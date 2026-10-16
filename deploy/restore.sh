#!/usr/bin/env bash
# Восстановление из копии с проверкой количества записей. Перезаписывает данные базы!
#   deploy/restore.sh backups/perepev-....dump
set -euo pipefail
file="${1:?укажи файл копии}"
run() {
  if [[ -n "${DATABASE_URL:-}" ]]; then psql "$DATABASE_URL" -Atc "$1"; else docker compose exec -T postgres psql -U perepev -d perepev -Atc "$1"; fi
}
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" < "$file"
else
  docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U perepev -d perepev < "$file"
fi
echo "Восстановлено: пользователей $(run 'select count(*) from users'), попыток $(run 'select count(*) from attempts'), матчей $(run 'select count(*) from matches'), записей рейтинга $(run 'select count(*) from rating_events')"
