import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useChatPreviews(friendIds: string[], lang: Lang, enabled: boolean) {
  const [previews, setPreviews] = useState<Record<string, ChatPreview>>({});
  const idsKey = friendIds.join('|');
  const idsRef = useRef(friendIds);
  const langRef = useRef(lang);

  useEffect(() => {
    idsRef.current = friendIds;
  }, [friendIds]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

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
    setPreviews(next);
  }, [enabled, idsKey]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return;
    const offReceived = onMessageReceived((message) => {
      const me = String(getCurrentUserId() || '');
      const from = String(message?.from || '');
      const to = String(message?.to || '');
      const peerId = from && from === me ? to : from;
      if (!peerId || !idsRef.current.includes(peerId)) return;
      const at = messageTimestampMs(message) || Date.now();
      const text = previewTextFromMessage(message, langRef.current);
      setPreviews((prev) => ({ ...prev, [peerId]: { text, at } }));
    });
    const offCleared = onChatCleared((data) => {
      const me = String(getCurrentUserId() || '');
      const by = String(data?.by || '');
      const withId = String(data?.with || '');
      const peerId = by === me ? withId : by;
      if (!peerId) return;
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
  }, [enabled]);

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
      return changed ? next : prev;
    });
  }, []);

  return { previews, reloadPreviews: reload, dropPreviews };
}
