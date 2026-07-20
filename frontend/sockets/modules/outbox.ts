// frontend/sockets/modules/outbox.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { emitAck } from "./emit";
import type {
  EditOutboxItem,
  MessageOutboxItem,
  OutboxMessageDeliveredPayload,
} from "./outboxTypes";

export type {
  EditOutboxItem,
  MessageOutboxItem,
  OutboxMessageDeliveredPayload,
} from "./outboxTypes";

const MESSAGE_OUTBOX_KEY = 'chat_message_outbox_v1';
const MESSAGE_EDIT_OUTBOX_KEY = 'chat_message_edit_outbox_v1';
/** fingerprint: optimisticUiId / outbox_* — пользователь удалил до отправки; блокируем поздний enqueue и drain. */
const MESSAGE_OUTBOX_CANCELLED_IDS_KEY = 'chat_message_outbox_cancelled_ids_v1';

async function loadCancelledOutboxIdsDisk(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGE_OUTBOX_CANCELLED_IDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.map((x: any) => String(x || '').trim()).filter(Boolean) : [],
    );
  } catch {
    return new Set();
  }
}

async function hydrateCancelledOutboxFromDisk(): Promise<void> {
  if (shared.cancelledOutboxDiskHydrated) return;
  shared.cancelledOutboxDiskHydrated = true;
  const disk = await loadCancelledOutboxIdsDisk();
  for (const id of disk) shared.cancelledOutboxSendIds.add(id);
}

async function persistCancelledOutboxIdsMerge(ids: Iterable<string>): Promise<void> {
  const add = [...new Set([...ids].map((x) => String(x || '').trim()).filter(Boolean))];
  if (!add.length) return;
  for (const id of add) shared.cancelledOutboxSendIds.add(id);
  try {
    const merged = new Set([...(await loadCancelledOutboxIdsDisk()), ...shared.cancelledOutboxSendIds]);
    const capped = [...merged].slice(-500);
    await AsyncStorage.setItem(MESSAGE_OUTBOX_CANCELLED_IDS_KEY, JSON.stringify(capped));
  } catch {}
}

function isFingerprintCancelledSync(optimisticUiId?: string, rowId?: string): boolean {
  const oid = String(optimisticUiId || '').trim();
  const rid = String(rowId || '').trim();
  if (rid && shared.cancelledOutboxSendIds.has(rid)) return true;
  if (oid && shared.cancelledOutboxSendIds.has(oid)) return true;
  return false;
}

export function clearCancelledOutboxFingerprints(): void {
  shared.cancelledOutboxSendIds.clear();
  shared.cancelledOutboxDiskHydrated = false;
  AsyncStorage.removeItem(MESSAGE_OUTBOX_CANCELLED_IDS_KEY).catch(() => {});
}

function isLikelyOfflineError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return (
    msg.includes('network request failed') ||
    msg.includes('socket connection timeout') ||
    msg.includes('xhr poll error') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

async function loadMessageOutbox(): Promise<MessageOutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGE_OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    return list
      .map((item: any) => ({
        id: String(item?.id || ''),
        optimisticUiId: item?.optimisticUiId ? String(item.optimisticUiId) : undefined,
        createdAt: Number(item?.createdAt || Date.now()),
        payload: item?.payload || {},
      }))
      .filter((item: MessageOutboxItem) => !!item.id && !!item.payload?.to);
  } catch {
    return [];
  }
}

async function saveMessageOutbox(items: MessageOutboxItem[]): Promise<void> {
  try {
    if (!items.length) {
      await AsyncStorage.removeItem(MESSAGE_OUTBOX_KEY);
      return;
    }
    await AsyncStorage.setItem(MESSAGE_OUTBOX_KEY, JSON.stringify(items));
  } catch {}
}

/** @returns false если отправку отменили (удалили сообщение) — не ставить снова в очередь. */
export async function enqueueMessageOutbox(item: MessageOutboxItem): Promise<boolean> {
  await hydrateCancelledOutboxFromDisk();
  const oid = String(item.optimisticUiId || '').trim();
  const rid = String(item.id || '').trim();
  if (isFingerprintCancelledSync(oid, rid)) {
    return false;
  }
  let items = await loadMessageOutbox();
  if (items.some((x) => x.id === item.id)) return true;
  if (oid) {
    items = items.filter((x) => String(x.optimisticUiId || '').trim() !== oid);
  }
  if (isFingerprintCancelledSync(oid, rid)) {
    await saveMessageOutbox(items);
    return false;
  }
  items.push(item);
  await saveMessageOutbox(items);
  return true;
}

/** Убрать из офлайн-очереди отправки по id outbox_* или по прежнему optimistic id из UI. */
export async function removeQueuedMessagesMatching(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(
    (rawIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (ids.size === 0) return;
  const items = await loadMessageOutbox();
  const removed = items.filter(
    (item) =>
      ids.has(item.id) ||
      !!(item.optimisticUiId && ids.has(String(item.optimisticUiId))),
  );
  const fingerprints = new Set<string>(ids);
  for (const r of removed) {
    fingerprints.add(r.id);
    if (r.optimisticUiId) fingerprints.add(String(r.optimisticUiId));
  }
  await persistCancelledOutboxIdsMerge(fingerprints);

  const next = items.filter(
    (item) =>
      !ids.has(item.id) &&
      !(item.optimisticUiId && ids.has(item.optimisticUiId)),
  );
  if (next.length === items.length && removed.length === 0) return;
  await saveMessageOutbox(next);
}

async function loadEditOutbox(): Promise<EditOutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGE_EDIT_OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    return list
      .map((item: any) => ({
        id: String(item?.id || ''),
        messageId: String(item?.messageId || '').trim(),
        text: String(item?.text ?? ''),
        createdAt: Number(item?.createdAt || Date.now()),
      }))
      .filter((item: EditOutboxItem) => !!item.id && !!item.messageId);
  } catch {
    return [];
  }
}

async function saveEditOutbox(items: EditOutboxItem[]): Promise<void> {
  try {
    if (!items.length) {
      await AsyncStorage.removeItem(MESSAGE_EDIT_OUTBOX_KEY);
      return;
    }
    await AsyncStorage.setItem(MESSAGE_EDIT_OUTBOX_KEY, JSON.stringify(items));
  } catch {}
}

export async function enqueueEditOutbox(item: EditOutboxItem): Promise<void> {
  let items = await loadEditOutbox();
  items = items.filter((x) => x.messageId !== item.messageId);
  items.push(item);
  await saveEditOutbox(items);
}

/**
 * Если сообщение ещё в очереди message outbox (офлайн / не успело уйти),
 * правка текста должна менять payload очереди — а не message:edit с id outbox_* / optimistic,
 * иначе сервер сохранит старый текст и quietSync даст дубликат с другим текстом.
 */
export async function mergePendingMessageOutboxEdit(messageId: string, text: string): Promise<boolean> {
  const mid = String(messageId || '').trim();
  if (!mid) return false;
  let items = await loadMessageOutbox();
  const idx = items.findIndex(
    (x) => x.id === mid || (!!x.optimisticUiId && String(x.optimisticUiId) === mid),
  );
  if (idx < 0) return false;
  const item = items[idx];
  items[idx] = {
    ...item,
    payload: { ...item.payload, text: String(text ?? '') },
  };
  await saveMessageOutbox(items);
  const rid = [mid, item.id, item.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean);
  await removeQueuedEditsMatching(rid);
  return true;
}

async function remapEditOutboxMessageIds(oldIds: readonly string[], newId: string): Promise<void> {
  const nid = String(newId || '').trim();
  if (!nid) return;
  const olds = new Set(
    (oldIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (!olds.size) return;
  let items = await loadEditOutbox();
  let touched = false;
  items = items.map((x) => {
    if (olds.has(x.messageId)) {
      touched = true;
      return { ...x, messageId: nid };
    }
    return x;
  });
  if (!touched) return;
  items.sort((a, b) => a.createdAt - b.createdAt);
  const lastByMid = new Map<string, EditOutboxItem>();
  for (const it of items) {
    lastByMid.set(it.messageId, it);
  }
  await saveEditOutbox(Array.from(lastByMid.values()));
}

function dispatchOutboxMessageDelivered(p: OutboxMessageDeliveredPayload): void {
  for (const cb of shared.outboxMessageDeliveredSubs) {
    try {
      cb(p);
    } catch {}
  }
}

/** После flush outbox: локальный id → серверный msg_*, плюс remap очереди правок. */
export function onOutboxMessageDelivered(cb: (p: OutboxMessageDeliveredPayload) => void): () => void {
  shared.outboxMessageDeliveredSubs.add(cb);
  return () => {
    shared.outboxMessageDeliveredSubs.delete(cb);
  };
}

/** Удалить из офлайн-очереди правок (например при удалении сообщения). */
export async function removeQueuedEditsMatching(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(
    (rawIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (ids.size === 0) return;
  const items = await loadEditOutbox();
  const next = items.filter((x) => !ids.has(x.messageId));
  if (next.length === items.length) return;
  await saveEditOutbox(next);
}

export async function drainEditOutbox(): Promise<void> {
  if (shared.editOutboxDrainInFlight) return shared.editOutboxDrainInFlight;
  shared.editOutboxDrainInFlight = (async () => {
    if (!socket.connected) return;
    let items = await loadEditOutbox();
    if (!items.length) return;

    items.sort((a, b) => a.createdAt - b.createdAt);
    const keep: EditOutboxItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const resp = await emitAck<{ ok: boolean; error?: string }>('message:edit', {
          messageId: item.messageId,
          text: item.text,
        });
        if (!resp?.ok) {
          keep.push(item);
        }
      } catch (e) {
        if (isLikelyOfflineError(e)) {
          keep.push(...items.slice(i));
          break;
        }
        keep.push(item);
      }
    }

    await saveEditOutbox(keep);
  })().finally(() => {
    shared.editOutboxDrainInFlight = null;
  });
  return shared.editOutboxDrainInFlight;
}

export async function drainMessageOutbox(): Promise<void> {
  if (shared.outboxDrainInFlight) return shared.outboxDrainInFlight;
  shared.outboxDrainInFlight = (async () => {
    if (!socket.connected) return;
    await hydrateCancelledOutboxFromDisk();
    let items = await loadMessageOutbox();
    if (!items.length) return;

    // Сохраняем порядок отправки, чтобы история чата после оффлайна выглядела ожидаемо.
    items.sort((a, b) => a.createdAt - b.createdAt);
    const keep: MessageOutboxItem[] = [];

    for (const item of items) {
      await hydrateCancelledOutboxFromDisk();
      if (isFingerprintCancelledSync(item.optimisticUiId, item.id)) {
        continue;
      }
      const freshList = await loadMessageOutbox();
      const row = freshList.find((x) => x.id === item.id);
      if (!row) {
        continue;
      }
      try {
        const resp = await emitAck<{ ok: boolean; messageId?: string; delivered?: boolean }>(
          'message:send',
          row.payload,
        );
        if (resp?.ok === true && resp.messageId) {
          const serverMessageId = String(resp.messageId);
          const oldIds = [row.id, row.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean);
          await remapEditOutboxMessageIds(oldIds, serverMessageId);
          dispatchOutboxMessageDelivered({
            to: String(row.payload?.to || ''),
            outboxId: row.id,
            optimisticUiId: row.optimisticUiId,
            serverMessageId,
          });
        } else if (!resp?.ok) {
          keep.push(row);
        }
      } catch (e) {
        if (isLikelyOfflineError(e)) {
          keep.push(row);
          // Если сеть снова упала — прерываем drain, остальные остаются в очереди.
          keep.push(...items.slice(items.indexOf(item) + 1));
          break;
        }
        keep.push(row);
      }
    }

    await saveMessageOutbox(keep);
  })().finally(() => {
    shared.outboxDrainInFlight = null;
  });
  return shared.outboxDrainInFlight;
}
