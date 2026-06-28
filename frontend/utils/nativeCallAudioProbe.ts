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
export async function isNativeBluetoothHeadsetConnectedForCall(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const mod = NativeModules.LiviAppModule as {
      isBluetoothHeadsetConnectedForCall?: () => Promise<boolean>;
    };
    if (typeof mod?.isBluetoothHeadsetConnectedForCall !== 'function') return false;
    return !!(await mod.isBluetoothHeadsetConnectedForCall());
  } catch {
    return false;
  }
}

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
    if (Platform.OS === 'android') {
      const btConnected = await isNativeBluetoothHeadsetConnectedForCall();
      if (!btConnected) {
        parsed.available = parsed.available.filter((r) => r !== 'BLUETOOTH');
        if (parsed.preferred === 'BLUETOOTH') parsed.preferred = null;
      }
    }
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
    const icmRaw = (global as any).__inCallAvailableAudioRoutesRef?.current;
    const icm = Array.isArray(icmRaw) ? icmRaw.map((s: unknown) => String(s)) : [];
    const listed = (route: InCallAudioRoute) => icm.length > 0 && icm.includes(route);
    if (probe.preferred && isExternalHeadsetRoute(probe.preferred) && listed(probe.preferred)) {
      return probe.preferred;
    }
    if (probe.available.includes('WIRED_HEADSET') && listed('WIRED_HEADSET')) return 'WIRED_HEADSET';
    if (probe.available.includes('BLUETOOTH') && listed('BLUETOOTH')) return 'BLUETOOTH';
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

/** После физического отключения BT — не держать stale BLUETOOTH в probe/available. */
export function clearNativeProbeBluetoothRoute(): void {
  try {
    const g = global as any;
    const probe = g.__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined;
    if (probe) {
      g.__nativeCallAudioRoutesRef = {
        current: {
          available: probe.available.filter((r) => r !== 'BLUETOOTH'),
          preferred: probe.preferred === 'BLUETOOTH' ? null : probe.preferred,
        },
      };
    }
    const av = g.__inCallAvailableAudioRoutesRef?.current;
    if (Array.isArray(av)) {
      g.__inCallAvailableAudioRoutesRef = {
        current: av.filter((r: string) => r !== 'BLUETOOTH'),
      };
    }
    const ext = g.__userSelectedExternalCallAudioRouteRef?.current;
    const extRoute = String(ext?.route || '');
    if (extRoute === 'BLUETOOTH') {
      g.__userSelectedExternalCallAudioRouteRef = { current: null };
    }
  } catch {}
}

/** После отключения провода — убрать stale WIRED_HEADSET из probe/available. */
export function clearNativeProbeWiredHeadsetRoute(): void {
  try {
    const g = global as any;
    const probe = g.__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined;
    if (probe) {
      g.__nativeCallAudioRoutesRef = {
        current: {
          available: probe.available.filter((r) => r !== 'WIRED_HEADSET'),
          preferred: probe.preferred === 'WIRED_HEADSET' ? null : probe.preferred,
        },
      };
    }
    const av = g.__inCallAvailableAudioRoutesRef?.current;
    if (Array.isArray(av)) {
      g.__inCallAvailableAudioRoutesRef = {
        current: av.filter((r: string) => r !== 'WIRED_HEADSET'),
      };
    }
    const ext = g.__userSelectedExternalCallAudioRouteRef?.current;
    const extRoute = String(ext?.route || '');
    if (extRoute === 'WIRED_HEADSET') {
      g.__userSelectedExternalCallAudioRouteRef = { current: null };
    }
  } catch {}
}
