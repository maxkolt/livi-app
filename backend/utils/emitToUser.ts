import type { Server } from 'socket.io';

const OID_HEX_24 = /^[a-f\d]{24}$/i;

export function normalizeMongoObjectId(s: string): string {
  const t = String(s || '').trim();
  return OID_HEX_24.test(t) ? t.toLowerCase() : t;
}

/**
 * Deliver a socket event to every connection belonging to userId.
 * Uses room u:<id> first, then falls back to sock.data.userId (covers sockets
 * that have identity but missed the personal room join).
 */
export function emitToUser(io: Server, userId: string, event: string, payload: unknown): void {
  const uid = normalizeMongoObjectId(userId);
  if (!OID_HEX_24.test(uid)) return;

  const delivered = new Set<string>();
  const room = io.sockets.adapter.rooms.get(`u:${uid}`);
  if (room) {
    for (const sid of room) {
      const sock = io.sockets.sockets.get(sid);
      if (!sock) continue;
      sock.emit(event, payload);
      delivered.add(sid);
    }
  }

  for (const sock of io.sockets.sockets.values()) {
    if (delivered.has(sock.id)) continue;
    const suid = normalizeMongoObjectId(String((sock as any).data?.userId || ''));
    if (suid !== uid) continue;
    sock.emit(event, payload);
    delivered.add(sock.id);
  }
}
