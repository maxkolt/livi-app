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

/**
 * После возврата на VideoCall (уведомление, in-app PiP, разворот system PiP) натив может
 * остаться с shouldEnterPiPOnLeaveHint=false — повторный Home тогда сворачивает без system PiP.
 */
export function reenableAndroidSystemPiPLeaveHintAfterReturn(): void {
  if (Platform.OS !== 'android') return;
  const attempt = () => {
    try {
      const g = global as any;
      const session = g.__webrtcSessionRef?.current;
      if (!session) return;
      if (typeof session.isEnded === 'function' && session.isEnded()) return;
      const roomId =
        typeof session.getRoomId === 'function' ? String(session.getRoomId() || '').trim() : '';
      if (!roomId) return;
      g.__disableSystemPiPUntilRef = g.__disableSystemPiPUntilRef || { current: 0 };
      if (Number(g.__disableSystemPiPUntilRef.current || 0) > Date.now()) {
        g.__disableSystemPiPUntilRef.current = 0;
      }
      NativeModules.LiviAppModule?.clearSystemPiPReenterSuppress?.();
      NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true);
    } catch (_) {}
  };
  attempt();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(attempt));
  }
  setTimeout(attempt, 320);
  setTimeout(attempt, 900);
}
