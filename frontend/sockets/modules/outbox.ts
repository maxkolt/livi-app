// frontend/sockets/modules/outbox.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logger } from "../../utils/logger";
import { shared } from "./shared";
import { socket } from "./socketCore";
import { emitAck } from "./emit";
import { postApiJson } from "./apiHttp";
import { ensureReauthBeforePrivilegedSocketOp } from "./reauth";
import {
  E2eUnavailableError,
  invalidateKeysAfterMismatch,
  toWireEditPayload,
  toWireMessagePayload,
} from "./e2e";

/** Повтор, когда ключи шифрования временно недоступны. */
const E2E_RETRY_AFTER_SEC = 5;
/** Ack одной попытки по сокету. Дольше не ждём: зависший под VPN сокет обходим по HTTP. */
const SEND_ACK_TIMEOUT_MS = 8000;
const SEND_HTTP_TIMEOUT_MS = 12000;
/** Пауза перед повтором, пока сеть не отвечает: растёт, чтобы без связи не жечь батарею. */
const NETWORK_RETRY_DELAYS_SEC = [2, 4, 8, 15, 30];
/** Временные отказы сервера подряд, после которых сообщение помечаем «не отправлено». */
const MAX_SERVER_REJECTS = 8;
/** Отказы, которые повтор не исправит. */
const PERMANENT_SEND_ERRORS = new Set([
  'not_friends',
  'invalid_to',
  'invalid_type',
  'text_too_long',
  'invalid_uri',
  'invalid_enc',
  'message_id_conflict',
]);
const PERMANENT_EDIT_ERRORS = new Set(['not_found_or_forbidden', 'bad_request', 'text_too_long', 'invalid_enc']);
import type {
  EditOutboxItem,
  MessageOutboxItem,
  OutboxMessageDeliveredPayload,
  OutboxMessageFailedPayload,
} from "./outboxTypes";

export type {
  EditOutboxItem,
  MessageOutboxItem,
  OutboxMessageDeliveredPayload,
  OutboxMessageFailedPayload,
} from "./outboxTypes";

const MESSAGE_OUTBOX_KEY = 'chat_message_outbox_v1';
const MESSAGE_EDIT_OUTBOX_KEY = 'chat_message_edit_outbox_v1';
/** fingerprint: optimisticUiId / outbox_* — пользователь удалил до отправки; блокируем поздний enqueue и drain. */
const MESSAGE_OUTBOX_CANCELLED_IDS_KEY = 'chat_message_outbox_cancelled_ids_v1';

// Очереди — read-modify-write одного ключа AsyncStorage. Без сериализации drain сохранял
// свой снимок и затирал сообщения, поставленные в очередь, пока он отправлял предыдущие.
function makeLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
}
const withMessageOutboxLock = makeLock();
const withEditOutboxLock = makeLock();
const withStatusesLock = makeLock();

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

/**
 * Сервер отказал по rate-limit (socket `rate_limited` или HTTP 429 — его sendMessage
 * отдаёт строкой `http_429:<body>`). Возвращает, через сколько секунд повторить, иначе null.
 */
export function readRateLimitRetryAfterSec(resp: unknown): number | null {
  const r = resp as any;
  const error = String(r?.error || '');
  let retryAfter: unknown;
  if (error === 'rate_limited') {
    retryAfter = r?.retryAfterSec;
  } else if (error.startsWith('http_429')) {
    try {
      retryAfter = JSON.parse(error.slice(error.indexOf(':') + 1))?.retryAfterSec;
    } catch {}
  } else {
    return null;
  }
  const sec = Number(retryAfter);
  return Number.isFinite(sec) && sec > 0 ? Math.min(sec, 600) : 5;
}

/** Код отказа: у сокета `error`, у HTTP — `error` из тела `http_<status>:<json>`. */
export function readApiErrorCode(resp: unknown): string {
  const error = String((resp as any)?.error || '');
  const m = /^http_\d+:([\s\S]*)$/.exec(error);
  if (!m) return error;
  try {
    return String(JSON.parse(m[1])?.error || error);
  } catch {
    return error;
  }
}

/* ========= Что сейчас в очереди (синхронно — для статуса «часы» в чате) ========= */

const queuedUiIds = new Set<string>();
/** Помечены до записи в хранилище, чтобы пузырь не мигнул галочкой между кадрами. */
const markedUiIds = new Set<string>();
const pendingSubs = new Set<() => void>();
let pendingMirrorHydrated = false;

function notifyPendingChange(): void {
  for (const cb of [...pendingSubs]) {
    try {
      cb();
    } catch {}
  }
}

function setQueuedMirror(items: MessageOutboxItem[]): void {
  pendingMirrorHydrated = true;
  const next = new Set<string>();
  for (const item of items) {
    if (item.id) next.add(item.id);
    if (item.optimisticUiId) next.add(String(item.optimisticUiId));
  }
  let changed = next.size !== queuedUiIds.size;
  if (!changed) {
    for (const id of next) {
      if (!queuedUiIds.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;
  queuedUiIds.clear();
  for (const id of next) queuedUiIds.add(id);
  notifyPendingChange();
}

/** Сообщение (по id в UI или outbox_*) ещё не принято сервером. */
export function isMessagePendingInOutbox(messageId: string): boolean {
  const id = String(messageId || '').trim();
  return !!id && (queuedUiIds.has(id) || markedUiIds.has(id));
}

export function markMessagePendingInOutbox(messageId: string, pending: boolean): void {
  const id = String(messageId || '').trim();
  if (!id) return;
  if (pending === markedUiIds.has(id)) return;
  if (pending) markedUiIds.add(id);
  else markedUiIds.delete(id);
  notifyPendingChange();
}

/** Состав очереди изменился. Первая подписка подтягивает очередь с диска (после перезапуска). */
export function onOutboxPendingChange(cb: () => void): () => void {
  pendingSubs.add(cb);
  if (!pendingMirrorHydrated) {
    void withMessageOutboxLock(() => loadMessageOutbox()).catch(() => {});
  }
  return () => {
    pendingSubs.delete(cb);
  };
}

/* ========= Исход отправки — для того, кто ждёт конкретное сообщение ========= */

export type OutboxOutcome =
  | { kind: 'delivered'; messageId: string; delivered: boolean; timestamp?: unknown }
  | { kind: 'failed'; error: string }
  | { kind: 'cancelled' };

const outcomeWaiters = new Map<string, (o: OutboxOutcome | null) => void>();

/** Ждать исход по outbox id не дольше timeoutMs; null — ещё в очереди. */
export function waitForOutboxOutcome(
  outboxId: string,
  timeoutMs: number,
): { promise: Promise<OutboxOutcome | null>; cancel: () => void } {
  let settle: (o: OutboxOutcome | null) => void = () => {};
  const promise = new Promise<OutboxOutcome | null>((resolve) => {
    const timer = setTimeout(() => settle(null), timeoutMs);
    settle = (o) => {
      clearTimeout(timer);
      if (outcomeWaiters.get(outboxId) === settle) outcomeWaiters.delete(outboxId);
      resolve(o);
    };
    outcomeWaiters.set(outboxId, settle);
  });
  return { promise, cancel: () => settle(null) };
}

function settleOutboxOutcome(outboxId: string, outcome: OutboxOutcome): void {
  outcomeWaiters.get(outboxId)?.(outcome);
}

/* ========= Хранилище очереди сообщений ========= */

let messageOutboxRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Повторить drain позже. Держим один таймер — берём более ранний срок. */
export function scheduleMessageOutboxDrain(delaySec: number): void {
  const delayMs = Math.max(1, delaySec) * 1000;
  const dueAt = Date.now() + delayMs;
  if (messageOutboxRetryTimer && (messageOutboxRetryTimer as any).__dueAt <= dueAt) return;
  if (messageOutboxRetryTimer) clearTimeout(messageOutboxRetryTimer);
  const timer = setTimeout(() => {
    if (messageOutboxRetryTimer === timer) messageOutboxRetryTimer = null;
    void drainMessageOutbox().catch(() => {});
  }, delayMs);
  (timer as any).__dueAt = dueAt;
  messageOutboxRetryTimer = timer;
}

let networkRetryStep = 0;

function scheduleNetworkRetry(): void {
  const sec = NETWORK_RETRY_DELAYS_SEC[Math.min(networkRetryStep, NETWORK_RETRY_DELAYS_SEC.length - 1)];
  networkRetryStep += 1;
  scheduleMessageOutboxDrain(sec);
}

async function loadMessageOutbox(): Promise<MessageOutboxItem[]> {
  try {
    const raw = await AsyncStorage.getItem(MESSAGE_OUTBOX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const items = list
      .map((item: any) => ({
        id: String(item?.id || ''),
        optimisticUiId: item?.optimisticUiId ? String(item.optimisticUiId) : undefined,
        createdAt: Number(item?.createdAt || Date.now()),
        ...(Number(item?.attempts) > 0 ? { attempts: Number(item.attempts) } : {}),
        payload: item?.payload || {},
      }))
      .filter((item: MessageOutboxItem) => !!item.id && !!item.payload?.to);
    setQueuedMirror(items);
    return items;
  } catch {
    return [];
  }
}

async function saveMessageOutbox(items: MessageOutboxItem[]): Promise<void> {
  try {
    if (!items.length) {
      await AsyncStorage.removeItem(MESSAGE_OUTBOX_KEY);
    } else {
      await AsyncStorage.setItem(MESSAGE_OUTBOX_KEY, JSON.stringify(items));
    }
    setQueuedMirror(items);
  } catch {}
}

function removeMessageOutboxRow(rowId: string): Promise<void> {
  return withMessageOutboxLock(async () => {
    const items = await loadMessageOutbox();
    const next = items.filter((x) => x.id !== rowId);
    if (next.length !== items.length) await saveMessageOutbox(next);
  });
}

/** @returns false если отправку отменили (удалили сообщение) — не ставить снова в очередь. */
export async function enqueueMessageOutbox(item: MessageOutboxItem): Promise<boolean> {
  await hydrateCancelledOutboxFromDisk();
  const oid = String(item.optimisticUiId || '').trim();
  const rid = String(item.id || '').trim();
  if (isFingerprintCancelledSync(oid, rid)) {
    return false;
  }
  return withMessageOutboxLock(async () => {
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
  });
}

/** Убрать из офлайн-очереди отправки по id outbox_* или по прежнему optimistic id из UI. */
export async function removeQueuedMessagesMatching(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(
    (rawIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (ids.size === 0) return;
  const removed = await withMessageOutboxLock(async () => {
    const items = await loadMessageOutbox();
    const matches = (item: MessageOutboxItem) =>
      ids.has(item.id) || !!(item.optimisticUiId && ids.has(String(item.optimisticUiId)));
    const hit = items.filter(matches);
    const fingerprints = new Set<string>(ids);
    for (const r of hit) {
      fingerprints.add(r.id);
      if (r.optimisticUiId) fingerprints.add(String(r.optimisticUiId));
    }
    await persistCancelledOutboxIdsMerge(fingerprints);
    if (hit.length) await saveMessageOutbox(items.filter((item) => !matches(item)));
    return hit;
  });
  for (const id of ids) markMessagePendingInOutbox(id, false);
  for (const r of removed) settleOutboxOutcome(r.id, { kind: 'cancelled' });
}

/* ========= Очередь правок ========= */

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
        ...(item?.to ? { to: String(item.to) } : {}),
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

export function enqueueEditOutbox(item: EditOutboxItem): Promise<void> {
  return withEditOutboxLock(async () => {
    let items = await loadEditOutbox();
    items = items.filter((x) => x.messageId !== item.messageId);
    items.push(item);
    await saveEditOutbox(items);
  });
}

/**
 * Если сообщение ещё в очереди message outbox (офлайн / не успело уйти),
 * правка текста должна менять payload очереди — а не message:edit с id outbox_* / optimistic,
 * иначе сервер сохранит старый текст и quietSync даст дубликат с другим текстом.
 */
export async function mergePendingMessageOutboxEdit(messageId: string, text: string): Promise<boolean> {
  const mid = String(messageId || '').trim();
  if (!mid) return false;
  const item = await withMessageOutboxLock(async () => {
    const items = await loadMessageOutbox();
    const idx = items.findIndex(
      (x) => x.id === mid || (!!x.optimisticUiId && String(x.optimisticUiId) === mid),
    );
    if (idx < 0) return null;
    const found = items[idx];
    items[idx] = {
      ...found,
      payload: { ...found.payload, text: String(text ?? '') },
    };
    await saveMessageOutbox(items);
    return found;
  });
  if (!item) return false;
  const rid = [mid, item.id, item.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean);
  await removeQueuedEditsMatching(rid);
  return true;
}

function remapEditOutboxMessageIds(oldIds: readonly string[], newId: string): Promise<void> {
  const nid = String(newId || '').trim();
  const olds = new Set(
    (oldIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (!nid || !olds.size) return Promise.resolve();
  return withEditOutboxLock(async () => {
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
  });
}

/* ========= События для открытого чата ========= */

const outboxMessageFailedSubs = new Set<(p: OutboxMessageFailedPayload) => void>();

function dispatchOutboxMessageDelivered(p: OutboxMessageDeliveredPayload): void {
  // Обходим снимок: подписчик вызывает setState, синхронный рендер переподписывает эффект,
  // а живой Set отдал бы и нового подписчика — и так по кругу, пока JS не встанет.
  for (const cb of [...shared.outboxMessageDeliveredSubs]) {
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

/** Сервер окончательно отказал — пузырь «не отправлено» с кнопкой повтора. */
export function onOutboxMessageFailed(cb: (p: OutboxMessageFailedPayload) => void): () => void {
  outboxMessageFailedSubs.add(cb);
  return () => {
    outboxMessageFailedSubs.delete(cb);
  };
}

/** Ключ как getChatStatusesKey в screens/chat/chatStorageKeys.ts. */
function chatStatusesKey(userId: string, peerId: string): string {
  const [a, b] = [userId, peerId].sort();
  return `chat_statuses_${a}_${b}`;
}

const STATUS_RANK: Record<string, number> = { failed: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/**
 * Статус пишем и в хранилище чата: если чат закрыт, пока очередь отправляла,
 * при открытии он иначе показал бы «часы» у давно доставленного сообщения.
 */
function persistOutgoingStatus(
  peerId: string,
  messageId: string,
  status: 'sent' | 'delivered' | 'failed',
  staleIds: readonly string[] = [],
): Promise<void> {
  const me = String(shared.currentUserId || '').trim();
  const pid = String(peerId || '').trim();
  if (!me || !pid || !messageId) return Promise.resolve();
  return withStatusesLock(async () => {
    try {
      const key = chatStatusesKey(me, pid);
      const raw = await AsyncStorage.getItem(key);
      const statuses: Record<string, string> = raw ? JSON.parse(raw) || {} : {};
      const cur = statuses[messageId];
      const upgrade =
        status === 'failed'
          ? !cur || cur === 'sending'
          : !cur || cur === 'failed' || (STATUS_RANK[cur] ?? 0) < STATUS_RANK[status];
      let changed = false;
      if (upgrade) {
        statuses[messageId] = status;
        changed = true;
      }
      for (const id of staleIds) {
        if (id && id !== messageId && id in statuses) {
          delete statuses[id];
          changed = true;
        }
      }
      if (changed) await AsyncStorage.setItem(key, JSON.stringify(statuses));
    } catch {}
  });
}

/* ========= Отправка: сокет, при его молчании — HTTP ========= */

type SendAttempt = { kind: 'resp'; resp: any; useSocket: boolean } | { kind: 'network'; useSocket: boolean };

async function socketReadyForSend(): Promise<boolean> {
  if (!socket.connected || shared.reconnecting) return false;
  // Гонка: connect уже сработал, а reauth на бэкенде ещё нет — тогда событие отклонят.
  // Ждём reauth (дедуп с обработчиком connect), как это делает fetchFriends.
  try {
    return (await ensureReauthBeforePrivilegedSocketOp()) && socket.connected;
  } catch {
    return false;
  }
}

/** Одна попытка: сокет (если жив), иначе HTTP. Повтор безопасен — сервер дедупит по id. */
async function sendOnce(
  event: string,
  httpPath: string,
  payload: Record<string, unknown>,
  useSocket: boolean,
): Promise<SendAttempt> {
  if (useSocket) {
    try {
      const resp = await emitAck(event, payload, SEND_ACK_TIMEOUT_MS, 0);
      if (resp?.error !== 'unauthorized') return { kind: 'resp', resp, useSocket: true };
    } catch {}
    // Сокет не ответил (VPN держит «connected», а пакеты не ходят) — до конца прохода шлём по HTTP.
    useSocket = false;
  }
  try {
    const resp = await postApiJson(httpPath, payload, SEND_HTTP_TIMEOUT_MS);
    return { kind: 'resp', resp, useSocket };
  } catch {
    return { kind: 'network', useSocket };
  }
}

/* ========= Drain очереди сообщений ========= */

let drainAgainRequested = false;

async function onRowDelivered(row: MessageOutboxItem, resp: any): Promise<void> {
  const to = String(row.payload?.to || '');
  const serverMessageId = String(resp?.messageId || row.payload?.clientMessageId || row.id);
  const delivered = resp?.delivered === true;
  const oldIds = [row.id, row.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean);
  await removeMessageOutboxRow(row.id);
  await remapEditOutboxMessageIds(oldIds, serverMessageId);
  void persistOutgoingStatus(to, serverMessageId, delivered ? 'delivered' : 'sent', oldIds);
  dispatchOutboxMessageDelivered({
    to,
    outboxId: row.id,
    optimisticUiId: row.optimisticUiId,
    serverMessageId,
    delivered,
  });
  settleOutboxOutcome(row.id, {
    kind: 'delivered',
    messageId: serverMessageId,
    delivered,
    timestamp: resp?.timestamp,
  });
}

async function onRowFailed(row: MessageOutboxItem, error: string): Promise<void> {
  const to = String(row.payload?.to || '');
  const uiId = String(row.optimisticUiId || row.id);
  logger.warn('[outbox] message rejected for good', { error, outboxId: row.id });
  await removeMessageOutboxRow(row.id);
  void persistOutgoingStatus(to, uiId, 'failed');
  const p: OutboxMessageFailedPayload = { to, outboxId: row.id, optimisticUiId: row.optimisticUiId, error };
  for (const cb of [...outboxMessageFailedSubs]) {
    try {
      cb(p);
    } catch {}
  }
  settleOutboxOutcome(row.id, { kind: 'failed', error });
}

/** Временный отказ сервера: считаем попытки, чтобы одно «битое» сообщение не держало очередь вечно. */
async function noteServerReject(row: MessageOutboxItem, error: string): Promise<'retry' | 'gave_up'> {
  const attempts = (row.attempts || 0) + 1;
  if (attempts >= MAX_SERVER_REJECTS) {
    await onRowFailed(row, error || 'server_error');
    return 'gave_up';
  }
  await withMessageOutboxLock(async () => {
    const items = await loadMessageOutbox();
    const idx = items.findIndex((x) => x.id === row.id);
    if (idx < 0) return;
    items[idx] = { ...items[idx], attempts };
    await saveMessageOutbox(items);
  });
  return 'retry';
}

/**
 * Один проход по очереди. Порядок держим внутри чата: застрявший чат (ключи, отказ сервера)
 * не держит остальные — 'partial'. Сеть и rate-limit общие: на них 'stopped' до таймера.
 */
async function drainMessageOutboxPass(): Promise<'done' | 'partial' | 'stopped'> {
  await hydrateCancelledOutboxFromDisk();
  const items = await withMessageOutboxLock(() => loadMessageOutbox());
  if (!items.length) return 'done';

  // Сохраняем порядок отправки, чтобы история чата после оффлайна выглядела ожидаемо.
  items.sort((a, b) => a.createdAt - b.createdAt);
  let useSocket = await socketReadyForSend();
  const blockedPeers = new Set<string>();
  let retryLater = false;

  for (const item of items) {
    const peer = String(item.payload?.to || '');
    if (blockedPeers.has(peer)) continue;
    if (isFingerprintCancelledSync(item.optimisticUiId, item.id)) {
      await removeMessageOutboxRow(item.id);
      settleOutboxOutcome(item.id, { kind: 'cancelled' });
      continue;
    }
    // Свежая строка: пока шли предыдущие, сообщение могли удалить или отредактировать.
    const row = (await withMessageOutboxLock(() => loadMessageOutbox())).find((x) => x.id === item.id);
    if (!row) continue;

    let wire: Record<string, unknown>;
    try {
      wire = await toWireMessagePayload(row.payload);
    } catch (e) {
      if (!(e instanceof E2eUnavailableError)) throw e;
      // Открытым текстом не шлём. locked ждёт восстановления ключа (оно само запустит drain).
      if (e.reason === 'unavailable') scheduleMessageOutboxDrain(E2E_RETRY_AFTER_SEC);
      blockedPeers.add(peer);
      continue;
    }

    const attempt = await sendOnce('message:send', '/api/messages/send', wire, useSocket);
    useSocket = attempt.useSocket;
    if (attempt.kind === 'network') {
      scheduleNetworkRetry();
      return 'stopped';
    }
    const resp = attempt.resp;
    if (resp?.ok === true) {
      networkRetryStep = 0;
      await onRowDelivered(row, resp);
      continue;
    }
    const code = readApiErrorCode(resp);
    if (code === 'e2e_key_mismatch') {
      await invalidateKeysAfterMismatch(peer);
      scheduleMessageOutboxDrain(1);
      blockedPeers.add(peer);
      continue;
    }
    const retryAfterSec = readRateLimitRetryAfterSec(resp);
    if (retryAfterSec != null) {
      // Остаток пачки тоже упрётся в лимит — останавливаемся и повторяем по таймеру,
      // а не ждём следующего connect.
      scheduleMessageOutboxDrain(retryAfterSec);
      return 'stopped';
    }
    if (PERMANENT_SEND_ERRORS.has(code)) {
      await onRowFailed(row, code);
      continue;
    }
    // Сервер перезапускается / БД не ответила: повторим позже, не нарушая порядок в этом чате.
    if ((await noteServerReject(row, code)) === 'gave_up') continue;
    blockedPeers.add(peer);
    retryLater = true;
  }
  if (retryLater) scheduleNetworkRetry();
  return blockedPeers.size ? 'partial' : 'done';
}

export async function drainMessageOutbox(): Promise<void> {
  if (shared.outboxDrainInFlight) {
    // Сообщение поставили в очередь, пока идёт проход, — он его не видит: пройдём ещё раз.
    drainAgainRequested = true;
    return shared.outboxDrainInFlight;
  }
  shared.outboxDrainInFlight = (async () => {
    let end: 'done' | 'partial' | 'stopped';
    do {
      drainAgainRequested = false;
      end = await drainMessageOutboxPass();
    } while (drainAgainRequested && end !== 'stopped');
  })().finally(() => {
    shared.outboxDrainInFlight = null;
  });
  return shared.outboxDrainInFlight;
}

/* ========= Drain очереди правок ========= */

/** Удалить из офлайн-очереди правок (например при удалении сообщения). */
export function removeQueuedEditsMatching(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(
    (rawIds || []).map((x) => String(x || '').trim()).filter(Boolean),
  );
  if (ids.size === 0) return Promise.resolve();
  return withEditOutboxLock(async () => {
    const items = await loadEditOutbox();
    const next = items.filter((x) => !ids.has(x.messageId));
    if (next.length === items.length) return;
    await saveEditOutbox(next);
  });
}

function removeEditOutboxRows(doneIds: ReadonlySet<string>): Promise<void> {
  if (!doneIds.size) return Promise.resolve();
  return withEditOutboxLock(async () => {
    const items = await loadEditOutbox();
    const next = items.filter((x) => !doneIds.has(x.id));
    if (next.length !== items.length) await saveEditOutbox(next);
  });
}

export async function drainEditOutbox(): Promise<void> {
  if (shared.editOutboxDrainInFlight) return shared.editOutboxDrainInFlight;
  shared.editOutboxDrainInFlight = (async () => {
    const items = await withEditOutboxLock(() => loadEditOutbox());
    if (!items.length) return;
    let useSocket = await socketReadyForSend();

    items.sort((a, b) => a.createdAt - b.createdAt);
    // Убираем по id ушедших, а не сохраняем снимок: правку, сделанную во время прохода, не теряем.
    const done = new Set<string>();

    for (const item of items) {
      // Правка сообщения, которое само ещё в очереди, ждёт его отправки (remap id после доставки).
      if (isMessagePendingInOutbox(item.messageId)) continue;
      let wire: Record<string, unknown>;
      try {
        wire = await toWireEditPayload(item.messageId, item.text, item.to);
      } catch (e) {
        // Правка зашифрованного чата не уходит открытым текстом — ждёт ключей.
        if (e instanceof E2eUnavailableError) break;
        continue;
      }
      const attempt = await sendOnce('message:edit', '/api/messages/edit', wire, useSocket);
      useSocket = attempt.useSocket;
      if (attempt.kind === 'network') break;
      const resp = attempt.resp;
      const code = readApiErrorCode(resp);
      if (code === 'e2e_key_mismatch' && item.to) {
        await invalidateKeysAfterMismatch(item.to);
      }
      if (resp?.ok || PERMANENT_EDIT_ERRORS.has(code)) done.add(item.id);
    }

    await removeEditOutboxRows(done);
  })().finally(() => {
    shared.editOutboxDrainInFlight = null;
  });
  return shared.editOutboxDrainInFlight;
}
