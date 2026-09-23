/**
 * Чистые предикаты «этот socket-сигнал про мой звонок?».
 *
 * Вынесено из VideoCallSession без изменения поведения: раньше эти правила жили пятью
 * приватными методами вперемешку с медиа-логикой, и проверить их можно было только
 * подняв всю сессию. Здесь они зависят только от переданного снимка идентификаторов.
 */

export type CallRoomIdentity = {
  /** `room.name` живой LiveKit-комнаты (пусто до connect). */
  liveKitRoomName?: string | null;
  /** roomId из socket-пейринга / call:accepted. */
  socketRoomId?: string | null;
  /** Имя комнаты, к которой сессия подключена прямо сейчас. */
  currentRoomName?: string | null;
};

export type CallParticipantsIdentity = {
  myUserId?: string | null;
  partnerUserId?: string | null;
};

export type PeerCallSignal = {
  callId?: string;
  roomId?: string;
  from?: string;
} | null | undefined;

/** Публичный roomId сессии: имя LiveKit-комнаты приоритетнее socket roomId. */
export function resolvePublicRoomId(identity: CallRoomIdentity): string | null {
  return identity.liveKitRoomName || identity.socketRoomId || null;
}

/** roomId для socket relay (LiveKit name, pairing roomId, call:accepted room). */
export function resolveSignalingRoomId(identity: CallRoomIdentity): string | null {
  for (const raw of [
    resolvePublicRoomId(identity),
    identity.currentRoomName,
    identity.socketRoomId,
    identity.liveKitRoomName,
  ]) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s) return s;
  }
  return null;
}

/** roomId в pip/cam-toggle/direct-call:video-ui может совпадать с socket roomId или именем LiveKit-комнаты. */
export function matchesSignalingRoom(identity: CallRoomIdentity, incoming?: string | null): boolean {
  if (!incoming) return false;
  const normalized = String(incoming).trim();
  if (!normalized) return false;
  const ids = new Set<string>();
  for (const raw of [
    resolvePublicRoomId(identity),
    identity.socketRoomId,
    identity.liveKitRoomName,
    identity.currentRoomName,
  ]) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s) ids.add(s);
  }
  return ids.has(normalized);
}

/** room_<userA>_<userB> из call:accepted / LiveKit — когда resolvePublicRoomId ещё пуст на «лишней» сессии. */
export function matchesDirectCallParticipantsRoom(
  participants: CallParticipantsIdentity,
  incoming?: string | null,
): boolean {
  const normalized = String(incoming ?? '').trim();
  if (!normalized.startsWith('room_')) return false;
  const me = String(participants.myUserId ?? '').trim();
  const partner = String(participants.partnerUserId ?? '').trim();
  if (!me || !partner) return false;
  const body = normalized.slice(5);
  return body.includes(me) && body.includes(partner);
}

/** Сигнал peer-состояния (reconnecting / network down) адресован текущему звонку. */
export function matchesPeerCallSignal(
  ctx: { callId?: string | null; identity: CallRoomIdentity; participants: CallParticipantsIdentity },
  data?: PeerCallSignal,
): boolean {
  const callId = String(data?.callId || '').trim();
  const roomId = String(data?.roomId || '').trim();
  const myCallId = String(ctx.callId || '').trim();
  if (callId && myCallId && callId !== myCallId) return false;
  if (roomId) {
    if (
      matchesSignalingRoom(ctx.identity, roomId) ||
      matchesDirectCallParticipantsRoom(ctx.participants, roomId)
    ) {
      return true;
    }
    // Сессия ещё без roomId — принимаем по callId (или без фильтров, если callId тоже пуст).
    if (resolveSignalingRoomId(ctx.identity)) return false;
  }
  return true;
}

/**
 * call:ended / call:cancel относится к текущему звонку.
 * Для обратной совместимости пустой payload (без callId и roomId) считается текущим звонком.
 */
export function isCurrentCallEvent(
  current: { callId?: string | null; roomId?: string | null },
  data?: { callId?: string; roomId?: string },
): boolean {
  const incomingCallId = String(data?.callId || '').trim();
  const incomingRoomId = String(data?.roomId || '').trim();
  if (!incomingCallId && !incomingRoomId) return true;

  const currentCallId = String(current.callId || '').trim();
  const currentRoomId = String(current.roomId || '').trim();
  if (incomingCallId && currentCallId && incomingCallId === currentCallId) return true;
  if (incomingRoomId && currentRoomId && incomingRoomId === currentRoomId) return true;
  return false;
}
