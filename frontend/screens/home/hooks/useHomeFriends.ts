import { useCallback, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import socket, {
  fetchFriends,
  API_BASE,
  getCurrentUserId,
} from '../../../sockets/socket';
import { getInstallId } from '../../../utils/installId';
import { logger } from '../../../utils/logger';
import { putThumb, warmAvatar } from '../../../utils/avatarCache';
import {
  FRIENDS_CACHE_KEY_LEGACY,
  FRIENDS_MAX_PAGES_PER_LOAD,
  FRIENDS_PAGE_SIZE,
} from '../constants';
import {
  friendsCacheKeyForIdentity,
  mapToFriend,
  mergeFriendBusyFromFetch,
} from '../friendHelpers';
import type { Friend } from '../types';
import type { HomeMenuTab } from './useHomeMenu';

type UseHomeFriendsArgs = {
  resolvedUserId: string;
  installId: string;
  menuOpen: boolean;
  tab: HomeMenuTab;
  appIsActive: boolean;
};

export function useHomeFriends({
  resolvedUserId,
  installId,
  menuOpen,
  tab,
  appIsActive,
}: UseHomeFriendsArgs) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const friendsRef = useRef<Friend[]>([]);
  const friendsCacheLoadedKeyRef = useRef('');
  const loadFriendsFnRef = useRef<() => void>(() => {});
  const loadFriendsRef = useRef<Promise<void> | null>(null);
  /** Метки времени «точно онлайн» для debounce офлайна в onPresenceUpdate */
  const friendLastOnlineTrueAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  const loadFriends = useCallback(async (options: { includeAvatarThumbs?: boolean } = {}) => {
    if (loadFriendsRef.current) {
      return loadFriendsRef.current;
    }
    const includeAvatarThumbs = options.includeAvatarThumbs !== false;

    const promise = (async () => {
      try {
        let res: any = null;
        const fetchFriendsPage = async (page: number): Promise<any> => {
          const s: any = socket as any;
          if (s?.connected) {
            try {
              const socketRes = await fetchFriends?.(page, FRIENDS_PAGE_SIZE, { includeAvatarThumbs });
              if (socketRes?.ok) return socketRes;
            } catch {}
          }

          const base = String(API_BASE || 'https://api.liviapp.com').replace(/\/+$/, '');
          const id = await getInstallId().catch(() => '');
          if (id) {
            const url = `${base}/api/friends?page=${encodeURIComponent(String(page))}&limit=${FRIENDS_PAGE_SIZE}&includeAvatarThumbs=${includeAvatarThumbs ? '1' : '0'}`;
            const timeouts = [7000, 20000];
            for (const ms of timeouts) {
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), ms);
                const httpRes = await fetch(url, {
                  method: 'GET',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-install-id': String(id),
                  },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (httpRes.ok) {
                  const json = await httpRes.json().catch(() => null);
                  if (json?.ok) {
                    return json;
                  }
                }
              } catch (_) {
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          }
          return { ok: false, list: [], error: 'friends_fetch_failed' };
        };

        const allFriends: any[] = [];
        for (let page = 1; page <= FRIENDS_MAX_PAGES_PER_LOAD; page += 1) {
          const pageRes = await fetchFriendsPage(page);
          if (!pageRes?.ok || !Array.isArray(pageRes?.list)) {
            if (page === 1) res = pageRes;
            break;
          }

          allFriends.push(...pageRes.list);
          res = { ...pageRes, list: allFriends };

          if (pageRes?.pagination?.hasMore !== true) break;
        }

        const logRes = res ? {
          ...res,
          list: res.list?.map((f: any) => ({
            ...f,
            avatarThumbB64: f.avatarThumbB64 ? `[base64: ${f.avatarThumbB64.length} chars]` : undefined
          }))
        } : res;
        void logRes;

        const hasUsableFriendsPayload = !!res?.ok && Array.isArray(res?.list);
        if (!hasUsableFriendsPayload) {
          logger.debug('[loadFriends] Skip friends overwrite: backend payload not usable', {
            ok: !!res?.ok,
            hasList: Array.isArray(res?.list),
            error: String(res?.error || ''),
          });
          return;
        }

        const incoming: any[] = res.list;
        const fresh: Friend[] = incoming.map(mapToFriend);
        const cacheKey = friendsCacheKeyForIdentity(getCurrentUserId(), installId || (await getInstallId().catch(() => '')));
        setFriends((prev) => {
          const merged: Friend[] = fresh.map((f: Friend) => {
            const prevOne = prev.find((p) => p.id === f.id) as any;
            const finalName = (f.name && f.name.trim()) || (prevOne?.name && prevOne.name.trim()) || '';

            if (finalName && finalName.length === 1 && finalName !== '—' && f.name && f.name.trim().length > 1) {
              logger.error('[loadFriends] ❌ КРИТИЧЕСКАЯ ОШИБКА: никнейм обрезан до одной буквы!', {
                friendId: f.id,
                newName: f.name,
                newNameLength: f.name.length,
                prevName: prevOne?.name,
                prevNameLength: prevOne?.name?.length || 0,
                finalName,
                finalNameLength: finalName.length
              });
              const correctedName = f.name.trim();
              logger.info('[loadFriends] Исправляем: используем полный никнейм', { correctedName });

              const newAvatarVer = typeof f.avatarVer === 'number' ? f.avatarVer : (prevOne?.avatarVer || 0);
              const prevAvatarVer = prevOne?.avatarVer || 0;
              const avatarVerChanged = newAvatarVer !== prevAvatarVer;

              let finalAvatarThumbB64: string;
              if (avatarVerChanged || 'avatarThumbB64' in f) {
                finalAvatarThumbB64 = typeof f.avatarThumbB64 === 'string' ? f.avatarThumbB64 : '';
              } else {
                finalAvatarThumbB64 = prevOne?.avatarThumbB64 || '';
              }

              let mergedOnlineCorr: boolean;
              if (f.online) {
                friendLastOnlineTrueAtRef.current.set(f.id, Date.now());
                mergedOnlineCorr = true;
              } else if (prevOne?.online) {
                mergedOnlineCorr = true;
              } else {
                friendLastOnlineTrueAtRef.current.delete(f.id);
                mergedOnlineCorr = false;
              }

              return {
                ...f,
                name: correctedName,
                avatar: f.avatar || prevOne?.avatar || '',
                avatarVer: newAvatarVer,
                avatarThumbB64: finalAvatarThumbB64,
                online: mergedOnlineCorr,
                isBusy: mergeFriendBusyFromFetch(!!f.isBusy, !!prevOne?.isBusy),
                isRandomBusy: !!prevOne?.isRandomBusy,
                inCall: !!prevOne?.inCall,
              } as any;
            }

            const newAvatarVer = typeof f.avatarVer === 'number' ? f.avatarVer : (prevOne?.avatarVer || 0);
            const prevAvatarVer = prevOne?.avatarVer || 0;
            const avatarVerChanged = newAvatarVer !== prevAvatarVer;

            let finalAvatarThumbB64: string;
            if (avatarVerChanged || 'avatarThumbB64' in f) {
              finalAvatarThumbB64 = typeof f.avatarThumbB64 === 'string' ? f.avatarThumbB64 : '';
            } else {
              finalAvatarThumbB64 = prevOne?.avatarThumbB64 || '';
            }

            let mergedOnlineMain: boolean;
            if (f.online) {
              friendLastOnlineTrueAtRef.current.set(f.id, Date.now());
              mergedOnlineMain = true;
            } else if (prevOne?.online) {
              mergedOnlineMain = true;
            } else {
              friendLastOnlineTrueAtRef.current.delete(f.id);
              mergedOnlineMain = false;
            }

            return {
              ...f,
              name: finalName,
              avatar: f.avatar || prevOne?.avatar || '',
              avatarVer: newAvatarVer,
              avatarThumbB64: finalAvatarThumbB64,
              online: mergedOnlineMain,
              isBusy: mergeFriendBusyFromFetch(!!f.isBusy, !!prevOne?.isBusy),
              isRandomBusy: !!prevOne?.isRandomBusy,
              inCall: !!prevOne?.inCall,
            } as any;
          });

          try {
            merged.forEach((f) => {
              if (f.avatarThumbB64 && f.avatarVer) {
                putThumb(f.id, f.avatarVer, f.avatarThumbB64).catch((e) => {
                  logger.warn('Failed to cache thumb:', e);
                });
              }
            });
          } catch (e) {
            logger.warn('Error caching thumbs:', e);
          }

          try {
            const cacheList = merged.map((f: any) => ({
              id: String(f.id),
              name: String(f.name || ''),
              avatar: String(f.avatar || ''),
              avatarVer: typeof f.avatarVer === 'number' ? f.avatarVer : 0,
              avatarThumbB64: String(f.avatarThumbB64 || ''),
            }));
            if (cacheKey) {
              AsyncStorage.setItem(
                cacheKey,
                JSON.stringify({ v: 1, ts: Date.now(), list: cacheList })
              ).catch(() => {});
            }
            AsyncStorage.removeItem(FRIENDS_CACHE_KEY_LEGACY).catch(() => {});
          } catch {}

          return merged;
        });
      } catch (e) {
        logger.warn('Friends load error', e);
      } finally {
        setInitialized(true);
        loadFriendsRef.current = null;
      }
    })();

    loadFriendsRef.current = promise;
    return promise;
  }, [installId]);

  // Поднимаем кэш друзей сразу (до socket/ensureIdentity)
  useEffect(() => {
    const cacheKey = friendsCacheKeyForIdentity(resolvedUserId || getCurrentUserId(), installId);
    if (!cacheKey) return;
    if (friendsCacheLoadedKeyRef.current === cacheKey) return;

    const previousKey = friendsCacheLoadedKeyRef.current;
    friendsCacheLoadedKeyRef.current = cacheKey;
    if (previousKey && previousKey !== cacheKey) {
      setFriends([]);
      friendLastOnlineTrueAtRef.current.clear();
    }

    (async () => {
      try {
        const raw = await AsyncStorage.getItem(cacheKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed?.list) ? parsed.list : (Array.isArray(parsed) ? parsed : []);
        if (!Array.isArray(list) || list.length === 0) return;

        const cached: Friend[] = list
          .map((it: any) => {
            const id = it?.id != null ? String(it.id) : '';
            if (!id) return null;
            return {
              id,
              name: String(it?.name || ''),
              avatar: String(it?.avatar || ''),
              avatarVer: typeof it?.avatarVer === 'number' ? it.avatarVer : 0,
              avatarThumbB64: String(it?.avatarThumbB64 || ''),
              online: false,
              isBusy: false,
            } as any;
          })
          .filter(Boolean) as Friend[];

        if (cached.length > 0) {
          setFriends((prev) => {
            if (friendsCacheLoadedKeyRef.current !== cacheKey) return prev;
            return prev && prev.length > 0 ? prev : cached;
          });
          setInitialized(true);
        }
      } catch {}
    })();
  }, [resolvedUserId, installId]);

  useEffect(() => {
    loadFriendsFnRef.current = () => {
      loadFriends().catch(() => {});
    };
  }, [loadFriends]);

  /* ===== refresh friends when menu friends tab open ===== */
  useEffect(() => {
    if (menuOpen && tab === 'friends' && appIsActive) {
      setInitialized(true);
      void loadFriends();
      const tmr = setInterval(() => void loadFriends({ includeAvatarThumbs: false }), 2 * 60_000);
      return () => clearInterval(tmr);
    }
  }, [menuOpen, tab, appIsActive, loadFriends]);

  /* ===== warm avatar cache когда открыта вкладка друзей === */
  useEffect(() => {
    if (menuOpen && tab === 'friends' && friends.length > 0) {
      friends.forEach((f) => {
        if (f.avatarVer) {
          warmAvatar(f.id, f.avatarVer).catch(() => {});
        }
      });
    }
  }, [menuOpen, tab, friends]);

  return {
    friends,
    setFriends,
    initialized,
    setInitialized,
    refreshing,
    setRefreshing,
    friendsRef,
    loadFriends,
    loadFriendsFnRef,
    friendLastOnlineTrueAtRef,
  };
}
