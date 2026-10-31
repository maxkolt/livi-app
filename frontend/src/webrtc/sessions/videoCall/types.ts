/** Формы socket-payload'ов и опций connect для прямого звонка (вынесено из VideoCallSession.ts). */
import type { CallAcceptedPayload as SocketCallAcceptedPayload } from '../../../../sockets/modules/types';

// Recovery paths also normalize partial snapshots of the same socket payload.
export type CallAcceptedPayload = Partial<SocketCallAcceptedPayload>;

export type LiveKitTokenResponse = {
  ok: boolean;
  token?: string;
  url?: string;
  error?: string;
  callId?: string;
  e2ee?: { peerPublicKey?: string } | null;
};

export type { CallIncomingPayload } from '../../../../sockets/modules/types';

export type CallEndedPayload = {
  callId?: string;
  roomId?: string;
  reason?: string;
  scope?: string;
  from?: string;
};

export type LiveKitConnectOptions = {
  forceRelayOnly?: boolean;
  /** Уже пробовали signaling через API-домен; защищает от бесконечного fallback-цикла. */
  signalProxyTried?: boolean;
  /** Исходный LiveKit URL — обратный резерв, если основной API-proxy недоступен. */
  directSignalUrl?: string;
  /** Уже пробовали обратный fallback с proxy на прямой LiveKit URL. */
  directSignalTried?: boolean;
  /** Proxy уже повторяли: второй раз он идёт по прогретому соединению (VPN). */
  proxyRetried?: boolean;
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
