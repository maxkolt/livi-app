import type { ChatMessage } from './chatMessageTypes';
/** Serialized writes for the local message list of one chat. */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearMessageCacheForStorageKey } from "../../sockets/modules/messages";

const writeChains = new Map<string, Promise<unknown>>();

function withChatMessageWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(work, work);
  const settled = next.catch(() => undefined);
  writeChains.set(key, settled);
  void settled.then(() => {
    if (writeChains.get(key) === settled) writeChains.delete(key);
  });
  return next;
}

export function writeStoredChatMessages(key: string, messages: ChatMessage[]): Promise<void> {
  return withChatMessageWriteLock(key, async () => {
    await AsyncStorage.setItem(key, JSON.stringify(messages));
    clearMessageCacheForStorageKey(key);
  });
}

/**
 * Фоновая подготовка медиа может закончиться уже после закрытия ChatScreen. В этом
 * случае меняем только её пузырь, не записывая поверх нового экрана старый снимок ленты.
 */
export function patchStoredChatMessage(
  key: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): Promise<void> {
  return withChatMessageWriteLock(key, async () => {
    const raw = await AsyncStorage.getItem(key);
    const messages = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(messages)) return;
    let changed = false;
    const next = messages.map((message: ChatMessage) => {
      if (String(message?.id || "") !== messageId) return message;
      changed = true;
      return { ...message, ...patch };
    });
    if (changed) {
      await AsyncStorage.setItem(key, JSON.stringify(next));
      clearMessageCacheForStorageKey(key);
    }
  });
}
