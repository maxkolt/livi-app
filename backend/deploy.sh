#!/bin/sh
# Деплой бэкенда: pull (из корня репо), сборка backend, рестарт.
# Запускать с сервера: cd /opt/backend && sh backend/deploy.sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
git pull origin main
cd backend
npm run build
systemctl restart livi-backend
echo "[deploy] done. Check: journalctl -u livi-backend -n 20 | grep 'push v2'"
