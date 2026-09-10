import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import { readNativeProbedExternalRoute } from './nativeCallAudioProbe';

function readInCallAvailableAudioRoutesList(): string[] {
  try {
    const av = (global as any).__inCallAvailableAudioRoutesRef?.current;
    return Array.isArray(av) ? av.map((s: unknown) => String(s)) : [];
  } catch {
    return [];
  }
}

function readUserSelectedExternalFromGlobals(): InCallAudioRoute | null {
  try {
    const entry = (global as any).__userSelectedExternalCallAudioRouteRef?.current;
    const route = normalizeInCallRoute(entry?.route || '');
    if (!route || !isExternalHeadsetRoute(route)) return null;
    if (Number(entry?.until || 0) <= Date.now()) return null;
    const available = readInCallAvailableAudioRoutesList();
    if (!available.length || !available.includes(route)) {
      try {
        const probe = (global as any).__nativeCallAudioRoutesRef?.current as
          | { available?: string[] }
          | undefined;
        if (Array.isArray(probe?.available) && probe.available.includes(route)) {
          if (route === 'BLUETOOTH') {
            const cached = (global as any).__callBtHeadsetConnectedRef?.current;
            if (cached === false) return null;
          }
          return route;
        }
      } catch {}
      if (!available.length) return route;
      return null;
    }
    return route;
  } catch {
    return null;
  }
}

/** BT / wired from globals (no activeCallSession import — breaks require cycle with PiP). */
function readActiveExternalCallAudioRouteFromGlobals(
  liveUserRoute?: InCallAudioRoute | string | null,
): InCallAudioRoute | null {
  try {
    const lastApplied = normalizeInCallRoute(
      (global as any).__lastAppliedCallAudioRouteRef?.current || '',
    );
    const candidates = [
      readUserSelectedExternalFromGlobals(),
      normalizeInCallRoute(liveUserRoute || ''),
      lastApplied,
      normalizeInCallRoute((global as any).__currentCallPiPParamsRef?.current?.audioOutputRoute || ''),
      normalizeInCallRoute((global as any).__persistedCallAudioRouteRef?.current || ''),
    ];
    return candidates.find((r) => r && isExternalHeadsetRoute(r)) || null;
  } catch {
    return null;
  }
}

/**
 * Headset that is actually in InCallManager list (persist + selected + hint).
 */
export function readConnectedExternalCallAudioRoute(
  hint?: InCallAudioRoute | string | null,
): InCallAudioRoute | null {
  const available = readInCallAvailableAudioRoutesList();
  const nativeExt = readNativeProbedExternalRoute();
  // Probe важнее отстающего ICM (accept/bootstrap).
  if (nativeExt) return nativeExt;
  const fromPersist = readActiveExternalCallAudioRouteFromGlobals(hint);
  if (fromPersist) {
    if (!available.length || available.includes(fromPersist)) return fromPersist;
    try {
      const probe = (global as any).__nativeCallAudioRoutesRef?.current as
        | { available?: string[] }
        | undefined;
      if (Array.isArray(probe?.available) && probe.available.includes(fromPersist)) {
        return fromPersist;
      }
    } catch {}
  }
  try {
    const selected = normalizeInCallRoute((global as any).__inCallSelectedAudioRouteRef?.current || '');
    if (isExternalHeadsetRoute(selected) && available.includes(selected)) {
      return selected;
    }
  } catch {}
  const hintNorm = normalizeInCallRoute(hint || '');
  if (hintNorm === 'BLUETOOTH' && available.includes('BLUETOOTH')) return 'BLUETOOTH';
  if (hintNorm === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
  return null;
}
