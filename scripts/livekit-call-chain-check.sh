#!/usr/bin/env bash
# Проверка цепочки видеозвонка: DNS → API → LiveKit keys → TURN.
#
# Локально (Mac):
#   ./scripts/livekit-call-chain-check.sh
#   API_HOST=api.liviapp.com LIVEKIT_HOST=livekit.liviapp.com ./scripts/livekit-call-chain-check.sh
#
# На сервере API (92.242.61.46):
#   bash scripts/livekit-call-chain-check.sh --on-api-server
#
# На сервере LiveKit (194.67.99.41):
#   bash scripts/livekit-call-chain-check.sh --on-livekit-server
#
# С Mac через SSH (подставь user и пути):
#   API_SSH=user@92.242.61.46 LIVEKIT_SSH=user@194.67.99.41 ./scripts/livekit-call-chain-check.sh --remote

set -euo pipefail

API_HOST="${API_HOST:-api.liviapp.com}"
LIVEKIT_HOST="${LIVEKIT_HOST:-livekit.liviapp.com}"
TURN_HOST="${TURN_HOST:-turn.liviapp.com}"
API_BASE="${API_BASE:-https://${API_HOST}}"
LIVEKIT_WSS="${LIVEKIT_WSS:-wss://${LIVEKIT_HOST}}"

BACKEND_DIR="${BACKEND_DIR:-/opt/backend/backend}"
LIVEKIT_CONFIG="${LIVEKIT_CONFIG:-/opt/livekit/livekit.yaml}"

RED=$'\033[0;31m'
GRN=$'\033[0;32m'
YLW=$'\033[1;33m'
RST=$'\033[0m'

section() { echo; echo "=== $1 ==="; }

mask_secret() {
  sed -E 's/(SECRET|secret|credential)(=|:)[^[:space:]"]*/\1=***/g; s/("your_api_secret"|"[^"]{8})[^"]*"/\1***"/g'
}

show_api_env_livekit() {
  local env_file="${1:-$BACKEND_DIR/.env}"
  if [ ! -f "$env_file" ]; then
    echo "${RED}Нет файла: $env_file${RST}"
    return 1
  fi
  echo "Файл: $env_file"
  grep -E '^(LIVEKIT_|LK_)(API_KEY|API_SECRET|URL)=' "$env_file" 2>/dev/null | mask_secret || true
  # Только префикс ключа (как в логах LiveKit: invalid API key: lk_...)
  local key
  key=$(grep -E '^LIVEKIT_API_KEY=' "$env_file" | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [ -z "$key" ]; then
    key=$(grep -E '^LK_API_KEY=' "$env_file" | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
  if [ -n "$key" ]; then
    echo "LIVEKIT_API_KEY (prefix для сверки с livekit.yaml): ${key:0:24}…"
  else
    echo "${RED}LIVEKIT_API_KEY не задан в .env${RST}"
  fi
}

show_livekit_yaml_keys() {
  local cfg="${1:-$LIVEKIT_CONFIG}"
  if [ ! -f "$cfg" ]; then
    echo "${RED}Нет конфига: $cfg${RST}"
    return 1
  fi
  echo "Файл: $cfg"
  echo "Имена ключей в keys: (должны совпадать с LIVEKIT_API_KEY на backend)"
  awk '
    /^keys:/ { inkeys=1; next }
    inkeys && /^[^[:space:]]/ { inkeys=0 }
    inkeys && /^[[:space:]]+[a-zA-Z0-9_]+:/ {
      gsub(/:.*/, "", $1)
      gsub(/^[[:space:]]+/, "", $1)
      print "  - " $1
    }
  ' "$cfg"
}

test_token_against_livekit() {
  local env_file="${1:-$BACKEND_DIR/.env}"
  section "Проверка JWT → LiveKit (на сервере API, нужен node + livekit-server-sdk)"
  if [ ! -f "$env_file" ]; then
    echo "Пропуск: нет .env"
    return 0
  fi
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
  export LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_URL LK_API_KEY LK_API_SECRET LK_URL
  local key="${LIVEKIT_API_KEY:-${LK_API_KEY:-}}"
  local secret="${LIVEKIT_API_SECRET:-${LK_API_SECRET:-}}"
  local url="${LIVEKIT_URL:-${LK_URL:-$LIVEKIT_WSS}}"
  if [ -z "$key" ] || [ -z "$secret" ]; then
    echo "${RED}Нет LIVEKIT_API_KEY/SECRET в .env${RST}"
    return 1
  fi
  local backend_dir
  backend_dir="$(dirname "$env_file")"
  if [ ! -d "$backend_dir/node_modules/livekit-server-sdk" ]; then
    echo "${YLW}Запусти из каталога backend с установленными deps, или:${RST}"
    echo "  cd $backend_dir && node -e \"...\"  (см. docs)"
    return 0
  fi
  (cd "$backend_dir" && node <<'NODE'
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const key = process.env.LIVEKIT_API_KEY || process.env.LK_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET || process.env.LK_API_SECRET;
const url = (process.env.LIVEKIT_URL || process.env.LK_URL || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
if (!key || !secret || !url) {
  console.error('Missing LIVEKIT_* env');
  process.exit(1);
}
(async () => {
  const at = new AccessToken(key, secret, { identity: 'chain-check' });
  at.addGrant({ roomJoin: true, room: 'chain-check-room', canPublish: false, canSubscribe: true });
  const jwt = await at.toJwt();
  const svc = new RoomServiceClient(url, key, secret);
  try {
    await svc.listRooms();
    console.log('OK: RoomServiceClient.listRooms() — ключ принят LiveKit на', url);
  } catch (e) {
    console.error('FAIL: LiveKit отклонил API key/secret:', e.message || e);
    console.error('→ Сверь LIVEKIT_API_KEY в backend .env с keys: в livekit.yaml на', url);
    process.exit(2);
  }
})();
NODE
  )
}

run_local() {
  section "1. DNS"
  for h in "$API_HOST" "$LIVEKIT_HOST" "$TURN_HOST"; do
    ip=$(dig +short A "$h" 2>/dev/null | head -1)
    echo "  $h → ${ip:-?}"
  done
  echo "  (api и turn на одном IP — нормально; livekit часто на отдельном)"

  section "2. API health"
  if curl -sf --connect-timeout 10 "${API_BASE}/health" | head -c 400; then
    echo
    echo "${GRN}  /health OK${RST}"
  else
    echo "${RED}  /health FAIL${RST}"
  fi

  section "3. LiveKit HTTPS (nginx → SFU)"
  code=$(curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 10 "https://${LIVEKIT_HOST}/" || echo "000")
  echo "  https://${LIVEKIT_HOST}/ → HTTP $code (ожидается 200 OK от LiveKit)"
  if [ "$code" != "200" ]; then
    echo "${YLW}  Если не 200 — проверь nginx на 194.67.99.41 и proxy_pass на :7880${RST}"
  fi

  section "4. TURN endpoint (без installId — только STUN fallback)"
  curl -sS --connect-timeout 10 "${API_BASE}/api/turn-credentials" | head -c 300
  echo
  echo "  (401 unauthorized без заголовков приложения — ожидаемо; с приложения должны быть TURN urls)"

  section "5. Что было в логах телефонов"
  echo "  invalid API key: lk_969512bce6a80fb0 + 401 на wss://${LIVEKIT_HOST}"
  echo "  → LIVEKIT_API_KEY на backend ДОЛЖЕН быть ключом из livekit.yaml на ${LIVEKIT_HOST}"
  echo "  → LIVEKIT_URL в backend .env должен быть: ${LIVEKIT_WSS}"

  section "6. Команды на серверах"
  echo "  API (${API_HOST}):"
  echo "    bash $(basename "$0") --on-api-server"
  echo "  LiveKit (${LIVEKIT_HOST}):"
  echo "    bash $(basename "$0") --on-livekit-server"
}

run_on_api_server() {
  section "Backend .env (LiveKit)"
  show_api_env_livekit "$BACKEND_DIR/.env"
  section "TURN (backend)"
  grep -E '^TURN_(HOST|SECRET|PORT)=' "$BACKEND_DIR/.env" 2>/dev/null | mask_secret || echo "TURN_* не найдены"
  section "Порт 3000 / health"
  ss -tlnp 2>/dev/null | grep -E ':3000\s' || echo "3000 не слушается"
  curl -sf http://127.0.0.1:3000/health && echo || echo "localhost:3000/health FAIL"
  test_token_against_livekit "$BACKEND_DIR/.env"
}

run_on_livekit_server() {
  section "LiveKit keys (livekit.yaml)"
  show_livekit_yaml_keys "$LIVEKIT_CONFIG"
  section "Порт 7880"
  ss -tlnp 2>/dev/null | grep -E ':7880\s' || echo "7880 не слушается"
  curl -sf http://127.0.0.1:7880/ && echo || echo "localhost:7880 FAIL"
}

run_remote() {
  : "${API_SSH:?Задай API_SSH=user@92.242.61.46}"
  : "${LIVEKIT_SSH:?Задай LIVEKIT_SSH=user@194.67.99.41}"
  section "Remote: API server"
  ssh "$API_SSH" "BACKEND_DIR=${BACKEND_DIR} bash -s -- --on-api-server" < "$0"
  section "Remote: LiveKit server"
  ssh "$LIVEKIT_SSH" "LIVEKIT_CONFIG=${LIVEKIT_CONFIG} bash -s -- --on-livekit-server" < "$0"
}

case "${1:-}" in
  --on-api-server) run_on_api_server ;;
  --on-livekit-server) run_on_livekit_server ;;
  --remote) run_remote ;;
  *) run_local ;;
esac

echo
echo "=== Готово ==="
