-- Одна связь на неупорядоченную пару, подтверждение только адресатом.
CREATE TABLE friendships (
    low_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    high_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (low_id, high_id),
    CHECK (low_id < high_id),
    CHECK (requester_id IN (low_id, high_id))
);
CREATE INDEX friendships_high ON friendships(high_id);
