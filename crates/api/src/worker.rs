//! Протокол GPU-обработчика (C2). Обработчик только сам обращается к серверу: long-poll
//! аренды, загрузка входа, отправка файлов и результата. Авторизация — `Bearer`-токен,
//! сервер хранит только его SHA-256. Маршруты вне браузерного CSRF-guard.
use crate::error::{ApiError, ApiResult};
use crate::jobs::{self, Job};
use crate::state::AppState;
use crate::util::{body_limit, sha256_hex};
use axum::body::Bytes;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::time::Instant;
use uuid::Uuid;

/// Наибольший JSON-результат (кадры высоты 70 с и слова).
pub const RESULT_MAX: usize = 2 * 1024 * 1024;
pub const FILE_MAX: usize = 20 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/worker/lease", post(lease))
        .route("/api/worker/heartbeat", post(heartbeat))
        .route("/api/worker/jobs/{id}/input", get(input))
        .route("/api/worker/jobs/{id}/asset/{name}", get(asset))
        .route("/api/worker/jobs/{id}/progress", post(progress))
        .route("/api/worker/jobs/{id}/fail", post(fail))
}

pub fn upload_routes() -> Router<AppState> {
    body_limit(Router::new().route("/api/worker/jobs/{id}/complete", post(complete)), RESULT_MAX)
        .merge(body_limit(Router::new().route("/api/worker/jobs/{id}/files/{name}", put(file)), FILE_MAX))
}

/// Обработчик с верным токеном. Без настроенного хеша маршруты закрыты.
pub struct Worker;

impl FromRequestParts<AppState> for Worker {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> ApiResult<Self> {
        let token = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| !t.is_empty());
        match (st.cfg.worker_token_sha256.as_deref(), token) {
            (Some(expected), Some(token)) if bool::from(sha256_hex(token.as_bytes()).as_bytes().ct_eq(expected.as_bytes())) => Ok(Self),
            _ => Err(ApiError::new(StatusCode::UNAUTHORIZED, "Нужен токен обработчика.")),
        }
    }
}

/// Имя обработчика по умолчанию — имя компьютера, на Windows оно бывает кириллическим,
/// поэтому допустим любой текст до 64 символов без управляющих.
fn valid_name(name: &str) -> ApiResult<()> {
    let ok = !name.trim().is_empty() && name.chars().count() <= 64 && !name.chars().any(char::is_control);
    if ok { Ok(()) } else { Err(ApiError::bad("Имя обработчика: от 1 до 64 символов без управляющих.")) }
}

fn no_job() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Задача не найдена.")
}

async fn job(st: &AppState, id: Uuid) -> ApiResult<Job> {
    jobs::get(st, id).await?.ok_or_else(no_job)
}

#[derive(Deserialize)]
struct LeaseRequest {
    worker: String,
    #[serde(default)]
    kinds: Option<Vec<String>>,
}

/// Long-poll до 25 секунд; каждый шаг опроса — сигнал жизни обработчика.
async fn lease(State(st): State<AppState>, _: Worker, Json(b): Json<LeaseRequest>) -> ApiResult<Response> {
    valid_name(&b.worker)?;
    let kinds: Vec<String> = match b.kinds {
        Some(kinds) => kinds.into_iter().filter(|k| jobs::KINDS.contains(&k.as_str())).collect(),
        None => jobs::KINDS.iter().map(|k| (*k).to_owned()).collect(),
    };
    let until = Instant::now() + jobs::LONG_POLL;
    loop {
        st.worker_seen(&b.worker).await;
        if !kinds.is_empty()
            && let Some((id, kind, params)) = jobs::lease_once(&st, &b.worker, &kinds).await?
        {
            let job = json!({ "id": id, "kind": kind, "lease_ttl_s": jobs::LEASE_TTL_S, "params": params });
            return Ok(Json(json!({ "job": job })).into_response());
        }
        if Instant::now() + jobs::POLL >= until {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
        tokio::time::sleep(jobs::POLL).await;
    }
}

#[derive(Deserialize)]
struct Heartbeat {
    worker: String,
}

async fn heartbeat(State(st): State<AppState>, _: Worker, Json(b): Json<Heartbeat>) -> ApiResult<StatusCode> {
    valid_name(&b.worker)?;
    st.worker_seen(&b.worker).await;
    jobs::renew(&st, &b.worker).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn input(State(st): State<AppState>, _: Worker, Path(id): Path<Uuid>) -> ApiResult<Response> {
    let bytes = jobs::read_file(&jobs::input_path(&st, id)).await?.ok_or_else(no_job)?;
    Ok(([(header::CONTENT_TYPE, "audio/wav")], bytes).into_response())
}

/// Стемы, которые слышал певец, для проверки проникновения звука из динамика.
async fn asset(State(st): State<AppState>, _: Worker, Path((id, name)): Path<(Uuid, String)>) -> ApiResult<Response> {
    if !crate::perf::STEMS.contains(&name.as_str()) || job(&st, id).await?.kind != "score" {
        return Err(no_job());
    }
    let song: Option<(String,)> = sqlx::query_as("SELECT song_id FROM perfs WHERE id = $1").bind(id).fetch_optional(&st.db).await?;
    let dir = song.and_then(|(s,)| crate::perf::song_dir(&st, &s)).ok_or_else(no_job)?;
    let bytes = jobs::read_file(&dir.join(&name)).await?.ok_or_else(no_job)?;
    Ok(([(header::CONTENT_TYPE, "audio/mpeg")], bytes).into_response())
}

#[derive(Deserialize)]
struct Progress {
    stage: String,
}

async fn progress(State(st): State<AppState>, _: Worker, Path(id): Path<Uuid>, Json(b): Json<Progress>) -> ApiResult<StatusCode> {
    if !jobs::STAGES.contains(&b.stage.as_str()) {
        return Err(ApiError::bad("Этап: separating, melody или words."));
    }
    job(&st, id).await?;
    if !jobs::set_stage(&st, id, &b.stage).await? {
        return Err(ApiError::new(StatusCode::CONFLICT, "Задача не выполняется."));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn file(State(st): State<AppState>, _: Worker, Path((id, name)): Path<(Uuid, String)>, body: Bytes) -> ApiResult<StatusCode> {
    if !crate::tracks::FILES.contains(&name.as_str()) {
        return Err(ApiError::bad("Недопустимое имя файла."));
    }
    let job = job(&st, id).await?;
    crate::tracks::store_file(&st, &job, &name, &body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Результат задачи. Повтор для завершённой (или уже неудачной) задачи ничего не меняет.
async fn complete(State(st): State<AppState>, _: Worker, Path(id): Path<Uuid>, Json(body): Json<Value>) -> ApiResult<StatusCode> {
    let job = job(&st, id).await?;
    match job.status.as_str() {
        "done" | "failed" => return Ok(StatusCode::NO_CONTENT),
        "running" => {}
        _ => return Err(ApiError::new(StatusCode::CONFLICT, "Задача ещё не выдана.")),
    }
    match job.kind.as_str() {
        "score" => crate::perf::complete(&st, &job, body).await?,
        _ => crate::tracks::complete(&st, &job, body).await?,
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Failure {
    error: String,
}

async fn fail(State(st): State<AppState>, _: Worker, Path(id): Path<Uuid>, Json(b): Json<Failure>) -> ApiResult<StatusCode> {
    let job = job(&st, id).await?;
    tracing::warn!(job = %id, kind = %job.kind, error = %b.error.chars().take(200).collect::<String>(), "worker reported failure");
    jobs::finish_failed(&st, id, &b.error).await?;
    Ok(StatusCode::NO_CONTENT)
}
