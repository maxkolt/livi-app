
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

