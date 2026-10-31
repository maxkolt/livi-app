import type { Server } from 'socket.io';
import mongoose from 'mongoose';
import { getFriendIdsForUsers } from './friendshipUtils';

/**
 * Два состояния для друзей: онлайн = пользователь в приложении, офлайн = вне приложения.
 * - Онлайн: есть сокет и (любой сокет не в фоне / legacy без app:visibility / или активный звонок),
 *   либо все сокеты в фоне, но не дольше IN_APP_OFFLINE_DEBOUNCE_MS (гистерезис, без мерцания).
 * - Офлайн: нет сокетов (см. disconnect grace в index) или устойчивый фон дольше гистерезиса без звонка.
 */
const IN_APP_OFFLINE_DEBOUNCE_MS = 2_000;
const APP_FOREGROUND_HEARTBEAT_STALE_MS = 90_000;

const userAllBackgroundSince = new Map<string, number>();

/** Когда все сокеты в фоне, список друзьям должен обновиться ровно по истечении гистерезиса — иначе один emit сразу после app:visibility остаётся «ещё онлайн», а следующего события может не быть долго. */
const inAppOfflinePresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Не сбрасываем «отсчёт фона» на каждый краткий foreground — только после устойчивого true. */
const FOREGROUND_ACK_CLEAR_BACKGROUND_MS = 480;
const foregroundAckTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** foreground:true от живого сокета не должен быть вечным, если клиент уснул и перестал подтверждать foreground. */
const foregroundStalePresenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

type PresenceSocket = { data?: Record<string, unknown> };

function socketUserId(s: PresenceSocket): string {
  return normalizeUid(String((s)?.data?.userId || ''));
}

/**
 * Сокеты пользователя на этом узле — через его комнату u:<id> (identity.ts): O(сокетов пользователя).
 * Раньше каждая проверка обходила все сокеты сервера, и пересчёт для всех пользователей стоил
 * O(пользователей × сокетов) на каждое событие видимости.
 */
function socketsOfUser(io: Server, uid: string): PresenceSocket[] {
  const room = (io.sockets).adapter?.rooms?.get(`u:${uid}`) as Set<string> | undefined;
  if (!room || room.size === 0) return [];
  const out: PresenceSocket[] = [];
  for (const sid of room) {
    const s = io.sockets.sockets.get(sid) as PresenceSocket | undefined;
    if (s && socketUserId(s) === uid) out.push(s);
  }
  return out;
}

/** Все подключённые пользователи с их сокетами — один проход по сокетам. */
function socketsByConnectedUser(io: Server): Map<string, PresenceSocket[]> {
  const byUser = new Map<string, PresenceSocket[]>();
  for (const s of io.sockets.sockets.values()) {
    const uid = socketUserId(s as PresenceSocket);
    if (!uid) continue;
    const list = byUser.get(uid);
    if (list) list.push(s as PresenceSocket);
    else byUser.set(uid, [s as PresenceSocket]);
  }
  return byUser;
}

function socketLooksInActiveCall(s: PresenceSocket): boolean {
  const d = (s)?.data || {};
  return !!(d.busy || d.inCall || d.roomId);
}

type LiveCallPredicate = (io: Server, userId: string) => boolean;
let liveCallPredicate: LiveCallPredicate | null = null;

/**
 * index.ts подтверждает звонок по своему реестру (callOfUser / callsById / комнаты): флаги
 * busy/roomId на сокете переживают сбойное завершение, и пользователь в фоне оставался
 * «онлайн» для друзей до переподключения.
 */
export function setLiveCallPredicate(fn: LiveCallPredicate | null): void {
  liveCallPredicate = fn;
}

function userHasBusyCallSocket(io: Server, uid: string, sockets: PresenceSocket[]): boolean {
  if (!sockets.some(socketLooksInActiveCall)) return false;
  return liveCallPredicate ? liveCallPredicate(io, uid) : true;
}

type FgTri = 'legacy' | 'true' | 'false';

function socketForegroundLastSeenAt(s: PresenceSocket): number {
  const raw = (s).data?.appForegroundLastSeenAt;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function isForegroundHeartbeatFresh(s: PresenceSocket): boolean {
  const lastSeenAt = socketForegroundLastSeenAt(s);
  return lastSeenAt > 0 && Date.now() - lastSeenAt <= APP_FOREGROUND_HEARTBEAT_STALE_MS;
}

function socketForegroundTriState(s: PresenceSocket): FgTri {
  const v = (s).data?.appForeground;
  if (v === false) return 'false';
  if (v === true) return isForegroundHeartbeatFresh(s) ? 'true' : 'false';
  return 'legacy';
}

function clearTimerFor(timers: Map<string, ReturnType<typeof setTimeout>>, uid: string): void {
  const t = timers.get(uid);
  if (t) clearTimeout(t);
  timers.delete(uid);
}

/** Пользователь ушёл со всех сокетов: его отсчёты и таймеры больше не нужны. */
function forgetUserTracking(uid: string): void {
  userAllBackgroundSince.delete(uid);
  clearTimerFor(foregroundAckTimers, uid);
  clearTimerFor(inAppOfflinePresenceTimers, uid);
  clearTimerFor(foregroundStalePresenceTimers, uid);
}

/**
 * Обновляет момент «все сокеты пользователя ушли в фон».
 * Не удаляем отсчёт при каждом кратком appForeground:true — это делает scheduleDebouncedClearBackgroundOnForeground.
 */
function syncInAppTrackingForUser(io: Server, uid: string, sockets: PresenceSocket[]): void {
  if (sockets.length === 0) {
    forgetUserTracking(uid);
    return;
  }
  if (userHasBusyCallSocket(io, uid, sockets)) {
    userAllBackgroundSince.delete(uid);
    cancelForegroundAckForUser(uid);
    return;
  }

  let hasLegacy = false;
  let allExplicitFalse = true;
  let allBackgroundSinceCandidate = 0;
  for (const s of sockets) {
    const tri = socketForegroundTriState(s);
    if (tri === 'legacy') {
      hasLegacy = true;
      allExplicitFalse = false;
    } else if (tri === 'true') {
      allExplicitFalse = false;
    } else {
      const staleForegroundAt =
        (s).data?.appForeground === true
          ? socketForegroundLastSeenAt(s) + APP_FOREGROUND_HEARTBEAT_STALE_MS
          : 0;
      allBackgroundSinceCandidate = Math.max(
        allBackgroundSinceCandidate,
        staleForegroundAt > 0 ? Math.min(Date.now(), staleForegroundAt) : Date.now(),
      );
    }
  }

  if (hasLegacy) {
    userAllBackgroundSince.delete(uid);
    cancelForegroundAckForUser(uid);
    return;
  }
  if (allExplicitFalse) {
    cancelForegroundAckForUser(uid);
    if (!userAllBackgroundSince.has(uid)) {
      userAllBackgroundSince.set(uid, allBackgroundSinceCandidate || Date.now());
    }
  }
  // Есть хотя бы один явный foreground:true — онлайн; таймер фона не трогаем здесь
}

export function cancelInAppOfflinePresenceEmit(userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  clearTimerFor(inAppOfflinePresenceTimers, key);
}

function cancelForegroundStalePresenceEmit(userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  clearTimerFor(foregroundStalePresenceTimers, key);
}

/** Если foreground:true перестал подтверждаться, переслать друзьям актуальный список без разрыва сокета. */
function armForegroundStalePresenceEmit(io: Server, userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  cancelForegroundStalePresenceEmit(key);

  let newestSeenAt = 0;
  for (const s of socketsOfUser(io, key)) {
    if ((s).data?.appForeground === true) {
      newestSeenAt = Math.max(newestSeenAt, socketForegroundLastSeenAt(s));
    }
  }
  if (newestSeenAt <= 0) return;

  const elapsed = Date.now() - newestSeenAt;
  const wait = Math.max(0, APP_FOREGROUND_HEARTBEAT_STALE_MS - elapsed + IN_APP_OFFLINE_DEBOUNCE_MS + 15);
  const t = setTimeout(() => {
    foregroundStalePresenceTimers.delete(key);
    scheduleGlobalFriendPresenceEmit(io, key);
  }, wait);
  foregroundStalePresenceTimers.set(key, t);
}

/** После ухода в фон: один раз переслать глобальный список, когда гистерезис «в приложении» истечёт. */
export function armInAppOfflinePresenceEmit(io: Server, userId: string): void {
  const key = normalizeUid(userId);
  if (!key) return;
  cancelInAppOfflinePresenceEmit(key);
  cancelForegroundStalePresenceEmit(key);
  syncInAppTrackingForUser(io, key, socketsOfUser(io, key));
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
  if (!key) return;
  const sockets = socketsOfUser(io, key);
  if (sockets.length === 0) return;
  if (sockets.some((s) => (s).data?.appForeground !== false)) return;
  cancelInAppOfflinePresenceEmit(key);
  userAllBackgroundSince.set(key, Date.now() - IN_APP_OFFLINE_DEBOUNCE_MS - 1);
  scheduleGlobalFriendPresenceEmit(io, key);
}

/** Онлайн ли пользователь «в приложении» — по его собственным сокетам. */
function evaluateUserOnline(io: Server, uid: string, sockets: PresenceSocket[]): boolean {
  syncInAppTrackingForUser(io, uid, sockets);
  if (sockets.length === 0) return false;
  if (sockets.some((s) => socketForegroundTriState(s) !== 'false')) return true;
  if (userHasBusyCallSocket(io, uid, sockets)) return true;
  const since = userAllBackgroundSince.get(uid);
  if (since == null) return true;
  return Date.now() - since < IN_APP_OFFLINE_DEBOUNCE_MS;
}

function isUserOnlineInApplication(io: Server, uid: string): boolean {
  const key = normalizeUid(uid);
  if (!key) return false;
  return evaluateUserOnline(io, key, socketsOfUser(io, key));
}

/** Все, кого друзья видят онлайн. O(сокетов); заодно чистит отсчёты ушедших пользователей. */
export function getFriendVisibleOnlineUserIds(io: Server): string[] {
  const byUser = socketsByConnectedUser(io);
  for (const tracked of [
    userAllBackgroundSince,
    foregroundAckTimers,
    inAppOfflinePresenceTimers,
    foregroundStalePresenceTimers,
  ] as Map<string, unknown>[]) {
    for (const uid of [...tracked.keys()]) {
      if (!byUser.has(uid)) forgetUserTracking(uid);
    }
  }
  const online: string[] = [];
  for (const [uid, sockets] of byUser) {
    if (evaluateUserOnline(io, uid, sockets)) online.push(uid);
  }
  return online;
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

async function emitFriendPresenceForUsers(io: Server, changedUserIds: string | string[]): Promise<void> {
  const changed = [...new Set((Array.isArray(changedUserIds) ? changedUserIds : [changedUserIds])
    .map(normalizeUid)
    .filter(isOid))];
  if (changed.length === 0) return;

  try {
    // Только те, чей статус нужен получателям: раньше на каждое событие пересчитывались все.
    const onlineMemo = new Map<string, boolean>();
    const isOnline = (uid: string): boolean => {
      let value = onlineMemo.get(uid);
      if (value === undefined) {
        value = isUserOnlineInApplication(io, uid);
        onlineMemo.set(uid, value);
      }
      return value;
    };
    const changedFriends = await loadFriendIdsForUsers(changed);
    const recipientIds = new Set<string>(changed);

    for (const userId of changed) {
      const friends = changedFriends.get(userId) || [];
      for (const friendId of friends) recipientIds.add(friendId);
    }

    const recipientFriends = await loadFriendIdsForUsers([...recipientIds]);
    for (const recipientId of recipientIds) {
      const friends = recipientFriends.get(recipientId) || [];
      emitPresenceSnapshotToUser(io, recipientId, friends.filter(isOnline));
    }
  } catch {
    // Presence is best-effort: skip noisy failures and let the next scheduled update heal state.
  }
}

export async function emitGlobalFriendPresence(io: Server): Promise<void> {
  try {
    const recipientIds = [...socketsByConnectedUser(io).keys()];
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
    // Отложенный require: welcomeOnlinePresence → getFriendVisibleOnlineUserIds (цикл импортов).
    try {
      const { scheduleWelcomeOnlinePresenceEmit } = require('./welcomeOnlinePresence') as {
        scheduleWelcomeOnlinePresenceEmit: (io: Server) => void;
      };
      scheduleWelcomeOnlinePresenceEmit(io);
    } catch {
      // best-effort
    }
  }, PRESENCE_BROADCAST_DEBOUNCE_MS);
}

/** app:visibility foreground:true — сброс отсчёта «фон» только если true удержался ~FOREGROUND_ACK_CLEAR_BACKGROUND_MS. */
export function scheduleDebouncedClearBackgroundOnForeground(io: Server, userId: string, broadcast = true): void {
  const key = normalizeUid(userId);
  if (!key) return;
  cancelInAppOfflinePresenceEmit(key);
  cancelForegroundAckForUser(key);
  armForegroundStalePresenceEmit(io, key);
  if (!broadcast && !userAllBackgroundSince.has(key)) return;
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
