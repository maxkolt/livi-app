import type { ChatMessage } from '../../chat/chatMessageTypes';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  fetchChatPreviews,
  getChatMessagesLocal,
  getCurrentUserId,
  globalMessageStorage,
  isMessagePendingInOutbox,
  onChatCleared,
  onMessageReadReceipt,
  onMessageReceived,
  onOutboxMessageDelivered,
  onOutboxMessageFailed,
  onOutboxPendingChange,
  persistOutgoingReadStatus,
} from '../../../sockets/socket';
import type { Lang } from '../../../utils/i18n';
import {
  keepReadStatus,
  outgoingPreviewStatus,
  pickLatestMessage,
  previewTextFromMessage,
  messageTimestampMs,
  type ChatPreview,
} from '../chatPreview';
import { getChatStatusesKey } from '../../chat/chatStorageKeys';
import { onChatCallStatusMessage } from '../../../utils/globalEvents';
import {
  getClearedForMePeerIds,
  markChatsClearedForMe,
  unmarkChatsClearedForMe,
} from '../chatClearedForMe';

export type { ChatPreview };

let previewMemory: Record<string, ChatPreview> = {};
/** Хуки вкладки, которым нужен результат prefetch (в т.ч. скрытая keep-alive вкладка). */
const prefetchListeners = new Set<() => void>();

function getChatPreviewSnapshot(): Record<string, ChatPreview> {
  return previewMemory;
}

function notifyPreviewListeners(): void {
  prefetchListeners.forEach((listener) => {
    try {
      listener();
    } catch {}
  });
}

/** Квитанции о прочтении за сессию: превью могло собраться из кэша, где read ещё false. */
const readReceiptIds = new Set<string>();

function rememberReadReceipt(messageId: string): void {
  readReceiptIds.add(messageId);
  if (readReceiptIds.size > 5000) {
    const oldest = readReceiptIds.values().next().value;
    if (oldest !== undefined) readReceiptIds.delete(oldest);
  }
}

/** Превью строки + статус своего последнего сообщения (значок слева от времени). */
function previewWithStatus(msg: ChatMessage | null | undefined, text: string, at: number, saved?: string): ChatPreview {
  const id = String(msg?.id || '').trim();
  const status = outgoingPreviewStatus(msg, String(getCurrentUserId() || '').trim(), {
    pending: !!id && isMessagePendingInOutbox(id),
    readReceipt: !!id && readReceiptIds.has(id),
    saved,
  });
  const preview: ChatPreview = { text, at };
  if (id) preview.id = id;
  if (status) preview.status = status;
  return preview;
}

/** Статус облака, сохранённый чатом или очередью (пишется и при закрытом чате). */
async function readSavedOutgoingStatus(peerId: string, msg: ChatMessage | null | undefined): Promise<string | undefined> {
  const me = String(getCurrentUserId() || '').trim();
  const id = String(msg?.id || '').trim();
  if (!me || !id || !outgoingPreviewStatus(msg, me, { pending: false, readReceipt: false })) {
    return undefined;
  }
  try {
    const raw = await AsyncStorage.getItem(getChatStatusesKey(me, peerId));
    const saved = raw ? JSON.parse(raw)?.[id] : undefined;
    return typeof saved === 'string' ? saved : undefined;
  } catch {
    return undefined;
  }
}

async function previewFromLocalHistory(peerId: string, lang: Lang): Promise<ChatPreview | null> {
  const messages = await getChatMessagesLocal(peerId);
  const last = pickLatestMessage(messages);
  if (!last) return null;
  const saved = await readSavedOutgoingStatus(peerId, last);
  return previewWithStatus(last, previewTextFromMessage(last, lang), messageTimestampMs(last), saved);
}

/** Обновить превью в памяти по событию (квитанция, очередь) и разослать вкладкам. */
function patchPreviewMemory(update: (preview: ChatPreview, peerId: string) => ChatPreview | null): void {
  let next: Record<string, ChatPreview> | null = null;
  for (const peerId of Object.keys(previewMemory)) {
    const updated = update(previewMemory[peerId], peerId);
    if (!updated) continue;
    next = next || { ...previewMemory };
    next[peerId] = updated;
  }
  if (!next) return;
  previewMemory = next;
  notifyPreviewListeners();
}

/**
 * Оптимистичная исходящая (в т.ч. без сети): сразу обновить строку в «Чаты»,
 * не дожидаясь message:received и не опираясь на устаревший messageCache.
 */
export function noteLocalChatPreview(peerId: string, message: unknown, lang: Lang): void {
  const id = String(peerId || "").trim();
  if (!id || !message) return;
  const at = messageTimestampMs(message) || Date.now();
  const text = previewTextFromMessage(message, lang);
  const prev = previewMemory[id];
  if (prev && prev.at > at) return;
  previewMemory = { ...previewMemory, [id]: keepReadStatus(prev, previewWithStatus(message, text, at)) };
  void unmarkChatsClearedForMe([id]);
  notifyPreviewListeners();
}

function previewFromServerMessage(msg: ChatMessage | null | undefined, lang: Lang): ChatPreview | null {
  if (!msg?.id) return null;
  const at = messageTimestampMs(msg);
  const text = previewTextFromMessage(msg, lang);
  if (!at && !text) return null;
  return previewWithStatus(msg, text, at || Date.now());
}

async function hydrateMissingPreviewsFromServer(
  friendIds: string[],
  local: Record<string, ChatPreview>,
  lang: Lang,
): Promise<Record<string, ChatPreview>> {
  const missing = friendIds.filter((id) => !local[id]);
  if (!missing.length) return local;

  let cleared: Set<string>;
  try {
    cleared = await getClearedForMePeerIds();
  } catch {
    cleared = new Set();
  }
  const toFetch = missing.filter((id) => !cleared.has(id));
  if (!toFetch.length) return local;

  try {
    const result = await fetchChatPreviews(toFetch);
    if (!result?.ok || !result.previews) return local;
    const next = { ...local };
    const me = String(getCurrentUserId() || '').trim();
    for (const peerId of toFetch) {
      const msg = result.previews[peerId];
      const preview = previewFromServerMessage(msg, lang);
      if (!preview) continue;
      next[peerId] = preview;
      if (me && msg) {
        void globalMessageStorage.saveMessage(msg, me).catch(() => {});
      }
    }
    return next;
  } catch {
    return local;
  }
}

function mergeLiveMemory(
  ids: string[],
  base: Record<string, ChatPreview>,
): Record<string, ChatPreview> {
  const next = { ...base };
  for (const id of ids) {
    const mem = previewMemory[id];
    if (!mem) continue;
    if (!next[id] || mem.at >= (next[id]?.at || 0)) {
      next[id] = keepReadStatus(next[id], mem);
    }
  }
  return next;
}

function previewMapsEqual(
  a: Record<string, ChatPreview>,
  b: Record<string, ChatPreview>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      a[key]?.at === b[key]?.at &&
      a[key]?.text === b[key]?.text &&
      a[key]?.id === b[key]?.id &&
      a[key]?.status === b[key]?.status,
  );
}

/** Prefetch до открытия вкладки Chat — первый paint с полными превью. */
export async function prefetchChatPreviews(friendIds: string[], lang: Lang): Promise<void> {
  const ids = friendIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return;
  const next: Record<string, ChatPreview> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const preview = await previewFromLocalHistory(id, lang);
        if (preview) next[id] = preview;
      } catch {
        // skip
      }
    }),
  );
  // Локальные превью — сразу: за VPN ответ сервера для недостающих идёт секундами,
  // а вкладка всё это время оставалась бы пустой.
  previewMemory = mergeLiveMemory(ids, next);
  notifyPreviewListeners();
  const hydrated = await hydrateMissingPreviewsFromServer(ids, next, lang);
  previewMemory = mergeLiveMemory(ids, hydrated);
  notifyPreviewListeners();
}

export function useChatPreviews(friendIds: string[], lang: Lang, enabled: boolean) {
  // Скрытая вкладка (prewarm) держит превью в синхроне с memory: строки, рамки и
  // аватары монтируются заранее, а не в момент тапа. Перезагрузки — только когда enabled.
  const [previews, setPreviews] = useState<Record<string, ChatPreview>>(() => ({
    ...getChatPreviewSnapshot(),
  }));

  // Холодный старт: вкладка монтируется после splash, prefetch мог ещё не закончиться.
  // Без этого скрытая вкладка оставалась пустой и при тапе мигала «Пока нет чатов».
  useEffect(() => {
    const applySnapshot = () => {
      const snap = getChatPreviewSnapshot();
      setPreviews((prev) => (previewMapsEqual(prev, snap) ? prev : { ...snap }));
    };
    prefetchListeners.add(applySnapshot);
    applySnapshot();
    return () => {
      prefetchListeners.delete(applySnapshot);
    };
  }, []);
  const idsKey = friendIds.join('|');
  const idsRef = useRef(friendIds);
  const langRef = useRef(lang);
  const reloadPromiseRef = useRef<Promise<void> | null>(null);
  const lastReloadCompletedAtRef = useRef(0);

  useEffect(() => {
    idsRef.current = friendIds;
  }, [friendIds]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const reload = useCallback((): Promise<void> => {
    if (reloadPromiseRef.current) return reloadPromiseRef.current;
    if (Date.now() - lastReloadCompletedAtRef.current < 750) return Promise.resolve();

    let tracked: Promise<void>;
    const task = (async () => {
      const ids = idsRef.current;
      if (!enabled || ids.length === 0) {
        if (!ids.length) setPreviews((prev) => (Object.keys(prev).length ? {} : prev));
        return;
      }
      const next: Record<string, ChatPreview> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const preview = await previewFromLocalHistory(id, langRef.current);
            if (preview) next[id] = preview;
          } catch {
            // keep missing preview
          }
        }),
      );
      // Не затирать более свежий live-preview (message:received), если persist ещё догоняет.
      const withLive = mergeLiveMemory(ids, next);
      const hydrated = await hydrateMissingPreviewsFromServer(ids, withLive, langRef.current);
      const finalMap = mergeLiveMemory(ids, hydrated);
      previewMemory = finalMap;
      setPreviews((prev) => (previewMapsEqual(prev, finalMap) ? prev : finalMap));
    })();
    tracked = task.finally(() => {
      lastReloadCompletedAtRef.current = Date.now();
      if (reloadPromiseRef.current === tracked) reloadPromiseRef.current = null;
    });
    reloadPromiseRef.current = tracked;
    return tracked;
  }, [enabled, idsKey]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const snap = getChatPreviewSnapshot();
    if (Object.keys(snap).length) {
      setPreviews((prev) => (previewMapsEqual(prev, snap) ? prev : { ...snap }));
    }
  }, [enabled, idsKey]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  // Слушаем всегда: иначе при выключенной вкладке Чаты memory/превью не обновляются,
  // а unread растёт → после открытия вкладки reload показывает своё последнее исходящее.
  // Состояние обновляем и у скрытой вкладки: иначе первый кадр после тапа показывал
  // старый список, а новая строка вставлялась следующим коммитом.
  useEffect(() => {
    const offReceived = onMessageReceived((message) => {
      const me = String(getCurrentUserId() || '');
      const from = String(message?.from || '');
      const to = String(message?.to || '');
      const peerId = from && from === me ? to : from;
      if (!peerId) return;
      void unmarkChatsClearedForMe([peerId]);
      if (idsRef.current.length && !idsRef.current.includes(peerId)) return;
      const at = messageTimestampMs(message) || Date.now();
      const text = previewTextFromMessage(message, langRef.current);
      const preview = keepReadStatus(previewMemory[peerId], previewWithStatus(message, text, at));
      previewMemory = { ...previewMemory, [peerId]: preview };
      setPreviews((prev) => ({ ...prev, [peerId]: preview }));
    });
    const offCleared = onChatCleared((data) => {
      const me = String(getCurrentUserId() || '');
      const by = String(data?.by || '');
      const withId = String(data?.with || '');
      const peerId = by === me ? withId : by;
      if (!peerId) return;
      // clear «для себя» — серверный lastMessage остаётся; не поднимать строку снова.
      if (!(data)?.forAll) {
        void markChatsClearedForMe([peerId]);
      }
      if (previewMemory[peerId]) {
        const mem = { ...previewMemory };
        delete mem[peerId];
        previewMemory = mem;
      }
      setPreviews((prev) => {
        if (!prev[peerId]) return prev;
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    });
    const offCallStatus = onChatCallStatusMessage(({ peerId, message }) => {
      const id = String(peerId || '').trim();
      if (!id) return;
      if (idsRef.current.length && !idsRef.current.includes(id)) return;
      const at = messageTimestampMs(message) || Date.now();
      const text = previewTextFromMessage(message, langRef.current);
      const preview = previewWithStatus(message, text, at);
      previewMemory = { ...previewMemory, [id]: preview };
      setPreviews((prev) => ({ ...prev, [id]: preview }));
    });
    // Статус своего последнего сообщения меняется без нового сообщения: прочитано, ушло из очереди.
    const offReadReceipt = onMessageReadReceipt(({ messageId }) => {
      const mid = String(messageId || '').trim();
      if (!mid) return;
      rememberReadReceipt(mid);
      patchPreviewMemory((p, peerId) => {
        if (p.id !== mid || !p.status || p.status === 'read') return null;
        void persistOutgoingReadStatus(peerId, mid);
        return { ...p, status: 'read' };
      });
    });
    const offOutboxPending = onOutboxPendingChange(() => {
      patchPreviewMemory((p) => {
        if (!p.id || !p.status || p.status === 'read') return null;
        const pending = isMessagePendingInOutbox(p.id);
        if (pending && p.status !== 'sending') return { ...p, status: 'sending' };
        if (!pending && p.status === 'sending') return { ...p, status: 'sent' };
        return null;
      });
    });
    const outboxIds = (d: { outboxId: string; optimisticUiId?: string }) =>
      [d.optimisticUiId, d.outboxId].map((x) => String(x || '').trim()).filter(Boolean);
    const offOutboxDelivered = onOutboxMessageDelivered((d) => {
      const ids = outboxIds(d);
      const serverId = String(d.serverMessageId || '').trim();
      patchPreviewMemory((p, peerId) => {
        if (peerId !== String(d.to || '').trim() || !p.id || !ids.includes(p.id)) return null;
        const id = serverId || p.id;
        const status = readReceiptIds.has(id) ? 'read' : 'sent';
        return p.id === id && p.status === status ? null : { ...p, id, status };
      });
    });
    const offOutboxFailed = onOutboxMessageFailed((f) => {
      const ids = outboxIds(f);
      patchPreviewMemory((p, peerId) =>
        peerId === String(f.to || '').trim() && p.id && ids.includes(p.id) && p.status !== 'failed'
          ? { ...p, status: 'failed' }
          : null,
      );
    });
    return () => {
      offReceived?.();
      offCleared?.();
      offCallStatus?.();
      offReadReceipt?.();
      offOutboxPending?.();
      offOutboxDelivered?.();
      offOutboxFailed?.();
    };
  }, []);

  const dropPreviews = useCallback((peerIds: string[]) => {
    const ids = new Set(peerIds.map((id) => String(id || '').trim()).filter(Boolean));
    if (ids.size === 0) return;
    void markChatsClearedForMe([...ids]);
    setPreviews((prev) => {
      let changed = false;
      const next = { ...prev };
      ids.forEach((id) => {
        if (next[id] == null) return;
        delete next[id];
        changed = true;
      });
      if (changed) {
        const mem = { ...previewMemory };
        ids.forEach((id) => {
          delete mem[id];
        });
        previewMemory = mem;
      }
      return changed ? next : prev;
    });
  }, []);

  return { previews, reloadPreviews: reload, dropPreviews };
}
