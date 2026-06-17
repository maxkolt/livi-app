import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { beginBackgroundMediaSuppression } from './callKeep';
import { applyNativeVoiceCallSpeaker } from './voiceCallAudioRoute';
import { logger } from './logger';
import { captureCallAudioRouteFromUi } from './activeCallSession';

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
let scheduledReapplyTimers: ReturnType<typeof setTimeout>[] = [];
let lastReapplySignature = '';
let lastReapplyAt = 0;
const REAPPLY_DEDUP_MS = 450;

function clearScheduledReapplies(): void {
  for (const t of scheduledReapplyTimers) {
    try {
      clearTimeout(t);
    } catch {}
  }
  scheduledReapplyTimers = [];
}

export async function reapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video' },
): Promise<void> {
  reapplyChain = reapplyChain
    .then(async () => {
      captureCallAudioRouteFromUi();
      const route = getPersistedCallAudioRoute();
      if (!route) return;

      const media = opts?.media ?? 'audio';
      const signature = `${route}|${media}`;
      const now = Date.now();
      if (signature === lastReapplySignature && now - lastReapplyAt < REAPPLY_DEDUP_MS) {
        logger.debug('[callAudioRoutePersist] reapply skipped (duplicate)', { reason, route, media });
        return;
      }
      lastReapplySignature = signature;
      lastReapplyAt = now;

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
  clearScheduledReapplies();
  const delays = opts?.delaysMs ?? [0, 300, 900, 1500, 2500];
  for (const ms of delays) {
    const timer = setTimeout(() => {
      scheduledReapplyTimers = scheduledReapplyTimers.filter((t) => t !== timer);
      void reapplyPersistedCallAudioRoute(reason, { media: opts?.media });
    }, ms);
    scheduledReapplyTimers.push(timer);
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
