/** Chat message id / delete / read-status helpers (pure). */

import {
  isOfflineQueuedOrOptimisticOutgoingId,
  type ChatReadStatus,
} from "./chatMessageIds";

export function isServerMessageId(messageId: string): boolean {
  const id = String(messageId || "").trim();
  return !!id && !isOfflineQueuedOrOptimisticOutgoingId(id);
}

/** Id может быть на сервере (в т.ч. clientMessageId вида 1734…-abc) — только outbox_* ещё не отправлен. */
export function isDeletableOnServerMessageId(messageId: string): boolean {
  const id = String(messageId || "").trim();
  if (!id) return false;
  return !id.startsWith("outbox_");
}

/** Совпадение исходящего текста ± время — убрать дубликат outbox/optimistic, когда сервер уже отдал msg_*. */
export function approxSameOutgoingTextMessage(a: any, b: any): boolean {
  if (String(a?.sender || "") !== "me" || String(b?.sender || "") !== "me") return false;
  const t1 = String(a?.text ?? "").trim();
  const t2 = String(b?.text ?? "").trim();
  if (!t1 || t1 !== t2) return false;
  const ty1 = String(a?.type || "text");
  const ty2 = String(b?.type || "text");
  if (ty1 !== "text" || ty2 !== "text") return false;
  const dt = Math.abs(+new Date(a?.timestamp || 0) - +new Date(b?.timestamp || 0));
  return dt < 180_000;
}

export function mergeChatReadStatuses(
  localStatuses: Record<string, ChatReadStatus> = {},
  serverStatuses: Record<string, ChatReadStatus> = {},
): Record<string, ChatReadStatus> {
  const rank: Record<ChatReadStatus, number> = {
    failed: 0,
    sending: 1,
    sent: 2,
    delivered: 3,
    read: 4,
  };
  const next: Record<string, ChatReadStatus> = { ...localStatuses };
  for (const [id, serverStatus] of Object.entries(serverStatuses)) {
    const localStatus = next[id];
    next[id] =
      localStatus && rank[localStatus] > rank[serverStatus]
        ? localStatus
        : serverStatus;
  }
  return next;
}

/** Удалить сообщение и «близнеца» outbox/optimistic с тем же текстом (чтобы не остался второй пузырь). */
export function filterRemoveMessageAndOutgoingDupes(prev: any[], deletedId: string): any[] {
  const victim = prev.find((m) => String(m?.id || "") === deletedId);
  return prev.filter((msg) => {
    const id = String(msg?.id || "");
    if (id === deletedId) return false;
    if (
      victim &&
      String(victim?.sender || "") === "me" &&
      String(msg?.sender || "") === "me" &&
      isOfflineQueuedOrOptimisticOutgoingId(id) &&
      approxSameOutgoingTextMessage(msg, victim)
    ) {
      return false;
    }
    return true;
  });
}

/** Снять с ленты id с сервера и связанные outbox/optimistic (по тексту и local→server map). */
export function removeMessagesForDeletedIds(
  prev: any[],
  rawIds: readonly string[],
  localToServer?: ReadonlyMap<string, string>,
): any[] {
  const deletedSet = new Set(
    (rawIds || []).map((id) => String(id || "").trim()).filter(Boolean),
  );
  if (deletedSet.size === 0) return prev;

  const aliasIds = new Set<string>();
  if (localToServer) {
    for (const sid of deletedSet) {
      for (const [local, server] of localToServer.entries()) {
        if (server === sid) aliasIds.add(local);
      }
    }
  }

  let next = prev;
  for (const id of deletedSet) {
    next = filterRemoveMessageAndOutgoingDupes(next, id);
  }
  for (const aid of aliasIds) {
    next = filterRemoveMessageAndOutgoingDupes(next, aid);
  }

  return next.filter((msg) => {
    const id = String(msg?.id || "").trim();
    if (!id) return true;
    if (deletedSet.has(id) || aliasIds.has(id)) return false;
    const mapped = localToServer?.get(id);
    if (mapped && deletedSet.has(mapped)) return false;
    return true;
  });
}

/** Перед delete «для обоих»: outbox_* → server id из ленты или из map после доставки. */
export function resolveServerMessageIdForDelete(
  messageId: string,
  messages: any[],
  localToServer: ReadonlyMap<string, string>,
): string {
  const id = String(messageId || "").trim();
  if (!id) return "";
  if (isDeletableOnServerMessageId(id)) return id;

  const mapped = localToServer.get(id);
  if (mapped && isDeletableOnServerMessageId(mapped)) return mapped;

  const victim = messages.find((m) => String(m?.id || "").trim() === id);
  if (!victim) return id;

  for (const m of messages) {
    const mid = String(m?.id || "").trim();
    if (!mid || mid === id) continue;
    if (String(m?.sender || "") !== "me") continue;
    if (!isDeletableOnServerMessageId(mid)) continue;
    if (approxSameOutgoingTextMessage(m, victim)) return mid;
  }
  return id;
}

export function isHardDeleteBatchError(error: unknown): boolean {
  const e = String(error || "").trim();
  return e === "network" || e === "server_error" || e === "unauthorized";
}
