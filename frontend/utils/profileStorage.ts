// utils/profileStorage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

export type StoredProfile = { nick?: string; avatar?: string };

const KEY = 'livi.profile.v1';

// ——— внутренняя утилита: берём из патча ТОЛЬКО допустимые ключи
function sanitizePatch(patch: StoredProfile, current?: StoredProfile): StoredProfile {
  const out: StoredProfile = {};

  if (typeof patch.nick === 'string') {
    out.nick = patch.nick; // допускаем и '' для очистки
  }

  if (typeof patch.avatar === 'string') {
    const raw = patch.avatar.trim();
    if (!raw) {
      // явная очистка
      out.avatar = '';
    } else if (/^https?:\/\//i.test(raw)) {
      // только публичные URL
      out.avatar = raw;
    } else {
      // локальные URI НЕ пишем в постоянный профиль — оставляем как было
      out.avatar = current?.avatar ?? '';
    }
  }

  return out;
}

export async function loadProfileFromStorage(): Promise<StoredProfile | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredProfile;

    // на всякий случай нормализуем, если когда-то записалось что-то не то
    const nick = typeof parsed.nick === 'string' ? parsed.nick : '';
    const avatar =
      typeof parsed.avatar === 'string' && /^https?:\/\//i.test(parsed.avatar)
        ? parsed.avatar
        : '';

    return { nick, avatar };
  } catch (e) {
    return null;
  }
}

export async function saveProfileToStorage(patch: StoredProfile): Promise<void> {
  try {
    const cur = await loadProfileFromStorage();
    const clean = sanitizePatch(patch, cur || undefined);
    const next: StoredProfile = { ...(cur || {}), ...clean };
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch (e) {}
}

export async function clearNickInStorage(): Promise<void> {
  try {
    await saveProfileToStorage({ nick: '' });
  } catch {}
}

export async function clearAvatarInStorage(): Promise<void> {
  try {
    await saveProfileToStorage({ avatar: '' });
  } catch {}
}

export async function clearProfileStorage(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {}
}

/**
 * Полная очистка всех кэшей аватара
 * Удаляет аватар из AsyncStorage и очищает кэш Expo Image
 */
export async function clearAllAvatarCaches(): Promise<void> {
  try {
    // 1. Очищаем профиль из AsyncStorage
    await clearProfileStorage();
    
    // 2. Очищаем кэш Expo Image (если доступен)
    try {
      if (typeof (global as any).expo !== 'undefined' && (global as any).expo.Image) {
        await (global as any).expo.Image.clearMemoryCache();
      }
    } catch (e) {}
    
    // 3. Очищаем кэш диска (если доступен)
    try {
      if (typeof (global as any).expo !== 'undefined' && (global as any).expo.Image) {
        await (global as any).expo.Image.clearDiskCache();
      }
    } catch (e) {}
    
  } catch (e) {
    logger.error('Error clearing avatar caches:', e);
  }
}

/**
 * Принудительная очистка всех кэшей с детальным логированием
 * Используйте эту функцию для отладки проблем с кэшированием
 */
export async function forceClearAllCaches(): Promise<void> {
  
  try {
    // 1. Проверяем текущее состояние
    const currentProfile = await loadProfileFromStorage();
    
    // 2. Очищаем AsyncStorage
    await clearProfileStorage();
    
    // 3. Проверяем, что очистилось
    const afterClear = await loadProfileFromStorage();
    
    // 4. Очищаем Expo Image кэши
    try {
      if (typeof (global as any).expo !== 'undefined' && (global as any).expo.Image) {
        await (global as any).expo.Image.clearMemoryCache();
        
        await (global as any).expo.Image.clearDiskCache();
      } else {
      }
    } catch (e) {}
    
  } catch (e) {
    logger.error('Force clear failed:', e);
    throw e;
  }
}
