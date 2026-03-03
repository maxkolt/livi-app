#!/usr/bin/env bash
# Диагностика сервера (backend + nginx + порты). Запуск на сервере по SSH: bash server-check.sh
# Можно скопировать в репо и выполнить: scp scripts/server-check.sh user@server:/tmp/ && ssh user@server 'bash /tmp/server-check.sh'

echo "=== LiVi Server Check ==="
echo ""

# 1. Backend процесс и порт 3000
echo "--- 1. Backend (порт 3000) ---"
if command -v ss >/dev/null 2>&1; then
  ss -tlnp | grep -E ':3000\s' || echo "Порт 3000 НЕ слушается"
else
  netstat -tlnp 2>/dev/null | grep 3000 || echo "Порт 3000: проверьте вручную (netstat/ss)"
fi
if systemctl is-active --quiet livi-backend 2>/dev/null; then
  echo "  systemd: livi-backend — active"
else
  echo "  systemd: livi-backend — НЕ active (или сервис не найден)"
fi
echo ""

# 2. LiveKit (порт 7880)
echo "--- 2. LiveKit (порт 7880) ---"
if command -v ss >/dev/null 2>&1; then
  ss -tlnp | grep -E ':7880\s' || echo "Порт 7880 НЕ слушается (LiveKit не запущен?)"
else
  netstat -tlnp 2>/dev/null | grep 7880 || echo "Порт 7880: проверьте вручную"
fi
echo ""

# 3. Nginx
echo "--- 3. Nginx ---"
if systemctl is-active --quiet nginx 2>/dev/null; then
  echo "  nginx: active"
else
  echo "  nginx: НЕ active"
fi
if command -v nginx >/dev/null 2>&1; then
  nginx -t 2>&1 || true
else
  echo "  nginx не установлен или не в PATH"
fi
echo ""

# 4. Порты 80, 443
echo "--- 4. Порты 80, 443 ---"
for p in 80 443; do
  if ss -tlnp 2>/dev/null | grep -q ":${p}\s"; then
    echo "  Порт $p: слушается"
  else
    echo "  Порт $p: НЕ слушается"
  fi
done
echo ""

# 5. Локальная проверка backend
echo "--- 5. Локальный запрос к backend (localhost:3000) ---"
if curl -sf --connect-timeout 3 http://127.0.0.1:3000/health >/dev/null 2>&1; then
  echo "  /health — OK"
else
  echo "  /health — НЕ отвечает (backend не слушает 3000 или упал)"
fi
echo ""

# 6. Доступность .env и рабочая директория
echo "--- 6. Backend директория и .env ---"
BACKEND_DIR="${BACKEND_DIR:-/opt/backend/backend}"
if [ -d "$BACKEND_DIR" ]; then
  echo "  Dir: $BACKEND_DIR — есть"
  [ -f "$BACKEND_DIR/.env" ] && echo "  .env — есть" || echo "  .env — НЕТ"
  [ -f "$BACKEND_DIR/dist/index.js" ] && echo "  dist/index.js — есть" || echo "  dist/index.js — НЕТ"
else
  echo "  Dir: $BACKEND_DIR — НЕТ (задайте BACKEND_DIR=... если backend в другом пути)"
fi
echo ""

echo "=== Конец проверки ==="
echo ""
echo "Если порт 3000 не слушается: systemctl restart livi-backend && journalctl -u livi-backend -f"
echo "Если nginx не active: systemctl restart nginx"
echo "Если 80/443 закрыты снаружи: откройте в firewall (ufw allow 80,443; ufw reload)"
