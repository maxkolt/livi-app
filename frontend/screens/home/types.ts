export type Friend = {
  id: string;
  name?: string;
  nick?: string;
  avatar?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  online: boolean;
  isBusy?: boolean;
  isRandomBusy?: boolean;
  inCall?: boolean;
};

export type HomeRouteParams = {
  callEnded?: boolean;
  callCancelled?: boolean;
  inviteCode?: string;
  showInviteModal?: boolean;
  openFriendsMenu?: boolean;
  openFriendsTab?: boolean;
  pushMessageFrom?: string;
};

export type MarkReadMenu = {
  friendId: string;
  type: 'video' | 'chat';
} | null;
