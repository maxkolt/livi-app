// frontend/sockets/socket.ts
// Thin facade: domain split lives in ./modules/*. Public API is 1:1 with the pre-split module.
import "./modules/connect";
// Ensure call signaling helpers/listeners are initialized with the connect boot path
// (accept from lock screen / background can race module evaluation order otherwise).
import "./modules/calls";

export { API_BASE, CALL_SIGNALING_CONNECT_MS, SOCKET_CONNECT_WAIT_MS } from "./modules/constants";
export type { SocketReauthResponse } from "./modules/types";
export type { OutboxMessageDeliveredPayload } from "./modules/outboxTypes";
export type { FriendListItem } from "./modules/friends";
export type { DeleteMessagesBatchResult } from "./modules/messages";
export type { DirectCallMedia } from "./modules/calls";

export {
  clearCancelledOutboxFingerprints,
  onOutboxMessageDelivered,
  removeQueuedEditsMatching,
  removeQueuedMessagesMatching,
} from "./modules/outbox";

export { recordAppliedFromPending, wasAppliedFromReauth } from "./modules/missedCalls";

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
  hasVisibleOnlinePresenceSnapshot,
  isPeerInVisibleOnlinePresence,
  onPresenceUpdate,
  onUserPresence,
} from "./modules/presence";

export {
  onRtcAnswer,
  onRtcCandidate,
  onRtcOffer,
  sendAnswer,
  sendCandidate,
  sendOffer,
  socketBufferIceCandidate,
  socketFlushBufferedIceCandidates,
} from "./modules/rtc";

export {
  acceptInvite,
  addFriend,
  checkFriendship,
  checkInviteLink,
  fetchFriends,
  inviteFriend,
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
  attachUserId,
  checkUserExists,
  checkUserExistsSocket,
  clearAllUserData,
  clearCurrentUserId,
  createUser,
  getCurrentUserId,
  getMyUserId,
  getSocketId,
  identityAttach,
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
  filterOutGloballyDeletedMessages,
  getChatHistory,
  getChatMessages,
  getChatMessagesLocal,
  getUnreadCount,
  getUnreadCounts,
  getUnreadMessageCount,
  globalMessageStorage,
  isGloballyDeletedMessageId,
  loadMessagesFromServer,
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
  rememberGloballyDeletedMessageIds,
  sendChatTyping,
  sendChatViewing,
  sendMessage,
  sendMessageReaction,
  sendReadReceipt,
  updateMessageUris,
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
  requestCallAccepted,
  requestCallAcceptedWithRetry,
  startCall,
} from "./modules/calls";

export { getSocket, isReconnecting, socket } from "./modules/socketCore";
export { socket as default } from "./modules/socketCore";
export { applyAuthAndConnect, boot, hardRecycleSocketConnection, shouldAttemptRealtimeConnection } from "./modules/connect";
