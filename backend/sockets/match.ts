import type { ErrorDetails } from '../utils/runtimeTypes';
import type { Server } from 'socket.io';
import { createHash } from 'node:crypto';
import type { AuthedSocket } from './types';
import { logger } from '../utils/logger';
import { isShuttingDown } from '../utils/shutdownState';
import { createToken, getLiveKitUrl } from '../routes/livekit';
import * as queueStore from '../utils/queueStore';
import { getPresenceFriendIds } from '../utils/friendPresenceRecipients';
import { scheduleGlobalFriendPresenceEmit } from '../utils/friendOnlinePresence';
import { beginFriendBusyNotification } from '../utils/friendBusyPresence';
import { checkRateLimit } from '../utils/rateLimit';
import UserReportModel, { isUserReportReason } from '../models/UserReport';
import { measureMatchStage, profileNow, recordMatchStage } from '../utils/matchPerformance';

const MODERATION_BAN_MS = 60 * 60 * 1000; // 1 час

/** После ручной жалобы эта пара пользователей больше не сводится. */
const REPORT_PAIR_BLOCK_MS = 180 * 24 * 60 * 60 * 1000;
/** Столько разных пользователей за окно — и на пожаловавшегося накладывается бан. */
const REPORT_BAN_THRESHOLD = 3;
const REPORT_BAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPORT_BAN_MS = 24 * 60 * 60 * 1000;
const REPORT_RATE_LIMIT_MAX = 20;
const REPORT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Блокировка пары по userId в том же хранилище, что и rematch-баны по socket id. */
function reportPairKey(userId: string): string {
  return `user:${userId}`;
}

/** Единое время окончания бана на клиенте (не продлевается при повторных start) */
async function emitModerationBannedToSocket(s: AuthedSocket, userId: string) {
  const until = await queueStore.getModerationBanExpiresAt(userId);
  const bannedUntil = until ?? Date.now() + MODERATION_BAN_MS;
  s.emit('moderation:banned', { bannedUntil });
}

/** Первое предупреждение нарушителю (показывается у него в приложении) */
const MODERATION_FIRST_WARNING_TEXT =
  'Уважаемый пользователь, вы нарушаете правила приложения, при продолжении данных действий вы будете забанены на один час.';

// === Очередь ожидания ========================================================
// Используем распределенное хранилище через queueStore
const matchInProgress = new Set<string>(); // Локальный Set для предотвращения одновременных матчей на одном инстансе
const delayedRetryTimers = new Map<string, NodeJS.Timeout>();
// Reserve both endpoints before the first queue write. JavaScript runs this section
// synchronously; another search cannot select either endpoint while Redis is pending.
const pairReservations = new WeakMap<AuthedSocket, object>();
const searchEpochs = new WeakMap<AuthedSocket, number>();
const stoppedSearches = new WeakSet<AuthedSocket>();
const stopsInFlight = new WeakMap<AuthedSocket, Promise<void>>();
const commandRetryTimers = new WeakMap<AuthedSocket, NodeJS.Timeout>();
// Bound simultaneous scans. Letting thousands of searches all read the same
// first 64 candidates creates retry waves despite correct endpoint reservation.
const MATCH_WORKERS = 32;
let activeMatchWorkers = 0;
const pendingMatchWorkers: Array<() => void> = [];
const pendingSearches = new WeakMap<AuthedSocket, { epoch: number; promise: Promise<boolean> }>();
async function withMatchWorker(work: () => Promise<boolean>): Promise<boolean> {
  const queuedAt = profileNow();
  if (activeMatchWorkers >= MATCH_WORKERS) await new Promise<void>((resolve) => pendingMatchWorkers.push(resolve));
  else activeMatchWorkers++;
  recordMatchStage('match.worker_wait', profileNow() - queuedAt);
  try { return await measureMatchStage('match.attempt', work); }
  finally {
    const next = pendingMatchWorkers.shift();
    if (next) next();
    else activeMatchWorkers--;
  }
}
function searchEpoch(s: AuthedSocket): number { return searchEpochs.get(s) || 0; }
function invalidateSearch(s: AuthedSocket): number {
  const retry = commandRetryTimers.get(s);
  if (retry) clearTimeout(retry);
  commandRetryTimers.delete(s);
  const epoch = searchEpoch(s) + 1;
  searchEpochs.set(s, epoch);
  return epoch;
}
function isFreeForMatch(io: Server, s: AuthedSocket, reservation?: object): boolean {
  return safeGet(io, s.id) === s && !s.data.partnerSid && !s.data.inCall &&
    !s.data.isNexting && (!pairReservations.has(s) || pairReservations.get(s) === reservation) && !stoppedSearches.has(s);
}
function releaseMatchReservation(s: AuthedSocket, reservation: object | undefined): void {
  if (pairReservations.get(s) === reservation) pairReservations.delete(s);
}

/**
 * Рандом-пары, где у одного собеседника оборвался сокет (моргнула сеть, VPN, лифт).
 * Ключ — userId пропавшего. Пока идёт пауза (reconnectGraceMs), собеседник не уходит в поиск, а новый сокет
 * того же пользователя возвращается в пару через random:resume. Держим в памяти процесса,
 * как и остальной матчинг (safeGet, matchInProgress): бэкенд работает одним инстансом.
 */
type HeldPair = {
  userId: string;
  oldSocket: AuthedSocket;
  partnerSid: string;
  partnerUserId: string;
  timer: NodeJS.Timeout;
};
const heldPairs = new Map<string, HeldPair>();

/** Anonymous invariant snapshot for the explicitly enabled local capacity API. */
export function auditRandomPairs(io: Server, queuedIds: readonly string[] = []) {
  const held = new Map([...heldPairs.values()].map((pair) => [pair.oldSocket.id, pair.partnerSid]));
  const pairs: string[] = [];
  let matchedSockets = 0, heldSockets = 0, asymmetricSockets = 0, stoppedWithPartner = 0;
  for (const raw of io.sockets.sockets.values()) {
    const socket = raw as AuthedSocket;
    const sid = socket.data.randomPartnerSid;
    if (!sid) continue;
    if (stoppedSearches.has(socket)) stoppedWithPartner++;
    const other = safeGet(io, sid);
    if (!other && held.get(sid) === socket.id) { heldSockets++; continue; }
    if (!other || other === socket || socket.data.partnerSid !== sid ||
        other.data.partnerSid !== socket.id || other.data.randomPartnerSid !== socket.id ||
        !socket.data.inCall || !other.data.inCall || socket.data.userId === other.data.userId) {
      asymmetricSockets++;
      continue;
    }
    matchedSockets++;
    if (socket.id < other.id) pairs.push(`${socket.id}|${other.id}`);
  }
  return { matchedSockets, heldSockets, asymmetricSockets, stoppedWithPartner,
    queuedSockets: queuedIds.length,
    queuedWithPartner: queuedIds.filter((id) => !!safeGet(io, id)?.data.partnerSid).length,
    pairs: pairs.length, pairDigest: createHash('sha256').update(pairs.sort().join('\n')).digest('hex') };
}

// === Константы ===============================================================
const NEXT_DEBOUNCE_MS = 500;
const REMATCH_BAN_MS = 5000; // Увеличили до 5 секунд для предотвращения немедленного рематча
const START_RATE_LIMIT_MS = 2000; // Максимум 1 start в 2 секунды (защита от DDoS)
const MATCH_RATE_LIMIT_MS = 1500; // Максимум 1 попытка матчинга в 1.5 секунды (защита от перегрузки CPU)
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут - максимальное время ожидания в очереди
const QUEUE_CLEANUP_INTERVAL_MS = 30 * 1000; // Очистка каждые 30 секунд
const MATCH_CANDIDATE_SCAN_LIMIT = 64; // Не читаем всю очередь на один подбор
/** Столько ждём, пока собеседник с оборвавшимся сокетом вернётся в ту же пару (env — для тестов и тонкой настройки). */
function reconnectGraceMs(): number {
  const fromEnv = Number(process.env.RANDOM_RECONNECT_GRACE_MS);
  // A single client Engine.IO attempt is 12s; a 10s grace broke the pair before
  // even one VPN transport fallback could finish. Match the media recovery budget.
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 45_000;
}

// === Вспомогательные =========================================================
function safeGet(io: Server, sid: string): AuthedSocket | undefined {
  const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
  return s && s.connected ? s : undefined;
}
function clearDelayedRetry(sid: string) {
  const timer = delayedRetryTimers.get(String(sid));
  if (timer) {
    clearTimeout(timer);
    delayedRetryTimers.delete(String(sid));
  }
}
function scheduleDelayedRetry(
  io: Server, sid: string, delayMs: number, reason: string, restoreQueue = false,
  expectedEpoch?: number,
) {
  const id = String(sid);
  const original = safeGet(io, id);
  if (!original) return;
  const epoch = expectedEpoch ?? searchEpoch(original);
  if (searchEpoch(original) !== epoch) return;
  clearDelayedRetry(id);
  const timer = setTimeout(() => {
    delayedRetryTimers.delete(id);
    void (async () => {
      const target = safeGet(io, id);
      if (target !== original || searchEpoch(original) !== epoch || !isFreeForMatch(io, original)) return;
      if (matchInProgress.has(id)) {
        scheduleDelayedRetry(io, id, 250, reason, restoreQueue, epoch);
        return;
      }
      matchInProgress.add(id);
      try {
        if (restoreQueue) await pushToQueue(id);
        if (searchEpoch(original) !== epoch) return;
        await tryMatch(io, original);
      } catch (e: unknown) {
        logger.error('Delayed tryMatch failed', { socketId: id, reason, error: (e as ErrorDetails)?.message || e });
        scheduleDelayedRetry(io, id, MATCH_RATE_LIMIT_MS, 'queue_recovery', restoreQueue, epoch);
      } finally { matchInProgress.delete(id); }
    })();
  }, delayMs);
  delayedRetryTimers.set(id, timer);
}
async function removeFromQueue(sid: string) {
  await queueStore.removeFromQueue(sid);
}
async function pushToQueue(sid: string) {
  await queueStore.addToQueue(sid);
}
/**
 * Оптимизированная отправка presence:update только друзьям пользователя
 * Вместо отправки всем подключенным (io.emit), отправляем только заинтересованным
 */
async function emitPresenceUpdateToFriends(io: Server, userId: string, busy: boolean, isCurrent: () => boolean) {
  try {
    if (!userId) return;
    
    const friends = await measureMatchStage('friends.single', () => getPresenceFriendIds(userId));
    if (!isCurrent()) return;
    if (friends.length === 0) {
      // Если друзей нет, отправляем только самому пользователю (для синхронизации состояния)
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }
    
    // Отправляем обновление только друзьям через их комнаты
    for (const friendId of friends) {
      try {
        io.to(`u:${friendId}`).emit('presence:update', { userId, busy });
      } catch {}
    }
    
    // Также отправляем самому пользователю для синхронизации состояния
    io.to(`u:${userId}`).emit('presence:update', { userId, busy });
  } catch (e) {
    // В случае ошибки отправляем только самому пользователю (fallback)
    try {
      if (isCurrent()) io.to(`u:${userId}`).emit('presence:update', { userId, busy });
    } catch {}
  }
}

// Only unresolved notifications are retained. Late reads cannot restore an older
// busy flag after Stop or another state change, including a replacement socket.
async function markBusy(io: Server, s: AuthedSocket, busy: boolean, capturedUserId?: string) {
  s.data = s.data || {};
  s.data.busy = busy;
  const userId = String(capturedUserId || s.data.userId || '');
  if (userId) {
    const notification = beginFriendBusyNotification(userId);
    try {
      await measureMatchStage('match.presence', () => emitPresenceUpdateToFriends(io, userId, busy,
        notification.isCurrent));
      scheduleGlobalFriendPresenceEmit(io, userId);
    } finally {
      notification.finish();
    }
  }
}
async function lockPair(a: AuthedSocket, b: AuthedSocket) {
  a.data.inCall = true;
  b.data.inCall = true;
  await Promise.all([
    queueStore.lockSocket(a.id),
    queueStore.lockSocket(b.id),
  ]);
}
async function unlockPair(aSid?: string, bSid?: string) {
  const promises: Promise<void>[] = [];
  if (aSid) promises.push(queueStore.unlockSocket(aSid));
  if (bSid) promises.push(queueStore.unlockSocket(bSid));
  await Promise.all(promises);
}
async function bannedTogether(aSid: string, bSid: string) {
  return await queueStore.isBannedTogether(aSid, bSid);
}
async function banPair(aSid: string, bSid: string, ms = REMATCH_BAN_MS) {
  await queueStore.banPair(aSid, bSid, ms);
}
function makeRoomId(aSid: string, bSid: string) {
  const sorted = [aSid, bSid].sort();
  return `room_${sorted[0]}_${sorted[1]}`;
}
/**
 * Выход из комнат пары/звонка. Личную комнату `u:<userId>` не трогаем: через неё идут
 * сообщения, presence и звонки, и по ней сервер ищет сокеты пользователя.
 */
function leaveCallRooms(s: AuthedSocket) {
  s.rooms.forEach((r) => {
    if (r !== s.id && !r.startsWith('u:') && !r.startsWith('presence:')) s.leave(r);
  });
}
/**
 * LiveKit room for random chat must differ from friend VideoCall (`room_<uid>_<uid>` in index.ts call:accept).
 * Reusing the same name after a call ends causes SDK races ("track for participant not present").
 */
function makeRandomMatchLiveKitRoomName(aUserId: string, bUserId: string) {
  const sorted = [aUserId, bUserId].sort();
  return `rand_room_${sorted[0]}_${sorted[1]}`;
}
async function clearPartner(
  io: Server,
  me: AuthedSocket,
  notifyOther: boolean,
  reason: 'next'|'stop'|'disconnect',
  signalData?: { nextTransitionId?: string | null }
) {
  const otherSid = me.data.partnerSid as string | undefined;
  const candidate = otherSid ? safeGet(io, otherSid) : undefined;
  const other = candidate?.data.partnerSid === me.id ? candidate : undefined;
  // Release both local endpoints before any Redis/DB await. Cleanup failure
  // must not leave the peer attached to a user who already pressed Stop.
  for (const target of other ? [me, other] : [me]) {
    target.data.partnerSid = undefined;
    target.data.randomPartnerSid = undefined;
    target.data.inCall = false;
    target.data.roomId = undefined;
  }
  if (other && notifyOther) other.emit(reason === 'disconnect' ? 'disconnected' : 'peer:stopped', signalData);
  await Promise.all([
    unlockPair(me.id, other?.id),
    ...(other ? [markBusy(io, other, false)] : []),
  ]);
}

// === Пауза на переподключение ================================================
/**
 * Сокет из рандом-пары оборвался: не разводим пару сразу, а ждём reconnectGraceMs(),
 * пока тот же пользователь вернётся (random:resume). Собеседник видит «переподключение»,
 * LiveKit-комната у обоих остаётся. false — пауза не нужна, обрабатываем как раньше.
 */
function holdPairForReconnect(io: Server, s: AuthedSocket): boolean {
  const userId = String(s.data.userId || '').trim();
  const partnerSid = s.data.partnerSid;
  if (!userId || !partnerSid || s.data.randomPartnerSid !== partnerSid) return false;
  const partner = safeGet(io, partnerSid);
  if (!partner || partner.data.partnerSid !== s.id) return false;
  const partnerUserId = String(partner.data.userId || '').trim();
  if (!partnerUserId) return false;

  const prev = heldPairs.get(userId);
  if (prev) {
    clearTimeout(prev.timer);
    heldPairs.delete(userId);
    void releaseHeldPartner(io, prev, 'replaced');
  }

  // Старый сокет больше не в паре; собеседник пока ждёт именно его (partnerSid = s.id).
  s.data.partnerSid = undefined;
  s.data.randomPartnerSid = undefined;
  s.data.inCall = false;
  const graceMs = reconnectGraceMs();
  const timer = setTimeout(() => {
    const held = heldPairs.get(userId);
    if (!held || held.oldSocket !== s) return;
    heldPairs.delete(userId);
    void releaseHeldPartner(io, held, 'expired');
  }, graceMs);
  heldPairs.set(userId, { userId, oldSocket: s, partnerSid, partnerUserId, timer });

  partner.emit('random:partnerReconnecting', { graceMs });
  logger.info('[Match] socket dropped mid-chat, holding pair for reconnect', {
    userId,
    socketId: s.id,
    partnerSocketId: partnerSid,
    partnerUserId,
    graceMs,
  });
  return true;
}

/** Пауза кончилась без возврата: собеседник уходит в поиск, как при обычном обрыве. */
async function releaseHeldPartner(io: Server, held: HeldPair, reason: 'expired' | 'replaced' | 'restarted') {
  // index.ts unbinds a disconnected socket before this timer fires. Retain the
  // identity captured at disconnect, otherwise busy:false is never sent to its friends.
  const userId = held.userId;
  const partner = safeGet(io, held.partnerSid);
  // Собеседник мог сам нажать «Далее»/«Стоп» за это время — тогда он уже не ждёт.
  const partnerWaiting = !!partner && partner.data.partnerSid === held.oldSocket.id;
  if (partner && partnerWaiting) {
    partner.data.partnerSid = undefined;
    partner.data.randomPartnerSid = undefined;
    partner.data.inCall = false;
    partner.data.roomId = undefined;
    partner.emit('disconnected', { nextTransitionId: null });
    await markBusy(io, partner, false);
    await unlockPair(partner.id);
  }
  // Presence пропавшего не трогаем, если он уже снова в рандоме с нового сокета.
  if (reason !== 'restarted') {
    await markBusy(io, held.oldSocket, false, userId);
  }
  logger.info('[Match] held pair released', {
    userId,
    socketId: held.oldSocket.id,
    partnerSocketId: held.partnerSid,
    partnerWaiting,
    reason,
  });
}

/** Пользователь начал поиск заново вместо возврата (старый клиент или не дождался) — не держим собеседника. */
async function releaseHeldPairOf(io: Server, userId: string) {
  const held = heldPairs.get(userId);
  if (!held) return;
  clearTimeout(held.timer);
  heldPairs.delete(userId);
  await releaseHeldPartner(io, held, 'restarted');
}

/**
 * Старый сокет пользователя, который сервер ещё считает живым в рандом-паре: клиент
 * переподключился раньше, чем сервер заметил обрыв (pingInterval + pingTimeout — до ~24 с).
 */
function findStalePairedSocketOfUser(io: Server, userId: string, exceptSid: string): AuthedSocket | undefined {
  const sids = io.sockets.adapter.rooms.get(`u:${userId}`);
  if (!sids) return undefined;
  for (const sid of sids) {
    if (sid === exceptSid) continue;
    const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    if (s && s.data.partnerSid && s.data.randomPartnerSid === s.data.partnerSid) return s;
  }
  return undefined;
}

// === Матчинг ================================================================
/**
 * Попытаться найти пару для сокета
 * Экспортируется для использования в других модулях (например, index.ts)
 */
export async function tryMatch(io: Server, socket: AuthedSocket): Promise<boolean> {
  const epoch = searchEpoch(socket);
  const existing = pendingSearches.get(socket);
  if (existing?.epoch === epoch) return existing.promise;
  const promise = withMatchWorker(() => searchEpoch(socket) === epoch ? tryMatchAvailable(io, socket, epoch) : Promise.resolve(false));
  const search = { epoch, promise };
  pendingSearches.set(socket, search);
  try { return await promise; }
  finally { if (pendingSearches.get(socket) === search) pendingSearches.delete(socket); }
}

async function tryMatchAvailable(io: Server, socket: AuthedSocket, epoch: number): Promise<boolean> {
  if (!isFreeForMatch(io, socket)) return false;
  if (!(await queueStore.isInQueue(socket.id)) || searchEpoch(socket) !== epoch || !isFreeForMatch(io, socket)) return false;
  // Rate limiting: проверяем, не слишком ли часто происходят попытки матчинга
  const now = Date.now();
  const lastAttempt = await queueStore.getLastMatchAttempt(socket.id) || 0;
  if (now - lastAttempt < MATCH_RATE_LIMIT_MS) {
    logger.debug('Match attempt rate limited', { 
      socketId: socket.id, 
      timeSinceLastAttempt: now - lastAttempt,
      rateLimitMs: MATCH_RATE_LIMIT_MS
    });
    scheduleDelayedRetry(io, socket.id, MATCH_RATE_LIMIT_MS - (now - lastAttempt) + 10, 'match_rate_limit', false, epoch);
    return false;
  }
  await queueStore.setLastMatchAttempt(socket.id, now);

  const queueSize = await queueStore.getQueueSize();
  logger.debug('Attempting match', { socketId: socket.id, queueSize });
  
  // КРИТИЧНО: Детальное логирование состояния сокета для диагностики
  const hasPartnerSid = !!socket.data.partnerSid;
  const hasInCall = !!socket.data.inCall;
  const hasPairLock = await queueStore.isLocked(socket.id);
  
  if (hasPartnerSid || hasInCall || hasPairLock) {
    logger.debug('Socket already matched/busy', { 
      socketId: socket.id,
      partnerSid: socket.data.partnerSid,
      inCall: socket.data.inCall,
      inPairLock: hasPairLock
    });
    return false;
  }

  const waitQueue = await queueStore.getWaitingQueue(MATCH_CANDIDATE_SCAN_LIMIT);
  let candidateSid: string | undefined;
  let candidateReservation: object | undefined;
  let cleanedSkipped = 0;
  let rematchBanSkipped = false;

  for (const sid of waitQueue) {
    if (searchEpoch(socket) !== epoch || !isFreeForMatch(io, socket)) return false;
    if (sid === socket.id) continue;
    const other = safeGet(io, sid);
    if (!other || stoppedSearches.has(other)) {
      await removeFromQueue(sid);
      cleanedSkipped++;
      continue;
    }
    if (!isFreeForMatch(io, other)) continue;
    const myUserId = String(socket.data.userId || '');
    const otherUserId = String(other.data.userId || '');
    if (myUserId && otherUserId && myUserId === otherUserId) continue;

    // Reserve before eligibility I/O: other workers skip this pair immediately
    // instead of all querying the same first candidate and losing the race later.
    const reservation = {};
    const otherEpoch = searchEpoch(other);
    pairReservations.set(socket, reservation);
    pairReservations.set(other, reservation);
    let selected = false;
    try {
      if (await queueStore.isLocked(sid)) continue;
      if (otherUserId && await queueStore.isModerationBanned(otherUserId)) {
        await removeFromQueue(sid);
        cleanedSkipped++;
        continue;
      }
      if (myUserId && otherUserId &&
          await queueStore.isBannedTogether(reportPairKey(myUserId), reportPairKey(otherUserId))) continue;
      // Friendship does not exclude a random match. Both kinds of pair bans do.
      if (await bannedTogether(socket.id, other.id)) { rematchBanSkipped = true; continue; }
      const [meQueued, otherQueued] = await Promise.all([
        queueStore.isInQueue(socket.id), queueStore.isInQueue(other.id),
      ]);
      if (!meQueued) return false;
      if (!otherQueued) continue;
      if (searchEpoch(socket) !== epoch || !isFreeForMatch(io, socket, reservation)) return false;
      if (searchEpoch(other) !== otherEpoch || !isFreeForMatch(io, other, reservation)) continue;
      candidateSid = sid;
      candidateReservation = reservation;
      selected = true;
      break;
    } finally {
      if (!selected) {
        releaseMatchReservation(socket, reservation);
        releaseMatchReservation(other, reservation);
      }
    }
  }

  if (!candidateSid) {
    logger.debug('No candidate found', {
      socketId: socket.id,
      queueSize,
      scanned: waitQueue.length,
      scanLimit: MATCH_CANDIDATE_SCAN_LIMIT,
      cleanedSkipped,
    });
    if (waitQueue.length >= MATCH_CANDIDATE_SCAN_LIMIT) {
      scheduleDelayedRetry(io, socket.id, MATCH_RATE_LIMIT_MS + 10, 'candidate_contention', false, epoch);
    } else if (rematchBanSkipped) {
      scheduleDelayedRetry(io, socket.id, REMATCH_BAN_MS + 10, 'rematch_ban_expiry', false, epoch);
    }
    return false;
  }

  const other = safeGet(io, candidateSid);
  if (!other || !isFreeForMatch(io, socket, candidateReservation) || !isFreeForMatch(io, other, candidateReservation)) {
    releaseMatchReservation(socket, candidateReservation);
    if (other) releaseMatchReservation(other, candidateReservation);
    return false;
  }
  const otherEpoch = searchEpoch(other);
  try {
    await Promise.all([removeFromQueue(socket.id), removeFromQueue(other.id)]);
  } catch (error) {
    scheduleDelayedRetry(io, socket.id, MATCH_RATE_LIMIT_MS, 'queue_write_failed', true, epoch);
    scheduleDelayedRetry(io, other.id, MATCH_RATE_LIMIT_MS, 'queue_write_failed', true, otherEpoch);
    throw error;
  } finally {
    releaseMatchReservation(socket, candidateReservation);
    releaseMatchReservation(other, candidateReservation);
  }
  if (searchEpoch(socket) !== epoch || searchEpoch(other) !== otherEpoch ||
      !isFreeForMatch(io, socket) || !isFreeForMatch(io, other)) {
    // The other endpoint may have stopped while the queue writes were pending.
    // Keep any unchanged search eligible instead of silently losing it.
    for (const [s, expected] of [[socket, epoch], [other, otherEpoch]] as const) {
      if (searchEpoch(s) === expected && isFreeForMatch(io, s)) {
        await pushToQueue(s.id);
        scheduleDelayedRetry(io, s.id, MATCH_RATE_LIMIT_MS + 10, 'reservation_cancelled');
      }
    }
    return false;
  }

  clearDelayedRetry(socket.id);
  clearDelayedRetry(other.id);

  const socketNextTransitionId = socket.data.lastNextTransitionId || null;
  const otherNextTransitionId = other.data.lastNextTransitionId || null;
  logger.info('Match found', {
    socket1: socket.id,
    socket2: other.id,
    socket1NextTransitionId: socketNextTransitionId,
    socket2NextTransitionId: otherNextTransitionId,
  });

  socket.data.partnerSid = other.id;
  other.data.partnerSid = socket.id;
  socket.data.randomPartnerSid = other.id;
  other.data.randomPartnerSid = socket.id;

  try {
    await lockPair(socket, other);
  } catch (error) {
    if (searchEpoch(socket) === epoch && searchEpoch(other) === otherEpoch &&
        socket.data.partnerSid === other.id && other.data.partnerSid === socket.id) {
      for (const s of [socket, other]) {
        s.data.partnerSid = undefined;
        s.data.randomPartnerSid = undefined;
        s.data.inCall = false;
      }
      await unlockPair(socket.id, other.id).catch(() => undefined);
      scheduleDelayedRetry(io, socket.id, MATCH_RATE_LIMIT_MS, 'pair_lock_failed', true, epoch);
      scheduleDelayedRetry(io, other.id, MATCH_RATE_LIMIT_MS, 'pair_lock_failed', true, otherEpoch);
    }
    throw error;
  }
  if (searchEpoch(socket) !== epoch || searchEpoch(other) !== otherEpoch ||
      socket.data.partnerSid !== other.id || other.data.partnerSid !== socket.id) {
    await Promise.all([socket, other].filter((s) => !s.data.partnerSid && !s.data.inCall).map((s) => unlockPair(s.id)));
    return false;
  }
  await markBusy(io, socket, true);
  if (searchEpoch(socket) !== epoch || searchEpoch(other) !== otherEpoch ||
      socket.data.partnerSid !== other.id || other.data.partnerSid !== socket.id) return false;
  await markBusy(io, other, true);

  const myUserId = String(socket.data.userId || '');
  const otherUserId = String(other.data.userId || '');

  logger.debug('Sending match_found events', { 
    socket1: socket.id, userId1: myUserId, 
    socket2: other.id, userId2: otherUserId,
    socket1NextTransitionId: socketNextTransitionId,
    socket2NextTransitionId: otherNextTransitionId,
  });

  const roomId = makeRoomId(socket.id, other.id);
  
  // Создаем roomName на основе userId для LiveKit
  let livekitTokenA: string | null = null;
  let livekitTokenB: string | null = null;
  let livekitRoomName: string = roomId;
  const livekitIdentityA = myUserId || `socket:${socket.id}`;
  const livekitIdentityB = otherUserId || `socket:${other.id}`;
  
  if (myUserId && otherUserId) {
    livekitRoomName = makeRandomMatchLiveKitRoomName(myUserId, otherUserId);
  }

  try {
    const [tokenA, tokenB] = await measureMatchStage('match.tokens', () => Promise.all([
      createToken({ identity: livekitIdentityA, roomName: livekitRoomName }),
      createToken({ identity: livekitIdentityB, roomName: livekitRoomName }),
    ]));
    livekitTokenA = tokenA;
    livekitTokenB = tokenB;
    logger.debug('LiveKit tokens created', { roomName: livekitRoomName, identityA: livekitIdentityA, identityB: livekitIdentityB });
  } catch (e: unknown) {
    logger.error('Failed to create LiveKit tokens:', e);
  }

  // Tokens and presence can finish after Next/Stop or a network interruption.
  // Never deliver a result for a pair that no longer exists.
  if (searchEpoch(socket) !== epoch || searchEpoch(other) !== otherEpoch ||
      !socket.connected || !other.connected ||
      socket.data.partnerSid !== other.id || other.data.partnerSid !== socket.id) return false;
  
  io.to(socket.id).emit('match_found', { 
    roomId, 
    id: other.id, 
    userId: otherUserId || null,
    livekitToken: livekitTokenA,
    livekitRoomName,
    livekitUrl: getLiveKitUrl() || null,
    nextTransitionId: socketNextTransitionId,
  });
  io.to(other.id).emit('match_found', { 
    roomId, 
    id: socket.id, 
    userId: myUserId || null,
    livekitToken: livekitTokenB,
    livekitRoomName,
    livekitUrl: getLiveKitUrl() || null,
    nextTransitionId: otherNextTransitionId,
  });

  socket.data.lastNextTransitionId = undefined;
  other.data.lastNextTransitionId = undefined;

  return true;
}

// === Основная логика ========================================================
export function bindMatch(io: Server, socket: AuthedSocket) {
  // Socket.IO does not await async listeners. Contain storage rejections so a
  // temporary Redis OOM/network failure cannot become a process-wide crash.
  const onCommand = <Args extends unknown[]>(event: string, handler: (...args: Args) => unknown) => {
    socket.on(event, (...args: Args) => {
      let retryAttempt = 0;
      const execute = async (): Promise<void> => {
        const entryEpoch = searchEpoch(socket);
        const entryPartnerSid = socket.data.partnerSid;
        try {
          if (event === 'start' || event === 'next') {
            await measureMatchStage(event === 'start' ? 'search.start' : 'search.next', async () => handler(...args));
          } else await handler(...args);
        }
        catch (error) {
          logger.error('Random command failed', { event, socketId: socket.id, error: (error as ErrorDetails)?.message || error });
          if (event === 'disconnect') {
            await Promise.allSettled([clearPartner(io, socket, true, 'disconnect'), markBusy(io, socket, false)]);
            return;
          }
          const epoch = searchEpoch(socket);
          if ((event !== 'start' && event !== 'next') || !socket.connected ||
              (epoch !== entryEpoch && !(event === 'next' && epoch === entryEpoch + 1)) ||
              (event === 'next' && stoppedSearches.has(socket))) return;
          const previous = commandRetryTimers.get(socket);
          if (previous) clearTimeout(previous);
          const retryDelay = Math.min(15_000, START_RATE_LIMIT_MS * 2 ** Math.min(retryAttempt++, 3));
          const timer = setTimeout(() => {
            commandRetryTimers.delete(socket);
            if (!socket.connected || searchEpoch(socket) !== epoch) return;
            const stillOriginalPair = event === 'next' && entryPartnerSid &&
              socket.data.partnerSid === entryPartnerSid && epoch === entryEpoch;
            if (!stillOriginalPair && (socket.data.partnerSid || socket.data.inCall)) return;
            void execute(); // repeats the original moderation and rate checks
          }, retryDelay + 100 + Math.floor(Math.random() * 300));
          commandRetryTimers.set(socket, timer);
        }
      };
      return execute();
    });
  };
  const runTryMatch = (target: AuthedSocket) => {
    if (matchInProgress.has(target.id)) return;
    matchInProgress.add(target.id);
    const epoch = searchEpoch(target);
    void tryMatch(io, target)
      .catch((e: unknown) => {
        logger.error('tryMatch failed', { socketId: target.id, error: (e as ErrorDetails)?.message || e });
        scheduleDelayedRetry(io, target.id, MATCH_RATE_LIMIT_MS, 'queue_recovery', true, epoch);
      })
      .finally(() => {
        matchInProgress.delete(target.id);
      });
  };

  /**
   * Бан собеседника и выход из пары. moderation:banned → клиент сам stopRandomChat;
   * peer:left не шлём — иначе последующий next() репортёра снова пометит
   * забаненного busy и вернёт в очередь.
   */
  const banAndEvictPartner = async (
    partner: AuthedSocket,
    partnerSid: string,
    partnerUserId: string,
    banMs: number,
  ) => {
    await queueStore.banModerationUser(partnerUserId, banMs);
    await banPair(socket.id, partnerSid);
    await emitModerationBannedToSocket(partner, partnerUserId);

    partner.data.partnerSid = undefined;

    partner.data.randomPartnerSid = undefined;
    partner.data.inCall = false;
    partner.data.roomId = undefined;
    leaveCallRooms(partner);
    clearDelayedRetry(partner.id);
    await unlockPair(partner.id);
    await removeFromQueue(partner.id);
    await markBusy(io, partner, false);

    // Отвязываем репортёра от пары до его next(), иначе next найдёт prevPartner
    // и сделает markBusy(banned, true) + requeue.
    socket.data.partnerSid = undefined;
    socket.data.randomPartnerSid = undefined;
    socket.data.inCall = false;
    socket.data.roomId = undefined;
    await unlockPair(socket.id);
  };

  // === START ================================================================
  onCommand('start', async (data?: { transitionId?: string }) => {
    const epoch = searchEpoch(socket);
    const cancelled = () => !socket.connected || searchEpoch(socket) !== epoch;
    await stopsInFlight.get(socket);
    if (cancelled()) return;
    const transitionId =
      data && typeof data.transitionId === 'string' && data.transitionId.trim().length > 0
        ? data.transitionId.trim()
        : undefined;
    // Бан модерации: пользователь не может войти в рандомный чат
    const myUserId = String(socket.data.userId || '');
    if (myUserId && (await queueStore.isModerationBanned(myUserId))) {
      logger.debug('Start rejected: user is moderation-banned', {
        socketId: socket.id,
        userId: myUserId,
        transitionId,
      });
      await emitModerationBannedToSocket(socket, myUserId);
      return;
    }
    // Начал поиск заново вместо random:resume — собеседника на паузе не держим.
    if (myUserId) await releaseHeldPairOf(io, myUserId);
    // Rate limiting: защита от DDoS через множественные start запросы
    const now = Date.now();
    const lastStart = await queueStore.getLastStart(socket.id) || 0;
    if (now - lastStart < START_RATE_LIMIT_MS) {
      logger.debug('Start request rate limited', { 
        socketId: socket.id, 
        timeSinceLastStart: now - lastStart,
        rateLimitMs: START_RATE_LIMIT_MS,
        transitionId,
      });
      return;
    }
    await queueStore.setLastStart(socket.id, now);
    if (cancelled()) return;

    // Если уже есть партнер и он существует — не ломаем активную сессию.
    const existingPartnerSid = socket.data.partnerSid as string | undefined;
    if (existingPartnerSid) {
      const partner = safeGet(io, existingPartnerSid);
      if (partner) {
        logger.debug('Start ignored: socket already has partner', {
          socketId: socket.id,
          partnerSid: existingPartnerSid,
          transitionId,
        });
        return;
      }
      // Партнер "пропал" — очищаем stale состояние.
      logger.warn('Start requested but stale partnerSid found, cleaning up', {
        socketId: socket.id,
        partnerSid: existingPartnerSid,
        transitionId,
      });
      socket.data.partnerSid = undefined;
      socket.data.randomPartnerSid = undefined;
      socket.data.inCall = false;
      await unlockPair(socket.id);
    }

    // Если сокет уже залочен/в колле — не добавляем в очередь повторно.
    const isLocked = await queueStore.isLocked(socket.id);
    if (cancelled()) return;
    if (isLocked || socket.data.inCall || socket.data.partnerSid || pairReservations.has(socket)) {
      logger.debug('Start ignored: socket is busy', {
        socketId: socket.id,
        inCall: !!socket.data.inCall,
        inPairLock: isLocked,
        transitionId,
      });
      return;
    }
    
    // КРИТИЧНО: Всегда очищаем состояние перед добавлением в очередь
    stoppedSearches.delete(socket);
    leaveCallRooms(socket);
    socket.data.partnerSid = undefined;
    socket.data.randomPartnerSid = undefined;
    socket.data.roomId = undefined;
    socket.data.busy = false;
    socket.data.inCall = false;
    socket.data.lastNextTransitionId = transitionId;
    await unlockPair(socket.id);
    if (cancelled()) return;

    logger.debug('Start requested', { socketId: socket.id, transitionId });
    await markBusy(io, socket, true);
    if (cancelled()) return;
    // A concurrent Next requeue may already have produced a pair while this
    // Start awaited metadata. Never put that matched endpoint back in the FIFO.
    if (socket.data.partnerSid || socket.data.inCall || pairReservations.has(socket)) return;
    await pushToQueue(socket.id);
    if (cancelled() || socket.data.partnerSid || socket.data.inCall) {
      await removeFromQueue(socket.id);
      return;
    }
    // КРИТИЧНО: Вызываем tryMatch немедленно, без задержек
    // Это гарантирует быстрое нахождение собеседника
    runTryMatch(socket);
  });

  // === NEXT ================================================================
  onCommand('next', async (data?: { transitionId?: string }) => {
    const entryEpoch = searchEpoch(socket);
    await stopsInFlight.get(socket);
    if (!socket.connected || searchEpoch(socket) !== entryEpoch) return;
    const transitionId = typeof data?.transitionId === 'string' && data.transitionId.trim()
      ? data.transitionId.trim() : undefined;
    const now = Date.now();
    const last = await queueStore.getLastSearch(socket.id) || 0;
    if (now - last < NEXT_DEBOUNCE_MS) return;
    await queueStore.setLastSearch(socket.id, now);
    if (!socket.connected || searchEpoch(socket) !== entryEpoch) return;

    const epoch = invalidateSearch(socket);
    stoppedSearches.delete(socket);
    const previous = socket.data.partnerSid ? safeGet(io, socket.data.partnerSid) : undefined;
    const other = previous?.data.partnerSid === socket.id ? previous : undefined;
    const otherEpoch = other ? invalidateSearch(other) : 0;
    socket.data.lastNextTransitionId = transitionId;

    // Detach both endpoints synchronously. No Redis wait can leave half a pair
    // available to another search or let a late token restore the old session.
    for (const target of other ? [socket, other] : [socket]) {
      target.data.partnerSid = undefined;
      target.data.randomPartnerSid = undefined;
      target.data.inCall = false;
      target.data.roomId = undefined;
      target.data.isNexting = true;
      clearDelayedRetry(target.id);
      leaveCallRooms(target);
    }

    const enqueueAfterNext = (target: AuthedSocket, expectedEpoch: number) => {
      setTimeout(() => {
        void (async () => {
          const current = () => safeGet(io, target.id) === target && searchEpoch(target) === expectedEpoch &&
            !target.data.partnerSid && !target.data.inCall && !stoppedSearches.has(target);
          if (!current()) return;
          const uid = String(target.data.userId || '').trim();
          const banned = uid && await queueStore.isModerationBanned(uid);
          if (!current()) return;
          target.data.isNexting = false;
          if (banned) { await markBusy(io, target, false); return; }
          await pushToQueue(target.id);
          if (!current()) {
            // A newer Start owns its queue entry. Stop/disconnect already mark
            // the socket idle and may have raced the pending queue write.
            if (!target.data.busy || !target.connected) await removeFromQueue(target.id);
            return;
          }
          runTryMatch(target);
          scheduleDelayedRetry(io, target.id, REMATCH_BAN_MS + 250, 'next_rematch_window');
        })().catch((e: unknown) => {
          logger.error('Next requeue failed', { socketId: target.id, error: (e as ErrorDetails)?.message || e });
        });
      }, 250);
    };

    await Promise.all([
      removeFromQueue(socket.id), unlockPair(socket.id),
      ...(other ? [removeFromQueue(other.id), unlockPair(other.id), banPair(socket.id, other.id)] : []),
    ]);
    if (other && safeGet(io, other.id) === other && searchEpoch(other) === otherEpoch && !stoppedSearches.has(other)) {
      const uid = String(other.data.userId || '').trim();
      const banned = uid && await queueStore.isModerationBanned(uid);
      if (other.connected && searchEpoch(other) === otherEpoch) {
        if (banned) {
          other.data.isNexting = false;
          await markBusy(io, other, false);
        } else {
          other.emit('peer:left', { nextTransitionId: transitionId ?? null });
          await markBusy(io, other, true);
          if (searchEpoch(other) === otherEpoch) enqueueAfterNext(other, otherEpoch);
        }
      }
    }
    if (socket.connected && searchEpoch(socket) === epoch) {
      await markBusy(io, socket, true);
      if (searchEpoch(socket) === epoch) enqueueAfterNext(socket, epoch);
    }
  });

  // === MODERATION: предупреждение партнёру (первое нарушение) =============
  socket.on('moderation:warningPartner', () => {
    const partnerSid = socket.data.partnerSid as string | undefined;
    if (partnerSid) {
      const partner = safeGet(io, partnerSid);
      if (partner) {
        partner.emit('moderation:warning', { message: MODERATION_FIRST_WARNING_TEXT });
        logger.debug('[Moderation] warning sent to partner', { reporterSocketId: socket.id, partnerSocketId: partnerSid });
      }
    }
  });

  type ReportAck = { ok: boolean; reason?: string };

  // === MODERATION: report partner for violation (второе нарушение — бан) ===
  onCommand(
    'moderation:reportPartner',
    async (
      { partnerUserId }: { partnerUserId?: string },
      ack?: (r: ReportAck) => void
    ) => {
      const done = (r: ReportAck) => {
        try {
          if (typeof ack === 'function') ack(r);
        } catch {}
      };

      const reported = String(partnerUserId || '').trim();
      if (!reported) {
        done({ ok: false, reason: 'no_partner_user_id' });
        return;
      }

      // SECURITY/CONSISTENCY:
      // Never trust client-provided partnerUserId blindly.
      // Ban only the currently connected partner in this random-chat pair.
      const partnerSid = socket.data.partnerSid as string | undefined;
      if (!partnerSid) {
        done({ ok: false, reason: 'no_partner_socket' });
        return;
      }
      const partner = safeGet(io, partnerSid);
      if (!partner) {
        done({ ok: false, reason: 'partner_not_connected' });
        return;
      }
      const actualPartnerUserId = String((partner)?.data?.userId || '').trim();
      if (!actualPartnerUserId) {
        done({ ok: false, reason: 'partner_user_unknown' });
        return;
      }
      if (reported !== actualPartnerUserId) {
        logger.warn('[Moderation] Reject reportPartner due to mismatched partnerUserId', {
          reporterSocketId: socket.id,
          reporterUserId: (socket)?.data?.userId,
          providedPartnerUserId: reported,
          actualPartnerUserId,
          partnerSocketId: partnerSid,
        });
        done({ ok: false, reason: 'partner_mismatch' });
        return;
      }

      const reporterId = (socket)?.data?.userId;
      logger.info('[Moderation] partner reported for violation, banning userId', {
        reporterUserId: reporterId,
        reportedUserId: actualPartnerUserId,
        reporterSocketId: socket.id,
      });

      await banAndEvictPartner(partner, partnerSid, actualPartnerUserId, MODERATION_BAN_MS);

      done({ ok: true });
    }
  );

  type UserReportAck = { ok: boolean; reason?: string; banned?: boolean };

  // === REPORT: ручная жалоба из карточки «Собеседник» ======================
  // Не банит сразу (иначе любой мог бы забанить любого): сохраняет жалобу для
  // разбора, навсегда разводит эту пару, а бан — только когда жалуются разные люди.
  socket.on(
    'user:reportPartner',
    async (
      { partnerUserId, reason }: { partnerUserId?: string; reason?: string },
      ack?: (r: UserReportAck) => void,
    ) => {
      const done = (r: UserReportAck) => {
        try {
          if (typeof ack === 'function') ack(r);
        } catch {}
      };
      try {
        const reporterId = String((socket)?.data?.userId || '').trim();
        const reported = String(partnerUserId || '').trim();
        if (!reporterId) return done({ ok: false, reason: 'unauthorized' });
        if (!reported) return done({ ok: false, reason: 'no_partner_user_id' });
        if (!isUserReportReason(reason)) return done({ ok: false, reason: 'invalid_reason' });

        const rl = await checkRateLimit(`user_report:${reporterId}`, REPORT_RATE_LIMIT_MAX, REPORT_RATE_LIMIT_WINDOW_MS);
        if (!rl.ok) return done({ ok: false, reason: 'rate_limited' });

        // Жаловаться можно только на текущего собеседника этой пары.
        const partnerSid = socket.data.partnerSid as string | undefined;
        const partner = partnerSid ? safeGet(io, partnerSid) : undefined;
        const actualPartnerUserId = String((partner)?.data?.userId || '').trim();
        if (!partnerSid || !partner || !actualPartnerUserId) {
          return done({ ok: false, reason: 'partner_not_connected' });
        }
        if (reported !== actualPartnerUserId) {
          logger.warn('[Report] Reject user:reportPartner due to mismatched partnerUserId', {
            reporterUserId: reporterId,
            providedPartnerUserId: reported,
            actualPartnerUserId,
          });
          return done({ ok: false, reason: 'partner_mismatch' });
        }

        await UserReportModel.updateOne(
          { reporter: reporterId, reported: actualPartnerUserId },
          { $set: { reason, source: 'random_chat', status: 'open' } },
          { upsert: true },
        );
        await queueStore.banPair(reportPairKey(reporterId), reportPairKey(actualPartnerUserId), REPORT_PAIR_BLOCK_MS);

        const distinctReporters = await UserReportModel.countDocuments({
          reported: actualPartnerUserId,
          updatedAt: { $gte: new Date(Date.now() - REPORT_BAN_WINDOW_MS) },
        });
        const shouldBan = distinctReporters >= REPORT_BAN_THRESHOLD;
        logger.info('[Report] partner reported', {
          reporterUserId: reporterId,
          reportedUserId: actualPartnerUserId,
          reason,
          distinctReporters,
          banned: shouldBan,
        });

        if (shouldBan) {
          await banAndEvictPartner(partner, partnerSid, actualPartnerUserId, REPORT_BAN_MS);
        }
        // Без бана пару разводит обычный next() репортёра — как при «Далее».
        done({ ok: true, banned: shouldBan });
      } catch (e: unknown) {
        logger.warn('[Report] user:reportPartner failed', { error: (e as ErrorDetails)?.message || String(e) });
        done({ ok: false, reason: 'server_error' });
      }
    },
  );

  // === RESUME: возврат в пару после обрыва сокета ==========================
  type ResumeAck =
    | {
        ok: true;
        id: string;
        livekitToken: string | null;
        livekitRoomName: string;
        livekitUrl: string | null;
      }
    | { ok: false; reason: string };

  socket.on(
    'random:resume',
    async (payload: { partnerUserId?: string } | undefined, ack?: (r: ResumeAck) => void) => {
      const done = (r: ResumeAck) => {
        try {
          if (typeof ack === 'function') ack(r);
        } catch {}
      };
      try {
        const userId = String(socket.data.userId || '').trim();
        // Сокет ещё не привязан к пользователю (reauth в процессе) — клиент повторит.
        if (!userId) return done({ ok: false, reason: 'not_ready' });
        const expectedPartnerUserId = String(payload?.partnerUserId || '').trim();
        if (!expectedPartnerUserId) return done({ ok: false, reason: 'bad_request' });
        if (stoppedSearches.has(socket)) return done({ ok: false, reason: 'expired' });

        // Сокет не рвался, сдался только LiveKit: пара цела — нужен лишь свежий токен в ту же комнату.
        const currentPartner =
          socket.data.partnerSid && socket.data.randomPartnerSid === socket.data.partnerSid
            ? safeGet(io, socket.data.partnerSid)
            : undefined;
        if (currentPartner && currentPartner.data.partnerSid === socket.id) {
          const epoch = searchEpoch(socket);
          const currentPartnerUserId = String(currentPartner.data.userId || '').trim();
          if (currentPartnerUserId !== expectedPartnerUserId) {
            return done({ ok: false, reason: 'partner_mismatch' });
          }
          const roomName = makeRandomMatchLiveKitRoomName(userId, currentPartnerUserId);
          let token: string | null = null;
          try {
            token = await createToken({ identity: userId, roomName });
          } catch (e: unknown) {
            logger.error('[Match] resume: failed to create LiveKit token', { error: (e as ErrorDetails)?.message || String(e) });
          }
          if (!socket.connected || searchEpoch(socket) !== epoch ||
              socket.data.partnerSid !== currentPartner.id || currentPartner.data.partnerSid !== socket.id) {
            return done({ ok: false, reason: 'expired' });
          }
          logger.info('[Match] resume on a live socket — LiveKit rejoin', { userId, socketId: socket.id });
          return done({
            ok: true,
            id: currentPartner.id,
            livekitToken: token,
            livekitRoomName: roomName,
            livekitUrl: getLiveKitUrl() || null,
          });
        }

        // Пара либо на паузе (сервер уже заметил обрыв), либо старый сокет ещё числится живым.
        const held = heldPairs.get(userId);
        const staleSocket = held ? undefined : findStalePairedSocketOfUser(io, userId, socket.id);
        const oldSocket = held ? held.oldSocket : staleSocket;
        const partnerSid = held ? held.partnerSid : staleSocket?.data.partnerSid;
        const partner = partnerSid ? safeGet(io, partnerSid) : undefined;
        const partnerUserId = String(partner?.data.userId || '').trim();

        const stillWaiting = !!oldSocket && !!partner && partner.data.partnerSid === oldSocket.id;
        if (!stillWaiting || partnerUserId !== expectedPartnerUserId) {
          if (held) {
            clearTimeout(held.timer);
            heldPairs.delete(userId);
            await releaseHeldPartner(io, held, 'restarted');
          }
          logger.info('[Match] resume rejected', {
            userId,
            socketId: socket.id,
            hadHeldPair: !!held,
            hadStaleSocket: !!staleSocket,
            partnerMismatch: stillWaiting && partnerUserId !== expectedPartnerUserId,
          });
          return done({ ok: false, reason: stillWaiting ? 'partner_mismatch' : 'expired' });
        }
        if (socket.data.partnerSid && socket.data.partnerSid !== partner.id) {
          return done({ ok: false, reason: 'already_paired' });
        }

        if (held) {
          clearTimeout(held.timer);
          heldPairs.delete(userId);
        }
        const epoch = invalidateSearch(socket);
        invalidateSearch(oldSocket);
        // Старый сокет отпускаем: его поздний disconnect не должен разорвать пару.
        oldSocket.data.resumedBy = socket.id;
        oldSocket.data.partnerSid = undefined;
        oldSocket.data.randomPartnerSid = undefined;
        oldSocket.data.inCall = false;
        clearDelayedRetry(socket.id);
        socket.data.partnerSid = partner.id;
        socket.data.randomPartnerSid = partner.id;
        partner.data.partnerSid = socket.id;
        partner.data.randomPartnerSid = socket.id;
        socket.data.isNexting = false;
        await Promise.all([unlockPair(oldSocket.id), removeFromQueue(socket.id)]);
        const current = () => socket.connected && searchEpoch(socket) === epoch &&
          socket.data.partnerSid === partner.id && partner.data.partnerSid === socket.id;
        if (!current()) return done({ ok: false, reason: 'expired' });
        await lockPair(socket, partner);
        if (!current()) {
          await Promise.all([socket, partner].filter((s) => !s.data.partnerSid && !s.data.inCall).map((s) => unlockPair(s.id)));
          return done({ ok: false, reason: 'expired' });
        }
        await markBusy(io, socket, true);

        // Свежий токен — если LiveKit у вернувшегося успел сдаться, он зайдёт в ту же комнату.
        const livekitRoomName = makeRandomMatchLiveKitRoomName(userId, partnerUserId);
        let livekitToken: string | null = null;
        try {
          livekitToken = await createToken({ identity: userId, roomName: livekitRoomName });
        } catch (e: unknown) {
          logger.error('[Match] resume: failed to create LiveKit token', { error: (e as ErrorDetails)?.message || String(e) });
        }

        if (!current()) return done({ ok: false, reason: 'expired' });
        partner.emit('random:partnerResumed', { id: socket.id });
        logger.info('[Match] pair resumed after reconnect', {
          userId,
          socketId: socket.id,
          oldSocketId: oldSocket.id,
          partnerSocketId: partner.id,
          partnerUserId,
          viaHeldPair: !!held,
        });
        done({
          ok: true,
          id: partner.id,
          livekitToken,
          livekitRoomName,
          livekitUrl: getLiveKitUrl() || null,
        });
      } catch (e: unknown) {
        logger.warn('[Match] random:resume failed', { error: (e as ErrorDetails)?.message || String(e) });
        done({ ok: false, reason: 'server_error' });
      }
    },
  );

  // === STOP ================================================================
  socket.on('stop', () => {
    invalidateSearch(socket);
    stoppedSearches.add(socket);
    socket.data.isNexting = false;
    clearDelayedRetry(socket.id);
    const previousStop = stopsInFlight.get(socket);
    const stop = (async () => {
      await previousStop;
      const stopUserId = String(socket.data.userId || '').trim();
      const partnerSid = socket.data.partnerSid as string | undefined;
      const clear = clearPartner(io, socket, true, 'stop', {
        nextTransitionId: socket.data.lastNextTransitionId ?? null,
      });
      socket.data.inCall = false;
      socket.data.lastNextTransitionId = undefined;
      await Promise.all([
        clear, markBusy(io, socket, false), removeFromQueue(socket.id),
        ...(stopUserId ? [releaseHeldPairOf(io, stopUserId)] : []),
        ...(partnerSid ? [banPair(socket.id, partnerSid)] : []),
      ]);
    })().catch((e: unknown) => {
      logger.error('Stop search cleanup failed', { socketId: socket.id, error: (e as ErrorDetails)?.message || e });
    }).finally(() => {
      if (stopsInFlight.get(socket) === stop) stopsInFlight.delete(socket);
    });
    stopsInFlight.set(socket, stop);
    return stop;
  });

  // === DISCONNECT ==========================================================
  onCommand('disconnect', async (reason: string) => {
    invalidateSearch(socket);
    stoppedSearches.add(socket);
    logger.debug('Socket disconnected', { socketId: socket.id, reason });
    clearDelayedRetry(socket.id);

    if (isShuttingDown()) {
      try {
        await removeFromQueue(socket.id);
        await queueStore.clearSocketData(socket.id);
      } catch {}
      socket.data.isNexting = false;
      // Shutdown закрывает Redis, пока обработчики disconnect ещё работают: без try отказ Redis
      // становился unhandled rejection и ронял процесс с кодом 1 посреди деплоя.
      try {
        await clearPartner(io, socket, false, 'disconnect', {
          nextTransitionId: socket.data.lastNextTransitionId ?? null,
        });
      } catch {}
      socket.data.inCall = false;
      socket.data.lastNextTransitionId = undefined;
      try {
        await markBusy(io, socket, false);
      } catch {}
      try {
        await unlockPair(socket.id);
      } catch {}
      return;
    }

    // Если пользователь нажал "Next" — не удаляем и не трогаем очередь
    if (socket.data?.isNexting) {
      logger.debug('Socket was nexting, cleaning disconnected socket without requeue', {
        socketId: socket.id,
        transitionId: socket.data.lastNextTransitionId,
      });
      socket.data.isNexting = false;
      await removeFromQueue(socket.id);
      await queueStore.clearSocketData(socket.id);
      socket.data.inCall = false;
      socket.data.lastNextTransitionId = undefined;
      await unlockPair(socket.id);
      await markBusy(io, socket, false);
      return;
    }

    // Пару уже забрал новый сокет этого же пользователя (random:resume) — собеседника не трогаем.
    if (socket.data.resumedBy) {
      await removeFromQueue(socket.id);
      await queueStore.clearSocketData(socket.id);
      await unlockPair(socket.id);
      return;
    }
    // Моргнула сеть посреди разговора — даём вернуться в ту же пару. Намеренное отключение
    // (клиент или сервер закрыл сокет сам) — не обрыв, ждать нечего. Исключение: сервер вытеснил
    // сокет, потому что пользователь уже переподключился новым, — это как раз обрыв.
    const deliberate =
      reason === 'client namespace disconnect' ||
      (reason === 'server namespace disconnect' && !socket.data.evictedBy);
    if (!deliberate && holdPairForReconnect(io, socket)) {
      await removeFromQueue(socket.id);
      await queueStore.clearSocketData(socket.id);
      socket.data.lastNextTransitionId = undefined;
      await unlockPair(socket.id);
      return;
    }

    await queueStore.clearSocketData(socket.id);
    await clearPartner(io, socket, true, 'disconnect', {
      nextTransitionId: socket.data.lastNextTransitionId ?? null,
    });
    socket.data.inCall = false;
    socket.data.lastNextTransitionId = undefined;
    await markBusy(io, socket, false);
    await unlockPair(socket.id);
  });
}

// === Периодическая очистка очереди ============================================
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Инициализировать периодическую очистку устаревших сокетов из очереди
 */
export function startQueueCleanup(io: Server): void {
  // Останавливаем предыдущий интервал, если он существует
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  const isSocketConnected = (sid: string): boolean => {
    const socket = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    return socket?.connected === true;
  };

  // Запускаем периодическую очистку
  cleanupInterval = setInterval(async () => {
    try {
      // 1. Очистка устаревших записей из очереди
      const staleSids = await queueStore.cleanupStaleQueueEntries(
        QUEUE_TIMEOUT_MS,
        isSocketConnected
      );

      if (staleSids.length > 0) {
        logger.info('Cleaned up stale queue entries', { 
          count: staleSids.length, 
          socketIds: staleSids 
        });

        // Очищаем данные для удаленных сокетов
        for (const sid of staleSids) {
          const socket = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
          if (socket) {
            // Если сокет все еще существует, но был удален из очереди, очищаем его состояние
            socket.data.partnerSid = undefined;
            socket.data.randomPartnerSid = undefined;
            socket.data.inCall = false;
            await markBusy(io, socket, false);
            await unlockPair(sid);
          }
        }
      }
      
      // 2. Очистка устаревших состояний (баны, блокировки, мертвые пары)
      const staleStates = await queueStore.cleanupStaleStates(isSocketConnected);
      
      if (staleStates.cleanedBans > 0 || staleStates.cleanedLocks > 0 || staleStates.cleanedPairs > 0) {
        logger.info('Cleaned up stale states', {
          bans: staleStates.cleanedBans,
          locks: staleStates.cleanedLocks,
          pairs: staleStates.cleanedPairs
        });
      }
    } catch (e: unknown) {
      logger.error('Queue cleanup error', { error: (e as ErrorDetails)?.message || e });
    }
  }, QUEUE_CLEANUP_INTERVAL_MS);

  logger.info('Queue cleanup started', { 
    intervalMs: QUEUE_CLEANUP_INTERVAL_MS,
    timeoutMs: QUEUE_TIMEOUT_MS
  });
}

/**
 * Остановить периодическую очистку очереди
 */
export function stopQueueCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.info('Queue cleanup stopped');
  }
}
