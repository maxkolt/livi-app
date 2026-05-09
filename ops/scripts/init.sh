#!/usr/bin/env sh
# Создаёт alertmanager/alertmanager.yml и .env из шаблонов, если файлов ещё нет.
set -e
cd "$(dirname "$0")/.."
if [ ! -f alertmanager/alertmanager.yml ]; then
  cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml
  echo "ops: создан alertmanager/alertmanager.yml."
else
  echo "ops: alertmanager/alertmanager.yml уже есть."
fi

if [ ! -f .env ]; then
  printf '%s\n' 'SMTP_AUTH_PASSWORD=PASTE_GMAIL_APP_PASSWORD' > .env
  echo "ops: создан .env — укажите SMTP_AUTH_PASSWORD (пароль приложения Gmail)."
else
  echo "ops: .env уже есть."
fi
