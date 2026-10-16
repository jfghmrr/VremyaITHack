//! Перепев: HTTP API и WebSocket. Модульный монолит: аккаунты, каталог, попытки,
//! матчи, подбор, рейтинг; оценка — общий crate scoring-core.
mod accounts;
mod catalog;
mod complaints;
mod config;
mod error;
mod history;
mod friends;
mod jobs;
mod lease;
mod legacy;
mod matches;
mod oauth;
mod perf;
mod protocol;
mod queue;
mod ratings;
mod realtime;
mod schemas;
mod state;
mod tracks;
mod util;
mod worker;
mod ws;

use crate::error::ApiError;
use crate::state::{AppState, Compute};
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use std::sync::{Arc, Mutex};
use tower_http::limit::RequestBodyLimitLayer;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Изменяющие запросы принимаются только со своего сайта и только как JSON; двоичные
/// загрузки записи и трека — со своим типом. Маршруты GPU-обработчика (`/api/worker/`)
/// вне guard: у них собственная авторизация токеном.
async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut response = if matches!(*req.method(), Method::GET | Method::HEAD) || path.starts_with("/api/worker/") {
        next.run(req).await
    } else {
        let h = req.headers();
        let origin_ok = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()).is_some_and(|o| st.cfg.origins.iter().any(|x| x == o));
        let marked = h.get("x-perepev-request").is_some_and(|v| v == "1");
        let kind = body_kind(req.method(), &path);
        let typed = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| kind.accepts(v));
        if !origin_ok || !marked {
            ApiError::new(StatusCode::FORBIDDEN, "Запрос с другого сайта отклонён. Обнови страницу.").into_response()
        } else if !typed {
            ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, kind.message()).into_response()
        } else {
            next.run(req).await
        }
    };
    response.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[derive(Clone, Copy)]
enum BodyKind {
    Json,
    Pcm,
    Wav,
}

impl BodyKind {
    fn accepts(self, content_type: &str) -> bool {
        match self {
            Self::Json => content_type.starts_with("application/json"),
            Self::Pcm => content_type.starts_with("application/octet-stream"),
            Self::Wav => content_type.starts_with("audio/wav") || content_type.starts_with("audio/x-wav"),
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::Json => "Ожидается JSON.",
            Self::Pcm => "Ожидается запись PCM (application/octet-stream).",
            Self::Wav => "Ожидается WAV (audio/wav).",
        }
    }
}

fn body_kind(method: &Method, path: &str) -> BodyKind {
    if *method == Method::PUT && path.starts_with("/api/perf/") && path.ends_with("/chunk") {
        BodyKind::Pcm
    } else if *method == Method::PUT && path.starts_with("/api/tracks/") && path.ends_with("/audio") {
        BodyKind::Wav
    } else {
        BodyKind::Json
    }
}

async fn health(State(st): State<AppState>) -> Response {
    let db = sqlx::query("SELECT 1").execute(&st.db).await.is_ok();
    let valkey = st.valkey_ping().await;
    let body = Json(serde_json::json!({
        "ok": db && valkey,
        "db": db,
        "valkey": valkey,
        // Есть ли живой GPU-обработчик (сигнал моложе 30 с); на `ok` не влияет.
        "worker": st.worker_online().await,
        "instance": st.cfg.instance_id,
        "connections": st.hub.connections(),
        "owned_matches": st.owned.lock().unwrap().len(),
        "compute_waiting": st.compute.waiting(),
        "algorithm_version": scoring_core::ALGORITHM_VERSION,
    }));
    if db && valkey { body.into_response() } else { (StatusCode::SERVICE_UNAVAILABLE, body).into_response() }
}

pub fn router(st: AppState) -> Router {
    // Обычные маршруты принимают JSON до 16 КБ; загрузки записи, трека и файлов
    // обработчика имеют собственные пределы (см. `util::body_limit`).
    let json = Router::new()
        .route("/api/health", get(health))
        .route("/api/ws", get(ws::upgrade))
        .merge(accounts::routes())
        .merge(oauth::routes())
        .merge(complaints::routes())
        .merge(friends::routes())
        .merge(history::routes())
        .merge(catalog::routes())
        .merge(matches::routes())
        .merge(ratings_routes())
        .merge(perf::routes())
        .merge(tracks::routes())
        .merge(worker::routes())
        .layer(RequestBodyLimitLayer::new(16 * 1024));
    Router::new()
        .merge(json)
        .merge(perf::upload_routes())
        .merge(tracks::upload_routes())
        .merge(worker::upload_routes())
        .layer(middleware::from_fn_with_state(st.clone(), guard))
        .with_state(st)
}

fn ratings_routes() -> Router<AppState> {
    async fn rating(State(st): State<AppState>, accounts::Authed(s): accounts::Authed) -> Result<Json<ratings::Summary>, ApiError> {
        Ok(Json(ratings::summary(&st, s.user.id).await?))
    }
    // Таблица лидеров видна только вошедшим игрокам: имена других участников не публикуются наружу.
    async fn leaders(State(st): State<AppState>, accounts::Authed(s): accounts::Authed) -> Result<Json<ratings::Leaderboard>, ApiError> {
        Ok(Json(ratings::leaderboard(&st, s.user.id, 50).await?))
    }
    Router::new().route("/api/rating", get(rating)).route("/api/leaderboard", get(leaders))
}

pub async fn build_state(cfg: config::Config) -> anyhow::Result<AppState> {
    let db = sqlx::postgres::PgPoolOptions::new().max_connections(cfg.db_pool).connect(&cfg.database_url).await?;
    MIGRATOR.run(&db).await?;
    let client = redis::Client::open(cfg.valkey_url.as_str())?;
    let valkey = redis::aio::ConnectionManager::new(client.clone()).await?;
    let catalog = catalog::Catalog::load(std::path::Path::new(&cfg.songs_dir))?;
    let hub = realtime::Hub::new(client);
    Ok(AppState {
        compute: Compute::new(cfg.compute_threads, cfg.compute_queue),
        cfg: Arc::new(cfg),
        db,
        valkey,
        catalog: Arc::new(catalog),
        hashing: Arc::new(tokio::sync::Semaphore::new(2)),
        hub,
        owned: Arc::new(Mutex::new(Default::default())),
    })
}

/// Фоновые задачи экземпляра: чтение потоков, отзыв сессий, восстановление матчей, подбор.
pub fn spawn_background(st: &AppState) {
    tokio::spawn(st.hub.clone().run());
    let s = st.clone();
    tokio::spawn(async move {
        let mut c = s.valkey.clone();
        let Ok(mut sub) = s.hub.subscribe_new(&mut c, realtime::key(format_args!("sys:revoke")), 256).await else { return };
        while let Some(entry) = sub.rx.recv().await {
            if let Ok(what) = serde_json::from_str::<realtime::Revoke>(&entry.body) {
                s.hub.revoke_local(&what);
            }
        }
    });
    tokio::spawn(matches::sweeper(st.clone()));
    tokio::spawn(queue::matchmaker(st.clone()));
    tokio::spawn(tracks::sweeper(st.clone()));
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("schemas") => return schemas::write(args.get(2).map_or("contracts", String::as_str)),
        Some("migrate") => {
            let cfg = config::Config::from_env()?;
            let db = sqlx::PgPool::connect(&cfg.database_url).await?;
            MIGRATOR.run(&db).await?;
            println!("Миграции применены.");
            return Ok(());
        }
        Some("import-legacy") => {
            let path = args.get(2).ok_or_else(|| anyhow::anyhow!("укажи путь к perepev.sqlite"))?;
            let dry = args.iter().any(|a| a == "--dry-run");
            let cfg = config::Config::from_env()?;
            let db = sqlx::PgPool::connect(&cfg.database_url).await?;
            MIGRATOR.run(&db).await?;
            return legacy::import(&db, path, dry).await;
        }
        Some("healthcheck") => {
            // Для HEALTHCHECK в образе без curl: простой HTTP-запрос к себе.
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let bind = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:3001".into());
            let port = bind.rsplit(':').next().unwrap_or("3001");
            let mut s = tokio::net::TcpStream::connect(format!("127.0.0.1:{port}")).await?;
            s.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n").await?;
            let mut buf = String::new();
            s.read_to_string(&mut buf).await?;
            anyhow::ensure!(buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200"), "unhealthy");
            return Ok(());
        }
        Some("serve") | None => {}
        Some(other) => anyhow::bail!("неизвестная команда {other}; доступны serve, migrate, import-legacy, schemas, healthcheck"),
    }
    let cfg = config::Config::from_env()?;
    let bind = cfg.bind.clone();
    let st = build_state(cfg).await?;
    spawn_background(&st);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, instance = %st.cfg.instance_id, "Перепев: сервер готов");
    axum::serve(listener, router(st))
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            tracing::info!("остановка: новые соединения не принимаются");
        })
        .await?;
    Ok(())
}
