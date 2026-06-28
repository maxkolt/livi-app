import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';
import { isExternalHeadsetRoute, normalizeInCallRoute } from '../components/VideoChat/hooks/audioRouteTypes';

const CALL_AUDIO_PRESERVE_PRIORITY_MS = 4000;
const CALL_AUDIO_UI_ROUTE_LOCK_MS = 8500;

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
