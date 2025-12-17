// backend/sockets/webrtc.ts
import type { Server } from "socket.io";
import type { AuthedSocket } from "./types";
import { logger } from '../utils/logger';
import User from '../models/User';

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
    
    // ОГРАНИЧЕНИЕ: Максимум 2 участника в комнате
    if (existingPeers.length >= 2) {
      logger.warn('Room is full, rejecting join', { roomId });
      socket.emit("call:busy", { 
        callId: roomId, 
        reason: 'room_full' 
      });
      return;
    }
    
    // Добавляем сокет в комнату
    socket.join(roomId);
    logger.debug('Socket joined room', { socketId: socket.id, roomId });
    
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
      logger.debug('Set busy for user', { userId: myUserId });
    }
  });

  /** =========================
   *  Camera toggle forwarding
   *  ========================= */
  socket.on("cam-toggle", (data: { enabled: boolean; from: string; to?: string; roomId?: string }) => {
    const { enabled, from, to, roomId } = data;
    
    // Пересылаем событие всем в комнатах, где находится этот сокет
    socket.rooms.forEach((currentRoomId) => {
      if (currentRoomId.startsWith("room_")) {
        // КРИТИЧНО: Передаем roomId при пересылке для правильной обработки на клиенте
        socket.to(currentRoomId).emit("cam-toggle", { enabled, from, roomId: currentRoomId });
        if (!enabled) logger.debug('Camera toggle forwarded to room', { roomId: currentRoomId });
      }
    });
    
    // Для обратной совместимости пересылаем событие напрямую по socket.id
    const socketData = (socket as any).data;
    
    if (socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        partnerSocket.emit("cam-toggle", { enabled, from, to: partnerSocket.id });
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
    if (roomId && roomId.startsWith("room_")) {
      socket.to(roomId).emit("pip:state", { 
        inPiP, 
        roomId, 
        from: socket.id 
      });
      logger.debug('PiP state forwarded to room', { roomId, inPiP });
    }
    
    // Также пересылаем через partnerSid для обратной совместимости
    const socketData = (socket as any).data;
    if (socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        partnerSocket.emit("pip:state", { inPiP, roomId, from: socket.id });
        logger.debug('PiP state forwarded to partner', { partnerId: socketData.partnerSid, inPiP });
      }
    }
  });

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
        }
      }
    }
    
    // Отправляем presence:update для уходящего (только друзьям)
    if (leavingUserId) {
      await emitPresenceUpdateToFriends(io, leavingUserId, false);
    }
    
    socket.leave(roomId);
    
    // Уведомляем оставшегося участника
    if (remainingPeers.length === 1) {
      const remainingId = remainingPeers[0];
      io.to(remainingId).emit("peer:stopped");
      logger.debug('Notified remaining peer', { roomId });
    }
  });

  /** =========================
   *  Disconnect cleanup
   *  ========================= */
  socket.on("disconnect", async (reason) => {
    logger.debug('Socket disconnected from webrtc', { socketId: socket.id, reason });
    
    // Если пользователь просто нажал "Next", не чистим очередь
    if (socket.data?.isNexting) {
      logger.debug('Socket performing next, skip cleanup', { socketId: socket.id });
      socket.data.isNexting = false;
      return;
    }
    
    // Снимаем флаг busy
    const disconnectedUserId = socket.data?.userId;
    if (socket.data) {
      socket.data.busy = false;
    }
    
    // Отправляем presence:update (только друзьям)
    if (disconnectedUserId) {
      await emitPresenceUpdateToFriends(io, disconnectedUserId, false);
    }
    
    // Оповещаем все комнаты о дисконнекте
    for (const roomId of socket.rooms) {
      if (roomId.startsWith("room_")) {
        // Получаем оставшихся участников
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size > 0) {
          // Снимаем busy со всех оставшихся (только друзьям)
          for (const peerId of room) {
            const peerSocket = io.sockets.sockets.get(peerId) as AuthedSocket;
            if (peerSocket) {
              peerSocket.data = peerSocket.data || {};
              peerSocket.data.busy = false;
              
              const peerUserId = peerSocket.data?.userId;
              if (peerUserId) {
                await emitPresenceUpdateToFriends(io, peerUserId, false);
              }
            }
          }
          
          // КРИТИЧНО: НЕ отправляем call:ended при disconnect для рандомных чатов
          // Для рандомных чатов дисконнект обрабатывается через событие 'disconnected' в index.ts
          // call:ended только для звонков друзей, и отправляется через call:end
          
          // Просто отправляем уведомление о дисконнекте
          io.to(roomId).emit("disconnected");
          logger.debug('Sent disconnected to room', { roomId });
        }
      }
    }
  });
}
