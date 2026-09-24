/**
 * Redis-реализация unreadStore — состояние общее для всех инстансов backend.
 *
 * Зачем: непрочитанные и отметка «смотрит чат» раньше лежали в Map внутри процесса.
 * При нескольких инстансах (а socket.io-адаптер у нас как раз на Redis) сообщение
 * могло прийти на один инстанс, а счётчик спрашивали у другого — бейджи врали.
 * Рестарт процесса обнулял их полностью.
 *
 * Модель данных:
 *   livi:unread:<userId>   HASH  messageId -> JSON {from, timestamp}
 *   livi:viewing:<userId>  STRING peerId, с TTL — истечение отдаём самому Redis
 */

import Redis from 'ioredis';
import { logger } from './logger';
import { VIEWING_CHAT_TTL_MS, type UnreadEntry } from './unreadStoreMemory';

const PREFIX = 'livi:';
/** Брошенные ключи не должны жить вечно, если пользователь больше не заходит. */
const UNREAD_TTL_SECONDS = 60 * 60 * 24 * 30;

const unreadKey = (userId: string) => `${PREFIX}unread:${userId}`;
const viewingKey = (userId: string) => `${PREFIX}viewing:${userId}`;

function parseEntry(id: string, raw: string): UnreadEntry | null {
  try {
    const v = JSON.parse(raw);
    return { id, from: String(v?.from || ''), timestamp: String(v?.timestamp || '') };
  } catch {
    return null;
  }
}

export function createRedisUnreadStore(url: string) {
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });
  client.on('error', (err) =>
    logger.warn('[unreadStore:redis] error', { message: (err as any)?.message ?? String(err) }),
  );

  async function entries(userId: string): Promise<UnreadEntry[]> {
    const all = await client.hgetall(unreadKey(userId));
    const out: UnreadEntry[] = [];
    for (const [id, raw] of Object.entries(all || {})) {
      const parsed = parseEntry(id, String(raw));
      if (parsed) out.push(parsed);
    }
    return out;
  }

  return {
    /** HSETNX даёт дедуп по messageId на уровне Redis — ретрай не накрутит счётчик. */
    async addUnread(userId: string, messageId: string, fromUser: string): Promise<void> {
      const id = String(messageId || '').trim();
      if (!id || !userId) return;
      const key = unreadKey(userId);
      await client.hsetnx(key, id, JSON.stringify({ from: fromUser, timestamp: new Date().toISOString() }));
      await client.expire(key, UNREAD_TTL_SECONDS);
    },

    async markAllReadFrom(userId: string, fromUser: string): Promise<void> {
      const ids = (await entries(userId)).filter((m) => m.from === fromUser).map((m) => m.id);
      if (ids.length) await client.hdel(unreadKey(userId), ...ids);
    },

    async countFrom(userId: string, fromUser: string): Promise<number> {
      return (await entries(userId)).filter((m) => m.from === fromUser).length;
    },

    async countTotal(userId: string): Promise<number> {
      return await client.hlen(unreadKey(userId));
    },

    async countsBySender(userId: string): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const m of await entries(userId)) {
        const from = String(m.from || '').trim();
        if (!from) continue;
        out[from] = (out[from] || 0) + 1;
      }
      return out;
    },

    async removeOne(userId: string, fromUser: string, messageId: string): Promise<void> {
      const id = String(messageId || '').trim();
      if (!id) return;
      const raw = await client.hget(unreadKey(userId), id);
      if (!raw) return;
      const parsed = parseEntry(id, raw);
      if (parsed && parsed.from !== fromUser) return;
      await client.hdel(unreadKey(userId), id);
    },

    async removeMany(userId: string, fromUser: string, messageIds: readonly string[]): Promise<void> {
      const wanted = new Set(messageIds.map((x) => String(x || '').trim()).filter(Boolean));
      if (wanted.size === 0) return;
      const ids = (await entries(userId))
        .filter((m) => m.from === fromUser && wanted.has(m.id))
        .map((m) => m.id);
      if (ids.length) await client.hdel(unreadKey(userId), ...ids);
    },

    async clearBetween(userA: string, userB: string): Promise<void> {
      await this.markAllReadFrom(userA, userB);
      await this.markAllReadFrom(userB, userA);
    },

    /** TTL отдаём Redis: отдельная проверка возраста на чтении больше не нужна. */
    async setViewing(userId: string, withPeerId: string | null): Promise<void> {
      if (!userId) return;
      if (withPeerId) await client.set(viewingKey(userId), withPeerId, 'PX', VIEWING_CHAT_TTL_MS);
      else await client.del(viewingKey(userId));
    },

    async isViewingWith(recipientUserId: string, senderUserId: string): Promise<boolean> {
      const current = await client.get(viewingKey(recipientUserId));
      return !!current && current === senderUserId;
    },

    async close(): Promise<void> {
      try { await client.quit(); } catch {}
    },
  };
}
