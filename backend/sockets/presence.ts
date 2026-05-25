import type { Server } from 'socket.io';
import type { AuthedSocket, UserID } from './types';
import { scheduleGlobalFriendPresenceEmit } from '../utils/friendOnlinePresence';

export const online: Map<UserID, Set<string>> = new Map();

export function bindPresence(io: Server, socket: AuthedSocket) {
  const userId = socket.data.userId!;
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId)!.add(socket.id);

  // можно слать себе подтверждение
  socket.emit('presence:me', { online: true });

  // Presence отправляем только друзьям пользователя, не broadcast всем сокетам.
  scheduleGlobalFriendPresenceEmit(io, userId);

  socket.on('disconnect', () => {
    const set = online.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      online.delete(userId);
      scheduleGlobalFriendPresenceEmit(io, userId);
    }
  });
}
