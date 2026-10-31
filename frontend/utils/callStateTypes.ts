import type { NavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from '../navigation/types';
import type { PiPState } from '../src/pip/PiPContext';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import type { VideoCallSession } from '../src/webrtc/sessions/VideoCallSession';
import type { SystemPiPReturnMediaSnapshot } from './activeCallSession';
import type { NativeCallAudioProbe } from './nativeCallAudioProbe';
import type { MediaStream } from '@livekit/react-native-webrtc';
import type { CallAcceptedPayload } from '../src/webrtc/sessions/videoCall/types';
import type { SystemPiPLeaveContext } from '../src/pip/pipPlaceholderOnly';

export type CallRef<T> = { current: T };
type BuiltinAudioRoute = Extract<InCallAudioRoute, 'EARPIECE' | 'SPEAKER_PHONE'>;

/** PiP may capture a call before the peer identity has resolved. */
export type CallPiPNavigationParams = Omit<NonNullable<RootStackParamList['VideoCall']>, 'peerUserId' | 'partnerId'> & {
  peerUserId?: string | null;
  partnerId?: string | null;
};

export type CallPiPShowParams = {
  callId: string;
  roomId: string;
  partnerName?: string;
  partnerAvatarUrl?: string;
  localStream?: MediaStream | null;
  remoteStream?: MediaStream | null;
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  muteLocal?: boolean;
  muteRemote?: boolean;
  navParams?: CallPiPNavigationParams;
  /** iOS defers visibility until the call screen has released its RTC views. */
  deferVisible?: boolean;
  fromAudioOnlyUi?: boolean;
  audioOutputRoute?: InCallAudioRoute;
};

export type SystemPiPReturnState = {
  token: number;
  owner: string | null;
  restoredAt: number;
  settledUntil: number;
};

/** Fields of the PiP snapshot shared with audio routing and call notifications. */
export type CallPiPParams = {
  callId?: string | null;
  roomId?: string | null;
  partnerId?: string | null;
  peerUserId?: string;
  partnerName?: string;
  partnerNick?: string;
  partnerAvatarUrl?: string;
  audioOutputRoute?: InCallAudioRoute | null;
  inAudioOnlyUi?: boolean;
  preferVideoCallUi?: boolean;
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  localStream?: MediaStream | null;
  remoteStream?: MediaStream | null;
  muteLocal?: boolean;
  muteRemote?: boolean;
  navParams?: CallPiPNavigationParams;
};

type CallPiPStateUpdate = Partial<PiPState> & {
  preferVideoCallUi?: boolean;
  inAudioOnlyUi?: boolean;
  audioOutputRoute?: InCallAudioRoute;
};

/** Existing legacy refs only: importing these types creates no state or timers. */
export type CallAudioGlobals = typeof global & {
  __callAudioRoutingOwnerRef?: CallRef<{ id: string; key: string } | null>;
  __endCallCleanupOwnerRef?: CallRef<string | null>;
  __endCallCleanupRef?: CallRef<(() => void) | null>;
  __incomingAcceptSentRef?: CallRef<string | null>;
  __videoCallCleanupDoneRef?: CallRef<{ key: string; at: number; reason: string } | null>;
  __videoCallTeardownScheduledRef?: CallRef<{ key: string; at: number; reason: string } | null>;
  __lastHandledCallEndedRef?: { key: string; at: number };
  __lastEndCallSourceRef?: CallRef<string | null>;
  __homeResetByVideoCallRef?: CallRef<boolean>;
  __toggleRemoteAudioRef?: CallRef<(() => void) | null>;
  __toggleCamRef?: CallRef<(() => void) | null>;
  __cycleAudioRouteRef?: CallRef<(() => void) | null>;
  __systemPiPCompactDiagAtRef?: CallRef<number>;
  __notifyIncomingAnswerUiReady?: (info?: { source?: string; callId?: string | null }) => void;
  __connectingToRoomRef?: { roomName: string | null; session: VideoCallSession | null };
  __syncDirectCallAudioOnlyUiRef?: CallRef<((session: VideoCallSession | null) => void) | null>;
  __videoCallRoomDisconnectPromiseRef?: CallRef<Promise<void> | null>;
  __acceptedVideoCallNavCallIdRef?: CallRef<string | null>;
  __callTimerCallIdRef?: CallRef<string>;
  __acceptCallTimeRef?: CallRef<number>;
  __callConnectedAtRef?: CallRef<number | null>;
  __onVideoCallEndedRef?: CallRef<(() => void) | null>;
  __navRef?: NavigationContainerRef<RootStackParamList> | null;
  __enterSystemPiPAfterVideoCallRef?: CallRef<null>;
  __lastInAppPipAudioReapplyAtRef?: CallRef<number>;
  __lastInAppPipExternalOrchestratorAtRef?: CallRef<number>;
  __lastReturnToCallAtRef?: CallRef<number>;
  __lastSystemPiPEnteredAtRef?: CallRef<number>;
  __lastSystemPiPModeChangedAtRef?: CallRef<number>;
  __pipCallEndedWasInAppRef?: CallRef<boolean>;
  __pipCallEndedWasInSystemRef?: CallRef<boolean>;
  __pipDeferVisiblePendingRef?: CallRef<boolean>;
  __pipHidePiPRef?: CallRef<(() => void) | null>;
  __pipLastContextRef?: CallRef<{
    callId: string | null;
    roomId: string | null;
    navParams?: CallPiPNavigationParams;
  } | null>;
  __pipReturnToAudioCallRef?: CallRef<(() => void) | null>;
  __pipShowPiPRef?: CallRef<((params: CallPiPShowParams) => void) | null>;
  __pipSyncSessionStateRef?: CallRef<((nextInPiP: boolean, reason: string) => boolean) | null>;
  __suppressAbortDuringSystemPiPReturnUntilRef?: CallRef<number>;
  __systemPiPBounceIgnoreUntilRef?: CallRef<number>;
  __systemPiPLiViBackdropActiveRef?: CallRef<boolean>;
  __systemPiPReturnStateRef?: CallRef<SystemPiPReturnState | null>;
  __systemPiPWindowOpenRef?: CallRef<boolean>;

  __LIVI_SYS_PIP_HOME_TRACE__?: boolean;
  __activeHomePiPTraceIdRef?: CallRef<string | null>;
  __audioBuiltinMismatchRepinAtRef?: CallRef<number>;
  __btUnplugConfirmPendingRef?: CallRef<boolean>;
  __directCallAudioOnlyMountKeyRef?: CallRef<string | null>;
  __earlyDirectCallBootstrapRef?: CallRef<{
    callId: string;
    at: number;
    reused: boolean;
    kicked?: boolean;
    isCaller: boolean;
    startWithCamOff?: boolean;
  } | null>;
  __incomingAnswerNavPending?: boolean;
  __incomingCalleeAcceptHandoff?: boolean;
  __lastInAppPiPHeadsetConnectAtRef?: CallRef<number>;
  __lastInAppPiPHeadsetConnectRouteRef?: CallRef<InCallAudioRoute | null>;
  __outgoingCallMediaRef?: CallRef<'audio' | 'video' | null>;
  __pendingCallAcceptedRef?: CallRef<CallAcceptedPayload | null>;
  __promptBluetoothPermissionRef?: CallRef<((opts?: { ifHeadsetPresent?: boolean }) => Promise<boolean>) | null>;
  __suppressInAppPiPUntilRef?: CallRef<number>;
  __systemPiPLeaveContextSnapshotRef?: SystemPiPLeaveContext | null;
  __systemPiPSessionAudioOriginDecidedRef?: CallRef<boolean>;
  __systemPiPSessionAudioOriginRef?: CallRef<boolean>;
  __webrtcSessionRef?: CallRef<VideoCallSession | null>;
  __currentCallPiPParamsRef?: CallRef<CallPiPParams | null>;
  __activeCallAudioRouteCallIdRef?: CallRef<string>;
  __audioCallHomeSpeakerPinRef?: CallRef<boolean>;
  __audioUiExplicitCycleRouteRef?: CallRef<InCallAudioRoute | null>;
  __blockSystemPiPCaptureHostUntilRef?: CallRef<number>;
  __btAutoSuppressUntilRef?: CallRef<number>;
  __btExpectReconnectUntilRef?: CallRef<number>;
  __btKeepInCycleAfterManualLeaveRef?: CallRef<boolean>;
  __btRemovedFromCycleByUnplugRef?: CallRef<boolean>;
  __btWearStickyUntilRef?: CallRef<number>;
  __builtinCallAudioRouteBeforeHeadsetRef?: CallRef<BuiltinAudioRoute | null>;
  __callAudioBootstrapPendingRef?: CallRef<boolean>;
  __callAudioPreservePriorityUntilRef?: CallRef<number>;
  __callAudioPreferQuietUntilRef?: CallRef<number>;
  __callAudioReturnSyncRouteRef?: CallRef<InCallAudioRoute | null>;
  __callAudioReturnSyncAtRef?: CallRef<number>;
  __callAudioNativeTransitionUntilRef?: CallRef<number>;
  __callAudioUiLockedRouteRef?: CallRef<InCallAudioRoute | null>;
  __callAudioUiLockUntilRef?: CallRef<number>;
  __callBtHeadsetConnectedRef?: CallRef<boolean>;
  __callBuiltinRouteChoiceRef?: CallRef<BuiltinAudioRoute | null>;
  __directAudioEarpieceStabilizeUntilRef?: CallRef<number>;
  __directAudioInitialRouteNormalizedKeyRef?: CallRef<string>;
  __directCallAudioAcceptBootstrappedCallIdRef?: CallRef<string | null>;
  __directCallAudioOnlyPreparedAtRef?: CallRef<number>;
  __directCallIncomingAcceptAudioBootstrapRef?: CallRef<string | null>;
  __directCallUserRequestedVideoExpandRef?: CallRef<boolean>;
  __directCallVideoExpandAudioPreparedAtRef?: CallRef<number>;
  __directCallVideoExpandUntilRef?: CallRef<number>;
  __directCallVideoExpandInFlightRef?: CallRef<boolean>;
  __directCallVideoExpandLastBeginRef?: CallRef<number>;
  __directCallVideoExpandPromiseRef?: CallRef<Promise<void> | null>;
  __disableSystemPiPUntilRef?: CallRef<number>;
  __expandToVideoCallUiFromPiPRef?: CallRef<boolean>;
  __explicitBuiltInCallAudioRouteRef?: CallRef<boolean>;
  __inAppPiPExplicitToggleRouteRef?: CallRef<InCallAudioRoute | null>;
  // InCallManager supplies raw device names; native probes normalize separately.
  __inCallAvailableAudioRoutesRef?: CallRef<string[]>;
  __inCallSelectedAudioRouteRef?: CallRef<InCallAudioRoute | null>;
  __incomingAnswerTransitionRef?: CallRef<{ callId: string; expiresAt: number } | null>;
  __incomingCallScreenVisibleRef?: CallRef<boolean>;
  __lastAppliedCallAudioRouteRef?: CallRef<InCallAudioRoute | null>;
  __lastAppliedSystemPiPSnapRef?: SystemPiPReturnMediaSnapshot | null;
  __lastAudioHomePreserveAtRef?: CallRef<number>;
  __lastBluetoothRouteApplyAtRef?: CallRef<number>;
  __lastInAppPiPAudioToggleAtRef?: CallRef<number>;
  __lastCycleUserRouteAtRef?: CallRef<number>;
  __lastCycleUserRouteCallIdRef?: CallRef<string | null>;
  __lastCycleUserRouteResultRef?: CallRef<InCallAudioRoute | null>;
  __lastSystemPiPAudioPrepareAtRef?: CallRef<number>;
  __leavingVideoCallByBackRef?: CallRef<boolean>;
  __isInactiveStateRef?: CallRef<boolean>;
  __toggleMicRef?: CallRef<(() => void) | null>;
  __returnToAudioCallRef?: CallRef<((opts?: { fromPiP?: boolean; skipNavigation?: boolean }) => Promise<void>) | null>;
  __expandDirectCallToVideoUiRef?: CallRef<(() => Promise<void>) | null>;
  __leavingVideoCallByHomeRef?: CallRef<boolean>;
  __manualBuiltinCallAudioRouteRef?: CallRef<{
    route: BuiltinAudioRoute;
    callId: string;
    at: number;
  } | null>;
  __nativeCallAudioProbeLogSigRef?: CallRef<string>;
  __nativeCallAudioRoutesRef?: CallRef<NativeCallAudioProbe>;
  __outgoingCallPeerNickRef?: CallRef<string | null>;
  __outgoingCallPeerUserIdRef?: CallRef<string | null>;
  __outgoingCallScreenVisibleRef?: CallRef<boolean>;
  __persistedCallAudioRouteRef?: CallRef<InCallAudioRoute | null>;
  __pendingInAppPiPRestoreAfterSystemRef?: CallRef<boolean>;
  __systemPiPNeedsInAppRestoreRef?: CallRef<boolean>;
  __pipBuiltinRouteLockUntilRef?: CallRef<number>;
  __pipInAppRtcFromAudioOnlyRef?: CallRef<boolean>;
  __restoringInAppPiPFromSystemRef?: CallRef<boolean>;
  __returningFromSystemPiPUntilRef?: CallRef<number>;
  __socketActiveVideoCallRef?: CallRef<boolean>;
  __systemPiPEntryInProgressUntilRef?: CallRef<number>;
  __systemPiPReturnMediaRestoreTokenRef?: CallRef<number>;
  __systemPiPReturnMediaSnapshotRef?: SystemPiPReturnMediaSnapshot | null;
  __systemPiPReturnTokenRef?: CallRef<number>;
  __userSelectedCallAudioRouteRef?: CallRef<InCallAudioRoute | null>;
  __userSelectedExternalCallAudioRouteRef?: CallRef<{
    route: Extract<InCallAudioRoute, 'BLUETOOTH' | 'WIRED_HEADSET'>;
    until: number;
  } | null>;
  __videoCallPartnerUserIdRef?: CallRef<string | null>;
  __applyCallAudioRouteFromParentRef?: CallRef<((route: InCallAudioRoute, reason: string) => void) | null>;
  __onInAppPiPAudioRouteChanged?: (route: InCallAudioRoute) => void;
  __pipUpdateStateRef?: CallRef<((update: CallPiPStateUpdate) => void) | null>;
  __pipReturnToCallRef?: CallRef<((options?: { preferAudioOnlyUi?: boolean; restoreInAppPiP?: boolean }) => void) | null>;
  __syncDirectCallAudioRouteRef?: CallRef<(() => void) | null>;
};
