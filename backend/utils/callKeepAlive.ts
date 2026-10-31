import type { ErrorDetails } from './runtimeTypes';
/**
 * Собственный канал доставки звонков для режима «Надёжные звонки» (Android).
 *
 * FCM остаётся основным транспортом. Но VPN, который душит постоянное соединение Google
 * (mtalk.google.com:5228), откладывает пуши на 10+ секунд или теряет их совсем — а сервер
 * LiVi через тот же VPN доступен. Клиент, включивший режим, держит из foreground-сервиса
 * WebSocket сюда, и каждое событие звонка, уходящее в FCM, параллельно уходит и в него —
 * тем же набором полей, что и FCM data. Дубли с FCM клиент отсекает по callId.
 *
 * Протокол (JSON-кадры от сервера):
 *   {"t":"push","data":{...FCM data...},"sentAt":ms}
 *   {"t":"hb","ts":ms} — сердцебиение: по нему клиент понимает, что соединение живо.
 */
import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { logger } from './logger';
import { getIoInstance } from './ioInstance';

export const CALL_KEEPALIVE_PATH = '/keepalive/calls';
/** Чаще не нужно: VPN и NAT держат простаивающее соединение дольше минуты. Реже — рискуем. */
export const CALL_KEEPALIVE_HEARTBEAT_MS = 40_000;
/** Защита от утечек: больше соединений на одного пользователя не держим (устройства/переустановки). */
const MAX_SOCKETS_PER_USER = 4;
const CLUSTER_EVENT = 'livi:callKeepAlive:push';

export type CallKeepAliveAuth = { userId: string; installId: string };
export type CallKeepAliveAuthenticator = (req: IncomingMessage) => Promise<CallKeepAliveAuth | null>;

type KeepAliveSocket = WebSocket & { liviAlive?: boolean; liviInstallId?: string; liviUserId?: string };

const socketsByUser = new Map<string, Set<KeepAliveSocket>>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let clusterListenerAttached = false;

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

function track(userId: string, ws: KeepAliveSocket): void {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  // Одна установка — одно соединение: после смены сети клиент переподключается раньше,
  // чем сервер замечает смерть старого сокета.
  for (const other of set) {
    if (other !== ws && other.liviInstallId === ws.liviInstallId) {
      set.delete(other);
      try { other.terminate(); } catch {}
    }
  }
  set.add(ws);
  while (set.size > MAX_SOCKETS_PER_USER) {
    const oldest = set.values().next().value as KeepAliveSocket | undefined;
    if (!oldest) break;
    set.delete(oldest);
    try { oldest.terminate(); } catch {}
  }
}

function untrack(ws: KeepAliveSocket): void {
  const userId = ws.liviUserId;
  if (!userId) return;
  const set = socketsByUser.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) socketsByUser.delete(userId);
}

function deliverLocal(userId: string, data: Record<string, string>): number {
  const set = socketsByUser.get(userId);
  if (!set || set.size === 0) return 0;
  const frame = JSON.stringify({ t: 'push', data, sentAt: Date.now() });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(frame);
      sent += 1;
    } catch (e: unknown) {
      logger.warn('[callKeepAlive] send failed', { userId, error: (e as ErrorDetails)?.message });
    }
  }
  return sent;
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const frame = JSON.stringify({ t: 'hb', ts: Date.now() });
    for (const set of socketsByUser.values()) {
      for (const ws of set) {
        // Не ответил на прошлый ping — соединение мёртвое (VPN/NAT молча его бросили).
        if (ws.liviAlive === false) {
          untrack(ws);
          try { ws.terminate(); } catch {}
          continue;
        }
        ws.liviAlive = false;
        try {
          ws.ping();
          ws.send(frame);
        } catch {}
      }
    }
  }, CALL_KEEPALIVE_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/**
 * Принять WebSocket на CALL_KEEPALIVE_PATH. Аутентификация — как у нативных HTTP-запросов
 * экранов звонка: x-install-id + x-install-secret.
 * onConnected: досылка звонка, который уже звонит (клиент переподключился посреди вызова).
 */
export function attachCallKeepAlive(
  server: HttpServer,
  authenticate: CallKeepAliveAuthenticator,
  onConnected?: (auth: CallKeepAliveAuth) => void,
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = String(req.url || '').split('?')[0];
    if (path !== CALL_KEEPALIVE_PATH) return;
    authenticate(req)
      .then((auth) => {
        if (!auth) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(req, socket, head, (raw) => {
          const ws = raw as KeepAliveSocket;
          ws.liviAlive = true;
          ws.liviInstallId = auth.installId;
          ws.liviUserId = auth.userId;
          track(auth.userId, ws);
          ws.on('pong', () => {
            ws.liviAlive = true;
          });
          // Клиент ничего не шлёт, кроме служебных кадров; чужие данные игнорируем.
          ws.on('message', () => {
            ws.liviAlive = true;
          });
          ws.on('close', () => untrack(ws));
          ws.on('error', () => untrack(ws));
          try {
            ws.send(JSON.stringify({ t: 'hb', ts: Date.now() }));
          } catch {}
          try {
            onConnected?.(auth);
          } catch (e: unknown) {
            logger.warn('[callKeepAlive] onConnected failed', { error: (e as ErrorDetails)?.message });
          }
        });
      })
      .catch((e: unknown) => {
        logger.warn('[callKeepAlive] auth failed', { error: (e as ErrorDetails)?.message });
        rejectUpgrade(socket, 503, 'Service Unavailable');
      });
  });

  startHeartbeat();
  attachClusterListener();
  logger.info('[callKeepAlive] listening', { path: CALL_KEEPALIVE_PATH });
}

/**
 * Клиент мог подключиться к другому узлу. serverSideEmit есть только у redis-адаптера:
 * адаптер в памяти на каждый вызов пишет предупреждение в консоль.
 */
function forwardToOtherNodes(userId: string, data: Record<string, string>): void {
  try {
    const io = getIoInstance();
    const adapterName = io?.of?.('/')?.adapter?.constructor?.name;
    if (adapterName !== 'RedisAdapter') return;
    io!.serverSideEmit(CLUSTER_EVENT, { userId, data });
  } catch {}
}

/** Другие инстансы (redis-adapter) пересылают события звонка своим подключённым клиентам. */
function attachClusterListener(): void {
  if (clusterListenerAttached) return;
  const io = getIoInstance();
  if (!io) return;
  clusterListenerAttached = true;
  io.on(CLUSTER_EVENT, (payload: { userId?: string; data?: Record<string, string> }) => {
    if (!payload?.userId || !payload.data) return;
    deliverLocal(String(payload.userId), payload.data);
  });
}

/**
 * Отправить событие звонка по собственному каналу — тем же набором полей, что FCM data.
 * Не ждёт Mongo/FCM: вызывать до поиска пуш-токенов, это самый быстрый путь доставки.
 */
export function deliverCallKeepAlive(userId: string, data: Record<string, string>): number {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined && v !== null) payload[k] = String(v);
  }
  const sent = deliverLocal(uid, payload);
  forwardToOtherNodes(uid, payload);
  if (sent > 0) {
    logger.info('[callKeepAlive] delivered', { userId: uid, type: payload.type, callId: payload.callId, sockets: sent });
  }
  return sent;
}

export function getCallKeepAliveStats(): { users: number; sockets: number } {
  let sockets = 0;
  for (const set of socketsByUser.values()) sockets += set.size;
  return { users: socketsByUser.size, sockets };
}

/** Только для тестов. */
export function __resetCallKeepAliveForTests(): void {
  for (const set of socketsByUser.values()) {
    for (const ws of set) {
      try { ws.terminate(); } catch {}
    }
  }
  socketsByUser.clear();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clusterListenerAttached = false;
}
