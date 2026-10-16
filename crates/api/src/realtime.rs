//! Доставка событий между экземплярами через потоки Valkey.
//!
//! Каждый экземпляр держит одно блокирующее соединение, которое читает (XREAD) все
//! потоки, нужные локальным подписчикам: входящие команды матчей, которыми он владеет,
//! события матчей и пользователей, подключённых к нему. У каждого подписчика свой курсор;
//! курсор сдвигается только после доставки, поэтому медленный подписчик не теряет записи,
//! пока они хранятся в потоке (MAXLEN ограничивает память).
use crate::state::KEY_PREFIX;
use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::{AsyncCommands, Client, Value};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, mpsc};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Revoke {
    Session(String),
    User(Uuid),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct StreamId(u64, u64);

impl StreamId {
    pub const ZERO: Self = Self(0, 0);
    pub fn parse(s: &str) -> Option<Self> {
        let (a, b) = s.split_once('-')?;
        Some(Self(a.parse().ok()?, b.parse().ok()?))
    }
}

impl std::fmt::Display for StreamId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}-{}", self.0, self.1)
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub id: StreamId,
    pub body: String,
}

struct Sub {
    id: u64,
    cursor: StreamId,
    tx: mpsc::Sender<Entry>,
}

struct Conn {
    user: Uuid,
    session: String,
    close: Arc<Notify>,
}

pub struct Hub {
    client: Client,
    subs: Mutex<HashMap<String, Vec<Sub>>>,
    conns: Mutex<HashMap<u64, Conn>>,
    next: AtomicU64,
    wake: Notify,
}

/// Подписка на поток. При удалении отписывается.
pub struct Subscription {
    pub rx: mpsc::Receiver<Entry>,
    hub: Arc<Hub>,
    key: String,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut subs = self.hub.subs.lock().unwrap();
        if let Some(list) = subs.get_mut(&self.key) {
            list.retain(|s| s.id != self.id);
            if list.is_empty() {
                subs.remove(&self.key);
            }
        }
    }
}

/// Регистрация соединения для отзыва доступа; снимается при удалении.
pub struct ConnGuard {
    hub: Arc<Hub>,
    id: u64,
    pub close: Arc<Notify>,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.hub.conns.lock().unwrap().remove(&self.id);
    }
}

pub fn key(parts: std::fmt::Arguments<'_>) -> String {
    format!("{KEY_PREFIX}{parts}")
}

impl Hub {
    pub fn new(client: Client) -> Arc<Self> {
        Arc::new(Self {
            client,
            subs: Mutex::new(HashMap::new()),
            conns: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            wake: Notify::new(),
        })
    }

    /// Подписка на записи с id строго больше `after`.
    pub fn subscribe(self: &Arc<Self>, key: String, after: StreamId, capacity: usize) -> Subscription {
        let (tx, rx) = mpsc::channel(capacity);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.subs.lock().unwrap().entry(key.clone()).or_default().push(Sub { id, cursor: after, tx });
        self.wake.notify_one();
        Subscription { rx, hub: self.clone(), key, id }
    }

    /// Подписка только на новые записи.
    pub async fn subscribe_new(self: &Arc<Self>, conn: &mut impl AsyncCommands, key: String, capacity: usize) -> redis::RedisResult<Subscription> {
        let last = last_id(conn, &key).await?;
        Ok(self.subscribe(key, last, capacity))
    }

    pub fn register(self: &Arc<Self>, user: Uuid, session: String) -> ConnGuard {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let close = Arc::new(Notify::new());
        self.conns.lock().unwrap().insert(id, Conn { user, session, close: close.clone() });
        ConnGuard { hub: self.clone(), id, close }
    }

    pub fn revoke_local(&self, what: &Revoke) {
        for c in self.conns.lock().unwrap().values() {
            let hit = match what {
                Revoke::Session(hash) => &c.session == hash,
                Revoke::User(user) => &c.user == user,
            };
            if hit {
                c.close.notify_one();
            }
        }
    }

    pub fn connections(&self) -> usize {
        self.conns.lock().unwrap().len()
    }

    /// Основной цикл чтения. Запускается один раз на экземпляр.
    pub async fn run(self: Arc<Self>) {
        loop {
            match self.client.get_multiplexed_async_connection().await {
                Ok(mut conn) => {
                    if let Err(e) = self.pump(&mut conn).await {
                        tracing::warn!(error = %e, "stream pump error, reconnecting");
                    }
                }
                Err(e) => tracing::warn!(error = %e, "stream pump connect failed"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    async fn pump(&self, conn: &mut redis::aio::MultiplexedConnection) -> redis::RedisResult<()> {
        loop {
            let (keys, ids): (Vec<String>, Vec<String>) = {
                let mut subs = self.subs.lock().unwrap();
                subs.retain(|_, list| {
                    list.retain(|s| !s.tx.is_closed());
                    !list.is_empty()
                });
                subs.iter()
                    .map(|(k, list)| (k.clone(), list.iter().map(|s| s.cursor).min().unwrap().to_string()))
                    .unzip()
            };
            if keys.is_empty() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(1), self.wake.notified()).await;
                continue;
            }
            // Короткое ожидание: новые подписки подхватываются не позже чем через 200 мс.
            let opts = StreamReadOptions::default().block(200).count(256);
            let reply: Option<StreamReadReply> = conn.xread_options(&keys, &ids, &opts).await?;
            let Some(reply) = reply else { continue };
            let mut subs = self.subs.lock().unwrap();
            for stream in reply.keys {
                let Some(list) = subs.get_mut(&stream.key) else { continue };
                for sub in list.iter_mut() {
                    for item in &stream.ids {
                        let Some(id) = StreamId::parse(&item.id) else { continue };
                        if id <= sub.cursor {
                            continue;
                        }
                        let body = match item.map.get("e") {
                            Some(Value::BulkString(b)) => String::from_utf8_lossy(b).into_owned(),
                            _ => String::new(),
                        };
                        // Переполненный подписчик получит остаток на следующем круге.
                        if sub.tx.try_send(Entry { id, body }).is_err() {
                            break;
                        }
                        sub.cursor = id;
                    }
                }
            }
        }
    }
}

pub async fn last_id(conn: &mut impl AsyncCommands, key: &str) -> redis::RedisResult<StreamId> {
    let reply: redis::streams::StreamRangeReply = conn.xrevrange_count(key, "+", "-", 1).await?;
    Ok(reply.ids.first().and_then(|e| StreamId::parse(&e.id)).unwrap_or(StreamId::ZERO))
}

/// Добавляет запись в поток с ограничением длины и сроком хранения.
pub async fn append(conn: &mut impl AsyncCommands, key: &str, body: &str, maxlen: usize, ttl_seconds: i64) -> redis::RedisResult<()> {
    redis::pipe()
        .cmd("XADD").arg(key).arg("MAXLEN").arg("~").arg(maxlen).arg("*").arg("e").arg(body).ignore()
        .expire(key, ttl_seconds).ignore()
        .query_async::<()>(conn)
        .await
}
