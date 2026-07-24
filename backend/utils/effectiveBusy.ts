import type { Server } from 'socket.io';

/**
 * Реализация «эффективной» занятости для списка друзей.
 * Direct-call: callee в ожидающем звонке (без inCall) не считается занятым.
 * Random: очередь (busy) / пара (partnerSid) / rand_room — занят (как presence:update).
 * Устанавливается из index.ts при старте сервера.
 */
let getEffectiveBusyImpl: ((io: Server, userId: string) => boolean) | null = null;

export function setGetEffectiveBusy(fn: (io: Server, userId: string) => boolean): void {
  getEffectiveBusyImpl = fn;
}

/**
 * Возвращает true, если пользователь должен отображаться как «Занят» в списке друзей.
 * Учитывает direct-call (callee до accept — не занят) и random/queue busy.
 */
export function getEffectiveBusy(io: Server, userId: string): boolean {
  if (getEffectiveBusyImpl) return getEffectiveBusyImpl(io, userId);
  // Fallback: хотя бы один сокет пользователя с data.busy === true
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any).data?.userId) === String(userId) && (s as any).data?.busy === true) return true;
  }
  return false;
}
