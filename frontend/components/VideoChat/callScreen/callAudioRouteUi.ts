/**
 * Какой маршрут звука показывать в UI, пока bootstrap звонка ещё не закончился.
 *
 * Показать «ухо» по умолчанию нельзя: если пользователь уже на громкой связи или в
 * гарнитуре, кнопка мигнёт не тем состоянием. Поэтому перебираем источники в порядке
 * достоверности — UI-лок, явный выбор пользователя, сохранённый маршрут, PiP, последний
 * применённый — и только в конце падаем на «ухо».
 *
 * Вынесено из VideoCall.tsx: хуков нет, это чтение уже сохранённого состояния.
 */

import type { InCallAudioRoute } from '../hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../hooks/audioRouteTypes';
import { isInAudioOnlyCallUi } from '../../../src/pip/pipPlaceholderOnly';
import {
  isDirectAudioEarpieceStabilizeWindow,
  readInAppPiPAudioOutputRoute,
  readLastAppliedCallAudioRoute,
  readUserLockedBuiltinCallAudioRoute,
  readUserSelectedCallAudioRoute,
} from '../../../utils/activeCallSession';
import { getPersistedCallAudioRoute, readCallAudioRouteUiLock } from '../../../utils/callAudioRoutePersist';

export /** Пока bootstrap pending: не всегда ухо — если маршрут уже SPEAKER/BT, показать сразу. */
function resolveCallAudioRouteUiWhileBootstrapPending(
  selectedRoute: InCallAudioRoute,
): InCallAudioRoute {
  const uiLock = readCallAudioRouteUiLock();
  if (uiLock) return uiLock;
  if (
    isInAudioOnlyCallUi() &&
    isDirectAudioEarpieceStabilizeWindow() &&
    !readUserLockedBuiltinCallAudioRoute() &&
    selectedRoute === 'SPEAKER_PHONE'
  ) {
    return 'EARPIECE';
  }
  if (
    selectedRoute === 'SPEAKER_PHONE' ||
    selectedRoute === 'EARPIECE' ||
    isExternalHeadsetRoute(selectedRoute)
  ) {
    return selectedRoute;
  }
  const candidates: (InCallAudioRoute | null | undefined)[] = [
    readUserSelectedCallAudioRoute(),
    getPersistedCallAudioRoute(),
    normalizeInCallRoute(readInAppPiPAudioOutputRoute() || ''),
    readLastAppliedCallAudioRoute(),
  ];
  for (const raw of candidates) {
    const route = normalizeInCallRoute(raw || '');
    if (
      route === 'SPEAKER_PHONE' ||
      route === 'EARPIECE' ||
      isExternalHeadsetRoute(route)
    ) {
      return route;
    }
  }
  return 'EARPIECE';
}
