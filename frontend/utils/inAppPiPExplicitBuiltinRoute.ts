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

/** Недавний ручной выбор на плашке (любой маршрут) — не трогать auto poll/unplug. */
export function isInAppPiPManualRouteLockActive(): boolean {
  try {
    const g = global as any;
    const lockUntil = Number(g.__pipBuiltinRouteLockUntilRef?.current || 0);
    if (lockUntil > Date.now()) return true;
    const lastToggle = Number(g.__lastInAppPiPAudioToggleAtRef?.current || 0);
    if (lastToggle > 0 && Date.now() - lastToggle < 6500) return true;
  } catch {}
  return false;
}

/** Пользователь на плашке явно выбрал ухо/динамик — не отбирать маршрут auto-BT poll. */
export function isInAppPiPExplicitBuiltinRouteChoiceActive(): boolean {
  try {
    const g = global as any;
    const lockUntil = Number(g.__pipBuiltinRouteLockUntilRef?.current || 0);
    if (lockUntil > Date.now()) {
      const explicitLock = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
      if (explicitLock) return true;
    }
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
    const explicit = normalizeInCallRoute(g.__inAppPiPExplicitToggleRouteRef?.current || '');
    if (explicit === 'EARPIECE' || explicit === 'SPEAKER_PHONE') {
      return true;
    }
  } catch {}
  return false;
}
