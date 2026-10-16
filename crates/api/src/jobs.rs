//! Очередь задач GPU-обработчика в PostgreSQL: постановка, аренда с TTL, завершение,
//! сроки и файлы задач в `DATA_DIR/jobs/<id>/`.
//!
//! Аренда — `FOR UPDATE SKIP LOCKED`, поэтому несколько экземпляров API и несколько
//! обработчиков не получают одну задачу дважды. Просроченная аренда (обработчик пропал)
//! снова выдаётся. Запись голоса живёт не дольше `VOICE_MAX_AGE` (см. `sweep_inputs`).
use crate::error::ApiResult;
use crate::state::AppState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use uuid::Uuid;

pub const LEASE_TTL_S: i64 = 120;
pub const SCORE_PRIORITY: i32 = 0;
pub const TRACK_PRIORITY: i32 = 1;
/// Шаг опроса очереди внутри long-poll.
pub const POLL: Duration = Duration::from_millis(500);
/// Наибольшая длительность long-poll `POST /api/worker/lease`.
pub const LONG_POLL: Duration = Duration::from_secs(25);
/// Обещание пользователю: запись голоса удаляется не позже чем через 10 минут после получения.
pub const VOICE_MAX_AGE: Duration = Duration::from_secs(10 * 60);
/// Уборка (`tracks::sweeper`) идёт раз в минуту на каждом экземпляре.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);
/// Каталог исполнения удаляется, как только исполнению (`perfs.created_at`, раньше любого
/// куска) больше этого срока, сколько бы кусков ни приходило потом.
const VOICE_SWEEP_AGE: Duration = Duration::from_secs(7 * 60);
/// Каталог без исполнения и без ждущей задачи трека удаляется через эту паузу после
/// последней записи. Пауза бережёт вход трека, записанный до вставки его задачи.
const ORPHAN_GRACE: Duration = Duration::from_secs(30);
// Худший случай: исполнение удаляется вместе с аккаунтом перед самой уборкой по возрасту,
// его каталог становится «ничьим» и удаляется после паузы и ещё одной уборки.
const _: () = assert!(
    VOICE_SWEEP_AGE.as_secs() + 2 * SWEEP_EVERY.as_secs() + ORPHAN_GRACE.as_secs() <= VOICE_MAX_AGE.as_secs()
);
/// Трек ждёт обработчика не дольше 30 минут, затем задача считается неудачной.
pub const TRACK_QUEUE_S: f64 = 30.0 * 60.0;
/// Результаты оценки (кривые ошибок) и сведения об исполнениях хранятся сутки.
const SCORE_RESULT_S: f64 = 24.0 * 3600.0;
/// Обращения правообладателей (имя, почта, текст) хранятся год.
const COMPLAINT_S: f64 = 365.0 * 24.0 * 3600.0;
pub const KINDS: [&str; 2] = ["score", "track"];
pub const STAGES: [&str; 3] = ["separating", "melody", "words"];

#[derive(Debug, sqlx::FromRow)]
pub struct Job {
    pub id: Uuid,
    pub kind: String,
    pub status: String,
    pub params: Value,
}

pub fn jobs_dir(st: &AppState) -> PathBuf {
    st.cfg.data_dir.join("jobs")
}

pub fn job_dir(st: &AppState, id: Uuid) -> PathBuf {
    jobs_dir(st).join(id.to_string())
}

pub fn input_path(st: &AppState, id: Uuid) -> PathBuf {
    job_dir(st, id).join("input.wav")
}

/// Атомарная запись: читатель видит либо старый файл, либо новый целиком.
pub async fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("file has a parent directory");
    tokio::fs::create_dir_all(dir).await?;
    let tmp = dir.join(format!(".{}.tmp", crate::util::random_hex(8)));
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await
}

/// Удаляет каталог; отсутствие каталога (удалил другой экземпляр) не ошибка.
pub async fn remove_dir(path: &Path) {
    if let Err(e) = tokio::fs::remove_dir_all(path).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), error = %e, "remove failed");
    }
}

/// Читает файл; отсутствие файла — `None`.
pub async fn read_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub struct NewJob<'a> {
    pub id: Uuid,
    pub kind: &'a str,
    pub priority: i32,
    pub owner_user: Option<Uuid>,
    pub guest_key: Option<&'a str>,
    pub params: Value,
}

/// Ставит задачу; повторная постановка с тем же id ничего не меняет.
pub async fn enqueue<'e>(db: impl sqlx::PgExecutor<'e>, job: NewJob<'_>) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO jobs (id, kind, status, priority, owner_user, guest_key, params)
         VALUES ($1, $2, 'queued', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING",
    )
    .bind(job.id)
    .bind(job.kind)
    .bind(job.priority)
    .bind(job.owner_user)
    .bind(job.guest_key)
    .bind(&job.params)
    .execute(db)
    .await?;
    Ok(())
}

/// Одна попытка аренды: самая приоритетная ожидающая задача или задача с истёкшей арендой.
/// Оценки после срока и слишком долго ждавшие треки не выдаются: результат уже не нужен.
pub async fn lease_once(st: &AppState, worker: &str, kinds: &[String]) -> ApiResult<Option<(Uuid, String, Value)>> {
    Ok(sqlx::query_as(
        "UPDATE jobs SET status = 'running', worker = $2, lease_until = now() + make_interval(secs => $3)
         WHERE id = (
             SELECT id FROM jobs
             WHERE kind = ANY($1)
               AND (status = 'queued' OR (status = 'running' AND lease_until < now()))
               AND NOT (kind = 'score' AND created_at < now() - make_interval(secs => $4))
               AND NOT (kind = 'track' AND created_at < now() - make_interval(secs => $5))
             ORDER BY priority, created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 1)
         RETURNING id, kind, params",
    )
    .bind(kinds)
    .bind(worker)
    .bind(LEASE_TTL_S as f64)
    .bind(st.cfg.perf_deadline_s as f64)
    .bind(TRACK_QUEUE_S)
    .fetch_optional(&st.db)
    .await?)
}

/// Продлевает аренды задач, которые выполняет этот обработчик.
pub async fn renew(st: &AppState, worker: &str) -> ApiResult<()> {
    sqlx::query("UPDATE jobs SET lease_until = now() + make_interval(secs => $2) WHERE status = 'running' AND worker = $1")
        .bind(worker)
        .bind(LEASE_TTL_S as f64)
        .execute(&st.db)
        .await?;
    Ok(())
}

pub async fn get(st: &AppState, id: Uuid) -> ApiResult<Option<Job>> {
    Ok(sqlx::query_as("SELECT id, kind, status, params FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await?)
}

/// Этап выполнения для интерфейса; заодно продлевает аренду.
pub async fn set_stage(st: &AppState, id: Uuid, stage: &str) -> ApiResult<bool> {
    let n = sqlx::query(
        "UPDATE jobs SET stage = $2, lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND status = 'running'",
    )
    .bind(id)
    .bind(stage)
    .bind(LEASE_TTL_S as f64)
    .execute(&st.db)
    .await?
    .rows_affected();
    Ok(n == 1)
}

/// Завершает выполняемую задачу результатом. Повторное завершение ничего не меняет.
pub async fn finish_done(st: &AppState, id: Uuid, result: &Value) -> ApiResult<()> {
    sqlx::query("UPDATE jobs SET status = 'done', result = $2, finished_at = now() WHERE id = $1 AND status = 'running'")
        .bind(id)
        .bind(result)
        .execute(&st.db)
        .await?;
    remove_dir(&job_dir(st, id)).await;
    Ok(())
}

/// Отмечает неудачу ожидающей или выполняемой задачи и удаляет её вход.
pub async fn finish_failed(st: &AppState, id: Uuid, error: &str) -> ApiResult<()> {
    let error: String = error.chars().take(500).collect();
    sqlx::query(
        "UPDATE jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('queued', 'running')",
    )
    .bind(id)
    .bind(error)
    .execute(&st.db)
    .await?;
    remove_dir(&job_dir(st, id)).await;
    Ok(())
}

/// Сроки очереди (раз в минуту на каждом экземпляре; операции идемпотентны):
/// оценки после срока → `deadline`, долго ждавшие треки → `timeout`, старые результаты
/// оценок и исполнения старше суток удаляются, записи голоса стираются с диска раньше
/// 10 минут, обращения правообладателей — через год.
pub async fn expire(st: &AppState) -> ApiResult<()> {
    let overdue: Vec<(Uuid,)> = sqlx::query_as(
        "UPDATE jobs SET status = 'failed', error = CASE kind WHEN 'score' THEN 'deadline' ELSE 'timeout' END, finished_at = now()
         WHERE status IN ('queued', 'running')
           AND ((kind = 'score' AND created_at < now() - make_interval(secs => $1))
             OR (kind = 'track' AND created_at < now() - make_interval(secs => $2)))
         RETURNING id",
    )
    .bind(st.cfg.perf_deadline_s as f64)
    .bind(TRACK_QUEUE_S)
    .fetch_all(&st.db)
    .await?;
    for (id,) in overdue {
        remove_dir(&job_dir(st, id)).await;
    }
    sqlx::query("DELETE FROM jobs WHERE kind = 'score' AND created_at < now() - make_interval(secs => $1)")
        .bind(SCORE_RESULT_S)
        .execute(&st.db)
        .await?;
    // Задача исполнения (тот же id) к этому сроку уже удалена строкой выше.
    sqlx::query("DELETE FROM perfs WHERE created_at < now() - make_interval(secs => $1)")
        .bind(SCORE_RESULT_S)
        .execute(&st.db)
        .await?;
    sqlx::query("DELETE FROM complaints WHERE created_at < now() - make_interval(secs => $1)")
        .bind(COMPLAINT_S)
        .execute(&st.db)
        .await?;
    sweep_inputs(st).await
}

/// Каталоги `jobs/<id>`:
/// - каталог исполнения (куски, вход оценки) удаляется, когда исполнению больше
///   `VOICE_SWEEP_AGE`, — от создания исполнения, а не от последней записи;
/// - вход трека, задача которого ещё ждёт обработки, остаётся (это не запись голоса);
/// - остальное (завершённые задачи, исполнения удалённых аккаунтов) — через
///   `ORPHAN_GRACE` после последней записи.
async fn sweep_inputs(st: &AppState) -> ApiResult<()> {
    let Ok(mut entries) = tokio::fs::read_dir(jobs_dir(st)).await else { return Ok(()) };
    let mut dirs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let age = entry
            .metadata()
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        let id = entry.file_name().to_str().and_then(|n| n.parse::<Uuid>().ok());
        dirs.push((entry.path(), id, age));
    }
    if dirs.is_empty() {
        return Ok(());
    }
    let ids: Vec<Uuid> = dirs.iter().filter_map(|d| d.1).collect();
    // Известные каталоги и пора ли их удалять.
    let known: Vec<(Uuid, bool)> = sqlx::query_as(
        "SELECT id, created_at < now() - make_interval(secs => $2) FROM perfs WHERE id = ANY($1)
         UNION ALL
         SELECT id, false FROM jobs WHERE kind = 'track' AND status IN ('queued', 'running') AND id = ANY($1)",
    )
    .bind(&ids)
    .bind(VOICE_SWEEP_AGE.as_secs_f64())
    .fetch_all(&st.db)
    .await?;
    for (path, id, age) in dirs {
        let remove = match id.and_then(|id| known.iter().find(|k| k.0 == id)) {
            Some(&(_, due)) => due,
            None => age.is_some_and(|a| a > ORPHAN_GRACE),
        };
        if remove {
            remove_dir(&path).await;
        }
    }
    Ok(())
}

/// Заголовок WAV (PCM16, моно) для `data_len` байт отсчётов.
pub fn wav_header(rate: u32, data_len: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    h[8..12].copy_from_slice(b"WAVE");
    h[12..16].copy_from_slice(b"fmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&1u16.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_len.to_le_bytes());
    h
}

#[derive(Debug, PartialEq)]
pub struct WavInfo {
    pub format: u16,
    pub channels: u16,
    pub rate: u32,
    pub bits: u16,
    pub data_len: usize,
}

/// Разбор RIFF/WAVE: формат из `fmt ` и длина `data`. Остальные блоки пропускаются.
pub fn wav_info(bytes: &[u8]) -> Option<WavInfo> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let u16_at = |i: usize| bytes.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]));
    let u32_at = |i: usize| bytes.get(i..i + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let (mut pos, mut fmt) = (12usize, None);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32_at(pos + 4)? as usize;
        let body = pos + 8;
        if id == b"fmt " {
            fmt = Some((u16_at(body)?, u16_at(body + 2)?, u32_at(body + 4)?, u16_at(body + 14)?));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt?;
            let data_len = len.min(bytes.len() - body);
            return Some(WavInfo { format, channels, rate, bits, data_len });
        }
        pos = body.checked_add(len)?.checked_add(len & 1)?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header_round_trips() {
        let mut bytes = wav_header(16000, 6).to_vec();
        bytes.extend([1, 0, 2, 0, 3, 0]);
        assert_eq!(wav_info(&bytes), Some(WavInfo { format: 1, channels: 1, rate: 16000, bits: 16, data_len: 6 }));
    }

    #[test]
    fn wav_info_skips_extra_chunks_and_rejects_garbage() {
        let header = wav_header(44100, 4);
        let mut bytes = header[..36].to_vec();
        bytes.extend(b"LIST");
        bytes.extend(3u32.to_le_bytes());
        bytes.extend([9, 9, 9, 0]); // нечётный блок выравнивается до чётной длины
        bytes.extend(&header[36..]);
        bytes.extend([0, 0, 0, 0]);
        assert_eq!(wav_info(&bytes).map(|w| (w.rate, w.data_len)), Some((44100, 4)));
        assert_eq!(wav_info(b"ID3\x04 not a wav file at all"), None);
        assert_eq!(wav_info(&header[..20]), None);
    }
}
