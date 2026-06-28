import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';

const CALL_AUDIO_PRESERVE_PRIORITY_MS = 4000;
const CALL_AUDIO_UI_ROUTE_LOCK_MS = 8500;
const CALL_AUDIO_NATIVE_TRANSITION_MS = 500;
const CALL_AUDIO_PREFER_QUIET_MS = 450;

/** После sync/bootstrap — не перебивать preferAudioMode (убирает SPEAKER→BT мерцание). */
export function armCallAudioPreferAudioModeQuiet(ms = CALL_AUDIO_PREFER_QUIET_MS): void {
  try {
    const g = global as any;
    g.__callAudioPreferQuietUntilRef = g.__callAudioPreferQuietUntilRef || { current: 0 };
    g.__callAudioPreferQuietUntilRef.current = Date.now() + ms;
  } catch {}
}

export function isCallAudioPreferAudioModeQuiet(): boolean {
  try {
    const g = global as any;
    return Date.now() < Number(g.__callAudioPreferQuietUntilRef?.current || 0);
  } catch {}
  return false;
}

/** return_to_audio_ui_sync только что выставил маршрут — не дублировать отложенный reapply. */
export function markCallAudioReturnToUiSyncApplied(route: InCallAudioRoute): void {
  try {
    const g = global as any;
    g.__callAudioReturnSyncRouteRef = g.__callAudioReturnSyncRouteRef || { current: null };
    g.__callAudioReturnSyncAtRef = g.__callAudioReturnSyncAtRef || { current: 0 };
    g.__callAudioReturnSyncRouteRef.current = route;
    g.__callAudioReturnSyncAtRef.current = Date.now();
    armCallAudioPreferAudioModeQuiet();
  } catch {}
}

export function shouldSkipScheduledReturnToAudioUiReapply(expectedRoute?: InCallAudioRoute): boolean {
  try {
    const g = global as any;
    const at = Number(g.__callAudioReturnSyncAtRef?.current || 0);
    if (Date.now() - at > 2500) return false;
    const synced = normalizeInCallRoute(g.__callAudioReturnSyncRouteRef?.current || '');
    if (!synced) return false;
    if (expectedRoute && normalizeInCallRoute(expectedRoute) !== synced) return false;
    return true;
  } catch {}
  return false;
}

/** Короткое окно PiP enter/exit/focus — без InCallManager stop/start и полного bootstrap. */
export function armCallAudioNativeTransitionLock(ms = CALL_AUDIO_NATIVE_TRANSITION_MS): void {
  try {
    const g = global as any;
    g.__callAudioNativeTransitionUntilRef = g.__callAudioNativeTransitionUntilRef || { current: 0 };
    g.__callAudioNativeTransitionUntilRef.current = Math.max(
      Number(g.__callAudioNativeTransitionUntilRef.current || 0),
      Date.now() + ms,
    );
  } catch {}
}

export function isCallAudioNativeTransitionLocked(): boolean {
  try {
    const g = global as any;
    return Date.now() < Number(g.__callAudioNativeTransitionUntilRef?.current || 0);
  } catch {}
  return false;
}

/** Окно enter/exit system PiP и возврата — не форсить громкую связь поверх earpiece/BT. */
export function isCallAudioPiPTransitionWindow(): boolean {
  try {
    const g = global as any;
    const now = Date.now();
    if (now < Number(g.__returningFromSystemPiPUntilRef?.current || 0)) return true;
    if (g.__pipInSystemModeRef?.current === true) return true;
    if (now < Number(g.__systemPiPEntryInProgressUntilRef?.current || 0)) return true;
    if (now < Number(g.__callAudioPreservePriorityUntilRef?.current || 0)) return true;
  } catch {}
  return false;
}

export function armCallAudioPreservePriority(ms = CALL_AUDIO_PRESERVE_PRIORITY_MS): void {
  try {
    const g = global as any;
    g.__callAudioPreservePriorityUntilRef = g.__callAudioPreservePriorityUntilRef || { current: 0 };
    g.__callAudioPreservePriorityUntilRef.current = Math.max(
      Number(g.__callAudioPreservePriorityUntilRef.current || 0),
      Date.now() + ms,
    );
  } catch {}
}

/** Фиксирует маршрут для UI и auto-paths после выхода с плашки на audio UI (без мерцания). */
export function armCallAudioRouteUiLock(route: InCallAudioRoute, ms = CALL_AUDIO_UI_ROUTE_LOCK_MS): void {
  if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE' && !isExternalHeadsetRoute(route)) {
    return;
  }
  try {
    const g = global as any;
    g.__callAudioUiLockedRouteRef = g.__callAudioUiLockedRouteRef || { current: null as InCallAudioRoute | null };
    g.__callAudioUiLockUntilRef = g.__callAudioUiLockUntilRef || { current: 0 };
    g.__callAudioUiLockedRouteRef.current = route;
    g.__callAudioUiLockUntilRef.current = Date.now() + ms;
    armCallAudioPreservePriority(ms);
  } catch {}
}

export function readCallAudioRouteUiLock(): InCallAudioRoute | null {
  try {
    const g = global as any;
    if (Date.now() >= Number(g.__callAudioUiLockUntilRef?.current || 0)) return null;
    const r = normalizeInCallRoute(g.__callAudioUiLockedRouteRef?.current || '');
    if (r === 'EARPIECE' || r === 'SPEAKER_PHONE' || isExternalHeadsetRoute(r)) return r;
  } catch {}
  return null;
}

export function clearCallAudioRouteUiLock(): void {
  try {
    const g = global as any;
    if (g.__callAudioUiLockedRouteRef) g.__callAudioUiLockedRouteRef.current = null;
    if (g.__callAudioUiLockUntilRef) g.__callAudioUiLockUntilRef.current = 0;
  } catch {}
}

export function resolveExternalRouteForAudioUiBootstrap(
  uiLock: InCallAudioRoute | null,
): InCallAudioRoute | null {
  try {
    const g = global as any;
    const extMarked = normalizeInCallRoute(g.__userSelectedExternalCallAudioRouteRef?.current || '');
    if (isExternalHeadsetRoute(extMarked)) return extMarked;
    const userSel = normalizeInCallRoute(g.__userSelectedCallAudioRouteRef?.current || '');
    if (isExternalHeadsetRoute(userSel)) return userSel;
    if (isExternalHeadsetRoute(uiLock)) return uiLock;
  } catch {}
  return null;
}
