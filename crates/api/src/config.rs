use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

/// Параметры запуска из переменных окружения.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub valkey_url: String,
    pub origins: Vec<String>,
    pub secure_cookies: bool,
    /// Доверять X-Forwarded-For (только за Caddy, который перезаписывает заголовок).
    pub trust_proxy: bool,
    pub songs_dir: String,
    pub instance_id: String,
    pub compute_threads: usize,
    pub compute_queue: usize,
    /// Соединений PostgreSQL на экземпляр.
    pub db_pool: u32,
    /// SHA-256 (hex) токена GPU-обработчика. Без него маршруты /api/worker закрыты.
    pub worker_token_sha256: Option<String>,
    /// Приватные файлы вне публичного /songs: записи исполнений и свои треки.
    pub data_dir: PathBuf,
    /// Сколько секунд после конца пения ждать точную оценку, затем «предварительная».
    pub perf_deadline_s: u64,
    /// Сколько исполнений для точной оценки можно создать за час с одного адреса. На защите
    /// жюри сидит за одним NAT-адресом площадки, поэтому по умолчанию 300.
    pub perf_limit_per_hour: i64,
    pub game: GameConfig,
    pub oauth: OAuthConfig,
}

/// Вход через Яндекс ID и VK ID. Провайдер включён, только когда заданы его ID и секрет.
#[derive(Clone, Debug)]
pub struct OAuthConfig {
    /// Адрес сайта для redirect_uri: `{public_origin}/api/auth/{provider}/callback`.
    pub public_origin: String,
    pub yandex: Option<OAuthClient>,
    pub vk: Option<OAuthClient>,
    /// Базовые адреса провайдеров; в тестах указывают на поддельный сервер.
    pub yandex_base: String,
    pub yandex_info: String,
    pub vk_base: String,
}

/// Приложение у провайдера. Секрет не попадает в отладочный вывод и журнал.
#[derive(Clone)]
pub struct OAuthClient {
    pub id: String,
    pub secret: String,
}

impl std::fmt::Debug for OAuthClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthClient").field("id", &self.id).field("secret", &"<скрыт>").finish()
    }
}

/// Непустое значение переменной: пустая строка из Compose равна отсутствующей.
fn optional(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn client(id: &str, secret: &str) -> Option<OAuthClient> {
    Some(OAuthClient { id: optional(id)?, secret: optional(secret)? })
}

impl OAuthConfig {
    fn from_env(origins: &[String]) -> Self {
        let url = |name: &str, default: &str| optional(name).unwrap_or_else(|| default.to_owned()).trim_end_matches('/').to_owned();
        let first_origin = origins.first().map_or("http://localhost:8080", String::as_str);
        Self {
            public_origin: url("PUBLIC_ORIGIN", first_origin),
            yandex: client("YANDEX_CLIENT_ID", "YANDEX_CLIENT_SECRET"),
            vk: client("VK_CLIENT_ID", "VK_CLIENT_SECRET"),
            yandex_base: url("OAUTH_YANDEX_BASE", "https://oauth.yandex.ru"),
            yandex_info: url("OAUTH_YANDEX_INFO", "https://login.yandex.ru/info"),
            vk_base: url("OAUTH_VK_BASE", "https://id.vk.ru"),
        }
    }
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let game = match std::env::var("GAME_CONFIG") {
            Ok(path) => serde_json::from_str(&std::fs::read_to_string(&path)?)?,
            Err(_) => GameConfig::default(),
        };
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get());
        let origins: Vec<String> = env("APP_ORIGINS", "http://localhost:8080,http://127.0.0.1:5173,http://localhost:5173")
            .split(',')
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(Self {
            bind: env("BIND", "127.0.0.1:3001"),
            database_url: env("DATABASE_URL", "postgres://localhost/perepev"),
            valkey_url: env("VALKEY_URL", "redis://127.0.0.1:6379"),
            oauth: OAuthConfig::from_env(&origins),
            origins,
            secure_cookies: env("COOKIE_SECURE", "false") == "true",
            trust_proxy: env("TRUST_PROXY", "false") == "true",
            songs_dir: env("SONGS_DIR", "web/static/songs"),
            instance_id: std::env::var("INSTANCE_ID").unwrap_or_else(|_| crate::util::random_hex(6)),
            // 0 — все ядра, кроме одного, оставленного для соединений.
            compute_threads: match env("COMPUTE_THREADS", "0").parse::<usize>()? {
                0 => threads.saturating_sub(1).max(1),
                n => n,
            },
            compute_queue: env("COMPUTE_QUEUE", "64").parse()?,
            db_pool: env("DB_POOL", "32").parse()?,
            worker_token_sha256: worker_token_hash()?,
            data_dir: PathBuf::from(env("DATA_DIR", "/data")),
            perf_deadline_s: env("PERF_DEADLINE_S", "20").parse()?,
            perf_limit_per_hour: positive("PERF_LIMIT_PER_HOUR", &env("PERF_LIMIT_PER_HOUR", "300"))?,
            game,
        })
    }
}

/// Целое число не меньше 1 (лимиты): ноль закрыл бы функцию целиком.
fn positive(name: &str, value: &str) -> anyhow::Result<i64> {
    let n: i64 = value.trim().parse().map_err(|_| anyhow::anyhow!("{name} должен быть целым числом, получено «{value}»"))?;
    anyhow::ensure!(n >= 1, "{name} должен быть не меньше 1, получено {n}");
    Ok(n)
}

/// Хеш токена обработчика: 64 hex-символа или пусто (обработчик отключён).
fn worker_token_hash() -> anyhow::Result<Option<String>> {
    let value = env("WORKER_TOKEN_SHA256", "").trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    anyhow::ensure!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()),
        "WORKER_TOKEN_SHA256 должен содержать 64 hex-символа SHA-256 токена"
    );
    Ok(Some(value))
}

/// Игровые настройки. Это исходные значения из ТЗ, а не результат исследований:
/// их нужно калибровать по реальным матчам. Переопределяются JSON-файлом GAME_CONFIG.
#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
pub struct GameConfig {
    pub start_mmr: f64,
    pub calibration_matches: i32,
    pub k_calibration: f64,
    pub k_regular: f64,
    pub window_start: f64,
    pub window_step: f64,
    pub window_step_seconds: u64,
    pub window_max: f64,
    pub protected_matches: i32,
    pub protected_below_mmr: f64,
    pub protected_forbidden_mmr: f64,
    pub protected_max_diff: f64,
    /// Не больше стольких рейтинговых матчей одной пары за сутки (защита от сговора).
    pub pair_daily_limit: i64,
    pub heartbeat_seconds: u64,
    pub disconnect_seconds: u64,
    pub return_window_seconds: u64,
    pub accept_seconds: u64,
    pub ready_seconds: u64,
    pub countdown_seconds: f64,
    /// Сколько секунд после конца песни ждать недостающие пакеты кривой.
    pub collect_seconds: u64,
    pub curve_retention_days: i64,
    pub queue_ticket_seconds: u64,
    /// Через сколько секунд ожидания (у обоих) пул калибровки и основной пул открываются
    /// друг для друга. Окна близости и защита новичков действуют по-прежнему.
    pub cross_pool_seconds: u64,
}

impl Default for GameConfig {
    fn default() -> Self {
        Self {
            start_mmr: 1000.0,
            calibration_matches: 10,
            k_calibration: 40.0,
            k_regular: 24.0,
            window_start: 80.0,
            window_step: 20.0,
            window_step_seconds: 15,
            window_max: 150.0,
            protected_matches: 20,
            protected_below_mmr: 1100.0,
            protected_forbidden_mmr: 1400.0,
            protected_max_diff: 100.0,
            pair_daily_limit: 3,
            heartbeat_seconds: 5,
            disconnect_seconds: 15,
            return_window_seconds: 15,
            accept_seconds: 20,
            ready_seconds: 60,
            countdown_seconds: 4.0,
            collect_seconds: 20,
            curve_retention_days: 30,
            queue_ticket_seconds: 30,
            cross_pool_seconds: 30,
        }
    }
}

impl GameConfig {
    pub fn disconnect(&self) -> Duration {
        Duration::from_secs(self.disconnect_seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::positive;

    #[test]
    fn limits_are_positive_integers() {
        assert_eq!(positive("PERF_LIMIT_PER_HOUR", "300").unwrap(), 300);
        assert_eq!(positive("PERF_LIMIT_PER_HOUR", " 7 ").unwrap(), 7);
        for bad in ["0", "-5", "", "много", "1.5"] {
            assert!(positive("PERF_LIMIT_PER_HOUR", bad).is_err(), "{bad}");
        }
    }
}
