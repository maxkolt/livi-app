import { Platform } from 'react-native';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  normalizeInCallRoute,
} from '../components/VideoChat/hooks/audioRouteTypes';
import {
  clearBuiltinPinForExternalHeadsetConnect,
  markUserSelectedExternalCallAudioRoute,
  readUserSelectedCallAudioRoute,
  readUserSelectedExternalCallAudioRoute,
  readUserLockedBuiltinCallAudioRoute,
  userExplicitlyPinnedBuiltinCallAudio,
  resolveActiveCallInCallMedia,
  setUserSelectedCallAudioRoute,
} from './activeCallSession';
import { isInAudioOnlyCallUi } from './callAudioOnlyUiContext';
import {
  applyCallAudioOutputRouteNow,
  clearCallAudioRouteUiLock,
  scheduleReapplyPersistedCallAudioRoute,
  setPersistedCallAudioRoute,
  cancelScheduledCallAudioRouteReappliesMatching,
  armCallAudioRouteUiLock,
} from './callAudioRoutePersist';
import { notifyInAppPiPAudioRouteUi } from './callInAppPiPAudioRouteUi';
import {
  isBluetoothHeadsetActiveForCall,
  isNativeBluetoothHeadsetConnectedForCall,
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  setCallBluetoothHeadsetConnectedCache,
  clearNativeProbeBluetoothRoute,
  clearNativeProbeWiredHeadsetRoute,
} from './nativeCallAudioProbe';
import {
  preferSpeakerAfterHeadsetDisconnect,
  resolveCallRouteAfterHeadsetDisconnect,
} from './callHeadsetAudioFallback';

import {
  isInAppPiPExplicitBuiltinRouteChoiceActive,
  isInAppPiPManualRouteLockActive,
  readInAppPiPPlaqueAudioRoute,
} from './inAppPiPExplicitBuiltinRoute';

export {
  isInAppPiPExplicitBuiltinRouteChoiceActive,
  isInAppPiPManualRouteLockActive,
} from './inAppPiPExplicitBuiltinRoute';

function readPlaqueRoute(): InCallAudioRoute | null {
  return readInAppPiPPlaqueAudioRoute();
}

function pipPlaqueVisible(): boolean {
  try {
    return (global as any).__pipVisibleRef?.current === true;
  } catch {
    return false;
  }
}

const IN_APP_PIP_HEADSET_CONNECT_COOLDOWN_MS = 2200;

/** In-app PiP без VideoCall: подключили BT/провод — нативный маршрут + иконка плашки. */
export async function applyInAppPiPHeadsetConnectRoute(
  route: 'BLUETOOTH' | 'WIRED_HEADSET',
  reason: string,
): Promise<boolean> {
  if (Platform.OS !== 'android' || !pipPlaqueVisible()) return false;
  if (isInAppPiPManualRouteLockActive()) return false;
  if (isInAppPiPExplicitBuiltinRouteChoiceActive()) return false;
  if (userExplicitlyPinnedBuiltinCallAudio()) return false;
  if (route === 'BLUETOOTH') {
    const bt = await isNativeBluetoothHeadsetConnectedForCall();
    setCallBluetoothHeadsetConnectedCache(bt);
    if (!bt) return false;
  }
  try {
    const g = global as any;
    g.__lastInAppPiPHeadsetConnectAtRef = g.__lastInAppPiPHeadsetConnectAtRef || { current: 0 };
    g.__lastInAppPiPHeadsetConnectRouteRef =
      g.__lastInAppPiPHeadsetConnectRouteRef || { current: null as InCallAudioRoute | null };
    const now = Date.now();
    const lastAt = Number(g.__lastInAppPiPHeadsetConnectAtRef.current || 0);
    const lastRoute = g.__lastInAppPiPHeadsetConnectRouteRef.current;
    const lastApplied = normalizeInCallRoute(g.__lastAppliedCallAudioRouteRef?.current || '');
    if (
      route === lastRoute &&
      route === lastApplied &&
      now - lastAt < IN_APP_PIP_HEADSET_CONNECT_COOLDOWN_MS
    ) {
      return true;
    }
    if (
      route === lastApplied &&
      readUserSelectedExternalCallAudioRoute() === route &&
      now - lastAt < IN_APP_PIP_HEADSET_CONNECT_COOLDOWN_MS
    ) {
      return true;
    }
    clearBuiltinPinForExternalHeadsetConnect();
    clearCallAudioRouteUiLock();
    cancelScheduledCallAudioRouteReappliesMatching([
      'return_to_audio_ui',
      'audio_home_preserve_route',
    ]);
    setUserSelectedCallAudioRoute(route);
    setPersistedCallAudioRoute(route);
    markUserSelectedExternalCallAudioRoute(route);
    g.__inCallSelectedAudioRouteRef = { current: route };
    g.__lastAppliedCallAudioRouteRef = { current: route };
    const params = g.__currentCallPiPParamsRef?.current;
    if (params && typeof params === 'object') {
      params.audioOutputRoute = route;
    }
    const media =
      g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
        ? 'audio'
        : resolveActiveCallInCallMedia();
    await applyCallAudioOutputRouteNow(route, { media, forceBuiltIn: false });
    notifyInAppPiPAudioRouteUi(route);
    g.__lastInAppPiPHeadsetConnectAtRef.current = now;
    g.__lastInAppPiPHeadsetConnectRouteRef.current = route;
    cancelScheduledCallAudioRouteReappliesMatching(['in_app_pip_headset_connect']);
    scheduleReapplyPersistedCallAudioRoute('in_app_pip_headset_connect', {
      media,
      delaysMs: [0],
      skipInCallRestart: true,
      honorUserRoute: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-app PiP: наушники сняли — native/ICM могут отставать, опрос по AudioManager.
 */
export async function tryAutoSwitchInAppPiPFromDisconnectedHeadset(): Promise<InCallAudioRoute | null> {
  if (Platform.OS !== 'android' || !pipPlaqueVisible()) return null;
  if (isInAppPiPManualRouteLockActive()) return null;
  if (isInAppPiPExplicitBuiltinRouteChoiceActive()) return null;

  const plaque = readPlaqueRoute();
  const userSel = readUserSelectedCallAudioRoute();
  const userExt = readUserSelectedExternalCallAudioRoute();
  const lastApplied = normalizeInCallRoute(
    (global as any).__lastAppliedCallAudioRouteRef?.current || '',
  );

  const uiShowsBt =
    plaque === 'BLUETOOTH' || userSel === 'BLUETOOTH' || userExt === 'BLUETOOTH' || lastApplied === 'BLUETOOTH';
  const uiShowsWired =
    plaque === 'WIRED_HEADSET' ||
    userSel === 'WIRED_HEADSET' ||
    userExt === 'WIRED_HEADSET' ||
    lastApplied === 'WIRED_HEADSET';
  if (!uiShowsBt && !uiShowsWired) return null;

  const probe = await probeNativeCallAudioRoutes();
  mergeNativeProbeIntoGlobal(probe);
  const btNative = await isNativeBluetoothHeadsetConnectedForCall();
  setCallBluetoothHeadsetConnectedCache(btNative);

  const wiredLive = probe.available.includes('WIRED_HEADSET');
  const btLive = btNative && probe.available.includes('BLUETOOTH');

  if (uiShowsBt && btLive) return null;
  if (uiShowsWired && wiredLive && !uiShowsBt) return null;
  if (uiShowsBt && !btLive) {
    // continue to fallback
  } else if (uiShowsWired && !wiredLive) {
    // continue
  } else {
    return null;
  }

  if (uiShowsBt && !btLive) clearNativeProbeBluetoothRoute();
  if (uiShowsWired && !wiredLive) clearNativeProbeWiredHeadsetRoute();

  cancelScheduledCallAudioRouteReappliesMatching([
    'in_app_pip_headset_connect',
    'in_app_pip_preserve_external',
    'in_app_pip_from_audio',
    'in_app_pip_from_video',
    'audio_ui_headset_connect',
    'in_app_pip_headset_unplug',
  ]);

  const g = global as any;
  let fallback: InCallAudioRoute = 'EARPIECE';
  if (wiredLive && uiShowsBt && !btLive) {
    fallback = 'WIRED_HEADSET';
  } else {
    const fromAudioPiP =
      g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi();
    fallback =
      fromAudioPiP && !preferSpeakerAfterHeadsetDisconnect()
        ? 'EARPIECE'
        : resolveCallRouteAfterHeadsetDisconnect();
  }

  try {
    g.__userSelectedExternalCallAudioRouteRef = { current: null };
  } catch {}
  setUserSelectedCallAudioRoute(fallback);
  setPersistedCallAudioRoute(fallback);
  g.__inCallSelectedAudioRouteRef = { current: fallback };
  g.__lastAppliedCallAudioRouteRef = { current: fallback };
  const params = g.__currentCallPiPParamsRef?.current;
  if (params && typeof params === 'object') {
    params.audioOutputRoute = fallback;
  }
  const media =
    g.__pipInAppRtcFromAudioOnlyRef?.current === true || isInAudioOnlyCallUi()
      ? 'audio'
      : resolveActiveCallInCallMedia();
  await applyCallAudioOutputRouteNow(fallback, { media, forceBuiltIn: true });
  if (fallback === 'EARPIECE') {
    armCallAudioRouteUiLock('EARPIECE');
  }
  notifyInAppPiPAudioRouteUi(fallback);
  scheduleReapplyPersistedCallAudioRoute('in_app_pip_headset_unplug', {
    media,
    delaysMs: [0],
    skipInCallRestart: true,
    honorUserRoute: true,
  });
  return fallback;
}

/**
 * Опрос (плашка на Home): ICM/onAudioDeviceChanged может не прийти — ловим BT по native probe.
 */
let lastPiPHeadsetPollAttemptAt = 0;

export async function tryAutoSwitchInAppPiPToConnectedHeadset(): Promise<InCallAudioRoute | null> {
  if (Platform.OS !== 'android' || !pipPlaqueVisible()) return null;
  if (isInAppPiPManualRouteLockActive()) return null;
  if (isInAppPiPExplicitBuiltinRouteChoiceActive()) return null;
  if (userExplicitlyPinnedBuiltinCallAudio()) return null;
  const pollNow = Date.now();
  if (pollNow - lastPiPHeadsetPollAttemptAt < 900) {
    return null;
  }
  lastPiPHeadsetPollAttemptAt = pollNow;

  const plaque = readPlaqueRoute();
  const userSel = readUserSelectedCallAudioRoute();
  const lastApplied = normalizeInCallRoute(
    (global as any).__lastAppliedCallAudioRouteRef?.current || '',
  );
  if (plaque === 'BLUETOOTH' && (userSel === 'BLUETOOTH' || lastApplied === 'BLUETOOTH')) {
    const stillBt = await isNativeBluetoothHeadsetConnectedForCall();
    setCallBluetoothHeadsetConnectedCache(stillBt);
    if (stillBt && isBluetoothHeadsetActiveForCall()) {
      return 'BLUETOOTH';
    }
  }

  const probe = await probeNativeCallAudioRoutes();
  mergeNativeProbeIntoGlobal(probe);

  const wired = probe.available.includes('WIRED_HEADSET');
  const bt =
    probe.available.includes('BLUETOOTH') &&
    (await isNativeBluetoothHeadsetConnectedForCall());
  setCallBluetoothHeadsetConnectedCache(bt);

  const target: InCallAudioRoute | null = wired
    ? 'WIRED_HEADSET'
    : bt
      ? 'BLUETOOTH'
      : null;
  if (!target) return null;

  if (plaque === target && userSel === target && lastApplied === target) {
    return target;
  }
  if (isExternalHeadsetRoute(plaque) && plaque === target) {
    return target;
  }

  const onBuiltin =
    plaque === 'EARPIECE' ||
    plaque === 'SPEAKER_PHONE' ||
    userSel === 'EARPIECE' ||
    userSel === 'SPEAKER_PHONE' ||
    lastApplied === 'EARPIECE' ||
    lastApplied === 'SPEAKER_PHONE' ||
    !plaque;

  if (!onBuiltin && !isExternalHeadsetRoute(plaque)) return null;

  const ok = await applyInAppPiPHeadsetConnectRoute(target, 'pip_poll_auto_headset');
  return ok ? target : null;
}

/** Синхронная проверка для onAudioDeviceChanged (список уже обновлён). */
export function shouldAutoBtConnectFromDeviceList(
  available: string[],
  prev: string[],
): boolean {
  if (!pipPlaqueVisible()) return false;
  if (isInAppPiPExplicitBuiltinRouteChoiceActive()) return false;
  if (userExplicitlyPinnedBuiltinCallAudio()) return false;
  const gainedBt = available.includes('BLUETOOTH') && !prev.includes('BLUETOOTH');
  if (gainedBt) return true;
  if (!available.includes('BLUETOOTH') || !isBluetoothHeadsetActiveForCall()) return false;
  const plaque = readPlaqueRoute();
  const userSel = readUserSelectedCallAudioRoute();
  if (plaque === 'BLUETOOTH' || userSel === 'BLUETOOTH') return false;
  return (
    plaque === 'EARPIECE' ||
    plaque === 'SPEAKER_PHONE' ||
    userSel === 'EARPIECE' ||
    userSel === 'SPEAKER_PHONE'
  );
}
