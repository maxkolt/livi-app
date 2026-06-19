import { NativeModules, Platform } from 'react-native';
import { logger } from './logger';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';

export type NativeCallAudioProbe = {
  available: InCallAudioRoute[];
  preferred: InCallAudioRoute | null;
};

function parseProbe(raw: unknown): NativeCallAudioProbe {
  const available: InCallAudioRoute[] = [];
  const list = (raw as { available?: unknown[] })?.available;
  if (Array.isArray(list)) {
    for (const item of list) {
      const r = normalizeInCallRoute(String(item || ''));
      if (r && !available.includes(r)) available.push(r);
    }
  }
  const preferred = normalizeInCallRoute(String((raw as { preferred?: string })?.preferred || '')) || null;
  return { available, preferred };
}

/** Android AudioManager — до onAudioDeviceChanged от InCallManager. */
export async function probeNativeCallAudioRoutes(): Promise<NativeCallAudioProbe> {
  if (Platform.OS !== 'android') return { available: [], preferred: null };
  try {
    const mod = NativeModules.LiviAppModule as {
      getVoiceCallCommunicationRoutes?: () => Promise<unknown>;
    };
    if (typeof mod?.getVoiceCallCommunicationRoutes !== 'function') {
      return { available: [], preferred: null };
    }
    const parsed = parseProbe(await mod.getVoiceCallCommunicationRoutes());
    if (parsed.available.includes('BLUETOOTH') || parsed.preferred === 'BLUETOOTH') {
      logger.info('[nativeCallAudioProbe] BT in communication devices', parsed);
    }
    return parsed;
  } catch {
    return { available: [], preferred: null };
  }
}

export function mergeNativeProbeIntoGlobal(probe: NativeCallAudioProbe): InCallAudioRoute[] {
  const g = global as any;
  g.__nativeCallAudioRoutesRef = { current: probe };
  const prev: InCallAudioRoute[] = Array.isArray(g.__inCallAvailableAudioRoutesRef?.current)
    ? g.__inCallAvailableAudioRoutesRef.current
    : [];
  const merged = Array.from(new Set([...probe.available, ...prev]));
  g.__inCallAvailableAudioRoutesRef = { current: merged };
  return merged;
}

export function readNativeProbedExternalRoute(): InCallAudioRoute | null {
  try {
    const probe = (global as any).__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined;
    if (!probe) return null;
    if (probe.preferred && isExternalHeadsetRoute(probe.preferred)) return probe.preferred;
    if (probe.available.includes('BLUETOOTH')) return 'BLUETOOTH';
    if (probe.available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
  } catch {}
  return null;
}

export function isCallAudioBootstrapPending(): boolean {
  try {
    return (global as any).__callAudioBootstrapPendingRef?.current !== false;
  } catch {
    return false;
  }
}

export function setCallAudioBootstrapPending(pending: boolean): void {
  try {
    (global as any).__callAudioBootstrapPendingRef = { current: pending };
  } catch {}
}
