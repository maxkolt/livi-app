// frontend/sockets/modules/shared.ts
import type { AppStateStatus } from "react-native";
import { AppState } from "react-native";
import type { OutboxMessageDeliveredPayload } from "./outboxTypes";
import type { SocketReauthResponse } from "./types";

export type PendingRtcSignal = {
  event: "offer" | "answer" | "ice-candidate";
  to: string;
  payload: any;
};

/**
 * Single mutable runtime store for the socket layer.
 * Domain modules MUST use this object — never recreate these fields.
 */
export const shared = {
  // auth / identity
  currentUserId: undefined as string | undefined,
  bootInProgress: false,
  createUserPromise: null as Promise<string | null> | null,
  lastSuccessfulReauthAt: 0,
  reauthInFlight: null as Promise<SocketReauthResponse> | null,

  // socket flags (instance lives in socketCore)
  reconnecting: false,
  connectAttemptPromise: null as Promise<void> | null,
  handshakeHasInstallId: false,
  hasConnectedEver: false,

  // outbox
  outboxDrainInFlight: null as Promise<void> | null,
  editOutboxDrainInFlight: null as Promise<void> | null,
  cancelledOutboxSendIds: new Set<string>(),
  cancelledOutboxDiskHydrated: false,
  outboxMessageDeliveredSubs: new Set<(p: OutboxMessageDeliveredPayload) => void>(),

  // missed calls dedupe
  appliedFromReauthByUid: new Map<string, number>(),
  appliedFromPendingByUid: new Map<string, number>(),

  // presence
  lastPresenceUpdateKey: null as string | null,
  lastVisibleOnlineUserIds: new Set<string>(),
  visibleOnlinePresenceListKnown: false,
  lastSocketConnectAt: 0,
  presenceUpdateSubscribers: new Set<(data: any) => void>(),

  // app visibility / call screen flags
  lastAppState: AppState.currentState as AppStateStatus,
  // SOCKET_KEEP_ALIVE_IN_BACKGROUND = true → start unpaused
  realtimePaused: false,
  appVisibilityHeartbeatTimer: null as ReturnType<typeof setInterval> | null,
  outgoingCallScreenVisible: false,
  incomingCallScreenVisible: false,
  incomingCallFromUserId: null as string | null,
  incomingCallScreenChangeListeners: new Set<
    (visible: boolean, fromUserId: string | null) => void
  >(),
  activeVideoCall: false,

  // ICE / RTC
  candidateBuffer: {} as Record<string, any[]>,
  pendingRtcSignals: [] as PendingRtcSignal[],

  // identity caches
  userExistsCache: new Map<string, { result: boolean; timestamp: number }>(),
  lastUserExistsCacheLogAt: 0,
  pendingChecks: new Map<string, Promise<boolean | null>>(),
  pendingWaitLogged: new Set<string>(),

  // messages cache
  messageCache: new Map<string, { messages: any[]; timestamp: number }>(),
  globallyDeletedMessageIdsMem: null as Set<string> | null,
  globallyDeletedMessageIdsLoadPromise: null as Promise<Set<string>> | null,

  // calls
  earlyIncomingCallAcceptById: new Map<
    string,
    Promise<{ ok: boolean; duplicate?: boolean }>
  >(),

  // typing log
  devTypingLogState: new Map<string, boolean>(),
};
