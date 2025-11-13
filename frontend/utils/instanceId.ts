// utils/instanceId.ts
import 'react-native-get-random-values';
import * as SecureStore from 'expo-secure-store';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';

const KEY = 'INSTANCE_ID';
let inMemory: string | null = null;

export async function getOrCreateInstanceId(): Promise<string> {
  if (inMemory) return inMemory;
  try {
    let id = await SecureStore.getItemAsync(KEY, {
      // на iOS после ребута значение будет доступно после первого разблокирования
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    } as any);
    if (!id) {
      id = uuidv4();
      await SecureStore.setItemAsync(KEY, id);
    }
    inMemory = id;
    return id;
  } catch (e) {
    logger.warn('Fallback to random uuid', e);
    inMemory = uuidv4();
    return inMemory;
  }
}
