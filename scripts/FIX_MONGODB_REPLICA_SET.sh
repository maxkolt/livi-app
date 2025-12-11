#!/bin/bash
# Скрипт для настройки MongoDB replica set

echo "🔧 Настройка MongoDB replica set..."

# 1. Остановить MongoDB
echo "⏹️  Останавливаем MongoDB..."
systemctl stop mongod

# 2. Проверить, есть ли уже секция replication
if grep -q "^replication:" /etc/mongod.conf; then
    echo "✅ Секция replication уже существует"
    # Проверим, есть ли replSetName
    if ! grep -q "replSetName:" /etc/mongod.conf; then
        echo "➕ Добавляем replSetName..."
        sed -i '/^replication:/a \  replSetName: "rs0"' /etc/mongod.conf
    else
        echo "✅ replSetName уже настроен"
    fi
elif grep -q "^#replication:" /etc/mongod.conf; then
    echo "🔓 Раскомментируем секцию replication..."
    sed -i 's/^#replication:/replication:/' /etc/mongod.conf
    # Проверим replSetName
    if ! grep -q "replSetName:" /etc/mongod.conf; then
        sed -i '/^replication:/a \  replSetName: "rs0"' /etc/mongod.conf
    fi
else
    echo "➕ Добавляем секцию replication..."
    # Найдем конец файла или секцию storage и добавим после неё
    if grep -q "^storage:" /etc/mongod.conf; then
        # Добавим после секции storage
        sed -i '/^storage:/a \\nreplication:\n  replSetName: "rs0"' /etc/mongod.conf
    else
        # Добавим в конец файла
        echo "" >> /etc/mongod.conf
        echo "replication:" >> /etc/mongod.conf
        echo "  replSetName: \"rs0\"" >> /etc/mongod.conf
    fi
fi

# 3. Показать изменения
echo ""
echo "📄 Проверяем изменения в /etc/mongod.conf:"
grep -A 2 "^replication:" /etc/mongod.conf || echo "⚠️  Секция replication не найдена"

# 4. Запустить MongoDB
echo ""
echo "🚀 Запускаем MongoDB..."
systemctl start mongod

# 5. Подождать немного для запуска
sleep 3

# 6. Инициализировать replica set
echo ""
echo "🔧 Инициализируем replica set..."
mongosh --quiet --eval "try { rs.status(); print('✅ Replica set уже инициализирован'); } catch(e) { rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]}); print('✅ Replica set инициализирован'); }"

# 7. Проверить статус
echo ""
echo "📊 Статус replica set:"
mongosh --quiet --eval "rs.status().myState" 2>/dev/null | grep -q "1" && echo "✅ MongoDB работает как PRIMARY" || echo "⏳ Ожидаем перехода в PRIMARY..."

echo ""
echo "✅ Готово! Теперь перезапустите backend:"
echo "   cd /opt/livi-app/backend && pm2 restart livi-backend"
