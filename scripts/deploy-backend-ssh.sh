#!/bin/bash
# Обновление бэкенда на сервере по SSH.
# Использование:
#   ./scripts/deploy-backend-ssh.sh                    # деплой на свой сервер (настроенный в ~/.ssh/config)
#   ./scripts/deploy-backend-ssh.sh user@host          # деплой на user@host
#   ./scripts/deploy-backend-ssh.sh user@host /path/to/livi-app   # свой путь к репо на сервере

set -e
REMOTE="${1:-}"
REPO_PATH="${2:-}"
if [ -z "$REMOTE" ]; then
  echo "Использование: $0 <user@host> [путь_к_репо_на_сервере]"
  echo "Пример:       $0 deploy@myserver.com"
  echo "Пример:       $0 deploy@myserver.com /var/www/livi-app"
  exit 1
fi
# Путь к репо на сервере по умолчанию (часто совпадает с именем репо)
DEFAULT_REPO_PATH="livi-app"
REPO_PATH="${REPO_PATH:-$DEFAULT_REPO_PATH}"

echo "→ Подключение к $REMOTE, путь к репо: $REPO_PATH"
ssh "$REMOTE" "cd $REPO_PATH && git pull && cd backend && npm ci --omit=dev && npm run build && sudo systemctl restart livi-backend && echo '✅ Backend обновлён и перезапущен'"
