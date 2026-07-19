/** Debounced AsyncStorage persist queue for chat messages. */

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getChatMessagesKey } from "./chatStorageKeys";

type Options = {
  historyReady: boolean;
  messages: any[];
  currentUserId: string | null;
  peerId: string;
  currentUserIdForPersistRef: React.MutableRefObject<string | null>;
  peerIdForPersistRef: React.MutableRefObject<string>;
  latestMessagesForPersistRef: React.MutableRefObject<any[]>;
};

export function useChatMessagePersist({
  historyReady,
  messages,
  currentUserId,
  peerId,
  currentUserIdForPersistRef,
  peerIdForPersistRef,
  latestMessagesForPersistRef,
}: Options) {
  const persistWriteTailRef = React.useRef<Promise<void>>(Promise.resolve());

  const flushMessagesPersist = React.useCallback(async (_reason: string) => {
    const uid = String(currentUserIdForPersistRef.current || "").trim();
    const pid = String(peerIdForPersistRef.current || "").trim();
    const msgs = latestMessagesForPersistRef.current;
    if (!uid || !pid || !Array.isArray(msgs)) return;
    const key = getChatMessagesKey(uid, pid);
    try {
      await AsyncStorage.setItem(key, JSON.stringify(msgs));
    } catch (error) {
      console.warn("💾 Failed to save messages to AsyncStorage:", error);
    }
  }, [currentUserIdForPersistRef, peerIdForPersistRef, latestMessagesForPersistRef]);

  const enqueueMessagesPersist = React.useCallback(
    (reason: string) => {
      persistWriteTailRef.current = persistWriteTailRef.current
        .then(() => flushMessagesPersist(reason))
        .catch(() => {});
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
