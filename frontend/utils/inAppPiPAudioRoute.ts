import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  nextRouteInCycle,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { readInAppPiPAudioOutputRoute } from './activeCallSession';
import {
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
} from './callAudioRoutePersist';
import { rememberBuiltinCallRouteBeforeHeadset } from './callHeadsetAudioFallback';

export { readInAppPiPAudioOutputRoute } from './activeCallSession';

function readAvailableInCallAudioRoutes(): string[] {
  try {
    const raw = (global as any).__inCallAvailableAudioRoutesRef?.current;
    if (Array.isArray(raw) && raw.length) {
      return raw.map((s) => String(s));
    }
  } catch {}
  return ['EARPIECE', 'SPEAKER_PHONE'];
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
  }
  setPersistedCallAudioRoute(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__pipUpdateStateRef?.current?.({ audioOutputRoute: route });
    notifyPiPAudioRouteChanged(route);
  } catch {}
}

function schedulePiPAudioRouteReapply(): void {
  const fromAudioPiP = (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
  scheduleReapplyPersistedCallAudioRoute('in_app_pip_audio_route_toggle', {
    media: fromAudioPiP ? 'audio' : 'video',
    delaysMs: [0, 200, 600],
  });
}

/** In-app PiP: цикл маршрутов (разговорный / громкая / BT / провод). */
export function toggleInAppPiPAudioOutputRoute(): InCallAudioRoute | null {
  const cycleFromVideoCall = (global as any).__cycleAudioRouteRef?.current;
  if (typeof cycleFromVideoCall === 'function') {
    try {
      cycleFromVideoCall();
      const route = readInAppPiPAudioOutputRoute();
      notifyPiPAudioRouteChanged(route);
      return route;
    } catch {
      /* fall through */
    }
  }

  const current = readInAppPiPAudioOutputRoute();
  const available = readAvailableInCallAudioRoutes();
  const next = nextRouteInCycle(current, available);
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
  schedulePiPAudioRouteReapply();
  return next;
}
