import { Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  nextRouteInCycleForContext,
  normalizeInCallRoute,
  sanitizeRoutesForAudioCycle,
} from '../components/VideoChat/hooks/audioRouteTypes';
import {
  markUserSelectedExternalCallAudioRoute,
  readInAppPiPAudioOutputRoute,
  readInCallAvailableAudioRoutesForCycle,
  rememberManualBuiltinCallAudioRoute,
  setUserSelectedCallAudioRoute,
  clearBuiltinPinForExternalHeadsetConnect,
} from './activeCallSession';
import {
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  isBluetoothHeadsetActiveForCall,
} from './nativeCallAudioProbe';
import {
  applyCallAudioOutputRouteNow,
  armCallAudioPreservePriority,
  cancelScheduledCallAudioRouteReappliesMatching,
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
} from './callAudioRoutePersist';
import { armCallAudioRouteUiLock, clearCallAudioRouteUiLock } from './callAudioRouteTransitionGuards';
import { rememberBuiltinCallRouteBeforeHeadset, rememberDirectCallAudioRouteBeforeVideo } from './callHeadsetAudioFallback';
import { notifyInAppPiPAudioRouteUi } from './callInAppPiPAudioRouteUi';
import { logger } from './logger';

export { readInAppPiPAudioOutputRoute } from './activeCallSession';
export { notifyInAppPiPAudioRouteUi } from './callInAppPiPAudioRouteUi';

const BUILTIN_FALLBACK = ['SPEAKER_PHONE', 'EARPIECE'];

let pipAudioToggleInFlight = false;
let lastPipAudioToggleAt = 0;
const PIP_AUDIO_TOGGLE_DEBOUNCE_MS = 480;

function readAvailableInCallAudioRoutes(): string[] {
  const icm = readInCallAvailableAudioRoutesForCycle();
  const set = new Set<string>();
  try {
    const raw = (global as any).__inCallAvailableAudioRoutesRef?.current;
    if (Array.isArray(raw)) {
      for (const s of raw) set.add(String(s));
    }
  } catch {}
  try {
    const probe = (global as any).__nativeCallAudioRoutesRef?.current as
      | { available?: string[] }
      | undefined;
    if (Array.isArray(probe?.available)) {
      for (const r of probe.available) set.add(String(r));
    }
  } catch {}
  const merged = set.size ? Array.from(set) : [...BUILTIN_FALLBACK];
  let sanitized = sanitizeRoutesForAudioCycle(merged, icm);
  if (Platform.OS === 'android' && !isBluetoothHeadsetActiveForCall()) {
    sanitized = sanitized.filter((r) => r !== 'BLUETOOTH');
  }
  return sanitized;
}

async function syncProbeBeforeCycle(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const probe = await probeNativeCallAudioRoutes();
    mergeNativeProbeIntoGlobal(probe);
  } catch {}
}

function notifyPiPAudioRouteChanged(route: InCallAudioRoute): void {
  notifyInAppPiPAudioRouteUi(route);
}

function persistInAppPiPAudioRoute(route: InCallAudioRoute): void {
  const fromAudioPiP = (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
  if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
    rememberBuiltinCallRouteBeforeHeadset(route, fromAudioPiP);
    rememberDirectCallAudioRouteBeforeVideo(route);
  }
  setUserSelectedCallAudioRoute(route);
  setPersistedCallAudioRoute(route);
  if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
    rememberManualBuiltinCallAudioRoute(route);
    try {
      const g = global as any;
      g.__explicitBuiltInCallAudioRouteRef =
        g.__explicitBuiltInCallAudioRouteRef || { current: false };
      g.__explicitBuiltInCallAudioRouteRef.current = true;
      g.__userSelectedExternalCallAudioRouteRef = { current: null };
    } catch {}
  } else if (isExternalHeadsetRoute(route)) {
    clearBuiltinPinForExternalHeadsetConnect();
    markUserSelectedExternalCallAudioRoute(route);
    try {
      const g = global as any;
      g.__explicitBuiltInCallAudioRouteRef =
        g.__explicitBuiltInCallAudioRouteRef || { current: false };
      g.__explicitBuiltInCallAudioRouteRef.current = false;
    } catch {}
  }
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__inCallSelectedAudioRouteRef = { current: route };
    (global as any).__lastAppliedCallAudioRouteRef = { current: route };
    (global as any).__pipUpdateStateRef?.current?.({ audioOutputRoute: route });
    notifyPiPAudioRouteChanged(route);
  } catch {}
}

/** In-app PiP: всегда 3 режима (как аудио-страница), не делегировать в video UI (2 режима). */
export async function toggleInAppPiPAudioOutputRoute(): Promise<InCallAudioRoute | null> {
  const now = Date.now();
  if (pipAudioToggleInFlight || now - lastPipAudioToggleAt < PIP_AUDIO_TOGGLE_DEBOUNCE_MS) {
    return readInAppPiPAudioOutputRoute();
  }
  pipAudioToggleInFlight = true;
  lastPipAudioToggleAt = now;
  try {
    return await toggleInAppPiPAudioOutputRouteInner();
  } finally {
    pipAudioToggleInFlight = false;
  }
}

async function toggleInAppPiPAudioOutputRouteInner(): Promise<InCallAudioRoute | null> {
  await syncProbeBeforeCycle();

  const available = readAvailableInCallAudioRoutes();
  const icm = readInCallAvailableAudioRoutesForCycle();
  const orderList = available.length ? available : BUILTIN_FALLBACK;
  let current = readInAppPiPAudioOutputRoute();
  const explicitToggle = normalizeInCallRoute(
    (global as any).__inAppPiPExplicitToggleRouteRef?.current || '',
  );
  if (
    explicitToggle &&
    (explicitToggle === 'EARPIECE' ||
      explicitToggle === 'SPEAKER_PHONE' ||
      isExternalHeadsetRoute(explicitToggle))
  ) {
    current = explicitToggle;
  }
  const next = nextRouteInCycleForContext(current, orderList, 'in_app_pip', icm);
  if (next === current) {
    return current;
  }
  const fromAudioPiP = (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
  if (
    isExternalHeadsetRoute(next) &&
    (current === 'EARPIECE' || current === 'SPEAKER_PHONE')
  ) {
    rememberBuiltinCallRouteBeforeHeadset(current, fromAudioPiP);
  }
  persistInAppPiPAudioRoute(next);
  try {
    const g = global as any;
    g.__audioUiExplicitCycleRouteRef = g.__audioUiExplicitCycleRouteRef || { current: null };
    g.__audioUiExplicitCycleRouteRef.current = next;
    g.__inAppPiPExplicitToggleRouteRef = g.__inAppPiPExplicitToggleRouteRef || { current: null };
    g.__inAppPiPExplicitToggleRouteRef.current = next;
    g.__pipBuiltinRouteLockUntilRef = g.__pipBuiltinRouteLockUntilRef || { current: 0 };
    g.__pipBuiltinRouteLockUntilRef.current = Date.now() + 6500;
    g.__lastInAppPiPAudioToggleAtRef = g.__lastInAppPiPAudioToggleAtRef || { current: 0 };
    g.__lastInAppPiPAudioToggleAtRef.current = Date.now();
    armCallAudioPreservePriority(6500);
  } catch {}
  const media = fromAudioPiP ? 'audio' : 'video';
  cancelScheduledCallAudioRouteReappliesMatching([
    'in_app_pip_headset_connect',
    'in_app_pip_headset_unplug',
    'in_app_pip_from_audio',
    'in_app_pip_from_video',
    'in_app_pip_audio_route_toggle',
  ]);
  if (next === 'EARPIECE' || next === 'SPEAKER_PHONE') {
    armCallAudioRouteUiLock(next);
  } else if (isExternalHeadsetRoute(next)) {
    clearCallAudioRouteUiLock();
  }
  await applyCallAudioOutputRouteNow(next, {
    media,
    forceBuiltIn: !isExternalHeadsetRoute(next),
  });
  scheduleReapplyPersistedCallAudioRoute('in_app_pip_audio_route_toggle', {
    media,
    honorUserRoute: true,
    skipInCallRestart: true,
    delaysMs: [0],
  });
  logger.info('[inAppPiPAudioRoute] pip toggle', { from: current, next, media });
  return next;
}
