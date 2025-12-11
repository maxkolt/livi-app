#!/usr/bin/expect -f
set timeout 30
set password "y4IDFbSuHPqVRd2U"

spawn ssh -o StrictHostKeyChecking=no root@89.111.152.241 "cd /opt/livi-app/backend && pm2 logs livi-backend --lines 200 --nostream | grep -iE 'friends|profile|unauthorized|userId' | tail -50"

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
