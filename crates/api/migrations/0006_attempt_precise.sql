-- Точная оценка (спецификация §5.6): у попытки хранится тег алгоритма точной оценки
-- (`precise-1`, если балл посчитал сервер) и признак, проверялись ли слова.
-- Старые попытки и попытки прежних клиентов остаются с NULL.
ALTER TABLE attempts
    ADD COLUMN algorithm text CHECK (algorithm IS NULL OR length(algorithm) BETWEEN 1 AND 32),
    ADD COLUMN words_checked boolean;
