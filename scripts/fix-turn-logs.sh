#!/bin/bash
# Исправление проблемы с лог файлом coturn

echo "Исправление логов coturn..."

# Вариант 1: Отключить логирование в файл (проще)
sed -i 's/^log-file=/#log-file=/' /etc/turnserver.conf
sed -i 's/^verbose/#verbose/' /etc/turnserver.conf

# Или вариант 2: Исправить права (если нужны логи)
# mkdir -p /var/log/turnserver
# touch /var/log/turnserver.log
# chown turnserver:turnserver /var/log/turnserver.log 2>/dev/null || chmod 666 /var/log/turnserver.log

# Перезапуск
systemctl restart coturn
sleep 2

# Проверка
if systemctl is-active --quiet coturn; then
    echo "✅ coturn работает без ошибок"
    systemctl status coturn --no-pager | head -10
else
    echo "❌ Ошибка"
    journalctl -u coturn -n 10 --no-pager
fi
