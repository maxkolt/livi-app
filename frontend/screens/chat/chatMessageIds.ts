/** Shared chat message id helpers (optimistic / outbox). */

/** Локальный id исходящего после офлайн-очереди или оптимистичной отправки (может ещё не попасть в свежую выборку с сервера). */
export function isOfflineQueuedOrOptimisticOutgoingId(messageId: string): boolean {
  const id = String(messageId || '').trim();
  if (!id) return false;
  if (id.startsWith('outbox_')) return true;
  return /^\d{10,}-[a-z0-9]+$/i.test(id);
}

export type ChatReadStatus = 'sending' | 'delivered' | 'read' | 'failed' | 'sent';
