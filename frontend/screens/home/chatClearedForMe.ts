import AsyncStorage from '@react-native-async-storage/async-storage';
import { CHAT_CLEARED_FOR_ME_KEY } from './constants';

async function readClearedIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(CHAT_CLEARED_FOR_ME_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((id) => String(id || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function writeClearedIds(ids: string[]): Promise<void> {
  const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (unique.length === 0) {
    await AsyncStorage.removeItem(CHAT_CLEARED_FOR_ME_KEY).catch(() => {});
    return;
  }
  await AsyncStorage.setItem(CHAT_CLEARED_FOR_ME_KEY, JSON.stringify(unique)).catch(() => {});
}

export async function getClearedForMePeerIds(): Promise<Set<string>> {
  return new Set(await readClearedIds());
}

export async function markChatsClearedForMe(peerIds: string[]): Promise<void> {
  const add = peerIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (!add.length) return;
  const prev = await readClearedIds();
  await writeClearedIds([...prev, ...add]);
}

export async function unmarkChatsClearedForMe(peerIds: string[]): Promise<void> {
  const remove = new Set(peerIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (!remove.size) return;
  const prev = await readClearedIds();
  await writeClearedIds(prev.filter((id) => !remove.has(id)));
}
