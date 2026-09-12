import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isInAudioOnlyCallUi } from './callAudioOnlyUiContext';
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
  if (norm !== 'EARPIECE' && norm !== 'SPEAKER_PHONE') return;
  const existing = beforeVideoRef().current;
  // Только вне audio UI: product SPEAKER с video pin не затирает earpiece.
  // На audio (cycle / expand snapshot) SPEAKER должен свободно перезаписывать EARPIECE.
  if (
    existing === 'EARPIECE' &&
    norm === 'SPEAKER_PHONE' &&
    !isInAudioOnlyCallUi()
  ) {
    return;
  }
  beforeVideoRef().current = norm;
  builtinRef().current = norm;
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
    // Video pin SPEAKER через setUserRoute не должен портить fallback для return-to-audio.
    if (
      norm === 'SPEAKER_PHONE' &&
      readDirectCallAudioRouteBeforeVideo() === 'EARPIECE' &&
      !isInAudioOnlyCallUi()
    ) {
      return;
    }
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

/**
 * ============================================================================
 * Ниже — REFACTOR (без изменения поведения): решение "какой встроенный маршрут
 * включить после отключения гарнитуры/BT" раньше читало глобальный мутабельный
 * стейт (global.__pipVisibleRef и т.п.) прямо внутри функций принятия решения,
 * из-за чего логику было невозможно протестировать без подмены глобалов.
 *
 * Теперь чтение внешнего состояния вынесено в один явный "снимок" —
 * gatherHeadsetRouteState() — а сами решения (*FromState) стали чистыми
 * функциями от этого снимка: одинаковый вход всегда даёт одинаковый выход,
 * без обращений к global/модульному стейту. Публичные функции без аргументов
 * (isOnFullScreenVideoCallUi, preferSpeakerAfterHeadsetDisconnect,
 * shouldDefaultToEarpieceAfterHeadsetDisconnect, resolveCallRouteAfterHeadsetDisconnect)
 * сохранили те же имена/сигнатуры и остаются тонкими обёртками — все
 * существующие вызовы (useAudioRouting.ts, PiPContext.tsx, callAudioRoutePersist.ts,
 * inAppPiPHeadsetConnect.ts) продолжают работать без изменений.
 * Тесты: callHeadsetAudioFallback.test.ts (покрывают *FromState).
 * ============================================================================
 */
export type HeadsetRouteState = {
  /** Маршрут, явно закреплённый пользователем (игнорирует авто-логику), либо null. */
  lockedRoute: BuiltinCallAudioRoute | null;
  /** Имя текущего экрана навигации (например, 'VideoCall'), либо null при ошибке чтения. */
  currentRouteName: string | null;
  /** Текущий звонок ожидает video-медиа (не чистое audio). */
  prefersVideoMedia: boolean;
  /** In-app PiP (плашка) сейчас видима. */
  pipVisible: boolean;
  /** Активен системный (Android) PiP. */
  pipInSystemMode: boolean;
  /** In-app PiP сейчас рендерит RTC-видео, попав туда из audio-only UI. */
  pipInAppRtcFromAudioOnly: boolean;
  /** Открыт audio-only экран звонка (без video UI). */
  isAudioOnlyCallUi: boolean;
  /** Сохранённый (до входа в headset/BT) builtin-маршрут, либо null. */
  storedBuiltinRoute: BuiltinCallAudioRoute | null;
};

/** Единственное место, где эта логика трогает global/модульный стейт (импуре-граница). */
export function gatherHeadsetRouteState(): HeadsetRouteState {
  const g = global as any;
  let currentRouteName: string | null = null;
  try {
    currentRouteName = readRootCurrentRouteName();
  } catch {}
  let prefersVideoMedia = false;
  try {
    prefersVideoMedia = ongoingCallPrefersVideoMedia();
  } catch {}
  let isAudioOnlyCallUi = false;
  try {
    isAudioOnlyCallUi = isInAudioOnlyCallUi();
  } catch {}
  return {
    lockedRoute: (readUserLockedBuiltinCallAudioRoute() as BuiltinCallAudioRoute | null) ?? null,
    currentRouteName,
    prefersVideoMedia,
    pipVisible: g?.__pipVisibleRef?.current === true,
    pipInSystemMode: g?.__pipInSystemModeRef?.current === true,
    pipInAppRtcFromAudioOnly: g?.__pipInAppRtcFromAudioOnlyRef?.current === true,
    isAudioOnlyCallUi,
    storedBuiltinRoute: readBuiltinCallRouteBeforeHeadset(),
  };
}

/** Полноэкранный video UI на VideoCall (не audio-only). Чистая версия. */
export function isOnFullScreenVideoCallUiFromState(state: HeadsetRouteState): boolean {
  return state.currentRouteName === 'VideoCall' && state.prefersVideoMedia;
}

/** Полноэкранный video UI на VideoCall (не audio-only). */
export function isOnFullScreenVideoCallUi(): boolean {
  return isOnFullScreenVideoCallUiFromState(gatherHeadsetRouteState());
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

/** In-app PiP с video (камера / video UI), не audio-only plaque. Чистая версия. */
export function isInAppPiPVideoPathContextFromState(state: HeadsetRouteState): boolean {
  if (!state.pipVisible) return false;
  if (state.pipInSystemMode) return false;
  if (state.pipInAppRtcFromAudioOnly) return false;
  return state.prefersVideoMedia;
}

/** In-app PiP с video (камера / video UI), не audio-only plaque. */
export function isInAppPiPVideoPathContext(): boolean {
  return isInAppPiPVideoPathContextFromState(gatherHeadsetRouteState());
}

/** System PiP во время audio-звонка (не video-медиа). Чистая версия. */
export function isInSystemPiPAudioOnlyContextFromState(state: HeadsetRouteState): boolean {
  return state.pipInSystemMode && !state.prefersVideoMedia;
}

/** System PiP во время audio-звонка (не video-медиа). */
export function isInSystemPiPAudioOnlyContext(): boolean {
  return isInSystemPiPAudioOnlyContextFromState(gatherHeadsetRouteState());
}

/** Громкий после снятия BT: полноэкранное video, system/in-app PiP с video-медиа. Чистая версия. */
export function preferSpeakerAfterHeadsetDisconnectFromState(state: HeadsetRouteState): boolean {
  if (isOnFullScreenVideoCallUiFromState(state)) return true;
  if (isInAppPiPVideoPathContextFromState(state)) return true;
  if (state.pipInSystemMode && state.prefersVideoMedia) return true;
  return false;
}

/** Громкий после снятия BT: полноэкранное video, system/in-app PiP с video-медиа. */
export function preferSpeakerAfterHeadsetDisconnect(): boolean {
  return preferSpeakerAfterHeadsetDisconnectFromState(gatherHeadsetRouteState());
}

/** После снятия гарнитуры: earpiece везде, кроме video UI и PiP с video-медиа. Чистая версия. */
export function shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(state: HeadsetRouteState): boolean {
  if (preferSpeakerAfterHeadsetDisconnectFromState(state)) return false;
  if (isInSystemPiPAudioOnlyContextFromState(state)) return true;
  if (state.lockedRoute === 'SPEAKER_PHONE') return false;
  if (state.lockedRoute === 'EARPIECE') return true;
  if (state.storedBuiltinRoute === 'SPEAKER_PHONE') return false;
  if (state.isAudioOnlyCallUi) return true;
  if (state.pipVisible && state.pipInAppRtcFromAudioOnly) return true;
  if (state.pipVisible) return true;
  if (state.currentRouteName !== 'VideoCall') return true;
  return !state.prefersVideoMedia;
}

/** После снятия гарнитуры: earpiece везде, кроме video UI и PiP с video-медиа. */
export function shouldDefaultToEarpieceAfterHeadsetDisconnect(): boolean {
  return shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(gatherHeadsetRouteState());
}

/** Чистая версия: см. resolveCallRouteAfterHeadsetDisconnect(). */
export function resolveCallRouteAfterHeadsetDisconnectFromState(state: HeadsetRouteState): BuiltinCallAudioRoute {
  if (state.lockedRoute === 'SPEAKER_PHONE' || state.lockedRoute === 'EARPIECE') {
    return state.lockedRoute;
  }
  if (preferSpeakerAfterHeadsetDisconnectFromState(state)) {
    return 'SPEAKER_PHONE';
  }
  if (state.storedBuiltinRoute === 'EARPIECE' || state.storedBuiltinRoute === 'SPEAKER_PHONE') {
    return state.storedBuiltinRoute;
  }
  if (shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(state)) {
    return 'EARPIECE';
  }
  return 'SPEAKER_PHONE';
}

export function resolveCallRouteAfterHeadsetDisconnect(): BuiltinCallAudioRoute {
  return resolveCallRouteAfterHeadsetDisconnectFromState(gatherHeadsetRouteState());
}

export function clearBuiltinCallRouteBeforeHeadset(): void {
  try {
    builtinRef().current = null;
    clearDirectCallAudioRouteBeforeVideo();
  } catch {}
}
