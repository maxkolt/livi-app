// frontend/sockets/modules/socketCore.ts
import { io, Socket } from "socket.io-client";
import {
  API_BASE,
  SOCKET_ENGINE_TIMEOUT_MS,
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
      // Mobile VPN often breaks XHR long-polling while WebSocket still works (and is faster).
      // Corporate/captive portals may block WS — tryAllTransports still falls back to polling.
      transports: ["websocket", "polling"],
      // @ts-ignore - engine.io-client: try every transport in the list on failure
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
      reconnectionAttempts: Infinity,
      reconnectionDelay: SOCKET_RECONNECT_DELAY_MS,
      reconnectionDelayMax: SOCKET_RECONNECT_DELAY_MAX_MS,
      // Keep short so tryAllTransports can fail over WS→polling inside one user-facing wait.
      timeout: SOCKET_ENGINE_TIMEOUT_MS,
    });
  }
  return socketInstance;
};

/** Access underlying instance (may be null before first getSocket). Prefer `socket`. */
export function getSocketInstance(): Socket | null {
  return socketInstance;
}

export const socket: Socket = getSocket();
