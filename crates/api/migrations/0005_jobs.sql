-- Очередь задач GPU-обработчика: точная оценка исполнения и обработка своих треков.
-- Аудио хранится не здесь, а в DATA_DIR: jobs/<id>/input.wav и tracks/<id>/<файл>.
CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('score', 'track')),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    -- Меньше — раньше: оценка исполнения (0) идёт перед треками (1).
    priority integer NOT NULL,
    owner_user uuid REFERENCES users(id) ON DELETE CASCADE,
    guest_key text,
    params jsonb NOT NULL,
    result jsonb,
    error text,
    stage text CHECK (stage IN ('separating', 'melody', 'words')),
    -- Имя обработчика, который держит аренду; heartbeat продлевает его аренды.
    worker text,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX jobs_pending ON jobs(priority, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_owner ON jobs(owner_user) WHERE owner_user IS NOT NULL;

-- Свои треки: видны только владельцу и удаляются через 24 часа.
CREATE TABLE tracks (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    language text NOT NULL CHECK (language IN ('ru', 'en')),
    job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX tracks_user ON tracks(user_id, created_at DESC);
CREATE INDEX tracks_expiry ON tracks(expires_at);
CREATE INDEX tracks_job ON tracks(job_id);

-- Исполнения для точной оценки: согласие на обработку записи голоса и связь с задачей.
-- Идентификатор задачи оценки совпадает с идентификатором исполнения.
CREATE TABLE perfs (
    id uuid PRIMARY KEY,
    song_id text NOT NULL,
    owner_user uuid REFERENCES users(id) ON DELETE CASCADE,
    guest_key text,
    mode text NOT NULL CHECK (mode IN ('headphones', 'speaker')),
    consent_version text NOT NULL,
    chunks integer NOT NULL DEFAULT 0,
    job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (owner_user IS NOT NULL OR guest_key IS NOT NULL)
);
CREATE INDEX perfs_owner ON perfs(owner_user) WHERE owner_user IS NOT NULL;
