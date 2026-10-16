//! Обращения правообладателей (ст. 1253.1 ГК РФ, ст. 15.7 149-ФЗ): форма на странице
//! «Контакты». Обращение сохраняется на сервере; с одного адреса — не больше 5 в час.
use crate::accounts::{chars_between, valid_email};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, Rate};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

const RATE: Rate = Rate { max: 5, window_seconds: 3600, message: "С этого адреса уже отправлено несколько обращений. Попробуй через час." };
/// Предел длины каждого поля в символах UTF-16, как `maxlength` в браузере.
const MAX_FIELD: usize = 2000;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/complaints", post(create))
}

#[derive(Deserialize)]
struct Complaint {
    name: Option<String>,
    email: Option<String>,
    /// Адрес материала на сайте; необязателен.
    url: Option<String>,
    text: Option<String>,
}

async fn create(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<Complaint>) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    st.check_rate(&headers, "complaint", &RATE).await?;
    let field = |v: Option<String>| v.unwrap_or_default().trim().to_owned();
    let (name, email, url, text) = (field(body.name), field(body.email), field(body.url), field(body.text));
    if [&name, &email, &url, &text].iter().any(|f| !chars_between(f, 0, MAX_FIELD)) {
        return Err(ApiError::bad("Каждое поле — не длиннее 2000 символов."));
    }
    if name.is_empty() || text.is_empty() {
        return Err(ApiError::bad("Укажи имя или название организации и суть обращения."));
    }
    if !valid_email(&email) {
        return Err(ApiError::bad("Укажи корректную почту для ответа."));
    }
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO complaints (id, name, email, url, body) VALUES ($1, $2, $3, $4, $5)")
        .bind(id)
        .bind(&name)
        .bind(&email)
        .bind(&url)
        .bind(&text)
        .execute(&st.db)
        .await?;
    // Лимит расходуют только принятые обращения: исправленная форма не упирается в него.
    st.hit_rate(&headers, "complaint", &RATE).await;
    tracing::info!(complaint = %id, "rights-holder complaint received");
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}
