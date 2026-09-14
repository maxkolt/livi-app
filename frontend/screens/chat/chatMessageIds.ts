/** Shared chat message id helpers (optimistic / outbox). */

/** Локальный статус звонка в переписке (не на сервере). */
export function isLocalCallEventMessageId(messageId: string): boolean {
  return String(messageId || '').trim().startsWith('local_call_');
}

/** Локальный id исходящего после офлайн-очереди или оптимистичной отправки (может ещё не попасть в свежую выборку с сервера). */
export function isOfflineQueuedOrOptimisticOutgoingId(messageId: string): boolean {
  const id = String(messageId || '').trim();
  if (!id) return false;
  if (id.startsWith('outbox_')) return true;
  if (isLocalCallEventMessageId(id)) return false;
  return /^\d{10,}-[a-z0-9]+$/i.test(id);
}

export type ChatReadStatus = 'sending' | 'delivered' | 'read' | 'failed' | 'sent';
