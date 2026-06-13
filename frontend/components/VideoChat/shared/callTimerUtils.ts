import type { MediaStream } from '@livekit/react-native-webrtc';

export function streamHasLiveRemoteAudio(stream: MediaStream | null | undefined): boolean {
  if (!stream) return false;
  try {
    const tracks = stream.getAudioTracks?.() ?? [];
    if (!tracks.length) return false;
    return tracks.some((t) => t.readyState === 'live') || tracks.length > 0;
  } catch {
    return false;
  }
}

export function partnerRemoteRtcLikelyVisible(opts: {
  showAudioPresentation: boolean;
  remoteCamOn: boolean;
  stream: MediaStream | null | undefined;
}): boolean {
  if (opts.showAudioPresentation) return false;
  if (!opts.remoteCamOn) return false;
  try {
    const vt = opts.stream?.getVideoTracks?.()?.[0];
    return !!vt && (vt.readyState === 'live' || vt.enabled !== false);
  } catch {
    return opts.remoteCamOn;
  }
}
