/**
 * Проверка доступности обновления приложения и логика показа уведомления (раз в сутки).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { API_BASE } from '../sockets/socket';

const APP_SETTINGS_URL = `${API_BASE}/api/app-settings`;
const LAST_UPDATE_BADGE_SHOWN_KEY = 'livi.lastUpdateBadgeShownAt';
/** При какой server latestAppVersion пользователь закрыл напоминание — если на сервере выше, кулдаун сбрасывается */
const LAST_UPDATE_BADGE_FOR_LATEST_KEY = 'livi.lastUpdateBadgeForLatest';
const LAST_KNOWN_ON_LATEST_VERSION_KEY = 'livi.lastKnownOnLatestVersion'; // после обновления: не показывать бейдж при ошибке сети/VPN
const BADGE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 часа

/** Публичная страница LiVi в Google Play (обновление и установка). */
export const PLAY_STORE_UPDATE_URL =
  'https://play.google.com/store/apps/details?id=com.kolt12max.livi';

/** Разбор версии в числовые части (v1.2.3-rc → [1,2,3], нечисловые сегменты → 0). */
function versionToParts(raw: string): number[] {
  const s = (raw || '')
    .trim()
    .replace(/^\uFEFF/, '')
    .replace(/^v/i, '');
  if (!s) return [0];
  return s.split('.').map((seg) => {
    const m = /^\d+/.exec(seg.trim());
    const n = m ? parseInt(m[0], 10) : NaN;
    return Number.isFinite(n) ? n : 0;
  });
}

/** Канонический ключ для сравнения с сохранённым «мы на последней» (одинаково для 1.01.0 и 1.1.0). */
export function normalizeVersionKey(v: string): string {
  return versionToParts(v).join('.');
}

/** Сравнение версий: true если current строго меньше latest. */
function isVersionLess(current: string, latest: string): boolean {
  const cur = versionToParts(current);
  const lat = versionToParts(latest);
  for (let i = 0; i < Math.max(cur.length, lat.length); i++) {
    const c = cur[i] ?? 0;
    const l = lat[i] ?? 0;
    if (c < l) return true;
    if (c > l) return false;
  }
  return false;
}

/** Текущая версия приложения для проверки обновлений.
 * Приоритет: nativeBuildVersion (Android versionCode / iOS buildNumber), затем nativeApplicationVersion.
 */
export function getCurrentAppVersion(): string {
  try {
    const { nativeBuildVersion, nativeApplicationVersion } = require('expo-application');
    const build = nativeBuildVersion ? String(nativeBuildVersion).trim() : '';
    if (build) return build;
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

/** Последний залогированный результат (current, latest, available) — логируем только при смене. */
let lastLogged: { current: string; latest: string; available: boolean } | null = null;

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

/** Быстрая проверка без сети: ранее мы уже считали, что приложение на последней версии? Тогда не показывать обновление. */
export async function isLikelyOnLatestVersion(): Promise<boolean> {
  try {
    const current = normalizeVersionKey(getCurrentAppVersion());
    const lastKnown = await AsyncStorage.getItem(LAST_KNOWN_ON_LATEST_VERSION_KEY);
    return lastKnown != null && normalizeVersionKey(lastKnown) === current;
  } catch {
    return false;
  }
}

/** Есть ли доступное обновление (текущая версия меньше той, что на сервере). Не зависит от VPN: при ошибке сети считаем «на последней», если ранее уже определяли current >= latest. */
export async function isUpdateAvailable(): Promise<boolean> {
  const current = getCurrentAppVersion();
  const latest = await fetchLatestAppVersion();

  if (latest !== null) {
    const available = isVersionLess(current, latest);
    if (!available) {
      try {
        await AsyncStorage.setItem(LAST_KNOWN_ON_LATEST_VERSION_KEY, normalizeVersionKey(current));
      } catch {
        // ignore
      }
    } else {
      try {
        await AsyncStorage.removeItem(LAST_KNOWN_ON_LATEST_VERSION_KEY);
      } catch {
        // ignore
      }
    }
    if (__DEV__) {
      const prev = lastLogged;
      const changed = !prev || prev.current !== current || prev.latest !== latest || prev.available !== available;
      if (changed) {
        lastLogged = { current, latest, available };
        console.log('[UpdateCheck] current:', current, 'latest from server:', latest, '→ update available:', available);
      }
    }
    return available;
  }

  // Ошибка сети/VPN: не показывать обновление, если ранее уже считали, что пользователь на последней версии
  try {
    const lastKnown = await AsyncStorage.getItem(LAST_KNOWN_ON_LATEST_VERSION_KEY);
    if (lastKnown != null && normalizeVersionKey(lastKnown) === normalizeVersionKey(current)) {
      if (__DEV__) {
        const prev = lastLogged;
        if (!prev || prev.current !== current || prev.latest !== '(null)' || prev.available !== false) {
          lastLogged = { current, latest: '(null)', available: false };
          console.log('[UpdateCheck] fetch failed, lastKnownOnLatest=', lastKnown, '→ no update');
        }
      }
      return false;
    }
  } catch {
    // ignore
  }
  if (__DEV__) {
    const prev = lastLogged;
    if (!prev || prev.current !== current || prev.latest !== '(null)' || prev.available !== false) {
      lastLogged = { current, latest: '(null)', available: false };
      console.log('[UpdateCheck] current:', current, 'latest from server: (null)', '→ no update (offline)');
    }
  }
  return false;
}

/**
 * Активен ли кулдаун напоминания об обновлении (24 ч).
 * Если с момента закрытия на сервере выросла latestAppVersion — кулдаун не действует.
 */
export async function isUpdateReminderCooldownActive(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(LAST_UPDATE_BADGE_SHOWN_KEY);
    if (raw == null) return false;
    const at = Number(raw);
    if (!Number.isFinite(at) || Date.now() - at >= BADGE_COOLDOWN_MS) return false;

    const shownFor = await AsyncStorage.getItem(LAST_UPDATE_BADGE_FOR_LATEST_KEY);
    if (shownFor == null) return true;

    const latest = await fetchLatestAppVersion();
    if (latest != null && normalizeVersionKey(latest) !== normalizeVersionKey(shownFor)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Показывать ли баннер «Скачайте обновление».
 * В dev — всегда true при включённом updateAvailable.
 * В релизе — с учётом кулдауна; передайте `prefetchedServerSaysUpdate` из той же проверки, что и таб «Ещё», чтобы не вызывать isUpdateAvailable() второй раз (меньше сети и дублей логов).
 */
export async function shouldShowUpdateBadge(prefetchedServerSaysUpdate?: boolean): Promise<boolean> {
  if (__DEV__) return true;
  if (await isUpdateReminderCooldownActive()) return false;
  if (typeof prefetchedServerSaysUpdate === 'boolean') return prefetchedServerSaysUpdate;
  return isUpdateAvailable();
}

/** Отметить напоминание (кулдаун 24 ч; привязка к текущей latest с сервера — чтобы новый релиз снова показал бейдж). */
export async function markUpdateBadgeShown(): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_UPDATE_BADGE_SHOWN_KEY, String(Date.now()));
    const latest = await fetchLatestAppVersion();
    if (latest) await AsyncStorage.setItem(LAST_UPDATE_BADGE_FOR_LATEST_KEY, latest.trim());
  } catch {
    // ignore
  }
}

/** Сбросить кулдаун показа бейджа (для тестов; в __DEV__ можно вызвать из консоли). */
export async function clearUpdateCooldownForTesting(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_UPDATE_BADGE_SHOWN_KEY);
    await AsyncStorage.removeItem(LAST_UPDATE_BADGE_FOR_LATEST_KEY);
    if (__DEV__) console.log('[UpdateCheck] Cooldown cleared for testing');
  } catch {
    // ignore
  }
}

/** Когда приложение уже не отстаёт от сервера — сбросить отложенное напоминание (не залипает после обновления). */
export async function clearUpdatePromotionWhenUpToDate(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_UPDATE_BADGE_SHOWN_KEY);
    await AsyncStorage.removeItem(LAST_UPDATE_BADGE_FOR_LATEST_KEY);
  } catch {
    // ignore
  }
}
