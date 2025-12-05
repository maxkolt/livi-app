// backend/sockets/webrtc.ts
import type { Server } from "socket.io";
import type { AuthedSocket } from "./types";
import { logger } from '../utils/logger';

/**
 * Тип полезной нагрузки для сигналинга WebRTC.
 */
type SignalPayload = {
  roomId?: string;
  to?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

/**
 * Подключает обработчики сигналинга WebRTC к сокету.
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
    
    // УБРАНО: Проверка busy флага в room:join:ack
    // В рандомном поиске пользователь должен быть busy=true (он в поиске)
    // busy флаг блокирует только прямые звонки, но не рандомный поиск
    
    // Убрано: проверка busy флага для room:join:ack
    // busy флаг не должен блокировать рандомный поиск
    
    // Добавляем сокет в комнату
    socket.join(roomId);
    logger.debug('Socket joined room', { socketId: socket.id, roomId });
    
    // УДАЛЕНО: установка busy флага - теперь устанавливается через connection:established
    // когда WebRTC соединение реально установлено (есть remoteStream)
    
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
  socket.on("connection:established", ({ roomId }: { roomId?: string }) => {
    logger.debug('WebRTC connection established', { socketId: socket.id, roomId });
    
    // Устанавливаем busy флаг для текущего пользователя
    (socket as any).data = (socket as any).data || {};
    (socket as any).data.busy = true;
    
    const myUserId = (socket as any)?.data?.userId;
    if (myUserId) {
      io.emit("presence:update", { userId: myUserId, busy: true });
      logger.debug('Set busy for user', { userId: myUserId });
    }
  });

  /** =========================
   *  Universal forward helper
   *  ========================= */
  const forward = (event: "offer" | "answer" | "ice-candidate" | "hangup") => {
    socket.on(event, (data: SignalPayload) => {
      const { roomId, to, ...payload } = data;
      const targetId = roomId || to;
      if (!targetId) {
        logger.warn(`[forward ${event}] No targetId (roomId or to) provided`, { socketId: socket.id });
        return;
      }

      // Логирование для отладки
      if (payload?.offer?.sdp) {
        logger.debug(`[forward ${event}] Forwarding offer`, { 
          socketId: socket.id, 
          roomId, 
          to, 
          targetId,
          hasRoomId: !!roomId,
          hasTo: !!to
        });
      } else if (payload?.answer?.sdp) {
        logger.debug(`[forward ${event}] Forwarding answer`, { 
          socketId: socket.id, 
          roomId, 
          to, 
          targetId,
          hasRoomId: !!roomId,
          hasTo: !!to
        });
      } else if (payload?.candidate) {
        // ICE кандидаты слишком частые, не логируем
      } else {
        logger.debug(`[forward ${event}] Forwarding event`, { 
          socketId: socket.id, 
          roomId, 
          to, 
          targetId 
        });
      }

      // Отправка: либо в комнату, либо конкретному сокету
      // При hangup дополнительно продублируем в обе стороны на всякий случай
      const fromUserId = (socket as any)?.data?.userId ? String((socket as any).data.userId) : undefined;
      // КРИТИЧНО: Включаем roomId в envelope для правильной обработки на клиенте
      const envelope = { from: socket.id, fromUserId, roomId, ...payload } as any;
      
      let delivered = false;
      
      // КРИТИЧНО: Для прямых звонков используем roomId для гарантированной доставки
      // КРИТИЧНО: Используем socket.to() вместо io.to(), чтобы исключить отправителя из получателей
      if (roomId) {
        const room = io.sockets.adapter.rooms.get(roomId);
        const roomSize = room ? room.size : 0;
        logger.debug(`[forward ${event}] Sending to room`, { 
          roomId, 
          roomSize,
          socketId: socket.id 
        });
        // КРИТИЧНО: socket.to() исключает отправителя, io.to() включает всех в комнате
        socket.to(roomId).emit(event, envelope);
        delivered = true;
      }
      
      // Также отправляем напрямую по to для совместимости
      if (to) {
        const targetSocket = io.sockets.sockets.get(to);
        if (targetSocket) {
          logger.debug(`[forward ${event}] Sending directly to socket`, { 
            to, 
            socketId: socket.id,
            targetExists: true
          });
          targetSocket.emit(event, envelope);
          delivered = true;
        } else {
          logger.warn(`[forward ${event}] Target socket not found`, { 
            to, 
            socketId: socket.id 
          });
        }
      }
      
      if (!delivered) {
        logger.error(`[forward ${event}] Failed to deliver event`, { 
          socketId: socket.id, 
          roomId, 
          to 
        });
      }
      // Доп. гарантия доставки для завершения вызова: шлем во все общие комнаты сокета
      if (event === 'hangup') {
        socket.rooms.forEach((rid) => {
          if (rid && rid.startsWith('room_')) {
            io.to(rid).emit('hangup', envelope);
          }
        });
      }
    });
  };

  /** =========================
   *  WebRTC events forwarding
   *  ========================= */
  forward("offer");
  forward("answer");
  forward("ice-candidate");
  forward("hangup");

  /** =========================
   *  Camera toggle forwarding
   *  ========================= */
  socket.on("cam-toggle", (data: { enabled: boolean; from: string; to?: string; roomId?: string }) => {
    const { enabled, from, to, roomId } = data;
    // Логируем только отключение камеры
    if (!enabled) {
      logger.debug('Camera disabled', { socketId: socket.id });
    }
    
    // Пересылаем событие всем в комнатах, где находится этот сокет
    socket.rooms.forEach((currentRoomId) => {
      if (currentRoomId.startsWith("room_")) {
        // КРИТИЧНО: Передаем roomId при пересылке для правильной обработки на клиенте
        socket.to(currentRoomId).emit("cam-toggle", { enabled, from, roomId: currentRoomId });
        if (!enabled) logger.debug('Camera toggle forwarded to room', { roomId: currentRoomId });
      }
    });
    
    // Для WebRTC рандомного чата пересылаем событие напрямую по socket.id
    const socketData = (socket as any).data;
    
    if (socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        // КРИТИЧНО: Передаем to при пересылке для правильной обработки на клиенте
        partnerSocket.emit("cam-toggle", { enabled, from, to: partnerSocket.id });
        // Логируем только при ошибках или отключении камеры
        if (!enabled) logger.debug('Camera toggle forwarded to WebRTC partner', { partnerId: socketData.partnerSid });
      } else {
        logger.debug('Partner socket not found', { partnerId: socketData.partnerSid });
      }
    } else {
      // Логируем только если это не обычная ситуация (когда нет партнера)
      if (socket.rooms.size > 1) {
        logger.debug('No partnerSid found', { socketId: socket.id });
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

  /** =========================
   *  PiP state forwarding (новое событие для синхронизации состояния PiP)
   *  ========================= */
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
    
    // Также пересылаем через partnerSid для рандомного чата (если есть)
    const socketData = (socket as any).data;
    if (socketData && socketData.partnerSid) {
      const partnerSocket = io.sockets.sockets.get(socketData.partnerSid);
      if (partnerSocket) {
        partnerSocket.emit("pip:state", { inPiP, roomId, from: socket.id });
        logger.debug('PiP state forwarded to WebRTC partner', { partnerId: socketData.partnerSid, inPiP });
      }
    }
  });

  /** =========================
   *  Room leave (УПРОЩЕНО для 1-на-1)
   *  ========================= */
  socket.on("room:leave", ({ roomId }: { roomId: string }) => {
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
    
    // Снимаем busy со всех оставшихся
    remainingPeers.forEach(peerId => {
      const peerSocket = io.sockets.sockets.get(peerId) as AuthedSocket;
      if (peerSocket) {
        (peerSocket as any).data = (peerSocket as any).data || {};
        (peerSocket as any).data.busy = false;
        
        const peerUserId = (peerSocket as any)?.data?.userId;
        if (peerUserId) {
          io.emit("presence:update", { userId: peerUserId, busy: false });
        }
      }
    });
    
    // Отправляем presence:update для уходящего
    if (leavingUserId) {
      io.emit("presence:update", { userId: leavingUserId, busy: false });
    }
    
    socket.leave(roomId);
    
    // КРИТИЧНО: НЕ отправляем call:ended для рандомных чатов (используется peer:stopped)
    // call:ended только для звонков друзей (с activeCallBySocket)
    // Для рандомных чатов разрыв обрабатывается через 'stop'/'next' → peer:stopped
    
    // УПРОЩЕНО: В комнате максимум 2 участника, если ушел один - уведомляем второго
    // (но НЕ через call:ended, чтобы не вызывать навигацию в рандомном чате)
    if (remainingPeers.length === 1) {
      const remainingId = remainingPeers[0];
      // Просто уведомляем об уходе партнера без call:ended
      io.to(remainingId).emit("peer:stopped");
      logger.debug('Notified remaining peer', { roomId });
    }
  });

  /** =========================
   *  Disconnect cleanup (УПРОЩЕНО для 1-на-1)
   *  ========================= */
  socket.on("disconnect", (reason) => {
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
    
    // Отправляем presence:update
    if (disconnectedUserId) {
      io.emit("presence:update", { userId: disconnectedUserId, busy: false });
    }
    
    // Оповещаем все комнаты о дисконнекте
    socket.rooms.forEach((roomId) => {
      if (roomId.startsWith("room_")) {
        // Получаем оставшихся участников
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size > 0) {
          // Снимаем busy со всех оставшихся
          room.forEach(peerId => {
            const peerSocket = io.sockets.sockets.get(peerId) as AuthedSocket;
            if (peerSocket) {
              peerSocket.data = peerSocket.data || {};
              peerSocket.data.busy = false;
              
              const peerUserId = peerSocket.data?.userId;
              if (peerUserId) {
                io.emit("presence:update", { userId: peerUserId, busy: false });
              }
            }
          });
          
          // КРИТИЧНО: НЕ отправляем call:ended при disconnect для рандомных чатов
          // Для рандомных чатов дисконнект обрабатывается через событие 'disconnected' в index.ts
          // call:ended только для звонков друзей, и отправляется через call:end
          
          // Просто отправляем уведомление о дисконнекте
          io.to(roomId).emit("disconnected");
          logger.debug('Sent disconnected to room', { roomId });
        }
      }
    });
  });
}
