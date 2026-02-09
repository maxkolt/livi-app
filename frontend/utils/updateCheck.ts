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

/** Текущая версия приложения. В релизе приоритет у nativeApplicationVersion (реальная версия из системы). */
export function getCurrentAppVersion(): string {
  try {
    const { nativeApplicationVersion } = require('expo-application');
    const native = nativeApplicationVersion ? String(nativeApplicationVersion).trim() : '';
    if (native) return native;
  } catch {}
  const v = (Constants.expoConfig as any)?.version ?? '';
  if (v) return String(v).trim();
  return '0';
}

let cachedLatest: string | null = null;
let cachedAt = 0;
const CACHE_MS = 2 * 60 * 1000; // 2 минуты (чаще проверяем при возврате в приложение)

/** Сбросить кэш версии (при возврате в приложение — запросить свежую версию с сервера). */
export function clearUpdateCheckCache(): void {
  cachedLatest = null;
  cachedAt = 0;
}

/** Таймаут запроса (при VPN/медленной сети запрос может идти дольше). */
const FETCH_TIMEOUT_MS = 15000;

/** Загружает latestAppVersion с бэкенда (с кэшем 2 мин). При ошибке — две повторные попытки с паузой (релиз, VPN, холодный старт). */
export async function fetchLatestAppVersion(): Promise<string | null> {
  if (cachedLatest !== null && Date.now() - cachedAt < CACHE_MS) return cachedLatest;
  const tryFetch = async (): Promise<string | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(APP_SETTINGS_URL, { method: 'GET', signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const data = await res.json();
      const latest = (data?.latestAppVersion ?? '').trim();
      if (latest) {
        cachedLatest = latest;
        cachedAt = Date.now();
        return latest;
      }
      return null;
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await tryFetch();
      if (result) return result;
    } catch {
      // Сеть/VPN/таймаут — повтор через 2 с
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return null;
}

/** Есть ли доступное обновление (текущая версия меньше той, что на сервере). */
export async function isUpdateAvailable(): Promise<boolean> {
  const latest = await fetchLatestAppVersion();
  const current = getCurrentAppVersion();
  const available = !!(latest && isVersionLess(current, latest));
  if (__DEV__) {
    console.log('[UpdateCheck] current:', current, 'latest from server:', latest ?? '(null)', '→ update available:', available);
  }
  return available;
}

/** Показывать ли бейдж «Скачайте обновление». В релизе — при каждом входе, если есть обновление; в __DEV__ — раз в сутки (или всегда для проверки UI). */
export async function shouldShowUpdateBadge(): Promise<boolean> {
  const available = await isUpdateAvailable();
  if (!available) return false;
  if (__DEV__) {
    // в dev можно ограничить показ раз в сутки или показывать всегда
    try {
      const raw = await AsyncStorage.getItem(LAST_UPDATE_BADGE_SHOWN_KEY);
      const last = raw ? parseInt(raw, 10) : 0;
      if (Number.isNaN(last) || Date.now() - last >= BADGE_COOLDOWN_MS) return true;
    } catch {
      return true;
    }
    return false;
  }
  // в релизе — показывать бейдж при каждом входе, если приложение не обновлено
  return true;
}

/** Отметить, что бейдж показан (сбрасывает показ на 24 ч). */
export async function markUpdateBadgeShown(): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_UPDATE_BADGE_SHOWN_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

/** Сбросить кулдаун показа бейджа (для тестов; в __DEV__ можно вызвать из консоли). */
export async function clearUpdateCooldownForTesting(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_UPDATE_BADGE_SHOWN_KEY);
    if (__DEV__) console.log('[UpdateCheck] Cooldown cleared for testing');
  } catch {
    // ignore
  }
}
