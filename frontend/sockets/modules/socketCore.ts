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
      // Capabilities для сервера. offline_ack: подтверждаем офлайн-очередь после записи в хранилище,
      // и сервер удаляет запись только по ack (иначе дошлёт при следующем подключении).
      query: { caps: "offline_ack" },
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
    guardDuplicateConnectPacket(socketInstance);
  }
  return socketInstance;
};

/**
 * connect() в окне «транспорт открыт, ответ сервера на CONNECT ещё не пришёл» шлёт второй
 * CONNECT-пакет, а сервер socket.io на него отвечает «invalid state» и закрывает всё
 * соединение (без DISCONNECT; WebSocket — кодом 1005, на Android это «transport error»).
 * Под VPN ответ идёт сотни мс, и любой emitAck/waitForConnect на старте попадал в это окно:
 * первый сокет рвался, а reauth и unread_count ждали полный таймаут.
 * В этом состоянии CONNECT уже отправлен — повторный connect() просто пропускаем.
 */
function guardDuplicateConnectPacket(s: Socket): void {
  const rawConnect = s.connect.bind(s);
  const guarded = (): Socket => {
    const mgr = (s as any).io;
    if (!s.connected && s.active && mgr?._readyState === "open") return s;
    return rawConnect();
  };
  s.connect = guarded;
  s.open = guarded;
}

/** Access underlying instance (may be null before first getSocket). Prefer `socket`. */
export function getSocketInstance(): Socket | null {
  return socketInstance;
}

export const socket: Socket = getSocket();
