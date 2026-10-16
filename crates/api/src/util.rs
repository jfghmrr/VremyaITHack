use axum::Router;
use axum::extract::DefaultBodyLimit;
use sha2::{Digest, Sha256};
use tower_http::limit::RequestBodyLimitLayer;

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(&mut buf[..]);
    hex::encode(buf)
}

pub fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

pub fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}

/// Собственный предел тела для маршрутов загрузки вместо общих 16 КБ: длинный
/// Content-Length отклоняется сразу (413), потоковое тело — при чтении.
pub fn body_limit<S: Clone + Send + Sync + 'static>(router: Router<S>, bytes: usize) -> Router<S> {
    router.layer(DefaultBodyLimit::max(bytes)).layer(RequestBodyLimitLayer::new(bytes))
}
