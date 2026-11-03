import type { MediaStream } from '@livekit/react-native-webrtc';

/** A cached stream can outlive its native track after SDK reconnect or camera restart. */
export function selectLiveVideoStream(...streams: Array<MediaStream | null | undefined>): MediaStream | null {
  for (const stream of streams) {
    try {
      if (stream?.getVideoTracks().some(track => track.readyState === 'live')) return stream;
    } catch { /* The SDK can already have disposed the native stream. */ }
  }
  return null;
}
