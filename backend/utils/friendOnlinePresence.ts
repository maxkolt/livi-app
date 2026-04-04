import type { Server } from 'socket.io';

/**
 * Два состояния для друзей: онлайн = пользователь в приложении, офлайн = вне приложения.
 * - Онлайн: есть сокет и (любой сокет не в фоне / legacy без app:visibility / или активный звонок),
 *   либо все сокеты в фоне, но не дольше IN_APP_OFFLINE_DEBOUNCE_MS (гистерезис, без мерцания).
 * - Офлайн: нет сокетов (см. disconnect grace в index) или устойчивый фон дольше гистерезиса без звонка.
 */
export const IN_APP_OFFLINE_DEBOUNCE_MS = 12_000;

const userAllBackgroundSince = new Map<string, number>();

function normalizeUid(userId: string): string {
  return String(userId || '').trim();
}

function hasAnySocketForUser(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any)?.data?.userId || '') === id) return true;
  }
  return false;
}

/** true = в приложении на переднем плане или клиент ещё не шлёт app:visibility (undefined). */
function anySocketForegroundOrLegacy(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any)?.data?.userId || '') !== id) continue;
    if ((s as any).data?.appForeground !== false) return true;
  }
  return false;
}

function socketLooksInActiveCall(s: { data?: Record<string, unknown> }): boolean {
  const d = (s as any)?.data || {};
  return !!(d.busy || d.inCall || d.roomId);
}

function userHasBusyCallSocket(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any)?.data?.userId || '') !== id) continue;
    if (socketLooksInActiveCall(s)) return true;
  }
  return false;
}

/**
 * Обновляет момент «все сокеты ушли в фон» для каждого подключённого пользователя.
 * Вызывается перед расчётом списка, чтобы не пропускать события и не копить мёртвые ключи.
 */
function syncInAppTrackingForAllConnectedUsers(io: Server): void {
  const active = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const u = normalizeUid(String((s as any)?.data?.userId || ''));
    if (u) active.add(u);
  }
  for (const uid of active) {
    if (anySocketForegroundOrLegacy(io, uid) || userHasBusyCallSocket(io, uid)) {
      userAllBackgroundSince.delete(uid);
    } else {
      if (!userAllBackgroundSince.has(uid)) {
        userAllBackgroundSince.set(uid, Date.now());
      }
    }
  }
  for (const k of [...userAllBackgroundSince.keys()]) {
    if (!active.has(k)) userAllBackgroundSince.delete(k);
  }
}

/** После syncInAppTrackingForAllConnectedUsers: онлайн ли пользователь «в приложении». */
function isUserOnlineInApplicationAfterSync(io: Server, uid: string): boolean {
  const key = normalizeUid(uid);
  if (!key || !hasAnySocketForUser(io, key)) return false;
  if (anySocketForegroundOrLegacy(io, key)) return true;
  if (userHasBusyCallSocket(io, key)) return true;
  const since = userAllBackgroundSince.get(key);
  if (since == null) return true;
  return Date.now() - since < IN_APP_OFFLINE_DEBOUNCE_MS;
}

export function isUserOnlineInApplication(io: Server, uid: string): boolean {
  const key = normalizeUid(uid);
  if (!key) return false;
  syncInAppTrackingForAllConnectedUsers(io);
  return isUserOnlineInApplicationAfterSync(io, key);
}

export function getFriendVisibleOnlineUserIds(io: Server): string[] {
  syncInAppTrackingForAllConnectedUsers(io);
  const uids = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const u = normalizeUid(String((s as any)?.data?.userId || ''));
    if (u) uids.add(u);
  }
  return [...uids].filter((uid) => isUserOnlineInApplicationAfterSync(io, uid));
}

/** @deprecated используйте isUserOnlineInApplication — то же имя для HTTP/сокетов друзей */
export const isFriendGloballyVisibleOnline = isUserOnlineInApplication;

export function emitGlobalFriendPresence(io: Server): void {
  const list = getFriendVisibleOnlineUserIds(io);
  io.emit('presence_update', list);
  io.emit('presence:update', list);
}

let presenceBroadcastDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const PRESENCE_BROADCAST_DEBOUNCE_MS = 120;

export function scheduleGlobalFriendPresenceEmit(io: Server): void {
  if (presenceBroadcastDebounceTimer) clearTimeout(presenceBroadcastDebounceTimer);
  presenceBroadcastDebounceTimer = setTimeout(() => {
    presenceBroadcastDebounceTimer = null;
    emitGlobalFriendPresence(io);
  }, PRESENCE_BROADCAST_DEBOUNCE_MS);
}
