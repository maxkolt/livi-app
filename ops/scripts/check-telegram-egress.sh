#!/usr/bin/env sh
# Проверка исходящего HTTPS до api.telegram.org (с хоста и из контейнера alertmanager).
set -e
cd "$(dirname "$0")/.."

echo "=== С хоста (ожидается HTTP 200 или 404 от сервера, не таймаут) ==="
if curl -sS -o /dev/null -w "HTTP %{http_code}\n" --connect-timeout 10 https://api.telegram.org/; then
  :
else
  echo "(curl завершился с ошибкой — см. текст выше)"
fi

if docker compose ps alertmanager 2>/dev/null | grep -q Up; then
  echo ""
  echo "=== Из контейнера alertmanager ==="
  docker compose exec -T alertmanager wget -S -O /dev/null --timeout=10 https://api.telegram.org/ 2>&1 | head -8 || true
else
  echo ""
  echo "(контейнер alertmanager не запущен — из каталога ops: docker compose up -d)"
fi
