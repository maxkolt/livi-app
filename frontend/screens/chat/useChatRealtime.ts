/** Realtime socket listeners for an open chat. */

import React from "react";
import { AppState, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  onMessageReceived,
  onMessageReadReceipt,
  onMessageReaction,
  markMessagesAsRead,
  sendReadReceipt,
  clearMessageCache,
  onChatCleared,
  onMessageDeleted,
  onMessagesDeleted,
  onMessageEdited,
  onMessageUrisUpdated,
  onOutboxMessageDelivered,
  globalMessageStorage,
} from "../../sockets/socket";
import { logger } from "../../utils/logger";
import {
  dismissMessageNotificationForUser,
  syncAppBadgeFromMissedCount,
} from "../../utils/pushNotifications";
import { CHAT_ALBUM_MAX, getMessageImageUris } from "./chatAlbum";
import { stickerFieldsFromMessage } from "./chatMessageMeta";
import { removeMessagesForDeletedIds } from "./chatMessageOps";

type ReadStatusMap = Record<string, "sending" | "delivered" | "read" | "failed" | "sent">;

type Options = {
  peerId: string;
  currentUserId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  setUploadStatus: React.Dispatch<React.SetStateAction<Record<string, "sending" | "sent" | "failed">>>;
  setSelectedMessageIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  updateReadStatuses: (updater: (prev: ReadStatusMap) => ReadStatusMap) => void;
  resolveMediaUri: (uri?: string) => string;
  scrollToBottom: () => void;
  latestMessagesForPersistRef: React.MutableRefObject<any[]>;
  isFocusedRef: React.MutableRefObject<boolean>;
  readReceiptSentIdsRef: React.MutableRefObject<Set<string>>;
  deletedServerMessageIdsRef: React.MutableRefObject<Set<string>>;
  outboxLocalIdToServerIdRef: React.MutableRefObject<Map<string, string>>;
  rememberDeletedServerMessageId: (id: string) => void;
  rememberOutboxLocalToServerId: (localId: string, serverId: string) => void;
  enqueueMessagesPersist: (reason: string) => void;
};

export function useChatRealtime({
  peerId,
  currentUserId,
  setMessages,
  setUploadStatus,
  setSelectedMessageIds,
  updateReadStatuses,
  resolveMediaUri,
  scrollToBottom,
  latestMessagesForPersistRef,
  isFocusedRef,
  readReceiptSentIdsRef,
  deletedServerMessageIdsRef,
  outboxLocalIdToServerIdRef,
  rememberDeletedServerMessageId,
  rememberOutboxLocalToServerId,
  enqueueMessagesPersist,
}: Options) {
  React.useEffect(() => {
    if (!currentUserId) return;


    // Слушатель входящих сообщений
    const unsubscribeReceived = onMessageReceived((message) => {
      const senderId = message.from;
      const isFromMe = senderId === currentUserId;
      const isFromPeer = senderId === peerId;

      if (isFromPeer || isFromMe) {
        // Очищаем кэш при получении нового сообщения
        clearMessageCache(peerId, currentUserId || undefined);
        
        
        
        const newMessage = {
          id: message.id,
          text: message.text,
          type: message.type,
          uri: message.uri,
          uris: Array.isArray((message as any).uris) && (message as any).uris.length > 1
            ? (message as any).uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
            : undefined,
          name: (message as any).name,
          size: (message as any).size,
          duration: (message as any).duration,
          ...stickerFieldsFromMessage(message),
          sender: isFromMe ? "me" : "peer",
          from: message.from,
          to: message.to,
          timestamp: new Date(message.timestamp),
          reactions: Array.isArray((message as any).reactions) ? (message as any).reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
          ...((message as any).replyTo && (message as any).replyTo.id ? { replyTo: { id: (message as any).replyTo.id, text: (message as any).replyTo.text, from: (message as any).replyTo.from, isOwn: (message as any).replyTo.from === currentUserId } } : {}),
        };
        
        // КРИТИЧНО: Логируем входящие сообщения с изображениями для отладки
        if (message.type === 'image') {
          logger.info('[ChatScreen] Received image message', {
            messageId: message.id,
            from: message.from,
            to: message.to,
            uri: message.uri,
            urisCount: getMessageImageUris(newMessage).length,
            resolvedUri: resolveMediaUri(message.uri),
            hasUri: !!message.uri,
          });
        }

        const existedBeforeLiveReceive = isFromPeer
          ? latestMessagesForPersistRef.current.some((msg: any) => String(msg?.id || '') === String(newMessage.id || ''))
          : false;

        setMessages((prev) => {
          // Проверяем, есть ли уже сообщение с таким ID
          const existingMessage = prev.find(msg => msg.id === newMessage.id);
          if (existingMessage) {
            return prev;
          }
          
          const updated = [...prev, newMessage];
          return updated;
        });

        const chatIsActiveForRead =
          isFocusedRef.current && AppState.currentState === 'active';

        if (isFromPeer && !existedBeforeLiveReceive && chatIsActiveForRead) {
          const id = String(newMessage.id || '').trim();
          if (id && !readReceiptSentIdsRef.current.has(id)) {
            readReceiptSentIdsRef.current.add(id);
            sendReadReceipt(id, peerId);
          }
        }

        // Для получателя: первый скролл часто случается до фактического layout нового пузыря.
        // Делаем принудительный post-layout double-pass, чтобы сообщение не "проваливалось" под input bar.
        if (Platform.OS === 'android' && isFromPeer) {
          requestAnimationFrame(() => {
            scrollToBottom();
            setTimeout(() => scrollToBottom(), 90);
            setTimeout(() => scrollToBottom(), 220);
          });
        }

        // Сохраняем сообщение глобально для офлайн доступа
        if (isFromPeer && currentUserId) {
          globalMessageStorage.saveMessage(message, currentUserId);
        }

        // Отмечаем прочитанным только если чат реально открыт (экран в фокусе). Иначе при возврате на «Друзья»
        // ChatScreen остаётся в стеке и гасит unread на Home сразу после появления бейджа.
        if (isFromPeer && chatIsActiveForRead) {
          setTimeout(() => {
            if (!isFocusedRef.current || AppState.currentState !== 'active') return;
            markMessagesAsRead(senderId);
            try {
              void dismissMessageNotificationForUser(senderId);
              void syncAppBadgeFromMissedCount();
            } catch {}
          }, 1000);
        }
      }
    });

    // Слушатель подтверждений прочтения
    const unsubscribeReadReceipt = onMessageReadReceipt((receipt) => {
      // Перекладываем статус в карту по server messageId
      updateReadStatuses(prev => ({
        ...prev, 
        [receipt.messageId]: 'read'
      }));
    });

    // Слушатель реакций на сообщения
    const unsubscribeReaction = onMessageReaction((data) => {
      setMessages((prev) =>
        prev.map((msg) =>
          String(msg?.id) === data.messageId ? { ...msg, reactions: data.reactions || [] } : msg
        )
      );
    });

    // Отслеживаем подтверждение доставки, если прилетает отдельным событием
    // Если статус доставки приходит отдельным механизмом, можно повесить сюда нужный слушатель в будущем
    const unsubscribeDelivered = () => {};

    // Слушатель очистки чата
    const unsubscribeChatCleared = onChatCleared((data) => {
      // Очищаем чат если это касается текущего чата
      // data.by - кто инициировал очистку, data.with - с кем очищается чат
      // Проверяем, что текущий чат между currentUserId и peerId участвует в очистке
      const isCurrentChatCleared = (
        (// Я очистил чат с peerId
        (data.by === currentUserId && data.with === peerId) || (data.by === peerId && data.with === currentUserId))     // peerId очистил чат со мной
      );
      
      if (isCurrentChatCleared) {
        setMessages([]);
        clearMessageCache(peerId, currentUserId || undefined);
        // Очищаем AsyncStorage
        const chatKey = globalMessageStorage.getChatKey(currentUserId, peerId);
        AsyncStorage.removeItem(chatKey);
      } else {
      }
    });

    // Слушатель удаления сообщений.
    // Коротко буферизуем входящие delete-события, чтобы массовое удаление у собеседника
    // визуально схлопывалось одной пачкой, а не по одному сообщению.
    const pendingDeletedIds = new Set<string>();
    let pendingDeletedTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPendingDeleted = () => {
      if (pendingDeletedIds.size === 0) return;
      const deletedIds = new Set(Array.from(pendingDeletedIds));
      pendingDeletedIds.clear();
      pendingDeletedTimer = null;
      for (const id of deletedIds) rememberDeletedServerMessageId(String(id));
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = removeMessagesForDeletedIds(
          prev,
          Array.from(deletedIds),
          outboxLocalIdToServerIdRef.current,
        );
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_event_messages'));
        return next;
      });
      try {
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setUploadStatus((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setSelectedMessageIds((prev) => {
          const next = new Set(prev);
          for (const id of deletedIds) next.delete(id);
          return next;
        });
      } catch {}
    };
    const applyDeletedIds = (ids: string[]) => {
      const deletedIds = new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean));
      if (deletedIds.size === 0) return;
      for (const id of deletedIds) rememberDeletedServerMessageId(String(id));
      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        const next = removeMessagesForDeletedIds(
          prev,
          Array.from(deletedIds),
          outboxLocalIdToServerIdRef.current,
        );
        latestMessagesForPersistRef.current = next;
        queueMicrotask(() => enqueueMessagesPersist('delete_event_messages'));
        return next;
      });
      try {
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setUploadStatus((prev) => {
          const next: any = { ...prev };
          for (const id of deletedIds) delete next[id];
          return next;
        });
      } catch {}
      try {
        setSelectedMessageIds((prev) => {
          const next = new Set(prev);
          for (const id of deletedIds) next.delete(id);
          return next;
        });
      } catch {}
    };
    const unsubscribeMessageDeleted = onMessageDeleted((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      if (!mid) return;
      rememberDeletedServerMessageId(mid);
      pendingDeletedIds.add(mid);
      if (pendingDeletedTimer) clearTimeout(pendingDeletedTimer);
      pendingDeletedTimer = setTimeout(flushPendingDeleted, 120);
    });
    const unsubscribeMessagesDeleted = onMessagesDeleted((data) => {
      if (pendingDeletedTimer) {
        clearTimeout(pendingDeletedTimer);
        pendingDeletedTimer = null;
      }
      pendingDeletedIds.clear();
      applyDeletedIds(Array.isArray((data as any)?.messageIds) ? (data as any).messageIds : []);
    });

    const unsubscribeMessageEdited = onMessageEdited((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      const text = typeof (data as any)?.text === 'string' ? String((data as any).text) : '';
      if (!mid) return;
      setMessages((prev) => {
        const updated = prev.map((msg) =>
          String(msg?.id || '') === mid ? { ...msg, text } : msg
        );
        return updated;
      });
    });

    const unsubscribeMessageUrisUpdated = onMessageUrisUpdated((data) => {
      const mid = String((data as any)?.messageId || '').trim();
      if (!mid) return;
      if ((data as any)?.deleted) {
        setMessages((prev) => prev.filter((msg) => String(msg?.id || '') !== mid));
        return;
      }
      const nextUris = Array.isArray((data as any)?.uris)
        ? (data as any).uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, CHAT_ALBUM_MAX)
        : [];
      const primary = String((data as any)?.uri || nextUris[0] || '').trim();
      setMessages((prev) =>
        prev.map((msg) => {
          if (String(msg?.id || '') !== mid) return msg;
          return {
            ...msg,
            uri: primary || msg.uri,
            uris: nextUris.length > 1 ? nextUris : undefined,
          };
        }),
      );
    });

    const unsubscribeOutboxDelivered = onOutboxMessageDelivered((ev) => {
      if (String(ev.to || '') !== peerId) return;
      const serverMessageId = String(ev.serverMessageId || '').trim();
      if (!serverMessageId) return;
      const olds = new Set(
        [ev.outboxId, ev.optimisticUiId].map((x) => String(x || '').trim()).filter(Boolean),
      );
      if (olds.size === 0) return;
      for (const oid of olds) rememberOutboxLocalToServerId(oid, serverMessageId);

      if (deletedServerMessageIdsRef.current.has(serverMessageId)) {
        clearMessageCache(peerId, currentUserId || undefined);
        setMessages((prev) => prev.filter((msg) => !olds.has(String(msg?.id || ''))));
        updateReadStatuses((prev) => {
          const next: any = { ...prev };
          for (const oid of olds) delete next[oid];
          delete next[serverMessageId];
          return next;
        });
        return;
      }

      clearMessageCache(peerId, currentUserId || undefined);
      setMessages((prev) => {
        let changed = false;
        const mapped = prev.map((msg) => {
          const id = String(msg?.id || '');
          if (!olds.has(id)) return msg;
          changed = true;
          return { ...msg, id: serverMessageId, from: currentUserId, to: peerId };
        });
        if (!changed) return prev;
        const seen = new Set<string>();
        return mapped.filter((msg) => {
          const id = String(msg?.id || '');
          if (!id) return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      });
      updateReadStatuses((prev) => {
        const next: any = { ...prev };
        let st = next[serverMessageId] || 'sent';
        for (const oid of olds) {
          const v = next[oid];
          if (v === 'delivered') st = 'delivered';
        }
        for (const oid of olds) delete next[oid];
        if (!next[serverMessageId]) next[serverMessageId] = st;
        return next;
      });
    });

    return () => {
      if (pendingDeletedTimer) {
        clearTimeout(pendingDeletedTimer);
        pendingDeletedTimer = null;
      }
      flushPendingDeleted();
      unsubscribeReceived();
      unsubscribeReadReceipt();
      unsubscribeReaction();
      unsubscribeChatCleared();
      unsubscribeMessageDeleted();
      unsubscribeMessagesDeleted();
      unsubscribeMessageEdited();
      unsubscribeMessageUrisUpdated();
      unsubscribeOutboxDelivered();
      unsubscribeDelivered();
    };
  }, [
    currentUserId,
    peerId,
    rememberDeletedServerMessageId,
    rememberOutboxLocalToServerId,
    setMessages,
    setUploadStatus,
    setSelectedMessageIds,
    updateReadStatuses,
    resolveMediaUri,
    scrollToBottom,
    latestMessagesForPersistRef,
    isFocusedRef,
    readReceiptSentIdsRef,
    deletedServerMessageIdsRef,
    outboxLocalIdToServerIdRef,
    enqueueMessagesPersist,
  ]);
}
