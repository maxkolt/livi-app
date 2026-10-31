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

export type CallInitiateResponse = {
  ok: boolean;
  callId?: string;
  error?: string;
};

export type CallIncomingPayload = {
  callId: string;
  callKitId?: string;
  from: string;
  fromNick?: string;
  ts?: number | string;
  expiresAt?: number | string;
  media?: 'audio' | 'video';
};

export type CallAcceptedPayload = {
  callId: string;
  // Replays after reconnect have no live sender socket.
  from?: string | null;
  fromUserId?: string;
  roomId?: string;
  livekitToken?: string | null;
  livekitRoomName?: string | null;
  livekitUrl?: string | null;
  acceptedAt?: number | string | null;
  e2ee?: { peerPublicKey: string } | null;
};

export type PresenceUpdatePayload =
  | Array<{ _id: string; online: boolean }>
  | string[]
  | { userId: string; busy: boolean };

export type WelcomePresencePayload = {
  ok?: boolean;
  list?: Array<string | { id?: string; nick?: string; name?: string; avatarVer?: number }>;
};
