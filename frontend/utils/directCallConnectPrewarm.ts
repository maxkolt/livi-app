import { createLocalTracks, type LocalAudioTrack, type LocalTrack } from 'livekit-client';
import { Platform } from 'react-native';
import { getIceConfiguration } from './iceConfig';
import { logger } from './logger';
import { mergeNativeProbeIntoGlobal, probeNativeCallAudioRoutes } from './nativeCallAudioProbe';

const PREWARM_TTL_MS = 120_000;

type AudioPrewarmEntry = {
  track: LocalAudioTrack;
  createdAt: number;
  reason: string;
};

let icePrefetchInFlight: Promise<void> | null = null;
let audioPrewarmInFlight: Promise<void> | null = null;
let audioPrewarmGeneration = 0;

function getAudioPrewarmRef(): { current: AudioPrewarmEntry | null } {
  const g = global as any;
  g.__directCallAudioPrewarmRef = g.__directCallAudioPrewarmRef || { current: null as AudioPrewarmEntry | null };
  return g.__directCallAudioPrewarmRef as { current: AudioPrewarmEntry | null };
}

function isLiveAudioTrack(track: LocalAudioTrack | null | undefined): boolean {
  const mediaTrack = track?.mediaStreamTrack;
  return !!mediaTrack && mediaTrack.readyState === 'live';
}

export function prefetchDirectCallIce(reason: string): void {
  if (icePrefetchInFlight) return;
  icePrefetchInFlight = getIceConfiguration(false)
    .then(() => {
      logger.debug('[directCallPrewarm] ICE prefetch done', { reason });
    })
    .catch((e) => {
      logger.warn('[directCallPrewarm] ICE prefetch failed', {
        reason,
        error: (e as Error)?.message || String(e),
      });
    })
    .finally(() => {
      icePrefetchInFlight = null;
    });
}

export function prewarmDirectCallAudioCapture(reason: string): void {
  if (Platform.OS === 'android') {
    void probeNativeCallAudioRoutes()
      .then((probe) => mergeNativeProbeIntoGlobal(probe))
      .catch(() => {});
  }
  if (audioPrewarmInFlight) return;
  const ref = getAudioPrewarmRef();
  const existing = ref.current;
  if (existing && isLiveAudioTrack(existing.track) && Date.now() - existing.createdAt < PREWARM_TTL_MS) {
    return;
  }
  disposeDirectCallAudioPrewarm('replace-before-prewarm');
  const generation = audioPrewarmGeneration;

  audioPrewarmInFlight = createLocalTracks({ audio: true, video: false })
    .then((tracks: LocalTrack[]) => {
      const audioTrack = tracks.find((track) => track.kind === 'audio') as LocalAudioTrack | undefined;
      for (const track of tracks) {
        if (track !== audioTrack) {
          try { track.stop(); } catch {}
        }
      }
      if (!audioTrack || !isLiveAudioTrack(audioTrack)) {
        try { audioTrack?.stop(); } catch {}
        return;
      }
      if (generation !== audioPrewarmGeneration) {
        try { audioTrack.stop(); } catch {}
        return;
      }
      ref.current = {
        track: audioTrack,
        createdAt: Date.now(),
        reason,
      };
      logger.info('[directCallPrewarm] Audio capture prewarmed', { reason });
    })
    .catch((e) => {
      logger.warn('[directCallPrewarm] Audio prewarm failed', {
        reason,
        error: (e as Error)?.message || String(e),
      });
    })
    .finally(() => {
      audioPrewarmInFlight = null;
    });
}

export function adoptDirectCallAudioPrewarm(): LocalAudioTrack | null {
  const ref = getAudioPrewarmRef();
  const entry = ref.current;
  if (!entry) return null;
  if (!isLiveAudioTrack(entry.track) || Date.now() - entry.createdAt > PREWARM_TTL_MS) {
    disposeDirectCallAudioPrewarm('stale-adopt');
    return null;
  }
  ref.current = null;
  logger.info('[directCallPrewarm] Adopted audio capture', { reason: entry.reason });
  return entry.track;
}

export function disposeDirectCallAudioPrewarm(reason: string): void {
  audioPrewarmGeneration += 1;
  const ref = getAudioPrewarmRef();
  const entry = ref.current;
  ref.current = null;
  if (!entry) return;
  try { entry.track.stop(); } catch {}
  logger.debug('[directCallPrewarm] Disposed audio capture', {
    reason,
    prewarmReason: entry.reason,
  });
}

