/** Формы socket-payload'ов и опций connect для прямого звонка (вынесено из VideoCallSession.ts). */

export type CallAcceptedPayload = {
  callId?: string;
  from?: string;
  fromUserId?: string;
  roomId?: string;
  livekitToken?: string | null;
  livekitRoomName?: string | null;
  livekitUrl?: string | null;
  acceptedAt?: number | string | null;
};

export type CallIncomingPayload = {
  callId: string;
  from: string;
  fromNick?: string;
};

export type CallEndedPayload = {
  callId?: string;
  roomId?: string;
  reason?: string;
  scope?: string;
  from?: string;
};

export type LiveKitConnectOptions = {
  forceRelayOnly?: boolean;
  reason?: string;
};

/** Идентификаторы принятого звонка, вытащенные из call:accepted один раз. */
export type AcceptedCallIds = {
  callId: string | null;
  roomId: string | null;
  partnerId: string | null;
  partnerUserId: string | null;
  /** Метка времени принятия (0 — сервер не прислал). */
  acceptedAt: number;
  /** Имя комнаты LiveKit, либо socket roomId как запасной вариант. */
  targetRoomName: string | null;
  /**
   * Префикс JWT: тот же звонок с новым токеном — не дубликат, его надо обработать
   * заново (например, после reauth).
   */
  tokenFp: string;
};
