/**
 * In-memory реализация queueStore (один процесс backend).
 * Используется когда REDIS_URL не задан.
 */

export type CleanupStatesResult = { cleanedBans: number; cleanedLocks: number; cleanedPairs: number };

const waitingQueue: string[] = [];
const inQueue = new Set<string>();
const queueAddedAt = new Map<string, number>();
const pair = new Map<string, string>();
const locks = new Map<string, number>();
const bans = new Map<string, number>();
/** Модерация: бан userId в рандомном чате (1 час) */
const moderationBans = new Map<string, number>();
const lastMatchAttempt = new Map<string, number>();
const lastStart = new Map<string, number>();
const lastSearch = new Map<string, number>();

const LOCK_TTL_MS = 30_000;

function now() {
  return Date.now();
}

function banKey(a: string, b: string) {
  const [x, y] = [a, b].sort();
  return `${x}|${y}`;
}

export function createMemoryStore() {
  return {
    async addToQueue(sid: string): Promise<void> {
      const id = String(sid);
      if (inQueue.has(id)) return;
      inQueue.add(id);
      waitingQueue.push(id);
      queueAddedAt.set(id, now());
    },

    async removeFromQueue(sid: string): Promise<void> {
      const id = String(sid);
      if (!inQueue.has(id)) return;
      inQueue.delete(id);
      queueAddedAt.delete(id);
      const idx = waitingQueue.indexOf(id);
      if (idx >= 0) waitingQueue.splice(idx, 1);
    },

    async isInQueue(sid: string): Promise<boolean> {
      return inQueue.has(String(sid));
    },

    async getWaitingQueue(): Promise<string[]> {
      return waitingQueue.slice();
    },

    async getQueueSize(): Promise<number> {
      return waitingQueue.length;
    },

    async setPair(aSid: string, bSid: string): Promise<void> {
      const a = String(aSid);
      const b = String(bSid);
      pair.set(a, b);
      pair.set(b, a);
    },

    async getPartner(sid: string): Promise<string | undefined> {
      return pair.get(String(sid));
    },

    async removePair(sid: string): Promise<string | undefined> {
      const a = String(sid);
      const b = pair.get(a);
      pair.delete(a);
      if (b) pair.delete(b);
      return b;
    },

    async lockSocket(sid: string): Promise<void> {
      locks.set(String(sid), now() + LOCK_TTL_MS);
    },

    async unlockSocket(sid: string): Promise<void> {
      locks.delete(String(sid));
    },

    async isLocked(sid: string): Promise<boolean> {
      const exp = locks.get(String(sid));
      if (!exp) return false;
      if (exp <= now()) {
        locks.delete(String(sid));
        return false;
      }
      return true;
    },

    async banPair(aSid: string, bSid: string, ms: number): Promise<void> {
      bans.set(banKey(String(aSid), String(bSid)), now() + Math.max(0, Number(ms) || 0));
    },

    async isBannedTogether(aSid: string, bSid: string): Promise<boolean> {
      const k = banKey(String(aSid), String(bSid));
      const exp = bans.get(k);
      if (!exp) return false;
      if (exp <= now()) {
        bans.delete(k);
        return false;
      }
      return true;
    },

    async banModerationUser(userId: string, ms: number): Promise<void> {
      const id = String(userId).trim();
      if (!id) return;
      moderationBans.set(id, now() + Math.max(0, Number(ms) || 0));
    },

    async isModerationBanned(userId: string): Promise<boolean> {
      const id = String(userId).trim();
      if (!id) return false;
      const exp = moderationBans.get(id);
      if (!exp) return false;
      if (exp <= now()) {
        moderationBans.delete(id);
        return false;
      }
      return true;
    },

    /** Unix ms, когда истекает бан модерации; null если не забанен */
    async getModerationBanExpiresAt(userId: string): Promise<number | null> {
      const id = String(userId).trim();
      if (!id) return null;
      const exp = moderationBans.get(id);
      if (!exp) return null;
      if (exp <= now()) {
        moderationBans.delete(id);
        return null;
      }
      return exp;
    },

    async getLastMatchAttempt(sid: string): Promise<number | undefined> {
      return lastMatchAttempt.get(String(sid));
    },

    async setLastMatchAttempt(sid: string, ts: number): Promise<void> {
      lastMatchAttempt.set(String(sid), Number(ts) || now());
    },

    async getLastStart(sid: string): Promise<number | undefined> {
      return lastStart.get(String(sid));
    },

    async setLastStart(sid: string, ts: number): Promise<void> {
      lastStart.set(String(sid), Number(ts) || now());
    },

    async getLastSearch(sid: string): Promise<number | undefined> {
      return lastSearch.get(String(sid));
    },

    async setLastSearch(sid: string, ts: number): Promise<void> {
      lastSearch.set(String(sid), Number(ts) || now());
    },

    async clearSocketData(sid: string): Promise<void> {
      const id = String(sid);
      await this.removeFromQueue(id);
      await this.unlockSocket(id);
      await this.removePair(id);
      lastMatchAttempt.delete(id);
      lastStart.delete(id);
      lastSearch.delete(id);
    },

    async cleanupStaleQueueEntries(
      timeoutMs: number,
      isSocketConnected: (sid: string) => boolean
    ): Promise<string[]> {
      const stale: string[] = [];
      const t = Math.max(0, Number(timeoutMs) || 0);
      const n = now();
      for (const sid of waitingQueue.slice()) {
        const added = queueAddedAt.get(sid) || n;
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
      const n = now();
      let cleanedBans = 0;
      let cleanedLocks = 0;
      let cleanedPairs = 0;
      for (const [k, exp] of bans.entries()) {
        if (exp <= n) {
          bans.delete(k);
          cleanedBans++;
        }
      }
      for (const [uid, exp] of moderationBans.entries()) {
        if (exp <= n) {
          moderationBans.delete(uid);
        }
      }
      for (const [sid, exp] of locks.entries()) {
        if (exp <= n || !isSocketConnected(sid)) {
          locks.delete(sid);
          cleanedLocks++;
        }
      }
      for (const [a, b] of pair.entries()) {
        if (!isSocketConnected(a) || !isSocketConnected(b)) {
          pair.delete(a);
          pair.delete(b);
          cleanedPairs++;
        }
      }
      return { cleanedBans, cleanedLocks, cleanedPairs };
    },

    async setBusy(_userId: string, _busy: boolean): Promise<void> {},

    async close(): Promise<void> {},
  };
}
