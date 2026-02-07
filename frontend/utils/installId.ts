import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAndroidId } from 'expo-application';

const KEY = 'livi.installId';
const randomId = () => `inst_${Math.random().toString(36).slice(2, 10)}`;

/** На Android при первом запуске (нет сохранённого id) используем стабильный Android ID,
 * чтобы после переустановки приложения тот же телефон получил тот же installId и подтянул данные из MongoDB. */
function getStableAndroidInstallId(): string | null {
  if (Platform.OS !== 'android') return null;
  try {
    const androidId = getAndroidId();
    if (androidId && typeof androidId === 'string' && androidId.length > 0) {
      return `inst_android_${androidId}`;
    }
  } catch {
    // getAndroidId throws on non-Android or if unavailable; fallback to random
  }
  return null;
}

async function getSecure(k: string) { try { return await SecureStore.getItemAsync(k); } catch { return null; } }
async function setSecure(k: string, v: string) { try { await SecureStore.setItemAsync(k, v); } catch {} }
async function delSecure(k: string) { try { await SecureStore.deleteItemAsync(k); } catch {} }

export async function getInstallId(): Promise<string> {
  let id = Platform.OS !== 'web' ? await getSecure(KEY) : null;
  if (!id) id = (await AsyncStorage.getItem(KEY)) || '';
  if (!id) id = getStableAndroidInstallId() ?? randomId();

  if (Platform.OS !== 'web') await setSecure(KEY, id);
  await AsyncStorage.setItem(KEY, id);
  return id;
}

export async function resetInstallId(): Promise<void> {
  if (Platform.OS !== 'web') await delSecure(KEY);
  await AsyncStorage.removeItem(KEY);
}
