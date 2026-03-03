#!/usr/bin/env bash
# Подготавливает конфиги для staging из примеров. После запуска отредактируйте секреты в созданных файлах.
# Запуск: из корня репо ./scripts/setup-staging-configs.sh

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Staging config setup ==="

if [[ ! -f backend/.env.staging ]]; then
  cp backend/.env.staging.example backend/.env.staging
  echo "  created backend/.env.staging (fill MONGO_URI, LIVEKIT_*, TURN_*, REDIS_URL)"
else
  echo "  backend/.env.staging already exists"
fi

if [[ ! -f livekit/.env.staging ]]; then
  cp livekit/.env.staging.example livekit/.env.staging
  echo "  created livekit/.env.staging (set LIVEKIT_KEYS = same as backend LIVEKIT_API_KEY:LIVEKIT_API_SECRET)"
else
  echo "  livekit/.env.staging already exists"
fi

if [[ ! -f backend/turn/turnserver.conf ]]; then
  cp backend/turn/turnserver.conf.example backend/turn/turnserver.conf
  echo "  created backend/turn/turnserver.conf (set static-auth-secret and realm)"
else
  echo "  backend/turn/turnserver.conf already exists"
fi

echo ""
echo "Next: edit backend/.env.staging, livekit/.env.staging, backend/turn/turnserver.conf with your secrets."
echo "Then: docker compose -f docker-compose.staging.yml up -d"
echo "Check Redis: docker compose -f docker-compose.staging.yml logs backend | grep 'queueStore:redis'"
