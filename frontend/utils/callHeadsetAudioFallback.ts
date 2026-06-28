import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi } from '../src/pip/pipPlaceholderOnly';
import { ongoingCallPrefersVideoMedia, rememberManualBuiltinCallAudioRoute, readUserLockedBuiltinCallAudioRoute } from './activeCallSession';
import { readRootCurrentRouteName } from './safeRootNavigation';
import { armCallAudioRouteUiLock } from './callAudioRouteTransitionGuards';

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

export function isInSystemPiPMode(): boolean {
  try {
    return (global as any).__pipInSystemModeRef?.current === true;
  } catch {
    return false;
  }
}

/** Полноэкранный video UI на VideoCall (не audio-only). */
export function isOnFullScreenVideoCallUi(): boolean {
  try {
    return readRootCurrentRouteName() === 'VideoCall' && ongoingCallPrefersVideoMedia();
  } catch {
    return false;
  }
}

/** После снятия BT на video UI / system PiP: громкий + lock для последующих экранов. */
export function rememberVideoUiSpeakerAfterHeadsetDisconnect(): void {
  rememberBuiltinCallRouteBeforeHeadset('SPEAKER_PHONE', false);
  rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
  try {
    const g = global as any;
    g.__explicitBuiltInCallAudioRouteRef = g.__explicitBuiltInCallAudioRouteRef || { current: false };
    g.__explicitBuiltInCallAudioRouteRef.current = true;
  } catch {}
  armCallAudioRouteUiLock('SPEAKER_PHONE');
}

/** In-app PiP с video (камера / video UI), не audio-only plaque. */
export function isInAppPiPVideoPathContext(): boolean {
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current !== true) return false;
    if (g.__pipInSystemModeRef?.current === true) return false;
    if (g.__pipInAppRtcFromAudioOnlyRef?.current === true) return false;
    return ongoingCallPrefersVideoMedia();
  } catch {
    return false;
  }
}

/** System PiP во время audio-звонка (не video-медиа). */
export function isInSystemPiPAudioOnlyContext(): boolean {
  return isInSystemPiPMode() && !ongoingCallPrefersVideoMedia();
}

/** Громкий после снятия BT: полноэкранное video, system/in-app PiP с video-медиа. */
export function preferSpeakerAfterHeadsetDisconnect(): boolean {
  if (isOnFullScreenVideoCallUi()) return true;
  if (isInAppPiPVideoPathContext()) return true;
  if (isInSystemPiPMode() && ongoingCallPrefersVideoMedia()) return true;
  return false;
}

/** После снятия гарнитуры: earpiece везде, кроме video UI и PiP с video-медиа. */
export function shouldDefaultToEarpieceAfterHeadsetDisconnect(): boolean {
  if (preferSpeakerAfterHeadsetDisconnect()) return false;
  if (isInSystemPiPAudioOnlyContext()) return true;
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'SPEAKER_PHONE') return false;
  if (locked === 'EARPIECE') return true;
  const stored = readBuiltinCallRouteBeforeHeadset();
  if (stored === 'SPEAKER_PHONE') return false;
  if (isInAudioOnlyCallUi()) return true;
  try {
    const g = global as any;
    if (g.__pipVisibleRef?.current === true && g.__pipInAppRtcFromAudioOnlyRef?.current === true) {
      return true;
    }
    if (g.__pipVisibleRef?.current === true) return true;
    const route = readRootCurrentRouteName();
    if (route !== 'VideoCall') return true;
    return !ongoingCallPrefersVideoMedia();
  } catch {
    return true;
  }
}

export function resolveCallRouteAfterHeadsetDisconnect(): BuiltinCallAudioRoute {
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked === 'SPEAKER_PHONE' || locked === 'EARPIECE') {
    return locked;
  }
  if (preferSpeakerAfterHeadsetDisconnect()) {
    return 'SPEAKER_PHONE';
  }
  const stored = readBuiltinCallRouteBeforeHeadset();
  if (stored === 'EARPIECE' || stored === 'SPEAKER_PHONE') {
    return stored;
  }
  if (shouldDefaultToEarpieceAfterHeadsetDisconnect()) {
    return 'EARPIECE';
  }
  return 'SPEAKER_PHONE';
}

export function clearBuiltinCallRouteBeforeHeadset(): void {
  try {
    builtinRef().current = null;
    clearDirectCallAudioRouteBeforeVideo();
  } catch {}
}
