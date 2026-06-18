import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { readInAppPiPAudioOutputRoute } from './activeCallSession';
import {
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
} from './callAudioRoutePersist';

export { readInAppPiPAudioOutputRoute } from './activeCallSession';

function persistInAppPiPAudioRoute(route: InCallAudioRoute): void {
  setPersistedCallAudioRoute(route);
  try {
    const params = (global as any).__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    (global as any).__pipUpdateStateRef?.current?.({ audioOutputRoute: route });
  } catch {}
}

/** In-app PiP с audio UI: разговорный ↔ громкая (BT/провод — через VideoCall ref, если есть). */
export function toggleInAppPiPAudioOutputRoute(): InCallAudioRoute | null {
  const cycleFromVideoCall = (global as any).__cycleAudioRouteRef?.current;
  if (typeof cycleFromVideoCall === 'function') {
    try {
      cycleFromVideoCall();
      return readInAppPiPAudioOutputRoute();
    } catch {
      /* fall through */
    }
  }

  const current = readInAppPiPAudioOutputRoute();
  if (isExternalHeadsetRoute(current)) {
    return current;
  }

  const next: InCallAudioRoute = current === 'SPEAKER_PHONE' ? 'EARPIECE' : 'SPEAKER_PHONE';
  persistInAppPiPAudioRoute(next);
  const fromAudioPiP = (global as any).__pipInAppRtcFromAudioOnlyRef?.current === true;
  scheduleReapplyPersistedCallAudioRoute('in_app_pip_audio_route_toggle', {
    media: fromAudioPiP ? 'audio' : 'video',
    delaysMs: [0, 200],
  });
  return next;
}
