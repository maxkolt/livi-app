import { setPipAudioOnlyPlaceholderSticky } from './callAudioOnlyUiContext';
import { resolveDirectCallAudioFirst } from './directCallMediaHint';

function setPipInAppRtcFromAudioOnlySticky(fromAudioOnlyUi: boolean): void {
  try {
    const g = global as any;
    g.__pipInAppRtcFromAudioOnlyRef = g.__pipInAppRtcFromAudioOnlyRef || { current: false };
    g.__pipInAppRtcFromAudioOnlyRef.current = fromAudioOnlyUi;
  } catch {}
}

const DIRECT_CALL_VIDEO_EXPAND_GUARD_MS = 3500;
const DIRECT_CALL_VIDEO_EXPAND_DEDUP_MS = 900;

/** Продлевает окно, в котором audio-only / PiP-return не должны откатывать переход на video UI. */
export function touchDirectCallVideoExpandGuard(): void {
  try {
    const g = global as any;
    g.__directCallVideoExpandUntilRef = g.__directCallVideoExpandUntilRef || { current: 0 };
    g.__directCallVideoExpandUntilRef.current = Date.now() + DIRECT_CALL_VIDEO_EXPAND_GUARD_MS;
  } catch {}
}

export function isDirectCallVideoExpandGuardActive(): boolean {
  try {
    const g = global as any;
    if (g.__directCallVideoExpandInFlightRef?.current === true) return true;
    return Date.now() < Number(g.__directCallVideoExpandUntilRef?.current || 0);
  } catch {
    return false;
  }
}

/** Один активный expand на коротком интервале (PiP overlay + mount effects). */
export function tryBeginDirectCallVideoExpand(): boolean {
  try {
    const g = global as any;
    const now = Date.now();
    g.__directCallVideoExpandInFlightRef = g.__directCallVideoExpandInFlightRef || { current: false };
    g.__directCallVideoExpandLastBeginRef = g.__directCallVideoExpandLastBeginRef || { current: 0 };
    g.__directCallVideoExpandUntilRef = g.__directCallVideoExpandUntilRef || { current: 0 };
    if (g.__directCallVideoExpandInFlightRef.current) return false;
    const lastBegin = Number(g.__directCallVideoExpandLastBeginRef.current || 0);
    if (now - lastBegin < DIRECT_CALL_VIDEO_EXPAND_DEDUP_MS) return false;
    g.__directCallVideoExpandInFlightRef.current = true;
    g.__directCallVideoExpandLastBeginRef.current = now;
    g.__directCallVideoExpandUntilRef.current = now + DIRECT_CALL_VIDEO_EXPAND_GUARD_MS;
    return true;
  } catch {
    return false;
  }
}

export function finishDirectCallVideoExpandInFlight(): void {
  try {
    const g = global as any;
    if (g.__directCallVideoExpandInFlightRef) {
      g.__directCallVideoExpandInFlightRef.current = false;
    }
  } catch {}
}

/** Пользователь явно перешёл на video UI (PiP expand / кнопка камеры), не stale ref с прошлого звонка. */
export function markDirectCallUserRequestedVideoExpand(): void {
  try {
    const g = global as any;
    g.__directCallUserRequestedVideoExpandRef =
      g.__directCallUserRequestedVideoExpandRef || { current: false };
    g.__directCallUserRequestedVideoExpandRef.current = true;
    clearFreshDirectCallAudioAcceptCall();
  } catch {}
}

export function clearDirectCallUserRequestedVideoExpand(): void {
  try {
    const g = global as any;
    if (g.__directCallUserRequestedVideoExpandRef) {
      g.__directCallUserRequestedVideoExpandRef.current = false;
    }
  } catch {}
}

export function isDirectCallUserRequestedVideoExpand(): boolean {
  try {
    return (global as any).__directCallUserRequestedVideoExpandRef?.current === true;
  } catch {
    return false;
  }
}

export function clearStaleDirectCallVideoExpandFlags(): void {
  try {
    const g = global as any;
    g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
    g.__expandToVideoCallUiFromPiPRef.current = false;
    g.__directCallVideoExpandUntilRef = g.__directCallVideoExpandUntilRef || { current: 0 };
    g.__directCallVideoExpandUntilRef.current = 0;
    finishDirectCallVideoExpandInFlight();
    clearDirectCallUserRequestedVideoExpand();
  } catch {}
}

/** Audio-first direct call: блокировать expand/camera, пока пользователь явно не перешёл на video UI. */
export function shouldBlockAutomatedDirectCallVideoExpand(
  params?: Parameters<typeof resolveDirectCallAudioFirst>[0],
  callId?: string | null,
): boolean {
  if (!resolveDirectCallAudioFirst(params, callId)) return false;
  return !isDirectCallUserRequestedVideoExpand();
}

function readDirectCallPiPParamsPreferVideo(): boolean {
  try {
    return (global as any).__currentCallPiPParamsRef?.current?.preferVideoCallUi === true;
  } catch {
    return false;
  }
}

/** Хвост expand/PiP с прошлого звонка: ref без guard и без preferVideoCallUi в route/params. */
export function isStaleDirectCallVideoExpandGlobalHint(
  routeParams?: {
    preferVideoCallUi?: boolean;
    audioOnlyPiPReturn?: boolean;
  } | null,
): boolean {
  try {
    const g = global as any;
    const hasHint =
      g.__expandToVideoCallUiFromPiPRef?.current === true ||
      isDirectCallUserRequestedVideoExpand();
    if (!hasHint) return false;
    if (routeParams?.audioOnlyPiPReturn === true) return false;
    if (routeParams?.preferVideoCallUi === true) return false;
    if (readDirectCallPiPParamsPreferVideo()) return false;
    if (isDirectCallVideoExpandGuardActive()) return false;
    if (g.__pipVisibleRef?.current === true) return false;
    if (g.__pipInSystemModeRef?.current === true) return false;
    if (Number(g.__returningFromSystemPiPUntilRef?.current || 0) > Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function clearStaleDirectCallVideoExpandGlobalHints(): void {
  clearStaleDirectCallVideoExpandFlags();
  clearDirectCallUserRequestedVideoExpand();
}

/** Свежий audio-first accept (incoming/caller): блокировать автоматический expand до явного действия пользователя. */
export function markFreshDirectCallAudioAcceptCall(callId?: string | null): void {
  const cid = String(callId || '').trim();
  if (!cid) return;
  try {
    const g = global as any;
    g.__freshDirectCallAudioAcceptCallIdRef =
      g.__freshDirectCallAudioAcceptCallIdRef || { current: null as string | null };
    g.__freshDirectCallAudioAcceptCallIdRef.current = cid;
    clearStaleDirectCallVideoExpandFlags();
    clearDirectCallUserRequestedVideoExpand();
  } catch {}
}

export function isFreshDirectCallAudioAcceptCallActive(callId?: string | null): boolean {
  const cid = String(callId || '').trim();
  if (!cid) return false;
  try {
    return String((global as any).__freshDirectCallAudioAcceptCallIdRef?.current || '') === cid;
  } catch {
    return false;
  }
}

export function clearFreshDirectCallAudioAcceptCall(): void {
  try {
    const g = global as any;
    if (g.__freshDirectCallAudioAcceptCallIdRef) {
      g.__freshDirectCallAudioAcceptCallIdRef.current = null;
    }
  } catch {}
}

/** Авто-expand / PiP-return video UI на свежем audio accept без явного запроса пользователя. */
export function shouldBlockFreshDirectCallAudioAutomatedVideoExpand(
  callId?: string | null,
): boolean {
  if (!isFreshDirectCallAudioAcceptCallActive(callId)) return false;
  return !isDirectCallUserRequestedVideoExpand();
}

/** Первый audio-first accept для callId уже применён — не повторять fresh layout на PiP-return/remount. */
export function markDirectCallAudioAcceptBootstrapped(callId?: string | null): void {
  const cid = String(callId || '').trim();
  if (!cid) return;
  try {
    const g = global as any;
    g.__directCallAudioAcceptBootstrappedCallIdRef =
      g.__directCallAudioAcceptBootstrappedCallIdRef || { current: null as string | null };
    g.__directCallAudioAcceptBootstrappedCallIdRef.current = cid;
  } catch {}
}

export function isDirectCallAudioAcceptBootstrapped(callId?: string | null): boolean {
  const cid = String(callId || '').trim();
  if (!cid) return false;
  try {
    return (
      String((global as any).__directCallAudioAcceptBootstrappedCallIdRef?.current || '') === cid
    );
  } catch {
    return false;
  }
}

export function clearDirectCallAudioAcceptBootstrapped(): void {
  try {
    const g = global as any;
    if (g.__directCallAudioAcceptBootstrappedCallIdRef) {
      g.__directCallAudioAcceptBootstrappedCallIdRef.current = null;
    }
  } catch {}
}

/** Пользователь на video UI (expand / PiP→fullscreen / камера), не на audio-only. */
export function isDirectCallVideoUiActive(): boolean {
  try {
    const g = global as any;
    const params = g.__currentCallPiPParamsRef?.current;
    const routePrefersVideo =
      params?.preferVideoCallUi === true || readDirectCallPiPParamsPreferVideo();
    if (isDirectCallVideoExpandGuardActive()) return true;
    if (isDirectCallUserRequestedVideoExpand()) {
      return routePrefersVideo || isDirectCallVideoExpandGuardActive();
    }
    if (g.__expandToVideoCallUiFromPiPRef?.current === true) {
      return routePrefersVideo || isDirectCallVideoExpandGuardActive();
    }
    if (g.__stayOnVideoCallUiRef?.current === true) return true;
    if (routePrefersVideo) return true;
    const session = g.__webrtcSessionRef?.current;
    if (session && typeof session.getIsCamOn === 'function' && session.getIsCamOn()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Не переводить в audio-only / enterDirectCallAudioOnlyMode / applyAudioOnlyUiState. */
export function shouldSuppressDirectCallAudioOnlyUiTransition(): boolean {
  return isDirectCallVideoUiActive();
}

/** Один expand + enable camera на всех входах (PiP overlay, mount, focus). */
export function runDirectCallVideoExpandOnce(run: () => Promise<void>): Promise<void> {
  try {
    const g = global as any;
    g.__directCallVideoExpandPromiseRef =
      g.__directCallVideoExpandPromiseRef || { current: null as Promise<void> | null };
    const existing = g.__directCallVideoExpandPromiseRef.current;
    if (existing) return existing;
    if (!tryBeginDirectCallVideoExpand()) {
      return Promise.resolve();
    }
    const task = (async () => {
      try {
        await run();
      } finally {
        finishDirectCallVideoExpandInFlight();
        try {
          g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
          g.__expandToVideoCallUiFromPiPRef.current = false;
        } catch {}
      }
    })();
    g.__directCallVideoExpandPromiseRef.current = task;
    return task.finally(() => {
      if (g.__directCallVideoExpandPromiseRef?.current === task) {
        g.__directCallVideoExpandPromiseRef.current = null;
      }
    });
  } catch {
    return Promise.resolve();
  }
}

/** In-app PiP → экран видеозвонка с Home / другого экрана (не audio UI). */
export function prepareDirectCallVideoReturnFromPiP(): void {
  try {
    const g = global as any;
    g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
    g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
    g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
    g.__expandToVideoCallUiFromPiPRef.current = true;
    g.__inAudioOnlyUiRef = g.__inAudioOnlyUiRef || { current: false };
    g.__inAudioOnlyUiRef.current = false;
    setPipAudioOnlyPlaceholderSticky(false);
    setPipInAppRtcFromAudioOnlySticky(false);
    try {
      g.__stayOnVideoCallUiRef = g.__stayOnVideoCallUiRef || { current: false };
      g.__stayOnVideoCallUiRef.current = true;
    } catch {}
    const paramsRef = g.__currentCallPiPParamsRef?.current;
    if (paramsRef && typeof paramsRef === 'object') {
      paramsRef.inAudioOnlyUi = false;
      paramsRef.preferVideoCallUi = true;
      paramsRef.localCamOn = true;
    }
    g.__directCallAudioOnlyPreparedAtRef = g.__directCallAudioOnlyPreparedAtRef || { current: 0 };
    g.__directCallAudioOnlyPreparedAtRef.current = 0;
    touchDirectCallVideoExpandGuard();
  } catch {}
}
