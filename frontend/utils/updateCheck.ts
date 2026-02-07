/**
 * Проверка доступности обновления приложения и логика показа уведомления (раз в сутки).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { API_BASE } from '../sockets/socket';

const APP_SETTINGS_URL = `${API_BASE}/api/app-settings`;
const LAST_UPDATE_BADGE_SHOWN_KEY = 'livi.lastUpdateBadgeShownAt';
const BADGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 часа

/** Ссылка на страницу обновления в Google Play (internal test). */
export const PLAY_STORE_UPDATE_URL = 'https://play.google.com/apps/internaltest/4700615664551768658';

/** Сравнение версий "a.b.c": true если current < latest. */
function isVersionLess(current: string, latest: string): boolean {
  const cur = (current || '0').split('.').map(Number);
  const lat = (latest || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (c < l) return true;
    if (c > l) return false;
  }
  return false;
}

/** Текущая версия приложения (из app.json / expo). */
export function getCurrentAppVersion(): string {
  const v = (Constants.expoConfig as any)?.version ?? '';
  if (v) return String(v).trim();
  try {
    const { nativeApplicationVersion } = require('expo-application');
    return String(nativeApplicationVersion ?? '0').trim();
  } catch {
    return '0';
  }
}

let cachedLatest: string | null = null;
let cachedAt = 0;
const CACHE_MS = 60 * 60 * 1000; // 1 час

/** Загружает latestAppVersion с бэкенда (с кэшем 1 ч). */
export async function fetchLatestAppVersion(): Promise<string | null> {
  if (cachedLatest !== null && Date.now() - cachedAt < CACHE_MS) return cachedLatest;
  try {
    const res = await fetch(APP_SETTINGS_URL, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    const latest = (data?.latestAppVersion ?? '').trim();
    if (latest) {
      cachedLatest = latest;
      cachedAt = Date.now();
      return latest;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Есть ли доступное обновление (текущая версия меньше той, что на сервере). */
export async function isUpdateAvailable(): Promise<boolean> {
  const latest = await fetchLatestAppVersion();
  if (!latest) return false;
  const current = getCurrentAppVersion();
  return isVersionLess(current, latest);
}

/** Показывать ли бейдж «Скачайте обновление» (раз в сутки; в __DEV__ — всегда, чтобы проверить UI). */
export async function shouldShowUpdateBadge(): Promise<boolean> {
  const available = await isUpdateAvailable();
  if (!available) return false;
  if (__DEV__) return true; // в dev всегда показываем бейдж для проверки UI
  try {
    const raw = await AsyncStorage.getItem(LAST_UPDATE_BADGE_SHOWN_KEY);
    const last = raw ? parseInt(raw, 10) : 0;
    if (Number.isNaN(last) || Date.now() - last >= BADGE_COOLDOWN_MS) return true;
  } catch {
    return true;
  }
  return false;
}

/** Отметить, что бейдж показан (сбрасывает показ на 24 ч). */
export async function markUpdateBadgeShown(): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_UPDATE_BADGE_SHOWN_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}
