-- Аккаунты, сессии и приватная история (перенос из SQLite прежней версии).
CREATE TABLE users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 32),
    -- Совместимость с прежними хешами: scrypt N=2^17, r=8, p=1, 64 байта;
    -- соль хранится hex-строкой и используется как UTF-8 байты этой строки.
    password_salt text NOT NULL,
    password_hash text NOT NULL,
    password_scheme text NOT NULL DEFAULT 'scrypt-17-8-1-64',
    created_at timestamptz NOT NULL DEFAULT now(),
    imported_from_legacy boolean NOT NULL DEFAULT false
);

CREATE TABLE sessions (
    -- SHA-256 случайного токена из HttpOnly-cookie; сам токен не хранится.
    hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE attempts (
    id uuid NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at timestamptz NOT NULL,
    payload jsonb NOT NULL,
    -- NULL для записей прежней версии: их балл посчитан клиентом старым TS-скорингом.
    algorithm_version integer,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX attempts_owner ON attempts(user_id, at DESC);

-- Рейтинг. Балл за песню, MMR и видимый ранг — разные величины.
CREATE TABLE ratings (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mmr double precision NOT NULL DEFAULT 1000,
    -- Наибольший MMR после подтверждённых рейтинговых матчей; не уменьшается при поражениях.
    peak_mmr double precision NOT NULL DEFAULT 1000,
    rated_matches integer NOT NULL DEFAULT 0 CHECK (rated_matches >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE matches (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('rated', 'friend')),
    state text NOT NULL CHECK (state IN (
        'created', 'waiting', 'ready_check', 'countdown', 'singing', 'collecting',
        'finished', 'cancelled', 'failed')),
    song_id text NOT NULL,
    song_version text NOT NULL,
    algorithm_version integer NOT NULL,
    duration_s double precision NOT NULL,
    -- Ключ пары из очереди: один резерв не может создать два матча.
    pair_key text UNIQUE,
    room_code text UNIQUE,
    -- Поколение владельца (fencing): запись принимается только от текущего поколения.
    owner_gen bigint NOT NULL DEFAULT 0,
    start_at timestamptz,
    finished_at timestamptz,
    end_reason text,
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matches_active ON matches(state) WHERE state NOT IN ('finished', 'cancelled', 'failed');

CREATE TABLE match_participants (
    match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot smallint NOT NULL CHECK (slot IN (0, 1)),
    -- Время входа в рейтинговую очередь: при отмене до старта приоритет ожидания сохраняется.
    queued_since_ms bigint,
    -- true, пока матч не завершён: один пользователь — один активный матч.
    active boolean NOT NULL DEFAULT true,
    outcome text CHECK (outcome IN ('win', 'draw', 'loss')),
    score double precision,
    raw_score double precision,
    result jsonb,
    -- Каноническая кривая (i16 BE, десятые доли полутона; -32768 = пауза) для разбора споров.
    curve bytea,
    curve_purge_after timestamptz,
    PRIMARY KEY (match_id, user_id),
    UNIQUE (match_id, slot)
);
CREATE UNIQUE INDEX one_active_match ON match_participants(user_id) WHERE active;
CREATE INDEX participants_user ON match_participants(user_id, match_id);
CREATE INDEX participants_purge ON match_participants(curve_purge_after) WHERE curve IS NOT NULL;

-- Журнал изменений MMR: рейтинг восстанавливается последовательным применением записей.
CREATE TABLE rating_events (
    id bigserial PRIMARY KEY,
    match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    opponent_id uuid NOT NULL,
    mmr_before double precision NOT NULL,
    mmr_after double precision NOT NULL,
    opponent_mmr double precision NOT NULL,
    k double precision NOT NULL,
    expected double precision NOT NULL,
    actual double precision NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (match_id, user_id)
);
CREATE INDEX rating_events_user ON rating_events(user_id, id);
