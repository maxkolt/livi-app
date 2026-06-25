import { Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  nextRouteInCycleForContext,
} from '../components/VideoChat/hooks/audioRouteTypes';
import {
  readInAppPiPAudioOutputRoute,
  rememberManualBuiltinCallAudioRoute,
  setUserSelectedCallAudioRoute,
} from './activeCallSession';
import {
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  readNativeProbedExternalRoute,
} from './nativeCallAudioProbe';
import {
  applyCallAudioOutputRouteNow,
  armCallAudioPreservePriority,
  reapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
} from './callAudioRoutePersist';
import { rememberBuiltinCallRouteBeforeHeadset, rememberDirectCallAudioRouteBeforeVideo } from './callHeadsetAudioFallback';

export { readInAppPiPAudioOutputRoute } from './activeCallSession';

const BUILTIN_FALLBACK = ['SPEAKER_PHONE', 'EARPIECE'];

let pipAudioToggleInFlight = false;
let lastPipAudioToggleAt = 0;
const PIP_AUDIO_TOGGLE_DEBOUNCE_MS = 480;

function readAvailableInCallAudioRoutes(): string[] {
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
  const nativeExt = readNativeProbedExternalRoute();
  if (nativeExt) set.add(nativeExt);
  if (set.size) return Array.from(set);
  return [...BUILTIN_FALLBACK];
}

async function syncProbeBeforeCycle(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const probe = await probeNativeCallAudioRoutes();
    mergeNativeProbeIntoGlobal(probe);
  } catch {}
}

function notifyPiPAudioRouteChanged(route: InCallAudioRoute): void {
  try {
    (global as any).__onInAppPiPAudioRouteChanged?.(route);
  } catch {}
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
    } catch {}
  }
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__pipUpdateStateRef?.current?.({ audioOutputRoute: route });
    notifyPiPAudioRouteChanged(route);
  } catch {}
}

function applyPiPAudioRouteNow(route: InCallAudioRoute): void {
  const fromAudioPiP = (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
  const media = fromAudioPiP ? 'audio' : 'video';
  void reapplyPersistedCallAudioRoute('in_app_pip_audio_route_toggle', {
    media,
    honorUserRoute: true,
    skipInCallRestart: route !== 'SPEAKER_PHONE',
  });
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
  const orderList = available.length ? available : BUILTIN_FALLBACK;
  const current = readInAppPiPAudioOutputRoute();
  const next = nextRouteInCycleForContext(current, orderList, 'in_app_pip');
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
    g.__inAppPiPExplicitToggleRouteRef = g.__inAppPiPExplicitToggleRouteRef || { current: null };
    g.__inAppPiPExplicitToggleRouteRef.current = next;
    g.__pipBuiltinRouteLockUntilRef = g.__pipBuiltinRouteLockUntilRef || { current: 0 };
    g.__pipBuiltinRouteLockUntilRef.current = Date.now() + 6500;
    armCallAudioPreservePriority(6500);
  } catch {}
  const media = fromAudioPiP ? 'audio' : 'video';
  await applyCallAudioOutputRouteNow(next, { media, forceBuiltIn: true });
  if (next === 'SPEAKER_PHONE') {
    applyPiPAudioRouteNow(next);
  }
  return next;
}
