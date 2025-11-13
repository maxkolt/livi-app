import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

const FULL = (id: string, v: number) => `avatar:${id}:ver:${v}`;
const THUMB = (id: string, v: number) => `avatarThumb:${id}:ver:${v}`;

/**
 * Сохранить полный аватар (data URI)
 */
export async function putFull(id: string, v: number, dataUri: string) {
  await AsyncStorage.setItem(FULL(id, v), dataUri);
}

/**
 * Получить полный аватар (data URI)
 */
export async function getFull(id: string, v: number) {
  return AsyncStorage.getItem(FULL(id, v));
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
export async function getThumb(id: string, v: number) {
  return AsyncStorage.getItem(THUMB(id, v));
}

/**
 * Очистка старых версий аватаров для конкретного пользователя
 */
export async function clearAvatarCacheFor(id: string) {
  const keys = await AsyncStorage.getAllKeys();
  const mine = keys.filter(k => k.includes(`avatar:${id}:`) || k.includes(`avatarThumb:${id}:`));
  if (mine.length) await AsyncStorage.multiRemove(mine);
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
  try {
    const keys = await AsyncStorage.getAllKeys();
    const avatarKeys = keys.filter(k => k.startsWith('avatar:') || k.startsWith('avatarThumb:'));
    if (avatarKeys.length > 0) {
      await AsyncStorage.multiRemove(avatarKeys);
    }
  } catch (e) {
    logger.warn('clearAvatarCache error:', e);
  }
}
