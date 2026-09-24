/**
 * Непрочитанные сообщения и отметка «смотрит чат».
 *
 * При REDIS_URL состояние общее для всех инстансов backend; без него — in-memory,
 * ровно как было раньше (один процесс). Выбор бэкенда повторяет queueStore.
 */

import { logger } from './logger';
import { createMemoryUnreadStore } from './unreadStoreMemory';
import { createRedisUnreadStore } from './unreadStoreRedis';

const REDIS_URL = (process.env.REDIS_URL || process.env.REDIS_URI || '').trim();

type UnreadStore = ReturnType<typeof createMemoryUnreadStore>;

let store: UnreadStore;

if (REDIS_URL) {
  try {
    store = createRedisUnreadStore(REDIS_URL) as unknown as UnreadStore;
    logger.info('[unreadStore] using Redis');
  } catch (e) {
    logger.warn('[unreadStore] Redis init failed, using in-memory', { error: e });
    store = createMemoryUnreadStore();
  }
} else {
  store = createMemoryUnreadStore();
  logger.info('[unreadStore] using in-memory (no REDIS_URL)');
}

export const addUnread = (userId: string, messageId: string, fromUser: string) =>
  store.addUnread(userId, messageId, fromUser);
export const markAllReadFrom = (userId: string, fromUser: string) => store.markAllReadFrom(userId, fromUser);
export const countUnreadFrom = (userId: string, fromUser: string) => store.countFrom(userId, fromUser);
export const countUnreadTotal = (userId: string) => store.countTotal(userId);
export const countUnreadBySender = (userId: string) => store.countsBySender(userId);
export const removeUnreadOne = (userId: string, fromUser: string, messageId: string) =>
  store.removeOne(userId, fromUser, messageId);
export const removeUnreadMany = (userId: string, fromUser: string, messageIds: readonly string[]) =>
  store.removeMany(userId, fromUser, messageIds);
export const clearUnreadBetween = (userA: string, userB: string) => store.clearBetween(userA, userB);
export const setViewingChatState = (userId: string, withPeerId: string | null) =>
  store.setViewing(userId, withPeerId);
export const isViewingChatWithUser = (recipientUserId: string, senderUserId: string) =>
  store.isViewingWith(recipientUserId, senderUserId);
export const closeUnreadStore = () => store.close();
