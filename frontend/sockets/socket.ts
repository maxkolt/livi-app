// frontend/sockets/socket.ts
// Thin facade: domain split lives in ./modules/*. Public API is 1:1 with the pre-split module.
import "./modules/connect";
// Ensure call signaling helpers/listeners are initialized with the connect boot path
// (accept from lock screen / background can race module evaluation order otherwise).
import "./modules/calls";

export { API_BASE, CALL_SIGNALING_CONNECT_MS, SOCKET_CONNECT_WAIT_MS } from "./modules/constants";
export type { SocketReauthResponse } from "./modules/types";
export type { OutboxMessageDeliveredPayload, OutboxMessageFailedPayload } from "./modules/outboxTypes";

export {
  clearCancelledOutboxFingerprints,
  isMessagePendingInOutbox,
  listPendingMessageOutboxForPeer,
  onOutboxMessageDelivered,
  onOutboxMessageFailed,
  onOutboxPendingChange,
  persistOutgoingReadStatus,
  removeQueuedEditsMatching,
  removeQueuedMessagesMatching,
} from "./modules/outbox";

export {
  hasPendingReactions,
  onReactionOutboxChange,
  withPendingReactions,
} from "./modules/reactionOutbox";
export type { MessageReaction } from "./modules/reactionOutbox";

export { recordAppliedFromPending } from "./modules/missedCalls";

export {
  emitAck,
  ensureSocketConnected,
  onConnected,
  onDisconnected,
  warmCallSignaling,
} from "./modules/emit";

export {
  PRESENCE_OFFLINE_DEBOUNCE_MS,
  emitPresenceUpdateIfChanged,
  onPresenceUpdate,
  onWelcomePresence,
} from "./modules/presence";


export {
  acceptInvite,
  checkInviteLink,
  fetchFriendRequests,
  fetchFriends,
  onFriendAccepted,
  onFriendAdded,
  onFriendDeclined,
  onFriendRemoved,
  onFriendRequest,
  removeFriend,
  requestFriend,
  respondFriend,
} from "./modules/friends";

export { getAvatar, getMyProfile, updateProfile } from "./modules/profile";

export {
  attachIdentity,
  checkUserExists,
  clearAllUserData,
  clearCurrentUserId,
  createUser,
  getCurrentUserId,
  getMyUserId,
  isCreateUserInProgress,
  onFriendProfile,
  refreshUserIdFromInstall,
  setCurrentUserId,
  waitForCreateUserCompletion,
} from "./modules/identity";

export { onCurrentUserId } from "./modules/authState";

export {
  clearAllMessageCache,
  clearChatMessages,
  clearMessageCache,
  deleteMessage,
  deleteMessages,
  editMessage,
  ensureGloballyDeletedMessageIdsLoaded,
  fetchMessages,
  getChatMessages,
  getChatMessagesLocal,
  getUnreadCount,
  getUnreadCounts,
  globalMessageStorage,
  isGloballyDeletedMessageId,
  markMessagesAsRead,
  onChatCleared,
  onChatTyping,
  onMessageDeleted,
  onMessageEdited,
  onMessageReaction,
  onMessageReadReceipt,
  onMessageReceived,
  onMessageUrisUpdated,
  onMessagesDeleted,
  sendChatTyping,
  sendChatViewing,
  sendMessage,
  sendMessageReaction,
  sendReadReceipt,
  updateMessageUris,
  fetchChatPreviews,
} from "./modules/messages";

export {
  getIncomingCallScreenState,
  onIncomingCallScreenChange,
  setActiveVideoCall,
  setIncomingCallScreenVisible,
  setOutgoingCallScreenVisible,
} from "./modules/connect";

export {
  acceptCall,
  awaitEarlyIncomingCallAccept,
  beginEarlyIncomingCallAccept,
  cancelCall,
  declineCall,
  emitCallAcceptAck,
  emitCallHeartbeat,
  forceEndDirectCallWithPeer,
  hasEarlyIncomingCallAccept,
  onCallAccepted,
  onCallCanceled,
  onCallDeclined,
  onCallIncoming,
  onCallRoomFull,
  onCallTimeout,
  onFriendsRoomState,
  onRandomBusy,
  reportIncomingCallShown,
  requestCallAcceptedWithRetry,
  startCall,
} from "./modules/calls";

export { isReconnecting, socket } from "./modules/socketCore";
export { socket as default } from "./modules/socketCore";
export { applyAuthAndConnect, boot, hardRecycleSocketConnection } from "./modules/connect";
