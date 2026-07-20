// frontend/sockets/modules/types.ts
export type SocketReauthResponse = {
  ok: boolean;
  userId?: string;
  error?: string;
  missed?: { from: string; fromNick?: string }[];
};
