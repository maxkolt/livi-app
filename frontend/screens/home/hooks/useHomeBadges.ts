import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  onMessageReceived,
  onMessageReadReceipt,
  onMessageDeleted,
  onMessagesDeleted,
  getUnreadCount,
  getUnreadCounts,
} from '../../../sockets/socket';
import socket from '../../../sockets/socket';
import { onMissedIncrement, onMissedClear, onMissedFetchedFromServer } from '../../../utils/globalEvents';
import { clearMissedBadgeCleared, syncAppBadgeFromMissedCount } from '../../../utils/pushNotifications';
import { logger } from '../../../utils/logger';
import { MISSED_CALLS_KEY, UNREAD_BY_USER_KEY } from '../constants';
import { badgeMapsEqual, patchUnreadCountsIfChanged } from '../friendHelpers';
import type { Friend } from '../types';

type UseHomeBadgesArgs = {
  friends: Friend[];
  friendsRef: MutableRefObject<Friend[]>;
};

const UNREAD_FLOOR_TTL_MS = 2500;
const UNREAD_SERVER_RECONCILE_DELAY_MS = 900;

function persistUnreadMap(map: Record<string, number>) {
  const cleaned: Record<string, number> = {};
  Object.keys(map).forEach((key) => {
    const v = map[key];
    if (typeof v === 'number' && v > 0) cleaned[key] = v;
  });
  AsyncStorage.setItem(UNREAD_BY_USER_KEY, JSON.stringify(cleaned)).catch(() => {});
}

export function useHomeBadges({ friends, friendsRef }: UseHomeBadgesArgs) {
  const [unreadByUser, setUnreadByUserState] = useState<Record<string, number>>({});
  const [missedByUser, setMissedByUser] = useState<Record<string, number>>({});
  const [missedLoaded, setMissedLoaded] = useState(false);
  const pendingUnreadBatchRefreshRef = useRef(false);
  const badgeSyncDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Не даём серверному 0 сразу после нового сообщения стереть красную точку (гонка ack). */
  const unreadFloorRef = useRef<Map<string, { min: number; until: number }>>(new Map());

  const clearUnreadFloor = useCallback((userId: string) => {
    unreadFloorRef.current.delete(String(userId));
  }, []);

  const bumpUnreadFloor = useCallback((userId: string, minCount: number, ttlMs = UNREAD_FLOOR_TTL_MS) => {
    const id = String(userId);
    const prev = unreadFloorRef.current.get(id);
    unreadFloorRef.current.set(id, {
      min: Math.max(minCount, prev?.min || 0),
      until: Date.now() + ttlMs,
    });
  }, []);

  const resolveServerUnreadCount = useCallback((userId: string, serverCount: number) => {
    const id = String(userId);
    const floor = unreadFloorRef.current.get(id);
    if (!floor) return serverCount;
    if (Date.now() > floor.until) {
      unreadFloorRef.current.delete(id);
      return serverCount;
    }
    if (serverCount >= floor.min) {
      unreadFloorRef.current.delete(id);
      return serverCount;
    }
    return Math.max(serverCount, floor.min);
  }, []);

  const setUnreadByUser = useCallback((
    action: Record<string, number> | ((prev: Record<string, number>) => Record<string, number>),
  ) => {
    setUnreadByUserState((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      // Явный сброс (чат / mark-read) — снимаем floor, иначе точка вернётся после batch refresh.
      Object.keys(prev).forEach((key) => {
        if ((prev[key] || 0) > 0 && (next[key] || 0) <= 0) {
          unreadFloorRef.current.delete(key);
        }
      });
      return next;
    });
  }, []);

  const refreshUnreadCountsForFriends = useCallback(async (list: Friend[], attempt = 0) => {
    if (!list.length) return;
    const ids = list.map((f) => String(f.id));
    try {
      const result = await getUnreadCounts(ids);
      if (!result?.ok || !result.counts) return;
      pendingUnreadBatchRefreshRef.current = false;
      const entries: Record<string, number> = {};
      for (const id of ids) {
        const n = result.counts[id];
        const raw = typeof n === 'number' && n > 0 ? n : 0;
        entries[id] = resolveServerUnreadCount(id, raw);
      }
      setUnreadByUserState((prev) => {
        const next = patchUnreadCountsIfChanged(prev, entries);
        if (next === prev) return prev;
        persistUnreadMap(next);
        return next;
      });
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      const retriable =
        attempt < 2 &&
        (msg.includes('offline') || msg.includes('timeout') || msg.includes('Ack timeout'));
      if (retriable) {
        pendingUnreadBatchRefreshRef.current = true;
        await new Promise((r) => setTimeout(r, 600 + attempt * 400));
        return refreshUnreadCountsForFriends(list, attempt + 1);
      }
      if (msg.includes('offline') || msg.includes('timeout')) {
        pendingUnreadBatchRefreshRef.current = true;
      }
      logger.info('[HomeScreen] Batch unread refresh failed:', msg);
    }
  }, [resolveServerUnreadCount]);
  // Кэш непрочитанных по друзьям — сразу при монтировании (до сокета).
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(UNREAD_BY_USER_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const normalized: Record<string, number> = {};
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach((key) => {
            const value = parsed[key];
            if (typeof value === 'number' && value > 0) normalized[String(key)] = value;
          });
        }
        if (Object.keys(normalized).length) {
          setUnreadByUser((prev) => ({ ...normalized, ...prev }));
        }
      } catch {}
    })();
  }, []);

  // Пропущенные звонки из storage при монтировании
  useEffect(() => {
    (async () => {
      try {
        const rawMissed = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = rawMissed ? JSON.parse(rawMissed) : {};
        const normalized: Record<string, number> = {};
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach((key) => {
            const value = parsed[key];
            if (typeof value === 'number' && value > 0) {
              normalized[String(key)] = value;
            }
          });
        }
        setMissedByUser((prev) => (badgeMapsEqual(prev, normalized) ? prev : normalized));
        setMissedLoaded(true);
        logger.debug('[HomeScreen] Loaded missed calls from storage', { count: Object.keys(normalized).length, normalized });
      } catch (e) {
        logger.warn('[HomeScreen] Error loading missed calls:', e);
        setMissedLoaded(true);
      }
    })();
  }, []);

  // Сохраняем пропущенные вызовы при изменении
  useEffect(() => {
    if (!missedLoaded) return;
    try {
      const cleaned: Record<string, number> = {};
      Object.keys(missedByUser).forEach((key) => {
        const value = missedByUser[key];
        if (typeof value === 'number' && value > 0) {
          cleaned[key] = value;
        }
      });
      AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(cleaned)).catch(() => {});
    } catch (e) {
      logger.warn('[HomeScreen] Error saving missed calls:', e);
    }
  }, [missedByUser, missedLoaded]);

  useEffect(() => {
    if (badgeSyncDebounceRef.current) clearTimeout(badgeSyncDebounceRef.current);
    badgeSyncDebounceRef.current = setTimeout(() => {
      badgeSyncDebounceRef.current = null;
      syncAppBadgeFromMissedCount().catch(() => {});
    }, 350);
    return () => {
      if (badgeSyncDebounceRef.current) clearTimeout(badgeSyncDebounceRef.current);
    };
  }, [unreadByUser, missedByUser]);

  useEffect(() => {
    const off = onMissedIncrement(({ userId, count }) => {
      if (!userId) return;
      const userIdStr = String(userId);
      setMissedByUser((prev) => {
        const prevCount = prev[userIdStr] || 0;
        const nextCount =
          typeof count === 'number' ? Math.max(prevCount, count) : prevCount + 1;
        if (nextCount <= 0 || nextCount === prevCount) return prev;
        logger.debug('[HomeScreen] Missed call updated (UI)', { userId: userIdStr, count: nextCount });
        return { ...prev, [userIdStr]: nextCount };
      });
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const off = onMissedClear(async ({ userId }) => {
      const userIdStr = String(userId);
      if (!userIdStr) return;
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.cancelMissedCallNotificationForUser?.(userIdStr); } catch (_) {}
        try { NativeModules.LiviAppModule?.removePendingMissedCall?.(userIdStr); } catch (_) {}
      }
      try {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const map: Record<string, number> = raw ? JSON.parse(raw) : {};
        if (map[userIdStr] === undefined) return;
        delete map[userIdStr];
        await AsyncStorage.setItem(MISSED_CALLS_KEY, JSON.stringify(map));
        setMissedByUser((prev) => {
          if (prev[userIdStr] === undefined) return prev;
          const next = { ...prev };
          delete next[userIdStr];
          return next;
        });
        await syncAppBadgeFromMissedCount();
        logger.debug('[HomeScreen] Missed calls cleared for user (emitMissedClear)', { userId: userIdStr });
      } catch (e) {
        logger.warn('[HomeScreen] onMissedClear failed', { userId: userIdStr, error: (e as Error)?.message });
      }
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    const off = onMissedFetchedFromServer(async () => {
      try {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        const normalized: Record<string, number> = {};
        if (parsed && typeof parsed === 'object') {
          Object.keys(parsed).forEach((key) => {
            const value = parsed[key];
            if (typeof value === 'number' && value > 0) normalized[String(key)] = value;
          });
        }
        setMissedByUser((prev) => {
          if (badgeMapsEqual(prev, normalized)) return prev;
          return normalized;
        });
        setMissedLoaded(true);
        await clearMissedBadgeCleared();
        await syncAppBadgeFromMissedCount();
      } catch {}
    });
    return off;
  }, []);

  // После восстановления сокета обновляем счётчики непрочитанных
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const refreshUnread = () => {
      const list = friendsRef.current;
      if (!list.length) return;
      void refreshUnreadCountsForFriends(list).then(() => {
        if (!pendingUnreadBatchRefreshRef.current) {
          logger.debug('[HomeScreen] Unread counts refreshed after socket connect/reconnect (batch)', {
            n: list.length,
          });
        }
      }).catch((e) => {
        logger.warn('[HomeScreen] Unread refresh after socket failed:', e);
      });
    };

    const schedule = () => {
      if (t) clearTimeout(t);
      t = setTimeout(refreshUnread, 700);
    };

    socket.on('connect', schedule);
    socket.on('reconnect', schedule);
    return () => {
      socket.off('connect', schedule);
      socket.off('reconnect', schedule);
      if (t) clearTimeout(t);
    };
  }, [friendsRef, refreshUnreadCountsForFriends]);

  /* ===== unread counters (через сокеты) =====
   * Слушатель не пересоздаём на каждый presence/loadFriends (только при смене набора friend ids),
   * иначе теряются события и batch refresh затирает optimistic точку гонкой с сервером.
   */
  const friendsIdsKey = friends
    .map((f) => String(f.id))
    .filter(Boolean)
    .sort()
    .join(',');

  useEffect(() => {
    if (!friendsIdsKey) return;
    let disposed = false;
    let allTimer: ReturnType<typeof setTimeout> | null = null;
    const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const scheduleRecalcAll = () => {
      if (allTimer) return;
      allTimer = setTimeout(() => {
        allTimer = null;
        if (!disposed) void refreshUnreadCountsForFriends(friendsRef.current);
      }, 150);
    };

    const updateOne = async (pid: string) => {
      try {
        const result = await getUnreadCount(pid);
        const raw = result.ok ? (result.count || 0) : 0;
        const count = resolveServerUnreadCount(pid, raw);
        if (!disposed) {
          setUnreadByUserState((prev) => {
            const next = patchUnreadCountsIfChanged(prev, { [pid]: count });
            if (next !== prev) persistUnreadMap(next);
            return next;
          });
        }
      } catch {
        // Не затираем optimistic unread при ошибке сети.
      }
    };

    const scheduleReconcileOne = (pid: string) => {
      const prevTimer = reconcileTimers.get(pid);
      if (prevTimer) clearTimeout(prevTimer);
      reconcileTimers.set(
        pid,
        setTimeout(() => {
          reconcileTimers.delete(pid);
          if (!disposed) void updateOne(pid);
        }, UNREAD_SERVER_RECONCILE_DELAY_MS),
      );
    };

    scheduleRecalcAll();

    const offReceived = onMessageReceived((message) => {
      const messageFromStr = String(message.from);
      const isFriend = friendsRef.current.some((f) => String(f.id) === messageFromStr);
      if (!isFriend) return;
      const openChatPeer = String((global as any).__currentChatPeerId || '').trim();
      if (openChatPeer && openChatPeer === messageFromStr) {
        if (!disposed) {
          clearUnreadFloor(messageFromStr);
          setUnreadByUserState((prev) => {
            const next = patchUnreadCountsIfChanged(prev, { [messageFromStr]: 0 });
            if (next !== prev) persistUnreadMap(next);
            return next;
          });
        }
      } else {
        if (!disposed) {
          setUnreadByUserState((prev) => {
            const nextCount = (prev[messageFromStr] || 0) + 1;
            bumpUnreadFloor(messageFromStr, nextCount);
            const next = patchUnreadCountsIfChanged(prev, { [messageFromStr]: nextCount });
            if (next !== prev) persistUnreadMap(next);
            return next;
          });
        }
        // Отложенная сверка с сервером — не мгновенная (сервер часто ещё отдаёт 0).
        scheduleReconcileOne(messageFromStr);
      }
      clearMissedBadgeCleared().then(() => syncAppBadgeFromMissedCount()).catch(() => {});
    });

    const offReadReceipt = onMessageReadReceipt(() => {
      scheduleRecalcAll();
    });

    const offDeleted = onMessageDeleted(() => {
      scheduleRecalcAll();
    });
    const offDeletedBatch = onMessagesDeleted(() => {
      scheduleRecalcAll();
    });

    return () => {
      disposed = true;
      offReceived?.();
      offReadReceipt?.();
      offDeleted?.();
      offDeletedBatch?.();
      if (allTimer) {
        clearTimeout(allTimer);
        allTimer = null;
      }
      reconcileTimers.forEach((t) => clearTimeout(t));
      reconcileTimers.clear();
    };
  }, [
    friendsIdsKey,
    friendsRef,
    refreshUnreadCountsForFriends,
    resolveServerUnreadCount,
    bumpUnreadFloor,
    clearUnreadFloor,
  ]);

  return {
    unreadByUser,
    setUnreadByUser,
    missedByUser,
    setMissedByUser,
    missedLoaded,
    setMissedLoaded,
    refreshUnreadCountsForFriends,
    pendingUnreadBatchRefreshRef,
  };
}
