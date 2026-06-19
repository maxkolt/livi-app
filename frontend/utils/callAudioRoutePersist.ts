import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { beginBackgroundMediaSuppression } from './backgroundMediaSuppression';
import { applyNativeVoiceCallSpeaker } from './voiceCallAudioRoute';
import { logger } from './logger';
import {
  applySystemPiPReturnMediaSnapshot,
  captureCallAudioRouteFromUi,
  isAppInCallBackgroundState,
  isAudioOnlyOngoingCallContext,
  peekSystemPiPReturnMediaSnapshot,
  resolveActiveCallInCallMedia,
  resolvePersistedCallAudioRouteForReapply,
  readInAppPiPAudioOutputRoute,
  readLastAppliedCallAudioRoute,
  markDirectCallVideoMediaActive,
} from './activeCallSession';
import { isInAudioOnlyCallUi } from '../src/pip/pipPlaceholderOnly';

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

/** Home / фон с экрана «Аудиозвонок»: громкая связь (кроме Bluetooth). */
export function pinLoudSpeakerForAudioCallLeavingToBackground(): void {
  if (!isAudioOnlyOngoingCallContext()) return;
  if (resolveActiveCallInCallMedia() === 'video') return;
  captureCallAudioRouteFromUi();
  const fromParams = normalizeInCallRoute(
    (global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
  );
  const stored = getPersistedCallAudioRoute();
  const lastApplied = readLastAppliedCallAudioRoute();
  const route =
    (lastApplied && isExternalHeadsetRoute(lastApplied) ? lastApplied : null) ||
    fromParams ||
    stored ||
    'EARPIECE';
  if (isExternalHeadsetRoute(route)) return;
  setPersistedCallAudioRoute('SPEAKER_PHONE');
  try {
    const g = global as any;
    g.__audioCallHomeSpeakerPinRef = g.__audioCallHomeSpeakerPinRef || { current: false };
    g.__audioCallHomeSpeakerPinRef.current = true;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = 'SPEAKER_PHONE';
    }
  } catch {}
}

/** После возврата с Home: снова разговорный на экране «Аудиозвонок». */
export function restoreAudioCallEarpieceAfterHomeReturn(): void {
  try {
    const g = global as any;
    if (g.__audioCallHomeSpeakerPinRef?.current !== true) return;
    g.__audioCallHomeSpeakerPinRef.current = false;
    if (!isAudioOnlyOngoingCallContext()) return;
    const snapRoute = normalizeInCallRoute(peekSystemPiPReturnMediaSnapshot()?.audioRoute || '');
    if (snapRoute && isExternalHeadsetRoute(snapRoute)) {
      setPersistedCallAudioRoute(snapRoute);
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = snapRoute;
      }
      return;
    }
    const persisted = getPersistedCallAudioRoute();
    if (persisted && isExternalHeadsetRoute(persisted)) return;
    const lastApplied = readLastAppliedCallAudioRoute();
    if (lastApplied && isExternalHeadsetRoute(lastApplied)) {
      setPersistedCallAudioRoute(lastApplied);
      const params = g.__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = lastApplied;
      }
      return;
    }
    setPersistedCallAudioRoute('EARPIECE');
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = 'EARPIECE';
    }
  } catch {}
}

/** Video UI / PiP с видео: громкая связь в persist и PiP params (не audio-only). */
export function pinVideoCallLoudSpeakerRoute(): void {
  if (isInAudioOnlyCallUi()) return;
  markDirectCallVideoMediaActive();
  setPersistedCallAudioRoute('SPEAKER_PHONE');
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = 'SPEAKER_PHONE';
      params.preferVideoCallUi = true;
      params.inAudioOnlyUi = false;
    }
  } catch {}
}

let reapplyChain = Promise.resolve();
let scheduledReapplyTimers: ReturnType<typeof setTimeout>[] = [];
let lastReapplySignature = '';
let lastReapplyAt = 0;
const REAPPLY_DEDUP_MS = 900;

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
      let stored = getPersistedCallAudioRoute();
      const preserveInAppPiP =
        shouldPreserveCallAudioRouteInInAppPiP() && !isAppInCallBackgroundState();
      if (preserveInAppPiP) {
        const preserved = readInAppPiPAudioOutputRoute();
        stored = preserved;
        setPersistedCallAudioRoute(preserved);
      }
      const route = preserveInAppPiP
        ? stored
        : resolvePersistedCallAudioRouteForReapply(stored);
      if (!route) return;
      if (route !== stored) {
        setPersistedCallAudioRoute(route);
      }

      const media = opts?.media ?? (isInAudioOnlyCallUi() ? 'audio' : resolveActiveCallInCallMedia());
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

/** In-app PiP: сохранить earpiece / speaker / BT (audio- и video-экран). */
export function shouldPreserveCallAudioRouteInInAppPiP(): boolean {
  try {
    if (isInAudioOnlyCallUi()) return false;
    const g = global as any;
    if (g.__pipVisibleRef?.current !== true) return false;
    if (g.__pipInSystemModeRef?.current === true) return false;
    return true;
  } catch {
    return false;
  }
}

/** После разворота system PiP: mic + динамик как до ухода на Home. */
export function restoreCallMediaAfterSystemPiPReturn(): boolean {
  const g = global as any;
  const token = Number(g.__systemPiPReturnTokenRef?.current || 0);
  g.__systemPiPReturnMediaRestoreTokenRef =
    g.__systemPiPReturnMediaRestoreTokenRef || { current: 0 };
  if (token && g.__systemPiPReturnMediaRestoreTokenRef.current === token) {
    return false;
  }
  if (!applySystemPiPReturnMediaSnapshot()) return false;
  if (token) {
    g.__systemPiPReturnMediaRestoreTokenRef.current = token;
  }
  scheduleReapplyPersistedCallAudioRoute('system_pip_return_media', {
    media: resolveActiveCallInCallMedia(),
    delaysMs: [0, 250, 800, 1500],
  });
  return true;
}
