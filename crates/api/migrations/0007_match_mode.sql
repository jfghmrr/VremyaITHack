-- Режим «Вместе» (2026-10-17): в комнате друга двое поют одну песню по очереди, по строке.
-- Существующие и рейтинговые матчи остаются «Кто лучше» (versus). Столбцы с постоянным
-- значением по умолчанию добавляются без перезаписи таблиц.
-- Миграция повторяема: после отката записи о ней (`DELETE FROM _sqlx_migrations WHERE
-- version = 7`, OPERATIONS.md) новая сборка применяет её снова поверх оставшихся столбцов.
ALTER TABLE matches
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'versus' CHECK (mode IN ('versus', 'coop'));
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_coop_friend') THEN
        ALTER TABLE matches ADD CONSTRAINT matches_coop_friend CHECK (mode = 'versus' OR kind = 'friend');
    END IF;
END $$;
-- Согласие участника «Вместе» поделиться голосом с партнёром для общего прослушивания
-- (по умолчанию нет). Сама запись в базе не хранится: файл в DATA_DIR живёт минуты.
ALTER TABLE match_participants
    ADD COLUMN IF NOT EXISTS share_voice boolean NOT NULL DEFAULT false;
