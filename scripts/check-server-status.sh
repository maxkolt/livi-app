#!/bin/bash
# Скрипт для проверки статуса сервера

echo "==========================================="
echo "ПРОВЕРКА СТАТУСА СЕРВЕРА"
echo "==========================================="
echo ""

echo "1. Статус PM2 процессов:"
pm2 status
echo ""

echo "2. Логи backend (последние 20 строк):"
pm2 logs livi-backend --lines 20 --nostream
echo ""

echo "3. Проверка доступности API:"
curl -s http://localhost:3000/api/turn-credentials | head -c 200
echo ""
echo ""

echo "4. Проверка порта 3000:"
netstat -tuln | grep 3000 || ss -tuln | grep 3000
echo ""

echo "5. Процессы Node.js:"
ps aux | grep -E "node|ts-node" | grep -v grep
echo ""

echo "==========================================="
echo "КОМАНДЫ ДЛЯ УПРАВЛЕНИЯ:"
echo "==========================================="
echo "Перезапуск:  pm2 restart livi-backend"
echo "Остановка:   pm2 stop livi-backend"
echo "Запуск:      pm2 start livi-backend"
echo "Логи:        pm2 logs livi-backend"
echo "Мониторинг:  pm2 monit"
echo ""

