import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  getChatMessagesLocal,
  getCurrentUserId,
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

export type { ChatPreview };

let previewMemory: Record<string, ChatPreview> = {};

export function getChatPreviewSnapshot(): Record<string, ChatPreview> {
  return previewMemory;
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
  previewMemory = next;
}

export function useChatPreviews(friendIds: string[], lang: Lang, enabled: boolean) {
  const [previews, setPreviews] = useState<Record<string, ChatPreview>>(() =>
    enabled ? { ...getChatPreviewSnapshot() } : {},
  );
  const idsKey = friendIds.join('|');
  const idsRef = useRef(friendIds);
  const langRef = useRef(lang);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    idsRef.current = friendIds;
  }, [friendIds]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const reload = useCallback(async () => {
    const ids = idsRef.current;
    if (!enabled || ids.length === 0) {
      if (!ids.length) setPreviews({});
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
    for (const id of ids) {
      const mem = previewMemory[id];
      if (!mem) continue;
      if (!next[id] || mem.at >= (next[id]?.at || 0)) {
        next[id] = mem;
      }
    }
    previewMemory = next;
    setPreviews(next);
  }, [enabled, idsKey]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const snap = getChatPreviewSnapshot();
    if (Object.keys(snap).length) setPreviews({ ...snap });
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
    return () => {
      offReceived?.();
      offCleared?.();
    };
  }, []);

  const dropPreviews = useCallback((peerIds: string[]) => {
    const ids = new Set(peerIds.map((id) => String(id || '').trim()).filter(Boolean));
    if (ids.size === 0) return;
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
