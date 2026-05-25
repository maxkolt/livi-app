import type { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getFriendIdsForUsers } from './friendshipUtils';

/**
 * Два состояния для друзей: онлайн = пользователь в приложении, офлайн = вне приложения.
 * - Онлайн: есть сокет и (любой сокет не в фоне / legacy без app:visibility / или активный звонок),
 *   либо все сокеты в фоне, но не дольше IN_APP_OFFLINE_DEBOUNCE_MS (гистерезис, без мерцания).
 * - Офлайн: нет сокетов (см. disconnect grace в index) или устойчивый фон дольше гистерезиса без звонка.
 */
export const IN_APP_OFFLINE_DEBOUNCE_MS = 2_000;

const userAllBackgroundSince = new Map<string, number>();

/** Когда все сокеты в фоне, список друзьям должен обновиться ровно по истечении гистерезиса — иначе один emit сразу после app:visibility остаётся «ещё онлайн», а следующего события может не быть долго. */
const inAppOfflinePresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Не сбрасываем «отсчёт фона» на каждый краткий foreground — только после устойчивого true. */
const FOREGROUND_ACK_CLEAR_BACKGROUND_MS = 480;
const foregroundAckTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelForegroundAckForUser(userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  const t = foregroundAckTimers.get(key);
  if (t) clearTimeout(t);
  foregroundAckTimers.delete(key);
}

function normalizeUid(userId: string): string {
  return String(userId || '').trim();
}

function isOid(userId: string): boolean {
  return /^[a-f\d]{24}$/i.test(normalizeUid(userId));
}

function getConnectedUserIds(io: Server): string[] {
  const uids = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const u = normalizeUid(String((s as any)?.data?.userId || ''));
    if (u) uids.add(u);
  }
  return [...uids];
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

type FgTri = 'legacy' | 'true' | 'false';

function socketForegroundTriState(s: { data?: Record<string, unknown> }): FgTri {
  const v = (s as any).data?.appForeground;
  if (v === false) return 'false';
  if (v === true) return 'true';
  return 'legacy';
}

/**
 * Обновляет момент «все сокеты ушли в фон».
 * Не удаляем отсчёт при каждом кратком appForeground:true — это делает scheduleDebouncedClearBackgroundOnForeground.
 */
export function syncInAppTrackingForAllConnectedUsers(io: Server): void {
  const active = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const u = normalizeUid(String((s as any)?.data?.userId || ''));
    if (u) active.add(u);
  }
  for (const uid of active) {
    if (userHasBusyCallSocket(io, uid)) {
      userAllBackgroundSince.delete(uid);
      cancelForegroundAckForUser(uid);
      continue;
    }

    let hasLegacy = false;
    let allExplicitFalse = true;
    let sawSocket = false;
    for (const s of io.sockets.sockets.values()) {
      if (String((s as any)?.data?.userId || '') !== uid) continue;
      sawSocket = true;
      const tri = socketForegroundTriState(s);
      if (tri === 'legacy') {
        hasLegacy = true;
        allExplicitFalse = false;
      } else if (tri === 'true') {
        allExplicitFalse = false;
      }
    }
    if (!sawSocket) continue;

    if (hasLegacy) {
      userAllBackgroundSince.delete(uid);
      cancelForegroundAckForUser(uid);
      continue;
    }
    if (allExplicitFalse) {
      cancelForegroundAckForUser(uid);
      if (!userAllBackgroundSince.has(uid)) {
        userAllBackgroundSince.set(uid, Date.now());
      }
      continue;
    }
    // Есть хотя бы один явный foreground:true — онлайн; таймер фона не трогаем здесь
  }

  for (const k of [...userAllBackgroundSince.keys()]) {
    if (!active.has(k)) userAllBackgroundSince.delete(k);
  }
  for (const k of [...foregroundAckTimers.keys()]) {
    if (!active.has(k)) {
      const t = foregroundAckTimers.get(k);
      if (t) clearTimeout(t);
      foregroundAckTimers.delete(k);
    }
  }
  for (const k of [...inAppOfflinePresenceTimers.keys()]) {
    if (!active.has(k)) {
      const t = inAppOfflinePresenceTimers.get(k);
      if (t) clearTimeout(t);
      inAppOfflinePresenceTimers.delete(k);
    }
  }
}

export function cancelInAppOfflinePresenceEmit(userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  const t = inAppOfflinePresenceTimers.get(key);
  if (t) clearTimeout(t);
  inAppOfflinePresenceTimers.delete(key);
}

/** После ухода в фон: один раз переслать глобальный список, когда гистерезис «в приложении» истечёт. */
export function armInAppOfflinePresenceEmit(io: Server, userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  cancelInAppOfflinePresenceEmit(key);
  syncInAppTrackingForAllConnectedUsers(io);
  const since = userAllBackgroundSince.get(key);
  if (since == null) return;
  const elapsed = Date.now() - since;
  const wait = Math.max(0, IN_APP_OFFLINE_DEBOUNCE_MS - elapsed + 15);
  const t = setTimeout(() => {
    inAppOfflinePresenceTimers.delete(key);
    scheduleGlobalFriendPresenceEmit(io, key);
  }, wait);
  inAppOfflinePresenceTimers.set(key, t);
}

/**
 * После call:end звонок больше не удерживает «в приложении».
 * Если у пользователя на всех сокетах явно фон (appForeground === false), сразу считаем
 * гистерезис исчерпанным — иначе он остаётся в списке онлайн ещё до IN_APP_OFFLINE_DEBOUNCE_MS.
 * Сокеты с appForeground === undefined не трогаем (клиент не шлёт видимость — считаем в приложении).
 */
export function applyFastOfflineAfterCallIfAllSocketsBackground(io: Server, userId: string): void {
  const key = normalizeUid(userId);
  if (!key || !hasAnySocketForUser(io, key)) return;
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any)?.data?.userId || '') !== key) continue;
    if ((s as any).data?.appForeground !== false) return;
  }
  cancelInAppOfflinePresenceEmit(key);
  userAllBackgroundSince.set(key, Date.now() - IN_APP_OFFLINE_DEBOUNCE_MS - 1);
  scheduleGlobalFriendPresenceEmit(io, key);
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

function emitPresenceSnapshotToUser(io: Server, userId: string, onlineFriendIds: string[]): void {
  io.to(`u:${userId}`).emit('presence_update', onlineFriendIds);
  io.to(`u:${userId}`).emit('presence:update', onlineFriendIds);
}

async function loadFriendIdsForUsers(userIds: string[]): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(userIds.map(normalizeUid).filter(isOid))];
  if (uniqueIds.length === 0 || mongoose.connection.readyState !== 1) return new Map<string, string[]>();
  return getFriendIdsForUsers(uniqueIds);
}

export async function emitFriendPresenceForUsers(io: Server, changedUserIds: string | string[]): Promise<void> {
  const changed = [...new Set((Array.isArray(changedUserIds) ? changedUserIds : [changedUserIds])
    .map(normalizeUid)
    .filter(isOid))];
  if (changed.length === 0) return;

  try {
    syncInAppTrackingForAllConnectedUsers(io);
    const online = new Set(getFriendVisibleOnlineUserIds(io));
    const changedFriends = await loadFriendIdsForUsers(changed);
    const recipientIds = new Set<string>(changed);

    for (const userId of changed) {
      const friends = changedFriends.get(userId) || [];
      for (const friendId of friends) recipientIds.add(friendId);
    }

    const recipientFriends = await loadFriendIdsForUsers([...recipientIds]);
    for (const recipientId of recipientIds) {
      const friends = recipientFriends.get(recipientId) || [];
      const onlineFriends = friends.filter((friendId) => online.has(friendId));
      emitPresenceSnapshotToUser(io, recipientId, onlineFriends);
    }
  } catch {
    // Presence is best-effort: skip noisy failures and let the next scheduled update heal state.
  }
}

export async function emitGlobalFriendPresence(io: Server): Promise<void> {
  try {
    const recipientIds = getConnectedUserIds(io);
    if (recipientIds.length === 0) return;

    const online = new Set(getFriendVisibleOnlineUserIds(io));
    const recipientFriends = await loadFriendIdsForUsers(recipientIds);

    for (const recipientId of recipientIds) {
      const friends = recipientFriends.get(recipientId) || [];
      const onlineFriends = friends.filter((friendId) => online.has(friendId));
      emitPresenceSnapshotToUser(io, recipientId, onlineFriends);
    }
  } catch {
    // Presence snapshots are opportunistic; avoid breaking socket flows on DB/emit errors.
  }
}

let presenceBroadcastDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPresenceChangedUserIds = new Set<string>();
const PRESENCE_BROADCAST_DEBOUNCE_MS = 80;

export function scheduleGlobalFriendPresenceEmit(io: Server, changedUserIds?: string | string[]): void {
  if (changedUserIds) {
    const ids = Array.isArray(changedUserIds) ? changedUserIds : [changedUserIds];
    for (const id of ids) {
      const normalized = normalizeUid(id);
      if (isOid(normalized)) pendingPresenceChangedUserIds.add(normalized);
    }
  }
  if (presenceBroadcastDebounceTimer) clearTimeout(presenceBroadcastDebounceTimer);
  presenceBroadcastDebounceTimer = setTimeout(() => {
    presenceBroadcastDebounceTimer = null;
    const changed = [...pendingPresenceChangedUserIds];
    pendingPresenceChangedUserIds.clear();
    if (changed.length > 0) {
      void emitFriendPresenceForUsers(io, changed);
    } else {
      void emitGlobalFriendPresence(io);
    }
  }, PRESENCE_BROADCAST_DEBOUNCE_MS);
}

/** app:visibility foreground:true — сброс отсчёта «фон» только если true удержался ~FOREGROUND_ACK_CLEAR_BACKGROUND_MS. */
export function scheduleDebouncedClearBackgroundOnForeground(io: Server, userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  cancelInAppOfflinePresenceEmit(key);
  cancelForegroundAckForUser(key);
  const t = setTimeout(() => {
    foregroundAckTimers.delete(key);
    userAllBackgroundSince.delete(key);
    scheduleGlobalFriendPresenceEmit(io, key);
  }, FOREGROUND_ACK_CLEAR_BACKGROUND_MS);
  foregroundAckTimers.set(key, t);
}

export function cancelDebouncedForegroundAck(userId: string): void {
  cancelForegroundAckForUser(userId);
}
