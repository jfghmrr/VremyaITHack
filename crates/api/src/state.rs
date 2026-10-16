use crate::catalog::Catalog;
use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use crate::realtime::{Hub, Revoke};
use axum::http::{HeaderMap, StatusCode};
use redis::AsyncCommands;
use redis::aio::ConnectionManager;
use sqlx::PgPool;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub db: PgPool,
    pub valkey: ConnectionManager,
    pub catalog: Arc<Catalog>,
    pub hashing: Arc<Semaphore>,
    pub compute: Compute,
    pub hub: Arc<Hub>,
    /// Матчи, которыми владеет этот экземпляр.
    pub owned: Arc<std::sync::Mutex<std::collections::HashSet<uuid::Uuid>>>,
}

pub const KEY_PREFIX: &str = "kv:";
/// Обработчик считается живым, пока его последний сигнал моложе этого срока.
pub const WORKER_STALE_S: u64 = 30;

/// Время последнего сигнала обработчика общее для всех экземпляров API: ключ в Valkey
/// живёт `WORKER_STALE_S` секунд и продлевается каждым lease и heartbeat.
pub fn worker_seen_key() -> String {
    format!("{KEY_PREFIX}worker:seen")
}

/// Порог событий с одного адреса за окно и сообщение при превышении.
pub struct Rate {
    pub max: i64,
    pub window_seconds: u64,
    pub message: &'static str,
}

impl Rate {
    /// Регистрация и неудачные входы: 12 за 15 минут.
    pub const AUTH: Rate = Rate { max: 12, window_seconds: 900, message: "Слишком много попыток. Попробуй через 15 минут." };
}

impl AppState {
    /// Адрес клиента: X-Forwarded-For учитывается только за доверенным прокси.
    pub fn client_ip(&self, headers: &HeaderMap) -> String {
        if self.cfg.trust_proxy
            && let Some(ip) = headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next_back())
        {
            return ip.trim().to_owned();
        }
        "direct".to_owned()
    }

    /// Общий для всех экземпляров лимит с адреса: не больше 12 событий за 15 минут.
    /// `register` — каждая регистрация; `auth` — неудачные входы и проверки пароля
    /// (успешный вход лимит не расходует, а подбор пароля упирается в него).
    pub async fn check_limit(&self, headers: &HeaderMap, bucket: &str) -> ApiResult<()> {
        self.check_rate(headers, bucket, &Rate::AUTH).await
    }

    pub async fn hit_limit(&self, headers: &HeaderMap, bucket: &str) {
        self.hit_rate(headers, bucket, &Rate::AUTH).await
    }

    /// Лимит с адреса с собственным порогом и окном; общий для всех экземпляров (в Valkey).
    pub async fn check_rate(&self, headers: &HeaderMap, bucket: &str, rate: &Rate) -> ApiResult<()> {
        let key = format!("{KEY_PREFIX}rl:{bucket}:{}", self.client_ip(headers));
        let mut c = self.valkey.clone();
        let (count, ttl): (Option<i64>, i64) = redis::pipe().get(&key).ttl(&key).query_async(&mut c).await?;
        if count.unwrap_or(0) >= rate.max {
            let mut err = ApiError::new(StatusCode::TOO_MANY_REQUESTS, rate.message);
            err.retry_after = Some(ttl.max(1) as u64);
            return Err(err);
        }
        Ok(())
    }

    pub async fn hit_rate(&self, headers: &HeaderMap, bucket: &str, rate: &Rate) {
        let key = format!("{KEY_PREFIX}rl:{bucket}:{}", self.client_ip(headers));
        let mut c = self.valkey.clone();
        let _: redis::RedisResult<()> = redis::pipe()
            .atomic()
            .incr(&key, 1).ignore()
            .cmd("EXPIRE").arg(&key).arg(rate.window_seconds).arg("NX").ignore()
            .query_async(&mut c)
            .await;
    }

    /// Лимит событий в окне для произвольного ключа (адрес, пользователь): каждое
    /// обращение считается, при превышении `max` возвращается 429 с `Retry-After`.
    pub async fn rate_limit(&self, bucket: &str, who: &str, max: i64, window_s: i64, message: &str) -> ApiResult<()> {
        let key = format!("{KEY_PREFIX}rl:{bucket}:{who}");
        let mut c = self.valkey.clone();
        let (count, ttl): (i64, i64) = redis::pipe()
            .atomic()
            .incr(&key, 1)
            .cmd("EXPIRE").arg(&key).arg(window_s).arg("NX").ignore()
            .ttl(&key)
            .query_async(&mut c)
            .await?;
        if count > max {
            let mut err = ApiError::new(StatusCode::TOO_MANY_REQUESTS, message);
            err.retry_after = Some(ttl.max(1) as u64);
            return Err(err);
        }
        Ok(())
    }

    /// Отмечает сигнал обработчика (lease, heartbeat).
    pub async fn worker_seen(&self, worker: &str) {
        let mut c = self.valkey.clone();
        let _: redis::RedisResult<()> = c.set_ex(worker_seen_key(), worker, WORKER_STALE_S).await;
    }

    /// Есть ли обработчик, подававший сигнал за последние `WORKER_STALE_S` секунд.
    pub async fn worker_online(&self) -> bool {
        let mut c = self.valkey.clone();
        c.exists(worker_seen_key()).await.unwrap_or(false)
    }

    /// Публикует отзыв доступа: все экземпляры закрывают соответствующие соединения.
    pub async fn revoke(&self, what: Revoke) {
        let mut c = self.valkey.clone();
        let body = serde_json::to_string(&what).expect("serializable");
        let key = crate::realtime::key(format_args!("sys:revoke"));
        if let Err(e) = crate::realtime::append(&mut c, &key, &body, 1000, 3600).await {
            // Соединение всё равно перепроверяет сессию не реже раза в 30 секунд.
            tracing::warn!(error = %e, "revoke publish failed");
        }
        self.hub.revoke_local(&what);
    }

    pub async fn valkey_ping(&self) -> bool {
        let mut c = self.valkey.clone();
        c.ping::<String>().await.is_ok()
    }
}

/// Ограниченный пул CPU-задач (оценка исполнений). Очередь ожидания тоже ограничена:
/// при переполнении вызывающий получает отказ, а не бесконечное ожидание.
#[derive(Clone)]
pub struct Compute {
    permits: Arc<Semaphore>,
    waiting: Arc<AtomicUsize>,
    capacity: usize,
}

#[derive(Debug, thiserror::Error)]
#[error("очередь вычислений переполнена")]
pub struct ComputeBusy;

impl Compute {
    pub fn new(threads: usize, capacity: usize) -> Self {
        Self { permits: Arc::new(Semaphore::new(threads)), waiting: Arc::new(AtomicUsize::new(0)), capacity }
    }

    pub async fn run<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> Result<T, ComputeBusy> {
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.capacity {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(ComputeBusy);
        }
        let permit = self.permits.clone().acquire_owned().await.expect("semaphore never closed");
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            f()
        })
        .await
        .map_err(|_| ComputeBusy)
    }

    pub fn waiting(&self) -> usize {
        self.waiting.load(Ordering::SeqCst)
    }
}
