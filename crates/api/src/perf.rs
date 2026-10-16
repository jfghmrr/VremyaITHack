//! Точная оценка исполнения (C3): исполнение создаётся с согласием на обработку записи
//! голоса, во время пения приходят куски PCM, по завершении ставится задача `score`
//! (её id совпадает с id исполнения), браузер опрашивает статус и получает `PreciseResult`.
//!
//! Без обработчика (не настроен или молчит дольше 30 секунд) исполнение не создаётся: 503,
//! голос не загружается. Если обработчик пропал во время пения или не уложился в срок после
//! конца песни, статус сразу `offline`: интерфейс оставляет предварительный балл окончательным.
use crate::accounts::{MaybeSession, Session};
use crate::error::{ApiError, ApiResult};
use crate::jobs::{self, Job, NewJob};
use crate::state::AppState;
use crate::util::random_hex;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use scoring_core::{Bleed, LyricWord, PitchFrame, Song, WordEvidence, WordInput};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::PathBuf;
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const GUEST_COOKIE: &str = "perepev_guest";
const GUEST_MAX_AGE: i64 = 24 * 3600;
pub const SAMPLE_RATE: u32 = 16_000;
pub const CHUNK_MAX: usize = 400 * 1024;
/// 70 секунд PCM16 моно 16 кГц.
pub const AUDIO_MAX: usize = 70 * SAMPLE_RATE as usize * 2;
const MAX_CHUNKS: u32 = 256;
/// Дорожки, которые слышал певец; обработчик сверяет с ними запись (проникновение звука).
pub const STEMS: [&str; 2] = ["instrumental.mp3", "guide.mp3"];
/// 70 с при шаге 10 мс с запасом.
const MAX_FRAMES: usize = 8000;
const MAX_WORDS: usize = 2000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/perf", post(create))
        .route("/api/perf/{id}", get(status))
        .route("/api/perf/{id}/finish", post(finish))
}

pub fn upload_routes() -> Router<AppState> {
    crate::util::body_limit(Router::new().route("/api/perf/{id}/chunk", put(chunk)), CHUNK_MAX)
}

fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "Исполнение не найдено.")
}

/// Песня исполнения: каталог или свой трек `my-<uuid>`.
enum SongRef {
    Catalog(String),
    Track(Uuid),
}

impl SongRef {
    fn parse(id: &str) -> Option<Self> {
        match id.strip_prefix("my-") {
            Some(rest) => Uuid::parse_str(rest).ok().map(Self::Track),
            None => Some(Self::Catalog(id.to_owned())),
        }
    }
}

/// Каталог файлов песни (стемы, слова). Для каталога — только известные id.
pub fn song_dir(st: &AppState, song_id: &str) -> Option<PathBuf> {
    match SongRef::parse(song_id)? {
        SongRef::Catalog(id) => st.catalog.get(&id).map(|_| std::path::Path::new(&st.cfg.songs_dir).join(id)),
        SongRef::Track(id) => Some(crate::tracks::track_dir(st, id)),
    }
}

/// Язык и эталон песни. Свой трек должен быть готов; `user` проверяет владельца.
async fn song_source(st: &AppState, song_id: &str, user: Option<Uuid>) -> ApiResult<Option<(String, Song)>> {
    Ok(match SongRef::parse(song_id) {
        Some(SongRef::Catalog(id)) => {
            st.catalog.get(&id).map(|c| (c.language.clone().unwrap_or_else(|| "en".into()), c.song.clone()))
        }
        Some(SongRef::Track(id)) => crate::tracks::ready(st, id, user).await?,
        None => None,
    })
}

fn guest_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|c| c.trim().strip_prefix(&format!("{GUEST_COOKIE}=")).map(str::to_owned))
        .filter(|k| k.len() == 32 && k.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

fn guest_cookie(st: &AppState, key: &str) -> String {
    let secure = if st.cfg.secure_cookies { "; Secure" } else { "" };
    format!("{GUEST_COOKIE}={key}; Path=/; HttpOnly; SameSite=Strict; Max-Age={GUEST_MAX_AGE}{secure}")
}

#[derive(sqlx::FromRow)]
struct Perf {
    song_id: String,
    owner_user: Option<Uuid>,
    guest_key: Option<String>,
    mode: String,
    chunks: i32,
    job_id: Option<Uuid>,
}

/// Исполнение текущего пользователя или текущего браузера гостя; чужое — 404.
async fn owned(st: &AppState, id: Uuid, session: &Option<Session>, headers: &HeaderMap) -> ApiResult<Perf> {
    let perf: Option<Perf> =
        sqlx::query_as("SELECT song_id, owner_user, guest_key, mode, chunks, job_id FROM perfs WHERE id = $1")
            .bind(id)
            .fetch_optional(&st.db)
            .await?;
    let guest = guest_key(headers);
    let allowed = |p: &Perf| match (p.owner_user, &p.guest_key) {
        (Some(user), _) => session.as_ref().is_some_and(|s| s.user.id == user),
        (None, Some(key)) => guest.as_ref().is_some_and(|g| bool::from(g.as_bytes().ct_eq(key.as_bytes()))),
        (None, None) => false,
    };
    perf.filter(allowed).ok_or_else(not_found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewPerf {
    song_id: Option<String>,
    mode: Option<String>,
    voice_consent: Option<bool>,
    consent_version: Option<String>,
}

async fn create(
    State(st): State<AppState>,
    headers: HeaderMap,
    MaybeSession(session): MaybeSession,
    Json(b): Json<NewPerf>,
) -> ApiResult<Response> {
    let ip = st.client_ip(&headers);
    st.rate_limit("perf", &ip, st.cfg.perf_limit_per_hour, 3600, "Слишком много попыток точной оценки. Попробуй через час.").await?;
    let version = b.consent_version.filter(|v| (1..=32).contains(&v.len()) && v.bytes().all(|c| c.is_ascii_graphic()));
    let (Some(true), Some(version)) = (b.voice_consent, version) else {
        return Err(ApiError::bad("Для точной оценки нужно согласие на обработку записи голоса."));
    };
    let Some(mode) = b.mode.filter(|m| m == "headphones" || m == "speaker") else {
        return Err(ApiError::bad("Неизвестный режим пения."));
    };
    let song_id = b.song_id.unwrap_or_default();
    let user = session.as_ref().map(|s| s.user.id);
    if song_id.len() > 64 || song_source(&st, &song_id, Some(user.unwrap_or(Uuid::nil()))).await?.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Песня не найдена."));
    }
    // Минимизация данных: голос не принимается, если оценить его некому. Браузер оставляет
    // свой балл окончательным с пометкой «слова не проверены».
    if st.cfg.worker_token_sha256.is_none() || !st.worker_online().await {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Точная оценка сейчас недоступна: компьютер команды не на связи. Балл посчитает браузер.",
        ));
    }
    let guest = match user {
        Some(_) => None,
        None => Some(guest_key(&headers).unwrap_or_else(|| random_hex(16))),
    };
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO perfs (id, song_id, owner_user, guest_key, mode, consent_version) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(id)
        .bind(&song_id)
        .bind(user)
        .bind(&guest)
        .bind(&mode)
        .bind(&version)
        .execute(&st.db)
        .await?;
    let body = Json(json!({ "id": id }));
    Ok(match guest {
        Some(key) => (StatusCode::CREATED, [(header::SET_COOKIE, guest_cookie(&st, &key))], body).into_response(),
        None => (StatusCode::CREATED, body).into_response(),
    })
}

#[derive(Deserialize)]
struct Seq {
    seq: u32,
}

fn chunk_name(seq: u32) -> String {
    format!("chunk-{seq:03}.pcm")
}

/// Кусок записи: сырой PCM16 LE, 16 кГц, моно. Повтор того же `seq` заменяет кусок.
async fn chunk(
    State(st): State<AppState>,
    headers: HeaderMap,
    MaybeSession(session): MaybeSession,
    Path(id): Path<Uuid>,
    Query(q): Query<Seq>,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let perf = owned(&st, id, &session, &headers).await?;
    if perf.job_id.is_some() {
        return Err(ApiError::new(StatusCode::CONFLICT, "Запись уже отправлена на оценку."));
    }
    if q.seq >= MAX_CHUNKS || body.is_empty() || !body.len().is_multiple_of(2) {
        return Err(ApiError::bad("Ожидается часть записи PCM16."));
    }
    let dir = jobs::job_dir(&st, id);
    let name = chunk_name(q.seq);
    let mut total = body.len();
    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let other = entry.file_name().to_str().is_some_and(|n| n.starts_with("chunk-") && n != name);
            if other {
                total += entry.metadata().await.map_or(0, |m| m.len() as usize);
            }
        }
    }
    if total > AUDIO_MAX {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Запись длиннее 70 секунд."));
    }
    jobs::write_file(&dir.join(name), &body).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Finish {
    chunks: Option<u32>,
}

/// Склеивает куски в WAV и ставит задачу оценки. Повторный вызов ничего не меняет.
async fn finish(
    State(st): State<AppState>,
    headers: HeaderMap,
    MaybeSession(session): MaybeSession,
    Path(id): Path<Uuid>,
    Json(b): Json<Finish>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let accepted = || (StatusCode::ACCEPTED, Json(json!({ "ok": true })));
    let perf = owned(&st, id, &session, &headers).await?;
    if perf.job_id.is_some() {
        return Ok(accepted());
    }
    let Some(n) = b.chunks.filter(|n| (1..=MAX_CHUNKS).contains(n)) else {
        return Err(ApiError::bad("Некорректное число частей записи."));
    };
    let dir = jobs::job_dir(&st, id);
    let mut pcm = Vec::new();
    for seq in 0..n {
        let Some(part) = jobs::read_file(&dir.join(chunk_name(seq))).await? else {
            return Err(ApiError::new(StatusCode::CONFLICT, "Часть записи не дошла. Останется предварительная оценка."));
        };
        pcm.extend(part);
        if pcm.len() > AUDIO_MAX {
            return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "Запись длиннее 70 секунд."));
        }
    }
    let params = score_params(&st, &perf).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Песня не найдена."))?;
    let mut wav = jobs::wav_header(SAMPLE_RATE, pcm.len() as u32).to_vec();
    wav.extend(pcm);
    jobs::write_file(&jobs::input_path(&st, id), &wav).await?;
    for seq in 0..n {
        let _ = tokio::fs::remove_file(dir.join(chunk_name(seq))).await;
    }
    let mut tx = st.db.begin().await?;
    jobs::enqueue(
        &mut *tx,
        NewJob {
            id,
            kind: "score",
            priority: jobs::SCORE_PRIORITY,
            owner_user: perf.owner_user,
            guest_key: perf.guest_key.as_deref(),
            params,
        },
    )
    .await?;
    sqlx::query("UPDATE perfs SET job_id = $1, chunks = $2 WHERE id = $1")
        .bind(id)
        .bind(n as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(accepted())
}

#[derive(Deserialize)]
struct WordsFile {
    lines: Vec<WordsLine>,
}

#[derive(Deserialize)]
struct WordsLine {
    line: usize,
    words: Vec<WordsWord>,
}

#[derive(Deserialize)]
struct WordsWord {
    text: String,
    start_s: f64,
    end_s: f64,
}

/// Слова `lyrics.words.json` по порядку: номер, строка, текст и границы.
fn numbered_words(bytes: &[u8]) -> Vec<Value> {
    let Ok(file) = serde_json::from_slice::<WordsFile>(bytes) else { return Vec::new() };
    file.lines
        .iter()
        .flat_map(|l| l.words.iter().map(move |w| (l.line, w)))
        .enumerate()
        .map(|(index, (line, w))| json!({ "index": index, "line": line, "text": w.text, "start_s": w.start_s, "end_s": w.end_s }))
        .collect()
}

/// Проверяются ли слова песни при точной оценке. Свои треки — всегда; песня каталога —
/// если в index.json не стоит `"wordsCheck": false`.
fn words_checked(st: &AppState, song_id: &str) -> bool {
    match SongRef::parse(song_id) {
        Some(SongRef::Catalog(id)) => st.catalog.get(&id).is_none_or(|c| c.words_check),
        _ => true,
    }
}

/// Параметры задачи `score` (C2): слова и стемы из файлов песни, язык, длительность, режим.
/// Для песни без проверки слов уходит `words: []`: обработчик не сопоставляет слова, и
/// `complete` считает балл по мелодии (`wordsChecked: false`, без предела за слова).
async fn score_params(st: &AppState, perf: &Perf) -> ApiResult<Option<Value>> {
    let (Some(dir), Some((language, song))) = (song_dir(st, &perf.song_id), song_source(st, &perf.song_id, None).await?) else {
        return Ok(None);
    };
    let words = if words_checked(st, &perf.song_id) {
        jobs::read_file(&dir.join("lyrics.words.json")).await?.map(|b| numbered_words(&b)).unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut assets = Vec::new();
    for name in STEMS {
        if tokio::fs::try_exists(dir.join(name)).await.unwrap_or(false) {
            assets.push(name);
        }
    }
    Ok(Some(json!({
        "sample_rate": SAMPLE_RATE,
        "language": language,
        "duration_s": song.duration_s,
        "words": words,
        "assets": assets,
        "mode": perf.mode,
    })))
}

#[derive(Deserialize)]
struct ScoreOutput {
    frames: Vec<PitchFrame>,
    #[serde(default)]
    words: Vec<WordEvidence>,
    #[serde(default)]
    bleed: Option<Bleed>,
}

/// Итог задачи `score`: окончательный балл считает сервер общим ядром оценки.
/// Пустой список свидетельств означает, что слова не проверялись.
pub async fn complete(st: &AppState, job: &Job, body: Value) -> ApiResult<()> {
    let out: ScoreOutput = serde_json::from_value(body).map_err(|_| ApiError::bad("Некорректный ScoreOutput."))?;
    if out.frames.len() > MAX_FRAMES || out.words.len() > MAX_WORDS {
        return Err(ApiError::bad("Слишком много кадров или слов."));
    }
    let song_id: Option<(String,)> = sqlx::query_as("SELECT song_id FROM perfs WHERE id = $1").bind(job.id).fetch_optional(&st.db).await?;
    let song = match song_id.as_ref().map(|s| SongRef::parse(&s.0)) {
        Some(Some(SongRef::Catalog(id))) => st.catalog.get(&id).map(|c| c.song.clone()),
        Some(Some(SongRef::Track(id))) => crate::tracks::load_reference(st, id).await?,
        _ => None,
    };
    let Some(song) = song else {
        // Свой трек удалён во время оценки: результат больше некуда показать.
        return jobs::finish_failed(st, job.id, "song missing").await;
    };
    let lyric: Vec<LyricWord> = serde_json::from_value(job.params["words"].clone()).unwrap_or_default();
    let words = (!lyric.is_empty() && !out.words.is_empty()).then_some(WordInput { words: lyric, evidence: out.words });
    let (frames, bleed) = (out.frames, out.bleed);
    let result = st
        .compute
        .run(move || scoring_core::score_precise(&frames, &song, words.as_ref(), bleed.as_ref()))
        .await
        .map_err(|_| ApiError::busy())?;
    jobs::finish_done(st, job.id, &serde_json::to_value(&result)?).await
}

/// Статус для браузера. `offline`, если обработчик молчит или срок после конца пения истёк.
async fn status(
    State(st): State<AppState>,
    headers: HeaderMap,
    MaybeSession(session): MaybeSession,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let perf = owned(&st, id, &session, &headers).await?;
    let job: Option<(String, Option<Value>, Option<String>, bool)> = match perf.job_id {
        Some(job) => {
            sqlx::query_as(
                "SELECT status, result, error, created_at < now() - make_interval(secs => $2) FROM jobs WHERE id = $1",
            )
            .bind(job)
            .bind(st.cfg.perf_deadline_s as f64)
            .fetch_optional(&st.db)
            .await?
        }
        None => None,
    };
    let online = st.worker_online().await;
    let (status, result) = match job {
        // Результат уже удалён по сроку хранения.
        None if perf.chunks > 0 => ("failed", None),
        None => (if online { "queued" } else { "offline" }, None),
        Some((s, result, error, overdue)) => match s.as_str() {
            "done" => ("done", result),
            "failed" if error.as_deref() == Some("deadline") => ("offline", None),
            "failed" => ("failed", None),
            _ if overdue || !online => ("offline", None),
            "running" => ("running", None),
            _ => ("queued", None),
        },
    };
    Ok(Json(json!({ "status": status, "result": result })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_numbered_across_lines() {
        let file = br#"{"v":1,"lines":[{"line":0,"words":[{"text":"A","start_s":1,"end_s":1.5},{"text":"b","start_s":1.5,"end_s":2}]},
            {"line":1,"words":[{"text":"c","start_s":3,"end_s":3.4}]}]}"#;
        let words = numbered_words(file);
        assert_eq!(words.len(), 3);
        assert_eq!(words[2], json!({ "index": 2, "line": 1, "text": "c", "start_s": 3.0, "end_s": 3.4 }));
        assert!(numbered_words(b"not json").is_empty());
    }

    #[test]
    fn song_ids_split_catalog_and_tracks() {
        assert!(matches!(SongRef::parse("cn-earth"), Some(SongRef::Catalog(id)) if id == "cn-earth"));
        let id = Uuid::new_v4();
        assert!(matches!(SongRef::parse(&format!("my-{id}")), Some(SongRef::Track(t)) if t == id));
        assert!(SongRef::parse("my-not-a-uuid").is_none());
    }

    #[test]
    fn guest_key_requires_32_lowercase_hex() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "a=1; perepev_guest=0123456789abcdef0123456789abcdef".parse().unwrap());
        assert_eq!(guest_key(&h).as_deref(), Some("0123456789abcdef0123456789abcdef"));
        h.insert(header::COOKIE, "perepev_guest=0123456789ABCDEF0123456789ABCDEF".parse().unwrap());
        assert_eq!(guest_key(&h), None);
    }
}
