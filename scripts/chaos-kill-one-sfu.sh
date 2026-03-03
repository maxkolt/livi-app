#!/usr/bin/env bash
# Chaos: остановить одну SFU-ноду (livekit2), затем снова запустить.
# Использование: из корня репо ./scripts/chaos-kill-one-sfu.sh
# Требует: docker-compose.staging.yml, контейнер livi-livekit2-staging.

set -e
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CONTAINER="${CHAOS_SFU_CONTAINER:-livi-livekit2-staging}"

echo "Stopping one SFU node: $CONTAINER"
docker stop "$CONTAINER" || true

echo "Wait 90s (clients may reconnect to other nodes)..."
sleep 90

echo "Starting $CONTAINER again"
docker start "$CONTAINER"

echo "Done. Check health and client reconnects."
