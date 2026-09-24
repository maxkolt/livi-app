/**
 * In-memory реализация unreadStore (один процесс backend).
 * Используется, когда REDIS_URL не задан — семантика та же, что была до вынесения
 * состояния из sockets/messagesReliable.ts.
 */

export type UnreadEntry = { id: string; from: string; timestamp: string };

/** Столько держим отметку «смотрит чат»: дольше — риск проглотить нужный пуш. */
export const VIEWING_CHAT_TTL_MS = 90_000;

export function createMemoryUnreadStore() {
  const unread = new Map<string, UnreadEntry[]>();
  const viewing = new Map<string, { with: string; at: number }>();

  const listOf = (userId: string) => unread.get(userId) || [];

  return {
    /** Дедуп по messageId: ретрай отправки не должен давать +2 к счётчику. */
    async addUnread(userId: string, messageId: string, fromUser: string): Promise<void> {
      const id = String(messageId || '').trim();
      if (!id || !userId) return;
      const list = unread.get(userId) || [];
      if (list.some((m) => m.id === id)) return;
      list.push({ id, from: fromUser, timestamp: new Date().toISOString() });
      unread.set(userId, list);
    },

    async markAllReadFrom(userId: string, fromUser: string): Promise<void> {
      unread.set(userId, listOf(userId).filter((m) => m.from !== fromUser));
    },

    async countFrom(userId: string, fromUser: string): Promise<number> {
      return listOf(userId).filter((m) => m.from === fromUser).length;
    },

    async countTotal(userId: string): Promise<number> {
      return listOf(userId).length;
    },

    /** Разрез по отправителям — для батч-запроса счётчиков по всем чатам. */
    async countsBySender(userId: string): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const m of listOf(userId)) {
        const from = String(m.from || '').trim();
        if (!from) continue;
        out[from] = (out[from] || 0) + 1;
      }
      return out;
    },

    async removeOne(userId: string, fromUser: string, messageId: string): Promise<void> {
      unread.set(userId, listOf(userId).filter((m) => !(m.from === fromUser && m.id === messageId)));
    },

    async removeMany(userId: string, fromUser: string, messageIds: readonly string[]): Promise<void> {
      const ids = new Set(messageIds.map((x) => String(x || '').trim()).filter(Boolean));
      if (ids.size === 0) return;
      unread.set(userId, listOf(userId).filter((m) => !(m.from === fromUser && ids.has(m.id))));
    },

    async clearBetween(userA: string, userB: string): Promise<void> {
      unread.set(userA, listOf(userA).filter((m) => m.from !== userB));
      unread.set(userB, listOf(userB).filter((m) => m.from !== userA));
    },

    async setViewing(userId: string, withPeerId: string | null): Promise<void> {
      if (!userId) return;
      if (withPeerId) viewing.set(userId, { with: withPeerId, at: Date.now() });
      else viewing.delete(userId);
    },

    async isViewingWith(recipientUserId: string, senderUserId: string): Promise<boolean> {
      const entry = viewing.get(recipientUserId);
      if (!entry) return false;
      if (Date.now() - entry.at > VIEWING_CHAT_TTL_MS) {
        viewing.delete(recipientUserId);
        return false;
      }
      return entry.with === senderUserId;
    },

    async close(): Promise<void> {},
  };
}
