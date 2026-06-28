import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { readInAppPiPAudioOutputRoute } from './activeCallSession';
import { isBluetoothHeadsetActiveForCall } from './nativeCallAudioProbe';

function readInCallAvailableAudioRoutesList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

/** Синхронизировать кнопку маршрута на in-app PiP-плашке (без импорта persist — без циклов). */
export function notifyInAppPiPAudioRouteUi(route: InCallAudioRoute): void {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    g.__pipUpdateStateRef?.current?.({ audioOutputRoute: route });
    g.__onInAppPiPAudioRouteChanged?.(route);
  } catch {}
}

/** In-app PiP: синхронизировать params/колбэк с вычисленным маршрутом (иконка плашки). */
export function reconcileInAppPiPAudioRoutePlaqueUi(): InCallAudioRoute {
  const route = readInAppPiPAudioOutputRoute();
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const prev = normalizeInCallRoute(params?.audioOutputRoute || '');
    const icmSelected = normalizeInCallRoute(g.__inCallSelectedAudioRouteRef?.current || '');
    const available = readInCallAvailableAudioRoutesList();
    const btStaleOnPlaque = prev === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall();
    const paramsExternalStale =
      isExternalHeadsetRoute(prev) &&
      (btStaleOnPlaque || (available.length > 0 && !available.includes(prev)));
    const icmOverridesStalePlaque =
      (icmSelected === 'EARPIECE' || icmSelected === 'SPEAKER_PHONE') &&
      isExternalHeadsetRoute(prev);
    if (prev !== route || paramsExternalStale || icmOverridesStalePlaque) {
      const display =
        icmOverridesStalePlaque && (icmSelected === 'EARPIECE' || icmSelected === 'SPEAKER_PHONE')
          ? icmSelected
          : route === 'BLUETOOTH' && !isBluetoothHeadsetActiveForCall()
            ? icmSelected === 'EARPIECE' || icmSelected === 'SPEAKER_PHONE'
              ? icmSelected
              : 'EARPIECE'
            : route;
      notifyInAppPiPAudioRouteUi(display);
      return display;
    }
  } catch {}
  return route;
}
