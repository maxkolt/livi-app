import { AppState, NativeModules, Platform } from 'react-native';
import {
  isInAudioOnlyCallUi,
  shouldUseSystemPiPPlaceholderOnly,
  refreshSystemPiPLeaveContextSnapshot,
  markSystemPiPSessionAudioOrigin,
  mediaStreamHasLiveVideo,
} from '../src/pip/pipPlaceholderOnly';
import { logHomePiPTrace } from './systemPiPHomeTrace';
import {
  isOngoingCallSession,
  ongoingCallPrefersVideoMedia,
  resolveActiveCallInCallMedia,
  isDirectAudioEarpieceStabilizeWindow,
  readActiveExternalCallAudioRoute,
  isIncomingAnswerTransitionActive,
} from './activeCallSession';
import { readRootCurrentRouteName } from './safeRootNavigation';
import {
  pinLoudSpeakerForAudioCallLeavingToBackground,
  scheduleReapplyPersistedCallAudioRoute,
  isInAppPiPContextIncludingSuspended,
} from './callAudioRoutePersist';
import { isFreshDirectCallAudioAcceptCallActive } from './directCallVideoExpandGuard';

/**
 * Video system PiP: кадр уже есть до leave-hint — enterPictureInPictureMode
 * должен вызваться сразу в onUserLeaveHint (задержки → OEM не даёт войти).
 */
function hasSystemPiPVideoCaptureReady(): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const session = g.__webrtcSessionRef?.current;
    if (params?.localCamOn === true || params?.remoteCamOn === true) return true;
    if (ongoingCallPrefersVideoMedia()) return true;
    if (g.__stayOnVideoCallUiRef?.current === true) return true;
    const remote =
      (typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null) ??
      params?.remoteStream ??
      null;
    const local =
      (typeof session?.getLocalStream === 'function' ? session.getLocalStream() : null) ??
      params?.localStream ??
      null;
    if (mediaStreamHasLiveVideo(remote) || mediaStreamHasLiveVideo(local)) return true;
    if (typeof session?.getRemoteCamEnabled === 'function' && session.getRemoteCamEnabled()) {
      return true;
    }
    if (typeof session?.getIsCamOn === 'function' && session.getIsCamOn()) return true;
  } catch (_) {}
  return false;
}
/**
 * Ongoing FGS label: только явный audio-only UI.
 * Не выводить из PiP placeholder / cam-off — иначе video-звонок попадает в «аудио» канал
 * и return-intent ломает разворот.
 */
function resolveActiveCallNotificationAudioOnly(): boolean {
  try {
    const g = global as any;
    if (g.__stayOnVideoCallUiRef?.current === true) return false;
    if (ongoingCallPrefersVideoMedia()) return false;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) return false;
    if (params?.inAudioOnlyUi === true) return true;
    if (g.__inAudioOnlyUiRef?.current === true) return true;
  } catch (_) {}
  return isInAudioOnlyCallUi();
}

function isCallTeardownInProgress(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return true;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return true;
    if (g.__endingFromPiPButtonRef?.current === true) return true;
    if (g.__videoCallActiveRef?.current === false) return true;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return true;
  } catch (_) {}
  return false;
}

function getActiveCallIds(): { roomId: string; callId: string } {
  try {
    const g = global as any;
    const session = g.__webrtcSessionRef?.current;
    const params = g.__currentCallPiPParamsRef?.current;
    const roomId = String(
      params?.roomId ||
        (typeof session?.getRoomId === 'function' ? session.getRoomId() : '') ||
        '',
    ).trim();
    const callId = String(
      params?.callId ||
        (typeof session?.getCallId === 'function' ? session.getCallId() : '') ||
        g.__outgoingCallIdRef?.current ||
        '',
    ).trim();
    return { roomId, callId };
  } catch {
    return { roomId: '', callId: '' };
  }
}

function shouldBlockActiveCallNotificationStart(): boolean {
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return true;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return true;
    if (g.__endingFromPiPButtonRef?.current === true) return true;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return true;
    const { roomId, callId } = getActiveCallIds();
    if (g.__videoCallActiveRef?.current === false && !roomId && !callId) return true;
  } catch (_) {}
  return false;
}

/** Home / system PiP entry window — не сбрасывать leaveHint до onUserLeaveHint. */
export function isAndroidLeaveHintHomeTransitionHold(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    const g = global as any;
    if (g.__leavingVideoCallByHomeRef?.current === true) return true;
    const entryUntil = Number(g.__systemPiPEntryInProgressUntilRef?.current || 0);
    return entryUntil > Date.now();
  } catch {
    return false;
  }
}

/** Не выполнять delayed disarm: активный video-eligible звонок или переход Home. */
export function shouldBlockAndroidLeaveHintDisarm(): boolean {
  if (Platform.OS !== 'android') return false;
  if (isCallTeardownInProgress()) return false;
  if (!shouldAllowAndroidSystemPiPOnLeaveHint()) return false;
  const { roomId, callId } = getActiveCallIds();
  if (!roomId && !callId) return false;
  if (isAndroidLeaveHintHomeTransitionHold()) return true;
  if (isAndroidActiveCallEligibleForLeaveHint()) return true;
  try {
    const g = global as any;
    const route = readRootCurrentRouteName();
    if (route === 'VideoCall' && g.__videoCallActiveRef?.current !== false) return true;
    if (AppState.currentState === 'background' && g.__videoCallActiveRef?.current !== false) return true;
  } catch (_) {}
  return false;
}

/** Android: ongoing-уведомление в шторке во время активного звонка (аудио — без system PiP, видео — в т.ч. PiP). */
let lastFgsStartSignature = '';
let lastFgsStartAtMs = 0;
const FGS_START_DEDUP_MS = 900;

export function startActiveCallNotification(
  partnerNick?: string | null,
  opts?: { audioOnly?: boolean },
): void {
  if (Platform.OS !== 'android') return;
  try {
    if (shouldBlockActiveCallNotificationStart()) return;
    const nick = typeof partnerNick === 'string' ? partnerNick.trim() : '';
    const audioOnly = opts?.audioOnly ?? resolveActiveCallNotificationAudioOnly();
    const signature = `${audioOnly ? 'a' : 'v'}|${nick}`;
    const now = Date.now();
    if (signature === lastFgsStartSignature && now - lastFgsStartAtMs < FGS_START_DEDUP_MS) {
      return;
    }
    lastFgsStartSignature = signature;
    lastFgsStartAtMs = now;
    NativeModules.LiviAppModule?.startActiveCallForegroundService?.(nick || null, audioOnly);
    // FGS больше не форсит logo на video — сразу синхронизируем peer-cam placeholder/frameReady.
    try {
      syncAndroidSystemPiPNativeFlags();
    } catch (_) {}
  } catch (_) {}
}

let lastNativeLeaveHintAllow: boolean | null = null;
let lastNativePlaceholderOnly: boolean | null = null;
let lastNativeFrameReady: boolean | null = null;

/** System PiP: всегда разрешаем вход (лого или peer video). Не отменяем audio system PiP. */
export function shouldUseSystemPiPControlsCaptureOnly(): boolean {
  return true;
}

function resolveLeaveHintPlaceholderOnly(): boolean {
  try {
    // Не переписываем leave-snapshot на каждом leave-hint sync —
    // иначе logo→peer video в PiP сбрасывал preferAudioOnly и return уходил в video UI.
    return shouldUseSystemPiPPlaceholderOnly();
  } catch (_) {
    return true;
  }
}

function applyAndroidLeaveHintNativeFlags(allowPiP: boolean): void {
  const effectiveAllow = allowPiP && shouldAllowAndroidSystemPiPOnLeaveHint();
  const placeholderOnly = effectiveAllow ? resolveLeaveHintPlaceholderOnly() : false;
  // Video path: pre-arm frameReady пока камеры/live track уже есть —
  // иначе leave-hint ждёт кадр и промахивает окно enter на OEM.
  const frameReady = !effectiveAllow
    ? false
    : placeholderOnly
      ? true
      : hasSystemPiPVideoCaptureReady();
  if (
    lastNativeLeaveHintAllow === effectiveAllow &&
    lastNativePlaceholderOnly === placeholderOnly &&
    lastNativeFrameReady === frameReady
  ) {
    return;
  }
  lastNativeLeaveHintAllow = effectiveAllow;
  lastNativePlaceholderOnly = placeholderOnly;
  lastNativeFrameReady = frameReady;
  NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnly);
  if (placeholderOnly) {
    NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
  } else if (effectiveAllow) {
    NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(frameReady);
  }
  NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(effectiveAllow);
  logHomePiPTrace('js_leave_hint_arm', {
    allowPiP: effectiveAllow,
    placeholderOnly,
    frameReady,
  });
}

/**
 * Mid-PiP logo→peer video: сразу снять native backdrop и синхронизировать leave-hint cache,
 * чтобы следующий syncAndroidLeaveHint не вернул лого поверх RTC.
 */
export function forceAndroidSystemPiPPeerVideoVisible(): void {
  if (Platform.OS !== 'android') return;
  try {
    lastNativePlaceholderOnly = false;
    lastNativeFrameReady = true;
    NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(false);
    NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
    logHomePiPTrace('js_force_pip_peer_video', {});
  } catch (_) {}
}

/**
 * Параметры VideoCall при возврате по ongoing-уведомлению / system PiP fallback.
 * Без peerUserId/partnerNick после remount в шапке «—» или пустой ник.
 */
export function buildVideoCallReturnNavParams(
  params: Record<string, any> | null | undefined,
  opts: {
    preferAudioOnlyUi: boolean;
    returnToken: number;
  },
): Record<string, unknown> {
  const g = global as any;
  const navParams =
    params?.navParams && typeof params.navParams === 'object' && !Array.isArray(params.navParams)
      ? (params.navParams as Record<string, unknown>)
      : {};
  const partnerNick = String(
    navParams.partnerNick ||
      params?.partnerNick ||
      params?.partnerName ||
      g.__outgoingCallPeerNickRef?.current ||
      '',
  ).trim();
  const peerUserId = String(
    navParams.peerUserId ||
      navParams.partnerId ||
      params?.peerUserId ||
      g.__videoCallPartnerUserIdRef?.current ||
      g.__outgoingCallPeerUserIdRef?.current ||
      '',
  ).trim();
  return {
    ...navParams,
    resume: true,
    fromPiP: true,
    systemPiPReturnToken: opts.returnToken,
    callId: params?.callId,
    roomId: params?.roomId,
    directCall: true,
    ...(peerUserId ? { peerUserId } : {}),
    ...(partnerNick ? { partnerNick } : {}),
    ...(opts.preferAudioOnlyUi
      ? { audioOnlyPiPReturn: true, preferVideoCallUi: false }
      : { audioOnlyPiPReturn: false, preferVideoCallUi: true }),
  };
}

/** До монтирования VideoCall: callId/roomId + active ref, чтобы Home не попал в should_enter_false. */
export function primeAndroidCallContextForLeaveHint(opts: {
  callId?: string | null;
  roomId?: string | null;
  partnerNick?: string | null;
}): void {
  if (Platform.OS !== 'android') return;
  const callId = String(opts.callId ?? '').trim();
  const roomId = String(opts.roomId ?? '').trim();
  if (!callId && !roomId) return;
  try {
    const g = global as any;
    g.__videoCallActiveRef = g.__videoCallActiveRef || { current: false };
    g.__videoCallActiveRef.current = true;
    g.__currentCallPiPParamsRef = g.__currentCallPiPParamsRef || { current: null };
    const prev = g.__currentCallPiPParamsRef.current;
    const nick = typeof opts.partnerNick === 'string' ? opts.partnerNick.trim() : '';
    g.__currentCallPiPParamsRef.current = {
      ...(prev && typeof prev === 'object' ? prev : {}),
      callId: callId || prev?.callId || '',
      roomId: roomId || prev?.roomId || '',
      ...(nick ? { partnerName: nick } : {}),
    };
    // Incoming→Main task-switch: leaveHint+onUserLeaveHint даёт ложный PiP вместо VideoCall.
    if (isIncomingAnswerTransitionActive()) {
      applyAndroidLeaveHintNativeFlags(false);
      return;
    }
    applyAndroidLeaveHintNativeFlags(true);
  } catch (_) {}
}

/** Держать leaveHint включённым на любом экране, пока звонок жив (Home/in-app PiP до onUserLeaveHint). */
export function syncAndroidLeaveHintForOngoingCall(): void {
  if (Platform.OS !== 'android') return;
  try {
    if (isCallTeardownInProgress()) return;
    if (isIncomingAnswerTransitionActive()) {
      applyAndroidLeaveHintNativeFlags(false);
      return;
    }
    const { roomId, callId } = getActiveCallIds();
    if (roomId || callId) {
      applyAndroidLeaveHintNativeFlags(true);
      return;
    }
    if (!isOngoingCallSession()) return;
    if (!shouldAllowAndroidSystemPiPOnLeaveHint()) return;
    applyAndroidLeaveHintNativeFlags(true);
  } catch (_) {}
}

/** Синхронизировать shouldEnterPiPOnLeaveHint + placeholderOnly + frameReady с текущим audio/video UI. */
export function syncAndroidSystemPiPNativeFlags(): void {
  if (Platform.OS !== 'android') return;
  try {
    if (shouldBlockAndroidLeaveHintDisarm()) {
      setAndroidSystemPiPLeaveHintEnabled(true);
      return;
    }
    if (!isAndroidActiveCallEligibleForLeaveHint()) {
      setAndroidSystemPiPLeaveHintEnabled(false);
      return;
    }
    setAndroidSystemPiPLeaveHintEnabled(true);
  } catch (_) {}
}

/** Обновить текст ongoing-уведомления при переключении audio ↔ video UI. */
export function refreshAndroidActiveCallNotification(): void {
  if (Platform.OS !== 'android') return;
  try {
    const g = global as any;
    if (g.__videoCallActiveRef?.current === false) return;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return;
    const params = g.__currentCallPiPParamsRef?.current;
    const nick =
      (typeof params?.partnerName === 'string' ? params.partnerName : '') ||
      '';
    startActiveCallNotification(nick, { audioOnly: resolveActiveCallNotificationAudioOnly() });
    syncAndroidSystemPiPNativeFlags();
  } catch (_) {}
}

export function stopActiveCallNotification(): void {
  if (Platform.OS !== 'android') return;
  lastFgsStartSignature = '';
  lastFgsStartAtMs = 0;
  try {
    NativeModules.LiviAppModule?.stopActiveCallForegroundService?.();
  } catch (_) {}
}

/** Активный звонок: нативный leaveHint может быть включён (дальше проверяем audio/video). */
export function isAndroidActiveCallEligibleForLeaveHint(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    const g = global as any;
    if (g.__endingCallInProgressRef?.current === true) return false;
    if (g.__callEndedFromPiPNoOpenRef?.current === true) return false;
    if (g.__endingFromPiPButtonRef?.current === true) return false;
    if (g.__videoCallActiveRef?.current === false) return false;

    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.isEnded === 'function' && session.isEnded()) return false;

    const { roomId, callId } = getActiveCallIds();
    if (!roomId && !callId) return false;

    const homeHold = isAndroidLeaveHintHomeTransitionHold();
    const onVideoCallRoute =
      readRootCurrentRouteName() === 'VideoCall' && g.__videoCallActiveRef?.current !== false;
    const inBackgroundWithLiveCall =
      AppState.currentState === 'background' && g.__videoCallActiveRef?.current !== false;
    const ongoingSession = isOngoingCallSession();
    const inAppPiPVisible = g.__pipVisibleRef?.current === true;
    const incomingTransition = g.__incomingAnswerTransitionRef?.current;
    const incomingAnswerTransitionActive =
      !!incomingTransition && Number(incomingTransition.expiresAt || 0) > Date.now();
    const outgoingCallId = String(g.__outgoingCallIdRef?.current || '').trim();
    const onCallConnectTransition = incomingAnswerTransitionActive || !!outgoingCallId;

    return (
      (onVideoCallRoute ||
        homeHold ||
        inBackgroundWithLiveCall ||
        ongoingSession ||
        inAppPiPVisible ||
        onCallConnectTransition) &&
      (!!roomId || !!callId)
    );
  } catch {
    return false;
  }
}

/** System PiP on Home while an active call is in progress (controls bar capture, not full video UI). */
export function shouldAllowAndroidSystemPiPOnLeaveHint(): boolean {
  return isAndroidActiveCallEligibleForLeaveHint();
}

let leaveHintDisableTimer: ReturnType<typeof setTimeout> | null = null;

export function setAndroidSystemPiPLeaveHintEnabled(enabled: boolean): void {
  if (Platform.OS !== 'android') return;
  try {
    if (enabled) {
      if (leaveHintDisableTimer) {
        clearTimeout(leaveHintDisableTimer);
        leaveHintDisableTimer = null;
      }
      const allowPiP = shouldAllowAndroidSystemPiPOnLeaveHint();
      applyAndroidLeaveHintNativeFlags(allowPiP);
      return;
    }
    if (shouldBlockAndroidLeaveHintDisarm()) {
      if (leaveHintDisableTimer) {
        clearTimeout(leaveHintDisableTimer);
        leaveHintDisableTimer = null;
      }
      applyAndroidLeaveHintNativeFlags(true);
      return;
    }
  } catch (_) {
    return;
  }
  try {
    const g = global as any;
    if (g.__leavingVideoCallByHomeRef?.current === true) return;
    const entryUntil = Number(g.__systemPiPEntryInProgressUntilRef?.current || 0);
    if (entryUntil > Date.now()) return;
  } catch (_) {}
  if (leaveHintDisableTimer) clearTimeout(leaveHintDisableTimer);
  leaveHintDisableTimer = setTimeout(() => {
    leaveHintDisableTimer = null;
    try {
      if (shouldBlockAndroidLeaveHintDisarm()) {
        applyAndroidLeaveHintNativeFlags(true);
        return;
      }
      const g = global as any;
      if (g.__leavingVideoCallByHomeRef?.current === true) return;
      const entryUntil = Number(g.__systemPiPEntryInProgressUntilRef?.current || 0);
      if (entryUntil > Date.now()) return;
    } catch (_) {}
    if (isAndroidActiveCallEligibleForLeaveHint() && shouldAllowAndroidSystemPiPOnLeaveHint()) {
      applyAndroidLeaveHintNativeFlags(true);
      return;
    }
    lastNativeLeaveHintAllow = false;
    lastNativePlaceholderOnly = false;
    NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
    NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(false);
    logHomePiPTrace('js_leave_hint_disarm', { reason: 'delayed_disable' });
  }, 320);
}

/**
 * Сразу при Home (AppState background): закрепить refs и нативные флаги до onUserLeaveHint.
 * allowFromInAppPiP: Back→фон из in-app PiP тоже должен открыть system PiP.
 */
export function armAndroidLeaveHintForVideoCallHome(opts?: { allowFromInAppPiP?: boolean }): void {
  if (Platform.OS !== 'android') return;
  // Accept handoff: AppState inactive от Incoming/Main не должен готовить system/in-app PiP.
  if (isIncomingAnswerTransitionActive()) return;
  if (!opts?.allowFromInAppPiP) {
    try {
      if (isInAppPiPContextIncludingSuspended()) return;
    } catch {}
  }
  try {
    try {
      // Leave с audio UI → sticky return-to-audio (даже если в PiP потом появится peer video).
      if (isInAudioOnlyCallUi()) {
        markSystemPiPSessionAudioOrigin(true);
      }
    } catch (_) {}
    refreshSystemPiPLeaveContextSnapshot();
    const media = resolveActiveCallInCallMedia();
    if (media === 'audio') {
      const external = readActiveExternalCallAudioRoute();
      // Accept / AppState flicker: не гонять multi-delay preserve поверх BT settle.
      const acceptQuiet =
        isDirectAudioEarpieceStabilizeWindow() ||
        (() => {
          try {
            const cid = String(
              (global as any).__activeCallAudioRouteCallIdRef?.current ||
                (global as any).__currentCallPiPParamsRef?.current?.callId ||
                '',
            ).trim();
            return !!cid && isFreshDirectCallAudioAcceptCallActive(cid);
          } catch {
            return false;
          }
        })();
      if (external) {
        if (!acceptQuiet) {
          scheduleReapplyPersistedCallAudioRoute('audio_home_preserve_headset', {
            media: 'audio',
            delaysMs: [0],
            skipInCallRestart: true,
          });
        }
      } else if (!acceptQuiet) {
        pinLoudSpeakerForAudioCallLeavingToBackground();
        scheduleReapplyPersistedCallAudioRoute('audio_home_loud_speaker', {
          media: 'audio',
          delaysMs: [0, 500],
        });
      }
    }
    const g = global as any;
    // Home/фон штатно → system PiP: снять Back-guards и returning с прошлого expand.
    try {
      g.__leavingVideoCallByBackRef = g.__leavingVideoCallByBackRef || { current: false };
      g.__leavingVideoCallByBackRef.current = false;
      g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
      g.__returningFromSystemPiPUntilRef.current = 0;
      g.__blockSystemPiPCaptureHostUntilRef =
        g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
      g.__blockSystemPiPCaptureHostUntilRef.current = 0;
      g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
      g.__disableSystemPiPUntilRef.current = 0;
    } catch (_) {}
    g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
    g.__leavingVideoCallByHomeRef.current = true;
    g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
    g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 6000;
    if (!isAndroidActiveCallEligibleForLeaveHint() && !isOngoingCallSession()) {
      g.__leavingVideoCallByHomeRef.current = false;
      return;
    }
    applyAndroidLeaveHintNativeFlags(true);
    // До onUserLeaveHint: VideoCall уже в compact (только peer), иначе PiP захватит dual layout.
    try {
      const placeholderOnly = shouldUseSystemPiPPlaceholderOnly();
      g.__pendingSystemPiPSyncRef = g.__pendingSystemPiPSyncRef || { current: false };
      g.__pendingSystemPiPSyncRef.current = !placeholderOnly;
      const upd = g.__pipUpdateStateRef?.current;
      if (typeof upd === 'function') {
        if (placeholderOnly) {
          upd({
            pendingSystemPiP: false,
            systemPiPCaptureActive: false,
            systemPiPCaptureRequestId: 0,
            allowVideoRender: false,
          });
        } else {
          upd({
            pendingSystemPiP: true,
            systemPiPCaptureActive: false,
            systemPiPCaptureRequestId: 0,
            allowVideoRender: true,
          });
        }
      }
      NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnly);
      if (!placeholderOnly) {
        NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
      }
    } catch (_) {}
  } catch (_) {}
}

/**
 * Системный Back → фон. При активном звонке сначала arm leaveHint,
 * чтобы moveTaskToBack → onUserLeaveHint открыл system PiP (как Home).
 */
export function minimizeAndroidAppToBackground(): boolean {
  if (Platform.OS !== 'android') return false;
  try {
    const g = global as any;
    const ending =
      g.__endingCallInProgressRef?.current === true ||
      g.__callEndedFromPiPNoOpenRef?.current === true ||
      g.__endingFromPiPButtonRef?.current === true;
    const callActive =
      !ending &&
      (isAndroidActiveCallEligibleForLeaveHint() ||
        isOngoingCallSession() ||
        g.__videoCallActiveRef?.current === true ||
        g.__pipVisibleRef?.current === true ||
        g.__pipInSystemModeRef?.current === true);
    if (callActive) {
      // Явный Back/Home leave: не держать returning/block с прошлого expand.
      try {
        g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
        g.__returningFromSystemPiPUntilRef.current = 0;
        g.__blockSystemPiPCaptureHostUntilRef =
          g.__blockSystemPiPCaptureHostUntilRef || { current: 0 };
        g.__blockSystemPiPCaptureHostUntilRef.current = 0;
        g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
        g.__disableSystemPiPUntilRef.current = 0;
      } catch (_) {}
      armAndroidLeaveHintForVideoCallHome({ allowFromInAppPiP: true });
      try {
        setAndroidSystemPiPLeaveHintEnabled(true);
      } catch (_) {}
      try {
        syncAndroidLeaveHintForOngoingCall();
      } catch (_) {}
      try {
        // Native: enter system PiP then background (same as Home leave-hint).
        if (typeof NativeModules.LiviAppModule?.moveTaskToBackAndEnterPiP === 'function') {
          NativeModules.LiviAppModule.moveTaskToBackAndEnterPiP(true);
          return true;
        }
      } catch (_) {}
    }
  } catch (_) {}
  try {
    NativeModules.LiviAppModule?.moveTaskToBack?.(true);
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PIP_RETURN_SETTLE_MS = 3600;

let reenableAfterReturnGeneration = 0;
let reenableAfterReturnTimers: ReturnType<typeof setTimeout>[] = [];

function clearReenableAfterReturnTimers(): void {
  for (const t of reenableAfterReturnTimers) {
    clearTimeout(t);
  }
  reenableAfterReturnTimers = [];
}

/**
 * После возврата на VideoCall (уведомление, in-app PiP, разворот system PiP) натив может
 * остаться с shouldEnterPiPOnLeaveHint=false — повторный Home тогда сворачивает без system PiP.
 * clearSystemPiPReenterSuppress откладываем до стабилизации навигации (~3.6s), иначе обходим
 * нативный 3s anti-reenter и ловим повторный onUserLeaveHint → снова system PiP.
 */
export function reenableAndroidSystemPiPLeaveHintAfterReturn(opts?: {
  settledMs?: number;
  /** @internal после внешнего ожидания — сразу снять suppress и arm leaveHint */
  afterExternalSettle?: boolean;
}): void {
  if (Platform.OS !== 'android') return;
  clearReenableAfterReturnTimers();
  reenableAfterReturnGeneration += 1;
  const generation = reenableAfterReturnGeneration;
  const settledMs = opts?.afterExternalSettle
    ? 0
    : Math.max(0, opts?.settledMs ?? SYSTEM_PIP_RETURN_SETTLE_MS);

  const attempt = (clearSuppress: boolean) => {
    if (generation !== reenableAfterReturnGeneration) return;
    try {
      if (!isAndroidActiveCallEligibleForLeaveHint()) return;
      const g = global as any;
      g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
      if (Number(g.__disableSystemPiPUntilRef.current || 0) > Date.now()) {
        g.__disableSystemPiPUntilRef.current = 0;
      }
      if (clearSuppress) {
        NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.();
      }
      setAndroidSystemPiPLeaveHintEnabled(true);
    } catch (_) {}
  };

  const schedule = (delayMs: number, clearSuppress: boolean) => {
    const t = setTimeout(() => attempt(clearSuppress), delayMs);
    reenableAfterReturnTimers.push(t);
  };

  schedule(settledMs, true);
  schedule(settledMs + 320, true);
  schedule(settledMs + 900, true);
  schedule(settledMs + 1800, true);
}

/** Пока экран VideoCall в фокусе и звонок жив — держим leaveHint включённым (Home → system PiP). */
export function syncAndroidSystemPiPLeaveHintForActiveVideoCall(): void {
  syncAndroidSystemPiPNativeFlags();
}
