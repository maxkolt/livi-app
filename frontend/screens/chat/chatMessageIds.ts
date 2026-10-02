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

/**
 * Строка ленты со старым локальным id outbox_* (прежняя версия переименовывала так сообщения
 * из очереди). Только у неё id не совпадает с серверным, и «близнеца» приходится искать по тексту.
 * Оптимистичный id (1734…-abc) и есть id в Mongo — по тексту его не сверяем: иначе второе «ок»
 * без сети пропадало из ленты как «дубль» первого.
 */
export function isLegacyOutboxLocalId(messageId: string): boolean {
  return String(messageId || '').trim().startsWith('outbox_');
}

export type ChatReadStatus = 'sending' | 'delivered' | 'read' | 'failed' | 'sent';

/** Статус своего сообщения по ответу sendMessage: ещё в очереди — «часы», сервер принял — галочки. */
export function outgoingStatusFromSendResult(
  r: { queued?: boolean; delivered?: boolean } | null | undefined,
): ChatReadStatus {
  if (r?.queued) return 'sending';
  return r?.delivered ? 'delivered' : 'sent';
}
