import type { Socket } from 'socket.io';

export type UserID = string;

export interface AuthedSocket extends Socket {
  data: {
    userId?: UserID;
    partnerSid?: string;
    roomId?: string;
    busy?: boolean;
    inCall?: boolean;
    isNexting?: boolean;
    lastNextTransitionId?: string;
    /** Собеседник по рандому (отличает рандом-пару от direct-call, где тоже ставится partnerSid). */
    randomPartnerSid?: string;
    /** Этот сокет отвалился, и его рандом-пару уже забрал новый сокет того же пользователя. */
    resumedBy?: string;
  };
}
