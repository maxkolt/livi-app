import { NativeModules, Platform } from 'react-native';
import { shouldUsePipPlaceholderOnly } from '../src/pip/pipPlaceholderOnly';

function resolveActiveCallPlaceholderOnly(): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const session = g.__webrtcSessionRef?.current;
    const remoteStream =
      params?.remoteStream ??
      (typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null);
    return shouldUsePipPlaceholderOnly({
      localCamOn: params?.localCamOn,
      remoteCamOn: params?.remoteCamOn,
      remoteStream,
    });
  } catch {
    return false;
  }
}

/** Android: ongoing-уведомление в шторке во время активного звонка (аудио — без system PiP, видео — в т.ч. PiP). */
export function startActiveCallNotification(
  partnerNick?: string | null,
  opts?: { audioOnly?: boolean },
): void {
  if (Platform.OS !== 'android') return;
  try {
    const nick = typeof partnerNick === 'string' ? partnerNick.trim() : '';
    const audioOnly = opts?.audioOnly ?? resolveActiveCallPlaceholderOnly();
    NativeModules.LiviAppModule?.startActiveCallForegroundService?.(nick || null, audioOnly);
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
    startActiveCallNotification(nick, { audioOnly: resolveActiveCallPlaceholderOnly() });
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
    if (!roomId && !callId) return false;

    const pipVisible =
      g.__pipForceHiddenRef?.current !== true &&
      (g.__pipVisibleRef?.current === true || g.__pipDeferVisiblePendingRef?.current === true);
    const onVideoCall =
      g.__navRef?.getCurrentRoute?.()?.name === 'VideoCall' && g.__videoCallActiveRef?.current !== false;

    return pipVisible || onVideoCall || !!roomId;
  } catch {
    return false;
  }
}

/** System PiP по Home — только для видеозвонка; аудио уходит в ongoing notification. */
export function shouldAllowAndroidSystemPiPOnLeaveHint(): boolean {
  if (!isAndroidActiveCallEligibleForLeaveHint()) return false;
  return !resolveActiveCallPlaceholderOnly();
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
      NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(!allowPiP);
      NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(allowPiP);
      return;
    }
    if (leaveHintDisableTimer) clearTimeout(leaveHintDisableTimer);
    leaveHintDisableTimer = setTimeout(() => {
      leaveHintDisableTimer = null;
      if (isAndroidActiveCallEligibleForLeaveHint()) return;
      NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
      NativeModules.LiviAppModule?.setSystemPiPCapturePlaceholderOnly?.(false);
    }, 320);
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
