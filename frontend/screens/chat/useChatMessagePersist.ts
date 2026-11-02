import type { ChatSessionState } from './useChatSessionState';
/** Debounced AsyncStorage persist queue for chat messages. */

import React from "react";
import { clearMessageCache } from "../../sockets/socket";
import type { Lang } from "../../utils/i18n";
import { pickLatestMessage } from "../home/chatPreview";
import { noteLocalChatPreview } from "../home/hooks/useChatPreviews";
import { getChatMessagesKey } from "./chatStorageKeys";
import { writeStoredChatMessages } from "./chatMessageStorageWrite";
import { createChatMessagePersistQueue, type ChatPersistSnapshot } from './chatMessagePersistQueue';

type Options = {
  session: ChatSessionState;
  lang: Lang;
};

export function useChatMessagePersist({ session, lang }: Options) {
  const {
    historyReady,
    messages,
    currentUserId,
    peerId,
    currentUserIdForPersistRef,
    peerIdForPersistRef,
    latestMessagesForPersistRef,
  } = session;
  const langRef = React.useRef(lang);
  langRef.current = lang;
  const readyRef = React.useRef(historyReady);
  readyRef.current = historyReady;
  const queueRef = React.useRef<ReturnType<typeof createChatMessagePersistQueue> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createChatMessagePersistQueue(
      ({ key, messages: snapshot }) => writeStoredChatMessages(key, snapshot),
      ({ peerId: pid, userId: uid, messages: snapshot, lang: snapshotLang }) => {
        clearMessageCache(pid, uid);
        const last = pickLatestMessage(snapshot);
        if (last) noteLocalChatPreview(pid, last, snapshotLang);
      },
    );
  }

  const flushMessagesPersist = React.useCallback(async (_reason: string) => {
    const uid = String(currentUserIdForPersistRef.current || "").trim();
    const pid = String(peerIdForPersistRef.current || "").trim();
    const msgs = latestMessagesForPersistRef.current;
    if (!readyRef.current || !uid || !pid || !Array.isArray(msgs)) return;
    const key = getChatMessagesKey(uid, pid);
    const snapshot: ChatPersistSnapshot = { key, userId: uid, peerId: pid, messages: msgs, lang: langRef.current };
    try {
      await queueRef.current!(snapshot);
    } catch (error) {
      console.warn("💾 Failed to save messages to AsyncStorage:", error);
    }
  }, [currentUserIdForPersistRef, peerIdForPersistRef, latestMessagesForPersistRef]);

  const enqueueMessagesPersist = React.useCallback(
    (reason: string) => {
      void flushMessagesPersist(reason);
    },
    [flushMessagesPersist],
  );

  const persistDebounceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistDebounceGenRef = React.useRef(0);

  // Debounced persist: keeps UI responsive during rapid send/receive.
  React.useEffect(() => {
    if (!currentUserId || !peerId) return;
    // Avoid writing previous chat's messages under the new peer's storage key while history reloads.
    if (!historyReady) return;
    persistDebounceGenRef.current += 1;
    const gen = persistDebounceGenRef.current;
    if (persistDebounceTimerRef.current) {
      clearTimeout(persistDebounceTimerRef.current);
      persistDebounceTimerRef.current = null;
    }
    persistDebounceTimerRef.current = setTimeout(() => {
      persistDebounceTimerRef.current = null;
      if (gen !== persistDebounceGenRef.current) return;
      enqueueMessagesPersist("debounced_effect");
    }, 400);
    return () => {
      if (persistDebounceTimerRef.current) {
        clearTimeout(persistDebounceTimerRef.current);
        persistDebounceTimerRef.current = null;
      }
    };
  }, [messages, currentUserId, peerId, enqueueMessagesPersist, historyReady]);

  React.useEffect(() => {
    return () => {
      enqueueMessagesPersist("unmount_flush");
    };
  }, [enqueueMessagesPersist]);

  return { enqueueMessagesPersist, flushMessagesPersist };
}
