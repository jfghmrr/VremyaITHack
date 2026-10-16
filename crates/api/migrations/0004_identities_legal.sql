-- Вход через Яндекс ID и VK ID: у таких пользователей может не быть почты и пароля.
-- UNIQUE на почте сохраняется (NULL не конфликтуют между собой).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_password_pair CHECK ((password_salt IS NULL) = (password_hash IS NULL));

-- Возраст при регистрации; до 14 лет согласие даёт родитель или опекун (ст. 28 ГК РФ),
-- его имя хранится вместе с согласием. NULL у аккаунтов, созданных до этой миграции.
ALTER TABLE users ADD COLUMN age_group text CHECK (age_group IN ('14plus', 'under14'));
ALTER TABLE users ADD COLUMN parent_name text;
ALTER TABLE users ADD CONSTRAINT users_parent_for_child CHECK (age_group IS DISTINCT FROM 'under14' OR parent_name IS NOT NULL);

-- Внешние учётные записи: провайдер и его постоянный идентификатор пользователя.
CREATE TABLE identities (
    provider text NOT NULL CHECK (provider IN ('yandex', 'vk')),
    subject text NOT NULL,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- Обращения правообладателей (ст. 1253.1 ГК РФ, ст. 15.7 149-ФЗ).
CREATE TABLE complaints (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL,
    url text NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
