import type { Server } from 'socket.io';
import type { AuthedSocket } from './types';
import { logger } from '../utils/logger';

// === Очередь ожидания ========================================================
const waitQueue: string[] = []; // очередь socket.id
const lastSearchAt = new Map<string, number>();
const pairLock = new Set<string>();
const recentPartnerBan = new Map<string, { sid: string; until: number }>();

// === Константы ===============================================================
const NEXT_DEBOUNCE_MS = 500;
const REMATCH_BAN_MS = 1000; // Уменьшили с 3000 до 1000 мс

// === Вспомогательные =========================================================
function safeGet(io: Server, sid: string): AuthedSocket | undefined {
  const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
  return s && s.connected ? s : undefined;
}
function removeFromQueue(sid: string) {
  const i = waitQueue.indexOf(sid);
  if (i !== -1) waitQueue.splice(i, 1);
}
function inQueue(sid: string) {
  return waitQueue.includes(sid);
}
function pushToQueue(sid: string) {
  if (!inQueue(sid)) waitQueue.push(sid);
}
function markBusy(io: Server, s: AuthedSocket, busy: boolean) {
  s.data = s.data || {};
  s.data.busy = busy;
  const userId = String(s.data.userId || '');
  if (userId) io.emit('presence:update', { userId, busy });
}
function lockPair(a: AuthedSocket, b: AuthedSocket) {
  pairLock.add(a.id);
  pairLock.add(b.id);
  a.data.inCall = true;
  b.data.inCall = true;
}
function unlockPair(aSid?: string, bSid?: string) {
  if (aSid) pairLock.delete(aSid);
  if (bSid) pairLock.delete(bSid);
}
function bannedTogether(aSid: string, bSid: string) {
  const now = Date.now();
  const aBan = recentPartnerBan.get(aSid);
  const bBan = recentPartnerBan.get(bSid);
  if (aBan && aBan.sid === bSid && aBan.until > now) return true;
  if (bBan && bBan.sid === aSid && bBan.until > now) return true;
  return false;
}
function banPair(aSid: string, bSid: string, ms = REMATCH_BAN_MS) {
  const until = Date.now() + ms;
  recentPartnerBan.set(aSid, { sid: bSid, until });
  recentPartnerBan.set(bSid, { sid: aSid, until });
}
function makeRoomId(aSid: string, bSid: string) {
  const sorted = [aSid, bSid].sort();
  return `room_${sorted[0]}_${sorted[1]}`;
}
function clearPartner(io: Server, me: AuthedSocket, notifyOther: boolean, reason: 'next'|'stop'|'disconnect') {
  const otherSid = me.data.partnerSid as string | undefined;
  if (!otherSid) return;

  const other = safeGet(io, otherSid);
  if (other) {
    other.data.partnerSid = undefined;
    other.data.inCall = false;
    if (notifyOther) {
      if (reason === 'disconnect') other.emit('disconnected');
      else other.emit('peer:stopped');
    }
    markBusy(io, other, false);
    unlockPair(other.id);
  }

  me.data.partnerSid = undefined;
  me.data.inCall = false;
  unlockPair(me.id);
}

// === Матчинг ================================================================
function tryMatch(io: Server, socket: AuthedSocket) {
  logger.debug('Attempting match', { socketId: socket.id, queueSize: waitQueue.length });
  if (socket.data.partnerSid || socket.data.inCall || pairLock.has(socket.id)) {
    logger.debug('Socket already matched/busy', { socketId: socket.id });
    return false;
  }

  const candidateSid = waitQueue.find((sid) => {
    if (sid === socket.id) return false;
    if (pairLock.has(sid)) return false;
    const other = safeGet(io, sid);
    if (!other || other.data.partnerSid) return false;
    
    // Проверяем, что это не один и тот же пользователь (по userId)
    // Это важно, если пользователь подключен с нескольких устройств
    const myUserId = String(socket.data.userId || '');
    const otherUserId = String(other.data.userId || '');
    if (myUserId && otherUserId && myUserId === otherUserId) {
      logger.debug('Skipping self-match by userId', { socketId: socket.id, userId: myUserId, otherSocketId: sid });
      return false;
    }
    
    // Если в очереди только 2 пользователя, разрешаем матч даже если они в бане
    if (waitQueue.length <= 2) {
      logger.debug('Only 2 users in queue, allowing match despite ban');
      return true;
    }
    
    if (bannedTogether(socket.id, other.id)) return false;
    return true;
  });

  if (!candidateSid) {
    logger.debug('No candidate found', { socketId: socket.id });
    return false;
  }

  removeFromQueue(socket.id);
  removeFromQueue(candidateSid);

  const other = safeGet(io, candidateSid);
  if (!other) return false;

  logger.info('Match found', { socket1: socket.id, socket2: other.id });

  socket.data.partnerSid = other.id;
  other.data.partnerSid = socket.id;

  lockPair(socket, other);
  markBusy(io, socket, true);
  markBusy(io, other, true);

  const myUserId = String(socket.data.userId || '');
  const otherUserId = String(other.data.userId || '');

  logger.debug('Sending match_found events', { 
    socket1: socket.id, userId1: myUserId, 
    socket2: other.id, userId2: otherUserId 
  });

  const roomId = makeRoomId(socket.id, other.id);
  io.to(socket.id).emit('match_found', { roomId, id: other.id, userId: otherUserId || null });
  io.to(other.id).emit('match_found', { roomId, id: socket.id, userId: myUserId || null });

  return true;
}

// === Основная логика ========================================================
export function bindMatch(io: Server, socket: AuthedSocket) {

  // === START ================================================================
  socket.on('start', () => {
    if (socket.data.partnerSid) return;
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.data.partnerSid = undefined;
    socket.data.roomId = undefined;
    socket.data.busy = false;
    socket.data.inCall = false;

    markBusy(io, socket, true);
    pushToQueue(socket.id);
    tryMatch(io, socket);
  });

  // === NEXT ================================================================
  socket.on('next', async () => {
    const now = Date.now();
    const last = lastSearchAt.get(socket.id) || 0;
    if (now - last < NEXT_DEBOUNCE_MS) {
      logger.debug('Next request debounced', { socketId: socket.id, debounceMs: now - last });
      return;
    }
    lastSearchAt.set(socket.id, now);

    logger.debug('Next requested', { socketId: socket.id });
    socket.data.isNexting = true;

    // разрываем пару перед очисткой
    const prevPartner = socket.data.partnerSid as string | undefined;
    if (prevPartner) {
      const other = safeGet(io, prevPartner);
      if (other) banPair(socket.id, other.id);
      clearPartner(io, socket, true, 'next');
    }

    // сбрасываем состояние
    removeFromQueue(socket.id);
    socket.rooms.forEach(r => { if (r !== socket.id) socket.leave(r); });
    socket.data.roomId = undefined;
    // КРИТИЧНО: НЕ убираем busy здесь - пользователь продолжает поиск, значит остается busy
    // busy будет установлен в true при добавлении в очередь и попытке матча
    // socket.data.busy = false; // УБРАНО - пользователь остается busy пока ищет
    socket.data.inCall = false;
    
    // КРИТИЧНО: Устанавливаем busy = true сразу, ДО setTimeout
    // чтобы бэйдж "занято" оставался видимым друзьям сразу при автопоиске
    // Пользователь продолжает поиск, значит остается busy
    markBusy(io, socket, true);

    setTimeout(() => {
      pushToQueue(socket.id);
      socket.data.isNexting = false;
      logger.debug('Socket re-added to queue', { socketId: socket.id });
      tryMatch(io, socket);
    }, 400);
  });

  // === STOP ================================================================
  socket.on('stop', () => {
    removeFromQueue(socket.id);
    clearPartner(io, socket, true, 'stop');
    socket.data.inCall = false;
    markBusy(io, socket, false);
  });

  // === DISCONNECT ==========================================================
  socket.on('disconnect', (reason) => {
    logger.debug('Socket disconnected', { socketId: socket.id, reason });

    // Если пользователь нажал "Next" — не удаляем и не трогаем очередь
    if (socket.data?.isNexting) {
      logger.debug('Socket was nexting, skip cleanup', { socketId: socket.id });
      socket.data.isNexting = false;
      return;
    }

    removeFromQueue(socket.id);
    clearPartner(io, socket, true, 'disconnect');
    socket.data.inCall = false;
    markBusy(io, socket, false);
    lastSearchAt.delete(socket.id);
    recentPartnerBan.delete(socket.id);
    unlockPair(socket.id);
  });
}
