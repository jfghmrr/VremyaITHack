// Сгенерировано scripts/gen-types.mjs из contracts/*.schema.json. Не редактировать вручную.

/**
 * Тело `POST /api/attempts`. Поля проверяет сервер; неверное значение — 400.
 */
export interface AttemptIn {
  /**
   * `"precise-1"`, если итог посчитан точной оценкой на сервере; без поля — балл браузера.
   */
  algorithm?: string | null;
  algorithmVersion?: number | null;
  axes?: {
    [k: string]: unknown | undefined;
  } | null;
  id?: string | null;
  moments?: MomentIn[] | null;
  owner?: string | null;
  score?: number | null;
  shift?: number | null;
  songId?: string | null;
  title?: string | null;
  /**
   * Слова проверены (только при точной оценке).
   */
  wordsChecked?: boolean | null;
}
/**
 * Момент разбора попытки (не больше трёх).
 */
export interface MomentIn {
  end_s?: number | null;
  loss?: number | null;
  phrase?: unknown;
  reason?: string | null;
  start_s?: number | null;
  text?: string | null;
}

/**
 * Сообщение клиента. `id` — номер команды в рамках соединения, сервер подтверждает его `ack`.
 * При повторной отправке после переподключения используется тот же `id` и тело:
 * все команды идемпотентны.
 */
export type ClientEnvelope = {
  id: number;
  v: number;
} & (
  | {
      last_seq?: number | null;
      match_id?: string | null;
      type: "hello";
    }
  | {
      c: number;
      type: "ping";
    }
  | {
      type: "queue_join";
    }
  | {
      type: "queue_leave";
    }
  | {
      song_id: string;
      type: "room_create";
    }
  | {
      code: string;
      type: "room_join";
    }
  | {
      match_id: string;
      type: "accept";
    }
  | {
      match_id: string;
      type: "decline";
    }
  | {
      algorithm_version: number;
      match_id: string;
      song_version: string;
      type: "ready";
    }
  | {
      from: number;
      match_id: string;
      points: (number | null)[];
      type: "perf";
    }
  | {
      count: number;
      match_id: string;
      type: "finish";
    }
  | {
      match_id: string;
      type: "leave";
    }
  | {
      match_id: string;
      type: "rematch";
    }
);

export interface Friends {
  friends: Friend[];
  incoming: Friend[];
  outgoing: Friend[];
}
export interface Friend {
  id: string;
  name: string;
}

export interface Leaderboard {
  /**
   * Место текущего игрока, если он откалиброван и не попал в первые места.
   */
  me?: LeaderRow | null;
  /**
   * Первые места: только игроки, прошедшие калибровку.
   */
  top: LeaderRow[];
}
/**
 * Строка таблицы лидеров: место среди откалиброванных игроков, имя и MMR.
 */
export interface LeaderRow {
  /**
   * Это строка текущего игрока.
   */
  me: boolean;
  mmr: number;
  name: string;
  place: number;
}

export type Outcome = "win" | "draw" | "loss";
export type MatchState =
  "created" | "waiting" | "ready_check" | "countdown" | "singing" | "collecting" | "finished" | "cancelled" | "failed";

export interface MatchView {
  algorithm_version: number;
  /**
   * Срок текущего шага (подтверждение, готовность, сбор кривых), мс Unix.
   */
  deadline_ms?: number | null;
  end_reason?: string | null;
  kind: string;
  match_id: string;
  players: PlayerView[];
  result?: MatchResult | null;
  room_code?: string | null;
  song: SongRef;
  /**
   * Время старта по часам сервера, мс Unix.
   */
  start_at_ms?: number | null;
  state: MatchState;
}
export interface PlayerView {
  accepted: boolean;
  connected: boolean;
  finished: boolean;
  left: boolean;
  name: string;
  /**
   * Сколько точек кривой принято сервером.
   */
  points: number;
  ready: boolean;
  slot: number;
  /**
   * Ранг или «Калибровка n/10»; MMR соперника не раскрывается.
   */
  standing: string;
  user_id: string;
}
export interface MatchResult {
  players: PlayerResult[];
  rated: boolean;
  technical: boolean;
}
export interface PlayerResult {
  axes?: Axes | null;
  mmr_after?: number | null;
  mmr_before?: number | null;
  outcome: Outcome;
  /**
   * Канонический балл; null, если кривая неполная (техническое поражение).
   */
  score?: number | null;
  shift?: number | null;
  standing?: string | null;
  user_id: string;
}
export interface Axes {
  coverage: number;
  intervals: number;
  rhythm: number;
  stability: number;
}
export interface SongRef {
  duration_s: number;
  id: string;
  title: string;
  version: string;
}

export interface Profile {
  /**
   * null, если кабинет создан входом через Яндекс ID или VK ID.
   */
  email: string | null;
  /**
   * false — изменения подтверждаются словом «УДАЛИТЬ» вместо пароля.
   */
  hasPassword: boolean;
  id: string;
  name: string;
  /**
   * Привязанные внешние входы: "yandex", "vk".
   */
  providers: string[];
}

export interface Summary {
  calibrating: boolean;
  calibrationTotal: number;
  /**
   * MMR, округлённый для отображения.
   */
  mmr: number;
  protected: boolean;
  /**
   * Ранг показывается только после калибровки.
   */
  rank?: string | null;
  ratedMatches: number;
}

/**
 * Сообщение сервера. `seq` есть у событий матча: важные события доставляются
 * повторно после переподключения, клиент отбрасывает уже виденные номера.
 */
export type ServerEnvelope = {
  seq?: number | null;
  v: number;
} & (
  | {
      heartbeat_ms: number;
      name: string;
      server_time: number;
      type: "welcome";
      user_id: string;
    }
  | {
      c: number;
      s: number;
      type: "pong";
    }
  | {
      error?: string | null;
      id: number;
      ok: boolean;
      type: "ack";
    }
  | {
      state: QueueState;
      type: "queue";
    }
  | {
      type: "match";
      view: MatchView;
    }
  | {
      from: number;
      match_id: string;
      points: (number | null)[];
      type: "opponent";
    }
  | {
      code: string;
      match_id: string;
      type: "room";
    }
  | {
      message: string;
      type: "error";
    }
);
export type QueueStatus = "idle" | "searching" | "matched";
export interface QueueState {
  match_id?: string | null;
  /**
   * Пояснение для пользователя, например об исчерпанном лимите пары.
   */
  note?: string | null;
  pool?: string | null;
  since_ms?: number | null;
  status: QueueStatus;
  /**
   * Допустимая разница MMR сейчас (±).
   */
  window?: number | null;
}

export interface SongInfo {
  artist: string;
  /**
   * Раздел каталога: «Русские», «Праздничные», «Детские», «Классика», «Мировые».
   */
  category?: string | null;
  duration_s: number;
  id: string;
  preview?: string | null;
  tag?: string;
  title: string;
  /**
   * Первые 12 hex-символов SHA-256 файла reference.json.
   */
  version?: string;
}
