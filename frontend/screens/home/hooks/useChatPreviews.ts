import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  fetchChatPreviews,
  getChatMessagesLocal,
  getCurrentUserId,
  globalMessageStorage,
  onChatCleared,
  onMessageReceived,
} from '../../../sockets/socket';
import type { Lang } from '../../../utils/i18n';
import {
  pickLatestMessage,
  previewTextFromMessage,
  messageTimestampMs,
  type ChatPreview,
} from '../chatPreview';
import { onChatCallStatusMessage } from '../../../utils/globalEvents';
import {
  getClearedForMePeerIds,
  markChatsClearedForMe,
  unmarkChatsClearedForMe,
} from '../chatClearedForMe';

export type { ChatPreview };

let previewMemory: Record<string, ChatPreview> = {};

export function getChatPreviewSnapshot(): Record<string, ChatPreview> {
  return previewMemory;
}

function previewFromServerMessage(msg: any, lang: Lang): ChatPreview | null {
  if (!msg?.id) return null;
  const at = messageTimestampMs(msg);
  const text = previewTextFromMessage(msg, lang);
  if (!at && !text) return null;
  return { text, at: at || Date.now() };
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
      next[id] = mem;
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
  return aKeys.every((key) => a[key]?.at === b[key]?.at && a[key]?.text === b[key]?.text);
}

/** Prefetch до открытия вкладки Chat — первый paint с полными превью. */
export async function prefetchChatPreviews(friendIds: string[], lang: Lang): Promise<void> {
  const ids = friendIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length === 0) return;
  const next: Record<string, ChatPreview> = {};
  await Promise.all(
    ids.map(async (id) => {
      try {
        const messages = await getChatMessagesLocal(id);
        const last = pickLatestMessage(messages);
        if (!last) return;
        const at = messageTimestampMs(last);
        const text = previewTextFromMessage(last, lang);
        next[id] = { text, at };
      } catch {
        // skip
      }
    }),
  );
  const hydrated = await hydrateMissingPreviewsFromServer(ids, next, lang);
  previewMemory = mergeLiveMemory(ids, hydrated);
}

export function useChatPreviews(friendIds: string[], lang: Lang, enabled: boolean) {
  const [previews, setPreviews] = useState<Record<string, ChatPreview>>(() =>
    enabled ? { ...getChatPreviewSnapshot() } : {},
  );
  const idsKey = friendIds.join('|');
  const idsRef = useRef(friendIds);
  const langRef = useRef(lang);
  const enabledRef = useRef(enabled);
  const reloadPromiseRef = useRef<Promise<void> | null>(null);
  const lastReloadCompletedAtRef = useRef(0);

  useEffect(() => {
    idsRef.current = friendIds;
  }, [friendIds]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

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
            const messages = await getChatMessagesLocal(id);
            const last = pickLatestMessage(messages);
            if (!last) return;
            const at = messageTimestampMs(last);
            const text = previewTextFromMessage(last, langRef.current);
            next[id] = { text, at };
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
      previewMemory = { ...previewMemory, [peerId]: { text, at } };
      if (!enabledRef.current) return;
      setPreviews((prev) => ({ ...prev, [peerId]: { text, at } }));
    });
    const offCleared = onChatCleared((data) => {
      const me = String(getCurrentUserId() || '');
      const by = String(data?.by || '');
      const withId = String(data?.with || '');
      const peerId = by === me ? withId : by;
      if (!peerId) return;
      // clear «для себя» — серверный lastMessage остаётся; не поднимать строку снова.
      if (!(data as any)?.forAll) {
        void markChatsClearedForMe([peerId]);
      }
      if (previewMemory[peerId]) {
        const mem = { ...previewMemory };
        delete mem[peerId];
        previewMemory = mem;
      }
      if (!enabledRef.current) return;
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
      previewMemory = { ...previewMemory, [id]: { text, at } };
      if (!enabledRef.current) return;
      setPreviews((prev) => ({ ...prev, [id]: { text, at } }));
    });
    return () => {
      offReceived?.();
      offCleared?.();
      offCallStatus?.();
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
