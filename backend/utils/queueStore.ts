/**
 * Распределённое хранилище очереди/состояний.
 * При REDIS_URL (или REDIS_URI) используется Redis (несколько инстансов backend).
 * Без Redis — in-memory (только один процесс).
 */

import { logger } from './logger';
import { createRedisStore } from './queueStoreRedis';
import { createMemoryStore } from './queueStoreMemory';

const REDIS_URL = (process.env.REDIS_URL || process.env.REDIS_URI || '').trim();

let store: ReturnType<typeof createMemoryStore>;
let redisStore: ReturnType<typeof createRedisStore> | null = null;

if (REDIS_URL) {
  try {
    redisStore = createRedisStore(REDIS_URL);
    store = redisStore as unknown as ReturnType<typeof createMemoryStore>;
    logger.info('[queueStore] using Redis');
  } catch (e) {
    logger.warn('[queueStore] Redis init failed, using in-memory', { error: e });
    store = createMemoryStore();
  }
} else {
  store = createMemoryStore();
}

export type CleanupStatesResult = { cleanedBans: number; cleanedLocks: number; cleanedPairs: number };

export const addToQueue = (sid: string) => store.addToQueue(sid);
export const removeFromQueue = (sid: string) => store.removeFromQueue(sid);
export const isInQueue = (sid: string) => store.isInQueue(sid);
export const getWaitingQueue = () => store.getWaitingQueue();
export const getQueueSize = () => store.getQueueSize();
export const setPair = (aSid: string, bSid: string) => store.setPair(aSid, bSid);
export const getPartner = (sid: string) => store.getPartner(sid);
export const removePair = (sid: string) => store.removePair(sid);
export const lockSocket = (sid: string) => store.lockSocket(sid);
export const unlockSocket = (sid: string) => store.unlockSocket(sid);
export const isLocked = (sid: string) => store.isLocked(sid);
export const banPair = (aSid: string, bSid: string, ms: number) => store.banPair(aSid, bSid, ms);
export const isBannedTogether = (aSid: string, bSid: string) => store.isBannedTogether(aSid, bSid);
export const banModerationUser = (userId: string, ms: number) => store.banModerationUser(userId, ms);
export const isModerationBanned = (userId: string) => store.isModerationBanned(userId);
export const getModerationBanExpiresAt = (userId: string) => store.getModerationBanExpiresAt(userId);
export const getLastMatchAttempt = (sid: string) => store.getLastMatchAttempt(sid);
export const setLastMatchAttempt = (sid: string, ts: number) => store.setLastMatchAttempt(sid, ts);
export const getLastStart = (sid: string) => store.getLastStart(sid);
export const setLastStart = (sid: string, ts: number) => store.setLastStart(sid, ts);
export const getLastSearch = (sid: string) => store.getLastSearch(sid);
export const setLastSearch = (sid: string, ts: number) => store.setLastSearch(sid, ts);
export const clearSocketData = (sid: string) => store.clearSocketData(sid);
export const cleanupStaleQueueEntries = (
  timeoutMs: number,
  isSocketConnected: (sid: string) => boolean
) => store.cleanupStaleQueueEntries(timeoutMs, isSocketConnected);
export const cleanupStaleStates = (isSocketConnected: (sid: string) => boolean) =>
  store.cleanupStaleStates(isSocketConnected);
export const setBusy = (userId: string, busy: boolean) => store.setBusy(userId, busy);
export const setDirectCall = (
  callId: string,
  state: { a: string; b: string; createdAtMs: number; expiresAtMs: number }
) => store.setDirectCall(callId, state);
export const getDirectCall = (callId: string) => store.getDirectCall(callId);
export const removeDirectCall = (callId: string) => store.removeDirectCall(callId);
export const setUserDirectCall = (
  userId: string,
  state: { with: string; callId: string; expiresAtMs: number }
) => store.setUserDirectCall(userId, state);
export const getUserDirectCall = (userId: string) => store.getUserDirectCall(userId);
export const clearUserDirectCall = (userId: string, expectedCallId?: string) => store.clearUserDirectCall(userId, expectedCallId);

export async function close(): Promise<void> {
  if (redisStore) {
    await redisStore.close();
    redisStore = null;
  }
}
