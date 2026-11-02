import React, { useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId as getCurrentSocketUserId } from '../../sockets/modules/authState';
import type { ChatMessage } from './chatMessageTypes';
import { isDeletableOnServerMessageId } from './chatMessageOps';
import { getChatHiddenForMeKey, getChatStatusesKey } from './chatStorageKeys';

/** Состояние одной открытой переписки. Синхронизация и очередь отправки используют те же refs. */
export function useChatSessionState(peerId: string) {
  const peerIdForPersistRef = useRef(peerId);
  peerIdForPersistRef.current = peerId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** Always points at latest `messages` for background/unmount persistence (avoid stale closures). */
  const latestMessagesForPersistRef = useRef(messages);
  latestMessagesForPersistRef.current = messages;
  /** Для каких live id уже слали `message:read`; history/initial sync закрывается batch `markMessagesAsRead`. */
  const readReceiptSentIdsRef = useRef<Set<string>>(new Set());
  // Чтобы не показывать "пустую заглушку" до загрузки истории (иначе она мелькает на входе в чат)
  const [historyReady, setHistoryReady] = useState(false);
  /** Prefetch chat images before first paint so bubbles don't flash empty→loaded. */
  const [chatImagesWarm, setChatImagesWarm] = useState(false);
  const [readStatuses, setReadStatuses] = useState<Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>>({});
  const readStatusesRef = useRef(readStatuses);
  readStatusesRef.current = readStatuses;
  /** Удалённые на сервере id (в t.ч. legacy numeric): блокируем повтор из history/outbox. */
  const deletedServerMessageIdsRef = useRef<Set<string>>(new Set());
  /** outbox_* / optimistic ui id → id в Mongo (после доставки). */
  const outboxLocalIdToServerIdRef = useRef<Map<string, string>>(new Map());
  const rememberOutboxLocalToServerId = React.useCallback((localId: string, serverId: string) => {
    const local = String(localId || '').trim();
    const server = String(serverId || '').trim();
    if (!local || !server || local === server) return;
    const map = outboxLocalIdToServerIdRef.current;
    map.set(local, server);
    if (map.size > 500) {
      const keep = new Map(Array.from(map.entries()).slice(-250));
      outboxLocalIdToServerIdRef.current = keep;
    }
  }, []);
  const hiddenForMeMessageIdsRef = useRef<Set<string>>(new Set());
  const rememberDeletedServerMessageId = React.useCallback((rawId: string) => {
    const id = String(rawId || '').trim();
    if (!id || !isDeletableOnServerMessageId(id)) return;
    const s = deletedServerMessageIdsRef.current;
    s.add(id);
    if (s.size > 400) {
      deletedServerMessageIdsRef.current = new Set(Array.from(s).slice(-200));
    }
  }, []);
  const [uploadStatus, setUploadStatus] = useState<Record<string, 'sending' | 'sent' | 'failed'>>({});
  const uploadStatusRef = useRef(uploadStatus);
  uploadStatusRef.current = uploadStatus;

  // Обертка для setReadStatuses с автосохранением. Стабильная: она в deps подписок useChatRealtime,
  // и новая функция на каждый рендер переподписывала их — а событие очереди, пришедшее во время
  // синхронного рендера, тогда крутилось по новым подписчикам бесконечно (JS 100%, чат замирал).
  // saveStatuses берёт id из ref, поэтому версия первого рендера актуальна.
  const updateReadStatuses = React.useCallback((updater: (prev: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    setReadStatuses(prev => {
      const updated = updater(prev);
      saveStatuses(updated); // Автоматически сохраняем
      return updated;
    });
  }, []);
  // Обычно уже известен сокету — сразу, без лишнего рендера при открытии чата.
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => {
    try {
      return getCurrentSocketUserId() || null;
    } catch {
      return null;
    }
  });
  const currentUserIdForPersistRef = useRef<string | null>(null);
  currentUserIdForPersistRef.current = currentUserId;

  // Функции для работы с сохраненными сообщениями и статусами
  const loadHiddenForMeMessageIds = React.useCallback(async (uid: string, pid: string): Promise<Set<string>> => {
    try {
      const raw = await AsyncStorage.getItem(getChatHiddenForMeKey(uid, pid));
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return new Set(
        Array.isArray(parsed)
          ? parsed.map((id: unknown) => String(id || '').trim()).filter(Boolean)
          : [],
      );
    } catch {
      return new Set();
    }
  }, []);

  const persistHiddenForMeMessageIds = React.useCallback(async (uid: string, pid: string, ids: Set<string>) => {
    try {
      const key = getChatHiddenForMeKey(uid, pid);
      const list = Array.from(ids).filter(Boolean).slice(-1000);
      if (list.length === 0) {
        await AsyncStorage.removeItem(key);
      } else {
        await AsyncStorage.setItem(key, JSON.stringify(list));
      }
    } catch {}
  }, []);

  const rememberHiddenForMeMessageId = React.useCallback(async (rawId: string) => {
    const id = String(rawId || '').trim();
    const uid = String(currentUserIdForPersistRef.current || '').trim();
    const pid = String(peerIdForPersistRef.current || '').trim();
    if (!id || !uid || !pid) return;
    const next = new Set(hiddenForMeMessageIdsRef.current);
    next.add(id);
    hiddenForMeMessageIdsRef.current = next;
    await persistHiddenForMeMessageIds(uid, pid, next);
  }, [persistHiddenForMeMessageIds]);

  const rememberHiddenForMeMessageIds = React.useCallback(async (rawIds: string[]) => {
    const ids = Array.from(new Set(
      (rawIds || []).map((rawId) => String(rawId || '').trim()).filter(Boolean),
    ));
    const uid = String(currentUserIdForPersistRef.current || '').trim();
    const pid = String(peerIdForPersistRef.current || '').trim();
    if (ids.length === 0 || !uid || !pid) return;
    const next = new Set(hiddenForMeMessageIdsRef.current);
    for (const id of ids) next.add(id);
    hiddenForMeMessageIdsRef.current = next;
    await persistHiddenForMeMessageIds(uid, pid, next);
  }, [persistHiddenForMeMessageIds]);

  const saveStatuses = async (statuses: Record<string, 'sending' | 'delivered' | 'read' | 'failed' | 'sent'>) => {
    try {
      // Читаем id из ref: эффект reconnect подписан с deps [] и иначе мог бы сохранять статусы под устаревшими peer/user.
      const uid = String(currentUserIdForPersistRef.current || '').trim();
      const pid = String(peerIdForPersistRef.current || '').trim();
      if (!uid || !pid) return;
      const key = getChatStatusesKey(uid, pid);
      await AsyncStorage.setItem(key, JSON.stringify(statuses));
    } catch (error) {
      // Игнорируем ошибки сохранения
    }
  };

  const loadStatuses = async (): Promise<Record<string, 'sending' | 'delivered' | 'read' | 'failed'>> => {
    try {
      const uid = String(currentUserIdForPersistRef.current || '').trim();
      const pid = String(peerIdForPersistRef.current || '').trim();
      if (!uid || !pid) return {};
      const key = getChatStatusesKey(uid, pid);
      const savedStatuses = await AsyncStorage.getItem(key);
      if (savedStatuses) {
        return JSON.parse(savedStatuses);
      }
      return {};
    } catch (error) {
      return {};
    }
  };

  // Слушатели сообщений через сокеты

  const messagesRef = useRef<ChatMessage[]>([]);

  return { peerId,
    peerIdForPersistRef,
    messages,
    setMessages,
    latestMessagesForPersistRef,
    readReceiptSentIdsRef,
    historyReady,
    setHistoryReady,
    chatImagesWarm,
    setChatImagesWarm,
    readStatuses,
    setReadStatuses,
    readStatusesRef,
    deletedServerMessageIdsRef,
    outboxLocalIdToServerIdRef,
    rememberOutboxLocalToServerId,
    hiddenForMeMessageIdsRef,
    rememberDeletedServerMessageId,
    uploadStatus,
    setUploadStatus,
    uploadStatusRef,
    updateReadStatuses,
    currentUserId,
    setCurrentUserId,
    currentUserIdForPersistRef,
    loadHiddenForMeMessageIds,
    rememberHiddenForMeMessageId,
    rememberHiddenForMeMessageIds,
    loadStatuses,
    messagesRef,
  };
}

export type ChatSessionState = ReturnType<typeof useChatSessionState>;
