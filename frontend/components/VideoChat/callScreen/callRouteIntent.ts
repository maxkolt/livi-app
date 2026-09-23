/**
 * Толкование навигационных параметров экрана звонка.
 *
 * Экран монтируется не только при старте звонка: ещё при возврате из PiP, из Home,
 * при повороте и при ремаунте после смены сессии. Параметры маршрута при этом легко
 * «протухают» — например, `fromPiP: true` остаётся от прошлого перехода. Ошибиться
 * здесь дорого: ложный возврат из PiP открывает видео-UI поверх аудио-звонка, а
 * пропущенный — оставляет пользователя на чёрном экране.
 *
 * Вынесено из VideoCall.tsx: хуков тут нет, только чтение флагов и маршрута.
 */

import { logger } from '../../../utils/logger';
import {
  clearStaleDirectCallVideoExpandFlags,
  clearStaleDirectCallVideoExpandGlobalHints,
  isDirectCallAudioAcceptBootstrapped,
  isDirectCallUserRequestedVideoExpand,
  isDirectCallVideoExpandGuardActive,
  markDirectCallUserRequestedVideoExpand,
} from '../../../src/pip/pipPlaceholderOnly';
import { mergeActiveVideoCallParams } from '../../../utils/appNavigationGuard';

/** Параметры маршрута, влияющие на выбор UI звонка. */
export type DirectCallRouteParams = {
  fromPiP?: boolean;
  resume?: boolean;
  preferVideoCallUi?: boolean;
  audioOnlyPiPReturn?: boolean;
  callId?: string | null;
  isIncoming?: boolean;
  directInitiator?: boolean;
  peerUserId?: string;
};

export function logDirectCallUiGate(
  gate: string,
  details: Record<string, unknown>,
): void {
  logger.info(`[VideoCall][directCallUi] ${gate}`, details);
}

export function isAcceptedVideoCallNavCallId(callId?: string | null): boolean {
  const cid = String(callId || '').trim();
  if (!cid) return false;
  try {
    return String((global as any).__acceptedVideoCallNavCallIdRef?.current || '') === cid;
  } catch {
    return false;
  }
}

export function hasAuthenticDirectCallVideoPiPReturnIntent(): boolean {
  try {
    const g = global as any;
    // Не считать stayOnVideo / in-app PiP «возвратом из PiP» — иначе remount/layout шум
    // и ложный restore fromPiP пока партнёр в system PiP.
    return (
      isDirectCallUserRequestedVideoExpand() ||
      isDirectCallVideoExpandGuardActive() ||
      g.__expandToVideoCallUiFromPiPRef?.current === true ||
      (g.__pipReturnToCallInFlightRef?.current === true &&
        Number(g.__systemPiPReturnTokenRef?.current || 0) > 0)
    );
  } catch {
    return false;
  }
}

export function isExplicitDirectCallVideoPiPReturnRoute(params?: {
  fromPiP?: boolean;
  resume?: boolean;
  preferVideoCallUi?: boolean;
  audioOnlyPiPReturn?: boolean;
  callId?: string | null;
} | null): boolean {
  if (
    params?.fromPiP !== true ||
    params?.resume !== true ||
    params?.preferVideoCallUi !== true ||
    params?.audioOnlyPiPReturn === true
  ) {
    return false;
  }
  const cid = String(params.callId ?? '').trim();
  if (!cid || !isDirectCallAudioAcceptBootstrapped(cid)) return false;
  return hasAuthenticDirectCallVideoPiPReturnIntent();
}

export function stripStaleDirectCallPiPNavParamsIfNeeded(
  params: {
    fromPiP?: boolean;
    resume?: boolean;
    preferVideoCallUi?: boolean;
    audioOnlyPiPReturn?: boolean;
    callId?: string | null;
  },
  mountKey: string,
): void {
  const routePiPFlags = params.fromPiP === true || params.resume === true;
  if (!routePiPFlags) return;
  if (params.audioOnlyPiPReturn === true) {
    // Sticky video-expand после Back→video-PiP→«на аудио» не должен restore'ить video nav.
    if (hasAuthenticDirectCallVideoPiPReturnIntent()) {
      clearStaleDirectCallVideoExpandFlags();
    }
    return;
  }
  if (isExplicitDirectCallVideoPiPReturnRoute({ ...params, callId: mountKey })) {
    return;
  }
  // Remount race: globals already say video return, но preferVideoCallUi ещё не в route.
  if (hasAuthenticDirectCallVideoPiPReturnIntent()) {
    // Явный audio return (preferVideoCallUi: false) — не форсить video nav.
    if (params.preferVideoCallUi === false) {
      clearStaleDirectCallVideoExpandFlags();
      return;
    }
    if (params.preferVideoCallUi !== true) {
      logDirectCallUiGate('layout_restore_video_pip_nav', {
        callId: mountKey,
        fromPiP: params.fromPiP,
        resume: params.resume,
        preferVideoCallUi: params.preferVideoCallUi,
      });
      mergeActiveVideoCallParams({
        fromPiP: true,
        resume: true,
        audioOnlyPiPReturn: false,
        preferVideoCallUi: true,
      });
    }
    return;
  }
  logDirectCallUiGate('layout_strip_stale_pip_nav', {
    callId: mountKey,
    fromPiP: params.fromPiP,
    resume: params.resume,
    preferVideoCallUi: params.preferVideoCallUi,
    bootstrapped: isDirectCallAudioAcceptBootstrapped(mountKey),
    authenticIntent: hasAuthenticDirectCallVideoPiPReturnIntent(),
  });
  mergeActiveVideoCallParams({
    fromPiP: false,
    resume: false,
    audioOnlyPiPReturn: false,
    preferVideoCallUi: false,
  });
  // Не затираем userExpand, если пользователь уже на video UI (иначе после PiP
  // повторное включение камеры тихо блокируется audio-first guard'ом).
  const stayOnVideoUi = (global as any).__stayOnVideoCallUiRef?.current === true;
  clearStaleDirectCallVideoExpandGlobalHints();
  if (stayOnVideoUi) {
    markDirectCallUserRequestedVideoExpand();
  }
}

export function isFreshDirectCallAudioAcceptRoute(params?: {
  isIncoming?: boolean;
  directInitiator?: boolean;
  peerUserId?: string;
  callId?: string | null;
  fromPiP?: boolean;
  resume?: boolean;
  preferVideoCallUi?: boolean;
  audioOnlyPiPReturn?: boolean;
} | null): boolean {
  if (!params) return false;
  if (params.fromPiP === true || params.resume === true) return false;
  if (params.preferVideoCallUi === true || params.audioOnlyPiPReturn === true) return false;
  if (isExplicitDirectCallVideoPiPReturnRoute(params)) return false;
  const callId = String(params.callId ?? '').trim();
  if (callId && isDirectCallAudioAcceptBootstrapped(callId)) return false;
  if (callId && isAcceptedVideoCallNavCallId(callId)) return true;
  if (params.isIncoming === true) return true;
  if (params.directInitiator === true) return true;
  const outgoingPeer = String((global as any).__outgoingCallPeerUserIdRef?.current || '').trim();
  const peer = String(params.peerUserId || '').trim();
  return !!outgoingPeer && outgoingPeer === peer;
}
