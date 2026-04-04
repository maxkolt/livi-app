/**
 * Payload для socket `call:end`: никогда не дублируем callId в roomId —
 * иначе сервер ищет Socket.IO-комнату по строке вида "123_abc" и не находит room_user1_user2.
 */
const CANONICAL_FRIEND_ROOM = /^room_[a-f\d]{24}_[a-f\d]{24}$/i;

export function isCanonicalFriendRoomId(roomId: string | null | undefined): boolean {
  return CANONICAL_FRIEND_ROOM.test(String(roomId ?? '').trim());
}

export function buildCallEndSocketPayload(
  callId?: string | null,
  roomId?: string | null,
): { callId?: string; roomId?: string } {
  const cid = callId != null ? String(callId).trim() : '';
  const rid = roomId != null ? String(roomId).trim() : '';
  const out: { callId?: string; roomId?: string } = {};
  if (cid) out.callId = cid;
  if (rid && isCanonicalFriendRoomId(rid)) out.roomId = rid;
  return out;
}
