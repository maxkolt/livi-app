import type { CallAudioGlobals, CallRef } from './callStateTypes';
import type { PendingVideoCallNav } from './appNavigationGuard';
import type { PushNotificationData } from './notificationTypes';
import type { VideoCallSession } from '../src/webrtc/sessions/VideoCallSession';
import type { WelcomeTabId } from '../screens/home/HomeWelcomeTabBar';

/** Optional getter retained for older call-session implementations. */
type AppCallSession = VideoCallSession & { getLocalCamEnabled?: () => boolean };

/** App-owned callbacks and snapshots; importing this view initializes no global state. */
export type AppRuntimeGlobals = CallAudioGlobals & {
  __webrtcSessionRef?: CallRef<AppCallSession | null>;
  __searchNavT0?: number;
  __searchNavSteps?: Array<{ step: string; at: number; elapsedMs: number; requireMs?: number }>;
  __searchNavStateChangeLogged?: boolean;
  __pendingForegroundVideoCallNavRef?: CallRef<PendingVideoCallNav | null>;
  __bumpAndroidPipGuardRef?: CallRef<(() => void) | null>;
  __callCancelNavDoneRef?: { from: string; at: number };
  __incomingAnswerPeerUserIdRef?: CallRef<string | null>;
  __completeAndroidIncomingAnswer?: (from: string, callId: string, fromNick?: string) => Promise<void>;
  __lastOutgoingCancelAtRef?: CallRef<number>;
  __outgoingCanceledByNativeRef?: CallRef<boolean>;
  __activeOutgoingAttemptRef?: CallRef<number>;
  __outgoingCallUiActiveRef?: CallRef<boolean>;
  __outgoingCancelAwaitingCallIdRef?: CallRef<boolean>;
  __lastIncomingFromUserIdRef?: CallRef<string | null>;
  __ignoreSystemPiPExpandedUntilRef?: CallRef<number>;
  __endCallFromNativeRef?: CallRef<((callId: string | null, roomId: string | null) => void) | null>;
  __lastSystemPiPExpandedAtRef?: CallRef<number>;
  __locallyEndedCallRef?: CallRef<{ callId: string; at: number } | null>;
  __handleCallDeepLinkRef?: CallRef<(url: string) => Promise<boolean>>;
  __currentChatPeerId?: string | null;
  __setIncomingCallFromPush?: (data: PushNotificationData) => void;
  __pipCallEndedWasInAppAtStartRef?: CallRef<boolean>;
  __onCallEndedFromPush?: () => void;
  __outgoingCallStartedAtRef?: CallRef<number>;
  __outgoingRedialGraceUntilRef?: CallRef<number>;
  __outgoingStartInFlightRef?: CallRef<boolean>;
  __outgoingAttemptTeardownRef?: CallRef<(() => void) | null>;
  __homeRowActionAtRef?: CallRef<number>;
  __randomChatPresenceBusyRef?: CallRef<boolean>;
  __randomChatHadPresenceBusyRef?: CallRef<boolean>;
  __welcomeTabPerfTrace?: {
    id: string;
    target: WelcomeTabId;
    from: WelcomeTabId;
    startedAt: number;
    mountedBefore: boolean;
    commitLogged?: boolean;
  };
};
