/** Audio-only call UI flags (globals only — no PiP / session imports). */

export function isInAudioOnlyCallUi(): boolean {
  try {
    const g = global as any;
    // Явный return-to-audio: не давать stale stayOnVideo / preferVideoCallUi
    // перебить audio UI (иначе партнёру снова шлётся video-ui=true).
    if (
      g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true &&
      g.__inAudioOnlyUiRef?.current === true
    ) {
      return true;
    }
    if (g.__stayOnVideoCallUiRef?.current === true) {
      return false;
    }
    const params = g.__currentCallPiPParamsRef?.current;
    if (params?.preferVideoCallUi === true) {
      return false;
    }
    if (g.__inAudioOnlyUiRef?.current === true) {
      return true;
    }
    if (g.__pipAudioOnlyPlaceholderRef?.current === true) {
      const session = g.__webrtcSessionRef?.current;
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
  try {
    const g = global as any;
    g.__pipAudioOnlyPlaceholderRef = g.__pipAudioOnlyPlaceholderRef || { current: false };
    g.__pipAudioOnlyPlaceholderRef.current = !!active;
  } catch {}
}
