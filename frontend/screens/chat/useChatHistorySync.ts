import type { ChatMessage } from './chatMessageTypes';
/** History load + quiet sync + reconnect merge for ChatScreen. */

import React from "react";
import { AppState, DeviceEventEmitter, unstable_batchedUpdates } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import socket, {
  fetchMessages,
  getChatMessages,
  getChatMessagesLocal,
  clearMessageCache,
  getCurrentUserId as getCurrentSocketUserId,
  isGloballyDeletedMessageId,
  listPendingMessageOutboxForPeer,
  markMessagesAsRead,
} from "../../sockets/socket";
import { logger } from "../../utils/logger";
import { resyncBadgeAfterChatRead } from "../../utils/pushNotifications";
import { mergeChatReadStatuses } from "./chatMessageOps";
import {
  buildOutgoingReadStatusesFromHistory,
  fetchQuietSyncMessagePages,
  filterVisibleServerMessages,
  formatServerChatMessage,
  mergeInitialHistoryMessages,
  mergeQuietSyncMessages,
} from "./chatHistory";
import { mergePendingOutboxIntoMessages } from "./outboxPendingRows";

/** Повторы синхронизации открытого чата после переподключения сокета. */
const RECONNECT_SYNC_DELAYS_MS = [650, 2500, 6000];

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  setCurrentUserId: React.Dispatch<React.SetStateAction<string | null>>;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
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
  latestMessagesForPersistRef: React.MutableRefObject<ChatMessage[]>;
  navigation: { addListener?: (event: "focus", listener: () => void) => () => void };
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
  /** Сервер ответил, что переписки нет совсем (для уведомления о шифровании в пустом чате). */
  const [serverHistoryEmpty, setServerHistoryEmpty] = React.useState(false);
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
      }).map((msg) => formatServerChatMessage(msg, String(currentUserId)));

      setMessages((prev) =>
        mergeQuietSyncMessages(prev, formatted, {
          uploadStatus: uploadStatusRef.current,
          readStatuses: readStatusesRef.current,
        }),
      );
    } catch {} finally {
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

  // FCM о сообщении в эту переписку, пока она на экране (натив не рисует уведомление):
  // живая доставка не подтвердилась — подтянуть с сервера и отметить прочитанным.
  React.useEffect(() => {
    if (!peerId) return;
    const sub = DeviceEventEmitter.addListener("LiviMessagePushForOpenChat", (e: { from?: string }) => {
      if (String(e?.from || "") !== String(peerId)) return;
      void (async () => {
        await quietSyncChat();
        const res = await markMessagesAsRead(peerId).catch(() => null);
        if (res?.ok) void resyncBadgeAfterChatRead(peerId);
      })();
    });
    return () => sub.remove();
  }, [peerId, quietSyncChat]);

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
      // Пустой и так (первое открытие) — не новый [] и не лишняя перерисовка.
      setMessages((prev) => (prev.length ? [] : prev));
    }

    historySyncGenerationRef.current += 1;
    const syncGen = historySyncGenerationRef.current;
    const pid = peerId;

    const loadHistory = async () => {
      setHistoryReady(false);
      setServerHistoryEmpty(false);
      setChatImagesWarm(false);
      clearMessageCache(pid, uid);

      const fetchPromise = fetchMessages({ with: pid, limit: 50 }).catch(() => null);

      let localPreloaded = false;
      try {
        const [localMessages, savedStatuses, hiddenIds, pendingOutbox] = await Promise.all([
          getChatMessagesLocal(pid, uid),
          loadStatuses(),
          loadHiddenForMeMessageIds(uid, pid),
          listPendingMessageOutboxForPeer(pid).catch(() => []),
        ]);
        if (historySyncGenerationRef.current !== syncGen) return;
        hiddenForMeMessageIdsRef.current = hiddenIds;
        const visibleLocalMessages = Array.isArray(localMessages)
          ? localMessages.filter((msg) => !hiddenIds.has(String(msg?.id || "").trim()))
          : [];
        // Быстрый Back без persist: пузырь мог остаться только в outbox — вернём в ленту.
        const hydrated = mergePendingOutboxIntoMessages(visibleLocalMessages, pendingOutbox || [], uid);
        const statusesWithPending: Record<string, "sending" | "delivered" | "read" | "failed" | "sent"> = {
          ...(savedStatuses || {}),
        };
        for (const id of hydrated.sendingIds) {
          const cur = statusesWithPending[id];
          if (!cur || cur === "sending" || cur === "failed") statusesWithPending[id] = "sending";
        }
        localPreloaded = hydrated.messages.length > 0;
        // Статусы, кэш и «история готова» — одним рендером: каждый отдельный setState
        // после await перерисовывал весь чат, пока шёл переход на экран переписки.
        unstable_batchedUpdates(() => {
          setReadStatuses(statusesWithPending);
          if (localPreloaded) setMessages(hydrated.messages);
          setHistoryReady(true);
        });
        if (hydrated.sendingIds.length > 0) {
          latestMessagesForPersistRef.current = hydrated.messages;
          enqueueMessagesPersist("hydrate_pending_outbox");
          updateReadStatuses(() => statusesWithPending);
        }
      } catch {
        if (historySyncGenerationRef.current === syncGen) setHistoryReady(true);
      }
      if (historySyncGenerationRef.current !== syncGen) return;

      void (async () => {
        try {
          const serverMessages = await fetchPromise;
          if (historySyncGenerationRef.current !== syncGen) return;

          if (serverMessages?.ok && serverMessages.messages) {
            // По серверу, а не по ленте: пустой локальный кэш ещё не значит, что переписки не было.
            const serverEmpty = serverMessages.messages.length === 0;
            const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
            const visible = filterVisibleServerMessages(serverMessages.messages, {
              hiddenForMeIds,
              deletedServerIds: deletedServerMessageIdsRef.current,
              isGloballyDeleted: isGloballyDeletedMessageId,
            });
            const formattedMessages = visible.map((msg) => {
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

            unstable_batchedUpdates(() => {
              setServerHistoryEmpty(serverEmpty);
              setMessages((prev) =>
                mergeInitialHistoryMessages(prev, formattedMessages, {
                  uploadStatus: uploadStatusRef.current,
                  readStatuses: readStatusesRef.current,
                }),
              );
            });

            const readRes = await markMessagesAsRead(pid);
            try {
              if (readRes?.ok) await resyncBadgeAfterChatRead(pid);
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
                fallbackLocal.filter((msg) => !hiddenIds.has(String(msg?.id || "").trim())),
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
                localMessages.filter((msg) => !hiddenIds.has(String(msg?.id || "").trim())),
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

  // Свежие колбэки для подписок, созданных один раз (см. эффект ниже).
  const setMessagesRef = React.useRef(setMessages);
  setMessagesRef.current = setMessages;
  const updateReadStatusesRef = React.useRef(updateReadStatuses);
  updateReadStatusesRef.current = updateReadStatuses;
  const wasReachableRef = React.useRef<boolean | null>(null);

  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      if (!isFocusedRef.current || !historyReadyRef.current) return;
      const pid = peerIdRef.current;
      const uid = currentUserIdRef.current;
      if (!pid || !uid) return;
      if (t) clearTimeout(t);
      // Сразу после возврата сети запрос часто падает (reauth ещё не прошёл, путь
      // не прогрелся) — без повтора открытый чат не видел сообщений, пришедших
      // в «мёртвый» сокет, пока его не переоткроют.
      const attempt = (index: number) => {
        t = setTimeout(() => {
          if (!isFocusedRef.current || peerIdRef.current !== pid || currentUserIdRef.current !== uid) {
            return;
          }
          (async () => {
            try {
              const serverMessages = await fetchMessages({ with: pid, limit: 50 });
              if (!serverMessages?.ok || !Array.isArray(serverMessages.messages)) {
                if (index + 1 < RECONNECT_SYNC_DELAYS_MS.length) attempt(index + 1);
                return;
              }

              const hiddenForMeIds = hiddenForMeMessageIdsRef.current;
              const formattedMessages = serverMessages.messages
                .filter((msg) => !hiddenForMeIds.has(String(msg?.id || "").trim()))
                .map((msg) => formatServerChatMessage(msg, String(uid)));

              setMessagesRef.current((prev) =>
                mergeInitialHistoryMessages(
                  prev,
                  formattedMessages,
                  {
                    uploadStatus: uploadStatusRef.current,
                    readStatuses: readStatusesRef.current,
                  },
                  { dropOptimisticDupes: false },
                ),
              );

              try {
                const serverStatuses = buildOutgoingReadStatusesFromHistory(formattedMessages);
                if (Object.keys(serverStatuses).length) {
                  updateReadStatusesRef.current((prev) => mergeChatReadStatuses(prev, serverStatuses));
                }
              } catch {}

              const readRes = await markMessagesAsRead(pid);
              try {
                if (readRes?.ok) await resyncBadgeAfterChatRead(pid);
              } catch {}
            } catch (e) {
              logger.warn("[ChatScreen] Post-reconnect message sync failed:", e);
              if (index + 1 < RECONNECT_SYNC_DELAYS_MS.length) attempt(index + 1);
            }
          })().catch(() => {});
        }, RECONNECT_SYNC_DELAYS_MS[index]);
      };
      attempt(0);
    };

    socket.on("connect", run);
    socket.on("reconnect", run);
    // Сеть вернулась (режим полёта, VPN, лифт): синхронизируем, не дожидаясь connect
    // сокета — сообщения, ушедшие в «мёртвый» сокет, иначе не видны до переоткрытия чата.
    const unsubscribeNet = NetInfo.addEventListener((state) => {
      const reachable = state.isConnected === true && state.isInternetReachable !== false;
      if (wasReachableRef.current === false && reachable) run();
      wasReachableRef.current = reachable;
    });
    return () => {
      socket.off("connect", run);
      socket.off("reconnect", run);
      unsubscribeNet();
      if (t) clearTimeout(t);
    };
    // Подписки — один раз на экран: с нестабильными колбэками в deps эффект
    // перезапускался на каждом рендере (несколько раз в секунду) и терял переход сети.
  }, []);

  return { quietSyncChat, serverHistoryEmpty };
}
