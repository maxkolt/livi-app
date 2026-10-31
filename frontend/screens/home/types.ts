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
  /** @deprecated legacy overlay — remapped to welcome; do not set */
  openFriendsMenu?: boolean;
  /** @deprecated prefer openWelcomeChat / openWelcomeCalls */
  openFriendsTab?: boolean;
  openWelcomeProfile?: boolean;
  openFriendRequests?: boolean;
  openWelcomeCalls?: boolean;
  openWelcomeCallsMissed?: boolean;
  openWelcomeChat?: boolean;
  openWelcomeChatUnread?: boolean;
  pushMessageFrom?: string;
};

export type MarkReadMenu = {
  friendId: string;
  type: 'video' | 'chat';
} | null;

/** Legacy refs used by home lists; each ref may be absent before its owner initializes. */
export type HomeUiGlobals = typeof global & {
  __currentChatPeerId?: string | null;
  __lastOutgoingCancelAtRef?: { current: number };
  __homeRowActionAtRef?: { current: number };
  __lastCallLogForceUiAtRef?: { current: number };
  __outgoingStartInFlightRef?: { current: boolean };
  __outgoingCallUiActiveRef?: { current: boolean };
  __outgoingCallScreenVisibleRef?: { current: boolean };
  __outgoingRedialGraceUntilRef?: { current: number };
  __videoCallPartnerUserIdRef?: { current: string | null };
};
