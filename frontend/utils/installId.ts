import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'livi.installId';
const randomId = () => `inst_${Math.random().toString(36).slice(2, 10)}`;

async function getSecure(k: string) { try { return await SecureStore.getItemAsync(k); } catch { return null; } }
async function setSecure(k: string, v: string) { try { await SecureStore.setItemAsync(k, v); } catch {} }
async function delSecure(k: string) { try { await SecureStore.deleteItemAsync(k); } catch {} }

export async function getInstallId(): Promise<string> {
  let id = Platform.OS !== 'web' ? await getSecure(KEY) : null;
  if (!id) id = (await AsyncStorage.getItem(KEY)) || '';
  if (!id) id = randomId();

  if (Platform.OS !== 'web') await setSecure(KEY, id);
  await AsyncStorage.setItem(KEY, id);
  return id;
}

export async function resetInstallId(): Promise<void> {
  if (Platform.OS !== 'web') await delSecure(KEY);
  await AsyncStorage.removeItem(KEY);
}
