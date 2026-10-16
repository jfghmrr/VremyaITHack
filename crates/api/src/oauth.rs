//! Вход через Яндекс ID и VK ID: authorization code с PKCE S256.
//!
//! Начало входа кладёт state в Valkey на 10 минут (ключ — хеш state) и привязывает его
//! к браузеру временной cookie `perepev_oauth`. Ответ провайдера принимается только с
//! той же cookie и только один раз. Известная учётная запись сразу получает сессию;
//! новая — одноразовый токен регистрации (тоже в cookie этого браузера), по которому
//! `/api/auth/complete` создаёт кабинет после согласия и выбора возраста.
//! Токены, коды и секреты в журнал не пишутся.
use crate::accounts::{self, CONSENT_VERSION};
use crate::config::{OAuthClient, OAuthConfig};
use crate::error::{ApiError, ApiResult};
use crate::state::{AppState, KEY_PREFIX, Rate};
use crate::util::{random_hex, sha256_hex};
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use redis::AsyncCommands;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::Duration;
use subtle::ConstantTimeEq;
use uuid::Uuid;

const COOKIE: &str = "perepev_oauth";
/// Срок жизни state и токена регистрации.
const TTL_SECONDS: u64 = 600;
/// Каждое начало входа занимает запись в Valkey: ограничиваем частоту с одного адреса.
const START_RATE: Rate = Rate { max: 60, window_seconds: 900, message: "Слишком много попыток входа. Попробуй через 15 минут." };
/// Куда вернуть после входа, если адрес возврата не указан или не прошёл проверку.
const DEFAULT_RETURN: &str = "/account";

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/providers", get(providers))
        .route("/api/auth/complete", post(complete))
        .route("/api/auth/{provider}/start", get(start))
        .route("/api/auth/{provider}/callback", get(callback))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Provider {
    Yandex,
    Vk,
}

impl Provider {
    const ALL: [Provider; 2] = [Provider::Yandex, Provider::Vk];

    fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.name() == name)
    }

    fn name(self) -> &'static str {
        match self {
            Self::Yandex => "yandex",
            Self::Vk => "vk",
        }
    }

    fn client(self, cfg: &OAuthConfig) -> Option<&OAuthClient> {
        match self {
            Self::Yandex => cfg.yandex.as_ref(),
            Self::Vk => cfg.vk.as_ref(),
        }
    }

    fn authorize_url(self, cfg: &OAuthConfig) -> String {
        match self {
            Self::Yandex => format!("{}/authorize", cfg.yandex_base),
            Self::Vk => format!("{}/authorize", cfg.vk_base),
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::Yandex => "login:info",
            Self::Vk => "vkid.personal_info",
        }
    }

    fn redirect_uri(self, cfg: &OAuthConfig) -> String {
        format!("{}/api/auth/{}/callback", cfg.public_origin, self.name())
    }
}

/// Начатый вход: хранится в Valkey под хешем state.
#[derive(Serialize, Deserialize)]
struct Pending {
    provider: String,
    verifier: String,
    #[serde(rename = "return")]
    ret: String,
}

/// Новая учётная запись провайдера, ожидающая согласия и возраста.
#[derive(Serialize, Deserialize)]
struct Signup {
    provider: String,
    subject: String,
}

fn state_key(state: &str) -> String {
    format!("{KEY_PREFIX}oauth:state:{}", sha256_hex(state.as_bytes()))
}

fn signup_key(token: &str) -> String {
    format!("{KEY_PREFIX}oauth:signup:{}", sha256_hex(token.as_bytes()))
}

/// Временная cookie начатого входа. SameSite=Lax: браузер пришлёт её при возврате
/// с сайта провайдера (межсайтовая навигация верхнего уровня).
fn oauth_cookie(st: &AppState, value: &str, max_age: u64) -> String {
    let secure = if st.cfg.secure_cookies { "; Secure" } else { "" };
    format!("{COOKIE}={value}; Path=/api/auth/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}")
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .map(str::trim)
        .find_map(|c| c.strip_prefix(&format!("{COOKIE}=")).map(str::to_owned))
}

fn redirect(location: &str, cookies: &[String]) -> Response {
    let location = HeaderValue::from_str(location).unwrap_or(HeaderValue::from_static(DEFAULT_RETURN));
    let mut response = (StatusCode::FOUND, [(header::LOCATION, location)]).into_response();
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(c) {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    response
}

/// Неудачный вход: страница кабинета показывает понятное сообщение по коду.
/// Коды: `state`, `denied`, `provider`, `limit`, `server`.
fn fail(code: &str, cookies: &[String]) -> Response {
    redirect(&format!("/account?authError={code}"), cookies)
}

/// Адрес возврата после входа: только относительный путь своего сайта, иначе /account.
/// Отсекаются `//host`, обратные слеши, управляющие символы и пробелы (браузер
/// выбрасывает их из адреса), не-ASCII и пути API.
fn safe_return(ret: Option<&str>) -> String {
    let Some(r) = ret else { return DEFAULT_RETURN.to_owned() };
    let path = r.split(['?', '#']).next().unwrap_or("");
    let ok = r.len() <= 512
        && r.starts_with('/')
        && !r.starts_with("//")
        && r.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'\\')
        && path != "/api"
        && !path.starts_with("/api/");
    if ok { r.to_owned() } else { DEFAULT_RETURN.to_owned() }
}

/// base64url без выравнивания (RFC 4648 §5), как требует PKCE.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, &b)| acc | (u32::from(b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// code_challenge = BASE64URL(SHA256(code_verifier)), метод S256 (RFC 7636 §4.2).
fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// Нейтральное игровое имя нового пользователя провайдера: настоящее имя не публикуется.
fn nickname() -> String {
    format!("Певец-{:04}", rand::random_range(0..10_000u32))
}

async fn providers(State(st): State<AppState>) -> Json<serde_json::Value> {
    let list: Vec<&str> = Provider::ALL.into_iter().filter(|p| p.client(&st.cfg.oauth).is_some()).map(Provider::name).collect();
    Json(serde_json::json!({ "providers": list }))
}

#[derive(Deserialize)]
struct StartQuery {
    #[serde(rename = "return")]
    ret: Option<String>,
}

async fn start(State(st): State<AppState>, headers: HeaderMap, Path(name): Path<String>, Query(q): Query<StartQuery>) -> ApiResult<Response> {
    let cfg = &st.cfg.oauth;
    let Some((provider, client)) = Provider::parse(&name).and_then(|p| Some((p, p.client(cfg)?))) else {
        return Ok(fail("provider", &[]));
    };
    if st.check_rate(&headers, "oauth", &START_RATE).await.is_err() {
        return Ok(fail("limit", &[]));
    }
    st.hit_rate(&headers, "oauth", &START_RATE).await;
    // 64 шестнадцатеричных символа: state не короче 43 (VK требует от 32), verifier в пределах 43–128.
    let state = random_hex(32);
    let verifier = random_hex(32);
    let pending = Pending { provider: provider.name().to_owned(), verifier, ret: safe_return(q.ret.as_deref()) };
    let mut c = st.valkey.clone();
    let _: () = c.set_ex(state_key(&state), serde_json::to_string(&pending)?, TTL_SECONDS).await?;
    let mut url = reqwest::Url::parse(&provider.authorize_url(cfg))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client.id)
        .append_pair("redirect_uri", &provider.redirect_uri(cfg))
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge(&pending.verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("scope", provider.scope());
    Ok(redirect(url.as_str(), &[oauth_cookie(&st, &state, TTL_SECONDS)]))
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    device_id: Option<String>,
    error: Option<String>,
}

async fn callback(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    query: Result<Query<CallbackQuery>, QueryRejection>,
) -> Response {
    let clear = oauth_cookie(&st, "", 0);
    let Ok(Query(q)) = query else { return fail("state", &[clear]) };
    match finish(&st, &headers, &name, q).await {
        Ok(Outcome::Session { ret, cookie }) => redirect(&ret, &[clear, cookie]),
        // Токен регистрации заменяет state во временной cookie: завершить регистрацию
        // можно только в том же браузере.
        Ok(Outcome::Signup(token)) => redirect(&format!("/account?signup={token}"), &[oauth_cookie(&st, &token, TTL_SECONDS)]),
        Ok(Outcome::Failed(code)) => fail(code, &[clear]),
        // Подробности уже записаны в журнал при преобразовании в ApiError.
        Err(_) => fail("server", &[clear]),
    }
}

enum Outcome {
    Session { ret: String, cookie: String },
    Signup(String),
    Failed(&'static str),
}

async fn finish(st: &AppState, headers: &HeaderMap, name: &str, q: CallbackQuery) -> ApiResult<Outcome> {
    let Some(provider) = Provider::parse(name) else { return Ok(Outcome::Failed("provider")) };
    // State израсходован в любом случае, включая отказ пользователя у провайдера.
    let pending = take_pending(st, headers, q.state.as_deref(), provider).await?;
    if let Some(error) = q.error {
        return Ok(Outcome::Failed(if error == "access_denied" { "denied" } else { "provider" }));
    }
    let (Some(pending), Some(state)) = (pending, q.state) else { return Ok(Outcome::Failed("state")) };
    let cfg = &st.cfg.oauth;
    let (Some(client), Some(code)) = (provider.client(cfg), q.code.filter(|c| !c.is_empty())) else {
        return Ok(Outcome::Failed("provider"));
    };
    let subject = match provider {
        Provider::Yandex => yandex_subject(cfg, client, &code, &pending.verifier).await,
        Provider::Vk => match q.device_id.filter(|d| !d.is_empty()) {
            Some(device) => vk_subject(cfg, client, &code, &pending.verifier, &device, &state).await,
            None => Err("no device_id".to_owned()),
        },
    };
    let subject = match subject {
        Ok(s) => s,
        Err(reason) => {
            tracing::warn!(provider = provider.name(), %reason, "oauth: code exchange failed");
            return Ok(Outcome::Failed("provider"));
        }
    };
    let known: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM identities WHERE provider = $1 AND subject = $2")
        .bind(provider.name())
        .bind(&subject)
        .fetch_optional(&st.db)
        .await?;
    if let Some(user) = known {
        let cookie = accounts::new_session(st, headers, user).await?;
        return Ok(Outcome::Session { ret: pending.ret, cookie });
    }
    let token = random_hex(32);
    let signup = Signup { provider: provider.name().to_owned(), subject };
    let mut c = st.valkey.clone();
    let _: () = c.set_ex(signup_key(&token), serde_json::to_string(&signup)?, TTL_SECONDS).await?;
    Ok(Outcome::Signup(token))
}

/// Начатый вход по state из адреса: только при совпадении с cookie этого браузера и только
/// один раз (GETDEL). Чужая ссылка, повтор и просроченный state дают None.
async fn take_pending(st: &AppState, headers: &HeaderMap, state: Option<&str>, provider: Provider) -> ApiResult<Option<Pending>> {
    let (Some(state), Some(cookie)) = (state.filter(|s| !s.is_empty()), cookie_value(headers)) else { return Ok(None) };
    if !bool::from(cookie.as_bytes().ct_eq(state.as_bytes())) {
        return Ok(None);
    }
    let mut c = st.valkey.clone();
    let raw: Option<String> = redis::cmd("GETDEL").arg(state_key(state)).query_async(&mut c).await?;
    Ok(raw.and_then(|r| serde_json::from_str::<Pending>(&r).ok()).filter(|p| p.provider == provider.name()))
}

fn http() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("perepev-api")
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| "http client unavailable".to_owned())
}

/// Причина сбоя без адресов, тел и токенов: только вид ошибки и код ответа.
fn reason(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_decode() {
        "decode"
    } else {
        "request"
    };
    match e.status() {
        Some(s) => format!("{kind} {}", s.as_u16()),
        None => kind.to_owned(),
    }
}

async fn read_json<T: DeserializeOwned>(response: Result<reqwest::Response, reqwest::Error>, what: &str) -> Result<T, String> {
    let response = response.map_err(|e| format!("{what}: {}", reason(&e)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{what}: HTTP {}", status.as_u16()));
    }
    response.json::<T>().await.map_err(|e| format!("{what}: {}", reason(&e)))
}

/// Идентификатор пользователя у провайдера: строка или число в JSON.
fn subject_of(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[derive(Deserialize)]
struct AccessToken {
    access_token: String,
}

#[derive(Deserialize)]
struct YandexInfo {
    id: serde_json::Value,
}

/// Яндекс ID: код → токен (`POST {base}/token`), затем `GET {info}?format=json`; субъект — поле `id`.
async fn yandex_subject(cfg: &OAuthConfig, client: &OAuthClient, code: &str, verifier: &str) -> Result<String, String> {
    let http = http()?;
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client.id.as_str()),
        ("client_secret", client.secret.as_str()),
        ("code_verifier", verifier),
    ];
    let token: AccessToken = read_json(http.post(format!("{}/token", cfg.yandex_base)).form(&form).send().await, "token").await?;
    let mut info = reqwest::Url::parse(&cfg.yandex_info).map_err(|_| "info url".to_owned())?;
    info.query_pairs_mut().append_pair("format", "json");
    let user: YandexInfo = read_json(
        http.get(info).header(header::AUTHORIZATION, format!("OAuth {}", token.access_token)).send().await,
        "info",
    )
    .await?;
    subject_of(&user.id).ok_or_else(|| "info: no id".to_owned())
}

#[derive(Deserialize)]
struct VkToken {
    user_id: serde_json::Value,
    state: Option<String>,
}

/// VK ID (OAuth 2.1): `POST {base}/oauth2/auth` с device_id и code_verifier; субъект — `user_id`.
/// Публичный обмен с PKCE: секрет приложения VK здесь не передаётся.
async fn vk_subject(cfg: &OAuthConfig, client: &OAuthClient, code: &str, verifier: &str, device: &str, state: &str) -> Result<String, String> {
    let redirect_uri = Provider::Vk.redirect_uri(cfg);
    let form = [
        ("grant_type", "authorization_code"),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri.as_str()),
        ("code", code),
        ("client_id", client.id.as_str()),
        ("device_id", device),
        ("state", state),
    ];
    let token: VkToken = read_json(http()?.post(format!("{}/oauth2/auth", cfg.vk_base)).form(&form).send().await, "token").await?;
    if token.state.as_deref().is_some_and(|s| s != state) {
        return Err("token: state mismatch".to_owned());
    }
    subject_of(&token.user_id).ok_or_else(|| "token: no user_id".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Complete {
    token: Option<String>,
    consent: Option<bool>,
    age_group: Option<String>,
    parent_name: Option<String>,
}

/// Создание кабинета для новой учётной записи провайдера: согласие, возраст,
/// нейтральное имя «Певец-NNNN», привязка и сессия.
async fn complete(State(st): State<AppState>, headers: HeaderMap, Json(body): Json<Complete>) -> ApiResult<Response> {
    st.check_limit(&headers, "register").await?;
    st.hit_limit(&headers, "register").await;
    if body.consent != Some(true) {
        return Err(ApiError::bad("Чтобы создать кабинет, согласись на обработку персональных данных."));
    }
    let age = accounts::check_age(body.age_group.as_deref(), body.parent_name.as_deref())?;
    let expired = || ApiError::bad("Ссылка для входа устарела. Войди через Яндекс ID или VK ID ещё раз.");
    let token = body.token.filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(expired)?;
    if !cookie_value(&headers).is_some_and(|c| bool::from(c.as_bytes().ct_eq(token.as_bytes()))) {
        return Err(expired());
    }
    // Проверки тела выше не расходуют токен: после ошибки можно исправить форму.
    let mut c = st.valkey.clone();
    let raw: Option<String> = redis::cmd("GETDEL").arg(signup_key(&token)).query_async(&mut c).await?;
    let signup = raw.and_then(|r| serde_json::from_str::<Signup>(&r).ok()).ok_or_else(expired)?;
    let id = Uuid::new_v4();
    let mut tx = st.db.begin().await?;
    sqlx::query(
        "INSERT INTO users (id, email, name, password_salt, password_hash, consent_at, consent_version, age_group, parent_name)
         VALUES ($1, NULL, $2, NULL, NULL, now(), $3, $4, $5)",
    )
    .bind(id)
    .bind(nickname())
    .bind(CONSENT_VERSION)
    .bind(age.group)
    .bind(&age.parent_name)
    .execute(&mut *tx)
    .await?;
    let linked = sqlx::query("INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
        .bind(&signup.provider)
        .bind(&signup.subject)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let user_id = if linked == 1 {
        tx.commit().await?;
        tracing::info!(user = %id, provider = %signup.provider, "account created via provider");
        id
    } else {
        // Та же учётная запись успела завершить вход в другой вкладке: входим в её кабинет.
        tx.rollback().await?;
        sqlx::query_scalar("SELECT user_id FROM identities WHERE provider = $1 AND subject = $2")
            .bind(&signup.provider)
            .bind(&signup.subject)
            .fetch_one(&st.db)
            .await?
    };
    let cookie = accounts::new_session(&st, &headers, user_id).await?;
    let user = accounts::user_by_id(&st, user_id).await?;
    let profile = accounts::profile(&st, &user).await?;
    let mut response = accounts::with_cookie(StatusCode::CREATED, cookie, serde_json::json!({ "profile": profile }));
    if let Ok(clear) = HeaderValue::from_str(&oauth_cookie(&st, "", 0)) {
        response.headers_mut().append(header::SET_COOKIE, clear);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636, приложение B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn base64url_without_padding() {
        // RFC 4648 §10 с алфавитом base64url и без «=».
        for (input, expected) in [("", ""), ("f", "Zg"), ("fo", "Zm8"), ("foo", "Zm9v"), ("foob", "Zm9vYg"), ("fooba", "Zm9vYmE"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64url(input.as_bytes()), expected);
        }
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn return_path_stays_on_site() {
        for ok in ["/", "/songs", "/songs?lang=ru", "/account#top", "/sing/cn-earth"] {
            assert_eq!(safe_return(Some(ok)), ok);
        }
        for bad in [
            "", "songs", "//evil.test", "///evil.test", "/\\evil.test", "\\\\evil.test", "https://evil.test", "javascript:alert(1)",
            "/\t/evil.test", "/ /x", "/песни", "/api", "/api/logout", "/api?x", "/\u{7f}",
        ] {
            assert_eq!(safe_return(Some(bad)), DEFAULT_RETURN, "{bad:?}");
        }
        assert_eq!(safe_return(None), DEFAULT_RETURN);
        assert_eq!(safe_return(Some(&format!("/{}", "a".repeat(600)))), DEFAULT_RETURN);
    }

    #[test]
    fn nickname_is_neutral() {
        for _ in 0..100 {
            let n = nickname();
            let digits = n.strip_prefix("Певец-").expect("prefix");
            assert!(digits.len() == 4 && digits.bytes().all(|b| b.is_ascii_digit()), "{n}");
        }
    }

    #[test]
    fn provider_subject_accepts_string_or_number() {
        assert_eq!(subject_of(&serde_json::json!("1000")).as_deref(), Some("1000"));
        assert_eq!(subject_of(&serde_json::json!(4242)).as_deref(), Some("4242"));
        assert_eq!(subject_of(&serde_json::json!("")), None);
        assert_eq!(subject_of(&serde_json::json!(null)), None);
    }
}
