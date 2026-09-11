/**
 * Audio-only call UI policy (поверх callRuntime, без PiP imports).
 * Сырые флаги — в callRuntime; здесь составное решение «сейчас audio UI?».
 */
import {
  getWebrtcSession,
  isInAudioOnlyUi,
  isPipAudioOnlyPlaceholder,
  isPreferAudioOnlyUiOnNextVideoCall,
  isStayOnVideoCallUi,
  setPipAudioOnlyPlaceholder,
} from './callRuntime';

export function isInAudioOnlyCallUi(): boolean {
  try {
    // Явный return-to-audio: не давать stale stayOnVideo / preferVideoCallUi
    // перебить audio UI (иначе партнёру снова шлётся video-ui=true).
    if (isPreferAudioOnlyUiOnNextVideoCall() && isInAudioOnlyUi()) {
      return true;
    }
    if (isStayOnVideoCallUi()) {
      return false;
    }
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) {
      return false;
    }
    if (isInAudioOnlyUi()) {
      return true;
    }
    if (isPipAudioOnlyPlaceholder()) {
      const session = getWebrtcSession();
      const callLive =
        session && typeof session.isEnded === 'function' ? !session.isEnded() : !!session;
      if (callLive) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function setPipAudioOnlyPlaceholderSticky(active: boolean): void {
  setPipAudioOnlyPlaceholder(!!active);
}
