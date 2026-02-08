import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAndroidId, getIosIdForVendorAsync } from 'expo-application';

const KEY = 'livi.installId';
const randomId = () => `inst_${Math.random().toString(36).slice(2, 10)}`;

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
  if (__DEV__) {
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

export async function getInstallId(): Promise<string> {
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
  if (__DEV__) {
    const type = id.startsWith('inst_android_') ? 'Android ID (stable)' : id.startsWith('inst_ios_') ? 'IDFV (stable)' : 'random';
    console.log('[installId]', type, '→', id.slice(0, 24) + (id.length > 24 ? '…' : ''));
  }
  return id;
}

export async function resetInstallId(): Promise<void> {
  if (Platform.OS !== 'web') await delSecure(KEY);
  await AsyncStorage.removeItem(KEY);
}
