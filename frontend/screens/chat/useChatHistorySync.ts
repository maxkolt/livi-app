/** History load + quiet sync + reconnect merge for ChatScreen. */

import React from "react";
import { AppState } from "react-native";
import socket, {
  fetchMessages,
  getChatMessages,
  getChatMessagesLocal,
  clearMessageCache,
  getCurrentUserId as getCurrentSocketUserId,
  isGloballyDeletedMessageId,
  markMessagesAsRead,
} from "../../sockets/socket";
import { logger } from "../../utils/logger";
import { dismissMessageNotificationForUser, syncAppBadgeFromMissedCount } from "../../utils/pushNotifications";
import { mergeChatReadStatuses } from "./chatMessageOps";
import {
  buildOutgoingReadStatusesFromHistory,
  fetchQuietSyncMessagePages,
  filterVisibleServerMessages,
  formatServerChatMessage,
  mergeInitialHistoryMessages,
  mergeQuietSyncMessages,
} from "./chatHistory";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  setCurrentUserId: React.Dispatch<React.SetStateAction<string | null>>;
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  messagesRef: React.MutableRefObject<any[]>;
  historyReady: boolean;
  setHistoryReady: React.Dispatch<React.SetStateAction<boolean>>;
  setChatImagesWarm: React.Dispatch<React.SetStateAction<boolean>>;
  setReadStatuses: React.Dispatch<React.SetStateAction<ReadStatusMap>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  loadStatuses: () => Promise<ReadStatusMap>;
  loadHiddenForMeMessageIds: (uid: string, pid: string) => Promise<Set<string>>;
  hiddenForMeMessageIdsRef: React.MutableRefObject<Set<string>>;
  deletedServerMessageIdsRef: React.MutableRefObject<Set<string>>;
  uploadStatusRef: React.MutableRefObject<Record<string, string | undefined>>;
  readStatusesRef: React.MutableRefObject<ReadStatusMap>;
  isFocusedRef: React.MutableRefObject<boolean>;
  enqueueMessagesPersist: (reason: string) => void;
  currentUserIdForPersistRef: React.MutableRefObject<string | null>;
  peerIdForPersistRef: React.MutableRefObject<string>;
  latestMessagesForPersistRef: React.MutableRefObject<any[]>;
  navigation: any;
  resolveMediaUri: (uri?: string) => string;
};

export function useChatHistorySync({
  peerId,
  currentUserId,
  setCurrentUserId,
  messages,
  setMessages,
  messagesRef,
  historyReady,
  setHistoryReady,
  setChatImagesWarm,
  setReadStatuses,
  updateReadStatuses,
  loadStatuses,
  loadHiddenForMeMessageIds,
  hiddenForMeMessageIdsRef,
  deletedServerMessageIdsRef,
  uploadStatusRef,
  readStatusesRef,
  isFocusedRef,
  enqueueMessagesPersist,
  currentUserIdForPersistRef,
  peerIdForPersistRef,
  latestMessagesForPersistRef,
  navigation,
  resolveMediaUri,
}: Options) {
  const lastQuietSyncAtRef = React.useRef(0);
  const quietSyncInFlightRef = React.useRef(false);
  const messagesLenRef = React.useRef(0);
  React.useEffect(() => {
    messagesLenRef.current = messages.length;
    messagesRef.current = messages;
  }, [messages, messagesRef]);

  const resolveMediaUriRef = React.useRef(resolveMediaUri);
  resolveMediaUriRef.current = resolveMediaUri;

  const loggedHistoryImageIdsRef = React.useRef<Set<string>>(new Set());
  const loggedHistoryImagesCountRef = React.useRef(0);

  const quietSyncChat = React.useCallback(async () => {
    try {
      if (!currentUserId || !peerId) return;
      if (quietSyncInFlightRef.current) return;
      const now = Date.now();
      if (now - lastQuietSyncAtRef.current < 1200) return;
      lastQuietSyncAtRef.current = now;
      quietSyncInFlightRef.current = true;

      const targetCount = Math.min(400, Math.max(60, Math.max(0, messagesLenRef.current)));
      const pages = await fetchQuietSyncMessagePages(peerId, targetCount, fetchMessages);
      if (pages.length === 0) return;

      const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
      const formatted = filterVisibleServerMessages(pages, {
        hiddenForMeIds,
        deletedServerIds: deletedServerMessageIdsRef.current,
        isGloballyDeleted: isGloballyDeletedMessageId,
      }).map((msg: any) => formatServerChatMessage(msg, String(currentUserId)));

      setMessages((prev) =>
        mergeQuietSyncMessages(prev, formatted, {
          uploadStatus: uploadStatusRef.current as any,
          readStatuses: readStatusesRef.current as any,
        }),
      );
    } catch {
    } finally {
      quietSyncInFlightRef.current = false;
    }
  }, [
    currentUserId,
    peerId,
    setMessages,
    hiddenForMeMessageIdsRef,
    deletedServerMessageIdsRef,
    uploadStatusRef,
    readStatusesRef,
  ]);

  const lastAppStatePersistAtRef = React.useRef(0);
  React.useEffect(() => {
    const appStateRef = { current: AppState.currentState };
    const sub = AppState.addEventListener("change", (state) => {
      const prev = appStateRef.current;
      const wasBg = /inactive|background/.test(String(prev || ""));
      appStateRef.current = state;
      if (state === "background" || state === "inactive") {
        const now = Date.now();
        if (now - lastAppStatePersistAtRef.current < 900) return;
        lastAppStatePersistAtRef.current = now;
        if (
          currentUserIdForPersistRef.current &&
          peerIdForPersistRef.current &&
          Array.isArray(latestMessagesForPersistRef.current)
        ) {
          enqueueMessagesPersist("appstate_background");
        }
      }
      if (wasBg && state === "active") {
        void quietSyncChat();
      }
    });
    return () => {
      try {
        sub.remove();
      } catch {}
    };
  }, [
    quietSyncChat,
    enqueueMessagesPersist,
    currentUserIdForPersistRef,
    peerIdForPersistRef,
    latestMessagesForPersistRef,
  ]);

  React.useEffect(() => {
    const unsub = navigation?.addListener?.("focus", () => {
      void quietSyncChat();
    });
    return () => {
      try {
        unsub?.();
      } catch {}
    };
  }, [navigation, quietSyncChat]);

  const prevPeerIdForHistoryRef = React.useRef<string | null>(null);
  const historySyncGenerationRef = React.useRef(0);

  React.useEffect(() => {
    if (!peerId) return;
    let uid = String(currentUserId || "").trim();
    if (!uid) {
      try {
        uid = String(getCurrentSocketUserId() || "").trim();
      } catch {}
    }
    if (!uid) return;
    if (!currentUserId && uid) {
      setCurrentUserId(uid);
    }
    const prevPeer = prevPeerIdForHistoryRef.current;
    if (prevPeer !== peerId) {
      prevPeerIdForHistoryRef.current = peerId;
      setMessages([]);
    }

    historySyncGenerationRef.current += 1;
    const syncGen = historySyncGenerationRef.current;
    const pid = peerId;

    const loadHistory = async () => {
      setHistoryReady(false);
      setChatImagesWarm(false);
      clearMessageCache(pid, uid);

      const fetchPromise = fetchMessages({ with: pid, limit: 50 }).catch(() => null);

      let localPreloaded = false;
      try {
        const [localMessages, savedStatuses, hiddenIds] = await Promise.all([
          getChatMessagesLocal(pid, uid),
          loadStatuses(),
          loadHiddenForMeMessageIds(uid, pid),
        ]);
        if (historySyncGenerationRef.current !== syncGen) return;
        hiddenForMeMessageIdsRef.current = hiddenIds;
        setReadStatuses(savedStatuses || {});
        const visibleLocalMessages = Array.isArray(localMessages)
          ? localMessages.filter((msg: any) => !hiddenIds.has(String(msg?.id || "").trim()))
          : [];
        if (visibleLocalMessages.length > 0) {
          setMessages(visibleLocalMessages);
          localPreloaded = true;
        }
      } catch {}

      if (historySyncGenerationRef.current !== syncGen) return;
      setHistoryReady(true);

      void (async () => {
        try {
          const serverMessages = await fetchPromise;
          if (historySyncGenerationRef.current !== syncGen) return;

          if (serverMessages?.ok && serverMessages.messages) {
            const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
            const visible = filterVisibleServerMessages(serverMessages.messages, {
              hiddenForMeIds,
              deletedServerIds: deletedServerMessageIdsRef.current,
              isGloballyDeleted: isGloballyDeletedMessageId,
            });
            const formattedMessages = visible.map((msg: any) => {
              if (msg.type === "image") {
                const mid = String(msg.id || "").trim();
                if (
                  __DEV__ &&
                  mid &&
                  !loggedHistoryImageIdsRef.current.has(mid) &&
                  loggedHistoryImagesCountRef.current < 1
                ) {
                  loggedHistoryImageIdsRef.current.add(mid);
                  loggedHistoryImagesCountRef.current += 1;
                  logger.info("[ChatScreen] Loading image message from history", {
                    messageId: msg.id,
                    from: msg.from,
                    to: msg.to,
                    uri: msg.uri,
                    resolvedUri: resolveMediaUriRef.current(msg.uri),
                    hasUri: !!msg.uri,
                  });
                }
              }
              return formatServerChatMessage(msg, uid);
            });

            setMessages((prev) =>
              mergeInitialHistoryMessages(prev, formattedMessages, {
                uploadStatus: uploadStatusRef.current as any,
                readStatuses: readStatusesRef.current as any,
              }),
            );

            await markMessagesAsRead(pid);
            try {
              await dismissMessageNotificationForUser(pid);
              await syncAppBadgeFromMissedCount();
            } catch {}

            try {
              const serverStatuses = buildOutgoingReadStatusesFromHistory(formattedMessages);
              const savedStatuses = await loadStatuses();
              updateReadStatuses(() => mergeChatReadStatuses(savedStatuses || {}, serverStatuses));
            } catch {}
          } else {
            if (!localPreloaded) {
              const fallbackLocal = await getChatMessages(pid, uid);
              if (historySyncGenerationRef.current !== syncGen) return;
              const hiddenIds = hiddenForMeMessageIdsRef.current;
              setMessages(
                fallbackLocal.filter((msg: any) => !hiddenIds.has(String(msg?.id || "").trim())),
              );
            }
            const savedStatuses = await loadStatuses();
            if (historySyncGenerationRef.current !== syncGen) return;
            setReadStatuses(savedStatuses);
          }
        } catch (error) {
          console.warn("Chat history network load failed, using local cache:", error);
          if (historySyncGenerationRef.current !== syncGen) return;
          if (!localPreloaded) {
            try {
              const localMessages = await getChatMessages(pid, uid);
              const hiddenIds = hiddenForMeMessageIdsRef.current;
              setMessages(
                localMessages.filter((msg: any) => !hiddenIds.has(String(msg?.id || "").trim())),
              );
              const savedStatuses = await loadStatuses();
              setReadStatuses(savedStatuses);
            } catch (fallbackError) {
              console.warn("Local fallback loading failed:", fallbackError);
              setMessages([]);
            }
          }
        }
      })();
    };

    void loadHistory();
    // Match pre-extract deps: only peer/user. Unstable callbacks (updateReadStatuses/loadStatuses)
    // must NOT be listed or every render cancels in-flight history via syncGen.
  }, [peerId, currentUserId]);

  const historyReadyRef = React.useRef(false);
  React.useEffect(() => {
    historyReadyRef.current = historyReady;
  }, [historyReady]);
  const peerIdRef = React.useRef(peerId);
  const currentUserIdRef = React.useRef(currentUserId);
  React.useEffect(() => {
    peerIdRef.current = peerId;
  }, [peerId]);
  React.useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (!isFocusedRef.current || !historyReadyRef.current) return;
      const pid = peerIdRef.current;
      const uid = currentUserIdRef.current;
      if (!pid || !uid) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!isFocusedRef.current || peerIdRef.current !== pid || currentUserIdRef.current !== uid) {
          return;
        }
        (async () => {
          try {
            const serverMessages = await fetchMessages({ with: pid, limit: 50 });
            if (!serverMessages?.ok || !Array.isArray(serverMessages.messages)) return;

            const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
            const formattedMessages = serverMessages.messages
              .filter((msg: any) => !hiddenForMeIds.has(String(msg?.id || "").trim()))
              .map((msg: any) => formatServerChatMessage(msg, String(uid)));

            setMessages((prev) =>
              mergeInitialHistoryMessages(
                prev,
                formattedMessages,
                {
                  uploadStatus: uploadStatusRef.current as any,
                  readStatuses: readStatusesRef.current as any,
                },
                { dropOptimisticDupes: false },
              ),
            );

            try {
              const serverStatuses = buildOutgoingReadStatusesFromHistory(formattedMessages);
              if (Object.keys(serverStatuses).length) {
                updateReadStatuses((prev) => mergeChatReadStatuses(prev, serverStatuses));
              }
            } catch {}

            await markMessagesAsRead(pid);
            try {
              await dismissMessageNotificationForUser(pid);
              await syncAppBadgeFromMissedCount();
            } catch {}
            logger.debug("[ChatScreen] Merged messages after socket connect/reconnect", {
              n: formattedMessages.length,
              peerId: pid,
            });
          } catch (e) {
            logger.warn("[ChatScreen] Post-reconnect message sync failed:", e);
          }
        })().catch(() => {});
      }, 650);
    };

    socket.on("connect", run);
    socket.on("reconnect", run);
    return () => {
      socket.off("connect", run);
      socket.off("reconnect", run);
      if (t) clearTimeout(t);
    };
  }, [
    isFocusedRef,
    setMessages,
    updateReadStatuses,
    hiddenForMeMessageIdsRef,
    uploadStatusRef,
    readStatusesRef,
  ]);

  return { quietSyncChat };
}
