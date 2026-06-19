import { Platform, NativeModules } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { beginBackgroundMediaSuppression } from './backgroundMediaSuppression';
import { applyNativeVoiceCallSpeaker, applyNativeVoiceCallRoute } from './voiceCallAudioRoute';
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
  readActiveExternalCallAudioRoute,
  markDirectCallVideoMediaActive,
  restoreOngoingCallMicrophoneIfEnabled,
  isOngoingCallSession,
} from './activeCallSession';
import { isInAudioOnlyCallUi } from '../src/pip/pipPlaceholderOnly';
import { resolveCallRouteAfterHeadsetDisconnect, rememberBuiltinCallRouteBeforeHeadset } from './callHeadsetAudioFallback';
import { readNativeProbedExternalRoute, mergeNativeProbeIntoGlobal, probeNativeCallAudioRoutes } from './nativeCallAudioProbe';

function readAvailableAudioDeviceList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

const CALL_AUDIO_PRESERVE_PRIORITY_MS = 4000;

/** Окно enter/exit system PiP и возврата — не форсить громкую связь поверх earpiece/BT. */
export function isCallAudioPiPTransitionWindow(): boolean {
  try {
    const g = global as any;
    const now = Date.now();
    if (now < Number(g.__returningFromSystemPiPUntilRef?.current || 0)) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (now < Number(g.__systemPiPEntryInProgressUntilRef?.current || 0)) return true;
    if (now < Number(g.__callAudioPreservePriorityUntilRef?.current || 0)) return true;
  } catch {}
  return false;
}

export function armCallAudioPreservePriority(ms = CALL_AUDIO_PRESERVE_PRIORITY_MS): void {
  try {
    const g = global as any;
    g.__callAudioPreservePriorityUntilRef = g.__callAudioPreservePriorityUntilRef || { current: 0 };
    g.__callAudioPreservePriorityUntilRef.current = Math.max(
      Number(g.__callAudioPreservePriorityUntilRef.current || 0),
      Date.now() + ms,
    );
  } catch {}
}

export function readPreferredCallAudioRouteForTransition(): InCallAudioRoute {
  const snap = peekSystemPiPReturnMediaSnapshot();
  const fromSnap = normalizeInCallRoute(snap?.audioRoute || '');
  if (fromSnap) return fromSnap;
  return readInAppPiPAudioOutputRoute();
}

/** Громкая связь на Home только для audio-only без гарнитуры и вне PiP-переходов. */
export function shouldApplyHomeLoudSpeakerPin(): boolean {
  try {
    if (isInAppPiPContextIncludingSuspended()) return false;
  } catch {}
  if (!isAudioOnlyOngoingCallContext()) return false;
  if (resolveActiveCallInCallMedia() === 'video') return false;
  if (readActiveExternalCallAudioRoute()) return false;
  if (isCallAudioPiPTransitionWindow()) return false;

  const preferred = readPreferredCallAudioRouteForTransition();
  if (isExternalHeadsetRoute(preferred)) return false;
  if (preferred === 'EARPIECE') return false;
  return true;
}

function schedulePreserveCallAudioRoute(reason: string, media?: 'audio' | 'video'): void {
  const route = readPreferredCallAudioRouteForTransition();
  setPersistedCallAudioRoute(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__lastAppliedCallAudioRouteRef = { current: route };
  } catch {}
  armCallAudioPreservePriority();
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media: media ?? resolveActiveCallInCallMedia(),
    delaysMs: [0, 400, 1200],
  });
}

/** In-app PiP, suspend под system PiP или restore с system PiP — плашка «активна» для audio guards. */
export function isInAppPiPContextIncludingSuspended(): boolean {
  try {
    const g = global as any;
    return (
      g.__pipVisibleRef?.current === true ||
      g.__pipSuspendedForSystemPiPRef?.current === true ||
      g.__restoringInAppPiPFromSystemRef?.current === true
    );
  } catch {
    return false;
  }
}

function shouldKeepExternalRouteDespiteMissingFromList(route: InCallAudioRoute): boolean {
  if (!isExternalHeadsetRoute(route)) return false;
  try {
    if (readNativeProbedExternalRoute() === route) return true;
    const lastApplied = readLastAppliedCallAudioRoute();
    if (lastApplied === route && isOngoingCallSession()) return true;
    const g = global as any;
    if (shouldPreserveCallAudioRouteInInAppPiP() || isInAppPiPContextIncludingSuspended()) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (readActiveExternalCallAudioRoute() === route) return true;
  } catch {}
  return false;
}

function coercePersistedRouteForAvailableDevices(route: InCallAudioRoute): InCallAudioRoute {
  try {
    const list = readAvailableAudioDeviceList();
    if (!list.length) return route;
    if (!list.includes(route) && shouldKeepExternalRouteDespiteMissingFromList(route)) {
      return route;
    }
    if (route === 'BLUETOOTH' && !list.includes('BLUETOOTH')) {
      if (readNativeProbedExternalRoute() === 'BLUETOOTH') return route;
      return resolveCallRouteAfterHeadsetDisconnect();
    }
    if (route === 'WIRED_HEADSET' && !list.includes('WIRED_HEADSET')) {
      if (readNativeProbedExternalRoute() === 'WIRED_HEADSET') return route;
      return resolveCallRouteAfterHeadsetDisconnect();
    }
  } catch {}
  return route;
}

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
  lastNativeInCallSignature = '';
  lastReapplySignature = '';
}

/** Home / фон с экрана «Аудиозвонок»: громкая связь (кроме Bluetooth / провода). */
export function pinLoudSpeakerForAudioCallLeavingToBackground(): void {
  try {
    if (isInAppPiPContextIncludingSuspended()) return;
  } catch {}
  if (!isAudioOnlyOngoingCallContext()) return;
  if (resolveActiveCallInCallMedia() === 'video') return;
  const externalIntent = readActiveExternalCallAudioRoute();
  if (externalIntent) {
    setPersistedCallAudioRoute(externalIntent);
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = externalIntent;
      }
      (global as any).__lastAppliedCallAudioRouteRef = { current: externalIntent };
    } catch {}
    scheduleReapplyPersistedCallAudioRoute('pin_preserve_headset', {
      media: 'audio',
      delaysMs: [0, 400, 1200],
    });
    return;
  }
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

  const available = readAvailableAudioDeviceList();
  if (available.includes('BLUETOOTH')) {
    setPersistedCallAudioRoute('BLUETOOTH');
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = 'BLUETOOTH';
      }
    } catch {}
    return;
  }
  if (available.includes('WIRED_HEADSET')) {
    setPersistedCallAudioRoute('WIRED_HEADSET');
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = 'WIRED_HEADSET';
      }
    } catch {}
    return;
  }

  if (!shouldApplyHomeLoudSpeakerPin()) {
    const keep = readPreferredCallAudioRouteForTransition();
    setPersistedCallAudioRoute(keep);
    try {
      const params = (global as any).__currentCallPiPParamsRef?.current;
      if (params && typeof params === 'object') {
        params.audioOutputRoute = keep;
      }
      (global as any).__lastAppliedCallAudioRouteRef = { current: keep };
    } catch {}
    return;
  }

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

/** Video PiP / UI: громкая вместо разговорного, BT и провод — без смены. */
export function resolveVideoInAppPiPAudioRoute(
  preferred?: InCallAudioRoute | string | null,
): InCallAudioRoute {
  const external = readActiveExternalCallAudioRoute(preferred);
  if (external) return external;
  const norm = normalizeInCallRoute(preferred || '');
  if (isExternalHeadsetRoute(norm)) return norm;
  const pip = readInAppPiPAudioOutputRoute();
  if (isExternalHeadsetRoute(pip)) return pip;
  if (norm === 'EARPIECE') return 'SPEAKER_PHONE';
  return norm || 'SPEAKER_PHONE';
}

function writeVideoCallPiPRouteToParams(route: InCallAudioRoute): void {
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
      params.preferVideoCallUi = true;
      params.inAudioOnlyUi = false;
    }
  } catch {}
}

/** Video in-app PiP: сохранить маршрут (в т.ч. Bluetooth) в persist и params. */
export function persistVideoInAppPiPAudioRoute(preferred?: InCallAudioRoute | string | null): void {
  if (isInAudioOnlyCallUi()) return;
  markDirectCallVideoMediaActive();
  const route = resolveVideoInAppPiPAudioRoute(preferred);
  if (isExternalHeadsetRoute(route)) {
    const hint =
      readLastAppliedCallAudioRoute() ||
      getPersistedCallAudioRoute() ||
      normalizeInCallRoute(preferred || '');
    rememberBuiltinCallRouteBeforeHeadset(hint, false);
  }
  setPersistedCallAudioRoute(route);
  writeVideoCallPiPRouteToParams(route);
}

/** Video UI / PiP с видео: громкая связь в persist и PiP params (не audio-only). */
export function pinVideoCallLoudSpeakerRoute(): void {
  if (isInAudioOnlyCallUi()) return;
  persistVideoInAppPiPAudioRoute('SPEAKER_PHONE');
}

let reapplyChain = Promise.resolve();
let scheduledReapplyTimers: ReturnType<typeof setTimeout>[] = [];
let lastReapplySignature = '';
let lastReapplyAt = 0;
let lastNativeInCallSignature = '';
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
      if (Platform.OS === 'android' && /foreground|pip|return/i.test(reason)) {
        try {
          const probe = await probeNativeCallAudioRoutes();
          mergeNativeProbeIntoGlobal(probe);
        } catch {}
      }
      const externalBeforeCapture = readActiveExternalCallAudioRoute();
      if (!externalBeforeCapture) {
        captureCallAudioRouteFromUi();
      } else {
        setPersistedCallAudioRoute(externalBeforeCapture);
        try {
          (global as any).__lastAppliedCallAudioRouteRef = { current: externalBeforeCapture };
        } catch {}
      }
      let stored = getPersistedCallAudioRoute();
      const preserveInAppPiP =
        shouldPreserveCallAudioRouteInInAppPiP() && !isAppInCallBackgroundState();
      if (preserveInAppPiP || externalBeforeCapture) {
        const preserved = readInAppPiPAudioOutputRoute();
        if (isExternalHeadsetRoute(preserved) || preserveInAppPiP) {
          stored = preserved;
          setPersistedCallAudioRoute(preserved);
        }
      }
      let route =
        preserveInAppPiP || isExternalHeadsetRoute(stored)
          ? stored
          : resolvePersistedCallAudioRouteForReapply(stored);
      if (
        reason === 'audio_home_loud_speaker' &&
        !shouldApplyHomeLoudSpeakerPin()
      ) {
        route = readPreferredCallAudioRouteForTransition();
        setPersistedCallAudioRoute(route);
      }
      if (!route) return;
      const extAfterResolve = readActiveExternalCallAudioRoute(route);
      if (
        extAfterResolve &&
        isExternalHeadsetRoute(extAfterResolve) &&
        !isExternalHeadsetRoute(route) &&
        (isCallAudioPiPTransitionWindow() || reason.includes('foreground') || reason.includes('pip'))
      ) {
        route = extAfterResolve;
        setPersistedCallAudioRoute(extAfterResolve);
      }
      route = coercePersistedRouteForAvailableDevices(route);
      if (route !== stored) {
        setPersistedCallAudioRoute(route);
        try {
          const params = (global as any).__currentCallPiPParamsRef?.current;
          if (params && typeof params === 'object') {
            params.audioOutputRoute = route;
          }
          (global as any).__onInAppPiPAudioRouteChanged?.(route);
        } catch {}
      }

      if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
        const liveExt =
          readActiveExternalCallAudioRoute(route) ||
          readNativeProbedExternalRoute() ||
          (isExternalHeadsetRoute(readLastAppliedCallAudioRoute())
            ? readLastAppliedCallAudioRoute()
            : null);
        if (isExternalHeadsetRoute(liveExt)) {
          route = liveExt;
          setPersistedCallAudioRoute(liveExt);
        }
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

      if (isExternalHeadsetRoute(route) && isOngoingCallSession()) {
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(false);
          InCallManager.setSpeakerphoneOn(false);
          await (InCallManager as any).chooseAudioRoute?.(route);
          await applyNativeVoiceCallRoute(route);
        } catch {}
        lastNativeInCallSignature = signature;
        logger.info('[callAudioRoutePersist] reapply headset light', { reason, route, media });
        return;
      }

      const skipHeavyNative =
        signature === lastNativeInCallSignature &&
        (isExternalHeadsetRoute(route) || route === 'EARPIECE');

      if (skipHeavyNative) {
        if (isExternalHeadsetRoute(route)) {
          try {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            await (InCallManager as any).chooseAudioRoute?.(route);
          } catch {}
        }
        logger.debug('[callAudioRoutePersist] reapply light (native unchanged)', { reason, route, media });
        return;
      }

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
        const ext =
          readActiveExternalCallAudioRoute() ||
          readNativeProbedExternalRoute() ||
          (isExternalHeadsetRoute(readLastAppliedCallAudioRoute())
            ? readLastAppliedCallAudioRoute()
            : null);
        if (isExternalHeadsetRoute(ext)) {
          try {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            await (InCallManager as any).chooseAudioRoute?.(ext);
            await applyNativeVoiceCallRoute(ext);
          } catch {}
          setPersistedCallAudioRoute(ext);
          lastNativeInCallSignature = `${ext}|${media}`;
          logger.info('[callAudioRoutePersist] reapply headset (blocked earpiece)', { reason, route: ext, media });
          return;
        }
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(false);
          InCallManager.setSpeakerphoneOn(false);
          void (InCallManager as any).chooseAudioRoute?.('EARPIECE');
        } catch {}
        if (!readActiveExternalCallAudioRoute() && !readNativeProbedExternalRoute()) {
          await applyNativeVoiceCallSpeaker(false);
        }
      } else if (isExternalHeadsetRoute(route)) {
        try {
          (InCallManager as any).setForceSpeakerphoneOn?.(false);
          InCallManager.setSpeakerphoneOn(false);
          await (InCallManager as any).chooseAudioRoute?.(route);
          await applyNativeVoiceCallRoute(route);
        } catch {}
      }

      lastNativeInCallSignature = signature;
      logger.info('[callAudioRoutePersist] reapply', { reason, route, media });
    })
    .catch(() => {});
}

export function scheduleReapplyPersistedCallAudioRoute(
  reason: string,
  opts?: { media?: 'audio' | 'video'; delaysMs?: number[] },
): void {
  if (reason === 'audio_home_loud_speaker' && !shouldApplyHomeLoudSpeakerPin()) {
    schedulePreserveCallAudioRoute('audio_home_preserve_route', opts?.media);
    return;
  }
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

/** In-app PiP: сохранить earpiece / speaker / BT / провод при reapply. */
export function shouldPreserveCallAudioRouteInInAppPiP(): boolean {
  try {
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

/**
 * Home + in-app PiP (VideoCall в стеке, но не на экране): переприменить маршрут и InCall после system PiP / фона.
 */
export function restoreCallAudioForInAppPiPPlaque(reason: string): void {
  if (!isOngoingCallSession()) return;
  try {
    const g = global as any;
    const plaqueActive =
      g.__pipVisibleRef?.current === true ||
      g.__pipSuspendedForSystemPiPRef?.current === true ||
      g.__restoringInAppPiPFromSystemRef?.current === true;
    if (!plaqueActive) return;
  } catch {
    return;
  }
  captureCallAudioRouteFromUi();
  const route = readInAppPiPAudioOutputRoute();
  setPersistedCallAudioRoute(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__lastAppliedCallAudioRouteRef = { current: route };
    (global as any).__onInAppPiPAudioRouteChanged?.(route);
  } catch {}
  const media = resolveActiveCallInCallMedia();
  const external = isExternalHeadsetRoute(route);
  scheduleReapplyPersistedCallAudioRoute(reason, {
    media,
    delaysMs: external ? [0, 500, 1500] : [0, 300, 900, 1500],
  });
  restoreOngoingCallMicrophoneIfEnabled();
  if (Platform.OS === 'android') {
    try {
      NativeModules.LiviAppModule?.maintainActiveCallVoiceAudio?.();
    } catch {}
  }
  try {
    const g = global as any;
    if (typeof g.__syncDirectCallAudioRouteRef?.current === 'function') {
      const external = isExternalHeadsetRoute(route);
      if (!external) {
        g.__syncDirectCallAudioRouteRef.current();
      }
    }
  } catch {}
}
