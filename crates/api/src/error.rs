use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Ошибка с понятным пользователю сообщением. Внутренние ошибки не раскрывают детали.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
    pub retry_after: Option<u64>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), retry_after: None }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Войди в кабинет, чтобы продолжить.")
    }
    pub fn busy() -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, "Сервер занят. Попробуй через несколько секунд.")
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(err: E) -> Self {
        let err = err.into();
        tracing::error!(error = %format!("{err:#}"), "internal error");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Сервис временно недоступен. Попробуй позже.")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (self.status, Json(serde_json::json!({ "error": self.message }))).into_response();
        if let Some(seconds) = self.retry_after {
            response.headers_mut().insert("retry-after", seconds.into());
        }
        response
    }
}
