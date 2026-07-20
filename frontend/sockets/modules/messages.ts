import AsyncStorage from "@react-native-async-storage/async-storage";
import { getInstallId } from "../../utils/installId";
import { logger } from "../../utils/logger";
import { API_BASE } from "./constants";
import { emitAck, waitForConnect } from "./emit";
import {
  enqueueEditOutbox,
  enqueueMessageOutbox,
  mergePendingMessageOutboxEdit,
} from "./outbox";
import { shared } from "./shared";
import { socket } from "./socketCore";

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
              from: String(message.replyTo.from || ""),
              isOwn: String(message.replyTo.from || "") === String(currentUserId),
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
          sender: "peer",
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
        };
        if (Array.isArray(message.uris) && message.uris.length > 1) {
          newMessage.uris = message.uris.map((u: any) => String(u || "").trim()).filter(Boolean).slice(0, 10);
          if (!newMessage.uri) newMessage.uri = newMessage.uris[0];
        }
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
      logger.warn("Failed to save message globally:", error);
    }
  },
};

const CACHE_DURATION = 5 * 60 * 1000;
const GLOBALLY_DELETED_MESSAGE_IDS_KEY = "chat_globally_deleted_message_ids";
const GLOBALLY_DELETED_MESSAGE_IDS_MAX = 600;

function isLikelyOfflineError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || "").toLowerCase();
  return (
    msg.includes("network request failed") ||
    msg.includes("socket connection timeout") ||
    msg.includes("xhr poll error") ||
    msg.includes("timeout") ||
    msg.includes("aborted")
  );
}

function trimMessageId(raw: unknown): string {
  return String(raw || "").trim();
}

export function sendMessage(payload: {
  to: string;
  text?: string;
  type: "text" | "image" | "audio" | "video" | "document" | "sticker";
  uri?: string;
  uris?: string[];
  name?: string;
  size?: number;
  duration?: number;
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
  replyTo?: { id: string; text?: string; from: string; isOwn?: boolean };
  clientUiMessageId?: string;
}) {
  // Ограничиваем типы сообщений для новой системы
  const messageType = payload.type === "video" || payload.type === "document" ? "text" : payload.type;

  const optimisticUiId = String(payload.clientUiMessageId || "").trim() || undefined;
  const albumUris =
    messageType === "image" && Array.isArray(payload.uris)
      ? payload.uris.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 10)
      : [];
  const primaryUri =
    messageType === "image"
      ? albumUris[0] || payload.uri
      : payload.uri;

  const socketPayload: any = {
    to: payload.to,
    text: payload.text,
    type: messageType,
    uri: primaryUri,
    name: payload.name,
    size: payload.size,
    duration: payload.duration,
    stickerId: payload.stickerId,
    stickerPackId: payload.stickerPackId,
    stickerEmoji: payload.stickerEmoji,
    stickerLabel: payload.stickerLabel,
  };
  if (messageType === "image" && albumUris.length > 1) {
    socketPayload.uris = albumUris;
  }
  if (optimisticUiId) {
    socketPayload.clientMessageId = optimisticUiId;
    socketPayload.clientId = optimisticUiId;
  }
  if (payload.replyTo?.id) {
    socketPayload.replyTo = { id: payload.replyTo.id, text: payload.replyTo.text, from: payload.replyTo.from };
  }

  const viaSocket = () =>
    emitAck<{ ok: boolean; messageId?: string; timestamp?: Date; delivered?: boolean; error?: string }>(
      "message:send",
      socketPayload,
    );

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const body: any = {
      to: payload.to,
      text: payload.text,
      type: messageType,
      uri: primaryUri,
      name: payload.name,
      size: payload.size,
      duration: payload.duration,
      stickerId: payload.stickerId,
      stickerPackId: payload.stickerPackId,
      stickerEmoji: payload.stickerEmoji,
      stickerLabel: payload.stickerLabel,
    };
    if (messageType === "image" && albumUris.length > 1) {
      body.uris = albumUris;
    }
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
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
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
  const viaSocket = () => emitAck<{ ok: boolean; error?: string }>("messages:mark_read", { from });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url = `${API_BASE}/api/messages/mark_read`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ from }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
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
  socket.emit("message:read", { messageId, from });
}

/** Сообщить серверу, что пользователь смотрит чат с peerId (или не смотрит, если null). Пуш о новом сообщении в этот чат не отправляется (как в Telegram). */
export function sendChatViewing(peerId: string | null) {
  try {
    socket.emit("chat:viewing", { with: peerId ?? null });
  } catch {}
}

export function sendChatTyping(payload: { to: string; typing?: boolean; recording?: boolean }) {
  try {
    if (__DEV__) {
      try {
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          throw new Error("__skip_dev_typing_log__");
        }
        const to = String(payload.to || "");
        const typing = !!payload.typing;
        const key = `send:${to}`;
        const prev = shared.devTypingLogState.get(key);
        if (prev !== typing) {
          shared.devTypingLogState.set(key, typing);
          console.log(`[chat:typing] send ${typing ? "1" : "0"} -> ${to}`);
        }
      } catch {}
    }
    socket.emit("chat:typing", {
      to: payload.to,
      typing: !!payload.typing,
      recording: payload.recording === undefined ? undefined : !!payload.recording,
    });
  } catch {}
}

export function onChatTyping(
  cb: (data: { from: string; to: string; typing: boolean; recording?: boolean; ts?: string }) => void,
): () => void {
  const h = (data: any) => {
    if (__DEV__) {
      try {
        const DEV_LOG_CHAT_TYPING = false;
        if (!DEV_LOG_CHAT_TYPING) {
          throw new Error("__skip_dev_typing_log__");
        }
        const from = String(data?.from || "");
        const to = String(data?.to || "");
        const typing = !!data?.typing;
        const key = `recv:${from}->${to}`;
        const prev = shared.devTypingLogState.get(key);
        if (prev !== typing) {
          shared.devTypingLogState.set(key, typing);
          console.log(`[chat:typing] recv ${typing ? "1" : "0"} ${from} -> ${to}`);
        }
      } catch {}
    }
    cb(data);
  };
  socket.on("chat:typing", h);
  return () => {
    socket.off("chat:typing", h);
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
        type: "text" | "image" | "audio" | "sticker";
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
    }>("messages:fetch", payload);

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

    const url =
      `${API_BASE}/api/messages?with=${encodeURIComponent(String(payload.with))}` +
      `&limit=${encodeURIComponent(String(payload.limit ?? 50))}` +
      (payload.before ? `&before=${encodeURIComponent(String(payload.before))}` : "");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return { ok: false, error: `http_${res.status}${txt ? `:${txt}` : ""}` };
      }
      return await res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return (async () => {
    try {
      const r: any = await viaSocket();
      if (r?.ok === true) return r;
      return await viaHttp();
    } catch {
      return await viaHttp();
    }
  })();
}

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
  const payload = ids?.length ? { fromIds: ids } : {};
  const viaSocket = () =>
    emitAck<{
      ok: boolean;
      counts?: Record<string, number>;
      error?: string;
    }>("messages:unread_counts", payload, 12000, 2);

  return (async () => {
    try {
      return await viaSocket();
    } catch (e: any) {
      const msg = String(e?.message || e || "");
      const retriable = msg.includes("offline") || msg.includes("timeout") || msg.includes("Ack timeout");
      if (!retriable) throw e;
      try {
        await waitForConnect(20000);
      } catch {
        throw e;
      }
      return viaSocket();
    }
  })();
}

export function onMessageReceived(
  cb: (message: {
    id: string;
    from: string;
    to: string;
    type: "text" | "image" | "audio" | "sticker";
    text?: string;
    uri?: string;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    timestamp: string;
    read: boolean;
  }) => void,
): () => void {
  const h = (message: any) => {
    cb(message);
  };
  socket.on("message:received", h);
  return () => {
    socket.off("message:received", h);
  };
}

export function onChatCleared(
  cb: (data: { by: string; with: string }) => void,
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:chat_cleared", h);
  return () => {
    socket.off("message:chat_cleared", h);
  };
}

export function onMessageDeleted(
  cb: (data: { messageId: string; deletedBy: string }) => void,
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:deleted", h);
  return () => {
    socket.off("message:deleted", h);
  };
}

export function onMessagesDeleted(
  cb: (data: { messageIds: string[]; deletedBy: string }) => void,
): () => void {
  const h = (data: any) => cb(data);
  socket.on("messages:deleted", h);
  return () => {
    socket.off("messages:deleted", h);
  };
}

export function onMessageReadReceipt(
  cb: (receipt: {
    messageId: string;
    readBy: string;
    timestamp: string;
  }) => void,
): () => void {
  const single = (receipt: any) => cb(receipt);
  const batch = (receipt: any) => {
    const messageIds = Array.isArray(receipt?.messageIds) ? receipt.messageIds : [];
    for (const messageId of messageIds) {
      cb({
        messageId: String(messageId),
        readBy: String(receipt?.readBy || ""),
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
    { messageId, emoji, with: withPeerId },
  );
}

export function onMessageReaction(
  cb: (data: { messageId: string; reactions: { emoji: string; userId: string }[] }) => void,
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:reaction", h);
  return () => socket.off("message:reaction", h);
}

export function getUnreadMessageCount(fromUserId: string) {
  return emitAck<{ ok: boolean; count?: number; error?: string }>(
    "message:unread_count",
    { from: fromUserId },
  );
}

export function loadMessagesFromServer(fromUserId: string, limit?: number) {
  return fetchMessages({ with: fromUserId, limit });
}

// Server history REMOVED - using local storage only
export async function getChatHistory(peerId: string): Promise<any[]> {
  return [];
}

export async function ensureGloballyDeletedMessageIdsLoaded(): Promise<Set<string>> {
  if (shared.globallyDeletedMessageIdsMem) return shared.globallyDeletedMessageIdsMem;
  if (shared.globallyDeletedMessageIdsLoadPromise) return shared.globallyDeletedMessageIdsLoadPromise;
  shared.globallyDeletedMessageIdsLoadPromise = (async () => {
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
    shared.globallyDeletedMessageIdsMem = set;
    return set;
  })();
  return shared.globallyDeletedMessageIdsLoadPromise;
}

export function isGloballyDeletedMessageId(messageId: string): boolean {
  const id = trimMessageId(messageId);
  if (!id) return false;
  return shared.globallyDeletedMessageIdsMem?.has(id) ?? false;
}

export function filterOutGloballyDeletedMessages<T extends { id?: unknown }>(messages: T[]): T[] {
  const tombstones = shared.globallyDeletedMessageIdsMem;
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
    logger.warn("[messages] failed to persist globally deleted message ids:", error);
  }
}

void ensureGloballyDeletedMessageIdsLoaded();

// Очистка кэша для конкретного чата (при получении новых сообщений)
export function clearMessageCache(peerId: string, userId?: string) {
  const currentUser = userId || shared.currentUserId;
  if (!currentUser || !peerId) return;

  const cacheKey = `${currentUser}-${peerId}`;
  shared.messageCache.delete(cacheKey);
}

async function removeDeletedMessagesFromLocalStorage(rawIds: readonly string[]): Promise<void> {
  const ids = new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean));
  if (ids.size === 0) return;

  await rememberGloballyDeletedMessageIds([...ids]);

  try {
    for (const [cacheKey, cached] of Array.from(shared.messageCache.entries())) {
      const before = Array.isArray(cached?.messages) ? cached.messages : [];
      const next = before.filter((msg: any) => !ids.has(String(msg?.id || "").trim()));
      if (next.length !== before.length) {
        shared.messageCache.set(cacheKey, { ...cached, messages: next, timestamp: Date.now() });
      }
    }
  } catch {}

  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((key) => String(key || "").startsWith("chat_messages_"));
    if (keys.length === 0) return;
    const rows = await AsyncStorage.multiGet(keys);
    await Promise.all(
      rows.map(async ([key, value]) => {
        if (!key || !value) return;
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) return;
          const next = parsed.filter((msg: any) => !ids.has(String(msg?.id || "").trim()));
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
    logger.warn("[messages] failed to remove deleted messages from local storage:", error);
  }
}

const deleteCleanupGlobal = globalThis as any;
if (!deleteCleanupGlobal.__liviMessageDeleteCacheCleanupRegistered) {
  deleteCleanupGlobal.__liviMessageDeleteCacheCleanupRegistered = true;
  socket.on("message:deleted", (data: any) => {
    void removeDeletedMessagesFromLocalStorage([String(data?.messageId || "")]);
  });
  socket.on("messages:deleted", (data: any) => {
    const ids = Array.isArray(data?.messageIds) ? data.messageIds.map((id: any) => String(id || "")) : [];
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
        if (msg.sender === "me") {
          correctedMsg.from = currentUser;
          correctedMsg.to = peerId;
        } else if (msg.sender === "peer") {
          correctedMsg.from = peerId;
          correctedMsg.to = currentUser;
        }
      }
      return {
        ...correctedMsg,
        timestamp: new Date(msg.timestamp),
        sender: correctedMsg.from === currentUser ? "me" : "peer",
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
    let currentUser = userId || shared.currentUserId;
    if (!currentUser) {
      const raw = await AsyncStorage.getItem("userId");
      if (raw && /^[a-f\d]{24}$/i.test(String(raw))) {
        currentUser = String(raw);
      }
    }
    if (!currentUser || !peerId) return [];

    const cacheKey = `${currentUser}-${peerId}`;
    const now = Date.now();
    const cached = shared.messageCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_DURATION) {
      return cached.messages;
    }

    const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
    const savedMessages = await AsyncStorage.getItem(chatKey);
    if (!savedMessages) return [];

    const messagesWithDates = parseStoredChatMessagesJson(savedMessages, currentUser, peerId);
    shared.messageCache.set(cacheKey, { messages: messagesWithDates, timestamp: now });
    return messagesWithDates;
  } catch (error) {
    console.warn("getChatMessagesLocal failed:", error);
    return [];
  }
}

// Очистка всего кэша сообщений
export function clearAllMessageCache() {
  shared.messageCache.clear();
}

// Очистить переписку с пользователем
export async function clearChatMessages(peerId: string, forAll: boolean = true): Promise<boolean> {
  try {
    const viaSocket = async () => {
      const result = await emitAck("message:clear_chat", { with: peerId, forAll });
      return !!result?.ok;
    };

    const viaHttp = async () => {
      const installId = await getInstallId().catch(() => "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (installId) headers["x-install-id"] = String(installId);
      if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

      const url = `${API_BASE}/api/messages/clear_chat`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: "POST",
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
      clearMessageCache(peerId);

      const currentUser = shared.currentUserId;
      if (currentUser) {
        const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
        await AsyncStorage.removeItem(chatKey);
      }

      return true;
    }
    return false;
  } catch (error) {
    console.error("Failed to clear chat messages:", error);
    return false;
  }
}

// Удалить одно сообщение
export async function deleteMessage(messageId: string): Promise<boolean> {
  try {
    const viaSocket = async () => {
      return await emitAck<{ ok: boolean; error?: string }>("message:delete", { messageId });
    };

    const viaHttp = async (): Promise<{ ok: boolean; error?: string }> => {
      const installId = await getInstallId().catch(() => "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (installId) headers["x-install-id"] = String(installId);
      if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

      const url = `${API_BASE}/api/messages/delete`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ messageId }),
          signal: controller.signal,
        });
        if (!res.ok) return { ok: false, error: "network" };
        const data = await res.json().catch(() => null);
        return { ok: !!data?.ok, error: data?.error ? String(data.error) : undefined };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const finishOk = async () => {
      await rememberGloballyDeletedMessageIds([messageId]);
      return true;
    };

    try {
      const r: any = await viaSocket();
      if (r?.ok === true) return finishOk();
      if (r?.ok === false && String(r?.error || "") === "not_found") return finishOk();
      const http = await viaHttp();
      if (http.ok) return finishOk();
      if (!http.ok && String(http.error || "") === "not_found") return finishOk();
      return false;
    } catch {
      const http = await viaHttp();
      if (http.ok) return finishOk();
      if (!http.ok && String(http.error || "") === "not_found") return finishOk();
      return false;
    }
  } catch (error) {
    console.error("Failed to delete message:", error);
    return false;
  }
}

export type DeleteMessagesBatchResult = {
  deletedIds: string[];
  failedIds: string[];
  error?: string;
};

export async function deleteMessages(messageIds: string[]): Promise<DeleteMessagesBatchResult> {
  try {
    const normalized = Array.from(new Set((messageIds || []).map((id) => String(id || "").trim()).filter(Boolean)));
    if (normalized.length === 0) return { deletedIds: [], failedIds: [] };

    const viaSocket = async () => {
      return await emitAck<{ ok: boolean; deletedIds?: string[]; failedIds?: string[]; error?: string }>("messages:delete", {
        messageIds: normalized,
      });
    };

    const viaHttp = async (): Promise<DeleteMessagesBatchResult> => {
      const installId = await getInstallId().catch(() => "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (installId) headers["x-install-id"] = String(installId);
      if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);

      const url = `${API_BASE}/api/messages/delete_many`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ messageIds: normalized }),
          signal: controller.signal,
        });
        if (!res.ok) {
          return { deletedIds: [], failedIds: normalized, error: "network" };
        }
        const data = await res.json().catch(() => null);
        return {
          deletedIds: Array.isArray(data?.deletedIds) ? data.deletedIds.map(String) : [],
          failedIds: Array.isArray(data?.failedIds) ? data.failedIds.map(String) : [],
          error: data?.error ? String(data.error) : undefined,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const buildResult = async (partial: DeleteMessagesBatchResult): Promise<DeleteMessagesBatchResult> => {
      const deletedIds = partial.deletedIds.map(String);
      const failedIds = partial.failedIds.map(String);
      const tombstones = [...deletedIds];
      if (!partial.error || partial.error === "not_found") {
        tombstones.push(...failedIds);
      }
      if (tombstones.length > 0) {
        await rememberGloballyDeletedMessageIds(tombstones);
      }
      return { deletedIds, failedIds, error: partial.error };
    };

    try {
      const r: any = await viaSocket();
      const deletedFromSocket = Array.isArray(r?.deletedIds) ? r.deletedIds.map(String) : [];
      const failedFromSocket = Array.isArray(r?.failedIds) ? r.failedIds.map(String) : [];
      if (r?.ok === true || deletedFromSocket.length > 0 || failedFromSocket.length > 0) {
        return buildResult({
          deletedIds: deletedFromSocket,
          failedIds: failedFromSocket.length > 0
            ? failedFromSocket
            : normalized.filter((id) => !deletedFromSocket.includes(String(id))),
          error: r?.error ? String(r.error) : undefined,
        });
      }
      return buildResult(await viaHttp());
    } catch {
      return buildResult(await viaHttp());
    }
  } catch (error) {
    console.error("Failed to delete messages:", error);
    return {
      deletedIds: [],
      failedIds: Array.from(new Set((messageIds || []).map((id) => String(id || "").trim()).filter(Boolean))),
      error: "server_error",
    };
  }
}

/** Редактировать текстовое сообщение (только своё). При офлайне ставит в очередь — после connect уйдёт через drainEditOutbox. */
export async function editMessage(
  messageId: string,
  text: string,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  const trimmedMid = String(messageId || "").trim();
  const trimmedText = String(text ?? "");
  if (!trimmedMid) return { ok: false, error: "no_messageId" };

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
    emitAck<{ ok: boolean; error?: string }>("message:edit", {
      messageId: trimmedMid,
      text: trimmedText,
    });

  const viaHttp = async () => {
    const installId = await getInstallId().catch(() => "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (installId) headers["x-install-id"] = String(installId);
    if (shared.currentUserId) headers["x-user-id"] = String(shared.currentUserId);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(`${API_BASE}/api/messages/edit`, {
        method: "POST",
        headers,
        body: JSON.stringify({ messageId: trimmedMid, text: trimmedText }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, error: `http_${res.status}` };
      const data = await res.json().catch(() => null);
      return data?.ok ? { ok: true } : { ok: false, error: data?.error || "unknown" };
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
    return { ok: false, error: (http as any)?.error || "edit_failed" };
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
      return { ok: false, error: (http as any)?.error || "edit_failed" };
    } catch (e: any) {
      if (isLikelyOfflineError(e)) {
        return await queueOffline();
      }
      if (await mergePendingMessageOutboxEdit(trimmedMid, trimmedText)) {
        return { ok: true };
      }
      return { ok: false, error: e?.message || "network_error" };
    }
  }
}

export function onMessageEdited(cb: (data: { messageId: string; text: string }) => void): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:edited", h);
  return () => {
    socket.off("message:edited", h);
  };
}

/** Update album URIs (remove one photo). Empty uris deletes the whole message on server. */
export async function updateMessageUris(messageId: string, uris: string[]): Promise<{
  ok: boolean;
  deleted?: boolean;
  uri?: string;
  uris?: string[];
  error?: string;
}> {
  const mid = String(messageId || "").trim();
  if (!mid) return { ok: false, error: "bad_request" };
  const normalized = (Array.isArray(uris) ? uris : [])
    .map((u) => String(u || "").trim())
    .filter(Boolean)
    .slice(0, 10);
  try {
    const r = await emitAck<any>("message:update_uris", { messageId: mid, uris: normalized }, 12000);
    return r && typeof r === "object" ? r : { ok: false, error: "bad_response" };
  } catch (e: any) {
    return { ok: false, error: e?.message || "network_error" };
  }
}

export function onMessageUrisUpdated(
  cb: (data: { messageId: string; uri?: string; uris?: string[]; deleted?: boolean }) => void,
): () => void {
  const h = (data: any) => cb(data);
  socket.on("message:uris_updated", h);
  return () => {
    socket.off("message:uris_updated", h);
  };
}

// Загрузка всех сообщений для чата (с кэшированием)
export async function getChatMessages(peerId: string, userId?: string): Promise<any[]> {
  try {
    let currentUser = userId || shared.currentUserId;

    // Если нет userId, принудительно получаем его
    if (!currentUser) {
      const identity = await import("./identity");
      const fetchedUserId = await identity.getMyUserId();
      if (!fetchedUserId) {
        console.warn("🔍 getChatMessages: still no userId after fetch");
        return [];
      }
      currentUser = fetchedUserId;
    }

    if (!currentUser || !peerId) return [];

    const cacheKey = `${currentUser}-${peerId}`;
    const now = Date.now();

    // Проверяем кэш
    const cached = shared.messageCache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_DURATION) {
      return cached.messages;
    }

    // Сначала пытаемся загрузить из локального хранилища (быстрее)
    const chatKey = globalMessageStorage.getChatKey(currentUser, peerId);
    const savedMessages = await AsyncStorage.getItem(chatKey);

    if (savedMessages) {
      const messagesWithDates = parseStoredChatMessagesJson(savedMessages, currentUser, peerId);
      shared.messageCache.set(cacheKey, { messages: messagesWithDates, timestamp: now });
      return messagesWithDates;
    }

    const response = await loadMessagesFromServer(peerId, 100);

    if (response.ok && response.messages && response.messages.length > 0) {
      const messagesWithSender = response.messages.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp),
        sender: msg.from === currentUser ? "me" : "peer",
      }));

      await AsyncStorage.setItem(chatKey, JSON.stringify(messagesWithSender));
      shared.messageCache.set(cacheKey, { messages: messagesWithSender, timestamp: now });

      return messagesWithSender;
    }

    return [];
  } catch (error) {
    console.warn("Failed to load chat messages:", error);
    return [];
  }
}
