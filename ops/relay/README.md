# API relay for VPN users (Finland)

## Why

From foreign VPN exits, new TCP connections to our servers on REG.RU open in 20–70 s or not at all.
Measured on 2026-10-06 from the A35 behind Hiro VPN (exit OVH Gravelines, FR): 8 parallel `GET /health`
gave 21–51 s and 2 failures, while Google and Cloudflare answered in 0.15 s through the same VPN.
Connections that are already open stay fast (≈0.2 s). The likely cause is REG.RU's inbound filtering of
new connections from foreign data-center addresses.

## How

```
phone ──TLS (SNI api.liviapp.com)──▶ relay 185.74.44.244:443
          iptables REDIRECT 443 → haproxy :8443 (inserted by wg0 PostUp, removed by PostDown)
          haproxy: SNI api.liviapp.com ──▶ 10.77.0.1:443 over WireGuard (UDP 51820) ──▶ origin Caddy
                   anything else (TURN over TCP/TLS) ──▶ 127.0.0.1:3478 coturn, as before
```

* The relay box is also coturn `turn2.liviapp.com`; the backend advertises TURN on TCP 443
  (`TURN_ENABLE_TCP_443_2=1`, coturn's own rule redirects 443 → 3478). HAProxy keeps that path:
  only TLS with SNI `api.liviapp.com` goes to the tunnel. If the tunnel is down, the REDIRECT
  rule is gone and TCP 443 falls back to coturn; the app then goes direct.
* TLS is end to end with the origin's certificate, so the app keeps using `https://api.liviapp.com`.
* The WireGuard tunnel is one long-lived UDP flow, so the "new TCP connection" filter does not hit it.
* Android picks the path per network (`NetPath.kt`): a race of `GET /health` direct vs relay; direct wins
  unless it is slower than the relay by more than 300 ms. The choice is applied through OkHttp `Dns`
  (fetch/XHR, images, WebSockets, native call screens, expo-file-system uploads).
* The origin sees relayed clients as `10.77.0.2` (only the nick audit log uses client IPs).

Addresses: origin `10.77.0.1/24` (listens UDP 51820), relay `10.77.0.2/24`.

Measured 2026-10-06 from the Mac behind Hiro VPN (FR): fresh connection via relay 0.5–2.1 s,
direct 7.5–13.4 s; through the tunnel from the relay 0.25–0.37 s. STUN over TCP 443 still answers (0.3 s).

## Setup

1. Origin (`cv-server`): `sudo bash origin-setup.sh` — prints the origin public key.
2. Relay (`185.74.44.244`): `sudo ORIGIN_PUBKEY=<key> bash relay-setup.sh` — prints the relay public key.
3. Origin: `sudo RELAY_PUBKEY=<key> bash origin-add-relay.sh`.
4. Check from anywhere: `curl --resolve api.liviapp.com:443:185.74.44.244 https://api.liviapp.com/health`.

Undo: `wg-quick down wg0 && systemctl disable wg-quick@wg0` on both (relay: also `systemctl disable --now haproxy`,
`ufw delete allow 8443/tcp`), `ufw delete allow 51820/udp` on origin.
