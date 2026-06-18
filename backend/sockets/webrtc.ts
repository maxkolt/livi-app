// backend/sockets/webrtc.ts
import type { Server } from "socket.io";
import type { AuthedSocket } from "./types";
import { logger } from '../utils/logger';
import { isShuttingDown } from '../utils/shutdownState';
import { getFriendIds } from '../utils/friendshipUtils';
import {
  evictExtraUserSocketsInDirectRoom,
  parseDirectCallRoomParticipants,
  sanitizeDirectCallSocketIoRoom,
} from "./directCallRoom";
import { scheduleGlobalFriendPresenceEmit } from "../utils/friendOnlinePresence";

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

/**
 * Подключает обработчики для LiveKit (сигналинг больше не нужен - LiveKit сам управляет)
 * Оставлены только вспомогательные события: room:join, connection:established, cam-toggle, PiP
 */
export function bindWebRTC(io: Server, socket: AuthedSocket) {
  /** =========================
   *  Room join
   *  ========================= */
  socket.on("room:join:ack", ({ roomId }: { roomId: string }) => {
    if (!roomId) return;

    const myUserId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : '';
    if (myUserId) {
      evictExtraUserSocketsInDirectRoom(io, roomId, myUserId, socket.id);
    }
    if (parseDirectCallRoomParticipants(roomId)) {
      try {
        sanitizeDirectCallSocketIoRoom(io, roomId);
      } catch {}
    }
    
    // Проверяем что пользователь еще не в этой комнате
    if (socket.rooms.has(roomId)) {
      logger.debug('Socket already in room', { socketId: socket.id, roomId });
      return;
    }
    
    // Получаем существующих участников комнаты ДО добавления нового
    const room = io.sockets.adapter.rooms.get(roomId);
    const existingPeers: Array<{ peerId: string; userId?: string }> = [];
    if (room) {
      room.forEach(socketId => {
        if (socketId !== socket.id) {
          const peerSocket = io.sockets.sockets.get(socketId) as AuthedSocket;
          const userId = (peerSocket as any)?.data?.userId ? String((peerSocket as any).data.userId) : undefined;
          existingPeers.push({ peerId: socketId, userId });
        }
      });
    }
    
    logger.debug('Room join', { roomId, existingPeers: existingPeers.length });
    
    const pair = parseDirectCallRoomParticipants(roomId);
    if (pair && myUserId) {
      if (myUserId !== pair.a && myUserId !== pair.b) {
        logger.warn('room:join:ack: user not in room pair', { roomId, myUserId });
        socket.emit("call:busy", { callId: roomId, reason: 'not_participant' });
        return;
      }
      const otherUserIds = new Set<string>();
      for (const p of existingPeers) {
        if (p.userId) otherUserIds.add(p.userId);
      }
      if (!otherUserIds.has(myUserId) && otherUserIds.size >= 2) {
        logger.warn('Room is full (two other users already)', { roomId });
        socket.emit("call:busy", { callId: roomId, reason: 'room_full' });
        return;
      }
    } else if (existingPeers.length >= 2) {
      // Рандом / fallback: не больше двух других сокетов
      logger.warn('Room is full, rejecting join', { roomId });
      socket.emit("call:busy", { 
        callId: roomId, 
        reason: 'room_full' 
      });
      return;
    }
    
    // Добавляем сокет в комнату
    socket.join(roomId);
    const userId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : undefined;
    logger.info(`[room:join] User joined room ${roomId}`, { 
      socketId: socket.id, 
      userId, 
      roomId, 
      existingPeers: existingPeers.length 
    });
    
    // Отправляем новому участнику peer ID собеседника (максимум 1)
    if (existingPeers.length === 1) {
      const peer = existingPeers[0];
      socket.emit("peer:connected", { 
        peerId: peer.peerId, 
        userId: peer.userId 
      });
    }
    
    // Уведомляем собеседника о подключении нового
    const newUserId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : undefined;
    socket.to(roomId).emit("peer:connected", { 
      peerId: socket.id, 
      userId: newUserId 
    });
    
    logger.debug('Room setup complete', { roomId, participants: existingPeers.length + 1 });
  });

  /** =========================
   *  Connection established (для установки busy при активном соединении)
   *  ========================= */
  socket.on("connection:established", async ({ roomId }: { roomId?: string }) => {
    logger.debug('LiveKit connection established', { socketId: socket.id, roomId });
    
    // Устанавливаем busy флаг для текущего пользователя
    (socket as any).data = (socket as any).data || {};
    (socket as any).data.busy = true;
    
    const myUserId = (socket as any)?.data?.userId;
    if (myUserId) {
      await emitPresenceUpdateToFriends(io, myUserId, true);
      scheduleGlobalFriendPresenceEmit(io, String(myUserId));
      logger.debug('Set busy for user', { userId: myUserId });
    }
  });

  /** =========================
   *  Camera toggle forwarding
   *  ========================= */
  socket.on("cam-toggle", (data: { enabled: boolean; from: string; to?: string; roomId?: string; camSide?: 'front' | 'back'; sideOnly?: boolean }) => {
    const { enabled, from, to, roomId, camSide, sideOnly } = data;
    const relayPayload = {
      enabled,
      from,
      roomId,
      camSide,
      ...(sideOnly === true ? { sideOnly: true as const } : {}),
    };
    
    // Пересылаем событие всем в комнатах, где находится этот сокет
    let forwardedViaRoom = false;
    // Prefer explicit roomId if provided (RandomChat can have LiveKit roomName != socket pairing roomId,
    // so the client relies on the socket pairing roomId from match_found).
    if (roomId && roomId.startsWith("room_")) {
      // Only treat as "forwarded via room" if the room actually exists in the adapter.
      // In RandomChat we may NOT join sockets to that roomId, so room-broadcast would be a no-op.
      const room = (io.sockets.adapter.rooms as any)?.get?.(roomId) as Set<string> | undefined;
      if (room && room.size > 0) {
        socket.to(roomId).emit("cam-toggle", { ...relayPayload, roomId });
        if (!enabled) logger.debug('Camera toggle forwarded to room (explicit)', { roomId, roomSize: room.size });
        forwardedViaRoom = true;
      } else {
        logger.debug('cam-toggle: roomId provided but room has no members; will fallback to partnerSid', { roomId });
      }
    } else {
      socket.rooms.forEach((currentRoomId) => {
        if (currentRoomId.startsWith("room_")) {
          // КРИТИЧНО: Передаем roomId при пересылке для правильной обработки на клиенте
          socket.to(currentRoomId).emit("cam-toggle", { ...relayPayload, roomId: currentRoomId });
          if (!enabled) logger.debug('Camera toggle forwarded to room', { roomId: currentRoomId });
          forwardedViaRoom = true;
        }
      });
    }
    
    // Для обратной совместимости пересылаем событие напрямую по socket.id
    // ТОЛЬКО если пересылка через комнату не сработала (чтобы избежать дубликатов).
    const socketData = (socket as any).data;
    
    if (!forwardedViaRoom && socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        // Include roomId if provided to let the client filter stale events.
        partnerSocket.emit("cam-toggle", {
          enabled,
          from,
          to: partnerSocket.id,
          camSide,
          ...(roomId ? { roomId } : {}),
          ...(sideOnly === true ? { sideOnly: true as const } : {}),
        });
        if (!enabled) logger.debug('Camera toggle forwarded to partner', { partnerId: socketData.partnerSid });
      }
    }
  });

  /** =========================
   *  PiP events forwarding
   *  ========================= */
  socket.on("pip:entered", (data: { callId?: string; partnerId?: string }) => {
    logger.debug('PiP entered', { socketId: socket.id, data });
    
    // Пересылаем событие всем в комнатах, где находится этот сокет
    socket.rooms.forEach((roomId) => {
      if (roomId.startsWith("room_")) {
        const fromUserId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : undefined;
        socket.to(roomId).emit("pip:entered", { 
          ...data, 
          from: socket.id, 
          fromUserId 
        });
        logger.debug('PiP entered forwarded to room', { roomId });
      }
    });
  });

  socket.on("pip:exited", (data: { callId?: string; partnerId?: string }) => {
    logger.debug('PiP exited', { socketId: socket.id, data });
    
    // Пересылаем событие всем в комнатах, где находится этот сокет
    socket.rooms.forEach((roomId) => {
      if (roomId.startsWith("room_")) {
        const fromUserId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : undefined;
        socket.to(roomId).emit("pip:exited", { 
          ...data, 
          from: socket.id, 
          fromUserId 
        });
        logger.debug('PiP exited forwarded to room', { roomId });
      }
    });
  });

  socket.on("pip:state", (data: { inPiP: boolean; roomId: string; from: string }) => {
    const { inPiP, roomId, from } = data;
    
    // Пересылаем событие партнеру в комнате
    let forwardedViaRoom = false;
    if (roomId && roomId.startsWith("room_")) {
      socket.to(roomId).emit("pip:state", { 
        inPiP, 
        roomId, 
        from: socket.id 
      });
      logger.debug('PiP state forwarded to room', { roomId, inPiP });
      forwardedViaRoom = true;
    }
    
    // Также пересылаем через partnerSid для обратной совместимости
    const socketData = (socket as any).data;
    if (!forwardedViaRoom && socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        partnerSocket.emit("pip:state", { inPiP, roomId, from: socket.id });
        logger.debug('PiP state forwarded to partner', { partnerId: socketData.partnerSid, inPiP });
      }
    }
  });

  /** Direct call: партнёр на экране видеозвонка или вернулся на аудио (не зависит от mute камеры). */
  socket.on(
    "direct-call:video-ui",
    (data: { inVideoCallUi: boolean; from: string; roomId?: string }) => {
      const { inVideoCallUi, roomId } = data;
      const payload = (resolvedRoomId: string) => ({
        inVideoCallUi,
        from: socket.id,
        roomId: resolvedRoomId,
      });

      let resolvedRoomId: string | undefined =
        roomId && roomId.startsWith("room_") ? roomId : undefined;

      if (resolvedRoomId) {
        const room = (io.sockets.adapter.rooms as any)?.get?.(resolvedRoomId) as
          | Set<string>
          | undefined;
        if (room && room.size > 1) {
          socket.to(resolvedRoomId).emit("direct-call:video-ui", payload(resolvedRoomId));
          logger.info("direct-call:video-ui forwarded to room", {
            roomId: resolvedRoomId,
            roomSize: room.size,
            inVideoCallUi,
          });
        } else {
          logger.debug("direct-call:video-ui: room missing or only sender; will use partnerSid", {
            roomId: resolvedRoomId,
            roomSize: room?.size ?? 0,
          });
        }
      } else {
        socket.rooms.forEach((currentRoomId) => {
          if (!currentRoomId.startsWith("room_")) return;
          resolvedRoomId = resolvedRoomId || currentRoomId;
          socket.to(currentRoomId).emit("direct-call:video-ui", payload(currentRoomId));
        });
      }

      let forwardedToPartnerSid = false;
      const socketData = (socket as any).data;
      const partnerSid = socketData?.partnerSid as string | undefined;
      if (partnerSid) {
        const partnerSocket = io.sockets.sockets.get(partnerSid);
        if (partnerSocket) {
          const sidRoomId =
            resolvedRoomId ||
            (roomId && roomId.startsWith("room_") ? roomId : undefined) ||
            (socketData?.roomId as string | undefined);
          partnerSocket.emit(
            "direct-call:video-ui",
            sidRoomId ? payload(sidRoomId) : { inVideoCallUi, from: socket.id },
          );
          forwardedToPartnerSid = true;
          logger.info("direct-call:video-ui forwarded to partnerSid", {
            partnerSid,
            inVideoCallUi,
            roomId: sidRoomId ?? roomId,
          });
        }
      }
      if (!forwardedToPartnerSid && resolvedRoomId) {
        logger.debug("direct-call:video-ui: no partnerSid fallback target", {
          roomId: resolvedRoomId,
          inVideoCallUi,
        });
      }
    },
  );

  /** =========================
   *  Room leave
   *  ========================= */
  socket.on("room:leave", async ({ roomId }: { roomId: string }) => {
    if (!roomId) return;
    
    logger.debug('Socket leaving room', { socketId: socket.id, roomId });
    
    // Снимаем флаг busy с уходящего
    const leavingUserId = (socket as any)?.data?.userId;
    (socket as any).data = (socket as any).data || {};
    (socket as any).data.busy = false;
    
    // Получаем оставшихся участников
    const room = io.sockets.adapter.rooms.get(roomId);
    const remainingPeers: string[] = [];
    if (room) {
      room.forEach(socketId => {
        if (socketId !== socket.id) {
          remainingPeers.push(socketId);
        }
      });
    }
    
    // Снимаем busy со всех оставшихся (только друзьям)
    for (const peerId of remainingPeers) {
      const peerSocket = io.sockets.sockets.get(peerId) as AuthedSocket;
      if (peerSocket) {
        (peerSocket as any).data = (peerSocket as any).data || {};
        (peerSocket as any).data.busy = false;
        
        const peerUserId = (peerSocket as any)?.data?.userId;
        if (peerUserId) {
          await emitPresenceUpdateToFriends(io, peerUserId, false);
          scheduleGlobalFriendPresenceEmit(io, String(peerUserId));
        }
      }
    }
    
    // Отправляем presence:update для уходящего (только друзьям)
    if (leavingUserId) {
      await emitPresenceUpdateToFriends(io, leavingUserId, false);
      scheduleGlobalFriendPresenceEmit(io, String(leavingUserId));
    }
    
    socket.leave(roomId);
    
    // Уведомляем оставшегося участника
    if (remainingPeers.length === 1) {
      const remainingId = remainingPeers[0];
      io.to(remainingId).emit("peer:stopped");
      logger.debug('Notified remaining peer', { roomId });
    }
  });

  // Обработчик disconnect вынесен в index.ts: один общий handler вызывает onSocketDisconnectWebRTC и затем unpair/очередь
}

/**
 * Очистка при отключении сокета: уведомление комнат "disconnected".
 * Вызывается из единого обработчика disconnect в index.ts, чтобы не дублировать логику.
 *
 * КРИТИЧНО: Не сбрасываем busy и не рассылаем presence:update(busy: false) при дисконнекте.
 * Иначе при обрыве связи друзья видят пользователя как "не занят" и могут позвонить в активную комнату.
 * busy снимается только при завершении звонка (call:end в index.ts).
 */
export async function onSocketDisconnectWebRTC(io: Server, socket: AuthedSocket): Promise<void> {
  if (isShuttingDown()) return;
  logger.debug('Socket disconnected (webrtc cleanup)', { socketId: socket.id });
  if (socket.data?.isNexting) {
    socket.data.isNexting = false;
    return;
  }
  for (const roomId of socket.rooms) {
    if (!roomId.startsWith("room_")) continue;
    const room = io.sockets.adapter.rooms.get(roomId);
    if (!room || room.size === 0) continue;
    io.to(roomId).emit("disconnected");
    logger.debug('Sent disconnected to room', { roomId });
  }
}
