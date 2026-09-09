import type { Server } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import { getFriendVisibleOnlineUserIds } from './friendOnlinePresence';

export type WelcomePresenceItem = {
  id: string;
  nick: string;
  avatarVer: number;
};

const META_TTL_MS = 5 * 60_000;
const metaCache = new Map<string, { nick: string; avatarVer: number; at: number }>();

let welcomeBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
const WELCOME_BROADCAST_DEBOUNCE_MS = 120;

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Снимок онлайн для welcome-баннера (тот же критерий, что GET /api/presence). */
export async function buildWelcomeOnlinePresenceList(io: Server): Promise<WelcomePresenceItem[]> {
  const ids = getFriendVisibleOnlineUserIds(io);
  if (!ids.length) return [];

  if (!isMongoReady()) {
    return ids.map((id) => ({ id, nick: '', avatarVer: 0 }));
  }

  const now = Date.now();
  const missing: string[] = [];
  for (const id of ids) {
    const cached = metaCache.get(id);
    if (!cached || now - cached.at > META_TTL_MS) missing.push(id);
  }

  if (missing.length > 0) {
    try {
      const users = await User.find({ _id: { $in: missing } })
        .select('nick avatarVer')
        .lean();
      for (const u of users as Array<{ _id: unknown; nick?: string; avatarVer?: number }>) {
        const id = String(u._id);
        metaCache.set(id, {
          nick: typeof u.nick === 'string' ? u.nick : '',
          avatarVer: Number(u.avatarVer) || 0,
          at: now,
        });
      }
      for (const id of missing) {
        if (!metaCache.has(id)) {
          metaCache.set(id, { nick: '', avatarVer: 0, at: now });
        }
      }
    } catch {
      // best-effort: отдадим ids без meta
    }
  }

  return ids.map((id) => {
    const meta = metaCache.get(id);
    return {
      id,
      nick: meta?.nick || '',
      avatarVer: meta?.avatarVer || 0,
    };
  });
}

export async function emitWelcomeOnlinePresence(io: Server): Promise<void> {
  try {
    const list = await buildWelcomeOnlinePresenceList(io);
    io.emit('presence:welcome', { ok: true, list });
  } catch {
    // Welcome presence is best-effort.
  }
}

/** Debounce рядом с friend presence — не ддосить Mongo при серии app:visibility. */
export function scheduleWelcomeOnlinePresenceEmit(io: Server): void {
  if (welcomeBroadcastTimer) clearTimeout(welcomeBroadcastTimer);
  welcomeBroadcastTimer = setTimeout(() => {
    welcomeBroadcastTimer = null;
    void emitWelcomeOnlinePresence(io);
  }, WELCOME_BROADCAST_DEBOUNCE_MS);
}
