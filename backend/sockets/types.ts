import type { Socket, Server, DefaultEventsMap } from 'socket.io';

export type UserID = string;

export interface SocketData {
  userId?: UserID;
  nick?: string;
  partnerSid?: string | null;
  roomId?: string;
  busy?: boolean;
  inCall?: boolean;
  isNexting?: boolean;
  lastNextTransitionId?: string;
  /** Собеседник по рандому (отличает рандом-пару от direct-call, где тоже ставится partnerSid). */
  randomPartnerSid?: string;
  /** Этот сокет отвалился, и его рандом-пару уже забрал новый сокет того же пользователя. */
  resumedBy?: string;
  /** Сервер отключил этот сокет, потому что тот же пользователь подключился заново (sockets/identity.ts). */
  evictedBy?: string;
  appForeground?: boolean;
  appForegroundLastSeenAt?: number;
}

export interface ClusterEvents {
  'livi:callKeepAlive:push': (payload: { userId?: string; data?: Record<string, string> }) => void;
}

export type BackendServer = Server<DefaultEventsMap, DefaultEventsMap, ClusterEvents, SocketData>;

export type InstallHandshake = {
  auth?: { installId?: unknown };
  query?: { installId?: unknown };
};

export type PresenceUpdateInput = {
  status?: 'busy' | 'online' | 'offline';
  idle?: boolean;
  roomId?: string | null;
  callId?: string | null;
};

export interface AuthedSocket extends Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData> {
  data: SocketData;
}
