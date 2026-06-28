import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';

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
