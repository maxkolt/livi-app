import type { Server } from 'socket.io';

/**
 * Друзьям показываем онлайн только если сокет не в режиме «приложение в фоне».
 * appForeground === false выставляется событием app:visibility с клиента; undefined = старые клиенты = видимы.
 */
export function isSocketForegroundVisible(s: { data?: Record<string, unknown> }): boolean {
  return (s as any).data?.appForeground !== false;
}

/** Пользователь явно ушёл в фон по app:visibility — не подмешиваем sticky. */
function hasAppForegroundFalseSocket(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any)?.data?.userId || '') !== id) continue;
    if ((s as any).data?.appForeground === false) return true;
  }
  return false;
}

/**
 * Последний раз пользователь отвалился от сокета, будучи в приложении (appForeground !== false).
 * Пока TTL не истёк — считаем его видимым онлайн, чтобы друзья не видели мигание при reconnect.
 * Сбрасывается при reconnect, app:visibility false и по таймеру в index.ts.
 */
const stickyForegroundOnlineUntil = new Map<string, number>();

export function touchStickyForegroundOnline(userId: string): void {
  const id = String(userId || '').trim();
  if (!id) return;
  const until = Date.now() + STICKY_FOREGROUND_ONLINE_MS;
  stickyForegroundOnlineUntil.set(id, until);
}

export function clearStickyForegroundOnline(userId: string): void {
  const id = String(userId || '').trim();
  if (!id) return;
  stickyForegroundOnlineUntil.delete(id);
}

/** TTL «липкого» онлайна после дисконнекта в foreground (согласован с таймером в index.ts). */
export const STICKY_FOREGROUND_ONLINE_MS = 45_000;

function pruneExpiredSticky(): void {
  const now = Date.now();
  for (const [uid, until] of stickyForegroundOnlineUntil) {
    if (now > until) stickyForegroundOnlineUntil.delete(uid);
  }
}

export function getVisibleOnlineUserIds(io: Server): string[] {
  pruneExpiredSticky();
  const set = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const uid = (s as any)?.data?.userId;
    if (uid && isSocketForegroundVisible(s)) {
      const id = String(uid);
      set.add(id);
      stickyForegroundOnlineUntil.delete(id);
    }
  }
  const now = Date.now();
  for (const [uid, until] of stickyForegroundOnlineUntil) {
    if (now > until) continue;
    if (hasAppForegroundFalseSocket(io, uid)) {
      stickyForegroundOnlineUntil.delete(uid);
      continue;
    }
    set.add(uid);
  }
  return Array.from(set);
}

export function isUserVisibleOnline(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any).data?.userId || '') !== id) continue;
    if (isSocketForegroundVisible(s)) return true;
  }
  pruneExpiredSticky();
  if (hasAppForegroundFalseSocket(io, id)) return false;
  const until = stickyForegroundOnlineUntil.get(id);
  return typeof until === 'number' && Date.now() <= until;
}
