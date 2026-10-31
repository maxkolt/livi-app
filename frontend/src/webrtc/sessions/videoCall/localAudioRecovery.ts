type RecoverableAudioTrack = {
  mediaStreamTrack: { readyState: string; enabled: boolean; muted?: boolean };
  isUpstreamPaused: boolean;
  restartTrack(): Promise<unknown>;
  unmute(): Promise<unknown>;
  mute(): Promise<unknown>;
  resumeUpstream(): Promise<unknown>;
};

/** Keep the existing publication/sender when Android interrupts capture in the background. */
export async function recoverLocalAudioTrack(
  track: RecoverableAudioTrack,
  canRestore: () => boolean,
): Promise<void> {
  if (!canRestore()) return;
  if (track.mediaStreamTrack.readyState === 'ended' || track.mediaStreamTrack.muted) {
    await track.restartTrack();
    if (!canRestore()) {
      await track.mute();
      return;
    }
  }
  await track.unmute();
  if (!canRestore()) {
    await track.mute();
    return;
  }
  // LiveKit unmute() returns early when isMuted=false, even if native capture was disabled.
  if (!track.mediaStreamTrack.enabled) track.mediaStreamTrack.enabled = true;
  if (track.isUpstreamPaused) {
    await track.resumeUpstream();
    if (!canRestore()) await track.mute();
  }
}
