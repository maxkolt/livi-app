import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';

export type BuiltinCallAudioRoute = 'EARPIECE' | 'SPEAKER_PHONE';

function builtinRef(): { current: BuiltinCallAudioRoute | null } {
  const g = global as any;
  g.__builtinCallAudioRouteBeforeHeadsetRef = g.__builtinCallAudioRouteBeforeHeadsetRef || { current: null };
  return g.__builtinCallAudioRouteBeforeHeadsetRef;
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

export function clearBuiltinCallRouteBeforeHeadset(): void {
  try {
    builtinRef().current = null;
  } catch {}
}
