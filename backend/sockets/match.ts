import type { Server } from 'socket.io';
import type { AuthedSocket } from './types';
import { logger } from '../utils/logger';
import { createToken, getLiveKitUrl } from '../routes/livekit';
import * as queueStore from '../utils/queueStore';
import User from '../models/User';

// === Очередь ожидания ========================================================
// Используем распределенное хранилище через queueStore
const matchInProgress = new Set<string>(); // Локальный Set для предотвращения одновременных матчей на одном инстансе
const delayedRetryTimers = new Map<string, NodeJS.Timeout>();

// === Константы ===============================================================
const NEXT_DEBOUNCE_MS = 500;
const REMATCH_BAN_MS = 5000; // Увеличили до 5 секунд для предотвращения немедленного рематча
const START_RATE_LIMIT_MS = 2000; // Максимум 1 start в 2 секунды (защита от DDoS)
const MATCH_RATE_LIMIT_MS = 1500; // Максимум 1 попытка матчинга в 1.5 секунды (защита от перегрузки CPU)
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 минут - максимальное время ожидания в очереди
const QUEUE_CLEANUP_INTERVAL_MS = 30 * 1000; // Очистка каждые 30 секунд

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
    
    // Получаем список друзей пользователя
    const user = await User.findById(userId).select('friends').lean();
    if (!user || !Array.isArray(user.friends) || user.friends.length === 0) {
      // Если друзей нет, отправляем только самому пользователю (для синхронизации состояния)
      io.to(`u:${userId}`).emit('presence:update', { userId, busy });
      return;
    }
    
    // Отправляем обновление только друзьям через их комнаты
    const friends = user.friends.map(f => String(f));
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
  if (userId) await emitPresenceUpdateToFriends(io, userId, busy);
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
function makeRoomNameByUserId(aUserId: string, bUserId: string) {
  const sorted = [aUserId, bUserId].sort();
  return `room_${sorted[0]}_${sorted[1]}`;
}
async function clearPartner(io: Server, me: AuthedSocket, notifyOther: boolean, reason: 'next'|'stop'|'disconnect') {
  const otherSid = me.data.partnerSid as string | undefined;
  
  // КРИТИЧНО: Всегда очищаем состояние текущего сокета, даже если партнера нет
  // Это важно для случаев, когда партнер уже отключился или очистил свое состояние
  me.data.partnerSid = undefined;
  me.data.inCall = false;
  await unlockPair(me.id);

  // Если партнер существует, очищаем и его состояние
  if (otherSid) {
    const other = safeGet(io, otherSid);
    if (other) {
      other.data.partnerSid = undefined;
      other.data.inCall = false;
      if (notifyOther) {
        if (reason === 'disconnect') other.emit('disconnected');
        else other.emit('peer:stopped');
      }
      await markBusy(io, other, false);
      await unlockPair(other.id);
    }
  }
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

  const waitQueue = await queueStore.getWaitingQueue();
  let candidateSid: string | undefined;
  
  for (const sid of waitQueue) {
    if (sid === socket.id) continue;
    const isLocked = await queueStore.isLocked(sid);
    if (isLocked) continue;
    const other = safeGet(io, sid);
    if (!other || other.data.partnerSid) continue;
    
    // Проверяем, что это не один и тот же пользователь (по userId)
    // Это важно, если пользователь подключен с нескольких устройств
    const myUserId = String(socket.data.userId || '');
    const otherUserId = String(other.data.userId || '');
    if (myUserId && otherUserId && myUserId === otherUserId) {
      logger.debug('Skipping self-match by userId', { socketId: socket.id, userId: myUserId, otherSocketId: sid });
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
    logger.debug('No candidate found', { socketId: socket.id });
    return false;
  }

  await removeFromQueue(socket.id);
  await removeFromQueue(candidateSid);

  const other = safeGet(io, candidateSid);
  if (!other) return false;

  clearDelayedRetry(socket.id);
  clearDelayedRetry(other.id);

  logger.info('Match found', { socket1: socket.id, socket2: other.id });

  socket.data.partnerSid = other.id;
  other.data.partnerSid = socket.id;

  await lockPair(socket, other);
  await markBusy(io, socket, true);
  await markBusy(io, other, true);

  const myUserId = String(socket.data.userId || '');
  const otherUserId = String(other.data.userId || '');

  logger.debug('Sending match_found events', { 
    socket1: socket.id, userId1: myUserId, 
    socket2: other.id, userId2: otherUserId 
  });

  const roomId = makeRoomId(socket.id, other.id);
  
  // Создаем roomName на основе userId для LiveKit
  let livekitTokenA: string | null = null;
  let livekitTokenB: string | null = null;
  let livekitRoomName: string = roomId;
  const livekitIdentityA = myUserId || `socket:${socket.id}`;
  const livekitIdentityB = otherUserId || `socket:${other.id}`;
  
  if (myUserId && otherUserId) {
    livekitRoomName = makeRoomNameByUserId(myUserId, otherUserId);
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
  });
  io.to(other.id).emit('match_found', { 
    roomId, 
    id: socket.id, 
    userId: myUserId || null,
    livekitToken: livekitTokenB,
    livekitRoomName,
    livekitUrl: getLiveKitUrl() || null,
  });

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

  // === START ================================================================
  socket.on('start', async () => {
    // Rate limiting: защита от DDoS через множественные start запросы
    const now = Date.now();
    const lastStart = await queueStore.getLastStart(socket.id) || 0;
    if (now - lastStart < START_RATE_LIMIT_MS) {
      logger.debug('Start request rate limited', { 
        socketId: socket.id, 
        timeSinceLastStart: now - lastStart,
        rateLimitMs: START_RATE_LIMIT_MS
      });
      return;
    }
    await queueStore.setLastStart(socket.id, now);

    // Если уже есть партнер и он существует — не ломаем активную сессию.
    const existingPartnerSid = socket.data.partnerSid as string | undefined;
    if (existingPartnerSid) {
      const partner = safeGet(io, existingPartnerSid);
      if (partner) {
        logger.debug('Start ignored: socket already has partner', { socketId: socket.id, partnerSid: existingPartnerSid });
        return;
      }
      // Партнер "пропал" — очищаем stale состояние.
      logger.warn('Start requested but stale partnerSid found, cleaning up', { socketId: socket.id, partnerSid: existingPartnerSid });
      socket.data.partnerSid = undefined;
      socket.data.inCall = false;
      await unlockPair(socket.id);
    }

    // Если сокет уже залочен/в колле — не добавляем в очередь повторно.
    const isLocked = await queueStore.isLocked(socket.id);
    if (isLocked || socket.data.inCall) {
      logger.debug('Start ignored: socket is busy', { socketId: socket.id, inCall: !!socket.data.inCall, inPairLock: isLocked });
      return;
    }
    
    // КРИТИЧНО: Всегда очищаем состояние перед добавлением в очередь
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.data.partnerSid = undefined;
    socket.data.roomId = undefined;
    socket.data.busy = false;
    socket.data.inCall = false;
    await unlockPair(socket.id);

    await markBusy(io, socket, true);
    await pushToQueue(socket.id);
    // КРИТИЧНО: Вызываем tryMatch немедленно, без задержек
    // Это гарантирует быстрое нахождение собеседника
    runTryMatch(socket);
  });

  // === NEXT ================================================================
  socket.on('next', async () => {
    const now = Date.now();
    const last = await queueStore.getLastSearch(socket.id) || 0;
    if (now - last < NEXT_DEBOUNCE_MS) {
      logger.debug('Next request debounced', { socketId: socket.id, debounceMs: now - last });
      return;
    }
    await queueStore.setLastSearch(socket.id, now);

    logger.debug('Next requested', { socketId: socket.id });
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
        other.data.inCall = false;
        await unlockPair(other.id);
        // КРИТИЧНО: Удаляем партнера из очереди и очищаем комнаты
        await removeFromQueue(other.id);
        other.rooms.forEach(r => { if (r !== other.id) other.leave(r); });
        other.data.roomId = undefined;
        // ЧАТРУЛЕТКА: Отправляем peer:left партнеру (он нажал "Далее", значит партнер должен начать новый поиск)
        other.emit('peer:left');
        // КРИТИЧНО: Автоматически возвращаем партнера в очередь для нового поиска
        await markBusy(io, other, true);
        // Одинаковая задержка для обоих (250ms), чтобы tryMatch не сматчил одного с третьим пока второй ещё не в очереди
        const reEnqueueDelayMs = 250;
        setTimeout(async () => {
          other.data.partnerSid = undefined;
          other.data.inCall = false;
          await unlockPair(other.id);
          await pushToQueue(other.id);
          logger.debug('Partner re-added to queue after next', { socketId: other.id });
          runTryMatch(other);
          scheduleDelayedRetry(io, other.id, REMATCH_BAN_MS + 250, 'next_rematch_window');
        }, reEnqueueDelayMs);
      }
    }

    // 2. Полностью очищаем состояние текущего сокета
    await removeFromQueue(socket.id);
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.data.roomId = undefined;
    socket.data.partnerSid = undefined;
    socket.data.inCall = false;
    await unlockPair(socket.id);
    
    // 3. Устанавливаем busy (пользователь продолжает поиск)
    await markBusy(io, socket, true);

    // 4. Та же задержка 250ms — оба в очереди одновременно, меньше гонок при tryMatch
    const reEnqueueDelayMs = 250;
    setTimeout(async () => {
      socket.data.partnerSid = undefined;
      socket.data.inCall = false;
      await unlockPair(socket.id);
      socket.data.isNexting = false;
      await pushToQueue(socket.id);
      logger.debug('Socket re-added to queue', { socketId: socket.id });
      runTryMatch(socket);
      scheduleDelayedRetry(io, socket.id, REMATCH_BAN_MS + 250, 'next_rematch_window');
    }, reEnqueueDelayMs);
  });

  // === MODERATION: report partner for violation (e.g. showed weapon) =======
  socket.on('moderation:reportPartner', async ({ partnerUserId }: { partnerUserId?: string }) => {
    const reporterId = (socket as any)?.data?.userId;
    const reported = String(partnerUserId || '').trim();
    if (!reported) return;
    logger.info('[Moderation] partner reported for violation', {
      reporterUserId: reporterId,
      reportedUserId: reported,
      reporterSocketId: socket.id,
    });
    // TODO: добавить бан reportedUserId в random chat (отдельное хранилище)
  });

  // === STOP ================================================================
  socket.on('stop', async () => {
    clearDelayedRetry(socket.id);
    await removeFromQueue(socket.id);
    // Ban pair to prevent immediate rematch (same race as "Next" — device may still be reconnecting)
    const partnerSid = socket.data.partnerSid as string | undefined;
    if (partnerSid) {
      await banPair(socket.id, partnerSid);
    }
    await clearPartner(io, socket, true, 'stop');
    socket.data.inCall = false;
    await markBusy(io, socket, false);
  });

  // === DISCONNECT ==========================================================
  socket.on('disconnect', async (reason) => {
    logger.debug('Socket disconnected', { socketId: socket.id, reason });
    clearDelayedRetry(socket.id);

    // Если пользователь нажал "Next" — не удаляем и не трогаем очередь
    if (socket.data?.isNexting) {
      logger.debug('Socket was nexting, skip cleanup', { socketId: socket.id });
      socket.data.isNexting = false;
      return;
    }

    await queueStore.clearSocketData(socket.id);
    await clearPartner(io, socket, true, 'disconnect');
    socket.data.inCall = false;
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
