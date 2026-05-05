#!/usr/bin/env sh
# Создаёт alertmanager/alertmanager.yml из примера, если файла ещё нет.
set -e
cd "$(dirname "$0")/.."
if [ ! -f alertmanager/alertmanager.yml ]; then
  cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml
  echo "ops: создан alertmanager/alertmanager.yml — укажите smtp_auth_password (пароль приложения Gmail)."
else
  echo "ops: alertmanager/alertmanager.yml уже есть."
fi
