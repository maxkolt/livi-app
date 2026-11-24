import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';
import { ExpiringLruCache } from './expiringLruCache';
import { subscribeMemoryPressure } from './memoryPressure';
import { invalidateAvatarCaches, subscribeAvatarCacheInvalidation } from './avatarCacheInvalidation';

const FULL = (id: string, v: number) => `avatar:${id}:ver:${v}`;
const THUMB = (id: string, v: number) => `avatarThumb:${id}:ver:${v}`;

/**
 * Полные аватары, уже прочитанные в этой сессии: экран (шапка чата) берёт их сразу,
 * без асинхронного чтения и лишней перерисовки при открытии. Небольшой — последние N.
 */
const fullMem = new ExpiringLruCache<string, string>({
  maxEntries: 24, maxCost: 8 * 1024 * 1024, ttlMs: 5 * 60 * 1000,
  cost: (value, key) => (value.length + key.length) * 2,
});
let cacheGeneration = 0;
let clearingAll = 0;
const clearingUsers = new Map<string, number>();
subscribeMemoryPressure(() => {
  cacheGeneration++;
  fullMem.clear();
});

function rememberFull(key: string, dataUri: string) {
  fullMem.set(key, dataUri);
}

/**
 * Сохранить полный аватар (data URI)
 */
export async function putFull(id: string, v: number, dataUri: string) {
  rememberFull(FULL(id, v), dataUri);
  await AsyncStorage.setItem(FULL(id, v), dataUri);
}

/**
 * Получить полный аватар (data URI)
 */
export async function getFull(id: string, v: number) {
  if (clearingAll || clearingUsers.has(id)) return null;
  const key = FULL(id, v);
  const mem = fullMem.get(key);
  if (mem) return mem;
  const generation = cacheGeneration;
  let deleted = false;
  const unsubscribe = subscribeAvatarCacheInvalidation(userId => {
    if (userId === undefined || userId === id) deleted = true;
  });
  try {
    const stored = await AsyncStorage.getItem(key);
    // A read begun before deletion must not bring the removed photo back.
    if (deleted) return fullMem.get(key) ?? null;
    const current = fullMem.get(key);
    if (current) return current;
    if (stored && generation === cacheGeneration) rememberFull(key, stored);
    return stored;
  } finally { unsubscribe(); }
}

/** Полный аватар, если он уже в памяти этой сессии, — синхронно; иначе null. */
export function peekFull(id: string, v: number): string | null {
  if (!id || !v) return null;
  return fullMem.get(FULL(id, v)) ?? null;
}

/**
 * Сохранить миниатюру аватара (data URI)
 */
export async function putThumb(id: string, v: number, dataUri: string) {
  await AsyncStorage.setItem(THUMB(id, v), dataUri);
}

/**
 * Получить миниатюру аватара (data URI)
 */
async function getThumb(id: string, v: number) {
  if (clearingAll || clearingUsers.has(id)) return null;
  return AsyncStorage.getItem(THUMB(id, v));
}

/**
 * Очистка старых версий аватаров для конкретного пользователя
 */
export async function clearAvatarCacheFor(id: string) {
  clearingUsers.set(id, (clearingUsers.get(id) ?? 0) + 1);
  cacheGeneration++;
  for (const key of fullMem.keys()) if (key.startsWith(`avatar:${id}:`)) fullMem.delete(key);
  invalidateAvatarCaches(id);
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter(k => k.startsWith(`avatar:${id}:`) || k.startsWith(`avatarThumb:${id}:`));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } finally {
    const remaining = (clearingUsers.get(id) ?? 1) - 1;
    if (remaining) clearingUsers.set(id, remaining);
    else clearingUsers.delete(id);
  }
}

/**
 * Получить data URI аватара (сначала проверяет кэш, потом запрашивает с сервера если нужно)
 * @param userId - ID пользователя
 * @param ver - версия аватара
 * @param isThumbnail - получить миниатюру вместо полного аватара
 * @returns data URI или null
 */
export async function getAvatarUri(userId: string, ver = 0, isThumbnail = false): Promise<string | null> {
  try {
    if (!ver) return null;

    // Проверяем кэш
    const cached = isThumbnail 
      ? await getThumb(userId, ver)
      : await getFull(userId, ver);

    if (cached) {
      return cached;
    }

    return null; // Если в кэше нет, возвращаем null
  } catch (e) {
    logger.warn(`getAvatarUri error for ${userId}:`, e);
    return null;
  }
}

/**
 * Предзагрузка аватара (заглушка для совместимости)
 */
export async function warmAvatar(userId: string, ver = 0) {
  // С новым подходом data URI приходит сразу в списке,
  // поэтому предзагрузка не требуется
  return;
}

/**
 * Очистить весь кэш аватаров
 */
export async function clearAvatarCache() {
  clearingAll++;
  cacheGeneration++;
  fullMem.clear();
  invalidateAvatarCaches();
  try {
    const keys = await AsyncStorage.getAllKeys();
    const avatarKeys = keys.filter(k => k.startsWith('avatar:') || k.startsWith('avatarThumb:'));
    if (avatarKeys.length > 0) {
      await AsyncStorage.multiRemove(avatarKeys);
    }
  } catch (e) {
    logger.warn('clearAvatarCache error:', e);
  } finally { clearingAll--; }
}
