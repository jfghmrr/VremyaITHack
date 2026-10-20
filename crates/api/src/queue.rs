//! Общая рейтинговая очередь.
//!
//! Заявки и пулы живут в Valkey; пара формируется в три шага, каждый с определённым
//! результатом при гонке:
//! 1. резерв обеих заявок одним Lua-скриптом (обе должны быть в состоянии queued);
//! 2. транзакция PostgreSQL: повторная проверка защиты новичков и лимита пары,
//!    создание матча (уникальный pair_key, один активный матч на игрока);
//! 3. финализация Lua-скриптом: если кто-то отменил заявку во время резерва,
//!    матч отменяется до уведомления игроков, а вторая заявка возвращается в очередь.
//!
//! Сбой между шагами исправляет восстановление зависших резервов.
//!
//! С 2026-10-17 подбор идёт одним проходом по обоим пулам: калибровка и основной пул открываются
//! друг для друга, когда оба игрока ждут дольше `cross_pool_seconds` (окна и защита новичков
//! действуют как прежде). Тому, кто остался без пары, подбор пишет в заявку пояснение (никого нет,
//! лимит пары, разница уровня, пул калибровки) и сразу отправляет его игроку. Поиск не кончается
//! молча: снятая заявка (игрок уже в другом матче, вход в комнату друга) сообщается клиенту.
use crate::config::GameConfig;
use crate::error::{ApiError, ApiResult};
use crate::matches::{self, ALREADY_BUSY};
use crate::protocol::{QueueState, QueueStatus, ServerMsg};
use crate::ratings::{self, Block, Rating};
use crate::realtime::key;
use crate::state::AppState;
use crate::util::now_ms;
use redis::{AsyncCommands, Script};
use std::collections::HashMap;
use std::sync::LazyLock;
use std::time::Duration;
use uuid::Uuid;

const POOLS: [&str; 2] = ["cal", "main"];
const LEADER_TTL_MS: u64 = 3000;
const STALE_RESERVATION_MS: i64 = 10_000;

fn ticket_key(user: Uuid) -> String {
    key(format_args!("q:t:{user}"))
}
fn pool_key(pool: &str) -> String {
    key(format_args!("q:pool:{pool}"))
}
fn reserved_key() -> String {
    key(format_args!("q:reserved"))
}
pub fn user_stream(user: Uuid) -> String {
    key(format_args!("u:{user}:out"))
}

static JOIN: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('EXISTS', KEYS[1]) == 1 then
            redis.call('PEXPIRE', KEYS[1], ARGV[5])
            return redis.call('HGET', KEYS[1], 'state')
        end
        redis.call('HSET', KEYS[1], 'ticket', ARGV[2], 'pool', ARGV[3], 'joined', ARGV[4], 'state', 'queued',
            'mmr', ARGV[6], 'peak', ARGV[7], 'matches', ARGV[8])
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
        return 'new'",
    )
});

static LEAVE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        local st = redis.call('HGET', KEYS[1], 'state')
        if not st then return 'none' end
        if st == 'queued' then
            redis.call('DEL', KEYS[1])
            redis.call('ZREM', KEYS[2], ARGV[1])
            redis.call('ZREM', KEYS[3], ARGV[1])
            return 'left'
        end
        if st == 'reserved' then
            redis.call('HSET', KEYS[1], 'state', 'cancel')
            return 'left'
        end
        return st",
    )
});

/// Резерв пары. Игроки могут быть из разных пулов (после ожидания пулы открыты друг для друга),
/// поэтому каждый убирается из обоих пулов.
static RESERVE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        for i = 1, 2 do
            if redis.call('HGET', KEYS[i], 'state') ~= 'queued' or redis.call('HGET', KEYS[i], 'ticket') ~= ARGV[i] then
                return 0
            end
        end
        for i = 1, 2 do
            redis.call('HSET', KEYS[i], 'state', 'reserved', 'pair', ARGV[3])
            redis.call('PEXPIRE', KEYS[i], 60000)
            redis.call('ZREM', KEYS[3], ARGV[3 + i])
            redis.call('ZREM', KEYS[5], ARGV[3 + i])
        end
        redis.call('ZADD', KEYS[4], ARGV[6], ARGV[3])
        return 1",
    )
});

/// Пояснение к живой заявке: пишется, только пока заявка ждёт (иначе HSET создал бы обрывок заявки).
static NOTE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        if redis.call('HGET', KEYS[1], 'state') ~= 'queued' or redis.call('HGET', KEYS[1], 'ticket') ~= ARGV[1] then
            return 0
        end
        redis.call('HSET', KEYS[1], 'note', ARGV[2])
        return 1",
    )
});

/// 1 — пара подтверждена (заявки удалены); 0 — кто-то отменил: отменённая заявка удаляется,
/// оставшаяся возвращается в очередь с прежним временем входа.
static FINALIZE: LazyLock<Script> = LazyLock::new(|| {
    Script::new(
        r"
        redis.call('ZREM', KEYS[4], ARGV[1])
        local ok = true
        for i = 1, 2 do
            if redis.call('HGET', KEYS[i], 'state') ~= 'reserved' or redis.call('HGET', KEYS[i], 'pair') ~= ARGV[1] then
                ok = false
            end
        end
        if ok and ARGV[4] == '1' then
            redis.call('DEL', KEYS[1], KEYS[2])
            return 1
        end
        for i = 1, 2 do
            local st = redis.call('HGET', KEYS[i], 'state')
            if st == 'cancel' or ARGV[4 + i] == 'drop' then
                redis.call('DEL', KEYS[i])
            elseif st == 'reserved' and redis.call('HGET', KEYS[i], 'pair') == ARGV[1] then
                redis.call('HSET', KEYS[i], 'state', 'queued')
                redis.call('HDEL', KEYS[i], 'pair')
                redis.call('PEXPIRE', KEYS[i], ARGV[7])
                local pk = KEYS[3]
                if redis.call('HGET', KEYS[i], 'pool') == 'cal' then pk = KEYS[5] end
                redis.call('ZADD', pk, redis.call('HGET', KEYS[i], 'joined'), ARGV[1 + i])
            end
        end
        return 0",
    )
});

#[derive(Clone, Debug)]
struct Ticket {
    user: Uuid,
    ticket: String,
    pool: String,
    joined: i64,
    state: String,
    rating: Rating,
    /// Почему пары пока нет (пишет подбор); пусто — пояснения нет.
    note: String,
}

fn parse_ticket(user: Uuid, map: &HashMap<String, String>) -> Option<Ticket> {
    Some(Ticket {
        user,
        ticket: map.get("ticket")?.clone(),
        pool: map.get("pool")?.clone(),
        joined: map.get("joined")?.parse().ok()?,
        state: map.get("state")?.clone(),
        rating: Rating {
            mmr: map.get("mmr")?.parse().ok()?,
            peak_mmr: map.get("peak")?.parse().ok()?,
            rated_matches: map.get("matches")?.parse().ok()?,
        },
        note: map.get("note").cloned().unwrap_or_default(),
    })
}

/// Сейчас в поиске больше никого (с живым соединением) нет.
pub const NOTE_ALONE: &str = "Сейчас больше никто не ищет соперника — ждём первого, кто начнёт.";
/// То же после 30 секунд поиска: честно предлагаем другие способы спеть.
pub const NOTE_ALONE_LONG: &str = "Сейчас больше никто не ищет соперника. Можно ждать дальше, позвать друга или спеть с призраком: ботов вместо людей здесь нет.";
const ALONE_LONG_MS: i64 = 30_000;
/// Заявку сняли потому, что игрок уже участвует в другом матче (например, вошёл в комнату друга).
pub const NOTE_BUSY: &str = "Поиск остановлен: ты уже в другом матче. Заверши его, чтобы искать соперника.";
/// Поиск снят входом в комнату друга.
pub const NOTE_ROOM: &str = "Поиск соперника остановлен: ты перешёл в комнату с другом.";

/// Момент по часам поиска самого игрока («Ищем соперника, 0:12»), когда пара станет возможной.
/// Ожидание обоих растёт вместе, поэтому эта отметка не меняется от такта к такту, и
/// пояснение не рассылается заново каждую секунду.
fn search_clock(waited_ms: i64, eta_ms: i64) -> String {
    let s = (waited_ms.max(0) + eta_ms + 999) / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Текст пояснения для игрока по причине, которая мешает подбору с другим ищущим.
/// `waited_ms` — сколько ждёт сам игрок.
fn note_text(cfg: &GameConfig, me: &Rating, waited_ms: i64, why: Why) -> String {
    match why {
        // Ни MMR, ни разница уровня другого игрока не раскрываются; про лимит пары игрок и так знает
        // по своей истории матчей.
        Why::PairLimit => {
            let n = cfg.pair_daily_limit;
            let matches = match (n % 10, n % 100) {
                (1, m) if m != 11 => "рейтинговый матч",
                (2..=4, m) if !(12..=14).contains(&m) => "рейтинговых матча",
                _ => "рейтинговых матчей",
            };
            format!("Соперник в поиске есть, но с ним сегодня уже сыграно {n} {matches} — больше подбор вас не сводит. Сыграйте без рейтинга: «Играть с другом».")
        }
        Why::Rule(Block::Protected) => "В поиске есть игрок, но новичков с сильными игроками подбор не сводит. Ждём соперника ближе по уровню.".to_owned(),
        Why::Rule(Block::Pool { opens_in_ms }) => {
            let other = if me.calibrating(cfg) { "уже прошедший калибровку" } else { "который ещё проходит калибровку" };
            format!("В поиске есть игрок, {other}. Если пары не найдётся, подберём вас друг с другом примерно на {} поиска.", search_clock(waited_ms, opens_in_ms))
        }
        Why::Rule(Block::Window { fits_in_ms: Some(ms), .. }) => format!(
            "В поиске есть игрок, но разница уровня с ним пока больше допустимой. Окно расширяется, подберём примерно на {} поиска.",
            search_clock(waited_ms, ms)
        ),
        Why::Rule(Block::Window { fits_in_ms: None, .. }) => "В поиске есть игрок, но разница уровня с ним больше предела для рейтинговой дуэли. Сыграйте без рейтинга: «Играть с другом».".to_owned(),
    }
}

/// Причина, по которой двое ищущих не сведены.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Why {
    PairLimit,
    Rule(Block),
}

impl Why {
    /// Что сообщить, если причин несколько: сначала та, что скоро пройдёт (ближайшая), потом постоянные.
    fn rank(self) -> (u8, i64) {
        match self {
            Why::Rule(Block::Window { fits_in_ms: Some(ms), .. }) => (0, ms),
            Why::Rule(Block::Pool { opens_in_ms }) => (0, opens_in_ms),
            Why::PairLimit => (1, 0),
            Why::Rule(Block::Window { fits_in_ms: None, .. }) => (2, 0),
            Why::Rule(Block::Protected) => (3, 0),
        }
    }
}

async fn load_ticket(st: &AppState, user: Uuid) -> redis::RedisResult<Option<Ticket>> {
    let mut c = st.valkey.clone();
    let map: HashMap<String, String> = c.hgetall(ticket_key(user)).await?;
    Ok(parse_ticket(user, &map))
}

pub async fn state_of(st: &AppState, user: Uuid) -> ApiResult<QueueState> {
    let idle = QueueState { status: QueueStatus::Idle, pool: None, window: None, since_ms: None, match_id: None, note: None };
    let Some(t) = load_ticket(st, user).await? else { return Ok(idle) };
    if t.state == "cancel" {
        return Ok(idle);
    }
    let waited = now_ms() - t.joined;
    Ok(QueueState {
        status: QueueStatus::Searching,
        window: Some(ratings::window(&st.cfg.game, &t.rating, waited)),
        pool: Some(t.pool),
        since_ms: Some(t.joined),
        match_id: None,
        note: (!t.note.is_empty()).then_some(t.note),
    })
}

fn idle(note: &str) -> QueueState {
    QueueState { status: QueueStatus::Idle, pool: None, window: None, since_ms: None, match_id: None, note: Some(note.to_owned()) }
}

/// Вход в очередь. Повтор запроса не создаёт вторую заявку.
pub async fn join(st: &AppState, user: Uuid) -> ApiResult<QueueState> {
    join_at(st, user, None).await
}

async fn join_at(st: &AppState, user: Uuid, joined: Option<i64>) -> ApiResult<QueueState> {
    if matches::active_match(st, user).await?.is_some() {
        return Err(ApiError::bad(ALREADY_BUSY));
    }
    let g = &st.cfg.game;
    let r = ratings::load(&st.db, g, user).await?;
    let pool = if r.calibrating(g) { "cal" } else { "main" };
    let mut c = st.valkey.clone();
    let _: String = JOIN
        .key(ticket_key(user))
        .key(pool_key(pool))
        .arg(user.to_string())
        .arg(crate::util::random_hex(8))
        .arg(pool)
        .arg(joined.unwrap_or_else(now_ms))
        .arg(g.queue_ticket_seconds * 1000)
        .arg(r.mmr)
        .arg(r.peak_mmr)
        .arg(r.rated_matches)
        .invoke_async(&mut c)
        .await?;
    state_of(st, user).await
}

/// Возврат в очередь после отмены матча до старта, с прежним временем входа.
pub async fn requeue(st: &AppState, user: Uuid, joined: Option<i64>) -> ApiResult<()> {
    let state = join_at(st, user, joined).await?;
    notify(st, user, &ServerMsg::Queue { state }).await;
    Ok(())
}

pub async fn leave(st: &AppState, user: Uuid) -> ApiResult<QueueState> {
    remove(st, user).await?;
    state_of(st, user).await
}

/// Снимает заявку; `true` — поиск действительно шёл.
async fn remove(st: &AppState, user: Uuid) -> ApiResult<bool> {
    let mut c = st.valkey.clone();
    let res: String = LEAVE
        .key(ticket_key(user))
        .key(pool_key(POOLS[0]))
        .key(pool_key(POOLS[1]))
        .arg(user.to_string())
        .invoke_async(&mut c)
        .await?;
    Ok(res == "left")
}

/// Вход в комнату друга (или реванш) снимает рейтинговый поиск: у игрока один матч за раз, а
/// заявка, оставшаяся в очереди, снялась бы при подборе молча. Возвращает состояние для клиента,
/// если поиск шёл.
pub async fn leave_for_room(st: &AppState, user: Uuid) -> ApiResult<Option<QueueState>> {
    Ok(remove(st, user).await?.then(|| idle(NOTE_ROOM)))
}

/// Heartbeat заявки: короткое переподключение не сбрасывает приоритет ожидания.
pub async fn touch(st: &AppState, user: Uuid) {
    let mut c = st.valkey.clone();
    let _: redis::RedisResult<i64> = c.pexpire(ticket_key(user), (st.cfg.game.queue_ticket_seconds * 1000) as i64).await;
}

pub async fn notify(st: &AppState, user: Uuid, msg: &ServerMsg) {
    let mut c = st.valkey.clone();
    let body = serde_json::to_string(msg).expect("serializable");
    if let Err(e) = crate::realtime::append(&mut c, &user_stream(user), &body, 200, 3600).await {
        tracing::warn!(error = %e, "user notify failed");
    }
}

/// Цикл подбора. Работает только на экземпляре-лидере (аренда в Valkey).
pub async fn matchmaker(st: AppState) {
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let leader_key = key(format_args!("q:leader"));
    loop {
        tick.tick().await;
        let mut c = st.valkey.clone();
        let me = st.cfg.instance_id.clone();
        let lead: redis::RedisResult<Option<String>> = redis::cmd("SET").arg(&leader_key).arg(&me).arg("NX").arg("PX").arg(LEADER_TTL_MS).query_async(&mut c).await;
        let mine = match lead {
            Ok(Some(_)) => true,
            Ok(None) => {
                let holder: Option<String> = c.get(&leader_key).await.unwrap_or(None);
                if holder.as_deref() == Some(me.as_str()) {
                    let _: redis::RedisResult<i64> = c.pexpire(&leader_key, LEADER_TTL_MS as i64).await;
                    true
                } else {
                    false
                }
            }
            Err(_) => false,
        };
        if !mine {
            continue;
        }
        if let Err(e) = recover_reservations(&st).await {
            tracing::warn!(error = %e.message, "reservation recovery failed");
        }
        if let Err(e) = match_queue(&st).await {
            tracing::warn!(error = %e.message, "matchmaking failed");
        }
    }
}

/// Лимит пары для пояснений: результат запроса живёт `PAIR_LIMIT_CACHE`, чтобы подбор не опрашивал
/// базу по каждой паре ищущих каждые 500 мс. `fresh` — проверить по базе сейчас (перед резервом пары).
async fn pair_limit(st: &AppState, a: Uuid, b: Uuid, fresh: bool) -> ApiResult<bool> {
    let k = if a < b { (a, b) } else { (b, a) };
    if !fresh && let Some((v, at)) = PAIR_LIMITS.lock().unwrap().get(&k) && at.elapsed() < PAIR_LIMIT_CACHE {
        return Ok(*v);
    }
    let v = pair_limit_reached(st, a, b).await?;
    let mut cache = PAIR_LIMITS.lock().unwrap();
    if cache.len() > 4096 {
        cache.retain(|_, (_, at)| at.elapsed() < PAIR_LIMIT_CACHE);
    }
    cache.insert(k, (v, std::time::Instant::now()));
    Ok(v)
}

const PAIR_LIMIT_CACHE: Duration = Duration::from_secs(10);
/// Пара игроков (меньший id первым) → (лимит исчерпан, когда проверено).
type PairLimits = HashMap<(Uuid, Uuid), (bool, std::time::Instant)>;
static PAIR_LIMITS: LazyLock<std::sync::Mutex<PairLimits>> = LazyLock::new(Default::default);

async fn pair_limit_reached(st: &AppState, a: Uuid, b: Uuid) -> ApiResult<bool> {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT count(*) FROM matches m
         JOIN match_participants pa ON pa.match_id = m.id AND pa.user_id = $1
         JOIN match_participants pb ON pb.match_id = m.id AND pb.user_id = $2
         WHERE m.kind = 'rated' AND m.state = 'finished' AND m.created_at > now() - interval '24 hours'",
    )
    .bind(a)
    .bind(b)
    .fetch_one(&st.db)
    .await?;
    Ok(count >= st.cfg.game.pair_daily_limit)
}

/// Один проход подбора по обоим пулам. Пары составляются в порядке ожидания; у каждого, кто
/// остался без пары, в заявке обновляется пояснение (никого нет, лимит пары, разница уровня,
/// пул калибровки), и при изменении оно сразу уходит игроку — поиск не крутится молча.
async fn match_queue(st: &AppState) -> ApiResult<()> {
    let mut c = st.valkey.clone();
    let mut tickets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for pool in POOLS {
        let members: Vec<String> = c.zrange(pool_key(pool), 0, -1).await?;
        for m in members {
            let Ok(user) = Uuid::parse_str(&m) else { continue };
            match load_ticket(st, user).await? {
                // Заявка в чужом пуле — устаревшая запись (игрок с тех пор вошёл заново в другой).
                Some(t) if t.pool != pool => {
                    let _: i64 = c.zrem(pool_key(pool), &m).await?;
                }
                Some(t) if t.state == "queued" && seen.insert(user) => tickets.push(t),
                Some(_) => {}
                // Заявка истекла (оборванный поиск без heartbeat).
                None => {
                    let _: i64 = c.zrem(pool_key(pool), &m).await?;
                }
            }
        }
    }
    // Без присутствия (heartbeat) игрок не подбирается, но заявка с приоритетом живёт
    // до своего TTL: короткое переподключение не отправляет в конец очереди.
    if !tickets.is_empty() {
        let keys: Vec<String> = tickets.iter().map(|t| key(format_args!("p:{}", t.user))).collect();
        let present: Vec<Option<String>> = redis::cmd("MGET").arg(&keys).query_async(&mut c).await?;
        let mut i = 0;
        tickets.retain(|_| {
            i += 1;
            present[i - 1].is_some()
        });
    }
    tickets.sort_by_key(|t| t.joined);
    let now = now_ms();
    let g = &st.cfg.game;
    let mut taken = vec![false; tickets.len()];
    let mut why: Vec<Option<Why>> = vec![None; tickets.len()];
    // Пара не сложилась из-за гонки (заявку как раз отменили): пояснение в этот такт не меняем.
    let mut raced = vec![false; tickets.len()];
    for i in 0..tickets.len() {
        if taken[i] {
            continue;
        }
        let a = &tickets[i];
        // Кандидаты в порядке ожидания: дольше ждущий подходящий игрок получает приоритет.
        for j in 0..tickets.len() {
            if j == i || taken[j] {
                continue;
            }
            let b = &tickets[j];
            // Лимит пары действует до конца суток и важнее временных причин (окно, пул): иначе
            // пояснение обещало бы подбор, которого не будет. Для пары, которую правила уже
            // допускают, он проверяется по базе заново, для пояснений — по короткому кешу.
            let blocked = match ratings::check(g, &a.rating, now - a.joined, &b.rating, now - b.joined) {
                Err(block @ (Block::Protected | Block::Window { fits_in_ms: None, .. })) => Some(Why::Rule(block)),
                rule => {
                    if pair_limit(st, a.user, b.user, rule.is_ok()).await? {
                        Some(Why::PairLimit)
                    } else {
                        rule.err().map(Why::Rule)
                    }
                }
            };
            if let Some(w) = blocked {
                if why[i].is_none_or(|old| w.rank() < old.rank()) {
                    why[i] = Some(w);
                }
                continue;
            }
            if try_pair(st, a, b).await? {
                taken[i] = true;
                taken[j] = true;
            } else {
                raced[i] = true;
            }
            break;
        }
    }
    for (i, t) in tickets.iter().enumerate() {
        if taken[i] || raced[i] {
            continue;
        }
        let alone = if now - t.joined >= ALONE_LONG_MS { NOTE_ALONE_LONG } else { NOTE_ALONE };
        let note = why[i].map_or_else(|| alone.to_owned(), |w| note_text(g, &t.rating, now - t.joined, w));
        if note == t.note {
            continue;
        }
        let written: i64 = NOTE.key(ticket_key(t.user)).arg(&t.ticket).arg(&note).invoke_async(&mut c).await?;
        if written == 1 {
            let state = state_of(st, t.user).await?;
            notify(st, t.user, &ServerMsg::Queue { state }).await;
        }
    }
    Ok(())
}

fn pair_key(a: &Ticket, b: &Ticket) -> String {
    let (x, y) = if a.user < b.user { (a, b) } else { (b, a) };
    format!("{}:{}|{}:{}", x.user, x.ticket, y.user, y.ticket)
}

async fn try_pair(st: &AppState, a: &Ticket, b: &Ticket) -> ApiResult<bool> {
    let pair = pair_key(a, b);
    let mut c = st.valkey.clone();
    let reserved: i64 = RESERVE
        .key(ticket_key(a.user))
        .key(ticket_key(b.user))
        .key(pool_key(POOLS[0]))
        .key(reserved_key())
        .key(pool_key(POOLS[1]))
        .arg(&a.ticket)
        .arg(&b.ticket)
        .arg(&pair)
        .arg(a.user.to_string())
        .arg(b.user.to_string())
        .arg(now_ms())
        .invoke_async(&mut c)
        .await?;
    if reserved == 0 {
        return Ok(false);
    }
    let created = create_rated(st, a, b, &pair).await;
    let (ok, drop_a, drop_b) = match &created {
        Ok(Some(_)) => (true, false, false),
        Ok(None) => (false, false, false),
        // Один из игроков уже в другом матче: его заявка снимается, второй ждёт дальше.
        Err(Busy::User(u)) => (false, *u == a.user, *u == b.user),
        Err(Busy::Other(_)) => (false, false, false),
    };
    finalize(st, &pair, a.user, b.user, ok, drop_a, drop_b, created).await
}

#[allow(clippy::too_many_arguments)]
async fn finalize(st: &AppState, pair: &str, a: Uuid, b: Uuid, ok: bool, drop_a: bool, drop_b: bool, created: Result<Option<Uuid>, Busy>) -> ApiResult<bool> {
    let mut c = st.valkey.clone();
    let mut confirmed: i64 = FINALIZE
        .key(ticket_key(a))
        .key(ticket_key(b))
        .key(pool_key("main"))
        .key(reserved_key())
        .key(pool_key("cal"))
        .arg(pair)
        .arg(a.to_string())
        .arg(b.to_string())
        .arg(if ok { "1" } else { "0" })
        .arg(if drop_a { "drop" } else { "keep" })
        .arg(if drop_b { "drop" } else { "keep" })
        .arg(st.cfg.game.queue_ticket_seconds * 1000)
        .invoke_async(&mut c)
        .await?;
    let id = match created {
        Ok(Some(id)) => id,
        Ok(None) => return Ok(false),
        Err(Busy::Other(e)) => return Err(e),
        // Заявка снята: игрок уже в другом матче. Поиск не должен крутиться у него на экране.
        Err(Busy::User(u)) => {
            notify(st, u, &ServerMsg::Queue { state: idle(NOTE_BUSY) }).await;
            return Ok(false);
        }
    };
    let mut orphaned = false;
    if confirmed == 1 && !matches::take_ownership(st, id).await.unwrap_or(false) {
        // Заявки уже удалены: вернём игроков в поиск после отмены матча.
        confirmed = 0;
        orphaned = true;
    }
    if confirmed == 0 {
        // Отмена во время резерва: матч закрывается до того, как кто-то о нём узнал.
        sqlx::query("UPDATE matches SET state = 'cancelled', end_reason = 'queue_cancelled', finished_at = now() WHERE id = $1 AND state = 'created'")
            .bind(id)
            .execute(&st.db)
            .await?;
        sqlx::query("UPDATE match_participants SET active = false WHERE match_id = $1").bind(id).execute(&st.db).await?;
        if orphaned {
            for user in [a, b] {
                let _ = requeue(st, user, None).await;
            }
        }
        return Ok(false);
    }
    for user in [a, b] {
        let state = QueueState { status: QueueStatus::Matched, pool: None, window: None, since_ms: None, match_id: Some(id), note: None };
        notify(st, user, &ServerMsg::Queue { state }).await;
    }
    Ok(true)
}

enum Busy {
    User(Uuid),
    Other(ApiError),
}

impl From<ApiError> for Busy {
    fn from(e: ApiError) -> Self {
        Self::Other(e)
    }
}
impl From<sqlx::Error> for Busy {
    fn from(e: sqlx::Error) -> Self {
        Self::Other(e.into())
    }
}

/// Выбор фрагмента: меньше всего сыгранный обоими за последние матчи; при равенстве —
/// детерминированно по идентификатору матча. Ни одна сторона не навязывает свою песню.
async fn pick_song(st: &AppState, tx: &mut sqlx::PgConnection, a: Uuid, b: Uuid, id: Uuid) -> Result<String, sqlx::Error> {
    let plays: Vec<(String, i64)> = sqlx::query_as(
        "SELECT m.song_id, count(*) FROM match_participants p JOIN matches m ON m.id = p.match_id
         WHERE p.user_id = ANY($1) AND m.kind = 'rated' AND m.state = 'finished'
           AND m.created_at > now() - interval '30 days'
         GROUP BY m.song_id",
    )
    .bind(vec![a, b])
    .fetch_all(&mut *tx)
    .await?;
    let count = |song: &str| plays.iter().find(|(s, _)| s == song).map_or(0, |(_, n)| *n);
    let songs: Vec<&String> = st.catalog.songs.keys().collect();
    let least = songs.iter().map(|s| count(s)).min().unwrap_or(0);
    let candidates: Vec<&&String> = songs.iter().filter(|s| count(s) == least).collect();
    let pick = id.as_u128() as usize % candidates.len();
    Ok((*candidates[pick]).clone())
}

async fn create_rated(st: &AppState, a: &Ticket, b: &Ticket, pair: &str) -> Result<Option<Uuid>, Busy> {
    let g: &GameConfig = &st.cfg.game;
    let id = Uuid::new_v4();
    let mut tx = st.db.begin().await?;
    // Повторная проверка правил по подтверждённым данным под блокировкой рейтингов.
    let mut users = [a.user, b.user];
    users.sort();
    let mut fresh = HashMap::new();
    for u in users {
        sqlx::query("INSERT INTO ratings (user_id, mmr, peak_mmr) VALUES ($1, $2, $2) ON CONFLICT DO NOTHING")
            .bind(u)
            .bind(g.start_mmr)
            .execute(&mut *tx)
            .await?;
        let r = sqlx::query_as::<_, Rating>("SELECT mmr, peak_mmr, rated_matches FROM ratings WHERE user_id = $1 FOR UPDATE")
            .bind(u)
            .fetch_one(&mut *tx)
            .await?;
        fresh.insert(u, r);
    }
    let now = now_ms();
    let (ra, rb) = (fresh[&a.user], fresh[&b.user]);
    if ratings::check(g, &ra, now - a.joined, &rb, now - b.joined).is_err() || pair_limit_reached(st, a.user, b.user).await? {
        return Ok(None);
    }
    let song_id = pick_song(st, &mut tx, a.user, b.user, id).await?;
    let song = st.catalog.get(&song_id).expect("picked from catalog");
    let inserted = sqlx::query(
        "INSERT INTO matches (id, kind, state, song_id, song_version, algorithm_version, duration_s, pair_key)
         VALUES ($1, 'rated', 'created', $2, $3, $4, $5, $6) ON CONFLICT (pair_key) DO NOTHING",
    )
    .bind(id)
    .bind(&song.info.id)
    .bind(&song.info.version)
    .bind(scoring_core::ALGORITHM_VERSION as i32)
    .bind(song.info.duration_s)
    .bind(pair)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        return Ok(None);
    }
    for (slot, t) in [a, b].into_iter().enumerate() {
        let r = sqlx::query("INSERT INTO match_participants (match_id, user_id, slot, queued_since_ms) VALUES ($1, $2, $3, $4)")
            .bind(id)
            .bind(t.user)
            .bind(slot as i16)
            .bind(t.joined)
            .execute(&mut *tx)
            .await;
        if let Err(e) = r {
            if e.as_database_error().is_some_and(|d| d.is_unique_violation()) {
                return Err(Busy::User(t.user));
            }
            return Err(e.into());
        }
    }
    tx.commit().await?;
    Ok(Some(id))
}

/// Резерв, переживший сбой экземпляра: если матч создан — подтверждаем пару,
/// иначе возвращаем заявки в очередь.
async fn recover_reservations(st: &AppState) -> ApiResult<()> {
    let mut c = st.valkey.clone();
    let stale: Vec<String> = c.zrangebyscore(reserved_key(), 0, now_ms() - STALE_RESERVATION_MS).await?;
    for pair in stale {
        let users: Vec<Uuid> = pair.split('|').filter_map(|p| p.split(':').next()).filter_map(|u| Uuid::parse_str(u).ok()).collect();
        let [a, b] = users[..] else {
            let _: i64 = c.zrem(reserved_key(), &pair).await?;
            continue;
        };
        let existing: Option<(Uuid, String)> = sqlx::query_as("SELECT id, state FROM matches WHERE pair_key = $1")
            .bind(&pair)
            .fetch_optional(&st.db)
            .await?;
        let created = match existing {
            Some((id, state)) if state == "created" => Ok(Some(id)),
            _ => Ok(None),
        };
        let ok = matches!(created, Ok(Some(_)));
        finalize(st, &pair, a, b, ok, false, false, created).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(mmr: f64, n: i32) -> Rating {
        Rating { mmr, peak_mmr: mmr, rated_matches: n }
    }

    /// Пояснение одинаково на соседних тактах: оно уходит игроку только при изменении.
    #[test]
    fn notes_do_not_tick() {
        let cfg = GameConfig::default();
        let (a, b) = (r(1000.0, 30), r(1107.0, 30));
        let (cal, main) = (r(1000.0, 4), r(1020.0, 14));
        // Б вошёл в поиск на 4 секунды позже А.
        for (x, y) in [(&a, &b), (&cal, &main)] {
            let text = |now: i64| {
                let (wa, wb) = (now, now - 4_000);
                let block = ratings::check(&cfg, x, wa, y, wb).unwrap_err();
                note_text(&cfg, x, wa, Why::Rule(block))
            };
            assert_eq!(text(5_000), text(5_700));
            assert_eq!(text(5_000), text(12_300));
        }
        let block = ratings::check(&cfg, &a, 5_000, &b, 1_000).unwrap_err();
        // Пояснение не раскрывает MMR соперника (ни разницу, ни его уровень).
        assert!(note_text(&cfg, &a, 5_000, Why::Rule(block)).contains("разница уровня"));
        assert!(!note_text(&cfg, &a, 5_000, Why::Rule(block)).contains("MMR"));
        let far = ratings::check(&cfg, &a, 5_000, &r(1300.0, 30), 1_000).unwrap_err();
        assert!(!note_text(&cfg, &a, 5_000, Why::Rule(far)).contains("MMR"));
        assert!(note_text(&cfg, &a, 5_000, Why::Rule(block)).contains("на 0:34 поиска"), "окна обоих вмещают 107 через 30 с поиска Б");
        let block = ratings::check(&cfg, &cal, 5_000, &main, 1_000).unwrap_err();
        assert!(note_text(&cfg, &cal, 5_000, Why::Rule(block)).contains("уже прошедший калибровку"));
        assert!(note_text(&cfg, &main, 1_000, Why::Rule(block)).contains("ещё проходит калибровку"));
        assert!(note_text(&cfg, &a, 0, Why::PairLimit).contains("3 рейтинговых матча"));
    }
}
