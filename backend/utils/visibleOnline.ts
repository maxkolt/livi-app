import type { Server } from 'socket.io';

/**
 * Друзьям показываем онлайн только если сокет не в режиме «приложение в фоне».
 * appForeground === false выставляется событием app:visibility с клиента; undefined = старые клиенты = видимы.
 */
export function isSocketForegroundVisible(s: { data?: Record<string, unknown> }): boolean {
  return (s as any).data?.appForeground !== false;
}

export function isUserVisibleOnline(io: Server, uid: string): boolean {
  const id = String(uid);
  for (const s of io.sockets.sockets.values()) {
    if (String((s as any).data?.userId || '') !== id) continue;
    if (isSocketForegroundVisible(s)) return true;
  }
  return false;
}

export function getVisibleOnlineUserIds(io: Server): string[] {
  const set = new Set<string>();
  for (const s of io.sockets.sockets.values()) {
    const uid = (s as any)?.data?.userId;
    if (uid && isSocketForegroundVisible(s)) set.add(String(uid));
  }
  return Array.from(set);
}
