import { setPipAudioOnlyPlaceholderSticky } from './callAudioOnlyUiContext';

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
