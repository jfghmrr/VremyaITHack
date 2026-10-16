#!/usr/bin/env bash
# Резервная копия PostgreSQL (окончательные данные: аккаунты, история, матчи, рейтинг).
# Valkey хранит только временное состояние и в копию не входит.
#   deploy/backup.sh                 — через docker compose
#   DATABASE_URL=... deploy/backup.sh — напрямую (локальная разработка)
set -euo pipefail
mkdir -p backups
file="backups/perepev-$(date +%Y%m%d-%H%M%S).dump"
if [[ -n "${DATABASE_URL:-}" ]]; then
  pg_dump --format=custom --no-owner "$DATABASE_URL" > "$file"
else
  docker compose exec -T postgres pg_dump --format=custom --no-owner -U perepev perepev > "$file"
fi
echo "Копия: $file ($(du -h "$file" | cut -f1))"
