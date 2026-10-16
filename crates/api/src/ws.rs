//! Шлюз WebSocket: одно соединение браузера. Проверяет Origin и сессию, отвечает на
//! heartbeat, отмечает присутствие, пересылает команды владельцу матча и доставляет
//! события пользователя и матча с этого или любого другого экземпляра.
use crate::accounts::{self, Session};
use crate::matches::{self, Cmd, Command, OutEvent};
use crate::protocol::*;
use crate::queue;
use crate::realtime::{Subscription, key};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use redis::AsyncCommands;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use uuid::Uuid;

const OUTBOX: usize = 512;
/// Допустимая частота команд: в среднем 40 в секунду, всплеск до 80.
const RATE: f64 = 40.0;
const BURST: f64 = 80.0;

pub async fn upgrade(State(st): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).unwrap_or("");
    if !st.cfg.origins.iter().any(|o| o == origin) {
        return (StatusCode::FORBIDDEN, "origin").into_response();
    }
    let session = match accounts::token(&headers) {
        Some(t) => accounts::session_by_token(&st, &t).await.ok().flatten(),
        None => None,
    };
    let Some(session) = session else {
        return (StatusCode::UNAUTHORIZED, "session").into_response();
    };
    ws.max_message_size(MAX_MESSAGE).max_frame_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        Connection::new(st, session).run(socket).await;
    })
}

struct Connection {
    st: AppState,
    user: Uuid,
    name: String,
    session: String,
    out: Option<mpsc::Sender<Message>>,
    match_id: Option<Uuid>,
    slot: Option<u8>,
    last_seq: u64,
    tokens: f64,
    refilled: Instant,
}

fn envelope(seq: Option<u64>, msg: ServerMsg) -> Message {
    let text = serde_json::to_string(&ServerEnvelope { v: PROTOCOL_VERSION, seq, msg }).expect("serializable");
    Message::Text(Utf8Bytes::from(text))
}

impl Connection {
    fn new(st: AppState, s: Session) -> Self {
        Self {
            st,
            user: s.user.id,
            name: s.user.name,
            session: s.hash,
            out: None,
            match_id: None,
            slot: None,
            last_seq: 0,
            tokens: BURST,
            refilled: Instant::now(),
        }
    }

    /// Отправка без ожидания: переполненная очередь означает слишком медленного клиента.
    /// Соединение закрывается, клиент переподключится и получит актуальное состояние.
    fn send(&mut self, seq: Option<u64>, msg: ServerMsg) -> bool {
        match &self.out {
            Some(tx) => tx.try_send(envelope(seq, msg)).is_ok(),
            None => false,
        }
    }

    async fn presence(&self) {
        let mut c = self.st.valkey.clone();
        let ttl = self.st.cfg.game.disconnect_seconds * 1000;
        let presence_key = key(format_args!("p:{}", self.user));
        let _: redis::RedisResult<()> = c.set_options(
            presence_key,
            &self.st.cfg.instance_id,
            redis::SetOptions::default().with_expiration(redis::SetExpiry::PX(ttl)),
        ).await;
    }

    async fn run(mut self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::channel::<Message>(OUTBOX);
        self.out = Some(tx);
        let writer = tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let guard = self.st.hub.register(self.user, self.session.clone());
        let mut c = self.st.valkey.clone();
        let mut user_sub = match self.st.hub.subscribe_new(&mut c, queue::user_stream(self.user), 64).await {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut match_sub: Option<Subscription> = None;
        let heartbeat = Duration::from_secs(self.st.cfg.game.heartbeat_seconds);
        // Без сигнала дольше порога разрыва соединение считается потерянным.
        let silence = self.st.cfg.game.disconnect();
        let mut recheck = tokio::time::interval(Duration::from_secs(30));
        recheck.tick().await;
        let mut last_seen = Instant::now();
        let mut said_hello = false;
        loop {
            tokio::select! {
                incoming = tokio::time::timeout(silence, stream.next()) => {
                    let Ok(Some(Ok(message))) = incoming else { break };
                    last_seen = Instant::now();
                    match message {
                        Message::Text(text) => {
                            if !self.allow() {
                                self.send(None, ServerMsg::Error { message: "Слишком много сообщений.".into() });
                                break;
                            }
                            let Ok(env) = serde_json::from_str::<ClientEnvelope>(&text) else {
                                self.send(None, ServerMsg::Error { message: "Некорректное сообщение.".into() });
                                continue;
                            };
                            if env.v != PROTOCOL_VERSION {
                                self.send(None, ServerMsg::Error { message: "Версия протокола устарела. Обнови страницу.".into() });
                                break;
                            }
                            self.presence().await;
                            if let ClientMsg::Hello { match_id, last_seq } = &env.msg {
                                said_hello = true;
                                self.last_seq = last_seq.unwrap_or(0);
                                match_sub = self.hello(*match_id).await;
                                continue;
                            }
                            if !said_hello {
                                continue;
                            }
                            let (ok, error, follow) = self.command(env.msg).await;
                            if !self.send(None, ServerMsg::Ack { id: env.id, ok, error }) { break; }
                            if let Some(id) = follow {
                                match_sub = self.attach(id).await;
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
                Some(entry) = user_sub.rx.recv() => {
                    let Ok(msg) = serde_json::from_str::<ServerMsg>(&entry.body) else { continue };
                    let follow = match &msg {
                        ServerMsg::Queue { state: QueueState { match_id: Some(id), .. } } => Some(*id),
                        _ => None,
                    };
                    if !self.send(None, msg) { break; }
                    if let Some(id) = follow {
                        match_sub = self.attach(id).await;
                    }
                }
                Some(entry) = async { match match_sub.as_mut() { Some(s) => s.rx.recv().await, None => std::future::pending().await } } => {
                    let Ok(ev) = serde_json::from_str::<OutEvent>(&entry.body) else { continue };
                    if !self.deliver(ev) { break; }
                }
                _ = guard.close.notified() => {
                    self.send(None, ServerMsg::Error { message: "Сессия завершена. Войди снова.".into() });
                    break;
                }
                _ = recheck.tick() => {
                    // Страховка на случай потерянного события отзыва.
                    if !self.session_valid().await {
                        break;
                    }
                    if last_seen.elapsed() > heartbeat * 4 {
                        break;
                    }
                }
            }
        }
        drop(match_sub);
        drop(user_sub);
        self.out = None;
        let _ = writer.await;
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.refilled).as_secs_f64() * RATE).min(BURST);
        self.refilled = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    async fn session_valid(&self) -> bool {
        sqlx::query_as::<_, (i32,)>("SELECT 1 FROM sessions WHERE hash = $1 AND expires_at > now()")
            .bind(&self.session)
            .fetch_optional(&self.st.db)
            .await
            .map(|r| r.is_some())
            .unwrap_or(true)
    }

    async fn hello(&mut self, resume: Option<Uuid>) -> Option<Subscription> {
        self.send(None, ServerMsg::Welcome {
            user_id: self.user,
            name: self.name.clone(),
            server_time: now_ms() as f64,
            heartbeat_ms: self.st.cfg.game.heartbeat_seconds * 1000,
        });
        if let Ok(q) = queue::state_of(&self.st, self.user).await {
            queue::touch(&self.st, self.user).await;
            self.send(None, ServerMsg::Queue { state: q });
        }
        let active = matches::active_match(&self.st, self.user).await.ok().flatten();
        // Завершённый матч, итог которого клиент мог не увидеть.
        let target = match (active, resume) {
            (Some(id), _) => Some(id),
            (None, Some(id)) if matches::is_member(&self.st, id, self.user).await.unwrap_or(false) => Some(id),
            _ => None,
        };
        match target {
            Some(id) => self.attach(id).await,
            None => None,
        }
    }

    /// Подписка на события матча с начала потока: клиент получает актуальное состояние,
    /// все промежуточные точки соперника и уже виденные события отбрасывает по seq.
    async fn attach(&mut self, id: Uuid) -> Option<Subscription> {
        if self.match_id != Some(id) {
            self.last_seq = 0;
        }
        self.match_id = Some(id);
        let mut c = self.st.valkey.clone();
        let snapshot: Option<String> = c.get(crate::lease::Keys::of(id).state).await.ok().flatten();
        let view = match snapshot.and_then(|s| serde_json::from_str::<matches::Persist>(&s).ok()) {
            Some(p) => Some((Some(p.seq), p.view)),
            None => matches::view_from_db(&self.st, id).await.ok().flatten().map(|v| (None, v)),
        };
        if let Some((seq, view)) = view {
            self.slot = view.players.iter().find(|p| p.user_id == self.user).map(|p| p.slot);
            self.send(seq, ServerMsg::Match { view: Box::new(view) });
        }
        Some(self.st.hub.subscribe(crate::lease::Keys::of(id).out, crate::realtime::StreamId::ZERO, OUTBOX))
    }

    fn deliver(&mut self, ev: OutEvent) -> bool {
        if ev.to.is_some_and(|u| u != self.user) || (ev.slot.is_some() && ev.slot == self.slot) {
            return true;
        }
        if let ServerMsg::Match { view } = &ev.msg {
            self.slot = view.players.iter().find(|p| p.user_id == self.user).map(|p| p.slot);
        }
        if let Some(seq) = ev.seq {
            if seq <= self.last_seq {
                return true;
            }
            self.last_seq = seq;
        }
        self.send(ev.seq, ev.msg)
    }

    /// Возвращает (успех, ошибка, матч для подписки).
    async fn command(&mut self, msg: ClientMsg) -> (bool, Option<String>, Option<Uuid>) {
        let st = self.st.clone();
        let user = self.user;
        let err = |e: crate::error::ApiError| (false, Some(e.message), None);
        match msg {
            ClientMsg::Ping { c } => {
                self.send(None, ServerMsg::Pong { c, s: now_ms() as f64 });
                queue::touch(&st, user).await;
                if let Ok(q) = queue::state_of(&st, user).await
                    && matches!(q.status, QueueStatus::Searching)
                {
                    self.send(None, ServerMsg::Queue { state: q });
                }
                (true, None, None)
            }
            ClientMsg::QueueJoin => match queue::join(&st, user).await {
                Ok(q) => {
                    self.send(None, ServerMsg::Queue { state: q });
                    (true, None, None)
                }
                Err(e) => err(e),
            },
            ClientMsg::QueueLeave => match queue::leave(&st, user).await {
                Ok(q) => {
                    self.send(None, ServerMsg::Queue { state: q });
                    (true, None, None)
                }
                Err(e) => err(e),
            },
            ClientMsg::RoomCreate { song_id } => match matches::create_room(&st, user, &song_id).await {
                Ok((id, code)) => {
                    self.send(None, ServerMsg::Room { match_id: id, code });
                    (true, None, Some(id))
                }
                Err(e) => err(e),
            },
            ClientMsg::RoomJoin { code } => match matches::join_room(&st, user, &code).await {
                Ok(id) => (true, None, Some(id)),
                Err(e) => err(e),
            },
            ClientMsg::Rematch { match_id } => match matches::rematch(&st, user, match_id).await {
                Ok((id, code, other)) => {
                    self.send(None, ServerMsg::Room { match_id: id, code: code.clone() });
                    queue::notify(&st, other, &ServerMsg::Room { match_id: id, code }).await;
                    (true, None, Some(id))
                }
                Err(e) => err(e),
            },
            ClientMsg::Hello { .. } => (true, None, None),
            other => {
                let Some(match_id) = other.match_id() else { return (false, None, None) };
                // Доступ к конкретному матчу проверяется при каждой команде.
                if self.match_id != Some(match_id) && !matches::is_member(&st, match_id, user).await.unwrap_or(false) {
                    return (false, Some("Нет доступа к этому матчу.".into()), None);
                }
                let cmd = match other {
                    ClientMsg::Accept { .. } => Cmd::Accept,
                    ClientMsg::Decline { .. } => Cmd::Decline,
                    ClientMsg::Ready { song_version, algorithm_version, .. } => Cmd::Ready { song_version, algorithm_version },
                    ClientMsg::Perf { from, points, .. } => {
                        if points.len() > MAX_POINTS {
                            return (false, Some("Слишком большой пакет.".into()), None);
                        }
                        Cmd::Perf { from, points }
                    }
                    ClientMsg::Finish { count, .. } => Cmd::Finish { count },
                    ClientMsg::Leave { .. } => Cmd::Leave,
                    _ => return (false, None, None),
                };
                let follow = (self.match_id != Some(match_id)).then_some(match_id);
                match matches::send(&st, match_id, &Command { user, cmd }).await {
                    Ok(()) => (true, None, follow),
                    Err(_) => (false, Some("Сервер временно недоступен.".into()), None),
                }
            }
        }
    }
}
