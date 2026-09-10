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
  /** Native: SCO/audio actually on — не idle paired в кейсе. */
  btCallAudioActive?: boolean;
  /** Native: HFP/paired виден (может быть idle в кейсе). */
  btPairedAvailable?: boolean;
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
  const btCallAudioActive = (raw as { btCallAudioActive?: boolean })?.btCallAudioActive === true;
  const btPairedAvailable = (raw as { btPairedAvailable?: boolean })?.btPairedAvailable === true;
  return { available, preferred, btCallAudioActive, btPairedAvailable };
}

export function setCallBluetoothHeadsetConnectedCache(connected: boolean): void {
  try {
    (global as any).__callBtHeadsetConnectedRef = { current: connected };
  } catch {}
}

export function readCallBluetoothHeadsetConnectedCache(): boolean | null {
  try {
    const v = (global as any).__callBtHeadsetConnectedRef?.current;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** Синхронный gate: только cache после native strict (не ICM list — в кейсе OEM врёт). */
export function isBluetoothHeadsetActiveForCall(): boolean {
  const cached = readCallBluetoothHeadsetConnectedCache();
  if (cached === false) return false;
  if (cached === true) return true;
  return false;
}

export async function refreshCallBluetoothHeadsetConnectedCache(): Promise<boolean> {
  const bt =
    Platform.OS === 'android' ? await isNativeBluetoothHeadsetConnectedForCall() : false;
  setCallBluetoothHeadsetConnectedCache(bt);
  if (!bt) clearNativeProbeBluetoothRoute();
  return bt;
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

/** Raw SCO/HFP audio without preferred-EAR kill — rising-edge wear after accept. */
export async function isNativeBluetoothHeadsetScoAudioConnected(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const mod = NativeModules.LiviAppModule as {
      isBluetoothHeadsetScoAudioConnected?: () => Promise<boolean>;
    };
    if (typeof mod?.isBluetoothHeadsetScoAudioConnected !== 'function') return false;
    return !!(await mod.isBluetoothHeadsetScoAudioConnected());
  } catch {
    return false;
  }
}

export async function startNativeBluetoothHeadsetWearMonitor(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    const mod = NativeModules.LiviAppModule as {
      startBluetoothHeadsetWearMonitor?: () => Promise<boolean>;
    };
    if (typeof mod?.startBluetoothHeadsetWearMonitor === 'function') {
      await mod.startBluetoothHeadsetWearMonitor();
    }
  } catch {}
}

/** HFP profile up — без preferred-EAR kill (TWS reconnect после disconnect). */
export async function isNativeBluetoothHeadsetProfileConnected(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const mod = NativeModules.LiviAppModule as {
      isBluetoothHeadsetProfileConnectedForCall?: () => Promise<boolean>;
    };
    if (typeof mod?.isBluetoothHeadsetProfileConnectedForCall !== 'function') return false;
    return !!(await mod.isBluetoothHeadsetProfileConnectedForCall());
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
      const nativeActive = await isNativeBluetoothHeadsetConnectedForCall();
      let btActive = parsed.btCallAudioActive === true || nativeActive;
      // OS на EAR/SPEAKER без native call-audio — buds в кейсе / sticky HFP.
      // Если native SCO уже up (одел) — не обнулять active из‑за запаздывающего preferred.
      const wearSticky =
        Date.now() < Number((global as any).__btWearStickyUntilRef?.current || 0);
      if (
        !wearSticky &&
        !nativeActive &&
        (parsed.preferred === 'EARPIECE' || parsed.preferred === 'SPEAKER_PHONE')
      ) {
        btActive = false;
      }
      const btPaired =
        parsed.btPairedAvailable === true ||
        btActive ||
        parsed.available.includes('BLUETOOTH');
      parsed.btCallAudioActive = btActive;
      parsed.btPairedAvailable = btPaired;
      // Cache = только call-audio active (не paired-in-case).
      setCallBluetoothHeadsetConnectedCache(btActive);
      if (!btPaired) {
        parsed.available = parsed.available.filter((r) => r !== 'BLUETOOTH');
        if (parsed.preferred === 'BLUETOOTH' && !btActive) parsed.preferred = null;
      } else if (!parsed.available.includes('BLUETOOTH')) {
        parsed.available = [...parsed.available, 'BLUETOOTH'];
      }
      if (!btActive && parsed.preferred === 'BLUETOOTH') {
        // preferred BT без active — не считаем auto-ready.
      }
    }
    if (
      parsed.available.includes('BLUETOOTH') ||
      parsed.preferred === 'BLUETOOTH' ||
      parsed.btCallAudioActive ||
      parsed.btPairedAvailable
    ) {
      const prev = (global as any).__nativeCallAudioProbeLogSigRef?.current as string | undefined;
      const sig = `${parsed.available.join(',')}|${parsed.preferred || ''}|a=${parsed.btCallAudioActive ? 1 : 0}|p=${parsed.btPairedAvailable ? 1 : 0}`;
      if (prev !== sig) {
        (global as any).__nativeCallAudioProbeLogSigRef = { current: sig };
        logger.info('[nativeCallAudioProbe] BT call-audio state', parsed);
      }
    }
    return parsed;
  } catch {
    return { available: [], preferred: null };
  }
}

export function mergeNativeProbeIntoGlobal(probe: NativeCallAudioProbe): InCallAudioRoute[] {
  const g = global as any;
  // Paired в кейсе: держим BLUETOOTH в available для cycle, даже без call-audio active.
  if (probe.btPairedAvailable === true && !probe.available.includes('BLUETOOTH')) {
    probe = {
      ...probe,
      available: Array.from(new Set([...probe.available, 'BLUETOOTH'])),
    };
  }
  g.__nativeCallAudioRoutesRef = { current: probe };
  const prev: InCallAudioRoute[] = Array.isArray(g.__inCallAvailableAudioRoutesRef?.current)
    ? g.__inCallAvailableAudioRoutesRef.current
    : [];
  const probeHas = new Set(probe.available);
  const merged = Array.from(
    new Set([...probe.available, ...prev]),
  ).filter((r) => {
    if (r === 'BLUETOOTH') {
      if (probeHas.has('BLUETOOTH') || probe.btPairedAvailable === true) return true;
      return false;
    }
    if (r === 'WIRED_HEADSET' && !probeHas.has('WIRED_HEADSET')) return false;
    return true;
  });
  g.__inCallAvailableAudioRoutesRef = { current: merged };
  // Cache только call-audio active — paired-in-case не считаем «на BT».
  setCallBluetoothHeadsetConnectedCache(probe.btCallAudioActive === true);
  return merged;
}

/**
 * BT «живой» для teardown/repin: OS already preferred BLUETOOTH или native call-audio active.
 */
export function isBluetoothPreferredForAutoRoute(
  probe?: NativeCallAudioProbe | null,
): boolean {
  try {
    const p =
      probe ||
      ((global as any).__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined);
    if (!p) return false;
    if (p.btCallAudioActive === true && p.preferred === 'BLUETOOTH') {
      return isBluetoothHeadsetActiveForCall();
    }
    if (p.preferred === 'BLUETOOTH' && p.available.includes('BLUETOOTH')) {
      return isBluetoothHeadsetActiveForCall();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Auto-route BT только при call-audio active (SCO / в ушах), не при idle paired в кейсе.
 * Если OS preferred = EAR/SPEAKER — buds в кейсе, даже при sticky HFP.
 */
export function isBluetoothAvailableForAutoRoute(
  probe?: NativeCallAudioProbe | null,
): boolean {
  try {
    const p =
      probe ||
      ((global as any).__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined);
    if (!p) return false;
    if (p.preferred === 'EARPIECE' || p.preferred === 'SPEAKER_PHONE') return false;
    if (p.btCallAudioActive === true) return true;
    if (p.preferred === 'BLUETOOTH' && isBluetoothHeadsetActiveForCall()) return true;
    return false;
  } catch {
    return false;
  }
}

export function isBluetoothPairedAvailable(
  probe?: NativeCallAudioProbe | null,
): boolean {
  try {
    const p =
      probe ||
      ((global as any).__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined);
    if (!p) return false;
    if (p.btPairedAvailable === true) return true;
    if (p.btCallAudioActive === true) return true;
    return p.available.includes('BLUETOOTH');
  } catch {
    return false;
  }
}

export function readNativeProbedExternalRoute(): InCallAudioRoute | null {
  try {
    const probe = (global as any).__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined;
    if (!probe) return null;
    const icmRaw = (global as any).__inCallAvailableAudioRoutesRef?.current;
    const icm = Array.isArray(icmRaw) ? icmRaw.map((s: unknown) => String(s)) : [];
    const listedOrProbeOnly = (route: InCallAudioRoute) =>
      !icm.length || icm.includes(route) || probe.available.includes(route);
    if (
      probe.preferred === 'WIRED_HEADSET' &&
      listedOrProbeOnly('WIRED_HEADSET')
    ) {
      return 'WIRED_HEADSET';
    }
    if (probe.available.includes('WIRED_HEADSET') && listedOrProbeOnly('WIRED_HEADSET')) {
      return 'WIRED_HEADSET';
    }
    // Accept/auto: только call-audio active + preferred BT, не paired-in-case.
    if (
      probe.preferred !== 'EARPIECE' &&
      probe.preferred !== 'SPEAKER_PHONE' &&
      isBluetoothAvailableForAutoRoute(probe)
    ) {
      return 'BLUETOOTH';
    }
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
  setCallBluetoothHeadsetConnectedCache(false);
  try {
    const g = global as any;
    const probe = g.__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined;
    if (probe) {
      // Paired (в кейсе) оставляем в available для cycle; снимаем только call-audio / preferred.
      const keepPaired =
        probe.btPairedAvailable === true || probe.available.includes('BLUETOOTH');
      const available = keepPaired
        ? Array.from(new Set([...probe.available.filter((r) => r !== 'BLUETOOTH'), 'BLUETOOTH']))
        : probe.available.filter((r) => r !== 'BLUETOOTH');
      g.__nativeCallAudioRoutesRef = {
        current: {
          available,
          preferred: probe.preferred === 'BLUETOOTH' ? 'EARPIECE' : probe.preferred,
          btCallAudioActive: false,
          btPairedAvailable: keepPaired,
        },
      };
    }
    const av = g.__inCallAvailableAudioRoutesRef?.current;
    if (Array.isArray(av)) {
      const keepPaired =
        (g.__nativeCallAudioRoutesRef?.current as NativeCallAudioProbe | undefined)
          ?.btPairedAvailable === true;
      g.__inCallAvailableAudioRoutesRef = {
        current: keepPaired
          ? Array.from(new Set([...av.filter((r: string) => r !== 'BLUETOOTH'), 'BLUETOOTH']))
          : av.filter((r: string) => r !== 'BLUETOOTH'),
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
