/**
 * Доставка офлайн-очереди сообщений при подключении.
 *
 * Клиенты, объявившие capability `offline_ack` в handshake-query, получают
 * «at-least-once»: запись не удаляется, а берётся в аренду (claimedUntil),
 * и удаляется только после ack клиента — то есть после того, как сообщение
 * легло в его локальное хранилище. Нет ack (сокет отвалился, таймаут) —
 * аренда истекает и сообщение уйдёт при следующем подключении; клиент
 * дедуплицирует по id.
 *
 * Старые клиенты ack не шлют, для них сохранена прежняя семантика
 * «забрал и удалил» — иначе им бы досылалась вся очередь на каждый reconnect.
 */

const OFFLINE_ACK_CAPABILITY = 'offline_ack';
export const OFFLINE_ACK_TIMEOUT_MS = 20_000;
/** Аренда длиннее таймаута ack, чтобы параллельный bind не выдал ту же запись повторно. */
export const OFFLINE_CLAIM_LEASE_MS = 45_000;
export const OFFLINE_DELIVERY_BATCH_SIZE = 50;

export type ClaimedOfflineMessage = { queueId: unknown; messageData: unknown };

export interface OfflineQueuePort {
  /** Взять в аренду ограниченную порцию записей не позже `drainStartedAt`. */
  claim(userId: string, drainStartedAt: Date, leaseUntil: Date, limit: number): Promise<ClaimedOfflineMessage[]>;
  /** Удалить подтверждённую клиентом запись. */
  remove(queueId: unknown): Promise<void>;
  /** Прежний режим: забрать и сразу удалить. */
  takeAll(userId: string, limit: number, drainStartedAt: Date): Promise<unknown[]>;
}

type OfflineAck = (error: unknown, response?: { ok?: boolean } | null) => void;

type AckingSocket = {
  connected?: boolean;
  handshake?: { query?: Record<string, unknown> };
  emit: (event: 'message:received', message: unknown) => unknown;
  timeout: (ms: number) => {
    emit: (event: 'message:received', message: unknown, ack: OfflineAck) => unknown;
  };
};

// identity:attach and reauth can overlap on the same socket. Share the initial
// batch promise while its background drain is alive, instead of doubling in-flight ACKs.
const drains = new WeakMap<AckingSocket, Map<string, Promise<number>>>();

export function socketSupportsOfflineAck(sock: { handshake?: { query?: Record<string, unknown> } }): boolean {
  const raw = sock?.handshake?.query?.caps;
  const caps = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return caps.split(',').map((c) => c.trim()).includes(OFFLINE_ACK_CAPABILITY);
}

/**
 * Отдать офлайн-очередь сокету. Не ждёт ack'ов — bindUser не должен
 * задерживать ответ на identity:attach на время подтверждений.
 * Возвращает число отправленных сообщений первой порции; остальные идут в фоне
 * с тем же пределом ожидающих ACK, не задерживая identity:attach.
 */
export async function deliverOfflineMessages(
  sock: AckingSocket,
  userId: string,
  queue: OfflineQueuePort,
  now: () => number = Date.now,
): Promise<number> {
  let active = drains.get(sock);
  if (!active) { active = new Map(); drains.set(sock, active); }
  const existing = active.get(userId);
  if (existing) return existing;
  let firstBatch!: (count: number) => void;
  const initial = new Promise<number>((resolve) => { firstBatch = resolve; });
  active.set(userId, initial);
  const startedAt = now();
  const connected = () => sock.connected !== false;
  void (async () => {
    let isFirst = true;
    while (connected()) {
      if (!socketSupportsOfflineAck(sock)) {
        const messages = await queue.takeAll(userId, OFFLINE_DELIVERY_BATCH_SIZE, new Date(startedAt));
        for (const message of messages) sock.emit('message:received', message);
        if (isFirst) { firstBatch(messages.length); isFirst = false; }
        if (messages.length < OFFLINE_DELIVERY_BATCH_SIZE) break;
        continue;
      }
      const leaseUntil = new Date(now() + OFFLINE_CLAIM_LEASE_MS);
      const claimed = await queue.claim(userId, new Date(startedAt), leaseUntil, OFFLINE_DELIVERY_BATCH_SIZE);
      if (!connected()) break;
      const acknowledgements = claimed.map(({ queueId, messageData }) => new Promise<boolean>((resolve) => {
        sock.timeout(OFFLINE_ACK_TIMEOUT_MS).emit('message:received', messageData, (err, res) => {
          // Delete only after durable client acknowledgement. Failed ACK/delete
          // leaves the record in MongoDB for retry after the lease expires.
          if (err || !res?.ok) { resolve(false); return; }
          queue.remove(queueId).then(() => resolve(true), (e) => {
            console.warn('[offline] ack delete failed:', (e as Error)?.message || e);
            resolve(false);
          });
        });
      }));
      if (isFirst) { firstBatch(claimed.length); isFirst = false; }
      await Promise.all(acknowledgements);
      // A single unacknowledged/corrupt message must not block unrelated chats.
      // Its lease is newer than the fixed drain cutoff, so subsequent claims
      // skip it while continuing with the remaining backlog.
      if (claimed.length < OFFLINE_DELIVERY_BATCH_SIZE) break;
    }
  })().catch((e) => {
    console.error('[offline] claim failed:', (e as Error)?.message || e);
  }).finally(() => {
    firstBatch(0);
    active.delete(userId);
  });
  return initial;
}
