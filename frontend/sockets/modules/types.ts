// frontend/sockets/modules/types.ts
export type MissedCallDelivery = {
  id?: string;
  callId?: string;
  from: string;
  fromNick?: string;
  at?: number;
};

export type SocketReauthResponse = {
  ok: boolean;
  userId?: string;
  error?: string;
  missed?: MissedCallDelivery[];
};
