//! Управление матчами: единственный владелец на матч, последовательная обработка команд,
//! машина состояний, сбор кривых и согласованная запись результата и рейтинга.
//!
//! Состояния: created → waiting → ready_check → countdown → singing → collecting →
//! finished; отдельно cancelled (до начала пения, без рейтинга) и failed (сбой, без рейтинга).
use crate::accounts::Authed;
use crate::error::{ApiError, ApiResult};
use crate::lease::{self, Keys, Lease, LeaseError};
use crate::protocol::{
    MatchResult, MatchState, MatchView, PlayerResult, PlayerView, ServerMsg, SongRef,
};
use crate::ratings::{self, Rating};
use crate::realtime::{StreamId, key};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use redis::AsyncCommands;
use scoring_core::{Outcome, config::CANONICAL_HOP};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

/// Маркер «точка ещё не получена» в сериализованной кривой (значения 0..=1270, пауза −32768).
const MISSING: i16 = i16::MAX;
const PAUSE: i16 = i16::MIN;
const ROOM_SECONDS: i64 = 15 * 60;

/// Команда участника, доставляемая владельцу через поток `m:{id}:in`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub user: Uuid,
    #[serde(flatten)]
    pub cmd: Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Cmd {
    Accept,
    Decline,
    Ready { song_version: String, algorithm_version: u32 },
    Perf { from: u32, points: Vec<Option<i16>> },
    Finish { count: u32 },
    Leave,
    Joined,
}

/// Запись потока событий матча. `to` — адресное событие, `slot` — чья это кривая.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutEvent {
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<u8>,
    pub msg: ServerMsg,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Extra {
    disconnected_since: Option<i64>,
    joined_ms: Option<i64>,
}

/// Снимок для восстановления после смены владельца и для подключающихся клиентов.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Persist {
    pub view: MatchView,
    pub seq: u64,
    inbox: String,
    extra: Vec<Extra>,
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/matches", get(list)).route("/api/matches/{id}", get(one))
}

/// Итог матча доступен участнику и после закрытия вкладки.
async fn one(State(st): State<AppState>, Authed(s): Authed, Path(id): Path<Uuid>) -> ApiResult<Json<MatchView>> {
    let member: Option<(i16,)> = sqlx::query_as("SELECT slot FROM match_participants WHERE match_id = $1 AND user_id = $2")
        .bind(id)
        .bind(s.user.id)
        .fetch_optional(&st.db)
        .await?;
    if member.is_none() {
        return Err(ApiError::new(axum::http::StatusCode::NOT_FOUND, "Матч не найден."));
    }
    view_from_db(&st, id).await?.map(Json).ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "Матч не найден."))
}

async fn list(State(st): State<AppState>, Authed(s): Authed) -> ApiResult<Json<serde_json::Value>> {
    type Row = (Uuid, String, String, String, Option<String>, Option<f64>, Option<time::OffsetDateTime>, Option<serde_json::Value>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT m.id, m.kind, m.state, m.song_id, p.outcome, p.score, m.finished_at, m.result
         FROM match_participants p JOIN matches m ON m.id = p.match_id
         WHERE p.user_id = $1 AND m.state IN ('finished', 'cancelled', 'failed')
         ORDER BY m.created_at DESC LIMIT 50",
    )
    .bind(s.user.id)
    .fetch_all(&st.db)
    .await?;
    let items: Vec<_> = rows
        .into_iter()
        .map(|(id, kind, state, song, outcome, score, at, result)| {
            serde_json::json!({
                "id": id, "kind": kind, "state": state, "songId": song, "outcome": outcome, "score": score,
                "at": at.and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok()),
                "result": result,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "matches": items })))
}

#[derive(sqlx::FromRow)]
struct MatchRow {
    kind: String,
    state: String,
    song_id: String,
    song_version: String,
    algorithm_version: i32,
    duration_s: f64,
    room_code: Option<String>,
    start_at: Option<time::OffsetDateTime>,
    end_reason: Option<String>,
    result: Option<serde_json::Value>,
}

#[derive(sqlx::FromRow)]
struct PlayerRow {
    user_id: Uuid,
    slot: i16,
    name: String,
    mmr: Option<f64>,
    peak_mmr: Option<f64>,
    rated_matches: Option<i32>,
    queued_since_ms: Option<i64>,
}

fn standing(st: &AppState, r: Rating) -> String {
    if r.calibrating(&st.cfg.game) {
        format!("Калибровка {}/{}", r.rated_matches, st.cfg.game.calibration_matches)
    } else {
        ratings::rank(r.mmr).to_owned()
    }
}

fn ts_ms(t: time::OffsetDateTime) -> i64 {
    (t.unix_timestamp_nanos() / 1_000_000) as i64
}

async fn players(st: &AppState, id: Uuid) -> ApiResult<Vec<PlayerView>> {
    Ok(players_with_queue(st, id).await?.into_iter().map(|(p, _)| p).collect())
}

async fn players_with_queue(st: &AppState, id: Uuid) -> ApiResult<Vec<(PlayerView, Option<i64>)>> {
    let rows: Vec<PlayerRow> = sqlx::query_as(
        "SELECT p.user_id, p.slot, u.name, r.mmr, r.peak_mmr, r.rated_matches, p.queued_since_ms
         FROM match_participants p JOIN users u ON u.id = p.user_id LEFT JOIN ratings r ON r.user_id = p.user_id
         WHERE p.match_id = $1 ORDER BY p.slot",
    )
    .bind(id)
    .fetch_all(&st.db)
    .await?;
    let initial = Rating::initial(&st.cfg.game);
    Ok(rows
        .into_iter()
        .map(|r| {
            let rating = Rating {
                mmr: r.mmr.unwrap_or(initial.mmr),
                peak_mmr: r.peak_mmr.unwrap_or(initial.peak_mmr),
                rated_matches: r.rated_matches.unwrap_or(0),
            };
            let view = PlayerView {
                slot: r.slot as u8,
                user_id: r.user_id,
                name: r.name,
                standing: standing(st, rating),
                accepted: false,
                ready: false,
                connected: false,
                finished: false,
                left: false,
                points: 0,
            };
            (view, r.queued_since_ms)
        })
        .collect())
}

/// Вид матча по данным PostgreSQL (для завершённых матчей и восстановления).
pub async fn view_from_db(st: &AppState, id: Uuid) -> ApiResult<Option<MatchView>> {
    let Some(m) = sqlx::query_as::<_, MatchRow>(
        "SELECT kind, state, song_id, song_version, algorithm_version, duration_s, room_code, start_at, end_reason, result
         FROM matches WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    else {
        return Ok(None);
    };
    let title = st.catalog.get(&m.song_id).map_or_else(|| m.song_id.clone(), |s| s.info.title.clone());
    Ok(Some(MatchView {
        match_id: id,
        kind: m.kind,
        state: MatchState::parse(&m.state).unwrap_or(MatchState::Failed),
        song: SongRef { id: m.song_id, title, version: m.song_version, duration_s: m.duration_s },
        algorithm_version: m.algorithm_version as u32,
        room_code: m.room_code,
        players: players(st, id).await?,
        start_at_ms: m.start_at.map(ts_ms),
        deadline_ms: None,
        end_reason: m.end_reason,
        result: m.result.and_then(|r| serde_json::from_value(r).ok()),
    }))
}

pub fn curve_len(duration_s: f64) -> usize {
    (duration_s / CANONICAL_HOP).ceil() as usize
}

fn encode_curve(curve: &[Option<Option<i16>>]) -> Vec<u8> {
    curve
        .iter()
        .flat_map(|p| match p {
            None => MISSING,
            Some(None) => PAUSE,
            Some(Some(v)) => *v,
        }.to_be_bytes())
        .collect()
}

/// Сохранённая кривая матча: десятые доли полутона или пауза (для выгрузки данных).
pub fn curve_values(bytes: &[u8]) -> Vec<Option<i16>> {
    decode_curve(bytes, bytes.len() / 2).into_iter().map(Option::flatten).collect()
}

fn decode_curve(bytes: &[u8], n: usize) -> Vec<Option<Option<i16>>> {
    (0..n)
        .map(|i| match bytes.get(2 * i..2 * i + 2) {
            Some(b) => match i16::from_be_bytes([b[0], b[1]]) {
                MISSING => None,
                PAUSE => Some(None),
                v => Some(Some(v)),
            },
            None => None,
        })
        .collect()
}

pub struct Owner {
    st: AppState,
    conn: redis::aio::ConnectionManager,
    lease: Lease,
    view: MatchView,
    seq: u64,
    inbox: StreamId,
    extra: Vec<Extra>,
    curves: Vec<Vec<Option<Option<i16>>>>,
    song: scoring_core::Song,
}

enum Flow {
    Continue,
    Stop,
}

type OwnerResult = Result<Flow, OwnerError>;

#[derive(Debug, thiserror::Error)]
enum OwnerError {
    #[error(transparent)]
    Lease(#[from] LeaseError),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Api(#[from] anyhow::Error),
}

impl From<ApiError> for OwnerError {
    fn from(e: ApiError) -> Self {
        Self::Api(anyhow::anyhow!(e.message))
    }
}

/// Пытается стать владельцем матча и запускает его обработку на этом экземпляре.
pub async fn take_ownership(st: &AppState, id: Uuid) -> anyhow::Result<bool> {
    if st.owned.lock().unwrap().contains(&id) {
        return Ok(true);
    }
    let mut conn = st.valkey.clone();
    let Some(lease) = lease::acquire(&mut conn, &st.cfg.instance_id, id).await? else { return Ok(false) };
    // Аренду продлевает отдельная задача с момента получения: ожидание соединения с базой
    // или долгий пересчёт не должны приводить к потере владения. Если продлить не удалось,
    // записи владельца отклонятся fencing-проверками, а матч подхватит другой экземпляр.
    let renewer = {
        let lease = lease.clone();
        let mut conn = st.valkey.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(lease::RENEW_MS));
            tick.tick().await;
            loop {
                tick.tick().await;
                if let Err(LeaseError::Lost) = lease.renew(&mut conn).await {
                    break;
                }
            }
        })
    };
    // Fencing в PostgreSQL: поколение может только расти.
    let claimed = sqlx::query(
        "UPDATE matches SET owner_gen = $2 WHERE id = $1 AND owner_gen < $2 AND state NOT IN ('finished', 'cancelled', 'failed')",
    )
    .bind(id)
    .bind(lease.generation)
    .execute(&st.db)
    .await;
    if !matches!(claimed, Ok(ref r) if r.rows_affected() == 1) {
        renewer.abort();
        lease.release(&mut conn).await;
        claimed?;
        return Ok(false);
    }
    st.owned.lock().unwrap().insert(id);
    let st2 = st.clone();
    tokio::spawn(async move {
        match Owner::load(st2.clone(), lease.clone()).await {
            Ok(owner) => owner.run().await,
            Err(e) => {
                tracing::error!(match_id = %id, error = %format!("{e:#}"), "owner load failed");
                lease.release(&mut st2.valkey.clone()).await;
            }
        }
        renewer.abort();
        st2.owned.lock().unwrap().remove(&id);
    });
    Ok(true)
}

/// Подхватывает активные матчи без живого владельца (сбой экземпляра, перезапуск).
pub async fn sweeper(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        let ids: Result<Vec<(Uuid,)>, _> = sqlx::query_as(
            "SELECT id FROM matches WHERE state NOT IN ('finished', 'cancelled', 'failed')
             AND NOT (state = 'created' AND created_at > now() - interval '30 seconds')",
        )
        .fetch_all(&st.db)
        .await;
        let Ok(ids) = ids else { continue };
        for (id,) in ids {
            let mut conn = st.valkey.clone();
            let owned: bool = conn.exists(Keys::of(id).owner).await.unwrap_or(true);
            if !owned && let Err(e) = take_ownership(&st, id).await {
                tracing::warn!(match_id = %id, error = %e, "recovery failed");
            }
        }
        purge_curves(&st).await;
    }
}

/// Удаляет сохранённые кривые матчей после срока хранения.
async fn purge_curves(st: &AppState) {
    let _ = sqlx::query("UPDATE match_participants SET curve = NULL WHERE curve IS NOT NULL AND curve_purge_after < now()")
        .execute(&st.db)
        .await;
}

impl Owner {
    async fn load(st: AppState, lease: Lease) -> anyhow::Result<Self> {
        let id = lease.id;
        let mut conn = st.valkey.clone();
        let view = view_from_db(&st, id).await.map_err(|e| anyhow::anyhow!(e.message))?.ok_or_else(|| anyhow::anyhow!("match vanished"))?;
        let song = st.catalog.get(&view.song.id).map(|s| (s.song.clone(), s.info.version.clone()));
        let n = curve_len(view.song.duration_s);
        let snapshot: Option<String> = conn.get(Keys::of(id).state).await?;
        let persisted: Option<Persist> = snapshot.and_then(|s| serde_json::from_str(&s).ok());
        let mut owner = Self {
            st: st.clone(),
            conn,
            lease,
            seq: 0,
            inbox: StreamId::ZERO,
            extra: players_with_queue(&st, id)
                .await
                .map_err(|e| anyhow::anyhow!(e.message))?
                .into_iter()
                .map(|(_, joined_ms)| Extra { disconnected_since: None, joined_ms })
                .collect(),
            curves: vec![vec![None; n]; 2],
            song: song.as_ref().map(|s| s.0.clone()).unwrap_or(scoring_core::Song { hop_ms: 10.0, duration_s: view.song.duration_s, f0_midi: vec![], phrases: vec![] }),
            view,
        };
        let db_state = owner.view.state;
        match persisted {
            Some(p) if !p.view.state.terminal() => {
                owner.seq = p.seq;
                owner.inbox = StreamId::parse(&p.inbox).unwrap_or(StreamId::ZERO);
                // Участники могли добавиться (комната): берём состав из базы, флаги — из снимка.
                for player in owner.view.players.iter_mut() {
                    if let Some(old) = p.view.players.iter().find(|o| o.user_id == player.user_id) {
                        *player = old.clone();
                    }
                }
                for (i, pl) in owner.view.players.iter().enumerate() {
                    if let Some(old) = p.view.players.iter().position(|o| o.user_id == pl.user_id).and_then(|k| p.extra.get(k)) {
                        owner.extra[i].disconnected_since = old.disconnected_since;
                    }
                }
                owner.view.state = p.view.state;
                owner.view.start_at_ms = p.view.start_at_ms;
                owner.view.deadline_ms = p.view.deadline_ms;
                for slot in 0..2u8 {
                    let bytes: Option<Vec<u8>> = owner.conn.get(Keys::curve(id, slot)).await?;
                    if let Some(b) = bytes {
                        owner.curves[slot as usize] = decode_curve(&b, n);
                    }
                }
                owner.refresh_points();
            }
            _ if db_state.committed() => {
                // Временное состояние потеряно после начала пения: достоверную кривую
                // восстановить нельзя, поэтому результат не выдумывается.
                owner.fail("state_lost").await.ok();
                return Ok(owner);
            }
            _ => {}
        }
        if song.as_ref().is_none_or(|s| s.1 != owner.view.song.version) {
            owner.fail("song_changed").await.ok();
        }
        Ok(owner)
    }

    fn now(&self) -> i64 {
        now_ms()
    }

    fn slot_of(&self, user: Uuid) -> Option<usize> {
        self.view.players.iter().position(|p| p.user_id == user)
    }

    fn rated(&self) -> bool {
        self.view.kind == "rated"
    }

    fn refresh_points(&mut self) {
        for p in self.view.players.iter_mut() {
            p.points = self.curves[p.slot as usize].iter().filter(|x| x.is_some()).count() as u32;
        }
    }

    fn persist(&self) -> String {
        serde_json::to_string(&Persist { view: self.view.clone(), seq: self.seq, inbox: self.inbox.to_string(), extra: self.extra.clone() }).expect("serializable")
    }

    /// Важное событие: новое состояние матча целиком.
    async fn publish(&mut self) -> Result<(), LeaseError> {
        self.seq += 1;
        let event = OutEvent { seq: Some(self.seq), to: None, slot: None, msg: ServerMsg::Match { view: Box::new(self.view.clone()) } };
        let (event, snapshot) = (serde_json::to_string(&event).expect("serializable"), self.persist());
        self.lease.emit(&mut self.conn, &event, &snapshot).await
    }

    async fn tell(&mut self, user: Uuid, message: &str) -> Result<(), LeaseError> {
        let event = OutEvent { seq: None, to: Some(user), slot: None, msg: ServerMsg::Error { message: message.to_owned() } };
        self.lease.emit(&mut self.conn, &serde_json::to_string(&event).expect("serializable"), "").await
    }

    async fn db_state(&self, state: MatchState) -> Result<bool, sqlx::Error> {
        let start_at = self.view.start_at_ms.and_then(|ms| time::OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000).ok());
        Ok(sqlx::query("UPDATE matches SET state = $3, start_at = COALESCE($4, start_at) WHERE id = $1 AND owner_gen = $2 AND state NOT IN ('finished', 'cancelled', 'failed')")
            .bind(self.lease.id)
            .bind(self.lease.generation)
            .bind(state.as_str())
            .bind(start_at)
            .execute(&self.st.db)
            .await?
            .rows_affected()
            == 1)
    }

    async fn transition(&mut self, state: MatchState, deadline_ms: Option<i64>) -> OwnerResult {
        self.view.state = state;
        self.view.deadline_ms = deadline_ms;
        // В PostgreSQL фиксируются только старт (после него выход — техническое поражение,
        // а потеря временных данных — сбой без результата) и итог. Промежуточные шаги живут
        // в Valkey под fencing владельца: каждый коммит ждёт сброса WAL, это главный расход
        // базы на матч.
        if state == MatchState::Countdown && !self.db_state(state).await? {
            return Err(LeaseError::Lost.into());
        }
        self.publish().await?;
        Ok(Flow::Continue)
    }

    async fn run(mut self) {
        let id = self.lease.id;
        if self.view.state.terminal() {
            self.lease.release(&mut self.conn).await;
            return;
        }
        if self.view.state == MatchState::Created {
            let (state, deadline) = if self.rated() {
                (MatchState::Waiting, self.now() + self.st.cfg.game.accept_seconds as i64 * 1000)
            } else {
                // Создатель комнаты уже подтвердил участие.
                if let Some(p) = self.view.players.get_mut(0) {
                    p.accepted = true;
                }
                (MatchState::Waiting, self.now() + ROOM_SECONDS * 1000)
            };
            if let Err(e) = self.transition(state, Some(deadline)).await {
                tracing::warn!(match_id = %id, error = %e, "owner start failed");
                self.lease.release(&mut self.conn).await;
                return;
            }
        } else if let Err(e) = self.publish().await {
            tracing::warn!(match_id = %id, error = %e, "owner resume failed");
            return;
        }
        let mut inbox = self.st.hub.subscribe(Keys::of(id).inbox, self.inbox, 1024);
        let mut tick = tokio::time::interval(Duration::from_millis(200));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut presence = 0i64;
        loop {
            let flow = tokio::select! {
                Some(entry) = inbox.rx.recv() => {
                    self.inbox = entry.id;
                    match serde_json::from_str::<Command>(&entry.body) {
                        Ok(cmd) => self.handle(cmd).await,
                        Err(e) => { tracing::warn!(error = %e, "bad command"); Ok(Flow::Continue) }
                    }
                }
                _ = tick.tick() => {
                    let now = self.now();
                    let mut r = Ok(Flow::Continue);
                    if now - presence >= 1000 {
                        presence = now;
                        r = self.check_presence().await;
                    }
                    if matches!(r, Ok(Flow::Continue)) { self.timers().await } else { r }
                }
            };
            match flow {
                Ok(Flow::Continue) => {}
                Ok(Flow::Stop) => break,
                Err(OwnerError::Lease(LeaseError::Lost)) => {
                    tracing::warn!(match_id = %id, generation = self.lease.generation, "ownership lost");
                    return;
                }
                // Временные ошибки базы или Valkey: повторим на следующем такте.
                Err(e) => tracing::warn!(match_id = %id, error = %e, "owner step failed"),
            }
        }
        self.lease.release(&mut self.conn).await;
    }

    async fn handle(&mut self, Command { user, cmd }: Command) -> OwnerResult {
        if matches!(cmd, Cmd::Joined) {
            return self.joined().await;
        }
        let Some(i) = self.slot_of(user) else { return Ok(Flow::Continue) };
        let state = self.view.state;
        if state.terminal() {
            return Ok(Flow::Stop);
        }
        match cmd {
            Cmd::Accept if state == MatchState::Waiting && !self.view.players[i].accepted => {
                self.view.players[i].accepted = true;
                if self.view.players.len() == 2 && self.view.players.iter().all(|p| p.accepted) {
                    let deadline = self.now() + self.st.cfg.game.ready_seconds as i64 * 1000;
                    return self.transition(MatchState::ReadyCheck, Some(deadline)).await;
                }
                self.publish().await?;
            }
            Cmd::Decline if !state.committed() => return self.cancel("declined", Some(user)).await,
            Cmd::Ready { song_version, algorithm_version } if state == MatchState::ReadyCheck => {
                if song_version != self.view.song.version || algorithm_version != self.view.algorithm_version {
                    self.tell(user, "Версия песни или оценки не совпадает с матчем. Обнови страницу.").await?;
                    return Ok(Flow::Continue);
                }
                if !self.view.players[i].ready {
                    self.view.players[i].ready = true;
                    if self.view.players.iter().all(|p| p.ready) {
                        return self.countdown().await;
                    }
                    self.publish().await?;
                }
            }
            Cmd::Perf { from, points } => self.perf(i, from as usize, points).await?,
            Cmd::Finish { count } if matches!(state, MatchState::Singing | MatchState::Collecting) => {
                if count as usize == self.curves[i].len() && !self.view.players[i].finished {
                    self.view.players[i].finished = true;
                    self.publish().await?;
                }
            }
            Cmd::Leave if state.committed() => {
                self.view.players[i].left = true;
                return self.finalize("left").await;
            }
            Cmd::Leave => return self.cancel("left", Some(user)).await,
            _ => {}
        }
        Ok(Flow::Continue)
    }

    async fn joined(&mut self) -> OwnerResult {
        if self.view.state != MatchState::Waiting {
            return Ok(Flow::Continue);
        }
        let fresh = players(&self.st, self.lease.id).await?;
        for p in fresh {
            if self.slot_of(p.user_id).is_none() {
                self.view.players.push(PlayerView { accepted: true, ..p });
                self.extra.push(Extra::default());
            }
        }
        if self.view.players.len() == 2 {
            let deadline = self.now() + self.st.cfg.game.ready_seconds as i64 * 1000;
            return self.transition(MatchState::ReadyCheck, Some(deadline)).await;
        }
        self.publish().await?;
        Ok(Flow::Continue)
    }

    async fn countdown(&mut self) -> OwnerResult {
        // Запас на оценку смещения часов и доставку: клиенты планируют звук по AudioContext.
        let start = self.now() + (self.st.cfg.game.countdown_seconds * 1000.0) as i64;
        self.view.start_at_ms = Some(start);
        for slot in 0..self.view.players.len() as u8 {
            let bytes = encode_curve(&self.curves[slot as usize]);
            self.lease.write_curve(&mut self.conn, slot, None, &bytes).await?;
        }
        self.transition(MatchState::Countdown, None).await
    }

    async fn perf(&mut self, i: usize, from: usize, points: Vec<Option<i16>>) -> Result<(), OwnerError> {
        let n = self.curves[i].len();
        // Отсчёт тоже допустим: такт владельца может отстать от старта на доли секунды,
        // а точки из будущего отсекает проверка времени ниже.
        let (Some(start), true) = (self.view.start_at_ms, self.view.state.committed()) else {
            return Ok(());
        };
        let player = &self.view.players[i];
        if player.left || player.finished || points.is_empty() || points.len() > crate::protocol::MAX_POINTS || from + points.len() > n {
            return Ok(());
        }
        if points.iter().flatten().any(|v| !(0..=1270).contains(v)) {
            return Ok(());
        }
        let now = self.now();
        let hop_ms = (CANONICAL_HOP * 1000.0) as i64;
        let last_t = start + ((from + points.len() - 1) as i64) * hop_ms;
        let first_t = start + from as i64 * hop_ms;
        let g = &self.st.cfg.game;
        // Точки из будущего не принимаются; поздние — только в пределах окна возвращения:
        // переподключение не даёт времени перепеть фрагмент.
        let max_late = ((g.disconnect_seconds + g.return_window_seconds) * 1000) as i64 + 5000;
        if last_t > now + 1500 || now > first_t + max_late {
            return Ok(());
        }
        let len = points.len();
        let mut changed = false;
        for (k, v) in points.into_iter().enumerate() {
            let slot = &mut self.curves[i][from + k];
            // Первое значение окончательно: повтор пакета не меняет кривую.
            if slot.is_none() {
                *slot = Some(v);
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        let range = from..from + len;
        let bytes = encode_curve(&self.curves[i][range.clone()]);
        self.lease.write_curve(&mut self.conn, i as u8, Some(from * 2), &bytes).await?;
        self.view.players[i].points = self.curves[i].iter().filter(|x| x.is_some()).count() as u32;
        let shown: Vec<Option<i16>> = self.curves[i][range].iter().map(|p| p.flatten()).collect();
        let event = OutEvent {
            seq: None,
            to: None,
            slot: Some(i as u8),
            msg: ServerMsg::Opponent { match_id: self.lease.id, from: from as u32, points: shown },
        };
        self.lease.emit(&mut self.conn, &serde_json::to_string(&event).expect("serializable"), "").await?;
        Ok(())
    }

    fn complete(&self, i: usize) -> bool {
        self.view.players[i].finished && self.curves[i].iter().all(Option::is_some)
    }

    async fn check_presence(&mut self) -> OwnerResult {
        let keys: Vec<String> = self.view.players.iter().map(|p| key(format_args!("p:{}", p.user_id))).collect();
        if keys.is_empty() {
            return Ok(Flow::Continue);
        }
        let present: Vec<Option<String>> = redis::cmd("MGET").arg(&keys).query_async(&mut self.conn).await.map_err(LeaseError::from)?;
        let now = self.now();
        let mut changed = false;
        for (i, here) in present.iter().enumerate() {
            let connected = here.is_some();
            if self.view.players[i].connected != connected {
                self.view.players[i].connected = connected;
                changed = true;
            }
            self.extra[i].disconnected_since = if connected { None } else { Some(self.extra[i].disconnected_since.unwrap_or(now)) };
        }
        // Окно возвращения отсчитывается после подтверждённого разрыва (истёк heartbeat).
        let window = self.st.cfg.game.return_window_seconds as i64 * 1000;
        let gone: Vec<usize> = (0..self.view.players.len())
            .filter(|&i| !self.view.players[i].left && self.extra[i].disconnected_since.is_some_and(|t| now - t > window))
            .collect();
        if !gone.is_empty() {
            let state = self.view.state;
            if state.committed() {
                for i in gone {
                    self.view.players[i].left = true;
                }
                return self.finalize("disconnected").await;
            }
            // До начала пения ждём, пока второй участник комнаты ещё не пришёл.
            if state == MatchState::ReadyCheck || (state == MatchState::Waiting && self.rated()) {
                let user = self.view.players[gone[0]].user_id;
                return self.cancel("disconnected", Some(user)).await;
            }
            if state == MatchState::Waiting && gone.contains(&0) {
                return self.cancel("disconnected", None).await;
            }
        }
        if changed {
            self.publish().await?;
        }
        Ok(Flow::Continue)
    }

    async fn timers(&mut self) -> OwnerResult {
        let now = self.now();
        let deadline_passed = self.view.deadline_ms.is_some_and(|d| now >= d);
        match self.view.state {
            MatchState::Waiting if deadline_passed => {
                let late = self.view.players.iter().find(|p| !p.accepted).map(|p| p.user_id);
                self.cancel(if self.rated() { "accept_timeout" } else { "room_expired" }, late).await
            }
            MatchState::ReadyCheck if deadline_passed => {
                let late = self.view.players.iter().find(|p| !p.ready).map(|p| p.user_id);
                self.cancel("ready_timeout", late).await
            }
            MatchState::Countdown if self.view.start_at_ms.is_some_and(|s| now >= s) => self.transition(MatchState::Singing, None).await,
            MatchState::Singing => {
                let end = self.view.start_at_ms.unwrap_or(now) + (self.view.song.duration_s * 1000.0) as i64;
                if now >= end {
                    let deadline = end + self.st.cfg.game.collect_seconds as i64 * 1000;
                    return self.transition(MatchState::Collecting, Some(deadline)).await;
                }
                Ok(Flow::Continue)
            }
            MatchState::Collecting => {
                let all = (0..self.view.players.len()).all(|i| self.view.players[i].left || self.complete(i));
                if all || deadline_passed { self.finalize("completed").await } else { Ok(Flow::Continue) }
            }
            _ => Ok(Flow::Continue),
        }
    }

    /// Отмена до начала пения: рейтинг не меняется. Подтвердившие участие игроки
    /// рейтинговой очереди возвращаются в поиск с прежним приоритетом.
    async fn cancel(&mut self, reason: &str, culprit: Option<Uuid>) -> OwnerResult {
        if !self.close("cancelled", reason, None).await? {
            return Err(LeaseError::Lost.into());
        }
        self.view.state = MatchState::Cancelled;
        self.view.end_reason = Some(reason.to_owned());
        self.view.deadline_ms = None;
        self.publish().await?;
        if self.rated() {
            for (p, extra) in self.view.players.iter().zip(&self.extra) {
                if Some(p.user_id) != culprit && p.accepted && p.connected {
                    let _ = crate::queue::requeue(&self.st, p.user_id, extra.joined_ms).await;
                }
            }
        }
        Ok(Flow::Stop)
    }

    async fn fail(&mut self, reason: &str) -> OwnerResult {
        if !self.close("failed", reason, None).await? {
            return Err(LeaseError::Lost.into());
        }
        self.view.state = MatchState::Failed;
        self.view.end_reason = Some(reason.to_owned());
        self.publish().await?;
        Ok(Flow::Stop)
    }

    async fn close(&self, state: &str, reason: &str, _result: Option<&MatchResult>) -> Result<bool, sqlx::Error> {
        let mut tx = self.st.db.begin().await?;
        let done = sqlx::query(
            "UPDATE matches SET state = $3, end_reason = $4, finished_at = now()
             WHERE id = $1 AND owner_gen = $2 AND state NOT IN ('finished', 'cancelled', 'failed')",
        )
        .bind(self.lease.id)
        .bind(self.lease.generation)
        .bind(state)
        .bind(reason)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if done == 0 {
            return Ok(false);
        }
        sqlx::query("UPDATE match_participants SET active = false WHERE match_id = $1").bind(self.lease.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(true)
    }

    /// Пересчёт обеих кривых на сервере и согласованная запись результата и рейтинга.
    async fn finalize(&mut self, reason: &str) -> OwnerResult {
        let count = self.view.players.len();
        let complete: Vec<bool> = (0..count).map(|i| !self.view.players[i].left && self.complete(i)).collect();
        // Проигрывает вышедший участник, а после срока сбора — и тот, чья кривая неполна.
        // Оставшемуся полная кривая для технической победы не нужна.
        let deadline = reason == "completed";
        let lost: Vec<bool> = (0..count).map(|i| self.view.players[i].left || (deadline && !complete[i])).collect();
        if count < 2 || lost.iter().all(|l| *l) || (!lost.iter().any(|l| *l) && !complete.iter().all(|c| *c)) {
            // Результат не выдумывается: без полной кривой у обоих рейтинг не меняется.
            return self.fail(if reason == "completed" { "incomplete" } else { reason }).await;
        }
        let frames: Vec<Option<Vec<scoring_core::PitchFrame>>> = (0..count)
            .map(|i| complete[i].then(|| scoring_core::dequantize(&self.curves[i].iter().map(|p| p.flatten()).collect::<Vec<_>>())))
            .collect();
        let song = self.song.clone();
        let scores = match self.st.compute.run(move || frames.iter().map(|f| f.as_ref().map(|f| scoring_core::score_performance(f, &song))).collect::<Vec<_>>()).await {
            Ok(s) => s,
            // Пул переполнен: состояние collecting сохраняется, повтор на следующем такте.
            Err(_) => return Ok(Flow::Continue),
        };
        let technical = lost.iter().any(|l| *l);
        let outcomes: Vec<Outcome> = if technical {
            lost.iter().map(|l| if *l { Outcome::Loss } else { Outcome::Win }).collect()
        } else {
            let (a, b) = (scores[0].as_ref().unwrap().score, scores[1].as_ref().unwrap().score);
            vec![scoring_core::outcome(a, b), scoring_core::outcome(b, a)]
        };
        let rated = self.rated();
        let retention = self.st.cfg.game.curve_retention_days as f64 * 86400.0;
        let mut tx = self.st.db.begin().await?;
        let claimed = sqlx::query(
            "UPDATE matches SET state = 'finished', end_reason = $3, finished_at = now()
             WHERE id = $1 AND owner_gen = $2 AND state NOT IN ('finished', 'cancelled', 'failed')",
        )
        .bind(self.lease.id)
        .bind(self.lease.generation)
        .bind(reason)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if claimed == 0 {
            return Err(LeaseError::Lost.into());
        }
        let mut results: Vec<PlayerResult> = Vec::new();
        let mut order: Vec<usize> = (0..count).collect();
        // Блокировки рейтингов в порядке id исключают взаимоблокировку параллельных матчей.
        order.sort_by_key(|&i| self.view.players[i].user_id);
        let mut before = vec![Rating::initial(&self.st.cfg.game); count];
        if rated {
            for &i in &order {
                let user = self.view.players[i].user_id;
                sqlx::query("INSERT INTO ratings (user_id, mmr, peak_mmr) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING")
                    .bind(user)
                    .bind(self.st.cfg.game.start_mmr)
                    .execute(&mut *tx)
                    .await?;
                before[i] = sqlx::query_as::<_, Rating>("SELECT mmr, peak_mmr, rated_matches FROM ratings WHERE user_id = $1 FOR UPDATE")
                    .bind(user)
                    .fetch_one(&mut *tx)
                    .await?;
            }
        }
        for i in 0..count {
            let p = &self.view.players[i];
            let o = 1 - i;
            let s = scores[i].as_ref();
            let mut res = PlayerResult {
                user_id: p.user_id,
                outcome: outcomes[i],
                score: s.map(|s| s.score),
                axes: s.map(|s| s.axes),
                shift: s.map(|s| s.shift),
                mmr_before: None,
                mmr_after: None,
                standing: None,
            };
            if rated {
                let actual = match outcomes[i] {
                    Outcome::Win => 1.0,
                    Outcome::Draw => 0.5,
                    Outcome::Loss => 0.0,
                };
                let u = ratings::apply(&self.st.cfg.game, before[i], before[o].mmr, actual);
                sqlx::query("UPDATE ratings SET mmr = $2, peak_mmr = $3, rated_matches = $4, updated_at = now() WHERE user_id = $1")
                    .bind(p.user_id)
                    .bind(u.after.mmr)
                    .bind(u.after.peak_mmr)
                    .bind(u.after.rated_matches)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    "INSERT INTO rating_events (match_id, user_id, opponent_id, mmr_before, mmr_after, opponent_mmr, k, expected, actual)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(self.lease.id)
                .bind(p.user_id)
                .bind(self.view.players[o].user_id)
                .bind(before[i].mmr)
                .bind(u.after.mmr)
                .bind(before[o].mmr)
                .bind(u.k)
                .bind(u.expected)
                .bind(actual)
                .execute(&mut *tx)
                .await?;
                res.mmr_before = Some(before[i].mmr);
                res.mmr_after = Some(u.after.mmr);
                res.standing = Some(standing(&self.st, u.after));
            }
            let curve = complete[i].then(|| encode_curve(&self.curves[i]));
            sqlx::query(
                "UPDATE match_participants SET active = false, outcome = $3, score = $4, raw_score = $5, result = $6,
                 curve = $7, curve_purge_after = CASE WHEN $7::bytea IS NULL THEN NULL ELSE now() + make_interval(secs => $8) END
                 WHERE match_id = $1 AND user_id = $2",
            )
            .bind(self.lease.id)
            .bind(p.user_id)
            .bind(match outcomes[i] { Outcome::Win => "win", Outcome::Draw => "draw", Outcome::Loss => "loss" })
            .bind(s.map(|s| s.score))
            .bind(s.map(|s| s.raw_score))
            .bind(serde_json::to_value(&res).ok())
            .bind(curve)
            .bind(retention)
            .execute(&mut *tx)
            .await?;
            results.push(res);
        }
        let result = MatchResult { rated, technical, players: results };
        sqlx::query("UPDATE matches SET result = $2 WHERE id = $1").bind(self.lease.id).bind(serde_json::to_value(&result).ok()).execute(&mut *tx).await?;
        tx.commit().await?;
        self.view.state = MatchState::Finished;
        self.view.end_reason = Some(reason.to_owned());
        self.view.deadline_ms = None;
        self.view.result = Some(result);
        self.publish().await?;
        Ok(Flow::Stop)
    }
}

/// Проверка участия пользователя в матче.
pub async fn is_member(st: &AppState, match_id: Uuid, user: Uuid) -> ApiResult<bool> {
    let row: Option<(i16,)> = sqlx::query_as("SELECT slot FROM match_participants WHERE match_id = $1 AND user_id = $2")
        .bind(match_id)
        .bind(user)
        .fetch_optional(&st.db)
        .await?;
    Ok(row.is_some())
}

pub async fn active_match(st: &AppState, user: Uuid) -> ApiResult<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT match_id FROM match_participants WHERE user_id = $1 AND active")
        .bind(user)
        .fetch_optional(&st.db)
        .await?;
    Ok(row.map(|r| r.0))
}

/// Передаёт команду владельцу матча, где бы он ни работал.
pub async fn send(st: &AppState, match_id: Uuid, command: &Command) -> redis::RedisResult<()> {
    let mut conn = st.valkey.clone();
    let body = serde_json::to_string(command).expect("serializable");
    crate::realtime::append(&mut conn, &Keys::of(match_id).inbox, &body, 5000, lease::DATA_TTL).await
}

const ROOM_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

fn room_code() -> String {
    let mut bytes = [0u8; 6];
    rand::fill(&mut bytes);
    bytes.iter().map(|b| ROOM_ALPHABET[*b as usize % ROOM_ALPHABET.len()] as char).collect()
}

fn busy_error(e: &sqlx::Error) -> bool {
    e.as_database_error().is_some_and(|d| d.is_unique_violation())
}

pub const ALREADY_BUSY: &str = "Ты уже в другом матче. Заверши его, чтобы начать новый.";

/// Комната для игры с другом: нерейтинговый матч, вход по коду.
pub async fn create_room(st: &AppState, host: Uuid, song_id: &str) -> ApiResult<(Uuid, String)> {
    let song = st.catalog.get(song_id).ok_or_else(|| ApiError::bad("Такой песни нет в каталоге."))?;
    for _ in 0..5 {
        let (id, code) = (Uuid::new_v4(), room_code());
        let mut tx = st.db.begin().await?;
        let inserted = sqlx::query(
            "INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s, room_code)
             VALUES ($1, 'friend', 'created', $2, $3, $4, $5, $6) ON CONFLICT (room_code) DO NOTHING",
        )
        .bind(id)
        .bind(&song.info.id)
        .bind(&song.info.version)
        .bind(scoring_core::ALGORITHM_VERSION as i32)
        .bind(song.info.duration_s)
        .bind(&code)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if inserted == 0 {
            continue;
        }
        if let Err(e) = sqlx::query("INSERT INTO match_participants (match_id, user_id, slot) VALUES ($1, $2, 0)").bind(id).bind(host).execute(&mut *tx).await {
            return Err(if busy_error(&e) { ApiError::bad(ALREADY_BUSY) } else { e.into() });
        }
        tx.commit().await?;
        take_ownership(st, id).await?;
        return Ok((id, code));
    }
    Err(ApiError::busy())
}

pub async fn join_room(st: &AppState, user: Uuid, code: &str) -> ApiResult<Uuid> {
    let code = code.trim().to_uppercase();
    let row: Option<(Uuid, String)> = sqlx::query_as("SELECT id, state FROM matches WHERE room_code = $1 AND kind = 'friend'")
        .bind(&code)
        .fetch_optional(&st.db)
        .await?;
    let Some((id, state)) = row else { return Err(ApiError::bad("Комната не найдена. Проверь ссылку.")) };
    if is_member(st, id, user).await? {
        return Ok(id);
    }
    if !matches!(state.as_str(), "created" | "waiting") {
        return Err(ApiError::bad("Матч в этой комнате уже начался или закончился."));
    }
    let r = sqlx::query(
        "INSERT INTO match_participants (match_id, user_id, slot)
         SELECT $1, $2, 1 WHERE NOT EXISTS (SELECT 1 FROM match_participants WHERE match_id = $1 AND slot = 1)",
    )
    .bind(id)
    .bind(user)
    .execute(&st.db)
    .await;
    match r {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => return Err(ApiError::bad("В комнате уже два участника.")),
        Err(e) if busy_error(&e) => return Err(ApiError::bad(ALREADY_BUSY)),
        Err(e) => return Err(e.into()),
    }
    send(st, id, &Command { user, cmd: Cmd::Joined }).await?;
    Ok(id)
}

/// Реванш в дружеском режиме: новая нерейтинговая комната с той же песней.
pub async fn rematch(st: &AppState, user: Uuid, previous: Uuid) -> ApiResult<(Uuid, String, Uuid)> {
    let row: Option<(String, String, String)> = sqlx::query_as("SELECT kind, state, song_id FROM matches WHERE id = $1")
        .bind(previous)
        .fetch_optional(&st.db)
        .await?;
    let Some((kind, state, song)) = row else { return Err(ApiError::bad("Матч не найден.")) };
    if kind != "friend" || !MatchState::parse(&state).is_some_and(MatchState::terminal) || !is_member(st, previous, user).await? {
        return Err(ApiError::bad("Реванш доступен после дружеского матча."));
    }
    let other: (Uuid,) = sqlx::query_as("SELECT user_id FROM match_participants WHERE match_id = $1 AND user_id <> $2")
        .bind(previous)
        .bind(user)
        .fetch_one(&st.db)
        .await?;
    let (id, code) = create_room(st, user, &song).await?;
    Ok((id, code, other.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_bytes_round_trip() {
        let curve = vec![None, Some(None), Some(Some(0)), Some(Some(1270)), None];
        assert_eq!(decode_curve(&encode_curve(&curve), 5), curve);
        assert_eq!(decode_curve(&[], 2), vec![None, None]);
    }

    #[test]
    fn room_codes_use_unambiguous_alphabet() {
        let code = room_code();
        assert_eq!(code.len(), 6);
        assert!(code.bytes().all(|b| ROOM_ALPHABET.contains(&b)));
    }
}
