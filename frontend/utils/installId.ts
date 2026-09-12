import 'react-native-get-random-values';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAndroidId, getIosIdForVendorAsync } from 'expo-application';

const KEY = 'livi.installId';
/** Секрет установки (installSecret): случайное значение высокой энтропии, доказывающее
 * владение installId серверу (identity:attach). Хранится ТОЛЬКО в SecureStore (Keychain/Keystore) —
 * никогда в AsyncStorage — и никогда не логируется целиком. См. backend/utils/installSecret.ts. */
const SECRET_KEY = 'livi.installSecret';
const randomId = () => `inst_${Math.random().toString(36).slice(2, 10)}`;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  // react-native-get-random-values полифиллит crypto.getRandomValues криптостойким генератором.
  (globalThis as any).crypto.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

let installSecretLoadPromise: Promise<string | null> | null = null;

/** Возвращает (создавая при первом вызове) секрет установки. На web возвращает null —
 * SecureStore недоступен, эти клиенты остаются в legacy-режиме (без installSecret). */
export async function getInstallSecret(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  if (!installSecretLoadPromise) {
    installSecretLoadPromise = (async () => {
      try {
        let secret = await SecureStore.getItemAsync(SECRET_KEY);
        if (!secret) {
          secret = randomHex(32); // 256 бит энтропии
          await SecureStore.setItemAsync(SECRET_KEY, secret);
        }
        return secret;
      } catch (e) {
        return null;
      } finally {
        installSecretLoadPromise = null;
      }
    })();
  }
  return installSecretLoadPromise;
}

let installIdLoggedOnce = false;
/** Сериализуем параллельные getInstallId(), чтобы не создать два разных id до записи в SecureStore. */
let installIdLoadPromise: Promise<string> | null = null;

/** На Android при первом запуске (нет сохранённого id) используем стабильный Android ID,
 * чтобы после переустановки приложения тот же телефон получил тот же installId и подтянул данные из MongoDB. */
function getStableAndroidInstallIdSync(): string | null {
  if (Platform.OS !== 'android') return null;
  try {
    const androidId = getAndroidId();
    if (androidId && typeof androidId === 'string' && androidId.length > 0) {
      return `inst_android_${androidId}`;
    }
  } catch {
    // getAndroidId throws on non-Android or if unavailable
  }
  return null;
}

/** С повторной попыткой после задержки — на первом запуске после установки нативный модуль может ещё не отдать ANDROID_ID. */
async function getStableAndroidInstallId(): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  let id = getStableAndroidInstallIdSync();
  if (id) return id;
  await new Promise((r) => setTimeout(r, 400));
  id = getStableAndroidInstallIdSync();
  if (__DEV__ && !installIdLoggedOnce) {
    installIdLoggedOnce = true;
    if (id) console.log('[installId] Using stable Android ID (data will restore after reinstall)');
    else console.warn('[installId] Android ID unavailable after retry — using random ID (data will not restore after reinstall)');
  }
  return id;
}

/** На iOS при первом запуске (нет сохранённого id) используем IDFV — после переустановки
 * он может сохраниться (если не удалены все приложения вендора), тогда данные подтянутся из MongoDB. */
async function getStableIosInstallId(): Promise<string | null> {
  if (Platform.OS !== 'ios') return null;
  try {
    const idfv = await getIosIdForVendorAsync();
    if (idfv && typeof idfv === 'string' && idfv.length > 0) {
      return `inst_ios_${idfv}`;
    }
  } catch {
    // ignore
  }
  return null;
}

async function getSecure(k: string) { try { return await SecureStore.getItemAsync(k); } catch { return null; } }
async function setSecure(k: string, v: string) { try { await SecureStore.setItemAsync(k, v); } catch {} }
async function delSecure(k: string) { try { await SecureStore.deleteItemAsync(k); } catch {} }

async function loadOrCreateInstallId(): Promise<string> {
  let id = Platform.OS !== 'web' ? await getSecure(KEY) : null;
  if (!id) id = (await AsyncStorage.getItem(KEY)) || '';
  if (!id) {
    if (Platform.OS === 'ios') {
      id = (await getStableIosInstallId()) ?? randomId();
    } else if (Platform.OS === 'android') {
      id = (await getStableAndroidInstallId()) ?? randomId();
    } else {
      id = randomId();
    }
  }

  if (Platform.OS !== 'web') await setSecure(KEY, id);
  await AsyncStorage.setItem(KEY, id);
  if (__DEV__ && !installIdLoggedOnce) {
    installIdLoggedOnce = true;
    const type = id.startsWith('inst_android_') ? 'Android ID (stable)' : id.startsWith('inst_ios_') ? 'IDFV (stable)' : 'random';
    console.log('[installId]', type, '→', id.slice(0, 24) + (id.length > 24 ? '…' : ''));
  }
  return id;
}

export async function getInstallId(): Promise<string> {
  if (!installIdLoadPromise) {
    installIdLoadPromise = loadOrCreateInstallId().finally(() => {
      installIdLoadPromise = null;
    });
  }
  return installIdLoadPromise;
}

export async function resetInstallId(): Promise<void> {
  installIdLoadPromise = null;
  if (Platform.OS !== 'web') {
    await delSecure(KEY);
    try { await SecureStore.deleteItemAsync(SECRET_KEY); } catch {}
  }
  await AsyncStorage.removeItem(KEY);
}
