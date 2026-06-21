import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi } from '../src/pip/pipPlaceholderOnly';

export type BuiltinCallAudioRoute = 'EARPIECE' | 'SPEAKER_PHONE';

function builtinRef(): { current: BuiltinCallAudioRoute | null } {
  const g = global as any;
  g.__builtinCallAudioRouteBeforeHeadsetRef = g.__builtinCallAudioRouteBeforeHeadsetRef || { current: null };
  return g.__builtinCallAudioRouteBeforeHeadsetRef;
}

function beforeVideoRef(): { current: BuiltinCallAudioRoute | null } {
  const g = global as any;
  g.__directCallAudioRouteBeforeVideoRef = g.__directCallAudioRouteBeforeVideoRef || { current: null };
  return g.__directCallAudioRouteBeforeVideoRef;
}

/** Маршрут (разговорный/громкий) на экране audio до перехода на video UI — не перезаписывается video pin. */
export function rememberDirectCallAudioRouteBeforeVideo(
  fromRoute?: InCallAudioRoute | string | null,
): void {
  const norm = normalizeInCallRoute(fromRoute || '') as BuiltinCallAudioRoute | null;
  if (norm === 'EARPIECE' || norm === 'SPEAKER_PHONE') {
    beforeVideoRef().current = norm;
    builtinRef().current = norm;
  }
}

export function readDirectCallAudioRouteBeforeVideo(): BuiltinCallAudioRoute | null {
  try {
    return normalizeInCallRoute(beforeVideoRef().current || '') as BuiltinCallAudioRoute | null;
  } catch {
    return null;
  }
}

export function clearDirectCallAudioRouteBeforeVideo(): void {
  try {
    beforeVideoRef().current = null;
  } catch {}
}

export function readBuiltinCallRouteBeforeHeadset(): BuiltinCallAudioRoute | null {
  try {
    return normalizeInCallRoute(builtinRef().current || '') as BuiltinCallAudioRoute | null;
  } catch {
    return null;
  }
}

/** Запомнить разговорный / громкий перед уходом на BT или провод. */
export function rememberBuiltinCallRouteBeforeHeadset(
  fromRoute?: InCallAudioRoute | string | null,
  productDefaultEarpiece = false,
): void {
  const norm = normalizeInCallRoute(fromRoute || '');
  if (norm === 'EARPIECE' || norm === 'SPEAKER_PHONE') {
    builtinRef().current = norm;
    return;
  }
  if (!readBuiltinCallRouteBeforeHeadset()) {
    builtinRef().current = productDefaultEarpiece ? 'EARPIECE' : 'SPEAKER_PHONE';
  }
}

/** После снятия наушников / отключения BT — вернуть сохранённый встроенный маршрут. */
export function resolveBuiltinCallRouteAfterHeadsetDisconnect(
  productDefaultEarpiece: boolean,
): BuiltinCallAudioRoute {
  const stored = readBuiltinCallRouteBeforeHeadset();
  if (stored) return stored;
  return productDefaultEarpiece ? 'EARPIECE' : 'SPEAKER_PHONE';
}

/** После снятия гарнитуры: earpiece только на экране аудиозвонка; video UI / system PiP → громкий. */
export function shouldDefaultToEarpieceAfterHeadsetDisconnect(): boolean {
  try {
    if ((global as any).__pipInSystemModeRef?.current === true) return false;
  } catch {}
  return isInAudioOnlyCallUi();
}

export function resolveCallRouteAfterHeadsetDisconnect(): BuiltinCallAudioRoute {
  if (!shouldDefaultToEarpieceAfterHeadsetDisconnect()) {
    return 'SPEAKER_PHONE';
  }
  return resolveBuiltinCallRouteAfterHeadsetDisconnect(true);
}

export function clearBuiltinCallRouteBeforeHeadset(): void {
  try {
    builtinRef().current = null;
    clearDirectCallAudioRouteBeforeVideo();
  } catch {}
}
