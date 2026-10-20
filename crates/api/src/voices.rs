//! «Вместе»: настоящие голоса для общего прослушивания — только по согласию обоих.
//!
//! До начала песни каждый участник может включить «Поделиться голосом с партнёром» (`voice_share`,
//! `match_participants.share_voice`, по умолчанию выключено). Если согласны оба, после песни каждый
//! браузер отправляет запись своих ходов (PCM16 LE, 16 кГц, моно, как у точной оценки) на
//! `PUT /api/matches/{id}/voice`; сервер ещё раз обнуляет всё вне ходов отправителя и хранит файл
//! `DATA_DIR/coop/<матч>/<слот>.pcm` несколько минут. Партнёр забирает его `GET …/voice/{слот}`,
//! пока матч свежий; браузер сводит минус и оба голоса по времени песни. Без согласия обоих оба
//! маршрута отказывают, и звучит синтезированный голос по линиям высоты.
use crate::accounts::Authed;
use crate::coop;
use crate::error::{ApiError, ApiResult};
use crate::jobs;
use crate::protocol::{MatchMode, Turn};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::Router;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

/// Частота записи голоса, как у точной оценки.
pub const RATE: usize = 16_000;
/// Песни каталога не длиннее 60 с; запас — секунда.
pub const MAX_BYTES: usize = 61 * RATE * 2;
/// Отправить свой голос можно только сразу после песни.
pub const UPLOAD_WINDOW_S: f64 = 90.0;
/// Запас после срока отправки: запрос, принятый в последний момент, успевает записать файл.
/// Позже отсутствующий голос уже не придёт, и `fetch` отвечает 410 вместо 404.
pub const UPLOAD_GRACE_S: f64 = 5.0;
/// Забрать голос партнёра можно, пока после конца песни прошло не больше этого.
pub const FETCH_WINDOW_S: f64 = 8.0 * 60.0;
/// Файл голоса удаляется, когда ему больше этого; уборка — раз в `SWEEP_EVERY` на каждом экземпляре.
pub const KEEP: Duration = Duration::from_secs(6 * 60);
pub const SWEEP_EVERY: Duration = Duration::from_secs(30);
/// Отправок голоса на пользователя в час (обычно одна на песню); считаются все попытки.
pub const UPLOADS_PER_HOUR: i64 = 30;
// Обещание пользователю: голос удаляется не позже чем через 10 минут после получения.
const _: () = assert!(KEEP.as_secs() + 2 * SWEEP_EVERY.as_secs() <= jobs::VOICE_MAX_AGE.as_secs());

pub fn upload_routes() -> Router<AppState> {
    crate::util::body_limit(Router::new().route("/api/matches/{id}/voice", put(upload)), MAX_BYTES)
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/matches/{id}/voice/{slot}", get(fetch))
}

pub fn voices_dir(st: &AppState) -> PathBuf {
    st.cfg.data_dir.join("coop")
}

fn voice_path(st: &AppState, id: Uuid, slot: u8) -> PathBuf {
    voices_dir(st).join(id.to_string()).join(format!("{slot}.pcm"))
}

/// Наибольшая длина записи для песни: вся песня плюс секунда запаса, не больше `MAX_BYTES`.
pub fn max_bytes(duration_s: f64) -> usize {
    (((duration_s + 1.0) * RATE as f64).ceil() as usize * 2).min(MAX_BYTES)
}

/// Обнуляет отсчёты вне ходов участника: на сервере остаётся только его партия.
pub fn keep_own_turns(pcm: &mut [u8], turns: &[Turn], slot: u8) {
    for (i, sample) in pcm.as_chunks_mut::<2>().0.iter_mut().enumerate() {
        if !coop::in_turns(turns, slot, i as f64 / RATE as f64) {
            sample.fill(0);
        }
    }
}

struct Shared {
    state: String,
    /// Секунды с конца песни; `None`, пока матч не закончился.
    since_end: Option<f64>,
    duration_s: f64,
    turns: Vec<Turn>,
    /// Слот запрашивающего.
    slot: u8,
    slots: Vec<u8>,
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Матч не найден.")
}

/// Матч «Вместе», где пользователь участник и оба согласились поделиться голосом.
async fn shared(st: &AppState, id: Uuid, user: Uuid) -> ApiResult<Shared> {
    type Row = (String, String, String, String, f64, Option<f64>);
    let row: Option<Row> = sqlx::query_as(
        "SELECT mode, state, song_id, song_version, duration_s, EXTRACT(EPOCH FROM now() - finished_at)::float8
         FROM matches WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let Some((mode, state, song_id, version, duration_s, since_end)) = row else { return Err(not_found()) };
    let players: Vec<(Uuid, i16, bool)> =
        sqlx::query_as("SELECT user_id, slot, share_voice FROM match_participants WHERE match_id = $1").bind(id).fetch_all(&st.db).await?;
    let Some(&(_, slot, _)) = players.iter().find(|p| p.0 == user) else { return Err(not_found()) };
    if MatchMode::parse(&mode) != MatchMode::Coop {
        return Err(ApiError::bad("Голосом можно поделиться только в режиме «Вместе»."));
    }
    if players.len() != 2 || !players.iter().all(|p| p.2) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Голосом делятся, только когда согласились оба участника."));
    }
    let turns = st
        .catalog
        .get(&song_id)
        .filter(|s| s.info.version == version)
        .map(|s| coop::schedule(&s.lines, s.song.duration_s))
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, "Версия песни на сервере изменилась."))?;
    Ok(Shared { state, since_end, duration_s, turns, slot: slot as u8, slots: players.iter().map(|p| p.1 as u8).collect() })
}

/// Согласны ли оба участника прямо сейчас.
async fn both_consent(st: &AppState, id: Uuid) -> ApiResult<bool> {
    let (shared, total): (i64, i64) =
        sqlx::query_as("SELECT count(*) FILTER (WHERE share_voice), count(*) FROM match_participants WHERE match_id = $1")
            .bind(id)
            .fetch_one(&st.db)
            .await?;
    Ok(total == 2 && shared == 2)
}

/// Пишет голос и сразу перепроверяет согласие. Снятие согласия могло случиться между проверкой
/// и записью (`withdraw` уже удалил каталог): тогда файл удаляется сразу; при сбое перепроверки
/// тоже — голос без подтверждённого согласия не хранится. `Ok(true)` — файл сохранён.
pub async fn write_if_still_shared<F, Fut>(path: &std::path::Path, bytes: &[u8], still_shared: F) -> ApiResult<bool>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ApiResult<bool>>,
{
    jobs::write_file(path, bytes).await?;
    let verdict = still_shared().await;
    if !matches!(verdict, Ok(true))
        && let Err(e) = tokio::fs::remove_file(path).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(path = %path.display(), error = %e, "voice remove failed");
    }
    verdict
}

/// Свой голос после песни: PCM16 LE, 16 кГц, моно, от нулевой секунды песни. Повтор заменяет файл.
async fn upload(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>, body: Bytes) -> ApiResult<StatusCode> {
    st.rate_limit("voice", &s.user.id.to_string(), UPLOADS_PER_HOUR, 3600, "Слишком много отправок голоса. Попробуй позже.").await?;
    let m = shared(&st, id, s.user.id).await?;
    if m.state != "finished" {
        return Err(ApiError::new(StatusCode::CONFLICT, "Песня ещё не закончилась."));
    }
    if m.since_end.is_none_or(|t| t > UPLOAD_WINDOW_S) {
        return Err(ApiError::new(StatusCode::GONE, "Голос отправляют сразу после песни; срок уже прошёл."));
    }
    if body.is_empty() || !body.len().is_multiple_of(2) {
        return Err(ApiError::bad("Ожидается запись PCM16."));
    }
    if body.len() > max_bytes(m.duration_s) {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Запись длиннее песни."));
    }
    let mut pcm = body.to_vec();
    keep_own_turns(&mut pcm, &m.turns, m.slot);
    if !write_if_still_shared(&voice_path(&st, id, m.slot), &pcm, || both_consent(&st, id)).await? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Согласие поделиться голосом снято: голос не сохранён."));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Голос участника `slot` (партнёра или свой), пока матч свежий и файл не удалён.
async fn fetch(State(st): State<AppState>, Authed(s): Authed, Path((id, slot)): Path<(Uuid, u8)>) -> ApiResult<Response> {
    let m = shared(&st, id, s.user.id).await?;
    if !m.slots.contains(&slot) {
        return Err(not_found());
    }
    if m.state != "finished" {
        return Err(ApiError::new(StatusCode::CONFLICT, "Песня ещё не закончилась."));
    }
    if m.since_end.is_none_or(|t| t > FETCH_WINDOW_S) {
        return Err(ApiError::new(StatusCode::GONE, "Голоса этой песни уже удалены."));
    }
    match jobs::read_file(&voice_path(&st, id, slot)).await? {
        Some(bytes) => Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response()),
        None => Err(missing_voice(m.since_end.unwrap_or(f64::INFINITY))),
    }
}

/// Голоса нет. В срок отправки он ещё может прийти (404 — страница партнёра ждёт дальше); после
/// срока уже не придёт (410), и страница честно говорит, что запись не пришла, а не ждёт впустую.
pub fn missing_voice(since_end: f64) -> ApiError {
    if since_end > UPLOAD_WINDOW_S + UPLOAD_GRACE_S {
        ApiError::new(StatusCode::GONE, "Записи нет: её не отправили в первые 90 секунд после песни или она уже удалена.")
    } else {
        ApiError::new(StatusCode::NOT_FOUND, "Голос партнёра ещё не загружен.")
    }
}

/// Снятие согласия поделиться голосом: в любой момент, в том числе после песни. Флаг снимается
/// сразу в базе (маршруты голоса после этого отвечают 403), а уже загруженные голоса матча
/// удаляются. Владелец идущего матча получает ту же команду и обновляет состояние для партнёра.
pub async fn withdraw(st: &AppState, id: Uuid, user: Uuid) -> ApiResult<()> {
    let changed = sqlx::query(
        "UPDATE match_participants p SET share_voice = false FROM matches m
         WHERE p.match_id = $1 AND p.user_id = $2 AND m.id = p.match_id AND m.mode = 'coop'",
    )
    .bind(id)
    .bind(user)
    .execute(&st.db)
    .await?
    .rows_affected();
    if changed > 0 {
        jobs::remove_dir(&voices_dir(st).join(id.to_string())).await;
    }
    Ok(())
}

/// Удаляет файлы голосов старше `KEEP` и опустевшие каталоги матчей.
pub async fn sweep(root: &std::path::Path, now: SystemTime) {
    let Ok(mut matches) = tokio::fs::read_dir(root).await else { return };
    while let Ok(Some(entry)) = matches.next_entry().await {
        let dir = entry.path();
        if let Ok(mut files) = tokio::fs::read_dir(&dir).await {
            while let Ok(Some(file)) = files.next_entry().await {
                let old = file
                    .metadata()
                    .await
                    .and_then(|m| m.modified())
                    .map_or(true, |t| now.duration_since(t).unwrap_or_default() > KEEP);
                if old && let Err(e) = tokio::fs::remove_file(file.path()).await
                    && e.kind() != std::io::ErrorKind::NotFound
                {
                    tracing::warn!(path = %file.path().display(), error = %e, "voice remove failed");
                }
            }
        }
        // Удаляется только пустой каталог; занятый (свежий голос) остаётся.
        let _ = tokio::fs::remove_dir(&dir).await;
    }
}

/// Уборка голосов на каждом экземпляре.
pub async fn sweeper(st: AppState) {
    let root = voices_dir(&st);
    let mut tick = tokio::time::interval(SWEEP_EVERY);
    loop {
        tick.tick().await;
        sweep(&root, SystemTime::now()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turns() -> Vec<Turn> {
        vec![
            Turn { slot: 0, start_s: 0.5, end_s: 1.0, lines: vec![0] },
            Turn { slot: 1, start_s: 1.0, end_s: 1.5, lines: vec![1] },
        ]
    }

    #[test]
    fn only_own_turns_survive_on_the_server() {
        // 2 с записи, все отсчёты ненулевые.
        let mut pcm: Vec<u8> = (0..2 * RATE).flat_map(|_| 1000i16.to_le_bytes()).collect();
        keep_own_turns(&mut pcm, &turns(), 1);
        let samples: Vec<i16> = pcm.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
        let at = |t: f64| samples[(t * RATE as f64) as usize];
        assert_eq!((at(0.2), at(0.7), at(1.2), at(1.7)), (0, 0, 1000, 0));
        assert_eq!(samples.iter().filter(|v| **v != 0).count(), RATE / 2, "ровно полсекунды хода B");
    }

    #[test]
    fn a_missing_voice_is_awaited_only_while_it_may_still_be_uploaded() {
        assert_eq!(missing_voice(1.0).status, StatusCode::NOT_FOUND);
        assert_eq!(missing_voice(UPLOAD_WINDOW_S + UPLOAD_GRACE_S).status, StatusCode::NOT_FOUND);
        assert_eq!(missing_voice(UPLOAD_WINDOW_S + UPLOAD_GRACE_S + 0.1).status, StatusCode::GONE);
    }

    #[test]
    fn recording_may_not_be_longer_than_the_song() {
        assert_eq!(max_bytes(13.87), ((14.87 * RATE as f64).ceil() as usize) * 2);
        assert_eq!(max_bytes(600.0), MAX_BYTES);
    }

    /// Снятие согласия между проверкой и записью: файл не остаётся на сервере.
    #[tokio::test]
    async fn a_voice_written_after_a_withdrawal_is_removed_at_once() {
        let root = std::env::temp_dir().join(format!("perepev-voice-race-{}", crate::util::random_hex(6)));
        let path = root.join("m").join("0.pcm");
        assert!(!write_if_still_shared(&path, &[1, 2], || async { Ok(false) }).await.unwrap(), "согласие снято");
        assert!(!path.exists(), "файл удалён сразу после записи");
        assert!(write_if_still_shared(&path, &[1, 2], || async { Ok(true) }).await.unwrap());
        assert!(path.exists());
        // Сбой перепроверки — тоже без файла: голос без подтверждённого согласия не хранится.
        let failed = write_if_still_shared(&path, &[3, 4], || async { Err(ApiError::busy()) }).await;
        assert!(failed.is_err() && !path.exists());
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn sweep_removes_voices_older_than_keep_and_empty_folders() {
        let root = std::env::temp_dir().join(format!("perepev-voices-{}", crate::util::random_hex(6)));
        let fresh = root.join("a");
        let stale = root.join("b");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(fresh.join("0.pcm"), [1, 2]).unwrap();
        std::fs::write(stale.join("1.pcm"), [1, 2]).unwrap();
        let old = SystemTime::now() - KEEP - Duration::from_secs(5);
        std::fs::File::options().write(true).open(stale.join("1.pcm")).unwrap().set_modified(old).unwrap();
        sweep(&root, SystemTime::now()).await;
        assert!(fresh.join("0.pcm").exists(), "свежий голос остаётся");
        assert!(!stale.exists(), "старый голос и пустой каталог удалены");
        // Через KEEP удаляется и свежий.
        sweep(&root, SystemTime::now() + KEEP + Duration::from_secs(1)).await;
        assert!(!fresh.exists());
        std::fs::remove_dir_all(&root).ok();
    }
}
