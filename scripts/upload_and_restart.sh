#!/usr/bin/expect -f
set timeout 60
set password "y4IDFbSuHPqVRd2U"

spawn scp -o StrictHostKeyChecking=no backend/sockets/profile.ts backend/index.ts root@89.111.152.241:/opt/livi-app/backend/

expect {
    "password:" {
        send "$password\r"
        exp_continue
    }
    "yes/no" {
        send "yes\r"
        exp_continue
    }
    eof
}

spawn ssh -o StrictHostKeyChecking=no root@89.111.152.241 "cd /opt/livi-app/backend && pm2 restart livi-backend"

expect {
    "password:" {
        send "$password\r"
        exp_continue
    }
    "yes/no" {
        send "yes\r"
        exp_continue
    }
    eof
}
