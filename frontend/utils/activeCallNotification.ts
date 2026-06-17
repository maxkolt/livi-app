import { AppState, NativeModules, Platform } from 'react-native';
import { isInAudioOnlyCallUi, shouldUsePipPlaceholderOnly, refreshSystemPiPLeaveContextSnapshot } from '../src/pip/pipPlaceholderOnly';
import { logHomePiPTrace } from './systemPiPHomeTrace';
import { isOngoingCallSession } from './activeCallSession';

/** Ongoing FGS: audio channel + return intent when пользователь на экране аудиозвонка. */
function resolveActiveCallNotificationAudioOnly(): boolean {
  try {
    const g = global as any;
    if (g.__stayOnVideoCallUiRef?.current === true) return false;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) return false;
    if (params?.inAudioOnlyUi === true) return true;
  } catch (_) {}
  if (isInAudioOnlyCallUi()) return true;
  return resolveActiveCallPlaceholderOnly();
}

function resolveActiveCallPlaceholderOnly(): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const session = g.__webrtcSessionRef?.current;
    const remoteStream =
      params?.remoteStream ??
      (typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null);
    const localStream =
      params?.localStream ??
      (typeof session?.getLocalStream === 'function' ? session.getLocalStream() : null);
    const localCamOn =
      params?.localCamOn ??
      (typeof session?.getIsCamOn === 'function' ? session.getIsCamOn() : undefined);
    const remoteCamOn =
      params?.remoteCamOn ??
      (typeof session?.getRemoteCamEnabled === 'function' ? session.getRemoteCamEnabled() : undefined);
    return shouldUsePipPlaceholderOnly({
      localCamOn,
      remoteCamOn,
      remoteStream,
      localStream,
    });
  } catch {
    return false;
  }
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
        '',
    ).trim();
    return { roomId, callId };
  } catch {
    return { roomId: '', callId: '' };
  }
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
    const route = g.__navRef?.getCurrentRoute?.()?.name;
    if (route === 'VideoCall' && g.__videoCallActiveRef?.current !== false) return true;
    if (AppState.currentState === 'background' && g.__videoCallActiveRef?.current !== false) return true;
  } catch (_) {}
  return false;
}

/** Android: ongoing-уведомление в шторке во время активного звонка (аудио — без system PiP, видео — в т.ч. PiP). */
export function startActiveCallNotification(
  partnerNick?: string | null,
  opts?: { audioOnly?: boolean },
): void {
  if (Platform.OS !== 'android') return;
  try {
    const nick = typeof partnerNick === 'string' ? partnerNick.trim() : '';
    const audioOnly = opts?.audioOnly ?? resolveActiveCallNotificationAudioOnly();
    NativeModules.LiviAppModule?.startActiveCallForegroundService?.(nick || null, audioOnly);
  } catch (_) {}
}

let lastNativeLeaveHintAllow: boolean | null = null;
let lastNativePlaceholderOnly: boolean | null = null;

/** System PiP: всегда заглушка LiVi (без RTC/capture), независимо от экрана звонка. */
export function shouldUseSystemPiPControlsCaptureOnly(): boolean {
  return true;
}

function applyAndroidLeaveHintNativeFlags(allowPiP: boolean): void {
  const effectiveAllow = allowPiP && shouldAllowAndroidSystemPiPOnLeaveHint();
  const placeholderOnly = effectiveAllow ? true : false;
  if (lastNativeLeaveHintAllow === effectiveAllow && lastNativePlaceholderOnly === placeholderOnly) {
    return;
  }
  lastNativeLeaveHintAllow = effectiveAllow;
  lastNativePlaceholderOnly = placeholderOnly;
  NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnly);
  if (placeholderOnly) {
    NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
  }
  NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(effectiveAllow);
  logHomePiPTrace('js_leave_hint_arm', { allowPiP: effectiveAllow, placeholderOnly });
}

/** Держать leaveHint включённым на любом экране, пока звонок жив (Home/in-app PiP до onUserLeaveHint). */
export function syncAndroidLeaveHintForOngoingCall(): void {
  if (Platform.OS !== 'android') return;
  try {
    if (!isOngoingCallSession()) return;
    if (!shouldAllowAndroidSystemPiPOnLeaveHint()) return;
    applyAndroidLeaveHintNativeFlags(true);
  } catch (_) {}
}

/** Синхронизировать shouldEnterPiPOnLeaveHint + placeholderOnly с текущим audio/video UI. */
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
      g.__navRef?.getCurrentRoute?.()?.name === 'VideoCall' && g.__videoCallActiveRef?.current !== false;
    const inBackgroundWithLiveCall =
      AppState.currentState === 'background' && g.__videoCallActiveRef?.current !== false;
    const ongoingSession = isOngoingCallSession();

    return (onVideoCallRoute || homeHold || inBackgroundWithLiveCall || ongoingSession) && (!!roomId || !!callId);
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
 */
export function armAndroidLeaveHintForVideoCallHome(): void {
  if (Platform.OS !== 'android') return;
  try {
    refreshSystemPiPLeaveContextSnapshot();
    const g = global as any;
    g.__leavingVideoCallByHomeRef = g.__leavingVideoCallByHomeRef || { current: false };
    g.__leavingVideoCallByHomeRef.current = true;
    g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
    g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 6000;
    if (!isAndroidActiveCallEligibleForLeaveHint() && !isOngoingCallSession()) {
      g.__leavingVideoCallByHomeRef.current = false;
      return;
    }
    applyAndroidLeaveHintNativeFlags(true);
  } catch (_) {}
}

/**
 * После возврата на VideoCall (уведомление, in-app PiP, разворот system PiP) натив может
 * остаться с shouldEnterPiPOnLeaveHint=false — повторный Home тогда сворачивает без system PiP.
 */
export function reenableAndroidSystemPiPLeaveHintAfterReturn(): void {
  if (Platform.OS !== 'android') return;
  const attempt = () => {
    try {
      if (!isAndroidActiveCallEligibleForLeaveHint()) return;
      const g = global as any;
      g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
      if (Number(g.__disableSystemPiPUntilRef.current || 0) > Date.now()) {
        g.__disableSystemPiPUntilRef.current = 0;
      }
      NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.();
      setAndroidSystemPiPLeaveHintEnabled(true);
    } catch (_) {}
  };
  attempt();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  }
  setTimeout(attempt, 320);
  setTimeout(attempt, 900);
  setTimeout(attempt, 1800);
}

/** Пока экран VideoCall в фокусе и звонок жив — держим leaveHint включённым (Home → system PiP). */
export function syncAndroidSystemPiPLeaveHintForActiveVideoCall(): void {
  syncAndroidSystemPiPNativeFlags();
}
