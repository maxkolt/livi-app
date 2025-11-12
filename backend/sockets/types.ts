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
  };
}
