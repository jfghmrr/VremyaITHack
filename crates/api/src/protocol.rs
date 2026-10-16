//! WebSocket-протокол версии 1. Описание и правила доставки — docs/protocol.md.
//! JSON-схемы генерируются из этих типов (`perepev-api schemas`), клиентские типы — из схем.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const PROTOCOL_VERSION: u8 = 1;
/// Максимальный размер входящего сообщения, байт.
pub const MAX_MESSAGE: usize = 16 * 1024;
/// Максимум точек кривой в одном пакете (5 секунд на сетке 50 мс).
pub const MAX_POINTS: usize = 100;

/// Сообщение клиента. `id` — номер команды в рамках соединения, сервер подтверждает его `ack`.
/// При повторной отправке после переподключения используется тот же `id` и тело:
/// все команды идемпотентны.
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
pub struct ClientEnvelope {
    pub v: u8,
    pub id: u64,
    #[serde(flatten)]
    pub msg: ClientMsg,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Первое сообщение. `last_seq` — последний обработанный клиентом номер события матча.
    Hello { match_id: Option<Uuid>, last_seq: Option<u64> },
    /// Heartbeat и оценка смещения часов: `c` — время клиента, мс.
    Ping { c: f64 },
    QueueJoin,
    QueueLeave,
    RoomCreate { song_id: String },
    RoomJoin { code: String },
    Accept { match_id: Uuid },
    Decline { match_id: Uuid },
    /// Эталон и минусовка загружены, микрофон разрешён, AudioContext активирован.
    Ready { match_id: Uuid, song_version: String, algorithm_version: u32 },
    /// Точки канонической кривой с индекса `from`: десятые доли полутона или null (пауза).
    Perf { match_id: Uuid, from: u32, points: Vec<Option<i16>> },
    /// Клиент отправил все точки: `count` — длина кривой.
    Finish { match_id: Uuid, count: u32 },
    Leave { match_id: Uuid },
    Rematch { match_id: Uuid },
}

impl ClientMsg {
    pub fn match_id(&self) -> Option<Uuid> {
        match self {
            Self::Accept { match_id }
            | Self::Decline { match_id }
            | Self::Ready { match_id, .. }
            | Self::Perf { match_id, .. }
            | Self::Finish { match_id, .. }
            | Self::Leave { match_id }
            | Self::Rematch { match_id } => Some(*match_id),
            _ => None,
        }
    }
}

/// Сообщение сервера. `seq` есть у событий матча: важные события доставляются
/// повторно после переподключения, клиент отбрасывает уже виденные номера.
#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct ServerEnvelope {
    pub v: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(flatten)]
    pub msg: ServerMsg,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    Welcome { user_id: Uuid, name: String, server_time: f64, heartbeat_ms: u64 },
    Pong { c: f64, s: f64 },
    Ack { id: u64, ok: bool, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> },
    Queue { state: QueueState },
    /// Состояние матча целиком. Приходит после подключения и при каждом изменении.
    Match { view: Box<MatchView> },
    /// Промежуточная кривая соперника для анимации. Может быть пропущена или заменена.
    Opponent { match_id: Uuid, from: u32, points: Vec<Option<i16>> },
    Room { match_id: Uuid, code: String },
    Error { message: String },
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Idle,
    Searching,
    Matched,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct QueueState {
    pub status: QueueStatus,
    pub pool: Option<String>,
    /// Допустимая разница MMR сейчас (±).
    pub window: Option<f64>,
    pub since_ms: Option<i64>,
    pub match_id: Option<Uuid>,
    /// Пояснение для пользователя, например об исчерпанном лимите пары.
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MatchState {
    Created,
    Waiting,
    ReadyCheck,
    Countdown,
    Singing,
    Collecting,
    Finished,
    Cancelled,
    Failed,
}

impl MatchState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Waiting => "waiting",
            Self::ReadyCheck => "ready_check",
            Self::Countdown => "countdown",
            Self::Singing => "singing",
            Self::Collecting => "collecting",
            Self::Finished => "finished",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        [
            Self::Created, Self::Waiting, Self::ReadyCheck, Self::Countdown, Self::Singing,
            Self::Collecting, Self::Finished, Self::Cancelled, Self::Failed,
        ]
        .into_iter()
        .find(|m| m.as_str() == s)
    }
    pub fn terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Cancelled | Self::Failed)
    }
    /// Пение уже началось: выход означает техническое поражение.
    pub fn committed(self) -> bool {
        matches!(self, Self::Countdown | Self::Singing | Self::Collecting)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct SongRef {
    pub id: String,
    pub title: String,
    pub version: String,
    pub duration_s: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct PlayerView {
    pub slot: u8,
    pub user_id: Uuid,
    pub name: String,
    /// Ранг или «Калибровка n/10»; MMR соперника не раскрывается.
    pub standing: String,
    pub accepted: bool,
    pub ready: bool,
    pub connected: bool,
    pub finished: bool,
    pub left: bool,
    /// Сколько точек кривой принято сервером.
    pub points: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct MatchView {
    pub match_id: Uuid,
    pub kind: String,
    pub state: MatchState,
    pub song: SongRef,
    pub algorithm_version: u32,
    pub room_code: Option<String>,
    pub players: Vec<PlayerView>,
    /// Время старта по часам сервера, мс Unix.
    pub start_at_ms: Option<i64>,
    /// Срок текущего шага (подтверждение, готовность, сбор кривых), мс Unix.
    pub deadline_ms: Option<i64>,
    pub end_reason: Option<String>,
    pub result: Option<MatchResult>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct PlayerResult {
    pub user_id: Uuid,
    pub outcome: scoring_core::Outcome,
    /// Канонический балл; null, если кривая неполная (техническое поражение).
    pub score: Option<f64>,
    pub axes: Option<scoring_core::Axes>,
    pub shift: Option<f64>,
    pub mmr_before: Option<f64>,
    pub mmr_after: Option<f64>,
    pub standing: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, JsonSchema)]
pub struct MatchResult {
    pub rated: bool,
    pub technical: bool,
    pub players: Vec<PlayerResult>,
}
