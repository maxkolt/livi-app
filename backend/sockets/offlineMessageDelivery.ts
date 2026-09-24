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

export const OFFLINE_ACK_CAPABILITY = 'offline_ack';
export const OFFLINE_ACK_TIMEOUT_MS = 20_000;
/** Аренда длиннее таймаута ack, чтобы параллельный bind не выдал ту же запись повторно. */
export const OFFLINE_CLAIM_LEASE_MS = 45_000;

export type ClaimedOfflineMessage = { queueId: unknown; messageData: any };

export interface OfflineQueuePort {
  /** Взять в аренду все записи получателя, созданные не позже `drainStartedAt`. */
  claim(userId: string, drainStartedAt: Date, leaseUntil: Date): Promise<ClaimedOfflineMessage[]>;
  /** Удалить подтверждённую клиентом запись. */
  remove(queueId: unknown): Promise<void>;
  /** Прежний режим: забрать и сразу удалить. */
  takeAll(userId: string): Promise<any[]>;
}

type AckingSocket = {
  handshake?: { query?: Record<string, unknown> };
  emit: (event: string, ...args: any[]) => unknown;
  timeout: (ms: number) => { emit: (event: string, ...args: any[]) => unknown };
};

export function socketSupportsOfflineAck(sock: { handshake?: { query?: Record<string, unknown> } }): boolean {
  const raw = sock?.handshake?.query?.caps;
  const caps = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return caps.split(',').map((c) => c.trim()).includes(OFFLINE_ACK_CAPABILITY);
}

/**
 * Отдать офлайн-очередь сокету. Не ждёт ack'ов — bindUser не должен
 * задерживать ответ на identity:attach на время подтверждений.
 * Возвращает число отправленных сообщений.
 */
export async function deliverOfflineMessages(
  sock: AckingSocket,
  userId: string,
  queue: OfflineQueuePort,
  now: () => number = Date.now,
): Promise<number> {
  if (!socketSupportsOfflineAck(sock)) {
    const messages = await queue.takeAll(userId);
    for (const message of messages) sock.emit('message:received', message);
    return messages.length;
  }

  const startedAt = now();
  let claimed: ClaimedOfflineMessage[];
  try {
    claimed = await queue.claim(userId, new Date(startedAt), new Date(startedAt + OFFLINE_CLAIM_LEASE_MS));
  } catch (e) {
    // Как и прежде: сбой очереди не должен ломать bindUser. Записи остались в БД.
    console.error('[offline] claim failed:', (e as Error)?.message || e);
    return 0;
  }
  for (const { queueId, messageData } of claimed) {
    sock.timeout(OFFLINE_ACK_TIMEOUT_MS).emit('message:received', messageData, (err: unknown, res: any) => {
      // Без ack запись остаётся в аренде и уйдёт при следующем подключении.
      if (err || !res?.ok) return;
      queue.remove(queueId).catch((e) => {
        console.warn('[offline] ack delete failed:', (e as Error)?.message || e);
      });
    });
  }
  return claimed.length;
}
