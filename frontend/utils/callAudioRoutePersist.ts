import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { beginBackgroundMediaSuppression } from './callKeep';
import { applyNativeVoiceCallSpeaker } from './voiceCallAudioRoute';
import { logger } from './logger';

export function setPersistedCallAudioRoute(route: InCallAudioRoute): void {
  try {
    const g = global as any;
    g.__persistedCallAudioRouteRef = g.__persistedCallAudioRouteRef || { current: null };
    g.__persistedCallAudioRouteRef.current = route;
  } catch {}
}

export function getPersistedCallAudioRoute(): InCallAudioRoute | null {
  try {
    return normalizeInCallRoute((global as any).__persistedCallAudioRouteRef?.current || '');
  } catch {
    return null;
  }
}

export function clearPersistedCallAudioRoute(): void {
  try {
    const g = global as any;
    if (g.__persistedCallAudioRouteRef) g.__persistedCallAudioRouteRef.current = null;
  } catch {}
}

let reapplyChain = Promise.resolve();

export async function reapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video' },
): Promise<void> {
  reapplyChain = reapplyChain
    .then(async () => {
      const route = getPersistedCallAudioRoute();
      if (!route) return;

      const media = opts?.media ?? 'audio';
      try {
        if (Platform.OS === 'android') beginBackgroundMediaSuppression();
        InCallManager.start({ media, ringback: '' });
        try {
          (InCallManager as any).requestAudioFocus?.();
        } catch {}
      } catch {}

      if (route === 'SPEAKER_PHONE') {
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(true);
          InCallManager.setSpeakerphoneOn(true);
          void (InCallManager as any).chooseAudioRoute?.('SPEAKER_PHONE');
        } catch {}
        await applyNativeVoiceCallSpeaker(true);
      } else if (route === 'EARPIECE') {
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(false);
          InCallManager.setSpeakerphoneOn(false);
          void (InCallManager as any).chooseAudioRoute?.('EARPIECE');
        } catch {}
        await applyNativeVoiceCallSpeaker(false);
      } else if (isExternalHeadsetRoute(route)) {
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(false);
          InCallManager.setSpeakerphoneOn(false);
          await (InCallManager as any).chooseAudioRoute?.(route);
        } catch {}
      }

      logger.info('[callAudioRoutePersist] reapply', { reason, route, media });
    })
    .catch(() => {});
}

export function scheduleReapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; delaysMs?: number[] },
): void {
  const delays = opts?.delaysMs ?? [0, 300, 900, 1500, 2500];
  for (const ms of delays) {
    setTimeout(() => {
      void reapplyPersistedCallAudioRoute(reason, { media: opts?.media });
    }, ms);
  }
}

/** In-app PiP с экрана «Аудиозвонок»: сохранить earpiece / speaker / BT. */
export function shouldPreserveCallAudioRouteInInAppPiP(): boolean {
  try {
    const g = global as any;
    if (g.__pipInAppRtcFromAudioOnlyRef?.current === true) return true;
    return false;
  } catch {
    return false;
  }
}
