#!/bin/bash
# Скрипт для проверки конфигурации TURN сервера

echo "=========================================="
echo "Проверка конфигурации TURN сервера"
echo "=========================================="
echo ""

# Проверка бэкенд конфигурации
echo "📋 Backend .env конфигурация:"
echo "----------------------------------------"
cd "$(dirname "$0")/../backend" 2>/dev/null || cd backend 2>/dev/null || exit 1

if [ -f .env ]; then
    echo "✅ Файл .env найден"
    echo ""
    echo "TURN настройки:"
    grep -E "TURN_|STUN_" .env | sed 's/^/  /'
    echo ""
    
    # Проверка обязательных переменных
    TURN_SECRET=$(grep "^TURN_SECRET=" .env | cut -d'=' -f2- | tr -d ' ')
    TURN_HOST=$(grep "^TURN_HOST=" .env | cut -d'=' -f2- | tr -d ' ')
    TURN_PORT=$(grep "^TURN_PORT=" .env | cut -d'=' -f2- | tr -d ' ')
    
    if [ -z "$TURN_SECRET" ]; then
        echo "❌ TURN_SECRET не найден!"
    else
        echo "✅ TURN_SECRET: ${TURN_SECRET:0:20}..."
    fi
    
    if [ -z "$TURN_HOST" ]; then
        echo "❌ TURN_HOST не найден!"
    else
        echo "✅ TURN_HOST: $TURN_HOST"
    fi
    
    if [ -z "$TURN_PORT" ]; then
        echo "❌ TURN_PORT не найден!"
    else
        echo "✅ TURN_PORT: $TURN_PORT"
    fi
else
    echo "❌ Файл backend/.env не найден!"
fi

echo ""
echo "=========================================="
echo "📋 Frontend .env конфигурация:"
echo "----------------------------------------"
cd "$(dirname "$0")/../frontend" 2>/dev/null || cd frontend 2>/dev/null || exit 1

if [ -f .env ]; then
    echo "✅ Файл .env найден"
    echo ""
    echo "TURN настройки:"
    grep -E "EXPO_PUBLIC_TURN" .env | sed 's/^/  /'
    echo ""
    
    TURN_URL=$(grep "^EXPO_PUBLIC_TURN_URL=" .env | cut -d'=' -f2- | tr -d ' ')
    TURN_USERNAME=$(grep "^EXPO_PUBLIC_TURN_USERNAME=" .env | cut -d'=' -f2- | tr -d ' ')
    TURN_CREDENTIAL=$(grep "^EXPO_PUBLIC_TURN_CREDENTIAL=" .env | cut -d'=' -f2- | tr -d ' ')
    
    if [ -z "$TURN_URL" ]; then
        echo "❌ EXPO_PUBLIC_TURN_URL не найден!"
    else
        echo "✅ EXPO_PUBLIC_TURN_URL: $TURN_URL"
    fi
    
    if [ -z "$TURN_USERNAME" ]; then
        echo "⚠️  EXPO_PUBLIC_TURN_USERNAME не найден (может использоваться ephemeral credentials)"
    else
        echo "✅ EXPO_PUBLIC_TURN_USERNAME: $TURN_USERNAME"
    fi
    
    if [ -z "$TURN_CREDENTIAL" ]; then
        echo "⚠️  EXPO_PUBLIC_TURN_CREDENTIAL не найден (может использоваться ephemeral credentials)"
    else
        echo "✅ EXPO_PUBLIC_TURN_CREDENTIAL: $TURN_CREDENTIAL"
    fi
else
    echo "❌ Файл frontend/.env не найден!"
fi

echo ""
echo "=========================================="
echo "🔍 Проверка API endpoint:"
echo "----------------------------------------"

# Попытка проверить API endpoint (если бэкенд запущен)
API_URL="${EXPO_PUBLIC_SERVER_URL:-http://localhost:3000}"
echo "Проверка: $API_URL/api/turn-credentials"

if command -v curl &> /dev/null; then
    RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/api/turn-credentials" 2>/dev/null)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | head -n-1)
    
    if [ "$HTTP_CODE" = "200" ]; then
        echo "✅ API endpoint работает!"
        echo ""
        echo "Ответ сервера:"
        echo "$BODY" | head -c 500
        echo ""
        echo ""
        
        # Проверка наличия TURN серверов в ответе
        if echo "$BODY" | grep -q "turn:"; then
            echo "✅ TURN серверы найдены в ответе"
        else
            echo "⚠️  TURN серверы не найдены в ответе"
        fi
    else
        echo "⚠️  API endpoint вернул код: $HTTP_CODE"
        echo "Ответ: $BODY"
    fi
else
    echo "⚠️  curl не установлен, пропускаем проверку API"
fi

echo ""
echo "=========================================="
echo "✅ Проверка завершена!"
echo "=========================================="
