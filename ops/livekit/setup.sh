#!/usr/bin/env bash
# LiveKit SFU on the API server (Finland, 217.177.44.79), next to the backend and coturn.
#
# Why: reg.ru (old LiveKit host 194.67.99.41) drops connections from foreign addresses. Phones behind a
# VPN with a foreign exit can't reach it, and since the API moved to Finland the /livekit signal proxy
# can't either (504) — calls and random chat don't connect under a VPN at all.
#
# Ports: signal 7880 on localhost behind Caddy (wss://livekit.liviapp.com), media TCP 7881 and a single
# UDP port 7882 (mux). coturn already owns UDP 50000–60000 here, so LiveKit must not use a range.
# Keys are the backend's LIVEKIT_API_KEY / LIVEKIT_API_SECRET, read from its .env on this box.
#
# Usage:
#   1. bash setup.sh                 installs and starts LiveKit (nothing user-facing changes yet)
#   2. Cloudflare: livekit.liviapp.com A → 217.177.44.79, DNS only
#   3. bash setup.sh caddy           adds the livekit.liviapp.com site to Caddy and checks the cert
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:-217.177.44.79}"
BACKEND_ENV="${BACKEND_ENV:-/opt/backend/backend/.env}"
DOMAIN="${DOMAIN:-livekit.liviapp.com}"

if [ "${1:-}" = "caddy" ]; then
  if ! grep -q "^${DOMAIN} " /etc/caddy/Caddyfile; then
    printf '\n%s {\n\treverse_proxy 127.0.0.1:7880\n}\n' "$DOMAIN" >> /etc/caddy/Caddyfile
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy
  for i in $(seq 1 30); do
    if curl -sf -m 5 "https://${DOMAIN}/" >/dev/null; then echo "CADDY_OK https://${DOMAIN}/"; exit 0; fi
    sleep 2
  done
  echo "no answer from https://${DOMAIN}/ yet: check DNS and journalctl -u caddy" >&2
  exit 1
fi

env_value() { grep -E "^$1=" "$BACKEND_ENV" | tail -1 | cut -d= -f2- | tr -d '"'"'"; }
KEY="$(env_value LIVEKIT_API_KEY)"
SECRET="$(env_value LIVEKIT_API_SECRET)"
[ -n "$KEY" ] && [ -n "$SECRET" ] || { echo "LIVEKIT_API_KEY/SECRET not found in $BACKEND_ENV" >&2; exit 1; }

command -v livekit-server >/dev/null || curl -sSL https://get.livekit.io | bash
id livekit >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin livekit

mkdir -p /etc/livekit
umask 027
cat > /etc/livekit/livekit.yaml <<EOF
port: 7880
log_level: info

rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
  node_ip: ${PUBLIC_IP}

keys:
  "${KEY}": "${SECRET}"
EOF
chown root:livekit /etc/livekit/livekit.yaml
umask 022

# LiveKit warns and drops packets under load with the default 208 KB UDP buffers.
cat > /etc/sysctl.d/90-livekit.conf <<EOF
net.core.rmem_max = 5000000
net.core.wmem_max = 5000000
EOF
sysctl -q --system

cat > /etc/systemd/system/livekit.service <<EOF
[Unit]
Description=LiveKit SFU
After=network-online.target
Wants=network-online.target

[Service]
User=livekit
ExecStart=$(command -v livekit-server) --config /etc/livekit/livekit.yaml
Restart=always
RestartSec=2
LimitNOFILE=200000

[Install]
WantedBy=multi-user.target
EOF

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 7881/tcp comment 'livekit rtc tcp' >/dev/null
  ufw allow 7882/udp comment 'livekit rtc udp' >/dev/null
fi

systemctl daemon-reload
systemctl enable livekit >/dev/null 2>&1
systemctl restart livekit
sleep 3
systemctl is-active livekit
curl -s -m 5 http://127.0.0.1:7880/ && echo && echo "LIVEKIT_OK $(livekit-server --version 2>/dev/null)"
