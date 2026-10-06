#!/usr/bin/env bash
# Relay (Finland VPS, also coturn "turn2"): TLS for api.liviapp.com on TCP 443 goes through WireGuard to
# the origin's Caddy (10.77.0.1:443); everything else on TCP 443 (TURN over TCP/TLS) still reaches coturn.
#
#   external tcp/443 ──REDIRECT──▶ haproxy :8443 ──SNI api.liviapp.com──▶ 10.77.0.1:443 (wg0 → origin Caddy)
#                                              └──anything else──────────▶ 127.0.0.1:3478 (coturn, as before)
#
# The REDIRECT rule is inserted first by wg0 PostUp and removed by PostDown: if the tunnel is down, tcp/443
# falls back to coturn's own rule (443 → 3478) and the app goes direct. TLS stays end to end.
# Usage: ORIGIN_PUBKEY=<key> bash relay-setup.sh   (prints the relay public key)
set -euo pipefail
: "${ORIGIN_PUBKEY:?set ORIGIN_PUBKEY}"
ORIGIN_ENDPOINT="${ORIGIN_ENDPOINT:-92.242.61.46:51820}"
API_SNI="${API_SNI:-api.liviapp.com}"
PUB_IF="$(ip route show default | awk '{print $5; exit}')"
HAPROXY_PORT=8443

export DEBIAN_FRONTEND=noninteractive
if ! command -v wg >/dev/null || ! command -v haproxy >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq wireguard-tools haproxy
fi

umask 077
mkdir -p /etc/wireguard
[ -s /etc/wireguard/relay.key ] || wg genkey > /etc/wireguard/relay.key
wg pubkey < /etc/wireguard/relay.key > /etc/wireguard/relay.pub

RULE="PREROUTING -i ${PUB_IF} -p tcp --dport 443 -j REDIRECT --to-ports ${HAPROXY_PORT}"
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.77.0.2/24
PrivateKey = $(cat /etc/wireguard/relay.key)
MTU = 1420
PostUp = iptables -t nat -I ${RULE/PREROUTING/PREROUTING 1}
PostDown = iptables -t nat -D ${RULE}

[Peer]
# origin (cv-server)
PublicKey = ${ORIGIN_PUBKEY}
Endpoint = ${ORIGIN_ENDPOINT}
AllowedIPs = 10.77.0.1/32
PersistentKeepalive = 15
EOF

umask 022
cat > /etc/haproxy/haproxy.cfg <<EOF
global
  log /dev/log local0
  maxconn 20000

defaults
  mode tcp
  log global
  option dontlognull
  timeout connect 10s
  timeout client 2h
  timeout server 2h
  timeout tunnel 2h

frontend tcp443
  bind :${HAPROXY_PORT}
  tcp-request inspect-delay 3s
  tcp-request content accept if { req.ssl_hello_type 1 }
  tcp-request content accept if { req.len gt 0 }
  use_backend api_origin if { req.ssl_sni -i ${API_SNI} }
  default_backend coturn

backend api_origin
  server origin 10.77.0.1:443

backend coturn
  server coturn 127.0.0.1:3478
EOF
haproxy -c -f /etc/haproxy/haproxy.cfg >/dev/null
systemctl enable haproxy >/dev/null 2>&1 || true
systemctl restart haproxy

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "${HAPROXY_PORT}/tcp" comment 'api relay haproxy (tcp/443 redirect)' >/dev/null
fi

systemctl enable wg-quick@wg0 >/dev/null 2>&1 || true
wg-quick down wg0 >/dev/null 2>&1 || true
wg-quick up wg0
echo "RELAY_PUBKEY=$(cat /etc/wireguard/relay.pub)"
