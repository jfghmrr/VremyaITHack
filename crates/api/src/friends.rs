//! Приватная адресная книга. Код друга — UUID профиля, не email и не токен входа.
use crate::{accounts::Authed, error::{ApiError, ApiResult}, state::AppState};
use axum::{extract::{Path, State}, http::{HeaderMap, StatusCode}, routing::{get, post, delete}, Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, schemars::JsonSchema)]
pub struct Friend { pub id: Uuid, pub name: String }
#[derive(Default, Serialize, schemars::JsonSchema)]
pub struct Friends { pub friends: Vec<Friend>, pub incoming: Vec<Friend>, pub outgoing: Vec<Friend> }
#[derive(Deserialize)]
struct Request { id: Uuid }

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/friends", get(list).post(request))
        .route("/api/friends/{id}/accept", post(accept))
        .route("/api/friends/{id}", delete(remove))
}

pub async fn for_user(st: &AppState, id: Uuid) -> ApiResult<Friends> {
    let rows: Vec<(Uuid, String, Uuid, bool)> = sqlx::query_as(
        "SELECT u.id, u.name, f.requester_id, f.accepted FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.low_id=$1 THEN f.high_id ELSE f.low_id END
         WHERE f.low_id=$1 OR f.high_id=$1 ORDER BY f.created_at DESC")
        .bind(id).fetch_all(&st.db).await?;
    let mut result = Friends::default();
    for (other, name, sender, accepted) in rows {
        let friend = Friend { id: other, name };
        if accepted { result.friends.push(friend); }
        else if sender == id { result.outgoing.push(friend); }
        else { result.incoming.push(friend); }
    }
    Ok(result)
}
async fn list(State(st): State<AppState>, Authed(s): Authed) -> ApiResult<Json<Friends>> {
    Ok(Json(for_user(&st, s.user.id).await?))
}
async fn request(State(st): State<AppState>, Authed(s): Authed, headers: HeaderMap, Json(b): Json<Request>) -> ApiResult<Json<Friends>> {
    let me = s.user.id;
    if me == b.id { return Err(ApiError::bad("Это твой код. Попроси друга прислать его код.")); }
    let bucket = format!("friends:{me}");
    st.check_limit(&headers, &bucket).await?;
    st.hit_limit(&headers, &bucket).await;
    let (low, high) = (me.min(b.id), me.max(b.id));
    let mut tx = st.db.begin().await?;
    // Одинаковый порядок блокировок также защищает лимит и встречные заявки.
    let users: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE")
        .bind(low).bind(high).fetch_all(&mut *tx).await?;
    if users.len() != 2 { return Err(ApiError::new(StatusCode::NOT_FOUND, "Игрок с таким кодом не найден.")); }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM friendships WHERE low_id=$1 AND high_id=$2)")
        .bind(low).bind(high).fetch_one(&mut *tx).await?;
    if !exists {
        for user in [low, high] {
            let count: i64 = sqlx::query_scalar("SELECT count(*) FROM friendships WHERE low_id=$1 OR high_id=$1")
                .bind(user).fetch_one(&mut *tx).await?;
            if count >= 200 { return Err(ApiError::bad("Список заполнен. Удали ненужные заявки или друзей.")); }
        }
        sqlx::query("INSERT INTO friendships(low_id,high_id,requester_id) VALUES($1,$2,$3)")
            .bind(low).bind(high).bind(me).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(for_user(&st, me).await?))
}
async fn accept(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>) -> ApiResult<Json<Friends>> {
    let me = s.user.id;
    let changed = sqlx::query("UPDATE friendships SET accepted=true WHERE low_id=$1 AND high_id=$2 AND requester_id=$3")
        .bind(me.min(id)).bind(me.max(id)).bind(id).execute(&st.db).await?;
    if changed.rows_affected() == 0 { return Err(ApiError::new(StatusCode::NOT_FOUND, "Входящая заявка не найдена. Обнови список.")); }
    Ok(Json(for_user(&st, me).await?))
}
async fn remove(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>) -> ApiResult<Json<Friends>> {
    let me = s.user.id;
    sqlx::query("DELETE FROM friendships WHERE low_id=$1 AND high_id=$2")
        .bind(me.min(id)).bind(me.max(id)).execute(&st.db).await?;
    Ok(Json(for_user(&st, me).await?))
}
