import type { Server } from 'socket.io';
import type { AuthedSocket, UserID } from './types';

export const online: Map<UserID, Set<string>> = new Map();

export function bindPresence(io: Server, socket: AuthedSocket) {
  const userId = socket.data.userId!;
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId)!.add(socket.id);

  // можно слать себе подтверждение
  socket.emit('presence:me', { online: true });

  // и всем — что я онлайн (фронт может фильтровать по друзьям)
  socket.broadcast.emit('presence:update', { userId, online: true });

  socket.on('disconnect', () => {
    const set = online.get(userId);
    if (!set) return;
    set.delete(socket.id);
    if (set.size === 0) {
      online.delete(userId);
      socket.broadcast.emit('presence:update', { userId, online: false });
    }
  });
}
