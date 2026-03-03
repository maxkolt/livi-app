#!/usr/bin/env bash
# Перезапуск staging. Запуск из корня репо: ./scripts/staging-restart.sh
set -e
cd "$(dirname "$0")/.."

echo "Stopping (timeout 8 sec)..."
docker compose -f docker-compose.staging.yml down -t 8 --remove-orphans 2>/dev/null || true

echo "Starting..."
docker compose -f docker-compose.staging.yml up -d --remove-orphans
sleep 5
docker compose -f docker-compose.staging.yml ps
