import { NativeModules, Platform } from 'react-native';

/** Android: ongoing-уведомление в шторке во время активного видеозвонка (в т.ч. PiP). */
export function startActiveCallNotification(partnerNick?: string | null): void {
  if (Platform.OS !== 'android') return;
  try {
    const nick = typeof partnerNick === 'string' ? partnerNick.trim() : '';
    NativeModules.LiviAppModule?.startActiveCallForegroundService?.(nick || null);
  } catch (_) {}
}

export function stopActiveCallNotification(): void {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.stopActiveCallForegroundService?.();
  } catch (_) {}
}

/** Активный звонок: системный PiP по Home должен оставаться разрешённым. */
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
        ''
    ).trim();
    const callId = String(
      params?.callId ||
        (typeof session?.getCallId === 'function' ? session.getCallId() : '') ||
        ''
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

let leaveHintDisableTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Включение — сразу; выключение — с короткой задержкой и повторной проверкой активного звонка,
 * чтобы несколько эффектов не «мигали» false→true и не блокировали system PiP после циклов in-app/Home.
 */
export function setAndroidSystemPiPLeaveHintEnabled(enabled: boolean): void {
  if (Platform.OS !== 'android') return;
  try {
    if (enabled) {
      if (leaveHintDisableTimer) {
        clearTimeout(leaveHintDisableTimer);
        leaveHintDisableTimer = null;
      }
      NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true);
      return;
    }
    if (leaveHintDisableTimer) clearTimeout(leaveHintDisableTimer);
    leaveHintDisableTimer = setTimeout(() => {
      leaveHintDisableTimer = null;
      if (isAndroidActiveCallEligibleForLeaveHint()) return;
      NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false);
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
