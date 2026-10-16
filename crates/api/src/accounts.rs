//! Аккаунты: регистрация, вход, сессии, профиль и пароль.
//! Поведение и сообщения перенесены из прежнего Fastify-сервера.
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{random_hex, sha256_hex};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const COOKIE: &str = "perepev_session";
/// Редакция документа «Согласие на обработку персональных данных» (web/src/routes/legal/consent).
pub const CONSENT_VERSION: &str = "2026-10-17";
/// Слово подтверждения смены пароля и удаления для кабинета без пароля (вход через Яндекс ID или VK ID).
pub const CONFIRM_PHRASE: &str = "УДАЛИТЬ";
const CONFIRM_MESSAGE: &str = "Для подтверждения введи слово УДАЛИТЬ.";
const SESSION_SECONDS: i64 = 7 * 24 * 3600;
/// Соль-пустышка для входа с неизвестной почтой: время ответа не выдаёт наличие аккаунта.
const DUMMY_SALT: &str = "00000000000000000000000000000000";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/me", get(me).patch(rename))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/password", post(password))
        .route("/api/me/delete", post(delete_account))
        .route("/api/me/export", get(export))
}

/// Почты и пароля нет у пользователей, вошедших через Яндекс ID или VK ID.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub email: Option<String>,
    pub name: String,
    pub password_salt: Option<String>,
    pub password_hash: Option<String>,
}

impl User {
    /// Соль и хеш пароля, если пароль задан.
    fn password(&self) -> Option<(&str, &str)> {
        Some((self.password_salt.as_deref()?, self.password_hash.as_deref()?))
    }
}

#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Uuid,
    /// null, если кабинет создан входом через Яндекс ID или VK ID.
    // Поле есть в ответе всегда: в схеме оно обязательное и допускает null.
    #[schemars(required, extend("type" = ["string", "null"]))]
    pub email: Option<String>,
    pub name: String,
    /// false — изменения подтверждаются словом «УДАЛИТЬ» вместо пароля.
    pub has_password: bool,
    /// Привязанные внешние входы: "yandex", "vk".
    pub providers: Vec<String>,
}

/// Профиль для клиента: с признаком пароля и списком привязанных провайдеров.
pub async fn profile(state: &AppState, user: &User) -> ApiResult<Profile> {
    let providers: Vec<String> = sqlx::query_scalar("SELECT provider FROM identities WHERE user_id = $1 ORDER BY created_at, provider")
        .bind(user.id)
        .fetch_all(&state.db)
        .await?;
    Ok(Profile { id: user.id, email: user.email.clone(), name: user.name.clone(), has_password: user.password().is_some(), providers })
}

pub async fn user_by_id(state: &AppState, id: Uuid) -> ApiResult<User> {
    Ok(sqlx::query_as::<_, User>("SELECT id, email, name, password_salt, password_hash FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(&state.db)
        .await?)
}

/// Возрастная группа при регистрации. До 14 лет согласие даёт родитель или опекун
/// (ст. 28 ГК РФ), его имя хранится вместе с согласием.
pub struct Age {
    pub group: &'static str,
    pub parent_name: Option<String>,
}

pub fn check_age(group: Option<&str>, parent_name: Option<&str>) -> ApiResult<Age> {
    match group {
        Some("14plus") => Ok(Age { group: "14plus", parent_name: None }),
        Some("under14") => {
            let parent = parent_name.unwrap_or("").trim();
            if !chars_between(parent, 2, 64) {
                return Err(ApiError::bad("До 14 лет укажи имя родителя или опекуна: от 2 до 64 символов."));
            }
            Ok(Age { group: "under14", parent_name: Some(parent.to_owned()) })
        }
        _ => Err(ApiError::bad("Укажи возраст: 14 лет и старше или младше 14.")),
    }
}

fn confirmed(phrase: Option<&str>) -> bool {
    phrase.is_some_and(|p| p.trim().to_uppercase() == CONFIRM_PHRASE)
}

/// Пользователь текущей сессии и хеш её токена.
pub struct Session {
    pub user: User,
    pub hash: String,
}

pub fn token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .find_map(|c| c.strip_prefix(&format!("{COOKIE}=")).map(str::to_owned))
        .filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

pub async fn session_by_token(state: &AppState, token: &str) -> ApiResult<Option<Session>> {
    let hash = sha256_hex(token.as_bytes());
    let user = sqlx::query_as::<_, User>(
        "SELECT u.id, u.email, u.name, u.password_salt, u.password_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.hash = $1 AND s.expires_at > now()",
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await?;
    Ok(user.map(|user| Session { user, hash }))
}

pub struct MaybeSession(pub Option<Session>);
pub struct Authed(pub Session);

impl FromRequestParts<AppState> for MaybeSession {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        match token(&parts.headers) {
            Some(t) => Ok(Self(session_by_token(state, &t).await?)),
            None => Ok(Self(None)),
        }
    }
}

impl FromRequestParts<AppState> for Authed {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> ApiResult<Self> {
        MaybeSession::from_request_parts(parts, state).await?.0.map(Self).ok_or_else(ApiError::unauthorized)
    }
}

fn cookie(state: &AppState, value: &str, max_age: i64) -> String {
    let secure = if state.cfg.secure_cookies { "; Secure" } else { "" };
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}")
}

/// Создаёт сессию, удаляя просроченные и текущую (ротация после входа).
pub async fn new_session(state: &AppState, headers: &HeaderMap, user: Uuid) -> ApiResult<String> {
    let old = token(headers).map(|t| sha256_hex(t.as_bytes())).unwrap_or_default();
    sqlx::query("DELETE FROM sessions WHERE expires_at <= now() OR hash = $1")
        .bind(&old)
        .execute(&state.db)
        .await?;
    let t = random_hex(32);
    sqlx::query("INSERT INTO sessions (hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))")
        .bind(sha256_hex(t.as_bytes()))
        .bind(user)
        .bind(SESSION_SECONDS as f64)
        .execute(&state.db)
        .await?;
    Ok(cookie(state, &t, SESSION_SECONDS))
}

/// scrypt с параметрами прежних хешей (N=2^17, r=8, p=1, 64 байта). Выполняется вне
/// асинхронных потоков; одновременно не больше двух вычислений (по 128 МиБ памяти).
pub async fn hash_password(state: &AppState, password: &str, salt: &str) -> ApiResult<Vec<u8>> {
    let permit = state.hashing.clone().try_acquire_owned().map_err(|_| ApiError::busy())?;
    let (password, salt) = (password.to_owned(), salt.to_owned());
    let key = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        derive(&password, &salt)
    })
    .await?;
    Ok(key)
}

pub fn derive(password: &str, salt: &str) -> Vec<u8> {
    let params = scrypt::Params::new(17, 8, 1).expect("valid scrypt params");
    let mut out = vec![0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).expect("valid output length");
    out
}

fn same_hash(key: &[u8], stored_hex: &str) -> bool {
    hex::decode(stored_hex).is_ok_and(|stored| stored.len() == key.len() && bool::from(stored.ct_eq(key)))
}

pub fn chars_between(s: &str, min: usize, max: usize) -> bool {
    // Длина в UTF-16, как `string.length` в прежнем сервере.
    (min..=max).contains(&s.encode_utf16().count())
}

pub fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else { return false };
    // Эквивалент /^[^\s@]+@[^\s@]+\.[^\s@]+$/: в домене есть точка с непустыми частями по краям.
    let ok = |s: &str| !s.is_empty() && !s.chars().any(|c| c.is_whitespace() || c == '@');
    ok(local) && ok(domain) && domain.char_indices().any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    email: Option<String>,
    password: Option<String>,
    name: Option<String>,
    consent: Option<bool>,
    age_group: Option<String>,
    parent_name: Option<String>,
}

struct Checked {
    email: String,
    password: String,
    name: String,
    /// Только при регистрации.
    age: Option<Age>,
}

fn check(body: Credentials, registration: bool) -> ApiResult<Checked> {
    let bad = || ApiError::bad("Введи корректную почту и пароль от 12 до 128 символов.");
    let email = body.email.ok_or_else(bad)?;
    let password = body.password.ok_or_else(bad)?;
    if !chars_between(&email, 3, 254) || !valid_email(email.trim()) || !chars_between(&password, 12, 128) {
        return Err(bad());
    }
    let name = body.name.as_deref().unwrap_or("").trim().to_owned();
    if registration && (!chars_between(&name, 2, 32) || body.consent != Some(true)) {
        return Err(ApiError::bad("Укажи имя от 2 до 32 символов и согласись сохранить данные кабинета."));
    }
    let age = if registration { Some(check_age(body.age_group.as_deref(), body.parent_name.as_deref())?) } else { None };
    Ok(Checked { email: email.trim().to_lowercase(), password, name, age })
}

pub fn with_cookie(status: StatusCode, cookie: String, body: serde_json::Value) -> Response {
    (status, [(header::SET_COOKIE, cookie)], Json(body)).into_response()
}

async fn me(State(state): State<AppState>, MaybeSession(s): MaybeSession) -> ApiResult<Json<serde_json::Value>> {
    let Some(s) = s else { return Ok(Json(serde_json::json!({ "profile": null }))) };
    let rating = crate::ratings::summary(&state, s.user.id).await?;
    Ok(Json(serde_json::json!({ "profile": profile(&state, &s.user).await?, "rating": rating })))
}

async fn register(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Credentials>) -> ApiResult<Response> {
    state.check_limit(&headers, "register").await?;
    state.hit_limit(&headers, "register").await;
    let b = check(body, true)?;
    let age = b.age.expect("registration checks age");
    let salt = random_hex(16);
    let key = hash_password(&state, &b.password, &salt).await?;
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO users (id, email, name, password_salt, password_hash, consent_at, consent_version, age_group, parent_name)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8) ON CONFLICT (email) DO NOTHING",
    )
    .bind(id)
    .bind(&b.email)
    .bind(&b.name)
    .bind(&salt)
    .bind(hex::encode(&key))
    .bind(CONSENT_VERSION)
    .bind(age.group)
    .bind(&age.parent_name)
    .execute(&state.db)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Err(ApiError::new(StatusCode::CONFLICT, "Не удалось создать кабинет с этой почтой. Попробуй войти."));
    }
    let cookie = new_session(&state, &headers, id).await?;
    let profile = Profile { id, email: Some(b.email), name: b.name, has_password: true, providers: vec![] };
    Ok(with_cookie(StatusCode::CREATED, cookie, serde_json::json!({ "profile": profile })))
}

async fn login(State(state): State<AppState>, headers: HeaderMap, Json(body): Json<Credentials>) -> ApiResult<Response> {
    state.check_limit(&headers, "auth").await?;
    let result = login_checked(&state, &headers, body).await;
    if result.is_err() {
        state.hit_limit(&headers, "auth").await;
    }
    result
}

async fn login_checked(state: &AppState, headers: &HeaderMap, body: Credentials) -> ApiResult<Response> {
    let state = state.clone();
    let b = check(body, false)?;
    let user = sqlx::query_as::<_, User>(
        "SELECT id, email, name, password_salt, password_hash FROM users WHERE email = $1",
    )
    .bind(&b.email)
    .fetch_optional(&state.db)
    .await?;
    let salt = user.as_ref().and_then(User::password).map_or(DUMMY_SALT, |(salt, _)| salt);
    let key = hash_password(&state, &b.password, salt).await?;
    let Some(user) = user.filter(|u| u.password().is_some_and(|(_, hash)| same_hash(&key, hash))) else {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Неверная почта или пароль."));
    };
    let cookie = new_session(&state, headers, user.id).await?;
    Ok(with_cookie(StatusCode::OK, cookie, serde_json::json!({ "profile": profile(&state, &user).await? })))
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(t) = token(&headers) {
        let hash = sha256_hex(t.as_bytes());
        sqlx::query("DELETE FROM sessions WHERE hash = $1").bind(&hash).execute(&state.db).await?;
        state.revoke(crate::realtime::Revoke::Session(hash)).await;
    }
    Ok(with_cookie(StatusCode::OK, cookie(&state, "", 0), serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct Rename {
    name: Option<String>,
}

async fn rename(State(state): State<AppState>, Authed(s): Authed, Json(body): Json<Rename>) -> ApiResult<Json<serde_json::Value>> {
    let name = body.name.as_deref().unwrap_or("").trim().to_owned();
    if !chars_between(&name, 2, 32) {
        return Err(ApiError::bad("Имя должно содержать от 2 до 32 символов."));
    }
    sqlx::query("UPDATE users SET name = $1 WHERE id = $2").bind(&name).bind(s.user.id).execute(&state.db).await?;
    let user = User { name, ..s.user };
    Ok(Json(serde_json::json!({ "profile": profile(&state, &user).await? })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordChange {
    current_password: Option<String>,
    new_password: Option<String>,
    /// Вместо текущего пароля, если его нет: слово «УДАЛИТЬ».
    confirm: Option<String>,
}

async fn password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Authed(s): Authed,
    Json(body): Json<PasswordChange>,
) -> ApiResult<Response> {
    state.check_limit(&headers, "auth").await?;
    // Пароль входит только вместе с почтой. Без почты им нельзя войти, а удаление аккаунта
    // потребовало бы этот пароль вместо слова «УДАЛИТЬ».
    if s.user.email.is_none() {
        return Err(ApiError::bad(
            "Пароль нужен только для входа по почте, а у этого аккаунта почты нет. Входи через Яндекс ID или VK ID.",
        ));
    }
    let length = || ApiError::bad("Пароль должен содержать от 12 до 128 символов.");
    let new = body.new_password.filter(|p| chars_between(p, 12, 128)).ok_or_else(length)?;
    match s.user.password() {
        Some((salt, hash)) => {
            let current = body.current_password.filter(|p| chars_between(p, 12, 128)).ok_or_else(length)?;
            if !same_hash(&hash_password(&state, &current, salt).await?, hash) {
                state.hit_limit(&headers, "auth").await;
                return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Текущий пароль неверен."));
            }
        }
        None if !confirmed(body.confirm.as_deref()) => return Err(ApiError::bad(CONFIRM_MESSAGE)),
        None => {}
    }
    let salt = random_hex(16);
    let key = hash_password(&state, &new, &salt).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET password_salt = $1, password_hash = $2, password_scheme = 'scrypt-17-8-1-64' WHERE id = $3")
        .bind(&salt)
        .bind(hex::encode(&key))
        .bind(s.user.id)
        .execute(&mut *tx)
        .await?;
    // Смена пароля отзывает все сессии, включая открытые WebSocket-соединения.
    sqlx::query("DELETE FROM sessions WHERE user_id = $1").bind(s.user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    state.revoke(crate::realtime::Revoke::User(s.user.id)).await;
    let cookie = new_session(&state, &HeaderMap::new(), s.user.id).await?;
    Ok(with_cookie(StatusCode::OK, cookie, serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DeleteRequest {
    password: Option<String>,
    /// Вместо пароля, если его нет: слово «УДАЛИТЬ».
    confirm: Option<String>,
}

/// Удаление аккаунта (отзыв согласия, ст. 21 152-ФЗ): аккаунт, сессии, история, рейтинг
/// и участие в матчах удаляются сразу, активные соединения закрываются.
async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Authed(s): Authed,
    Json(body): Json<DeleteRequest>,
) -> ApiResult<Response> {
    state.check_limit(&headers, "auth").await?;
    match s.user.password() {
        Some((salt, hash)) => {
            let password = body.password.unwrap_or_default();
            if !chars_between(&password, 12, 128) || !same_hash(&hash_password(&state, &password, salt).await?, hash) {
                state.hit_limit(&headers, "auth").await;
                return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Пароль неверен."));
            }
        }
        None if !confirmed(body.confirm.as_deref()) => return Err(ApiError::bad(CONFIRM_MESSAGE)),
        None => {}
    }
    if crate::matches::active_match(&state, s.user.id).await?.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Сначала заверши текущую дуэль."));
    }
    let _ = crate::queue::leave(&state, s.user.id).await;
    sqlx::query("DELETE FROM users WHERE id = $1").bind(s.user.id).execute(&state.db).await?;
    state.revoke(crate::realtime::Revoke::User(s.user.id)).await;
    tracing::info!(user = %s.user.id, "account deleted on request");
    Ok(with_cookie(StatusCode::OK, cookie(&state, "", 0), serde_json::json!({ "ok": true })))
}

/// Выгрузка своих данных (ст. 14 152-ФЗ): всё, что сервер хранит о пользователе.
async fn export(State(state): State<AppState>, Authed(s): Authed) -> ApiResult<Response> {
    let id = s.user.id;
    type ConsentRow = (Option<time::OffsetDateTime>, Option<String>, time::OffsetDateTime, Option<String>, Option<String>);
    let consent: ConsentRow =
        sqlx::query_as("SELECT consent_at, consent_version, created_at, age_group, parent_name FROM users WHERE id = $1")
            .bind(id)
            .fetch_one(&state.db)
            .await?;
    let identities: Vec<(String, String, time::OffsetDateTime)> =
        sqlx::query_as("SELECT provider, subject, created_at FROM identities WHERE user_id = $1 ORDER BY created_at")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    type AttemptRow = (Uuid, time::OffsetDateTime, serde_json::Value, Option<String>, Option<bool>);
    let attempts: Vec<AttemptRow> =
        sqlx::query_as("SELECT id, at, payload, algorithm, words_checked FROM attempts WHERE user_id = $1 ORDER BY at")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    // Исполнения для точной оценки и свои треки: только сведения, без звука.
    let perfs: Vec<(Uuid, String, String, String, i32, time::OffsetDateTime)> = sqlx::query_as(
        "SELECT id, song_id, mode, consent_version, chunks, created_at FROM perfs WHERE owner_user = $1 ORDER BY created_at",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let tracks: Vec<(Uuid, String, String, time::OffsetDateTime, time::OffsetDateTime)> =
        sqlx::query_as("SELECT id, title, language, created_at, expires_at FROM tracks WHERE user_id = $1 ORDER BY created_at")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    type MatchRow = (Uuid, String, String, String, Option<String>, Option<f64>, time::OffsetDateTime, Option<Vec<u8>>);
    let matches: Vec<MatchRow> = sqlx::query_as(
        "SELECT m.id, m.kind, m.state, m.song_id, p.outcome, p.score, m.created_at, p.curve
         FROM match_participants p JOIN matches m ON m.id = p.match_id WHERE p.user_id = $1 ORDER BY m.created_at",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;
    let rating_events: Vec<(Uuid, f64, f64, time::OffsetDateTime)> =
        sqlx::query_as("SELECT match_id, mmr_before, mmr_after, created_at FROM rating_events WHERE user_id = $1 ORDER BY id")
            .bind(id)
            .fetch_all(&state.db)
            .await?;
    let ts = |t: &time::OffsetDateTime| t.format(&time::format_description::well_known::Rfc3339).unwrap_or_default();
    let body = serde_json::json!({
        "exported_at": ts(&time::OffsetDateTime::now_utc()),
        "profile": profile(&state, &s.user).await?,
        "friends": crate::friends::for_user(&state, id).await?,
        "account_created_at": ts(&consent.2),
        "consent": { "at": consent.0.as_ref().map(ts), "version": consent.1 },
        "age": { "group": consent.3, "parent_name": consent.4 },
        "identities": identities.iter().map(|(provider, subject, at)| serde_json::json!({ "provider": provider, "subject": subject, "created_at": ts(at) })).collect::<Vec<_>>(),
        "rating": crate::ratings::summary(&state, id).await?,
        "attempts": attempts.iter().map(|(aid, at, p, algorithm, words)| serde_json::json!({
            "id": aid, "at": ts(at), "result": p, "algorithm": algorithm, "words_checked": words,
        })).collect::<Vec<_>>(),
        "precise_performances": perfs.iter().map(|(pid, song, mode, consent, chunks, at)| serde_json::json!({
            "id": pid, "song_id": song, "mode": mode, "voice_consent_version": consent, "chunks": chunks, "created_at": ts(at),
        })).collect::<Vec<_>>(),
        "own_tracks": tracks.iter().map(|(tid, title, language, at, expires)| serde_json::json!({
            "id": tid, "title": title, "language": language, "created_at": ts(at), "expires_at": ts(expires),
        })).collect::<Vec<_>>(),
        "matches": matches.iter().map(|(mid, kind, st, song, outcome, score, at, curve)| serde_json::json!({
            "id": mid, "kind": kind, "state": st, "song_id": song, "outcome": outcome, "score": score, "created_at": ts(at),
            "curve_tenths_of_semitone_50ms": curve.as_deref().map(crate::matches::curve_values),
        })).collect::<Vec<_>>(),
        "rating_events": rating_events.iter().map(|(mid, b, a, at)| serde_json::json!({ "match_id": mid, "mmr_before": b, "mmr_after": a, "at": ts(at) })).collect::<Vec<_>>(),
        "not_stored": "Запись голоса уходит на сервер только при точной оценке и только с отдельного согласия; её обрабатывает компьютер команды в России, после оценки она удаляется, не позже чем через 10 минут, поэтому в выгрузку не входит. Итоги точной оценки и сведения об исполнениях хранятся сутки. Свои треки и их файлы удаляются через 24 часа; файлы в выгрузку не входят. Кривые высоты дуэлей хранятся 30 дней, затем удаляются; пока они есть, они включены в выгрузку. Адрес IP используется только для ограничения частоты запросов и хранится не дольше часа.",
    });
    Ok((
        StatusCode::OK,
        [(header::CONTENT_DISPOSITION, "attachment; filename=\"perepev-data.json\"".to_owned())],
        Json(body),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Векторы получены из Node: crypto.scryptSync(password, salt, 64, {N: 131072, r: 8, p: 1}).
    #[test]
    fn legacy_scrypt_hashes_verify() {
        let key = derive("Long-demo-pass-2026", "0123456789abcdef0123456789abcdef");
        assert!(same_hash(&key, "3081dfccd5bd1d7097a716a04d788d7e5f574ca3ecfac25756802dbc08e0ad9890bf8c78c7e31f19716164e0a4154ae7fb76c4e68719e2146fffbd3f7bed8ea8"));
        let key = derive("Пароль-с-юникодом 🎤", DUMMY_SALT);
        assert!(same_hash(&key, "a533abffbd1d055e356644c76659b9e0120698d3e8f1128fc52eadb7eeabcb8b7cd20f4673d7857dc79959d105d3d3b3f7a671546b7ef2ca6ca3a54d543ed28f"));
        assert!(!same_hash(&key, "00"));
    }

    #[test]
    fn email_rule_matches_legacy_regex() {
        for ok in ["a@b.c", "singer@example.test", "x.y@sub.domain.ru", "a@b.c.", "a@b..c"] {
            assert!(valid_email(ok), "{ok}");
        }
        for bad in ["bad", "a@b", "a b@c.d", "@b.c", "a@.c", "a@b.", "a@@b.c"] {
            assert!(!valid_email(bad), "{bad}");
        }
    }
}
