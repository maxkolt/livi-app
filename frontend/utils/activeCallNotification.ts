import { AppState, NativeModules, Platform } from 'react-native';
import { isInAudioOnlyCallUi, shouldUsePipPlaceholderOnly } from '../src/pip/pipPlaceholderOnly';
import { logHomePiPTrace } from './systemPiPHomeTrace';

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

function applyAndroidLeaveHintNativeFlags(_allowPiP: boolean): void {
  const allowPiP = false;
  const placeholderOnly = resolveActiveCallPlaceholderOnly();
  if (lastNativeLeaveHintAllow === allowPiP && lastNativePlaceholderOnly === placeholderOnly) {
    return;
  }
  lastNativeLeaveHintAllow = allowPiP;
  lastNativePlaceholderOnly = placeholderOnly;
  NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(placeholderOnly);
  NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
  logHomePiPTrace('js_leave_hint_arm', { allowPiP, placeholderOnly });
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

    return (onVideoCallRoute || homeHold) && (!!roomId || !!callId);
  } catch {
    return false;
  }
}

/** System PiP on Home / system navigation buttons is disabled app-wide. */
export function shouldAllowAndroidSystemPiPOnLeaveHint(): boolean {
  return false;
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
/** @deprecated System PiP on Home is disabled; ongoing notification handles background audio. */
export function armAndroidLeaveHintForVideoCallHome(): void {}

/**
 * После возврата на VideoCall (уведомление, in-app PiP, разворот system PiP) натив может
 * остаться с shouldEnterPiPOnLeaveHint=false — повторный Home тогда сворачивает без system PiP.
 */
export function reenableAndroidSystemPiPLeaveHintAfterReturn(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.();
    setAndroidSystemPiPLeaveHintEnabled(false);
  } catch (_) {}
}

/** Пока экран VideoCall в фокусе и звонок жив — держим leaveHint включённым (Home → system PiP). */
export function syncAndroidSystemPiPLeaveHintForActiveVideoCall(): void {
  syncAndroidSystemPiPNativeFlags();
}
