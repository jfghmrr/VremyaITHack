//! Аренда владения матчем с номером поколения (fencing).
//!
//! Владелец — один экземпляр. Ключ `owner` содержит `экземпляр:поколение` и истекает,
//! если владелец не продлевает его. Каждая запись владельца в Valkey проходит через
//! Lua-скрипт, сверяющий значение ключа; каждая запись в PostgreSQL сверяет
//! `matches.owner_gen`. Устаревший процесс не может ничего записать.
use crate::realtime::key;
use redis::Script;
use std::sync::LazyLock;
use uuid::Uuid;

pub const TTL_MS: u64 = 6000;
pub const RENEW_MS: u64 = 2000;
/// Сколько хранятся временные данные матча в Valkey.
pub const DATA_TTL: i64 = 2 * 3600;
pub const OUT_MAXLEN: usize = 4000;

static ACQUIRE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
        local g = redis.call('INCR', KEYS[2])
        redis.call('EXPIRE', KEYS[2], 86400)
        redis.call('SET', KEYS[1], ARGV[1] .. ':' .. g, 'PX', ARGV[2])
        return g",
    )
});

static RENEW: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('GET', KEYS[1]) == ARGV[1] then
            return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        return 0",
    )
});

static RELEASE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
        return 0",
    )
});

/// Событие в поток матча и снимок состояния — только от текущего владельца.
static EMIT: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        if ARGV[2] ~= '' then
            redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[4], '*', 'e', ARGV[2])
            redis.call('EXPIRE', KEYS[2], ARGV[5])
        end
        if ARGV[3] ~= '' then redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[5]) end
        return 1",
    )
});

static CURVE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
        if ARGV[2] == 'init' then
            redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
        else
            redis.call('SETRANGE', KEYS[2], tonumber(ARGV[2]), ARGV[3])
            redis.call('EXPIRE', KEYS[2], ARGV[4])
        end
        return 1",
    )
});

pub struct Keys {
    pub owner: String,
    pub generation: String,
    pub inbox: String,
    pub out: String,
    pub state: String,
}

impl Keys {
    pub fn of(id: Uuid) -> Self {
        Self {
            owner: key(format_args!("m:{id}:owner")),
            generation: key(format_args!("m:{id}:gen")),
            inbox: key(format_args!("m:{id}:in")),
            out: key(format_args!("m:{id}:out")),
            state: key(format_args!("m:{id}:state")),
        }
    }
    pub fn curve(id: Uuid, slot: u8) -> String {
        key(format_args!("m:{id}:curve:{slot}"))
    }
}

#[derive(Clone)]
pub struct Lease {
    pub id: Uuid,
    pub generation: i64,
    pub value: String,
}

#[derive(Debug, thiserror::Error)]
pub enum LeaseError {
    #[error("аренда владельца потеряна")]
    Lost,
    #[error(transparent)]
    Valkey(#[from] redis::RedisError),
}

pub async fn acquire(conn: &mut redis::aio::ConnectionManager, instance: &str, id: Uuid) -> redis::RedisResult<Option<Lease>> {
    let k = Keys::of(id);
    let generation: i64 = ACQUIRE.key(&k.owner).key(&k.generation).arg(instance).arg(TTL_MS).invoke_async(conn).await?;
    Ok((generation > 0).then(|| Lease { id, generation, value: format!("{instance}:{generation}") }))
}

impl Lease {
    pub async fn renew(&self, conn: &mut redis::aio::ConnectionManager) -> Result<(), LeaseError> {
        let ok: i64 = RENEW.key(Keys::of(self.id).owner).arg(&self.value).arg(TTL_MS).invoke_async(conn).await?;
        if ok == 1 { Ok(()) } else { Err(LeaseError::Lost) }
    }

    pub async fn release(&self, conn: &mut redis::aio::ConnectionManager) {
        let _: redis::RedisResult<i64> = RELEASE.key(Keys::of(self.id).owner).arg(&self.value).invoke_async(conn).await;
    }

    pub async fn emit(&self, conn: &mut redis::aio::ConnectionManager, event: &str, snapshot: &str) -> Result<(), LeaseError> {
        let k = Keys::of(self.id);
        let ok: i64 = EMIT
            .key(&k.owner)
            .key(&k.out)
            .key(&k.state)
            .arg(&self.value)
            .arg(event)
            .arg(snapshot)
            .arg(OUT_MAXLEN)
            .arg(DATA_TTL)
            .invoke_async(conn)
            .await?;
        if ok == 1 { Ok(()) } else { Err(LeaseError::Lost) }
    }

    /// `offset == None` — инициализация всей кривой.
    pub async fn write_curve(&self, conn: &mut redis::aio::ConnectionManager, slot: u8, offset: Option<usize>, bytes: &[u8]) -> Result<(), LeaseError> {
        let op = offset.map_or_else(|| "init".to_owned(), |o| o.to_string());
        let ok: i64 = CURVE
            .key(Keys::of(self.id).owner)
            .key(Keys::curve(self.id, slot))
            .arg(&self.value)
            .arg(op)
            .arg(bytes)
            .arg(DATA_TTL)
            .invoke_async(conn)
            .await?;
        if ok == 1 { Ok(()) } else { Err(LeaseError::Lost) }
    }
}
