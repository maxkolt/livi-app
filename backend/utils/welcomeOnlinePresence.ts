import type { Server } from 'socket.io';
import mongoose from 'mongoose';
import User from '../models/User';
import { randomUUID } from 'node:crypto';
import type { AuthedSocket } from '../sockets/types';
import { getFriendVisibleOnlineUserIds } from './friendOnlinePresence';

export type WelcomePresenceItem = {
  id: string;
  nick: string;
  avatarVer: number;
};

const META_TTL_MS = 5 * 60_000;
const metaCache = new Map<string, { nick: string; avatarVer: number; at: number }>();

const WELCOME_BROADCAST_DEBOUNCE_MS = 120;
export const WELCOME_DELTA_ROOM = 'presence:welcome:delta';
type Snapshot = { ok: true; epoch: string; revision: number; list: WelcomePresenceItem[] };
type PresenceState = {
  snapshot: Snapshot;
  refreshedAt: number;
  requestedVersion: number;
  completedVersion: number;
  inFlight?: Promise<Snapshot>;
  timer?: ReturnType<typeof setTimeout>;
};
const states = new WeakMap<Server, PresenceState>();
function stateFor(io: Server): PresenceState {
  let state = states.get(io);
  if (!state) {
    state = { snapshot: { ok: true, epoch: randomUUID(), revision: 0, list: [] }, refreshedAt: 0,
      requestedVersion: 0, completedVersion: 0 };
    states.set(io, state);
  }
  return state;
}

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** Снимок онлайн для welcome-баннера (тот же критерий, что GET /api/presence). */
export async function buildWelcomeOnlinePresenceList(io: Server): Promise<WelcomePresenceItem[]> {
  const ids = getFriendVisibleOnlineUserIds(io);
  const online = new Set(ids);
  // Offline profiles must not accumulate forever in a long-running process.
  for (const id of metaCache.keys()) if (!online.has(id)) metaCache.delete(id);
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

/** One shared refresh for concurrent HTTP requests/socket subscriptions. */
export function getWelcomeOnlinePresenceSnapshot(io: Server): Promise<Snapshot> {
  const state = stateFor(io);
  if (state.inFlight) return state.inFlight;
  if (state.requestedVersion === state.completedVersion && state.refreshedAt && Date.now() - state.refreshedAt < WELCOME_BROADCAST_DEBOUNCE_MS) {
    return Promise.resolve(state.snapshot);
  }
  const requestedVersion = state.requestedVersion;
  state.inFlight = (async () => {
    const list = await buildWelcomeOnlinePresenceList(io);
    const previous = new Map(state.snapshot.list.map((item) => [item.id, item]));
    const next = new Set(list.map((item) => item.id));
    const upsert = list.filter((item) => {
      const old = previous.get(item.id);
      return !old || old.nick !== item.nick || old.avatarVer !== item.avatarVer;
    });
    const removed = [...previous.keys()].filter((id) => !next.has(id));
    if (upsert.length || removed.length) {
      state.snapshot = { ok: true, epoch: state.snapshot.epoch, revision: state.snapshot.revision + 1, list };
      const { epoch, revision } = state.snapshot;
      io.to(WELCOME_DELTA_ROOM).emit('presence:welcome:delta', { epoch, revision, upsert, removed });
      // Installed older builds keep receiving the exact snapshot contract.
      io.except(WELCOME_DELTA_ROOM).emit('presence:welcome', state.snapshot);
    }
    state.refreshedAt = Date.now();
    state.completedVersion = requestedVersion;
    return state.snapshot;
  })().finally(() => {
    state.inFlight = undefined;
    // A visibility change during the Mongo metadata read needs another pass.
    if (state.requestedVersion !== state.completedVersion) armWelcomeRefresh(io, state);
  });
  return state.inFlight;
}

/** Debounce рядом с friend presence — не ддосить Mongo при серии app:visibility. */
export function scheduleWelcomeOnlinePresenceEmit(io: Server): void {
  const state = stateFor(io);
  state.requestedVersion++;
  armWelcomeRefresh(io, state);
}

function armWelcomeRefresh(io: Server, state: PresenceState): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void getWelcomeOnlinePresenceSnapshot(io).catch(() => undefined);
  }, WELCOME_BROADCAST_DEBOUNCE_MS);
}

/** New builds receive one snapshot, then versioned changes. Sync heals gaps/restarts. */
export function bindWelcomeOnlinePresence(io: Server, socket: AuthedSocket): void {
  const raw = socket.handshake.query.caps;
  const caps = (Array.isArray(raw) ? raw.join(',') : String(raw || '')).split(',').map((v) => v.trim());
  if (!caps.includes('welcome_delta')) return;
  let syncing = false;
  let lastSyncAt = 0;
  const sync = async () => {
    if (syncing || !socket.connected || Date.now() - lastSyncAt < 500) return;
    syncing = true;
    try {
      await socket.join(WELCOME_DELTA_ROOM);
      const snapshot = await getWelcomeOnlinePresenceSnapshot(io);
      if (socket.connected) socket.emit('presence:welcome', snapshot);
      lastSyncAt = Date.now();
    } catch {
      // HTTP fallback or the next sync heals a failed snapshot.
    } finally { syncing = false; }
  };
  socket.on('presence:welcome:sync', () => { void sync(); });
  void sync();
}
