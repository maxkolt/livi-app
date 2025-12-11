#!/usr/bin/expect -f

# Автоматическое развертывание с использованием expect
set timeout 300
set server "89.111.152.241"
set user "root"
set password "y4IDFbSuHPqVRd2U"

spawn ssh -o StrictHostKeyChecking=no $user@$server

expect {
    "password:" {
        send "$password\r"
        exp_continue
    }
    "$ " {
        send "apt clean && journalctl --vacuum-time=7d 2>/dev/null || true\r"
        expect "$ "
        
        send "node --version 2>/dev/null || (curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs)\r"
        expect "$ "
        
        send "mongod --version 2>/dev/null || (curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor && echo 'deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse' | tee /etc/apt/sources.list.d/mongodb-org-7.0.list && apt update && apt install -y mongodb-org && systemctl enable mongod && systemctl start mongod)\r"
        expect "$ "
        
        send "systemctl start mongod && systemctl enable mongod\r"
        expect "$ "
        
        send "npm install -g pm2\r"
        expect "$ "
        
        send "mkdir -p /opt/livi-app/backend && cd /opt/livi-app/backend && cat > .env << 'ENVEOF'\nPORT=3000\nHOST=0.0.0.0\nMONGO_URI=mongodb://localhost:27017/livi-app\nENVEOF\n\r"
        expect "$ "
        
        send "ufw allow 3000/tcp 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || true\r"
        expect "$ "
        
        send "echo '✅ Настройка завершена'\r"
        expect "$ "
        
        send "exit\r"
    }
}

wait

# Загрузка файлов
spawn scp -r -o StrictHostKeyChecking=no backend/* $user@$server:/opt/livi-app/backend/

expect {
    "password:" {
        send "$password\r"
        exp_continue
    }
    eof
}

wait

# Установка зависимостей и запуск
spawn ssh -o StrictHostKeyChecking=no $user@$server

expect {
    "password:" {
        send "$password\r"
        exp_continue
    }
    "$ " {
        send "cd /opt/livi-app/backend && npm install\r"
        expect "$ "
        
        send "pm2 delete livi-backend 2>/dev/null || true\r"
        expect "$ "
        
        send "pm2 start npm --name 'livi-backend' -- run start\r"
        expect "$ "
        
        send "pm2 save\r"
        expect "$ "
        
        send "pm2 startup | grep -v 'PM2' | bash || true\r"
        expect "$ "
        
        send "sleep 3 && pm2 status\r"
        expect "$ "
        
        send "pm2 logs livi-backend --lines 20 --nostream\r"
        expect "$ "
        
        send "exit\r"
    }
}

wait
