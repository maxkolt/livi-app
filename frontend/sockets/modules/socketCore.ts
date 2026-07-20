// frontend/sockets/modules/socketCore.ts
import { io, Socket } from "socket.io-client";
import {
  API_BASE,
  SOCKET_RECONNECT_DELAY_MS,
  SOCKET_RECONNECT_DELAY_MAX_MS,
} from "./constants";
import { shared } from "./shared";

/* ========= socket (singleton) ========= */
let socketInstance: Socket | null = null;

export const isReconnecting = () => shared.reconnecting;

export const getSocket = (): Socket => {
  if (!socketInstance) {
    socketInstance = io(API_BASE, {
      path: "/socket.io",
      // IMPORTANT:
      // Many VPNs / captive portals / corporate networks block WebSocket.
      // Start with polling (more likely to pass), then upgrade to WebSocket when possible.
      transports: ["polling", "websocket"],
      // If first transport fails (e.g. VPN blocks polling), engine.io should try the next one.
      // This keeps behavior stable both with and without VPN.
      // @ts-ignore - available in newer engine.io, safe no-op on older versions.
      tryAllTransports: true,
      upgrade: true,
      // After a successful WebSocket session, reconnect with WebSocket first (less polling→upgrade churn).
      rememberUpgrade: true,
      forceNew: false, // не создаём новый, держим singleton
      // CRITICAL:
      // Do NOT auto-connect on module load. We must attach installId into handshake first,
      // otherwise server will treat us as guest and reauth can fail with "no_installId",
      // causing reconnect loops and even identity resets.
      // Connection is triggered via applyAuthAndConnect()/emitAck() when ready.
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 25,
      reconnectionDelay: SOCKET_RECONNECT_DELAY_MS,
      reconnectionDelayMax: SOCKET_RECONNECT_DELAY_MAX_MS,
      // Connection attempt timeout. Heartbeat pingInterval/pingTimeout are negotiated in the Engine.IO handshake (server-side).
      timeout: 25000,
    });
  }
  return socketInstance;
};

/** Access underlying instance (may be null before first getSocket). Prefer `socket`. */
export function getSocketInstance(): Socket | null {
  return socketInstance;
}

export const socket: Socket = getSocket();
