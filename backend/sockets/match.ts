import type { Server } from 'socket.io';
import type { AuthedSocket } from './types';
import { logger } from '../utils/logger';
import { isShuttingDown } from '../utils/shutdownState';
import { createToken, getLiveKitUrl } from '../routes/livekit';
import * as queueStore from '../utils/queueStore';
import { getFriendIds } from '../utils/friendshipUtils';
import { scheduleGlobalFriendPresenceEmit } from '../utils/friendOnlinePresence';
import { checkRateLimit } from '../utils/rateLimit';
import UserReportModel, { isUserReportReason } from '../models/UserReport';

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
export const MODERATION_FIRST_WARNING_TEXT =
  'Уважаемый пользователь, вы нарушаете правила приложения, при продолжении данных действий вы будете забанены на один час.';

// === Очередь ожидания ========================================================
// Используем распределенное хранилище через queueStore
const matchInProgress = new Set<string>(); // Локальный Set для предотвращения одновременных матчей на одном инстансе
const delayedRetryTimers = new Map<string, NodeJS.Timeout>();

/**
 * Рандом-пары, где у одного собеседника оборвался сокет (моргнула сеть, VPN, лифт).
 * Ключ — userId пропавшего. Пока идёт пауза (reconnectGraceMs), собеседник не уходит в поиск, а новый сокет
 * того же пользователя возвращается в пару через random:resume. Держим в памяти процесса,
 * как и остальной матчинг (safeGet, matchInProgress): бэкенд работает одним инстансом.
 */
type HeldPair = {
  oldSocket: AuthedSocket;
  partnerSid: string;
  partnerUserId: string;
  timer: NodeJS.Timeout;
};
const heldPairs = new Map<string, HeldPair>();

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
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 10_000;
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
function scheduleDelayedRetry(io: Server, sid: string, delayMs: number, reason: string) {
  const id = String(sid);
  clearDelayedRetry(id);
  const timer = setTimeout(() => {
    delayedRetryTimers.delete(id);
    const target = safeGet(io, id);
    if (!target) return;
    if (target.data.partnerSid || target.data.inCall) return;
    if (matchInProgress.has(id)) return;
    matchInProgress.add(id);
    logger.debug('Running delayed match retry', { socketId: id, reason, delayMs });
    void tryMatch(io, target)
      .catch((e: any) => {
        logger.error('Delayed tryMatch failed', { socketId: id, reason, error: e?.message || e });
      })
      .finally(() => {
        matchInProgress.delete(id);
      });
  }, delayMs);
  delayedRetryTimers.set(id, timer);
}
async function removeFromQueue(sid: string) {
  await queueStore.removeFromQueue(sid);
}
async function inQueue(sid: string) {
  return await queueStore.isInQueue(sid);
}
async function pushToQueue(sid: string) {
  await queueStore.addToQueue(sid);
}
/**
 * Оптимизированная отправка presence:update только друзьям пользователя
 * Вместо отправки всем подключенным (io.emit), отправляем только заинтересованным
 */
async function emitPresenceUpdateToFriends(io: Server, userId: string, busy: boolean) {
  try {
    if (!userId) return;
    
    const friends = await getFriendIds(userId);
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
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
    } catch {}
  }
}

async function markBusy(io: Server, s: AuthedSocket, busy: boolean) {
  s.data = s.data || {};
  s.data.busy = busy;
  const userId = String(s.data.userId || '');
  if (userId) {
    await emitPresenceUpdateToFriends(io, userId, busy);
    scheduleGlobalFriendPresenceEmit(io, userId);
  }
}
async function lockPair(a: AuthedSocket, b: AuthedSocket) {
  await Promise.all([
    queueStore.lockSocket(a.id),
    queueStore.lockSocket(b.id),
  ]);
  a.data.inCall = true;
  b.data.inCall = true;
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
    if (r !== s.id && !r.startsWith('u:')) s.leave(r);
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
  
  // КРИТИЧНО: Всегда очищаем состояние текущего сокета, даже если партнера нет
  // Это важно для случаев, когда партнер уже отключился или очистил свое состояние
  me.data.partnerSid = undefined;
  me.data.randomPartnerSid = undefined;
  me.data.inCall = false;
  me.data.roomId = undefined;
  await unlockPair(me.id);

  // Если партнер существует, очищаем и его состояние
  if (otherSid) {
    const other = safeGet(io, otherSid);
    if (other) {
      other.data.partnerSid = undefined;
      other.data.randomPartnerSid = undefined;
      other.data.inCall = false;
      other.data.roomId = undefined;
      if (notifyOther) {
        if (reason === 'disconnect') other.emit('disconnected', signalData);
        else other.emit('peer:stopped', signalData);
      }
      await markBusy(io, other, false);
      await unlockPair(other.id);
    }
  }
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
  heldPairs.set(userId, { oldSocket: s, partnerSid, partnerUserId, timer });

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
  const userId = String(held.oldSocket.data.userId || '').trim();
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
    await markBusy(io, held.oldSocket, false);
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
  // Rate limiting: проверяем, не слишком ли часто происходят попытки матчинга
  const now = Date.now();
  const lastAttempt = await queueStore.getLastMatchAttempt(socket.id) || 0;
  if (now - lastAttempt < MATCH_RATE_LIMIT_MS) {
    logger.debug('Match attempt rate limited', { 
      socketId: socket.id, 
      timeSinceLastAttempt: now - lastAttempt,
      rateLimitMs: MATCH_RATE_LIMIT_MS
    });
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
  let cleanedSkipped = 0;
  
  for (const sid of waitQueue) {
    if (sid === socket.id) continue;
    const isLocked = await queueStore.isLocked(sid);
    if (isLocked) continue;
    const other = safeGet(io, sid);
    if (!other || other.data.partnerSid || other.data.inCall) {
      await removeFromQueue(sid);
      cleanedSkipped++;
      continue;
    }
    
    // Проверяем, что это не один и тот же пользователь (по userId)
    const myUserId = String(socket.data.userId || '');
    const otherUserId = String(other.data.userId || '');
    if (myUserId && otherUserId && myUserId === otherUserId) {
      logger.debug('Skipping self-match by userId', { socketId: socket.id, userId: myUserId, otherSocketId: sid });
      continue;
    }
    // Пропускаем пользователей, забаненных модерацией (нарушение правил)
    if (otherUserId && (await queueStore.isModerationBanned(otherUserId))) {
      logger.debug('Skipping moderation-banned user', { socketId: socket.id, otherUserId, otherSocketId: sid });
      await removeFromQueue(sid);
      cleanedSkipped++;
      continue;
    }
    // Один пожаловался на другого — эту пару больше не сводим.
    if (
      myUserId &&
      otherUserId &&
      (await queueStore.isBannedTogether(reportPairKey(myUserId), reportPairKey(otherUserId)))
    ) {
      continue;
    }
    
    // КРИТИЧНО: Друзья могут попадаться в рандомном чате - это нормально и не блокирует работу
    // Проверка на дружбу НЕ выполняется здесь, так как друзья имеют право общаться в рандомном чате
    
    // Проверяем бан перед проверкой размера очереди
    const isBanned = await bannedTogether(socket.id, other.id);
    
    // Даже если в очереди осталось только 2 пользователя, соблюдаем rematch-ban.
    // Иначе после нажатия "Далее" сервер мгновенно сводит ту же пару обратно,
    // и клиент выглядит так, будто новый поиск у одного пользователя не начался.
    if (queueSize <= 2) {
      if (isBanned) {
        logger.debug('Only 2 users in queue, rematch ban still active', {
          socketId: socket.id,
          otherId: other.id,
          waitQueueSize: queueSize
        });
        continue;
      }
      logger.debug('Only 2 users in queue, allowing match');
      candidateSid = sid;
      break;
    }
    
    // Если в очереди больше 2 пользователей, проверяем бан
    if (isBanned) continue;
    candidateSid = sid;
    break;
  }

  if (!candidateSid) {
    logger.debug('No candidate found', {
      socketId: socket.id,
      queueSize,
      scanned: waitQueue.length,
      scanLimit: MATCH_CANDIDATE_SCAN_LIMIT,
      cleanedSkipped,
    });
    return false;
  }

  await removeFromQueue(socket.id);
  await removeFromQueue(candidateSid);

  const other = safeGet(io, candidateSid);
  if (!other) return false;

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

  await lockPair(socket, other);
  await markBusy(io, socket, true);
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
    const [tokenA, tokenB] = await Promise.all([
      createToken({ identity: livekitIdentityA, roomName: livekitRoomName }),
      createToken({ identity: livekitIdentityB, roomName: livekitRoomName }),
    ]);
    livekitTokenA = tokenA;
    livekitTokenB = tokenB;
    logger.debug('LiveKit tokens created', { roomName: livekitRoomName, identityA: livekitIdentityA, identityB: livekitIdentityB });
  } catch (e: any) {
    logger.error('Failed to create LiveKit tokens:', e);
  }
  
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
  const runTryMatch = (target: AuthedSocket) => {
    if (matchInProgress.has(target.id)) return;
    matchInProgress.add(target.id);
    void tryMatch(io, target)
      .catch((e: any) => {
        logger.error('tryMatch failed', { socketId: target.id, error: e?.message || e });
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
  socket.on('start', async (data?: { transitionId?: string }) => {
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
    if (isLocked || socket.data.inCall) {
      logger.debug('Start ignored: socket is busy', {
        socketId: socket.id,
        inCall: !!socket.data.inCall,
        inPairLock: isLocked,
        transitionId,
      });
      return;
    }
    
    // КРИТИЧНО: Всегда очищаем состояние перед добавлением в очередь
    leaveCallRooms(socket);
    socket.data.partnerSid = undefined;
    socket.data.randomPartnerSid = undefined;
    socket.data.roomId = undefined;
    socket.data.busy = false;
    socket.data.inCall = false;
    socket.data.lastNextTransitionId = transitionId;
    await unlockPair(socket.id);

    logger.debug('Start requested', { socketId: socket.id, transitionId });
    await markBusy(io, socket, true);
    await pushToQueue(socket.id);
    // КРИТИЧНО: Вызываем tryMatch немедленно, без задержек
    // Это гарантирует быстрое нахождение собеседника
    runTryMatch(socket);
  });

  // === NEXT ================================================================
  socket.on('next', async (data?: { transitionId?: string }) => {
    const transitionId =
      data && typeof data.transitionId === 'string' && data.transitionId.trim().length > 0
        ? data.transitionId.trim()
        : undefined;
    const now = Date.now();
    const last = await queueStore.getLastSearch(socket.id) || 0;
    if (now - last < NEXT_DEBOUNCE_MS) {
      logger.debug('Next request debounced', { socketId: socket.id, debounceMs: now - last, transitionId });
      return;
    }
    await queueStore.setLastSearch(socket.id, now);

    socket.data.lastNextTransitionId = transitionId;
    logger.debug('Next requested', { socketId: socket.id, transitionId });
    socket.data.isNexting = true;

    // ПРОСТАЯ ЛОГИКА: Полностью очищаем все состояние синхронно
    // 1. Разрываем пару с предыдущим партнером
    const prevPartner = socket.data.partnerSid as string | undefined;
    if (prevPartner) {
      const other = safeGet(io, prevPartner);
      if (other) {
        await banPair(socket.id, other.id);
        // КРИТИЧНО: Полностью очищаем состояние партнера
        other.data.partnerSid = undefined;
        other.data.randomPartnerSid = undefined;
        other.data.inCall = false;
        await unlockPair(other.id);
        // КРИТИЧНО: Удаляем партнера из очереди и очищаем комнаты
        await removeFromQueue(other.id);
        leaveCallRooms(other);
        other.data.roomId = undefined;

        const otherUserId = String(other.data.userId || '').trim();
        const otherModBanned =
          !!otherUserId && (await queueStore.isModerationBanned(otherUserId));
        if (otherModBanned) {
          // После модерации не возвращаем в поиск и не вешаем busy друзьям.
          clearDelayedRetry(other.id);
          await markBusy(io, other, false);
          logger.debug('Skip partner requeue after next: moderation-banned', {
            socketId: other.id,
            otherUserId,
            triggeredByTransitionId: transitionId,
          });
        } else {
          // ЧАТРУЛЕТКА: Отправляем peer:left партнеру (он нажал "Далее", значит партнер должен начать новый поиск)
          other.emit('peer:left', { nextTransitionId: transitionId ?? null });
          // КРИТИЧНО: Автоматически возвращаем партнера в очередь для нового поиска
          await markBusy(io, other, true);
          // Одинаковая задержка для обоих (250ms), чтобы tryMatch не сматчил одного с третьим пока второй ещё не в очереди
          const reEnqueueDelayMs = 250;
          setTimeout(async () => {
            const currentOther = safeGet(io, other.id);
            if (!currentOther) {
              await queueStore.clearSocketData(other.id);
              logger.debug('Skip partner requeue after next: socket disconnected', {
                socketId: other.id,
                triggeredByTransitionId: transitionId,
              });
              return;
            }
            const uid = String(currentOther.data.userId || '').trim();
            if (uid && (await queueStore.isModerationBanned(uid))) {
              clearDelayedRetry(currentOther.id);
              await markBusy(io, currentOther, false);
              logger.debug('Skip partner requeue after next delay: moderation-banned', {
                socketId: currentOther.id,
                otherUserId: uid,
                triggeredByTransitionId: transitionId,
              });
              return;
            }
            currentOther.data.partnerSid = undefined;
            currentOther.data.randomPartnerSid = undefined;
            currentOther.data.inCall = false;
            await unlockPair(currentOther.id);
            await pushToQueue(currentOther.id);
            logger.debug('Partner re-added to queue after next', {
              socketId: currentOther.id,
              triggeredByTransitionId: transitionId,
            });
            runTryMatch(currentOther);
            scheduleDelayedRetry(io, currentOther.id, REMATCH_BAN_MS + 250, 'next_rematch_window');
          }, reEnqueueDelayMs);
        }
      }
    }

    // 2. Полностью очищаем состояние текущего сокета
    await removeFromQueue(socket.id);
    leaveCallRooms(socket);
    socket.data.roomId = undefined;
    socket.data.partnerSid = undefined;
    socket.data.randomPartnerSid = undefined;
    socket.data.inCall = false;
    await unlockPair(socket.id);
    
    // 3. Устанавливаем busy (пользователь продолжает поиск)
    await markBusy(io, socket, true);

    // 4. Та же задержка 250ms — оба в очереди одновременно, меньше гонок при tryMatch
    const reEnqueueDelayMs = 250;
    setTimeout(async () => {
      const currentSocket = safeGet(io, socket.id);
      if (!currentSocket) {
        await queueStore.clearSocketData(socket.id);
        logger.debug('Skip socket requeue after next: socket disconnected', { socketId: socket.id, transitionId });
        return;
      }
      currentSocket.data.partnerSid = undefined;
      currentSocket.data.randomPartnerSid = undefined;
      currentSocket.data.inCall = false;
      await unlockPair(currentSocket.id);
      currentSocket.data.isNexting = false;
      await pushToQueue(currentSocket.id);
      logger.debug('Socket re-added to queue', { socketId: currentSocket.id, transitionId });
      runTryMatch(currentSocket);
      scheduleDelayedRetry(io, currentSocket.id, REMATCH_BAN_MS + 250, 'next_rematch_window');
    }, reEnqueueDelayMs);
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
  socket.on(
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
      const actualPartnerUserId = String((partner as any)?.data?.userId || '').trim();
      if (!actualPartnerUserId) {
        done({ ok: false, reason: 'partner_user_unknown' });
        return;
      }
      if (reported !== actualPartnerUserId) {
        logger.warn('[Moderation] Reject reportPartner due to mismatched partnerUserId', {
          reporterSocketId: socket.id,
          reporterUserId: (socket as any)?.data?.userId,
          providedPartnerUserId: reported,
          actualPartnerUserId,
          partnerSocketId: partnerSid,
        });
        done({ ok: false, reason: 'partner_mismatch' });
        return;
      }

      const reporterId = (socket as any)?.data?.userId;
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
        const reporterId = String((socket as any)?.data?.userId || '').trim();
        const reported = String(partnerUserId || '').trim();
        if (!reporterId) return done({ ok: false, reason: 'unauthorized' });
        if (!reported) return done({ ok: false, reason: 'no_partner_user_id' });
        if (!isUserReportReason(reason)) return done({ ok: false, reason: 'invalid_reason' });

        const rl = await checkRateLimit(`user_report:${reporterId}`, REPORT_RATE_LIMIT_MAX, REPORT_RATE_LIMIT_WINDOW_MS);
        if (!rl.ok) return done({ ok: false, reason: 'rate_limited' });

        // Жаловаться можно только на текущего собеседника этой пары.
        const partnerSid = socket.data.partnerSid as string | undefined;
        const partner = partnerSid ? safeGet(io, partnerSid) : undefined;
        const actualPartnerUserId = String((partner as any)?.data?.userId || '').trim();
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
      } catch (e: any) {
        logger.warn('[Report] user:reportPartner failed', { error: e?.message || String(e) });
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

        // Сокет не рвался, сдался только LiveKit: пара цела — нужен лишь свежий токен в ту же комнату.
        const currentPartner =
          socket.data.partnerSid && socket.data.randomPartnerSid === socket.data.partnerSid
            ? safeGet(io, socket.data.partnerSid)
            : undefined;
        if (currentPartner && currentPartner.data.partnerSid === socket.id) {
          const currentPartnerUserId = String(currentPartner.data.userId || '').trim();
          if (currentPartnerUserId !== expectedPartnerUserId) {
            return done({ ok: false, reason: 'partner_mismatch' });
          }
          const roomName = makeRandomMatchLiveKitRoomName(userId, currentPartnerUserId);
          let token: string | null = null;
          try {
            token = await createToken({ identity: userId, roomName });
          } catch (e: any) {
            logger.error('[Match] resume: failed to create LiveKit token', { error: e?.message || String(e) });
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
        // Старый сокет отпускаем: его поздний disconnect не должен разорвать пару.
        oldSocket.data.resumedBy = socket.id;
        oldSocket.data.partnerSid = undefined;
        oldSocket.data.randomPartnerSid = undefined;
        oldSocket.data.inCall = false;
        await unlockPair(oldSocket.id);

        clearDelayedRetry(socket.id);
        await removeFromQueue(socket.id);
        socket.data.partnerSid = partner.id;
        socket.data.randomPartnerSid = partner.id;
        partner.data.partnerSid = socket.id;
        partner.data.randomPartnerSid = socket.id;
        await lockPair(socket, partner);
        await markBusy(io, socket, true);

        // Свежий токен — если LiveKit у вернувшегося успел сдаться, он зайдёт в ту же комнату.
        const livekitRoomName = makeRandomMatchLiveKitRoomName(userId, partnerUserId);
        let livekitToken: string | null = null;
        try {
          livekitToken = await createToken({ identity: userId, roomName: livekitRoomName });
        } catch (e: any) {
          logger.error('[Match] resume: failed to create LiveKit token', { error: e?.message || String(e) });
        }

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
      } catch (e: any) {
        logger.warn('[Match] random:resume failed', { error: e?.message || String(e) });
        done({ ok: false, reason: 'server_error' });
      }
    },
  );

  // === STOP ================================================================
  socket.on('stop', async () => {
    clearDelayedRetry(socket.id);
    await removeFromQueue(socket.id);
    const stopUserId = String(socket.data.userId || '').trim();
    if (stopUserId) await releaseHeldPairOf(io, stopUserId);
    // Ban pair to prevent immediate rematch (same race as "Next" — device may still be reconnecting)
    const partnerSid = socket.data.partnerSid as string | undefined;
    if (partnerSid) {
      await banPair(socket.id, partnerSid);
    }
    await clearPartner(io, socket, true, 'stop', {
      nextTransitionId: socket.data.lastNextTransitionId ?? null,
    });
    socket.data.inCall = false;
    socket.data.lastNextTransitionId = undefined;
    await markBusy(io, socket, false);
  });

  // === DISCONNECT ==========================================================
  socket.on('disconnect', async (reason) => {
    logger.debug('Socket disconnected', { socketId: socket.id, reason });
    clearDelayedRetry(socket.id);

    if (isShuttingDown()) {
      try {
        await removeFromQueue(socket.id);
        await queueStore.clearSocketData(socket.id);
      } catch {}
      socket.data.isNexting = false;
      await clearPartner(io, socket, false, 'disconnect', {
        nextTransitionId: socket.data.lastNextTransitionId ?? null,
      });
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
    // (клиент или сервер закрыл сокет сам) — не обрыв, ждать нечего.
    const deliberate = reason === 'client namespace disconnect' || reason === 'server namespace disconnect';
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
    } catch (e: any) {
      logger.error('Queue cleanup error', { error: e?.message || e });
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
