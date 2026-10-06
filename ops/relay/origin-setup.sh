#!/usr/bin/env bash
# Origin (cv-server): WireGuard endpoint for the API relay. Additive: new wg0 interface + UDP 51820.
# Prints the origin public key for relay-setup.sh. Safe to re-run.
set -euo pipefail

WG_PORT="${WG_PORT:-51820}"
WG_ADDR="10.77.0.1/24"

export DEBIAN_FRONTEND=noninteractive
command -v wg >/dev/null || { apt-get update -qq && apt-get install -y -qq wireguard-tools; }

umask 077
mkdir -p /etc/wireguard
[ -s /etc/wireguard/origin.key ] || wg genkey > /etc/wireguard/origin.key
wg pubkey < /etc/wireguard/origin.key > /etc/wireguard/origin.pub

if [ ! -f /etc/wireguard/wg0.conf ]; then
  cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = ${WG_ADDR}
ListenPort = ${WG_PORT}
PrivateKey = $(cat /etc/wireguard/origin.key)
MTU = 1420
EOF
fi

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow "${WG_PORT}/udp" comment 'wireguard api relay' >/dev/null
fi

systemctl enable --now wg-quick@wg0 >/dev/null 2>&1 || wg-quick up wg0
echo "ORIGIN_PUBKEY=$(cat /etc/wireguard/origin.pub)"
