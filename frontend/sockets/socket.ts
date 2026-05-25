// frontend/sockets/socket.ts
import { io, Socket } from "socket.io-client";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logger } from '../utils/logger';

// Глобальное хранение сообщений
export const globalMessageStorage = {
  // Функция для получения ключа чата
  getChatKey: (userId1: string, userId2: string) => {
    const sortedIds = [userId1, userId2].sort();
    return `chat_messages_${sortedIds[0]}_${sortedIds[1]}`;
  },
  
  // Сохранение сообщения в AsyncStorage
  saveMessage: async (message: any, currentUserId: string) => {
    try {
      const chatKey = globalMessageStorage.getChatKey(currentUserId, message.from);
      const existingMessages = await AsyncStorage.getItem(chatKey);
      const messages = existingMessages ? JSON.parse(existingMessages) : [];

      const replyToPayload =
        message.replyTo && message.replyTo.id
          ? {
              id: String(message.replyTo.id),
              text: message.replyTo.text,
              from: String(message.replyTo.from || ''),
              isOwn: String(message.replyTo.from || '') === String(currentUserId),
            }
          : null;

      const existingIdx = messages.findIndex((m: any) => m.id === message.id);
      let didWrite = false;
      if (existingIdx < 0) {
        const newMessage: any = {
          id: message.id,
          text: message.text,
          type: message.type,
          uri: message.uri,
          name: message.name,
          size: message.size,
          duration: message.duration,
          stickerId: message.stickerId,
          stickerPackId: message.stickerPackId,
          stickerEmoji: message.stickerEmoji,
          stickerLabel: message.stickerLabel,
          sender: 'peer',
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
        };
        if (replyToPayload) newMessage.replyTo = replyToPayload;
        messages.push(newMessage);
        didWrite = true;
      } else if (replyToPayload && !messages[existingIdx]?.replyTo?.id) {
        messages[existingIdx] = { ...messages[existingIdx], replyTo: replyToPayload };
        didWrite = true;
      }
      if (didWrite) {
        await AsyncStorage.setItem(chatKey, JSON.stringify(messages));
      }
    } catch (error) {
      logger.warn('Failed to save message globally:', error);
    }
  }
};
// Dev-only: avoid log spam for typing events
const __devTypingLogState = new Map<string, boolean>();
import { NativeModules, Platform } from "react-native";
import { AppState, type AppStateStatus } from "react-native";
import { getInstallId } from "../utils/installId";
import { emitMissedFetchedFromServer } from '../utils/globalEvents';

const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
const MESSAGE_OUTBOX_KEY = 'chat_message_outbox_v1';
const MESSAGE_EDIT_OUTBOX_KEY = 'chat_message_edit_outbox_v1';
/** fingerprint: optimisticUiId / outbox_* — пользователь удалил до отправки; блокируем поздний enqueue и drain. */
const MESSAGE_OUTBOX_CANCELLED_IDS_KEY = 'chat_message_outbox_cancelled_ids_v1';

type MessageOutboxItem = {
  id: string;
  /** Совпадает с id сообщения в UI до замены на outbox_/msg_* (чтобы удалить из очереди при отмене до ack). */
  optimisticUiId?: string;
  createdAt: number;
  payload: {
    to: string;
    text?: string;
    type: 'text' | 'image' | 'audio' | 'sticker';
    uri?: string;
    name?: string;
    size?: number;
    duration?: number;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    replyTo?: { id: string; text?: string; from: string };
    clientMessageId?: string;
    clientId?: string;
  };
};

type EditOutboxItem = {
  id: string;
  messageId: string;
  text: string;
  createdAt: number;
};

let outboxDrainInFlight: Promise<void> | null = null;
let editOutboxDrainInFlight: Promise<void> | null = null;

const cancelledOutboxSendIds = new Set<string>();
let cancelledOutboxDiskHydrated = false;

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
  if (cancelledOutboxDiskHydrated) return;
  cancelledOutboxDiskHydrated = true;
  const disk = await loadCancelledOutboxIdsDisk();
  for (const id of disk) cancelledOutboxSendIds.add(id);
}

async function persistCancelledOutboxIdsMerge(ids: Iterable<string>): Promise<void> {
  const add = [...new Set([...ids].map((x) => String(x || '').trim()).filter(Boolean))];
  if (!add.length) return;
  for (const id of add) cancelledOutboxSendIds.add(id);
  try {
    const merged = new Set([...(await loadCancelledOutboxIdsDisk()), ...cancelledOutboxSendIds]);
    const capped = [...merged].slice(-500);
    await AsyncStorage.setItem(MESSAGE_OUTBOX_CANCELLED_IDS_KEY, JSON.stringify(capped));
  } catch {}
}

function isFingerprintCancelledSync(optimisticUiId?: string, rowId?: string): boolean {
  const oid = String(optimisticUiId || '').trim();
  const rid = String(rowId || '').trim();
  if (rid && cancelledOutboxSendIds.has(rid)) return true;
  if (oid && cancelledOutboxSendIds.has(oid)) return true;
  return false;
}

export function clearCancelledOutboxFingerprints(): void {
  cancelledOutboxSendIds.clear();
  cancelledOutboxDiskHydrated = false;
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
async function enqueueMessageOutbox(item: MessageOutboxItem): Promise<boolean> {
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

async function enqueueEditOutbox(item: EditOutboxItem): Promise<void> {
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
async function mergePendingMessageOutboxEdit(messageId: string, text: string): Promise<boolean> {
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

export type OutboxMessageDeliveredPayload = {
  to: string;
  outboxId: string;
  optimisticUiId?: string;
  serverMessageId: string;
};

const outboxMessageDeliveredSubs = new Set<(p: OutboxMessageDeliveredPayload) => void>();

function dispatchOutboxMessageDelivered(p: OutboxMessageDeliveredPayload): void {
  for (const cb of outboxMessageDeliveredSubs) {
    try {
      cb(p);
    } catch {}
  }
}

/** После flush outbox: локальный id → серверный msg_*, плюс remap очереди правок. */
export function onOutboxMessageDelivered(cb: (p: OutboxMessageDeliveredPayload) => void): () => void {
  outboxMessageDeliveredSubs.add(cb);
  return () => {
    outboxMessageDeliveredSubs.delete(cb);
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

async function drainEditOutbox(): Promise<void> {
  if (editOutboxDrainInFlight) return editOutboxDrainInFlight;
  editOutboxDrainInFlight = (async () => {
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
    editOutboxDrainInFlight = null;
  });
  return editOutboxDrainInFlight;
}

async function drainMessageOutbox(): Promise<void> {
  if (outboxDrainInFlight) return outboxDrainInFlight;
  outboxDrainInFlight = (async () => {
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
    outboxDrainInFlight = null;
  });
  return outboxDrainInFlight;
}

/** Uids, для которых мы только что применили пропущенные из reauth (missed_calls:sync). Нужно не дублировать при getAndClearPendingMissedCalls. */
const appliedFromReauthByUid = new Map<string, number>();
const APPLIED_FROM_REAUTH_EXPIRY_MS = 30_000;

/** Uids, для которых мы только что применили пропущенные из pending (FCM). Чтобы applyMissedFromReauth не дублировал. */
const appliedFromPendingByUid = new Map<string, number>();
const APPLIED_FROM_PENDING_EXPIRY_MS = 30_000;

/** Проверить, что uid недавно учтён в applyMissedFromReauth — чтобы при применении pending не инкрементировать повторно. */
export function wasAppliedFromReauth(uid: string): boolean {
  if (!uid) return false;
  const ts = appliedFromReauthByUid.get(uid);
  if (ts == null) return false;
  if (Date.now() - ts > APPLIED_FROM_REAUTH_EXPIRY_MS) {
    appliedFromReauthByUid.delete(uid);
    return false;
  }
  return true;
}

/** Записать, что uid только что учтён при применении pending (getAndClearPendingMissedCalls). */
export function recordAppliedFromPending(uid: string): void {
  if (!uid) return;
  appliedFromPendingByUid.set(uid, Date.now());
}

/** Проверить, что uid недавно учтён при применении pending — чтобы applyMissedFromReauth не инкрементировал повторно. */
function wasAppliedFromPending(uid: string): boolean {
  if (!uid) return false;
  const ts = appliedFromPendingByUid.get(uid);
  if (ts == null) return false;
  if (Date.now() - ts > APPLIED_FROM_PENDING_EXPIRY_MS) {
    appliedFromPendingByUid.delete(uid);
    return false;
  }
  return true;
}

/** Мержим пропущенные с сервера (после reauth) в AsyncStorage и уведомляем UI. */
async function applyMissedFromReauth(response: { missed?: { from: string; fromNick?: string }[] }) {
  const missed = response?.missed;
  if (!Array.isArray(missed) || missed.length === 0) return;
  try {
    const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    for (const m of missed) {
      const uid = String(m?.from || '').trim();
      if (uid) {
        if (wasAppliedFromPending(uid)) continue;
        map[uid] = (map[uid] || 0) + 1;
        appliedFromReauthByUid.set(uid, now);
      }
    }
    await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
    if (Platform.OS === 'android' && NativeModules.LiviAppModule?.removePendingMissedCall) {
      for (const m of missed) {
        const uid = String(m?.from || '').trim();
        if (uid) {
          try { NativeModules.LiviAppModule.removePendingMissedCall(uid); } catch (_) {}
        }
      }
    }
    emitMissedFetchedFromServer();
  } catch (e) {
    logger.warn('[applyMissedFromReauth] failed', e as any);
  }
}

/* ========= Server URL ========= */
// Получаем BASE_URL из переменных окружения
// Приоритет: платформо-специфичная переменная > общая переменная > fallback
// КРИТИЧНО: В production используйте домены с HTTPS, не IP адреса!
const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';

function isLocalOrPrivateApiHost(rawUrl: string): boolean {
  try {
    const normalized = String(rawUrl || '').trim();
    if (!normalized) return true;
    const u = new URL(normalized);
    const host = String(u.hostname || '').toLowerCase();
    if (!host) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.startsWith('10.')) return true;
    if (host.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

const RAW_API_BASE = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');
const ALLOW_PRIVATE_API_IN_RELEASE = String(process.env.EXPO_PUBLIC_ALLOW_PRIVATE_API_IN_RELEASE || '').trim() === '1';
const SAFE_PRODUCTION_API_BASE = 'https://api.liviapp.com';
const SHOULD_FORCE_SAFE_API_BASE =
  !__DEV__ &&
  !ALLOW_PRIVATE_API_IN_RELEASE &&
  isLocalOrPrivateApiHost(RAW_API_BASE);

export const API_BASE = SHOULD_FORCE_SAFE_API_BASE ? SAFE_PRODUCTION_API_BASE : RAW_API_BASE;

if (SHOULD_FORCE_SAFE_API_BASE) {
  logger.warn('[socket] Non-public API base in release build, forcing production API', {
    rawApiBase: RAW_API_BASE,
    forcedApiBase: API_BASE,
  });
}

/** Первый коннект / смена сети (VPN, DNS): согласовано с io({ timeout }). Пуши и accept/decline ждут столько же. */
export const SOCKET_CONNECT_WAIT_MS = 25000;

/** In-app call signaling (accept / initiate) after warmCallSignaling or while app is active. */
export const CALL_SIGNALING_CONNECT_MS = 8000;

if (__DEV__) {
  const lk = (process.env.EXPO_PUBLIC_LIVEKIT_URL || '').trim();
  logger.debug('[socket] API_BASE / LIVEKIT', { API_BASE, livekit: lk || '—' });
}

/* ========= helpers ========= */
const isOid = (s?: string) => !!s && /^[a-f\d]{24}$/i.test(s);

/* ========= auth state ========= */
let currentUserId: string | undefined;
let bootInProgress = false; // Защита от повторного вызова boot()
let createUserPromise: Promise<string | null> | null = null; // Трекер параллельных createUser
export type SocketReauthResponse = {
  ok: boolean;
  userId?: string;
  error?: string;
  missed?: { from: string; fromNick?: string }[];
};

let lastSuccessfulReauthAt = 0;
/** Единый in-flight для reauth: иначе при reconnect срабатывают и `connect`, и `io.reconnect` — два параллельных emit и Ack timeout. */
let reauthInFlight: Promise<SocketReauthResponse> | null = null;
const REAUTH_FRESH_MS = 6000;

// Notify UI when currentUserId changes (screens depend on it for profile/avatar).
type CurrentUserIdListener = (userId: string | undefined) => void;
const __currentUserIdListeners = new Set<CurrentUserIdListener>();
function __notifyCurrentUserId() {
  try {
    for (const cb of __currentUserIdListeners) {
      try { cb(currentUserId); } catch {}
    }
  } catch {}
}

// Subscribe to currentUserId changes (invoked immediately once).
export function onCurrentUserId(cb: CurrentUserIdListener): () => void {
  try { cb(currentUserId); } catch {}
  __currentUserIdListeners.add(cb);
  return () => {
    __currentUserIdListeners.delete(cb);
  };
}

/* ========= socket (singleton) ========= */
const SOCKET_RECONNECT_DELAY_MS = 1000;
const SOCKET_RECONNECT_DELAY_MAX_MS = 10000;
/** После server:restarting (деплой) — быстрее цепляемся к поднявшемуся инстансу. */
const SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MS = 200;
const SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MAX_MS = 5000;

let socketInstance: Socket | null = null;
let reconnecting = false;
let connectAttemptPromise: Promise<void> | null = null;
// Флаг: гарантировали ли мы, что handshake содержит installId (иначе сервер вернёт guest профиль {})
let __handshakeHasInstallId = false;
export const isReconnecting = () => reconnecting;
export const getSocket = (): Socket => {
  if (!socketInstance) {
    socketInstance = io(API_BASE, {
      path: "/socket.io",
      // IMPORTANT:
      // Many VPNs / captive portals / corporate networks block WebSocket.
      // Start with polling (more likely to pass), then upgrade to WebSocket when possible.
      transports: ["polling", "websocket"],
      // If first transport fails (e.g. VPN blocks polling), engine.io should try the next one.
      // This keeps behavior stable both with and without VPN.
      // @ts-ignore - available in newer engine.io, safe no-op on older versions.
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
      reconnectionAttempts: 25,
      reconnectionDelay: SOCKET_RECONNECT_DELAY_MS,
      reconnectionDelayMax: SOCKET_RECONNECT_DELAY_MAX_MS,
      // Connection attempt timeout. Heartbeat pingInterval/pingTimeout are negotiated in the Engine.IO handshake (server-side).
      timeout: 25000,
    });
  }
  return socketInstance;
};

export const socket: Socket = getSocket();

/** Дедуп повторных presence:update с одним и тем же status/roomId (useEffect в VideoCall/PiP и т.д.). Сброс при connect. */
let __lastPresenceUpdateKey: string | null = null;

function __presenceUpdateKey(payload: { status?: string; roomId?: string | undefined }): string {
  const st = String(payload?.status || '');
  const rid =
    payload?.roomId != null && String(payload.roomId).trim() !== ''
      ? String(payload.roomId).trim()
      : '';
  return `${st}\0${rid}`;
}

/**
 * Отправляет presence:update только если изменился статус или комната.
 * После reconnect передавайте `{ force: true }`, чтобы сервер снова получил busy.
 */
export function emitPresenceUpdateIfChanged(
  payload: { status: string; roomId?: string; idle?: boolean },
  opts?: { force?: boolean }
): void {
  const key = __presenceUpdateKey(payload);
  if (!opts?.force && key === __lastPresenceUpdateKey) return;
  __lastPresenceUpdateKey = key;
  const out: { status: string; roomId?: string; idle?: boolean } = { status: payload.status };
  const rid = payload.roomId != null ? String(payload.roomId).trim() : '';
  if (rid) out.roomId = rid;
  if (payload.idle === true) out.idle = true;
  try {
    socket.emit('presence:update', out);
  } catch {}
}

// Для первого подключения (VPN/медленный DNS) даём больший таймаут в waitForConnect
let __hasConnectedEver = false;

/** Единый debounce офлайн в списке друзей и шапке чата (см. HomeScreen / ChatScreen). */
export const PRESENCE_OFFLINE_DEBOUNCE_MS = 350;

/**
 * Сразу после connect пустой массив presence часто приходит при гонке reauth / комнаты — не затираем
 * последний непустой снимок (иначе мерцание «онлайн → офлайн → онлайн»).
 */
const PRESENCE_EMPTY_ONLINE_LIST_GRACE_MS = 5000;

/** Совпадает с серверным списком «видимых» онлайн (в т.ч. ушёл в фон → нет в списке). */
let __lastVisibleOnlineUserIds: Set<string> = new Set();
let __visibleOnlinePresenceListKnown = false;
let __lastSocketConnectAt = 0;

socket.on('connect', () => {
  __hasConnectedEver = true;
  __lastPresenceUpdateKey = null;
  __lastSocketConnectAt = Date.now();
  void drainMessageOutbox()
    .then(() => drainEditOutbox())
    .catch(() => {});
});

function ingestVisibleOnlinePresenceList(data: unknown) {
  if (!Array.isArray(data)) return;
  __visibleOnlinePresenceListKnown = true;
  const next = new Set<string>();
  for (const it of data) {
    if (it == null) continue;
    const id = String((it as any)?._id ?? it);
    if (id) next.add(id);
  }
  __lastVisibleOnlineUserIds = next;
}

const __presenceUpdateSubscribers = new Set<(data: any) => void>();

function __normalizePresenceUpdatePayload(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  if (
    raw.length === 0 &&
    __lastVisibleOnlineUserIds.size > 0 &&
    Date.now() - __lastSocketConnectAt < PRESENCE_EMPTY_ONLINE_LIST_GRACE_MS
  ) {
    const msSinceConnect = Date.now() - __lastSocketConnectAt;
    logger.debug('[socket] presence: skip empty online list during post-connect grace', {
      preservedCount: __lastVisibleOnlineUserIds.size,
      msSinceConnect,
    });
    return Array.from(__lastVisibleOnlineUserIds);
  }
  return raw;
}

function __dispatchPresenceUpdate(raw: unknown): void {
  const payload = __normalizePresenceUpdatePayload(raw);
  if (Array.isArray(payload)) {
    ingestVisibleOnlinePresenceList(payload);
  }
  for (const cb of __presenceUpdateSubscribers) {
    try {
      cb(payload);
    } catch (e) {
      logger.warn('[socket] onPresenceUpdate subscriber error', e as any);
    }
  }
}

socket.on('presence:update', __dispatchPresenceUpdate);
socket.on('presence_update', __dispatchPresenceUpdate);

/**
 * Был ли хотя бы один полный presence-массив с сервера (не путать с «ещё не приходил»).
 * Для шапки чата: при фокусе подставляем тот же статус, что и у списка друзей.
 */
export function hasVisibleOnlinePresenceSnapshot(): boolean {
  return __visibleOnlinePresenceListKnown;
}

export function isPeerInVisibleOnlinePresence(peerId: string): boolean {
  if (!peerId) return false;
  return __lastVisibleOnlineUserIds.has(String(peerId));
}

// При подключении сервер шлёт пропущенные звонки (телефон был выключен / нет сети) — мержим в хранилище и обновляем UI
socket.on('missed_calls:sync', (payload: { missed?: { from: string; fromNick?: string }[] }) => {
  applyMissedFromReauth(payload).catch(() => {});
});

/* ========= auth apply & connect ========= */
async function applyAuthAndConnect() {
  if (connectAttemptPromise) return connectAttemptPromise;

  connectAttemptPromise = (async () => {
    try {
      const installId = await getInstallId();
      // @ts-ignore
      socket.auth = { installId, ...(currentUserId ? { userId: currentUserId } : {}) };

      // Если realtime сейчас сознательно поставлен на паузу, не стартуем новый connect().
      // Иначе при фоне/блокировке экрана можно словить шумный xhr poll error от уже отмененного запроса.
      if (!shouldAttemptRealtimeConnection()) {
        logger.debug('[applyAuthAndConnect] Realtime paused, skip connect');
        return;
      }

      // Если уже подключены, но handshake был без installId (типичный кейс из-за autoConnect),
      // сервер будет считать нас гостем и profile:me вернёт {}. В этом случае делаем 1 reconnect.
      if (socket.connected) {
        if (!__handshakeHasInstallId && installId) {
          try {
            const resp = await emitAck<{ ok: boolean; userId?: string; error?: string }>(
              'reauth',
              { userId: currentUserId },
              6000,
              0
            );
            if (resp?.ok) {
              __handshakeHasInstallId = true;
              return;
            }
            if (resp?.error === 'no_installId') {
              logger.warn('[applyAuthAndConnect] Connected without installId in handshake, forcing reconnect');
              try { socket.disconnect(); } catch {}
              __handshakeHasInstallId = false;
              socket.connect();
            } else {
              // Если иная ошибка — не делаем агрессивный reconnect, чтобы не ломать релиз-стабильность.
              return;
            }
          } catch (e) {
            // Если ack завис/упал — мягко пробуем переподключиться один раз.
            try { socket.disconnect(); } catch {}
            __handshakeHasInstallId = false;
            socket.connect();
          }
        } else {
          return;
        }
      }

      if (!socket.connected) {
        logger.debug("Connecting socket...");
        // Socket.connect() не возвращает промис, поэтому используем события
        socket.connect();

        // Ждем подключения с таймаутом
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.off('connect_error', onError);
          };
          const timeout = setTimeout(() => {
            cleanup();
            if (!shouldAttemptRealtimeConnection()) {
              logger.debug('[applyAuthAndConnect] Connection timeout while realtime paused');
              resolve();
              return;
            }
            reject(new Error('Socket connection timeout'));
          }, SOCKET_CONNECT_WAIT_MS);

          const onConnect = () => {
            cleanup();
            logger.debug("Socket connected");
            resolve();
          };

          const onError = (err: any) => {
            cleanup();
            if (!shouldAttemptRealtimeConnection()) {
              logger.debug('[applyAuthAndConnect] Ignoring connect error while realtime paused:', err?.message || String(err));
              resolve();
              return;
            }
            logger.warn("Socket connect error:", err);
            reject(err);
          };

          if (socket.connected) {
            cleanup();
            resolve();
          } else {
            socket.once('connect', onConnect);
            socket.once('connect_error', onError);
          }
        });
        if (socket.connected && installId) __handshakeHasInstallId = true;
      } else {
        logger.debug("Socket already connected, skip reconnect");
      }
    } catch (error) {
      if (!shouldAttemptRealtimeConnection()) {
        logger.debug('[applyAuthAndConnect] Connection attempt stopped while realtime paused');
        return;
      }
      if (isExpectedSocketConnectError(error)) {
        // Оффлайн/временные сетевые сбои — ожидаемое состояние, не показываем как console.error в dev.
        logger.warn('[applyAuthAndConnect] Connection failed (non-critical network):', error);
      } else {
        logger.error('[applyAuthAndConnect] Connection failed:', error);
      }
      // Не выбрасываем ошибку - приложение должно продолжить работу
      // Socket переподключится автоматически
    } finally {
      connectAttemptPromise = null;
    }
  })();

  return connectAttemptPromise;
}

async function boot() {
  // Защита от повторного вызова
  if (bootInProgress) {
    logger.debug('Boot already in progress, skipping...');
    return;
  }
  
  bootInProgress = true;
  logger.debug('Starting boot process...');

  // Снимаем уведомление «Видеозвонок от...», если оно осталось от прошлого запуска (сервис не закрылся).
  if (Platform.OS === 'android') {
    try { NativeModules.LiviAppModule?.stopActiveCallForegroundService?.(); } catch (_) {}
  }
  
  try {
    const saved = await AsyncStorage.getItem("userId");
    if (saved && isOid(saved)) {
      logger.debug('Found saved userId:', saved);
      
      // Сначала устанавливаем userId и подключаемся
      currentUserId = saved;
      __notifyCurrentUserId();
      
      // Подключаемся к socket (и гарантируем installId в handshake)
      await applyAuthAndConnect();

      // ВАЖНО: гарантируем, что сервер "видит" userId (иначе profile:me вернёт гостевой профиль {})
      // Не пересоздаём пользователя на временных проблемах сети/авторизации — сначала пробуем reauth.
      try {
        if (socket.connected) {
          await emitReauthDeduped(saved, 6000, 1);
        }
      } catch (e) {
        // мягко игнорируем — может быть оффлайн, но userId локально сохраняем
        logger.warn('[boot] reauth failed (non-critical):', e);
      }
      
      // Проверяем профиль пользователя через getMyProfile
      // КРИТИЧНО: getMyProfile уже имеет таймаут 8 секунд
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok) {
          // profile === undefined → userId не найден в БД (реальный кейс "пользователь удалён/сломана база")
          // profile === {} допустимо (пустой ник/аватар) и НЕ должно приводить к созданию нового userId
          if (profileResponse.profile === undefined) {
            logger.info('Profile is missing for saved userId (user not found), creating new user...');
            await createUser();
            return;
          }

          const profile = profileResponse.profile;
          logger.debug('Loaded profile from backend:', { nick: profile?.nick });

          logger.debug('Using existing user with profile:', saved);
        } else {
          const err = String((profileResponse as any)?.error || '').toLowerCase();
          const isDefinitiveUserMissing =
            err === 'user_not_found' ||
            err.includes('user_not_found') ||
            err.startsWith('http_404');
          if (isDefinitiveUserMissing) {
            logger.info('Profile explicitly missing for saved userId, creating new user...');
            await createUser();
            return; // Выходим из функции boot
          }
          // ВАЖНО: оффлайн/таймаут/временный сбой НЕ должен приводить к пересозданию userId
          // и очистке локального профиля/кэшей друзей.
          logger.warn('[boot] Profile check failed (temporary), keep saved userId and local cache', {
            error: (profileResponse as any)?.error,
          });
        }
      } catch (e) {
        // ВАЖНО: при сетевых сбоях не пересоздаём пользователя.
        logger.warn('[boot] Profile check threw error, keep saved userId and local cache', e as any);
      }
    } else {
      // Нет сохраненного userId (удаление приложения или сброс аккаунта) - создаем нового
      logger.info('No saved userId, creating new user...');
      await createUser();
    }
  } catch (e) {
    logger.error('Boot error loading userId:', e);
    logger.info('Error occurred, creating new user...');
    await createUser();
  }
  
  // КРИТИЧНО: Подключаемся с актуальным currentUserId (только если не создавали нового пользователя)
  logger.debug('Final currentUserId:', currentUserId);
  if (!socket.connected) {
    await applyAuthAndConnect();
  } else if (currentUserId) {
    logger.debug('Socket connected, sending reauth with userId:', currentUserId);
    try {
      const reauthResponse = await emitReauthDeduped(currentUserId);
      if (reauthResponse?.ok) {
        logger.debug('Reauth successful');
      } else {
        logger.warn('Reauth failed:', reauthResponse?.error);
        if (reauthResponse?.error === 'user_not_found' || reauthResponse?.error === 'not_found') {
          await recoverFromReauthFailure(reauthResponse?.error);
        }
      }
    } catch (e) {
      logger.warn('Reauth error:', e);
    }
  }
  
  // Сбрасываем флаг завершения boot процесса
  bootInProgress = false;
  logger.debug('[boot] Boot process completed');
}

// КРИТИЧНО: Обертываем boot() в try-catch для предотвращения крашей
// Запускаем boot с задержкой, чтобы дать приложению время инициализироваться
setTimeout(() => {
  (async () => {
    try {
      await boot();
    } catch (error) {
      logger.error('[boot] Critical error during boot process:', error);
      // Не выбрасываем ошибку - приложение должно продолжить работу
      // Попробуем создать пользователя как fallback
      try {
        await createUser();
      } catch (createError) {
        logger.error('[boot] Failed to create user as fallback:', createError);
      }
    }
  })();
}, 100); // Небольшая задержка для инициализации модулей

/* ========= AppState -> presence ========= */
/**
 * Держать Socket.IO подключённым в фоне и не выключать reconnection при блокировке экрана.
 * Внимание: сильнее батарея; iOS всё равно может приостановить JS-процесс без спец. background modes;
 * Android при агрессивном Doze может рвать сеть — клиент переподключится при пробуждении.
 */
const SOCKET_KEEP_ALIVE_IN_BACKGROUND = true;

let __lastAppState: AppStateStatus = AppState.currentState;
let __realtimePaused = SOCKET_KEEP_ALIVE_IN_BACKGROUND ? false : __lastAppState !== 'active';
/** Пока на нативном экране исходящего (OutgoingCallActivity) — не отключать сокет при «background», чтобы инициатор получил call:accepted. */
let __outgoingCallScreenVisible = false;
/** Пока на нативном экране входящего (IncomingCallActivity) — не отключать сокет при «background», чтобы получатель мог принять/отклонить по сокету. */
let __incomingCallScreenVisible = false;
/** userId звонящего, пока показан нативный экран входящего (для UI: у этого друга кнопка в стиле «занято» без бейджа). */
let __incomingCallFromUserId: string | null = null;
const __incomingCallScreenChangeListeners = new Set<(visible: boolean, fromUserId: string | null) => void>();

/** Пока активен видеозвонок (подключение к LiveKit или комната connected) — не отключать сокет при «background», чтобы избежать negotiation disconnected / m-line errors. */
let __activeVideoCall = false;

function emitAppVisibilityToServer(foreground: boolean) {
  try {
    if (socket?.connected) socket.emit('app:visibility', { foreground });
  } catch {}
}

function shouldAttemptRealtimeConnection(): boolean {
  if (SOCKET_KEEP_ALIVE_IN_BACKGROUND) return true;
  const inSystemPiP =
    typeof (global as any).__pipInSystemModeRef?.current === 'boolean' &&
    (global as any).__pipInSystemModeRef?.current === true;
  return !__realtimePaused || __outgoingCallScreenVisible || __incomingCallScreenVisible || __activeVideoCall || inSystemPiP;
}

function isExpectedSocketConnectError(error: unknown): boolean {
  const msg = String((error as any)?.message || error || '').toLowerCase();
  return (
    msg.includes('websocket error') ||
    msg.includes('xhr poll error') ||
    msg.includes('network request failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

export function setOutgoingCallScreenVisible(visible: boolean): void {
  __outgoingCallScreenVisible = visible;
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !visible &&
    __lastAppState !== 'active' &&
    __lastAppState !== 'inactive'
  ) {
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function setIncomingCallScreenVisible(visible: boolean, fromUserId?: string | null): void {
  __incomingCallScreenVisible = visible;
  __incomingCallFromUserId = visible && fromUserId != null ? String(fromUserId) : null;
  __incomingCallScreenChangeListeners.forEach((cb) => {
    try { cb(__incomingCallScreenVisible, __incomingCallFromUserId); } catch {}
  });
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !visible &&
    __lastAppState !== 'active' &&
    __lastAppState !== 'inactive'
  ) {
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

export function getIncomingCallScreenState(): { visible: boolean; fromUserId: string | null } {
  return { visible: __incomingCallScreenVisible, fromUserId: __incomingCallFromUserId };
}

export function onIncomingCallScreenChange(cb: (visible: boolean, fromUserId: string | null) => void): () => void {
  __incomingCallScreenChangeListeners.add(cb);
  return () => { __incomingCallScreenChangeListeners.delete(cb); };
}

export function setActiveVideoCall(active: boolean, _partnerDisplayName?: string | null): void {
  __activeVideoCall = active;
  // При завершении звонка снимаем уведомление «Видеозвонок от...», если оно осталось от прошлого запуска.
  if (!active && Platform.OS === 'android') {
    try { NativeModules.LiviAppModule?.stopActiveCallForegroundService?.(); } catch (_) {}
  }
  if (
    !SOCKET_KEEP_ALIVE_IN_BACKGROUND &&
    !active &&
    __lastAppState !== 'active' &&
    __lastAppState !== 'inactive'
  ) {
    __realtimePaused = true;
    try { (socket as any).io.opts.reconnection = false; } catch {}
    if (socket?.connected) socket.disconnect();
  }
}

try {
  AppState.addEventListener('change', (nextState) => {
    try {
      // Treat 'inactive' as foreground to avoid disconnect/reconnect flicker while user is still in-app
      // (e.g. transient OS transitions). We only pause realtime when app actually goes to background.
      const wasForeground = __lastAppState === 'active' || __lastAppState === 'inactive';
      const isForeground = nextState === 'active' || nextState === 'inactive';
      __lastAppState = nextState;

      if (wasForeground && !isForeground) {
        emitAppVisibilityToServer(false);
        if (SOCKET_KEEP_ALIVE_IN_BACKGROUND) return;
        const inSystemPiP = typeof (global as any).__pipInSystemModeRef?.current === 'boolean' && (global as any).__pipInSystemModeRef?.current === true;
        if (__outgoingCallScreenVisible || __incomingCallScreenVisible || __activeVideoCall || inSystemPiP) return;
        __realtimePaused = true;
        try {
          try { (socket as any).io.opts.reconnection = false; } catch {}
          if (socket?.connected) socket.disconnect();
        } catch {}
        return;
      }

      if (!wasForeground && isForeground) {
        emitAppVisibilityToServer(true);
        if (!SOCKET_KEEP_ALIVE_IN_BACKGROUND) __realtimePaused = false;
        // Не сбрасываем __incomingCallScreenVisible / __outgoingCallScreenVisible / __activeVideoCall здесь:
        // нативные экраны звонка и видеозвонок могут оставаться активными при возврате из фона; сброс давал
        // ложный «офлайн», обрыв сокета во время входящего/исходящего и рассинхрон presence.
        try { (socket as any).io.opts.reconnection = true; } catch {}
        // applyAuthAndConnect already sets installId/userId and connects with timeouts.
        applyAuthAndConnect().catch(() => {});
      }
    } catch {}
  });
} catch {}

/* ========= logging ========= */
socket.on('server:restarting', () => {
  try {
    const mgr = (socket as any).io;
    if (mgr?.opts) {
      mgr.opts.reconnectionDelay = SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MS;
      mgr.opts.reconnectionDelayMax = SOCKET_RECONNECT_AFTER_SERVER_RESTART_DELAY_MAX_MS;
    }
  } catch {}
  logger.info('[socket] server restarting — accelerated reconnect backoff');
});

socket.on("connect", async () => {
  reconnecting = false;
  try {
    const mgr = (socket as any).io;
    if (mgr?.opts) {
      mgr.opts.reconnectionDelay = SOCKET_RECONNECT_DELAY_MS;
      mgr.opts.reconnectionDelayMax = SOCKET_RECONNECT_DELAY_MAX_MS;
    }
  } catch {}
  logger.debug(`[socket] connected ${socket.id} (API: ${API_BASE})`);
  // If we connected with installId in auth, handshake is considered valid.
  try {
    // @ts-ignore
    const auth = (socket as any)?.auth;
    if (auth?.installId) __handshakeHasInstallId = true;
  } catch {}
  
  // КРИТИЧНО: Если у нас есть userId, но socket подключился без него - отправляем reauth (дедуп с boot / другими вызовами)
  if (currentUserId && !(socket as any).data?.userId) {
    logger.debug('[socket] post-connect reauth (no userId in socket data yet)', { userId: currentUserId });
    try {
      const reauthResponse = await emitReauthDeduped(currentUserId);
      if (reauthResponse?.ok) {
        logger.debug('[socket] Reauth successful after connect');
      } else {
        logger.warn('[socket] Reauth failed after connect:', reauthResponse?.error);
        if (reauthResponse?.error === 'user_not_found' || reauthResponse?.error === 'not_found') {
          await recoverFromReauthFailure(reauthResponse?.error);
        }
      }
    } catch (e) {
      logger.warn('[socket] Reauth error after connect:', e);
    }
  }
  // После bind на сервере: для друзей «онлайн» только на переднем плане (сокет может оставаться в фоне).
  const syncAppVisibilityAfterConnect = () => {
    try {
      const fg = __lastAppState === 'active' || __lastAppState === 'inactive';
      if (socket.connected) emitAppVisibilityToServer(fg);
    } catch {}
  };
  syncAppVisibilityAfterConnect();
  setTimeout(syncAppVisibilityAfterConnect, 250);
  __flushPendingRtcSignals();
  // После reconnect сервер сбрасывает chat:viewing — восстанавливаем, если пользователь всё ещё в переписке.
  try {
    const peer = (global as any).__currentChatPeerId;
    if (peer && typeof peer === 'string' && peer.length > 0) {
      sendChatViewing(peer);
    }
  } catch {}
});
socket.on("reconnect_attempt", () => { reconnecting = true; });
// Manager `reconnect` не дублируем: после успешного переподключения снова срабатывает `connect` → один reauth через emitReauthDeduped.

socket.on("disconnect", (r) => {
  // Временные отвалы: по ним считаем, что сокет в состоянии переподключения (для логов и isReconnecting()).
  // io server disconnect: корректное закрытие при деплое/restart (см. server:restarting на бэкенде)
  const transient = ["transport close", "ping timeout", "transport error", "io server disconnect"];
  reconnecting = transient.includes(r) || r === undefined;
  // При транзиентных разрывах auth на клиенте не теряется — не сбрасываем флаг (избегаем лишних reconnect/reauth веток).
  const reason = String(r || '');
  if (!transient.includes(reason) && reason) {
    __handshakeHasInstallId = false;
  }
  const isExpectedUserBackgroundDisconnect = reason === 'io client disconnect';
  if (isExpectedUserBackgroundDisconnect) {
    const note = __realtimePaused ? 'app in background / screen locked' : 'user-initiated disconnect';
    logger.info(`[socket] temporary disconnect (${note}) reason=${reason || 'unknown'}`);
  } else if (transient.includes(reason)) {
    logger.debug(`[socket] disconnected (${reason}) reconnecting=${reconnecting} (transient; reauth after reconnect if needed)`);
  } else {
    logger.warn(`[socket] disconnected (${reason || 'unknown'}) reconnecting=${reconnecting}`);
  }
});
socket.on("connect_error", (e) => {
  reconnecting = true;
  // VPNs sometimes break XHR polling while WebSocket is still available.
  // Switch transport preference for next attempts to avoid stuck retries.
  try {
    const msg = String((e as any)?.message || '').toLowerCase();
    if (msg.includes('xhr poll error')) {
      const ioOpts: any = (socket as any)?.io?.opts;
      if (Array.isArray(ioOpts?.transports) && ioOpts.transports[0] !== 'websocket') {
        ioOpts.transports = ['websocket', 'polling'];
        logger.warn('[socket] xhr polling failed, preferring websocket for reconnect');
      }
    }
  } catch {}
  console.warn(`[socket] error ${e?.message || e}`);
});
// Busy handler (for logging/forwarding to UI screens)
socket.on('call:busy', (data) => {});

// Обработчики для системы бэйджа "Занято"
socket.on('random:busy', (data: { userId: string; busy: boolean }) => {});

socket.on('friends:room_state', (data: { roomId: string; participants: string[] }) => {});


// Глобальный слушатель для сохранения всех входящих сообщений
// УБРАН - сообщения теперь обрабатываются только в ChatScreen

/* ========= ICE candidates ========= */
// Буфер ICE-кандидатов на уровне сокета (для модулей, где PC создаются позже)
const __candidateBuffer: Record<string, any[]> = {};
type PendingRtcSignal = {
  event: 'offer' | 'answer' | 'ice-candidate';
  to: string;
  payload: any;
};
const __pendingRtcSignals: PendingRtcSignal[] = [];

function __flushPendingRtcSignals() {
  if (!socket.connected) return;
  if (!__pendingRtcSignals.length) return;
  const pending = __pendingRtcSignals.splice(0, __pendingRtcSignals.length);
  for (const item of pending) {
    try {
      socket.emit(item.event, item.payload);
    } catch {
      __pendingRtcSignals.unshift(item);
    }
  }
}

export function socketBufferIceCandidate(from: string, candidate: any) {
  const key = String(from || '');
  if (!key || !candidate) return;
  if (!__candidateBuffer[key]) __candidateBuffer[key] = [];
  __candidateBuffer[key].push(candidate);
  try {} catch {}
}

export function socketFlushBufferedIceCandidates(from: string): any[] {
  const key = String(from || '');
  if (!key) return [];
  const list = __candidateBuffer[key] || [];
  delete __candidateBuffer[key];
  try {
    list.length;
  } catch {}
  return list;
}

// socket.onAny((event, ...args) => {
//   console.log("[socket:onAny]", event, args);
// });

/* ========= small utils ========= */
async function waitForConnect(ms = 8000): Promise<void> {
  if (socket.connected) return;
  // Первое подключение (VPN / медленный DNS): не обрываем раньше, чем engine.io handshake.
  const effectiveMs = !__hasConnectedEver ? Math.max(ms, SOCKET_CONNECT_WAIT_MS) : ms;
  // CRITICAL: ensure installId is attached before any implicit connect().
  // Some codepaths call waitForConnect() (emitAck) which triggers socket.connect().
  // Without installId in handshake server can treat client as guest and return empty profile/avatar.
  try {
    const installId = await getInstallId();
    // @ts-ignore
    const prevAuth =
      (socket as any)?.auth && typeof (socket as any).auth === 'object' ? (socket as any).auth : {};
    // @ts-ignore
    socket.auth = { ...prevAuth, installId, ...(currentUserId ? { userId: currentUserId } : {}) };
  } catch {}
  return new Promise((resolve, reject) => {
    const onOk = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); reject(new Error("wait connect timeout")); }, effectiveMs);
    const cleanup = () => { clearTimeout(t); socket.off("connect", onOk); };
    socket.once("connect", onOk);
    // гарантируем попытку соединения
    try { socket.connect(); } catch {}
  });
}

/** Ждёт подключения сокета (с таймаутом). Нужно при отмене вызова из вне приложения, чтобы call:decline дошёл до сервера и caller получил call:declined. */
export async function ensureSocketConnected(ms = 15000): Promise<void> {
  if (socket.connected) return;
  try {
    await waitForConnect(ms);
  } catch {
    // Таймаут — всё равно вызываем declineCall ниже, emit может уйти в очередь
  }
}

/** Неблокирующий старт handshake до accept/initiate (входящий/исходящий звонок). */
export function warmCallSignaling(): void {
  if (socket.connected || reconnecting) return;
  void (async () => {
    try {
      const installId = await getInstallId();
      // @ts-ignore
      const prevAuth =
        (socket as any)?.auth && typeof (socket as any).auth === 'object' ? (socket as any).auth : {};
      // @ts-ignore
      socket.auth = { ...prevAuth, installId, ...(currentUserId ? { userId: currentUserId } : {}) };
    } catch {}
    try {
      socket.connect();
    } catch {}
  })();
}

type AnyObj = Record<string, any>;
export async function emitAck<T = any>(
  event: string,
  payload?: AnyObj,
  timeoutMs = 12000,
  retries = 2,                 // <= добавили авто-ретраи
): Promise<T> {
  // 1) если оффлайн/реконнект — сначала дождаться коннекта
  if (!socket.connected || reconnecting) {
    try {
      await waitForConnect(15000);
    } catch {
      throw new Error(`offline: cannot emit "${event}"`);
    }
  }

  const tryOnce = () =>
    new Promise<T>((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => {
        if (!done) { done = true; reject(new Error(`Ack timeout for "${event}"`)); }
      }, timeoutMs);

      const ack = (resp: T) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(resp);
      };

      // socket.emit с ack
      try {
        if (payload !== undefined) socket.emit(event, payload, ack);
        else socket.emit(event, null, ack);
      } catch (e) {
        clearTimeout(t);
        reject(e);
      }
    });

  // 2) ретраи на таймаут
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await tryOnce();
    } catch (e: any) {
      lastErr = e;
      // если снова ушли в реконнект — подождём и повторим
      if (!socket.connected || reconnecting) {
        try {
          await waitForConnect(15000);
        } catch {}
      }
      // джиттер между попытками
      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
    }
  }
  throw lastErr;
}

/** Один reauth за раз на всех вызывающих (connect, boot, friends:fetch, …). */
async function emitReauthDeduped(
  userId: string,
  timeoutMs = 6000,
  retries = 1,
): Promise<SocketReauthResponse> {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'no_userId' };
  if (reauthInFlight) return reauthInFlight;

  const p = (async (): Promise<SocketReauthResponse> => {
    try {
      const res = await emitAck<SocketReauthResponse>('reauth', { userId: uid }, timeoutMs, retries);
      if (res?.ok) {
        lastSuccessfulReauthAt = Date.now();
        if (res?.missed?.length) applyMissedFromReauth(res).catch(() => {});
      }
      return res && typeof res.ok === 'boolean' ? res : { ok: false, error: 'bad_response' };
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e || 'reauth_failed') };
    } finally {
      reauthInFlight = null;
    }
  })();

  reauthInFlight = p;
  return p;
}

/** Reauth failed: restore install mapping or recreate user (handles race with in-flight createUser). */
async function recoverFromReauthFailure(error?: string): Promise<void> {
  const err = String(error || '');
  if (err !== 'user_not_found' && err !== 'not_found') return;

  if (err === 'not_found' && isCreateUserInProgress()) {
    try {
      await waitForCreateUserCompletion();
    } catch {}
    const uid = getCurrentUserId();
    if (uid) {
      const retry = await emitReauthDeduped(uid);
      if (retry?.ok) return;
    }
  }

  if (err === 'not_found') {
    const mapped = await refreshUserIdFromInstall();
    if (mapped) {
      const retry = await emitReauthDeduped(mapped);
      if (retry?.ok) return;
    }
  }

  clearCurrentUserId();
  await createUser();
}

// После разрыва Manager шлёт `reconnect`, а namespace socket всегда шлёт `connect` — reauth делаем только в обработчике `connect` (через emitReauthDeduped), иначе двойной emit.

async function ensureReauthBeforePrivilegedSocketOp(): Promise<boolean> {
  const uid = String(currentUserId || '').trim();
  if (!uid) return false;
  const now = Date.now();
  if (now - lastSuccessfulReauthAt < REAUTH_FRESH_MS) return true;
  const res = await emitReauthDeduped(uid);
  return !!res.ok;
}

export function onConnected(cb: () => void): () => void {
  const h = () => cb();
  if (socket.connected) h();
  socket.on("connect", h);
  return () => socket.off("connect", h);
}

export function onDisconnected(cb: (reason?: string) => void): () => void {
  const h = (r?: string) => cb(r);
  socket.on("disconnect", h);
  return () => socket.off("disconnect", h);
}

/* ========= Friends API ========= */
export type FriendListItem = {
  _id: string;
  nick?: string;
  avatar?: string; // локальный путь /uploads/... или пусто
  avatarVer?: number;
  avatarThumbB64?: string;
  online: boolean;
  isBusy?: boolean; // статус занятости для видеозвонков
  isRandomBusy?: boolean;
  inCall?: boolean;
};

export function addFriend(toUserId: string) {
  if (!isOid(toUserId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = async () => {
    if (socket.connected && currentUserId) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) throw new Error('reauth_before_friends_add_failed');
    }
    return emitAck<{ ok: boolean; status?: string; error?: string }>('friends:add', { to: toUserId });
  };

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/add`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: toUserId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}
export const inviteFriend = addFriend;
export const requestFriend = addFriend; // Для обратной совместимости

export function respondFriend(fromUserId: string, accept: boolean, requestId?: string) {
  if (!isOid(fromUserId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>('friends:respond', { from: fromUserId, accept, requestId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/respond`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from: fromUserId, accept }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function acceptInvite(inviterId: string) {
  if (!isOid(inviterId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; status?: string; error?: string }>('friends:acceptInvite', { inviterId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/acceptInvite`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ inviterId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function fetchFriends(
  page: number = 1,
  limit: number = 50,
  options: { includeAvatarThumbs?: boolean } = {},
) {
  const includeAvatarThumbs = options.includeAvatarThumbs !== false;
  const viaSocket = async () => {
    // Защита от гонки: socket connected, но reauth на бэкенде ещё не успел завершиться.
    if (socket.connected && currentUserId) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) throw new Error('reauth_before_friends_fetch_failed');
    }
    return emitAck<{
      ok: boolean;
      list: FriendListItem[];
      pagination?: {
        page: number;
        limit: number;
        total: number;
        hasMore: boolean;
      };
      error?: string;
    }>('friends:fetch', { page, limit, includeAvatarThumbs });
  };

  // Fallback for networks/VPNs that break socket connectivity:
  // use REST endpoint that returns the same list shape.
  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    // Legacy/audit-only header (server does NOT trust it, but may log mismatch).
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    // "Fast but safe" strategy:
    // - first attempt: short timeout (good networks feel instant)
    // - second attempt: longer timeout (slow VPN still succeeds)
    const timeouts = [7000, 20000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends?page=${encodeURIComponent(String(page))}&limit=${encodeURIComponent(String(limit))}&includeAvatarThumbs=${includeAvatarThumbs ? '1' : '0'}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, list: [], error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        // If it's a timeout, just retry with the longer budget.
        // For other errors (DNS/VPN drop), retry once too — it can be transient.
        await new Promise((r) => setTimeout(r, 200));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, list: [], error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
}

export function onFriendAdded(
  cb: (d: { userId: string; userNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_added", h);
  socket.on("friend:added", h);
  return () => {
    socket.off("friend_added", h);
    socket.off("friend:added", h);
  };
}

export function onFriendRequest(
  cb: (d: { from: string; requestId?: string; fromNick?: string }) => void,
): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_request", h);
  socket.on("friend:request", h);
  return () => {
    socket.off("friend_request", h);
    socket.off("friend:request", h);
  };
}

export function onFriendAccepted(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_accepted", h);
  socket.on("friend:accepted", h);
  return () => {
    socket.off("friend_accepted", h);
    socket.off("friend:accepted", h);
  };
}

export function onFriendDeclined(cb: (d: { userId: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on("friend_declined", h);
  socket.on("friend:declined", h);
  return () => {
    socket.off("friend_declined", h);
    socket.off("friend:declined", h);
  };
}

export function onFriendRemoved(cb: (p: { userId: string }) => void): () => void {
  const h = (d: any) => cb({ userId: String(d?.userId ?? d?.id ?? d) });
  socket.on("friend_removed", h);
  socket.on("friend:removed", h);
  return () => {
    socket.off("friend_removed", h);
    socket.off("friend:removed", h);
  };
}

export function removeFriend(peerId: string) {
  if (!isOid(peerId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>('friends:remove', { peerId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/friends/remove`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ peerId }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

// Проверка реферальной ссылки
export async function checkInviteLink(code: string): Promise<{
  ok: boolean;
  inviter?: {
    id: string;
    nick: string;
    avatar: string;
    avatarVer: number;
    avatarThumbB64: string;
  };
  areFriends?: boolean;
  hasPendingRequest?: boolean;
  canAdd?: boolean;
  error?: string;
}> {
  try {
    if (!isOid(code)) {
      return { ok: false, error: 'invalid_code' };
    }

    const userId = getCurrentUserId();
    const headers: Record<string, string> = {};
    // Prefer installId so backend can resolve user securely.
    try {
      const installId = await getInstallId();
      if (installId) headers['x-install-id'] = String(installId);
    } catch {}
    
    if (userId) {
      headers['x-user-id'] = userId;
    }

    const url = `${API_BASE}/api/invite/${code}`;
    logger.debug('Checking invite link:', { url, code, userId });
    
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    // Проверяем статус ответа
    if (!response.ok) {
      const text = await response.text();
      logger.error('Invite link check failed:', { 
        status: response.status, 
        statusText: response.statusText,
        url,
        responseText: text.substring(0, 200) // Первые 200 символов для отладки
      });
      return { ok: false, error: `http_error_${response.status}` };
    }

    // Проверяем Content-Type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      logger.error('Invite link check returned non-JSON:', { 
        contentType,
        url,
        responseText: text.substring(0, 200) // Первые 200 символов для отладки
      });
      return { ok: false, error: 'invalid_response_format' };
    }

    const data = await response.json();
    logger.debug('Invite link check success:', { code, hasInviter: !!data.inviter });
    return data;
  } catch (e: any) {
    logger.error('Failed to check invite link:', { 
      error: e?.message || e,
      code,
      stack: e?.stack 
    });
    return { ok: false, error: e?.message || 'network_error' };
  }
}

export function checkFriendship(userId: string) {
  if (!isOid(userId)) return Promise.reject(new Error("invalid ObjectId"));
  const viaSocket = () =>
    emitAck<{ ok: boolean; areFriends: boolean; error?: string }>('friends:check', { userId });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/friends/check/${encodeURIComponent(String(userId))}`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, areFriends: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        return await res.json();
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return { ok: false, areFriends: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch (e) {
      return await viaHttp();
    }
  })();
}

/* ========= Presence ========= */
export function onPresenceUpdate(
  cb: (data: Array<{ _id: string; online: boolean }> | string[] | { userId: string; busy: boolean }) => void,
): () => void {
  const wrapped = (data: any) => {
    cb(data);
  };
  __presenceUpdateSubscribers.add(wrapped);
  return () => {
    __presenceUpdateSubscribers.delete(wrapped);
  };
}

export function onUserPresence(
  cb: (userId: string, online: boolean) => void,
): () => void {
  // Сохраняем предыдущий список онлайн пользователей для сравнения
  let previousOnlineUsers = new Set<string>();
  
  return onPresenceUpdate((data) => {
    // Логи presence убраны - показывают только рабочее состояние
    
    if (Array.isArray(data)) {
      const currentOnlineUsers = new Set<string>();
      
      // Обрабатываем массив (обычно это массив строк - ID онлайн пользователей)
      data.forEach(item => {
        const userId = typeof item === 'string' ? item : item._id;
        if (userId) {
          currentOnlineUsers.add(userId);
        }
      });
      
      // Определяем, кто стал онлайн
      currentOnlineUsers.forEach(userId => {
        if (!previousOnlineUsers.has(userId)) {
          cb(userId, true); // Пользователь стал онлайн
        }
      });
      
      // Определяем, кто стал офлайн
      previousOnlineUsers.forEach(userId => {
        if (!currentOnlineUsers.has(userId)) {
          cb(userId, false); // Пользователь стал офлайн
        }
      });
      
      // Обновляем предыдущий список
      previousOnlineUsers = currentOnlineUsers;
    }
  });
}

/* ========= Signaling (webrtc) ========= */
export function sendOffer(to: string, offer: any) {
  const payload = { to, offer };
  if (!socket.connected || reconnecting) {
    __pendingRtcSignals.push({ event: 'offer', to, payload });
    return;
  }
  socket.emit("offer", payload);
}
export function sendAnswer(to: string, answer: any) {
  const payload = { to, answer };
  if (!socket.connected || reconnecting) {
    __pendingRtcSignals.push({ event: 'answer', to, payload });
    return;
  }
  socket.emit("answer", payload);
}
export function sendCandidate(to: string, candidate: any) {
  const payload = { to, candidate };
  if (!socket.connected || reconnecting) {
    __pendingRtcSignals.push({ event: 'ice-candidate', to, payload });
    return;
  }
  socket.emit("ice-candidate", payload);
}

export function onRtcOffer(
  cb: (d: { from: string; offer: any }) => void,
): () => void {
  socket.on("offer", cb as any);
  return () => socket.off("offer", cb as any);
}
export function onRtcAnswer(
  cb: (d: { from: string; answer: any }) => void,
): () => void {
  socket.on("answer", cb as any);
  return () => socket.off("answer", cb as any);
}
export function onRtcCandidate(
  cb: (d: { from: string; candidate: any }) => void,
): () => void {
  socket.on("ice-candidate", cb as any);
  return () => socket.off("ice-candidate", cb as any);
}

/* ========= Profile ========= */
export function getMyProfile() {
  // КРИТИЧНО: Добавляем таймаут 8 секунд для защиты от зависания MongoDB
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      profile?: {
        nick?: string;
        avatarUrl?: string;
        avatarB64?: string;
        avatarThumbB64?: string;
        avatarVer?: number;
      };
      error?: string;
    }>('profile:me', undefined, 8000);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/me`;

    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return {
            ok: true,
            profile: {
              nick: data.user.nick || '',
              avatarUrl: data.user.avatar || '',
              avatarVer: data.user.avatarVer || 0,
            },
          };
        }
        return { ok: false, error: 'invalid_response' };
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}
export function updateProfile(patch: { nick?: string; avatar?: string }) {
  const clean: { nick?: string; avatar?: string } = {};
  const hasNick = typeof patch.nick === "string";
  if (hasNick) clean.nick = patch.nick;

  // ⚠️ КРИТИЧНО:
  // На сервере `avatar: ''` трактуется как УДАЛЕНИЕ аватара.
  // Поэтому:
  // - отправляем avatar='' ТОЛЬКО если это явная операция удаления (нет nick в patch)
  // - отправляем avatar только если это http(s) URL
  // - data:/file:/content:/ph: и т.п. НЕ отправляем
  if (typeof patch.avatar === "string") {
    const a = patch.avatar.trim();
    if (a === "") {
      if (!hasNick) clean.avatar = "";
    } else if (/^https?:\/\//i.test(a)) {
      clean.avatar = a;
    }
  }

  const viaSocket = async () => {
    if (currentUserId && socket.connected) {
      const ok = await ensureReauthBeforePrivilegedSocketOp();
      if (!ok) return { ok: false, error: 'unauthorized' };
    }
    return emitAck<{ ok: boolean; profile?: { nick?: string; avatar?: string }; error?: string }>(
      'profile:update',
      clean,
      5000
    );
  };

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const timeouts = [5000, 12000];
    let lastErr: any = null;
    const url = `${API_BASE}/api/me`;
    for (const ms of timeouts) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers,
          body: JSON.stringify(clean),
          signal: controller.signal,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        }
        const data = await res.json();
        if (data?.ok && data?.user) {
          return { ok: true, profile: { nick: data.user.nick || '', avatar: data.user.avatar || '' } };
        }
        return data;
      } catch (e: any) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return { ok: false, error: lastErr?.message || String(lastErr || 'network_error') };
  };

  const promise = (async () => {
    if (!currentUserId || !isOid(currentUserId)) {
      return { ok: false, error: 'no_userId' };
    }
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();

  promise.then((result) => {
    if (result?.ok) {} else {
      const err = String(result?.error || '');
      if (err === 'unauthorized' || err === 'no_userId') {
        logger.debug('[updateProfile] skipped — identity not ready yet', { error: err });
      } else {
        console.error('[updateProfile] ❌ Server response error:', result?.error);
      }
    }
  }).catch((error) => {
    console.error('[updateProfile] ❌ Request failed:', error);
  });

  return promise;
}

export async function getAvatar(userId: string) {
  if (!isOid(userId)) return { ok: false };
  return emitAck<{ ok: boolean; avatarB64?: string; avatarVer?: number }>(
    "user.getAvatar",
    { userId },
    8000,
    1
  );
}

/* ========= Identity ========= */
export function identityAttach(payload: {
  installId?: string;
  profile?: { nick?: string; avatarUrl?: string };
}) {
  return emitAck<{ ok: boolean; userId?: string; error?: string }>(
    "identity:attach",
    payload,
  );
}
export const attachIdentity = identityAttach;


/* ========= Service ========= */
export function getSocketId() {
  return socket.id;
}
export async function attachUserId(userId: string) {
  if (!isOid(userId)) return;
  console.log('[attachUserId] Attaching userId:', userId);
  currentUserId = userId;
  __notifyCurrentUserId();
  try {
    await AsyncStorage.setItem("userId", currentUserId);
  } catch {}
  if (socket.connected) {
    console.log('[socket] reauth — skip full disconnect');
    // Убираем избыточную проверку - reauth сам проверит существование пользователя
    socket.emit('reauth', { userId }); // мягкая переавторизация
    return;
  }
  await applyAuthAndConnect();
}

// Кэш для проверки существования пользователей
const userExistsCache = new Map<string, { result: boolean; timestamp: number }>();
// ВАЖНО: отрицательный результат нельзя кэшировать надолго — иначе после восстановления/создания пользователя
// приложение будет зацикливаться на "user_not_found" и делать hard reset по старому кэшу.
const USER_EXISTS_CACHE_TTL_TRUE = 30000; // 30s
const USER_EXISTS_CACHE_TTL_FALSE = 1500; // 1.5s (почти "debounce")
// Чтобы не спамить логами при частых проверках (например, при resume/focus)
let __lastUserExistsCacheLogAt = 0;

// Защита от одновременных вызовов для одного userId
const pendingChecks = new Map<string, Promise<boolean | null>>();
// Чтобы не спамить "Waiting for pending check" при множественных параллельных вызовах
const pendingWaitLogged = new Set<string>();

// Функция для проверки существования пользователя с retry и кэшированием
export async function checkUserExists(userId: string): Promise<boolean | null> {
  // Проверяем кэш
  const cached = userExistsCache.get(userId);
  if (cached) {
    const ttl = cached.result ? USER_EXISTS_CACHE_TTL_TRUE : USER_EXISTS_CACHE_TTL_FALSE;
    if (Date.now() - cached.timestamp < ttl) {
    // Log at most once per ~10s to avoid noisy dev console spam
    const now = Date.now();
    if (__DEV__ && now - __lastUserExistsCacheLogAt > 10_000) {
      __lastUserExistsCacheLogAt = now;
      logger.debug('[checkUserExists] Using cached result', { result: cached.result });
    }
    return cached.result;
    }
  }
  
  // Защита от одновременных вызовов - если уже есть запрос для этого userId, ждем его
  const pending = pendingChecks.get(userId);
  if (pending) {
    if (!pendingWaitLogged.has(userId)) {
      pendingWaitLogged.add(userId);
      logger.debug('[checkUserExists] Waiting for pending check', { userId });
    }
    return pending;
  }
  
  // Создаем новый запрос
  const checkPromise = (async () => {
    try {
  logger.debug('[checkUserExists] Checking user', { userId });
  
      // ПРИОРИТЕТ: Используем socket.io если подключен, иначе HTTP
      if (socketInstance?.connected) {
        try {
          const socketResult = await checkUserExistsSocket(userId);
          // ВАЖНО: не интерпретируем ok=false как exists=false (например, когда БД временно недоступна).
          if (socketResult?.ok === true && typeof (socketResult as any).exists === 'boolean') {
            const exists = (socketResult as any).exists as boolean;
            userExistsCache.set(userId, { result: exists, timestamp: Date.now() });
            logger.debug('[checkUserExists] User exists (via socket)', { userId, exists });
            return exists;
          }
          // ok=false / нет exists -> fallback to HTTP
        } catch (socketError) {
          // Не логируем как warning - это нормально если socket временно недоступен
          logger.debug('[checkUserExists] Socket check failed, falling back to HTTP');
        }
      }
      
      // Fallback: HTTP запрос с retry (только если socket не работает)
      const httpMaxAttempts = 3;
      for (let attempt = 1; attempt <= httpMaxAttempts; attempt++) {
        try {
          if (attempt === 1) {
            logger.debug('[checkUserExists] Attempt (HTTP)', { attempt, maxAttempts: httpMaxAttempts });
          }

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 20000);

          const response = await fetch(`${API_BASE}/api/exists/${userId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (attempt === httpMaxAttempts) {
              console.warn(`[checkUserExists] HTTP failed after ${attempt} attempts, status:`, response.status);
            }
            if (attempt < httpMaxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 700));
              continue;
            }
            return null;
          }

          const data = await response.json();
          if (data.ok) {
            logger.debug('[checkUserExists] User exists (via HTTP)', { userId, exists: data.exists });
            userExistsCache.set(userId, { result: data.exists, timestamp: Date.now() });
            return data.exists;
          }
        } catch (e: any) {
          if (attempt === httpMaxAttempts) {
            const errorMsg = e?.message || String(e);
            if (errorMsg.includes('Network request failed') || errorMsg.includes('timeout')) {
              logger.debug('[checkUserExists] Network unavailable, will retry later', {
                attempt,
                maxAttempts: httpMaxAttempts,
              });
            } else {
              console.warn(`[checkUserExists] HTTP error (attempt ${attempt}/${httpMaxAttempts}):`, errorMsg);
            }
          }
          if (attempt < httpMaxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 700));
            continue;
          }
        }
      }
  
      // Не логируем как warning - это нормальная ситуация когда сервер временно недоступен
      logger.debug('[checkUserExists] All attempts failed, server temporarily unavailable');
  return null; // null = неизвестно (сервер не готов)
    } finally {
      // Удаляем из pending после завершения
      pendingChecks.delete(userId);
      pendingWaitLogged.delete(userId);
    }
  })();
  
  // Сохраняем promise для защиты от дубликатов
  pendingChecks.set(userId, checkPromise);
  
  return checkPromise;
}

async function createUserInternal(): Promise<string | null> {
  console.log('[createUser] Creating user...');
  
  // КРИТИЧНО: Проверяем существование пользователя на сервере перед пропуском создания
  if (currentUserId) {
    try {
      const exists = await checkUserExists(currentUserId);
      if (exists === true) {
        console.log('[createUser] User already exists on server:', currentUserId, 'skipping creation');
        return currentUserId;
      } else if (exists === false) {
        console.warn('[createUser] User exists locally but not on server, clearing and creating new...');
        clearCurrentUserId();
      } else {
        // exists === null => сеть/сервер временно недоступны; не сбрасываем userId во избежание ложных ре-созданий.
        console.warn('[createUser] User existence unknown (temporary offline), keeping local userId and retrying later...');
        return null;
      }
    } catch (e) {
      console.warn('[createUser] Failed to check user existence, clearing local userId:', e);
      clearCurrentUserId();
    }
  }
  
  // Очищаем старый userId и все локальные данные из AsyncStorage
  try {
    await AsyncStorage.removeItem("userId");
    // актуальные ключи
    await AsyncStorage.removeItem('livi.profile.v1');
    await AsyncStorage.removeItem('profile_draft_v1');
    // legacy keys (на случай старых версий)
    await AsyncStorage.removeItem('profile');
    await AsyncStorage.removeItem('livi.home.draft.v1');
    console.log('[createUser] Cleared old userId and all local data from AsyncStorage');
  } catch (e) {
    console.warn('[createUser] Failed to clear AsyncStorage:', e);
  }
  
  let installId = await getInstallId();

  // Retry до 5 раз с задержкой
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`[createUser] Attempt ${attempt}/5...`);
      
      // Используем identity:attach для создания пользователя
      const response = await identityAttach({ installId });
      
      if (response?.ok && response?.userId) {
        // ВАЖНО: сервер может вернуть userId, который уже удалён из БД (например, по старой связке installId→userId).
        // Поэтому подтверждаем существование перед тем как считать создание успешным.
        const candidateId = String(response.userId);
        const exists = await checkUserExists(candidateId);

        if (exists === true) {
          setCurrentUserId(candidateId);
          await applyAuthAndConnect();
          console.log('[createUser] User created successfully:', candidateId);
          return candidateId;
        }

        if (exists === null) {
          setCurrentUserId(candidateId);
          await applyAuthAndConnect();
          try {
            await emitReauthDeduped(candidateId);
          } catch {}
          console.log('[createUser] User created (existence check inconclusive, trusting attach):', candidateId);
          return candidateId;
        }

        console.warn('[createUser] identity:attach returned non-existing userId, resetting installId and retrying...', {
          candidateId,
          exists,
        });
        const { resetInstallId } = await import('../utils/installId');
        await resetInstallId();
        clearCurrentUserId();
        installId = await getInstallId();
        continue;
      }
      
      if (response?.error === 'duplicate_request') {
        // КРИТИЧНО: Проверяем, существует ли пользователь на сервере
        // Если пользователь был удален из БД, getMyUserId может вернуть старый userId
        const existing = await getMyUserId();
        if (existing) {
          const exists = await checkUserExists(existing);
          if (exists) {
            // Пользователь существует на сервере - используем его
            setCurrentUserId(existing);
            await applyAuthAndConnect();
            console.log('[createUser] Existing user restored from installId:', existing);
            return existing;
          } else {
            // Пользователь не существует на сервере - очищаем installId и создаем нового
            console.warn('[createUser] User from duplicate_request does not exist on server, clearing installId and creating new user...');
            const { resetInstallId } = await import('../utils/installId');
            await resetInstallId();
            clearCurrentUserId();
            // Продолжаем цикл retry с новым installId
            const newInstallId = await getInstallId();
            continue;
          }
        } else {
          // Не удалось получить userId - ждем и повторяем
          console.warn('[createUser] duplicate_request but no userId found, retrying...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
      }
      
      // КРИТИЧНО: Если БД недоступна, не бросаем ошибку сразу - ждем и повторяем
      // Это позволяет приложению работать даже если БД временно недоступна
      if (response?.error === 'database_unavailable') {
        console.warn(`[createUser] Database unavailable on attempt ${attempt}, will retry...`);
        // Продолжаем цикл retry - следующая попытка будет через 2 секунды
        throw new Error('database_unavailable');
      }
      
      throw new Error(response?.error || 'Failed to create user');
      
    } catch (e) {
      console.warn(`[createUser] Attempt ${attempt} error:`, e);
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 секунды задержка
        continue;
      }
    }
  }
  
  console.error('[createUser] All attempts failed');
  return null;
}

// Функция для создания пользователя с retry
export async function createUser(): Promise<string | null> {
  if (createUserPromise) {
    console.log('[createUser] Creation already in progress, waiting for existing promise');
    return createUserPromise;
  }

  createUserPromise = (async () => {
    try {
      return await createUserInternal();
    } catch (error) {
      throw error;
    }
  })();

  try {
    return await createUserPromise;
  } finally {
    createUserPromise = null;
  }
}

export const isCreateUserInProgress = () => !!createUserPromise;
export async function waitForCreateUserCompletion(): Promise<string | null> {
  if (!createUserPromise) return null;
  return createUserPromise.catch((error) => { throw error; });
}

export function getCurrentUserId(): string | undefined {
  return currentUserId;
}

export function setCurrentUserId(userId: string) {
  if (!userId || !isOid(String(userId))) {
    clearCurrentUserId();
    return;
  }
  // Логи setCurrentUserId убраны - показывают только рабочее состояние
  currentUserId = userId;
  __notifyCurrentUserId();
  // При смене userId — сбрасываем кэш существования, чтобы не залипать на старом false
  try { userExistsCache.delete(String(userId)); } catch {}
  // При смене пользователя — сбрасываем кэш сообщений (иначе новый пользователь может увидеть чужие чаты)
  try { clearAllMessageCache(); } catch {}
  // Сохраняем в AsyncStorage без переподключения
  AsyncStorage.setItem("userId", userId).catch(e => console.warn('Failed to save userId to storage:', e));
}

// КРИТИЧНО: Функция для сброса currentUserId (нужна после удаления профиля)
export function clearCurrentUserId() {
  currentUserId = undefined;
  __notifyCurrentUserId();
  // При сбросе identity — сбрасываем кэши проверок, чтобы новые попытки были "чистыми"
  try { userExistsCache.clear(); } catch {}
  try { pendingChecks.clear(); } catch {}
  try { clearAllMessageCache(); } catch {}
  try { clearCancelledOutboxFingerprints(); } catch {}
  AsyncStorage.removeItem("userId").catch(e => console.warn('Failed to remove userId from storage:', e));
  console.log('[clearCurrentUserId] Cleared currentUserId');
}

/* ========= REST API для получения userId (как в старой версии) ========= */
async function whoamiViaRest(): Promise<string | null> {
  try {
    const installId = await getInstallId();
    const r = await fetch(`${API_BASE}/whoami?installId=${encodeURIComponent(installId)}`);
    const j = await r.json();
    if (j?.ok && isOid(j?.userId)) {
      return String(j.userId);
    }
  } catch (e) {
    console.warn('whoamiViaRest failed:', e);
  }
  return null;
}

/** installId → user mapping with REST whoami (ignores in-memory currentUserId). */
export async function refreshUserIdFromInstall(): Promise<string | null> {
  const userId = await whoamiViaRest();
  if (userId && isOid(userId)) {
    setCurrentUserId(userId);
    return userId;
  }
  return null;
}

export async function getMyUserId(): Promise<string | null> {
  // Сначала пробуем из памяти
  if (currentUserId) {
    return currentUserId;
  }
  
  // Потом через REST API
  const userId = await whoamiViaRest();
  if (userId) {
    setCurrentUserId(userId);
    return userId;
  }
  
  // Если REST API не работает, попробуем через socket
  try {
    const resp = await emitAck<any>("whoami", undefined, 6000, 1);
    if (resp && resp._id) {
      setCurrentUserId(resp._id);
      return resp._id;
    }
  } catch (error) {
    console.warn("🔍 getMyUserId: whoami via socket failed:", error);
  }
  
  return null;
}

export function onFriendProfile(
  cb: (p: { userId: string; nick?: string; avatar?: string; avatarVer?: number; avatarThumbB64?: string }) => void,
): () => void {
  const h = (p: any) => cb(p);
  socket.on("friend:profile", h);
  socket.on("friend_profile", h);
  return () => {
    socket.off("friend:profile", h);
    socket.off("friend_profile", h);
  };
}

/* ========= Messages ========= */
export function sendMessage(payload: {
  to: string;
  text?: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker';
  uri?: string;
  name?: string;
  size?: number;
  duration?: number;
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
  replyTo?: { id: string; text?: string; from: string; isOwn?: boolean };
  /** Не уходит на сервер — только для сопоставления с очередью при удалении до отправки. */
  clientUiMessageId?: string;
}) {
  // Ограничиваем типы сообщений для новой системы
  const messageType = payload.type === 'video' || payload.type === 'document' ? 'text' : payload.type;

  const optimisticUiId = String(payload.clientUiMessageId || '').trim() || undefined;

  const socketPayload: any = {
    to: payload.to,
    text: payload.text,
    type: messageType,
    uri: payload.uri,
    name: payload.name,
    size: payload.size,
    duration: payload.duration,
    stickerId: payload.stickerId,
    stickerPackId: payload.stickerPackId,
    stickerEmoji: payload.stickerEmoji,
    stickerLabel: payload.stickerLabel,
  };
  if (optimisticUiId) {
    socketPayload.clientMessageId = optimisticUiId;
    socketPayload.clientId = optimisticUiId;
  }
  if (payload.replyTo?.id) socketPayload.replyTo = { id: payload.replyTo.id, text: payload.replyTo.text, from: payload.replyTo.from };

  const viaSocket = () =>
    emitAck<{ ok: boolean; messageId?: string; timestamp?: Date; delivered?: boolean; error?: string }>(
      'message:send',
      socketPayload
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const body: any = {
      to: payload.to,
      text: payload.text,
      type: messageType,
      uri: payload.uri,
      name: payload.name,
      size: payload.size,
      duration: payload.duration,
      stickerId: payload.stickerId,
      stickerPackId: payload.stickerPackId,
      stickerEmoji: payload.stickerEmoji,
      stickerLabel: payload.stickerLabel,
    };
    if (optimisticUiId) {
      body.clientMessageId = optimisticUiId;
      body.clientId = optimisticUiId;
    }
    if (payload.replyTo?.id) body.replyTo = { id: payload.replyTo.id, text: payload.replyTo.text, from: payload.replyTo.from };

    const url = `${API_BASE}/api/messages/send`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    const outboxId = `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    try {
      const r = await viaSocket();
      // IMPORTANT: if socket responds with ok=false (no throw), fall back to HTTP.
      // This improves reliability (e.g. during transient auth/reauth timing or server hiccups),
      // and still supports offline recipients via backend persistence.
      if ((r as any)?.ok === true) return r;
      const http = await viaHttp();
      if ((http as any)?.ok === true) return http;
      if (isLikelyOfflineError((http as any)?.error)) {
        const enq = await enqueueMessageOutbox({
          id: outboxId,
          optimisticUiId,
          createdAt: Date.now(),
          payload: socketPayload,
        });
        if (!enq) {
          return { ok: true, localCancelled: true as const, delivered: false };
        }
        return { ok: true, queued: true, messageId: outboxId, delivered: false };
      }
      return http;
    } catch {
      try {
        const http = await viaHttp();
        if ((http as any)?.ok === true) return http;
        if (isLikelyOfflineError((http as any)?.error)) {
          const enq = await enqueueMessageOutbox({
            id: outboxId,
            optimisticUiId,
            createdAt: Date.now(),
            payload: socketPayload,
          });
          if (!enq) {
            return { ok: true, localCancelled: true as const, delivered: false };
          }
          return { ok: true, queued: true, messageId: outboxId, delivered: false };
        }
        return http;
      } catch (e) {
        if (isLikelyOfflineError(e)) {
          const enq = await enqueueMessageOutbox({
            id: outboxId,
            optimisticUiId,
            createdAt: Date.now(),
            payload: socketPayload,
          });
          if (!enq) {
            return { ok: true, localCancelled: true as const, delivered: false };
          }
          return { ok: true, queued: true, messageId: outboxId, delivered: false };
        }
        throw e;
      }
    }
  })();
}

export function markMessagesAsRead(from: string) {
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>('messages:mark_read', { from });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url = `${API_BASE}/api/messages/mark_read`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ from }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      return await viaSocket();
    } catch {
      return await viaHttp();
    }
  })();
}

export function sendReadReceipt(messageId: string, from: string) {
  socket.emit('message:read', { messageId, from });
}

/** Сообщить серверу, что пользователь смотрит чат с peerId (или не смотрит, если null). Пуш о новом сообщении в этот чат не отправляется (как в Telegram). */
export function sendChatViewing(peerId: string | null) {
  try {
    socket.emit('chat:viewing', { with: peerId ?? null });
  } catch {}
}

export function sendChatTyping(payload: { to: string; typing?: boolean; recording?: boolean }) {
  try {
    if (__DEV__) {
      try {
        // По умолчанию выключаем спам логов typing.
        // Если нужно включить — поставь true и получишь короткие логи только при смене состояния.
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          // всё равно продолжаем отправлять событие
          throw new Error('__skip_dev_typing_log__');
        }
        const to = String(payload.to || '');
        const typing = !!payload.typing;
        const key = `send:${to}`;
        const prev = __devTypingLogState.get(key);
        if (prev !== typing) {
          __devTypingLogState.set(key, typing);
          // Короткий формат: меньше шума в Metro
          console.log(`[chat:typing] send ${typing ? '1' : '0'} -> ${to}`);
        }
      } catch {}
    }
    socket.emit('chat:typing', {
      to: payload.to,
      typing: !!payload.typing,
      recording: payload.recording === undefined ? undefined : !!payload.recording,
    });
  } catch {}
}

export function onChatTyping(
  cb: (data: { from: string; to: string; typing: boolean; recording?: boolean; ts?: string }) => void
): () => void {
  const h = (data: any) => {
    if (__DEV__) {
      try {
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          throw new Error('__skip_dev_typing_log__');
        }
        const from = String(data?.from || '');
        const to = String(data?.to || '');
        const typing = !!data?.typing;
        const key = `recv:${from}->${to}`;
        const prev = __devTypingLogState.get(key);
        if (prev !== typing) {
          __devTypingLogState.set(key, typing);
          console.log(`[chat:typing] recv ${typing ? '1' : '0'} ${from} -> ${to}`);
        }
      } catch {}
    }
    cb(data);
  };
  socket.on('chat:typing', h);
  return () => {
    socket.off('chat:typing', h);
  };
}

// Новая функция для получения сообщений
export function fetchMessages(payload: {
  with: string;
  limit?: number;
  before?: string;
}) {
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      messages?: Array<{
        id: string;
        from: string;
        to: string;
        type: 'text' | 'image' | 'audio' | 'sticker';
        text?: string;
        uri?: string;
        stickerId?: string;
        stickerPackId?: string;
        stickerEmoji?: string;
        stickerLabel?: string;
        timestamp: string;
        read: boolean;
      }>;
      hasMore?: boolean;
      error?: string;
    }>('messages:fetch', payload);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const url =
      `${API_BASE}/api/messages?with=${encodeURIComponent(String(payload.with))}` +
      `&limit=${encodeURIComponent(String(payload.limit ?? 50))}` +
      (payload.before ? `&before=${encodeURIComponent(String(payload.before))}` : '');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      const r: any = await viaSocket();
      // IMPORTANT: if socket returns ok=false (no throw), fall back to HTTP.
      // This is common right after device wake / reconnect when auth/reauth is still settling.
      if (r?.ok === true) return r;
      return await viaHttp();
    } catch {
      return await viaHttp();
    }
  })();
}

// Новая функция для получения количества непрочитанных сообщений
export function getUnreadCount(from?: string) {
  return emitAck<{ 
    ok: boolean; 
    count?: number;
    error?: string;
  }>("messages:unread_count", { from });
}

export function getUnreadCounts(fromIds?: string[]) {
  const ids = Array.isArray(fromIds)
    ? fromIds.map((id) => String(id).trim()).filter(Boolean)
    : undefined;
  return emitAck<{
    ok: boolean;
    counts?: Record<string, number>;
    error?: string;
  }>('messages:unread_counts', ids?.length ? { fromIds: ids } : {});
}

export function onMessageReceived(
  cb: (message: {
    id: string;
    from: string;
    to: string;
    type: 'text' | 'image' | 'audio' | 'sticker';
    text?: string;
    uri?: string;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    timestamp: string;
    read: boolean;
  }) => void
): () => void {
  const h = (message: any) => {
    cb(message);
  };
  socket.on("message:received", h);
  return () => { socket.off("message:received", h); };
}

export function onChatCleared(
  cb: (data: { by: string; with: string }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:chat_cleared", h);
  return () => { socket.off("message:chat_cleared", h); };
}

export function onMessageDeleted(
  cb: (data: { messageId: string; deletedBy: string }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:deleted", h);
  return () => { socket.off("message:deleted", h); };
}

export function onMessagesDeleted(
  cb: (data: { messageIds: string[]; deletedBy: string }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("messages:deleted", h);
  return () => { socket.off("messages:deleted", h); };
}

export function onMessageReadReceipt(
  cb: (receipt: {
    messageId: string;
    readBy: string;
    timestamp: string;
  }) => void
): () => void {
  const single = (receipt: any) => cb(receipt);
  const batch = (receipt: any) => {
    const messageIds = Array.isArray(receipt?.messageIds) ? receipt.messageIds : [];
    for (const messageId of messageIds) {
      cb({
        messageId: String(messageId),
        readBy: String(receipt?.readBy || ''),
        timestamp: String(receipt?.timestamp || new Date().toISOString()),
      });
    }
  };
  socket.on("message:read_receipt", single);
  socket.on("messages:read_receipt", batch);
  return () => {
    socket.off("message:read_receipt", single);
    socket.off("messages:read_receipt", batch);
  };
}

/** Поставить/снять реакцию на сообщение. with = peerId чата. */
export function sendMessageReaction(messageId: string, emoji: string, withPeerId: string) {
  return emitAck<{ ok: boolean; reactions?: { emoji: string; userId: string }[]; error?: string }>(
    "message:react",
    { messageId, emoji, with: withPeerId }
  );
}

export function onMessageReaction(
  cb: (data: { messageId: string; reactions: { emoji: string; userId: string }[] }) => void
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:reaction", h);
  return () => socket.off("message:reaction", h);
}

export function getUnreadMessageCount(fromUserId: string) {
  return emitAck<{ ok: boolean; count?: number; error?: string }>(
    "message:unread_count",
    { from: fromUserId }
  );
}

export function loadMessagesFromServer(fromUserId: string, limit?: number) {
  return fetchMessages({ with: fromUserId, limit });
}

/* ========= User Validation ========= */
export function checkUserExistsSocket(userId: string) {
  return emitAck<{ ok: boolean; exists: boolean; error?: string }>(
    "user:exists",
    { userId }
  );
}

/* ========= User Data Cleanup ========= */
export async function clearAllUserData(): Promise<{ success: boolean; error?: any }> {
  try {
    // Очищаем все данные из AsyncStorage
    const keys = await AsyncStorage.getAllKeys();
    const userDataKeys = keys.filter(key => 
      key.startsWith('user') || 
      key.startsWith('friends') || 
      key.startsWith('chat_messages_') || 
      key.startsWith('chat_statuses_') ||
      key.startsWith('profile_') ||
      key.startsWith('profile_draft_') ||
      key.startsWith('livi.profile') || // Добавляем livi.profile.v1
      key.startsWith('unread_') ||
      key.startsWith('message_') ||
      key === 'missed_calls_by_user_v1' ||
      key.includes('userId') ||
      key.includes('installId') ||
      key.includes('avatar') || // Добавляем кеш аватаров
      key.includes('cache') || // Добавляем общий кеш
      key.includes('draft') // Добавляем все черновики
    );
    
    if (userDataKeys.length > 0) {
      await AsyncStorage.multiRemove(userDataKeys);
    }
    
    // Очищаем кэш сообщений
    clearAllMessageCache();
    
    // Очищаем данные профиля
    try {
      const { clearProfileStorage } = await import('../utils/profileStorage');
      await clearProfileStorage();
    } catch (e) {
      console.warn('Failed to clear profile storage:', e);
    }
    
    // Очищаем кеш аватаров
    try {
      const { clearAvatarCache } = await import('../utils/avatarCache');
      await clearAvatarCache();
    } catch (e) {
      console.warn('Failed to clear avatar cache:', e);
    }
    
    // Сбрасываем текущий userId
    currentUserId = undefined;
    
    return { success: true };
  } catch (error) {
    console.error('Failed to clear user data:', error);
    return { success: false, error };
  }
}


// Server history REMOVED - using local storage only
export async function getChatHistory(peerId: string): Promise<any[]> {
  return [];
}

// Кэш для сообщений (избегаем повторной загрузки)
const messageCache = new Map<string, { messages: any[], timestamp: number }>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 минут

const GLOBALLY_DELETED_MESSAGE_IDS_KEY = 'chat_globally_deleted_message_ids';
const GLOBALLY_DELETED_MESSAGE_IDS_MAX = 600;
let globallyDeletedMessageIdsMem: Set<string> | null = null;
let globallyDeletedMessageIdsLoadPromise: Promise<Set<string>> | null = null;

function trimMessageId(raw: unknown): string {
  return String(raw || '').trim();
}

export async function ensureGloballyDeletedMessageIdsLoaded(): Promise<Set<string>> {
  if (globallyDeletedMessageIdsMem) return globallyDeletedMessageIdsMem;
  if (globallyDeletedMessageIdsLoadPromise) return globallyDeletedMessageIdsLoadPromise;
  globallyDeletedMessageIdsLoadPromise = (async () => {
    const set = new Set<string>();
    try {
      const raw = await AsyncStorage.getItem(GLOBALLY_DELETED_MESSAGE_IDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            const t = trimMessageId(id);
            if (t) set.add(t);
          }
        }
      }
    } catch {}
    globallyDeletedMessageIdsMem = set;
    return set;
  })();
  return globallyDeletedMessageIdsLoadPromise;
}

export function isGloballyDeletedMessageId(messageId: string): boolean {
  const id = trimMessageId(messageId);
  if (!id) return false;
  return globallyDeletedMessageIdsMem?.has(id) ?? false;
}

export function filterOutGloballyDeletedMessages<T extends { id?: unknown }>(messages: T[]): T[] {
  const tombstones = globallyDeletedMessageIdsMem;
  if (!tombstones || tombstones.size === 0) return messages;
  return messages.filter((msg) => !tombstones.has(trimMessageId(msg?.id)));
}

export async function rememberGloballyDeletedMessageIds(rawIds: readonly string[]): Promise<void> {
  const incoming = rawIds.map(trimMessageId).filter(Boolean);
  if (incoming.length === 0) return;
  const set = await ensureGloballyDeletedMessageIdsLoaded();
  let changed = false;
  for (const id of incoming) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (!changed) return;
  while (set.size > GLOBALLY_DELETED_MESSAGE_IDS_MAX) {
    const first = set.values().next().value;
    if (first == null) break;
    set.delete(first);
  }
  try {
    await AsyncStorage.setItem(GLOBALLY_DELETED_MESSAGE_IDS_KEY, JSON.stringify(Array.from(set)));
  } catch (error) {
    logger.warn('[messages] failed to persist globally deleted message ids:', error);
  }
}

void ensureGloballyDeletedMessageIdsLoaded();

// Очистка кэша для конкретного чата (при получении новых сообщений)
export function clearMessageCache(peerId: string, userId?: string) {
  const currentUser = userId || currentUserId;
  if (!currentUser || !peerId) return;

  const cacheKey = `${currentUser}-${peerId}`;
  messageCache.delete(cacheKey);
}

async function removeDeletedMessagesFromLocalStorage(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(rawIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (ids.size === 0) return;

  await rememberGloballyDeletedMessageIds([...ids]);

  try {
    for (const [cacheKey, cached] of Array.from(messageCache.entries())) {
      const before = Array.isArray(cached?.messages) ? cached.messages : [];
      const next = before.filter((msg: any) => !ids.has(String(msg?.id || '').trim()));
      if (next.length !== before.length) {
        messageCache.set(cacheKey, { ...cached, messages: next, timestamp: Date.now() });
      }
    }
  } catch {}

  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => String(key || '').startsWith('chat_messages_'));
    if (keys.length === 0) return;
    const rows = await AsyncStorage.multiGet(keys);
    await Promise.all(
      rows.map(async ([key, value]) => {
        if (!key || !value) return;
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) return;
          const next = parsed.filter((msg: any) => !ids.has(String(msg?.id || '').trim()));
          if (next.length === parsed.length) return;
          if (next.length === 0) {
            await AsyncStorage.removeItem(key);
          } else {
            await AsyncStorage.setItem(key, JSON.stringify(next));
          }
        } catch {}
      }),
    );
  } catch (error) {
    logger.warn('[messages] failed to remove deleted messages from local storage:', error);
  }
}

const deleteCleanupGlobal = globalThis as any;
if (!deleteCleanupGlobal.__liviMessageDeleteCacheCleanupRegistered) {
  deleteCleanupGlobal.__liviMessageDeleteCacheCleanupRegistered = true;
  socket.on('message:deleted', (data: any) => {
    void removeDeletedMessagesFromLocalStorage([String(data?.messageId || '')]);
  });
  socket.on('messages:deleted', (data: any) => {
    const ids = Array.isArray(data?.messageIds) ? data.messageIds.map((id: any) => String(id || '')) : [];
    void removeDeletedMessagesFromLocalStorage(ids);
  });
}

function parseStoredChatMessagesJson(
  savedMessages: string,
  currentUser: string,
  peerId: string,
): any[] {
  const parsed = JSON.parse(savedMessages);
  const mapped = parsed
    .filter((msg: any) => {
      const isFromCurrentUser = msg.from === currentUser && msg.to === peerId;
      const isToCurrentUser = msg.from === peerId && msg.to === currentUser;
      return isFromCurrentUser || isToCurrentUser;
    })
    .map((msg: any) => {
      let correctedMsg = { ...msg };
      if (!msg.from || !msg.to) {
        if (msg.sender === 'me') {
          correctedMsg.from = currentUser;
          correctedMsg.to = peerId;
        } else if (msg.sender === 'peer') {
          correctedMsg.from = peerId;
          correctedMsg.to = currentUser;
        }
      }
      return {
        ...correctedMsg,
        timestamp: new Date(msg.timestamp),
        sender: correctedMsg.from === currentUser ? 'me' : 'peer',
      };
    });
  return filterOutGloballyDeletedMessages(mapped);
}

/**
 * Только in-memory кэш + AsyncStorage — без сети и без getMyUserId.
 * Нужен для первого кадра ChatScreen (нет долгого спиннера при офлайне / таймаутах сокета).
 */
export async function getChatMessagesLocal(peerId: string, userId?: string): Promise<any[]> {
  try {
    let currentUser = userId || currentUserId;
    if (!currentUser) {
      const raw = await AsyncStorage.getItem('userId');
      if (raw && /^[a-f\d]{24}$/i.test(String(raw))) {
        currentUser = String(raw);
      }
    }
    if (!currentUser || !peerId) return [];

    const cacheKey = `${currentUser}-${peerId}`;
    const now = Date.now();
    const cached = messageCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_DURATION) {
      return cached.messages;
    }

    const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
    const savedMessages = await AsyncStorage.getItem(chatKey);
    if (!savedMessages) return [];

    const messagesWithDates = parseStoredChatMessagesJson(savedMessages, currentUser, peerId);
    messageCache.set(cacheKey, { messages: messagesWithDates, timestamp: now });
    return messagesWithDates;
  } catch (error) {
    console.warn('getChatMessagesLocal failed:', error);
    return [];
  }
}

// Очистка всего кэша сообщений
export function clearAllMessageCache() {
  messageCache.clear();
}

// Очистить переписку с пользователем
export async function clearChatMessages(peerId: string, forAll: boolean = true): Promise<boolean> {
  try {
    const viaSocket = async () => {
      const result = await emitAck('message:clear_chat', { with: peerId, forAll });
      return !!result?.ok;
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (installId) headers['x-install-id'] = String(installId);
      if (currentUserId) headers['x-user-id'] = String(currentUserId);

      const url = `${API_BASE}/api/messages/clear_chat`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ with: peerId, forAll }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => null);
        return !!data?.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let ok = false;
    try {
      ok = await viaSocket();
    } catch {
      ok = await viaHttp();
    }

    if (ok) {
      // Очищаем локальный кэш
      clearMessageCache(peerId);
      
      // Очищаем AsyncStorage
      const currentUser = currentUserId;
      if (currentUser) {
        const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
        await AsyncStorage.removeItem(chatKey);
      }
      
      return true;
    }
    return false;
  } catch (error) {
    console.error('Failed to clear chat messages:', error);
    return false;
  }
}

// Удалить одно сообщение
export async function deleteMessage(messageId: string): Promise<boolean> {
  try {
    const viaSocket = async () => {
      return await emitAck('message:delete', { messageId });
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (installId) headers['x-install-id'] = String(installId);
      if (currentUserId) headers['x-user-id'] = String(currentUserId);

      const url = `${API_BASE}/api/messages/delete`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messageId }),
          signal: controller.signal,
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => null);
        return !!data?.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      const r: any = await viaSocket();
      // IMPORTANT: if socket responds with ok=false (no throw), fall back to HTTP for reliability.
      if (r?.ok === true) {
        await rememberGloballyDeletedMessageIds([messageId]);
        return true;
      }
      const httpOk = await viaHttp();
      if (httpOk) await rememberGloballyDeletedMessageIds([messageId]);
      return httpOk;
    } catch {
      const httpOk = await viaHttp();
      if (httpOk) await rememberGloballyDeletedMessageIds([messageId]);
      return httpOk;
    }
  } catch (error) {
    console.error('Failed to delete message:', error);
    return false;
  }
}

export async function deleteMessages(messageIds: string[]): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  try {
    const normalized = Array.from(new Set((messageIds || []).map((id) => String(id || '').trim()).filter(Boolean)));
    if (normalized.length === 0) return { deletedIds: [], failedIds: [] };

    const viaSocket = async () => {
      return await emitAck<{ ok: boolean; deletedIds?: string[]; failedIds?: string[] }>('messages:delete', {
        messageIds: normalized,
      });
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (installId) headers['x-install-id'] = String(installId);
      if (currentUserId) headers['x-user-id'] = String(currentUserId);

      const url = `${API_BASE}/api/messages/delete_many`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messageIds: normalized }),
          signal: controller.signal,
        });
        if (!res.ok) return { deletedIds: [], failedIds: normalized };
        const data = await res.json().catch(() => null);
        return {
          deletedIds: Array.isArray(data?.deletedIds) ? data.deletedIds.map(String) : [],
          failedIds: Array.isArray(data?.failedIds) ? data.failedIds.map(String) : normalized,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    try {
      const r: any = await viaSocket();
      const deletedFromSocket = Array.isArray(r?.deletedIds) ? r.deletedIds.map(String) : [];
      const failedFromSocket = Array.isArray(r?.failedIds) ? r.failedIds.map(String) : [];
      if (r?.ok === true || deletedFromSocket.length > 0) {
        if (deletedFromSocket.length > 0) {
          await rememberGloballyDeletedMessageIds(deletedFromSocket);
        }
        return {
          deletedIds: deletedFromSocket,
          failedIds: failedFromSocket.length > 0
            ? failedFromSocket
            : normalized.filter((id) => !deletedFromSocket.includes(String(id))),
        };
      }
      const httpResult = await viaHttp();
      if (httpResult.deletedIds.length > 0) {
        await rememberGloballyDeletedMessageIds(httpResult.deletedIds);
      }
      return httpResult;
    } catch {
      const httpResult = await viaHttp();
      if (httpResult.deletedIds.length > 0) {
        await rememberGloballyDeletedMessageIds(httpResult.deletedIds);
      }
      return httpResult;
    }
  } catch (error) {
    console.error('Failed to delete messages:', error);
    return {
      deletedIds: [],
      failedIds: Array.from(new Set((messageIds || []).map((id) => String(id || '').trim()).filter(Boolean))),
    };
  }
}

/** Редактировать текстовое сообщение (только своё). При офлайне ставит в очередь — после connect уйдёт через drainEditOutbox. */
export async function editMessage(
  messageId: string,
  text: string,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const trimmedMid = String(messageId || '').trim();
  const trimmedText = String(text ?? '');
  if (!trimmedMid) return { ok: false, error: 'no_messageId' };

  if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
    return { ok: true };
  }

  const queueOffline = async (): Promise<{ ok: true; queued: true }> => {
    if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
      return { ok: true, queued: true };
    }
    await enqueueEditOutbox({
      id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      messageId: trimmedMid,
      text: trimmedText,
      createdAt: Date.now(),
    });
    return { ok: true, queued: true };
  };

  const viaSocket = async () =>
    emitAck<{ ok: boolean; error?: string }>('message:edit', {
      messageId: trimmedMid,
      text: trimmedText,
    });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/api/messages/edit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messageId: trimmedMid, text: trimmedText }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const data = await res.json().catch(() => null);
      return data?.ok ? { ok: true } : { ok: false, error: data?.error || 'unknown' };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  try {
    const r: any = await viaSocket();
    if (r?.ok === true) return { ok: true };
    if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
      return { ok: true };
    }
    const http = await viaHttp();
    if ((http as any)?.ok === true) return { ok: true };
    if (isLikelyOfflineError((http as any)?.error)) {
      return await queueOffline();
    }
    if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
      return { ok: true };
    }
    return { ok: false, error: (http as any)?.error || 'edit_failed' };
  } catch {
    try {
      const http = await viaHttp();
      if ((http as any)?.ok === true) return { ok: true };
      if (isLikelyOfflineError((http as any)?.error)) {
        return await queueOffline();
      }
      if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
        return { ok: true };
      }
      return { ok: false, error: (http as any)?.error || 'edit_failed' };
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        return await queueOffline();
      }
      if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
        return { ok: true };
      }
      return { ok: false, error: e?.message || 'network_error' };
    }
  }
}

export function onMessageEdited(cb: (data: { messageId: string; text: string }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on('message:edited', h);
  return () => { socket.off('message:edited', h); };
}

// Загрузка всех сообщений для чата (с кэшированием)
export async function getChatMessages(peerId: string, userId?: string): Promise<any[]> {
  try {
    let currentUser = userId || currentUserId;

    // Если нет userId, принудительно получаем его
    if (!currentUser) {
      const fetchedUserId = await getMyUserId();
      if (!fetchedUserId) {
        console.warn('🔍 getChatMessages: still no userId after fetch');
        return [];
      }
      currentUser = fetchedUserId;
    }

    if (!currentUser || !peerId) return [];

    const cacheKey = `${currentUser}-${peerId}`;
    const now = Date.now();

    // Проверяем кэш
    const cached = messageCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < CACHE_DURATION) {
      return cached.messages;
    }

    // Сначала пытаемся загрузить из локального хранилища (быстрее)
    const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
    const savedMessages = await AsyncStorage.getItem(chatKey);

    if (savedMessages) {
      const messagesWithDates = parseStoredChatMessagesJson(savedMessages, currentUser, peerId);
      messageCache.set(cacheKey, { messages: messagesWithDates, timestamp: now });
      return messagesWithDates;
    }

    const response = await loadMessagesFromServer(peerId, 100);

    if (response.ok && response.messages && response.messages.length > 0) {
      const messagesWithSender = response.messages.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
        sender: msg.from === currentUser ? 'me' : 'peer'
      }));

      // Сохраняем в локальное хранилище
      await AsyncStorage.setItem(chatKey, JSON.stringify(messagesWithSender));

      // Кэшируем результат
      messageCache.set(cacheKey, { messages: messagesWithSender, timestamp: now });

      return messagesWithSender;
    }

    return [];
  } catch (error) {
    console.warn('Failed to load chat messages:', error);
    return [];
  }
}

export default socket;

/* ========= Calls (direct video) ========= */
export function startCall(toUserId: string) {
  const raw = String(toUserId || '').trim();
  if (!isOid(raw)) return Promise.reject(new Error('invalid ObjectId'));
  const to = /^[a-f\d]{24}$/i.test(raw) ? raw.toLowerCase() : raw;

  const viaSocket = () =>
    emitAck<{ ok: boolean; callId?: string; error?: string }>(
      'call:initiate',
      { to },
      20000,
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (installId) headers['x-install-id'] = String(installId);
    if (currentUserId) headers['x-user-id'] = String(currentUserId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/api/calls/initiate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(async () => {
          const txt = await res.text().catch(() => '');
          return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ''}` };
        });
        return {
          ok: false,
          error: body?.error || `http_${res.status}`,
        };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    if (!socket.connected || reconnecting) {
      logger.info('[call:initiate] socket unavailable, using HTTP fallback', {
        connected: socket.connected,
        reconnecting,
      });
      return viaHttp();
    }

    try {
      const socketResp = await viaSocket();
      if (socketResp?.ok === true) return socketResp;
      return socketResp;
    } catch (e: any) {
      logger.warn('[call:initiate] socket initiate failed, trying HTTP fallback', {
        error: e?.message || String(e),
        connected: socket.connected,
        reconnecting,
      });
      return viaHttp();
    }
  })();
}

export function cancelCall(callId: string) {
  socket.emit('call:cancel', { callId });
}

export function acceptCall(callId: string) {
  const id = String(callId || '').trim();
  if (!id) return;
  void (async () => {
    try {
      warmCallSignaling();
      await ensureSocketConnected(CALL_SIGNALING_CONNECT_MS);
      const resp = await emitAck<{ ok?: boolean; error?: string }>('call:accept', { callId: id }, 7000, 2);
      if (!resp?.ok) {
        logger.warn('[socket] call:accept ack returned not ok', { callId: id, error: resp?.error });
      }
    } catch (e: any) {
      logger.warn('[socket] call:accept via ack failed, fallback emit', {
        callId: id,
        error: e?.message || String(e),
      });
      try {
        socket.emit('call:accept', { callId: id });
      } catch {}
    }
  })();
}

export function declineCall(callId: string) {
  socket.emit('call:decline', { callId });
}

/** Запросить payload call:accepted у сервера (после FCM call_accepted, когда приложение вывели на передний план). */
export function requestCallAccepted(callId: string) {
  socket.emit('call:getAccepted', { callId });
}

export function onCallIncoming(cb: (d: { callId: string; callKitId?: string; from: string; fromNick?: string; ts?: number | string; expiresAt?: number | string }) => void): () => void {
  const h = (d: any) => {
    logger.debug('Socket received call:incoming', { callId: d.callId, from: d.from, fromNick: d.fromNick });
    cb(d);
  };
  socket.on('call:incoming', h);
  return () => socket.off('call:incoming', h);
}

/** Получатель сообщает серверу, что входящий экран реально показан (метрика доставки). */
export function reportIncomingCallShown(callId: string): void {
  const id = String(callId || '').trim();
  if (!id) return;
  const connected = socket.connected;
  const sid = connected ? socket.id : null;
  try {
    logger.info('[call:incoming_shown] socket emit', { callId: id, connected, socketId: sid });
    socket.emit('call:incoming_shown', { callId: id });
  } catch (e) {
    logger.warn('[call:incoming_shown] socket emit failed', { callId: id, connected, err: String(e) });
  }
}

export function onCallAccepted(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => {
    logger.debug('Socket received call:accepted', { callId: d.callId, from: d.from });
    cb(d);
  };
  socket.on('call:accepted', h);
  return () => socket.off('call:accepted', h);
}

export function onCallDeclined(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:declined', h);
  return () => socket.off('call:declined', h);
}

// Отдельное событие для явной отмены звонком инициатора (дублирует call:declined на сервере, но даём отдельный listener для явности)
export function onCallCanceled(cb: (d: { callId: string; from: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:cancel', h);
  return () => socket.off('call:cancel', h);
}

export function onCallTimeout(cb: (d: { callId: string; from?: string }) => void): () => void {
  const h = (d: any) => cb(d);
  socket.on('call:timeout', h);
  return () => socket.off('call:timeout', h);
}

export function onCallRoomFull(cb: (d: { userId?: string }) => void): () => void {
  const h = (d: any) => cb(d || {});
  socket.on('call:room_full', h);
  return () => socket.off('call:room_full', h);
}

// Обработчики для системы бэйджа "Занято"
export function onRandomBusy(cb: (data: { userId: string; busy: boolean }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on('random:busy', h);
  return () => socket.off('random:busy', h);
}

export function onFriendsRoomState(cb: (data: { roomId: string; participants: string[] }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on('friends:room_state', h);
  return () => socket.off('friends:room_state', h);
}
