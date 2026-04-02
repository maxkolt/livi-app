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

function scoreSocketForDirectRoomKeep(
  s: AuthedSocket | undefined,
  roomId: string,
  activeRoomBySocket?: Map<string, string>
): number {
  if (!s) return -1;
  let score = 0;
  const d: any = s.data || {};
  if (activeRoomBySocket?.get(s.id) === roomId) score += 4;
  if (String(d.roomId || "") === roomId) score += 2;
  if (d.inCall) score += 1;
  return score;
}

/**
 * Комната дружеского звонка: убираем «чужих» (нет userId / не из пары) и лишние сокеты одного userId.
 * Вызывать после accept / перед подсчётом участников / при join:ack.
 */
export function sanitizeDirectCallSocketIoRoom(
  io: Server,
  roomId: string,
  activeRoomBySocket?: Map<string, string>
): { evicted: number } {
  const pair = parseDirectCallRoomParticipants(roomId);
  if (!pair) return { evicted: 0 };

  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room || room.size === 0) return { evicted: 0 };

  let evicted = 0;
  const byUser = new Map<string, string[]>();

  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
    if (!s) continue;
    const suid = String((s as any)?.data?.userId || "");
    if (!suid || (suid !== pair.a && suid !== pair.b)) {
      try {
        s.leave(roomId);
      } catch {}
      try {
        onCallSocketDetached?.(sid);
      } catch {}
      try {
        clearCallRoomDataIfStale(s, roomId);
      } catch {}
      evicted++;
      logger.info("[directCallRoom] evicted non-participant from direct call room", {
        roomId,
        socketId: sid,
        suid: suid || null,
      });
      continue;
    }
    const arr = byUser.get(suid) || [];
    arr.push(sid);
    byUser.set(suid, arr);
  }

  for (const uid of [pair.a, pair.b]) {
    const arr = byUser.get(uid);
    if (!arr || arr.length <= 1) continue;

    const scored = arr.map((sid) => {
      const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
      return {
        sid,
        score: scoreSocketForDirectRoomKeep(s, roomId, activeRoomBySocket),
      };
    });
    scored.sort((x, y) => {
      if (y.score !== x.score) return y.score - x.score;
      return x.sid.localeCompare(y.sid);
    });

    const keep = scored[0].sid;
    for (let i = 1; i < scored.length; i++) {
      const sid = scored[i].sid;
      const s = io.sockets.sockets.get(sid) as AuthedSocket | undefined;
      if (s) {
        try {
          s.leave(roomId);
        } catch {}
        try {
          onCallSocketDetached?.(sid);
        } catch {}
        try {
          clearCallRoomDataIfStale(s, roomId);
        } catch {}
      }
      evicted++;
      logger.debug("[directCallRoom] evicted duplicate tab for participant", {
        roomId,
        userId: uid,
        evictedSocketId: sid,
        keepSocketId: keep,
      });
    }
  }

  if (evicted > 0) {
    logger.info("[directCallRoom] sanitizeDirectCallSocketIoRoom done", { roomId, evicted });
  }
  return { evicted };
}
