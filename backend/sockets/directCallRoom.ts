import type { Server } from "socket.io";
import type { AuthedSocket } from "./types";
import { logger } from "../utils/logger";

const DIRECT_USER_PAIR_ROOM_RE = /^room_([a-f\d]{24})_([a-f\d]{24})$/i;

export function parseDirectCallRoomParticipants(roomId: string): { a: string; b: string } | null {
  const m = String(roomId || "").match(DIRECT_USER_PAIR_ROOM_RE);
  if (!m) return null;
  return { a: m[1], b: m[2] };
}

let onCallSocketDetached: ((socketId: string) => void) | undefined;

/** Регистрируется из index.ts (activeCallBySocket и т.п.). */
export function setOnCallSocketDetached(fn: ((socketId: string) => void) | undefined) {
  onCallSocketDetached = fn;
}

/** Полностью очищает комнату в адаптере Socket.IO (все сокеты делают leave). */
export function dissolveSocketIoRoom(io: Server, roomId: string): void {
  if (!roomId) return;
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room || room.size === 0) return;
  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    if (!s) continue;
    try {
      s.leave(roomId);
    } catch {}
  }
}

function clearCallRoomDataIfStale(s: AuthedSocket, roomId: string) {
  const d: any = s.data || {};
  if (String(d.roomId || "") !== roomId) return;
  d.roomId = undefined;
  d.partnerSid = undefined;
  d.inCall = false;
  d.busy = false;
}

/**
 * В комнате дружеского звонка (room_<userId>_<userId>) оставляем один сокет на userId.
 * Остальные вкладки/зомби после переподключения выкидываются из комнаты.
 */
export function evictExtraUserSocketsInDirectRoom(
  io: Server,
  roomId: string,
  userId: string,
  keepSocketId: string
): void {
  const participants = parseDirectCallRoomParticipants(roomId);
  const uid = String(userId || "");
  if (!participants || !uid || (uid !== participants.a && uid !== participants.b)) return;

  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return;

  for (const sid of [...room]) {
    if (sid === keepSocketId) continue;
    const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    if (!s) continue;
    const suid = String((s as any)?.data?.userId || "");
    if (suid !== uid) continue;
    try {
      s.leave(roomId);
    } catch {}
    try {
      onCallSocketDetached?.(sid);
    } catch {}
    try {
      clearCallRoomDataIfStale(s, roomId);
    } catch {}
    logger.debug("[directCallRoom] evicted duplicate user socket from room", {
      roomId,
      userId: uid,
      evictedSocketId: sid,
      keepSocketId,
    });
  }
}
