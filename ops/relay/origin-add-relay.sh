#!/usr/bin/env bash
# Origin: add the relay as a WireGuard peer (10.77.0.2). Usage: RELAY_PUBKEY=<key> bash origin-add-relay.sh
set -euo pipefail
: "${RELAY_PUBKEY:?set RELAY_PUBKEY}"

if ! grep -q "${RELAY_PUBKEY}" /etc/wireguard/wg0.conf; then
  cat >> /etc/wireguard/wg0.conf <<EOF

[Peer]
# api relay (Finland)
PublicKey = ${RELAY_PUBKEY}
AllowedIPs = 10.77.0.2/32
EOF
fi
wg set wg0 peer "${RELAY_PUBKEY}" allowed-ips 10.77.0.2/32
wg show wg0
