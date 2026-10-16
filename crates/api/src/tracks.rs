//! Свои треки (C3): владелец загружает выбранный отрывок, обработчик делает стемы,
//! эталон и слова. Файлы лежат в `DATA_DIR/tracks/<id>/`, отдаются только владельцу
//! и удаляются через 24 часа. Здесь же фоновая уборка файлов и сроков очереди.
use crate::accounts::Authed;
use crate::error::{ApiError, ApiResult};
use crate::jobs::{self, Job, NewJob};
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use scoring_core::Song;
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use uuid::Uuid;

/// Файлы трека, которые пишет обработчик и читает владелец.
pub const FILES: [&str; 5] = ["instrumental.mp3", "guide.mp3", "backing.mp3", "reference.json", "lyrics.words.json"];
pub const AUDIO_MAX: usize = 12 * 1024 * 1024;
const RATE: u32 = 44_100;
const MARGIN_S: f64 = 2.0;
const TTL_S: f64 = 24.0 * 3600.0;
const DAILY_UPLOADS: i64 = 5;
/// Трек без аудио дольше этого срока показывается как неудачный.
const UPLOAD_GRACE_S: f64 = 10.0 * 60.0;

const NO_AUDIO: &str = "Аудио не загрузилось. Удали трек и попробуй снова.";
const TIMEOUT: &str = "Обработчик не взялся за трек вовремя. Попробуй позже.";
const FAILED: &str = "Не удалось обработать трек. Попробуй другой отрывок.";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tracks", get(list).post(create))
        .route("/api/tracks/{id}", delete(remove))
        .route("/api/tracks/{id}/files/{name}", get(file))
}

pub fn upload_routes() -> Router<AppState> {
    crate::util::body_limit(Router::new().route("/api/tracks/{id}/audio", put(audio)), AUDIO_MAX)
}

pub fn tracks_dir(st: &AppState) -> PathBuf {
    st.cfg.data_dir.join("tracks")
}

pub fn track_dir(st: &AppState, id: Uuid) -> PathBuf {
    tracks_dir(st).join(id.to_string())
}

pub fn content_type(name: &str) -> &'static str {
    if name.ends_with(".mp3") { "audio/mpeg" } else { "application/json" }
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Трек не найден.")
}

/// Эталон своего трека с теми же ограничениями, что у каталога, но до 70 секунд
/// (отрывок до 60 с плюс поля по 2 с).
fn parse_reference(bytes: &[u8]) -> Option<Song> {
    serde_json::from_slice::<Song>(bytes)
        .ok()
        .filter(|s| s.hop_ms == 10.0 && s.duration_s > 0.0 && s.duration_s <= 70.0 && s.f0_midi.len() <= 7001)
}

pub async fn load_reference(st: &AppState, id: Uuid) -> ApiResult<Option<Song>> {
    Ok(jobs::read_file(&track_dir(st, id).join("reference.json")).await?.as_deref().and_then(parse_reference))
}

/// Обработанный и не просроченный трек: язык и эталон. `user` — проверка владельца.
pub async fn ready(st: &AppState, id: Uuid, user: Option<Uuid>) -> ApiResult<Option<(String, Song)>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT t.language FROM tracks t JOIN jobs j ON j.id = t.job_id
         WHERE t.id = $1 AND ($2::uuid IS NULL OR t.user_id = $2) AND t.expires_at > now() AND j.status = 'done'",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&st.db)
    .await?;
    let Some((language,)) = row else { return Ok(None) };
    Ok(load_reference(st, id).await?.map(|song| (language, song)))
}

#[derive(sqlx::FromRow)]
struct Track {
    title: String,
    language: String,
    job_id: Option<Uuid>,
}

async fn own(st: &AppState, id: Uuid, user: Uuid) -> ApiResult<Track> {
    sqlx::query_as("SELECT title, language, job_id FROM tracks WHERE id = $1 AND user_id = $2 AND expires_at > now()")
        .bind(id)
        .bind(user)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(not_found)
}

#[derive(Deserialize)]
struct NewTrack {
    title: Option<String>,
    language: Option<String>,
}

async fn create(State(st): State<AppState>, Authed(s): Authed, Json(b): Json<NewTrack>) -> ApiResult<(StatusCode, Json<Value>)> {
    let title = b.title.as_deref().unwrap_or("").trim().to_owned();
    let language = b.language.unwrap_or_default();
    if !(1..=100).contains(&title.chars().count()) || !matches!(language.as_str(), "ru" | "en") {
        return Err(ApiError::bad("Укажи название до 100 символов и язык: русский или английский."));
    }
    st.rate_limit("tracks", &s.user.id.to_string(), DAILY_UPLOADS, 24 * 3600, "Можно загрузить не больше 5 треков в сутки.").await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO tracks (id, user_id, title, language, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    )
    .bind(id)
    .bind(s.user.id)
    .bind(&title)
    .bind(&language)
    .bind(TTL_S)
    .execute(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// Выбранный отрывок с полями: WAV 44,1 кГц, моно, PCM16. Ставит задачу `track`.
async fn audio(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>, body: Bytes) -> ApiResult<(StatusCode, Json<Value>)> {
    let track = own(&st, id, s.user.id).await?;
    if track.job_id.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Аудио этого трека уже загружено."));
    }
    let Some(info) = jobs::wav_info(&body).filter(|w| w.format == 1 && w.channels == 1 && w.rate == RATE && w.bits == 16) else {
        return Err(ApiError::bad("Нужен WAV 44,1 кГц, моно, 16 бит."));
    };
    let seconds = info.data_len as f64 / (RATE as f64 * 2.0);
    if !(14.0..=70.0).contains(&seconds) {
        return Err(ApiError::bad("Нужен отрывок от 15 до 60 секунд."));
    }
    let job = Uuid::new_v4();
    // Файл пишется до постановки задачи: обработчик не получит задачу без входа.
    jobs::write_file(&jobs::input_path(&st, job), &body).await?;
    let mut tx = st.db.begin().await?;
    jobs::enqueue(
        &mut *tx,
        NewJob {
            id: job,
            kind: "track",
            priority: jobs::TRACK_PRIORITY,
            owner_user: Some(s.user.id),
            guest_key: None,
            // track_id: обработчик пишет в reference.json id «my-<track_id>», а клиент
            // принимает эталон, только если id совпадает с песней.
            params: json!({ "language": track.language, "title": track.title, "margin_s": MARGIN_S, "track_id": id }),
        },
    )
    .await?;
    let linked = sqlx::query("UPDATE tracks SET job_id = $2 WHERE id = $1 AND job_id IS NULL")
        .bind(id)
        .bind(job)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if linked == 0 {
        drop(tx);
        jobs::remove_dir(&jobs::job_dir(&st, job)).await;
        return Err(ApiError::new(StatusCode::CONFLICT, "Аудио этого трека уже загружено."));
    }
    tx.commit().await?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "ok": true }))))
}

/// Статус трека для владельца и понятная причина неудачи (без текста ошибки обработчика).
fn track_status(job: Option<&str>, error: Option<&str>, upload_overdue: bool, online: bool) -> (&'static str, Option<&'static str>) {
    match job {
        None if upload_overdue => ("failed", Some(NO_AUDIO)),
        None => ("queued", None),
        Some("done") => ("ready", None),
        Some("failed") if error == Some("timeout") => ("failed", Some(TIMEOUT)),
        Some("failed") => ("failed", Some(FAILED)),
        Some(_) if !online => ("offline", None),
        Some("running") => ("running", None),
        Some(_) => ("queued", None),
    }
}

async fn list(State(st): State<AppState>, Authed(s): Authed) -> ApiResult<Json<Value>> {
    type Row = (Uuid, String, String, time::OffsetDateTime, bool, Option<String>, Option<String>, Option<String>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT t.id, t.title, t.language, t.expires_at, t.created_at < now() - make_interval(secs => $2),
                j.status, j.stage, j.error
         FROM tracks t LEFT JOIN jobs j ON j.id = t.job_id
         WHERE t.user_id = $1 AND t.expires_at > now() ORDER BY t.created_at DESC",
    )
    .bind(s.user.id)
    .bind(UPLOAD_GRACE_S)
    .fetch_all(&st.db)
    .await?;
    let online = st.worker_online().await;
    let tracks: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, language, expires, overdue, job, stage, error)| {
            let (status, error) = track_status(job.as_deref(), error.as_deref(), overdue, online);
            // Этап имеет смысл только у выполняемой задачи; у готовой он устарел.
            let stage = if status == "running" { stage } else { None };
            json!({
                "id": id, "title": title, "language": language, "status": status, "stage": stage, "error": error,
                "expiresAt": expires.format(&time::format_description::well_known::Rfc3339).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(json!({ "tracks": tracks })))
}

async fn file(State(st): State<AppState>, Authed(s): Authed, Path((id, name)): Path<(Uuid, String)>) -> ApiResult<Response> {
    if !FILES.contains(&name.as_str()) {
        return Err(not_found());
    }
    own(&st, id, s.user.id).await?;
    let bytes = jobs::read_file(&track_dir(&st, id).join(&name)).await?.ok_or_else(not_found)?;
    Ok(([(header::CONTENT_TYPE, content_type(&name))], bytes).into_response())
}

async fn remove(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>) -> ApiResult<StatusCode> {
    let row: Option<(Option<Uuid>,)> = sqlx::query_as("DELETE FROM tracks WHERE id = $1 AND user_id = $2 RETURNING job_id")
        .bind(id)
        .bind(s.user.id)
        .fetch_optional(&st.db)
        .await?;
    let (job,) = row.ok_or_else(not_found)?;
    delete_files(&st, id, job).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Удаляет файлы трека, его задачу и её вход.
async fn delete_files(st: &AppState, id: Uuid, job: Option<Uuid>) -> ApiResult<()> {
    if let Some(job) = job {
        sqlx::query("DELETE FROM jobs WHERE id = $1").bind(job).execute(&st.db).await?;
        jobs::remove_dir(&jobs::job_dir(st, job)).await;
    }
    jobs::remove_dir(&track_dir(st, id)).await;
    Ok(())
}

async fn track_for_job(st: &AppState, job: Uuid) -> ApiResult<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM tracks WHERE job_id = $1").bind(job).fetch_optional(&st.db).await?;
    Ok(row.map(|r| r.0))
}

/// Файл от обработчика для выполняемой задачи трека.
pub async fn store_file(st: &AppState, job: &Job, name: &str, bytes: &[u8]) -> ApiResult<()> {
    if job.kind != "track" || job.status != "running" {
        return Err(ApiError::new(StatusCode::CONFLICT, "Файлы принимаются только для выполняемой задачи трека."));
    }
    let track = track_for_job(st, job.id).await?.ok_or_else(not_found)?;
    jobs::write_file(&track_dir(st, track).join(name), bytes).await?;
    Ok(())
}

/// Итог задачи `track`: эталон и запись должны уже лежать в каталоге трека.
pub async fn complete(st: &AppState, job: &Job, body: Value) -> ApiResult<()> {
    if !body.is_object() {
        return Err(ApiError::bad("Некорректный TrackOutput."));
    }
    let Some(track) = track_for_job(st, job.id).await? else {
        return jobs::finish_failed(st, job.id, "track deleted").await;
    };
    let dir = track_dir(st, track);
    let reference = load_reference(st, track).await?.is_some();
    let backing = tokio::fs::try_exists(dir.join("backing.mp3")).await.unwrap_or(false);
    if !reference || !backing {
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "Сначала загрузи корректные reference.json и backing.mp3."));
    }
    jobs::finish_done(st, job.id, &body).await
}

/// Фоновая уборка раз в минуту: сроки очереди, записи голоса (не дольше 10 минут),
/// треки старше 24 часов и каталоги треков, оставшиеся после удаления аккаунта.
pub async fn sweeper(st: AppState) {
    for dir in [jobs::jobs_dir(&st), tracks_dir(&st)] {
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            tracing::warn!(path = %dir.display(), error = %e, "DATA_DIR недоступен: точная оценка и свои треки не будут работать");
        }
    }
    let mut tick = tokio::time::interval(jobs::SWEEP_EVERY);
    loop {
        tick.tick().await;
        let _ = jobs::expire(&st).await;
        let _ = purge(&st).await;
    }
}

async fn purge(st: &AppState) -> ApiResult<()> {
    let expired: Vec<(Uuid, Option<Uuid>)> =
        sqlx::query_as("DELETE FROM tracks WHERE expires_at < now() RETURNING id, job_id").fetch_all(&st.db).await?;
    for (id, job) in expired {
        delete_files(st, id, job).await?;
    }
    let Ok(mut entries) = tokio::fs::read_dir(tracks_dir(st)).await else { return Ok(()) };
    let mut dirs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        if let Some(id) = entry.file_name().to_str().and_then(|n| n.parse::<Uuid>().ok()) {
            dirs.push(id);
        }
    }
    if dirs.is_empty() {
        return Ok(());
    }
    let alive: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM tracks WHERE id = ANY($1)").bind(&dirs).fetch_all(&st.db).await?;
    for id in dirs.into_iter().filter(|id| !alive.iter().any(|a| a.0 == *id)) {
        jobs::remove_dir(&track_dir(st, id)).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_for_the_owner() {
        assert_eq!(track_status(None, None, false, true), ("queued", None));
        assert_eq!(track_status(None, None, true, true), ("failed", Some(NO_AUDIO)));
        assert_eq!(track_status(Some("queued"), None, false, false), ("offline", None));
        assert_eq!(track_status(Some("running"), None, false, true), ("running", None));
        assert_eq!(track_status(Some("done"), None, false, false), ("ready", None));
        assert_eq!(track_status(Some("failed"), Some("timeout"), false, true), ("failed", Some(TIMEOUT)));
        assert_eq!(track_status(Some("failed"), Some("CUDA out of memory"), false, true), ("failed", Some(FAILED)));
    }

    #[test]
    fn reference_limits() {
        let ok = br#"{"hop_ms":10,"duration_s":64,"f0_midi":[null,60.0]}"#;
        assert!(parse_reference(ok).is_some());
        assert!(parse_reference(br#"{"hop_ms":20,"duration_s":10,"f0_midi":[]}"#).is_none());
        assert!(parse_reference(br#"{"hop_ms":10,"duration_s":90,"f0_midi":[]}"#).is_none());
        assert!(parse_reference(b"{}").is_none());
    }
}
