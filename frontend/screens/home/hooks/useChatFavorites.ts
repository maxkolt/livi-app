import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId } from '../../../sockets/socket';
import { CHAT_FAVORITES_KEY } from '../constants';

function storageKey(userId?: string): string {
  const uid = String(userId || getCurrentUserId() || '').trim();
  return uid ? `${CHAT_FAVORITES_KEY}:${uid}` : CHAT_FAVORITES_KEY;
}

function parseIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((id) => String(id || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function useChatFavorites(userId?: string) {
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const key = storageKey(userId);
    AsyncStorage.getItem(key)
      .then((raw) => {
        if (cancelled) return;
        setFavoriteIds(parseIds(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const toggleFavorite = useCallback(
    (friendId: string) => {
      const id = String(friendId || '').trim();
      if (!id) return;
      setFavoriteIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        AsyncStorage.setItem(storageKey(userId), JSON.stringify([...next])).catch(() => {});
        return next;
      });
    },
    [userId],
  );

  const isFavorite = useCallback((friendId: string) => favoriteIds.has(String(friendId)), [favoriteIds]);

  return { favoriteIds, toggleFavorite, isFavorite };
}
