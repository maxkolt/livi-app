import {
  normalizeInCallRoute,
  type InCallAudioRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import {
  readUserLockedBuiltinCallAudioRoute,
  readUserSelectedCallAudioRoute,
  userExplicitlyPinnedBuiltinCallAudio,
} from './activeCallSession';

function readPlaqueRoute(): InCallAudioRoute | null {
  try {
    return normalizeInCallRoute(
      (global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || '',
    );
  } catch {
    return null;
  }
}

export { readPlaqueRoute as readInAppPiPPlaqueAudioRoute };

/** Пользователь на плашке явно выбрал ухо/динамик — не отбирать маршрут auto-BT poll. */
export function isInAppPiPExplicitBuiltinRouteChoiceActive(): boolean {
  try {
    const g = global as any;
    const plaque = readPlaqueRoute();
    const userSel = readUserSelectedCallAudioRoute();
    const lockedBuiltin = readUserLockedBuiltinCallAudioRoute();
    const onBuiltinPlaque =
      plaque === 'EARPIECE' ||
      plaque === 'SPEAKER_PHONE' ||
      userSel === 'EARPIECE' ||
      userSel === 'SPEAKER_PHONE';
    if (lockedBuiltin && onBuiltinPlaque) {
      return true;
    }
    if (
      g.__explicitBuiltInCallAudioRouteRef?.current === true &&
      onBuiltinPlaque
    ) {
      return true;
    }
    if (userExplicitlyPinnedBuiltinCallAudio() && onBuiltinPlaque) {
      return true;
    }
    if (Number(g.__pipBuiltinRouteLockUntilRef?.current || 0) <= Date.now()) {
      return false;
    }
    const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
      return true;
    }
  } catch {}
  return false;
}
