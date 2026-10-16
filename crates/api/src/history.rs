//! Приватная история одиночных попыток. Балл одиночной попытки считает браузер тем же
//! ядром оценки или, при точной оценке, сервер (`algorithm = "precise-1"`); у попытки
//! хранится признак, проверялись ли слова. Это личная статистика, а не доверенный
//! турнирный результат.
use crate::accounts::Authed;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

const KEEP: i64 = 100;
const AXES: [&str; 4] = ["intervals", "rhythm", "stability", "coverage"];

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/attempts", get(list).post(save))
}

async fn list(State(state): State<AppState>, Authed(s): Authed) -> ApiResult<Json<Value>> {
    type Row = (Uuid, time::OffsetDateTime, Value, Option<i32>, Option<String>, Option<bool>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, at, payload, algorithm_version, algorithm, words_checked FROM attempts WHERE user_id = $1 ORDER BY at DESC LIMIT 100",
    )
    .bind(s.user.id)
    .fetch_all(&state.db)
    .await?;
    let attempts: Vec<Value> = rows
        .into_iter()
        .map(|(id, at, mut payload, version, algorithm, words_checked)| {
            let o = payload.as_object_mut().expect("payload is an object");
            o.insert("id".into(), json!(id));
            o.insert("at".into(), json!(at.format(&time::format_description::well_known::Rfc3339).unwrap_or_default()));
            o.insert("owner".into(), json!(s.user.id));
            o.insert("algorithmVersion".into(), json!(version));
            o.insert("algorithm".into(), json!(algorithm));
            o.insert("wordsChecked".into(), json!(words_checked));
            payload
        })
        .collect();
    Ok(Json(json!({ "attempts": attempts })))
}

/// Момент разбора попытки (не больше трёх).
#[derive(Deserialize, schemars::JsonSchema)]
pub struct MomentIn {
    text: Option<String>,
    start_s: Option<f64>,
    end_s: Option<f64>,
    phrase: Option<Value>,
    reason: Option<String>,
    loss: Option<f64>,
}

/// Тело `POST /api/attempts`. Поля проверяет сервер; неверное значение — 400.
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttemptIn {
    id: Option<String>,
    song_id: Option<String>,
    title: Option<String>,
    score: Option<f64>,
    shift: Option<f64>,
    axes: Option<serde_json::Map<String, Value>>,
    moments: Option<Vec<MomentIn>>,
    owner: Option<String>,
    algorithm_version: Option<i32>,
    /// `"precise-1"`, если итог посчитан точной оценкой на сервере; без поля — балл браузера.
    algorithm: Option<String>,
    /// Слова проверены (только при точной оценке).
    words_checked: Option<bool>,
}

fn len_between(s: &Option<String>, min: usize, max: usize) -> bool {
    s.as_ref().is_some_and(|s| (min..=max).contains(&s.encode_utf16().count()))
}

async fn save(State(state): State<AppState>, Authed(s): Authed, Json(b): Json<AttemptIn>) -> ApiResult<(StatusCode, Json<Value>)> {
    let invalid = || ApiError::bad("Некорректный результат.");
    let id = b.id.as_ref().filter(|_| len_between(&b.id, 36, 36)).and_then(|i| Uuid::parse_str(i).ok()).ok_or_else(invalid)?;
    let score = b.score.filter(|v| v.is_finite() && (0.0..=100.0).contains(v)).ok_or_else(invalid)?;
    let shift = b.shift.filter(|v| v.is_finite() && v.abs() <= 127.0).ok_or_else(invalid)?;
    let axes_in = b.axes.ok_or_else(invalid)?;
    let mut axes = serde_json::Map::new();
    for k in AXES {
        let v = axes_in.get(k).and_then(Value::as_f64).filter(|v| (0.0..=1.0).contains(v)).ok_or_else(invalid)?;
        axes.insert(k.into(), json!(v));
    }
    let moments_in = b.moments.ok_or_else(invalid)?;
    if !len_between(&b.song_id, 1, 80) || !len_between(&b.title, 1, 200) || moments_in.len() > 3 {
        return Err(invalid());
    }
    let mut moments = Vec::new();
    for m in moments_in {
        let (Some(start), Some(end)) = (m.start_s, m.end_s) else { return Err(invalid()) };
        // Number.isInteger: 2 и 2.0 допустимы.
        let phrase = m.phrase.as_ref().and_then(Value::as_f64).filter(|p| p.is_finite() && p.fract() == 0.0).map(|p| p as i64);
        let reason_ok = matches!(m.reason.as_deref(), Some("pitch" | "rhythm" | "missing"));
        if !len_between(&m.text, 1, 1000) || !start.is_finite() || !end.is_finite() || start < 0.0 || end < start || end > 60.0 || phrase.is_none() || !reason_ok {
            return Err(invalid());
        }
        moments.push(json!({
            "text": m.text, "start_s": start, "end_s": end, "phrase": phrase, "reason": m.reason,
            "loss": m.loss.filter(|l| l.is_finite()).unwrap_or(0.0),
        }));
    }
    // Тег точной оценки — только известный; слова проверяются только точной оценкой.
    let algorithm = match b.algorithm.as_deref() {
        None => None,
        Some(scoring_core::PRECISE_ALGORITHM) => Some(scoring_core::PRECISE_ALGORITHM),
        Some(_) => return Err(invalid()),
    };
    if algorithm.is_none() && b.words_checked == Some(true) {
        return Err(invalid());
    }
    if b.owner.as_deref().is_some_and(|o| !o.is_empty() && o != s.user.id.to_string()) {
        return Err(ApiError::new(StatusCode::CONFLICT, "Аккаунт изменился в другой вкладке. Обнови страницу перед новой попыткой."));
    }
    let payload = json!({
        "songId": b.song_id, "title": b.title, "name": s.user.name, "score": score, "shift": shift,
        "axes": axes, "moments": moments,
    });
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO attempts (id, user_id, at, payload, algorithm_version, algorithm, words_checked)
         VALUES ($1, $2, now(), $3, $4, $5, $6) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(s.user.id)
    .bind(&payload)
    .bind(b.algorithm_version.filter(|v| *v == scoring_core::ALGORITHM_VERSION as i32))
    .bind(algorithm)
    .bind(b.words_checked)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM attempts WHERE user_id = $1 AND id NOT IN
         (SELECT id FROM attempts WHERE user_id = $1 ORDER BY at DESC LIMIT $2)",
    )
    .bind(s.user.id)
    .bind(KEEP)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}
