/** Активен экран «аудиозвонок» (ещё не перешли на video UI). */
export function isInAudioOnlyCallUi(): boolean {
  try {
    const g = global as any;
    if (g.__inAudioOnlyUiRef?.current === true) {
      return true;
    }
    // VideoCall может размонтироваться при Home → system PiP; sticky ref сохраняет audio-only до endCall.
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

export function mediaStreamHasLiveVideo(stream: unknown): boolean {
  try {
    const t = (stream as any)?.getVideoTracks?.()?.[0];
    return !!t && t.readyState === 'live' && t.enabled !== false;
  } catch {
    return false;
  }
}

/** System / in-app PiP: не монтировать RTCView, показывать заглушку LiVi. */
export function shouldUsePipPlaceholderOnly(opts?: {
  localCamOn?: boolean;
  remoteCamOn?: boolean;
  remoteStream?: unknown;
}): boolean {
  if (isInAudioOnlyCallUi()) {
    return true;
  }
  if (opts?.localCamOn === true || opts?.remoteCamOn === true) {
    return false;
  }
  if (mediaStreamHasLiveVideo(opts?.remoteStream)) {
    return false;
  }
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.shouldUsePlaceholderPiP === 'function') {
      return session.shouldUsePlaceholderPiP();
    }
  } catch {}
  return false;
}
