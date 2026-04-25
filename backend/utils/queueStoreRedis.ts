/**
 * Redis-backed распределённое хранилище очереди/состояний.
 * Включается при заданном REDIS_URL. Ключи: префикс livi:
 */

import Redis from 'ioredis';
import { logger } from './logger';

const PREFIX = 'livi:';
const LOCK_TTL_SEC = 30;

function now() {
  return Date.now();
}

function banKey(a: string, b: string) {
  const [x, y] = [a, b].sort();
  return `${x}|${y}`;
}

function directCallKey(callId: string) {
  return PREFIX + 'directCall:' + String(callId).trim();
}

function userDirectCallKey(userId: string) {
  return PREFIX + 'userDirectCall:' + String(userId).trim();
}

function activeCallTtlMs(expiresAtMs: number) {
  const ttlFromExpiry = Math.max(1_000, Number(expiresAtMs || 0) - now() + 10 * 60_000);
  return ttlFromExpiry;
}

export type CleanupStatesResult = { cleanedBans: number; cleanedLocks: number; cleanedPairs: number };

export function createRedisStore(redisUrl: string) {
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
  });
  redis.on('error', (err) => logger.warn('[queueStore:redis]', { message: err?.message ?? String(err) }));
  redis.on('connect', () => logger.info('[queueStore:redis] connected'));

  return {
    async addToQueue(sid: string): Promise<void> {
      const id = String(sid);
      const inSet = await redis.sadd(PREFIX + 'inQueue', id);
      if (inSet === 0) return;
      await redis.rpush(PREFIX + 'queue', id);
      await redis.hset(PREFIX + 'queueAddedAt', id, String(now()));
    },

    async removeFromQueue(sid: string): Promise<void> {
      const id = String(sid);
      await redis.srem(PREFIX + 'inQueue', id);
      await redis.lrem(PREFIX + 'queue', 0, id);
      await redis.hdel(PREFIX + 'queueAddedAt', id);
    },

    async isInQueue(sid: string): Promise<boolean> {
      return (await redis.sismember(PREFIX + 'inQueue', String(sid))) === 1;
    },

    async getWaitingQueue(): Promise<string[]> {
      return redis.lrange(PREFIX + 'queue', 0, -1);
    },

    async getQueueSize(): Promise<number> {
      return redis.llen(PREFIX + 'queue');
    },

    async setPair(aSid: string, bSid: string): Promise<void> {
      const a = String(aSid);
      const b = String(bSid);
      await redis.hset(PREFIX + 'pair', a, b, b, a);
    },

    async getPartner(sid: string): Promise<string | undefined> {
      const v = await redis.hget(PREFIX + 'pair', String(sid));
      return v ?? undefined;
    },

    async removePair(sid: string): Promise<string | undefined> {
      const a = String(sid);
      const b = await redis.hget(PREFIX + 'pair', a);
      if (b) {
        await redis.hdel(PREFIX + 'pair', a, b);
        return b;
      }
      return undefined;
    },

    async lockSocket(sid: string): Promise<void> {
      await redis.set(PREFIX + 'lock:' + String(sid), '1', 'EX', LOCK_TTL_SEC);
    },

    async unlockSocket(sid: string): Promise<void> {
      await redis.del(PREFIX + 'lock:' + String(sid));
    },

    async isLocked(sid: string): Promise<boolean> {
      const ttl = await redis.ttl(PREFIX + 'lock:' + String(sid));
      return ttl > 0;
    },

    async banPair(aSid: string, bSid: string, ms: number): Promise<void> {
      const k = banKey(aSid, bSid);
      const px = Math.max(0, Number(ms) || 0);
      if (px > 0) await redis.set(PREFIX + 'ban:' + k, '1', 'PX', px);
    },

    async isBannedTogether(aSid: string, bSid: string): Promise<boolean> {
      const k = PREFIX + 'ban:' + banKey(aSid, bSid);
      const v = await redis.get(k);
      return v !== null;
    },

    async banModerationUser(userId: string, ms: number): Promise<void> {
      const id = String(userId).trim();
      if (!id) return;
      const px = Math.max(0, Number(ms) || 0);
      if (px > 0) await redis.set(PREFIX + 'modban:' + id, '1', 'PX', px);
    },

    async isModerationBanned(userId: string): Promise<boolean> {
      const id = String(userId).trim();
      if (!id) return false;
      const v = await redis.get(PREFIX + 'modban:' + id);
      return v !== null;
    },

    async getModerationBanExpiresAt(userId: string): Promise<number | null> {
      const id = String(userId).trim();
      if (!id) return null;
      const key = PREFIX + 'modban:' + id;
      const pttl = await redis.pttl(key);
      if (pttl < 0) return null;
      return now() + pttl;
    },

    async getLastMatchAttempt(sid: string): Promise<number | undefined> {
      const v = await redis.hget(PREFIX + 'lastMatchAttempt', String(sid));
      return v !== null ? Number(v) : undefined;
    },

    async setLastMatchAttempt(sid: string, ts: number): Promise<void> {
      await redis.hset(PREFIX + 'lastMatchAttempt', String(sid), String(Number(ts) || now()));
    },

    async getLastStart(sid: string): Promise<number | undefined> {
      const v = await redis.hget(PREFIX + 'lastStart', String(sid));
      return v !== null ? Number(v) : undefined;
    },

    async setLastStart(sid: string, ts: number): Promise<void> {
      await redis.hset(PREFIX + 'lastStart', String(sid), String(Number(ts) || now()));
    },

    async getLastSearch(sid: string): Promise<number | undefined> {
      const v = await redis.hget(PREFIX + 'lastSearch', String(sid));
      return v !== null ? Number(v) : undefined;
    },

    async setLastSearch(sid: string, ts: number): Promise<void> {
      await redis.hset(PREFIX + 'lastSearch', String(sid), String(Number(ts) || now()));
    },

    async clearSocketData(sid: string): Promise<void> {
      const id = String(sid);
      await this.removeFromQueue(id);
      await this.unlockSocket(id);
      await this.removePair(id);
      await redis.hdel(PREFIX + 'lastMatchAttempt', id);
      await redis.hdel(PREFIX + 'lastStart', id);
      await redis.hdel(PREFIX + 'lastSearch', id);
    },

    async cleanupStaleQueueEntries(
      timeoutMs: number,
      isSocketConnected: (sid: string) => boolean
    ): Promise<string[]> {
      const stale: string[] = [];
      const t = Math.max(0, Number(timeoutMs) || 0);
      const n = now();
      const queue = await redis.lrange(PREFIX + 'queue', 0, -1);
      for (const sid of queue) {
        const added = Number(await redis.hget(PREFIX + 'queueAddedAt', sid) || n);
        const tooOld = n - added > t;
        const disconnected = !isSocketConnected(sid);
        if (tooOld || disconnected) {
          stale.push(sid);
          await this.removeFromQueue(sid);
        }
      }
      return stale;
    },

    async cleanupStaleStates(isSocketConnected: (sid: string) => boolean): Promise<CleanupStatesResult> {
      let cleanedBans = 0;
      let cleanedLocks = 0;
      let cleanedPairs = 0;

      const banKeys = await redis.keys(PREFIX + 'ban:*');
      for (const key of banKeys) {
        const ttl = await redis.pttl(key);
        if (ttl === -2) continue;
        if (ttl === -1 || ttl < 100) {
          await redis.del(key);
          cleanedBans++;
        }
      }

      const lockKeys = await redis.keys(PREFIX + 'lock:*');
      for (const key of lockKeys) {
        const socketId = key.slice((PREFIX + 'lock:').length);
        const ttl = await redis.ttl(key);
        if (ttl <= 0 || !isSocketConnected(socketId)) {
          await redis.del(key);
          cleanedLocks++;
        }
      }

      const pairEntries = await redis.hgetall(PREFIX + 'pair');
      if (pairEntries) {
        for (const [a, b] of Object.entries(pairEntries)) {
          if (!isSocketConnected(a) || !isSocketConnected(b)) {
            await redis.hdel(PREFIX + 'pair', a, b);
            cleanedPairs++;
          }
        }
      }

      return { cleanedBans, cleanedLocks, cleanedPairs };
    },

    async setBusy(_userId: string, _busy: boolean): Promise<void> {},

    async setDirectCall(
      callId: string,
      state: { a: string; b: string; createdAtMs: number; expiresAtMs: number }
    ): Promise<void> {
      const key = directCallKey(callId);
      if (!String(callId || '').trim()) return;
      await redis.set(
        key,
        JSON.stringify({
          a: String(state.a),
          b: String(state.b),
          createdAtMs: Number(state.createdAtMs) || now(),
          expiresAtMs: Number(state.expiresAtMs) || now(),
        }),
        'PX',
        activeCallTtlMs(Number(state.expiresAtMs) || now())
      );
    },

    async getDirectCall(callId: string): Promise<{ a: string; b: string; createdAtMs: number; expiresAtMs: number } | null> {
      const id = String(callId || '').trim();
      if (!id) return null;
      const raw = await redis.get(directCallKey(id));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const expiresAtMs = Number(parsed?.expiresAtMs) || 0;
        if (expiresAtMs > 0 && expiresAtMs <= now()) {
          await redis.del(directCallKey(id));
          return null;
        }
        return {
          a: String(parsed?.a || ''),
          b: String(parsed?.b || ''),
          createdAtMs: Number(parsed?.createdAtMs) || 0,
          expiresAtMs,
        };
      } catch {
        await redis.del(directCallKey(id));
        return null;
      }
    },

    async removeDirectCall(callId: string): Promise<void> {
      const id = String(callId || '').trim();
      if (!id) return;
      await redis.del(directCallKey(id));
    },

    async setUserDirectCall(
      userId: string,
      state: { with: string; callId: string; expiresAtMs: number }
    ): Promise<void> {
      const id = String(userId || '').trim();
      if (!id) return;
      await redis.set(
        userDirectCallKey(id),
        JSON.stringify({
          with: String(state.with),
          callId: String(state.callId),
          expiresAtMs: Number(state.expiresAtMs) || now(),
        }),
        'PX',
        activeCallTtlMs(Number(state.expiresAtMs) || now())
      );
    },

    async getUserDirectCall(userId: string): Promise<{ with: string; callId: string; expiresAtMs: number } | null> {
      const id = String(userId || '').trim();
      if (!id) return null;
      const raw = await redis.get(userDirectCallKey(id));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const expiresAtMs = Number(parsed?.expiresAtMs) || 0;
        if (expiresAtMs > 0 && expiresAtMs <= now()) {
          await redis.del(userDirectCallKey(id));
          return null;
        }
        return {
          with: String(parsed?.with || ''),
          callId: String(parsed?.callId || ''),
          expiresAtMs,
        };
      } catch {
        await redis.del(userDirectCallKey(id));
        return null;
      }
    },

    async clearUserDirectCall(userId: string, expectedCallId?: string): Promise<void> {
      const id = String(userId || '').trim();
      if (!id) return;
      if (!expectedCallId) {
        await redis.del(userDirectCallKey(id));
        return;
      }
      const current = await this.getUserDirectCall(id);
      if (!current || String(current.callId) !== String(expectedCallId)) return;
      await redis.del(userDirectCallKey(id));
    },

    async close(): Promise<void> {
      await redis.quit();
      logger.info('[queueStore:redis] connection closed');
    },
  };
}
