import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  DeviceEventEmitter,
  InteractionManager,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { beginBackgroundMediaSuppression, pauseBackgroundMediaAfterCall } from '../../../utils/callKeep';
import { logger } from '../../../utils/logger';
import { applyNativeVoiceCallSpeaker, applyNativeVoiceCallRoute } from '../../../utils/voiceCallAudioRoute';
import {
  isCallAudioBootstrapPending,
  mergeNativeProbeIntoGlobal,
  probeNativeCallAudioRoutes,
  readNativeProbedExternalRoute,
  setCallAudioBootstrapPending,
  clearNativeProbeBluetoothRoute,
  isNativeBluetoothHeadsetConnectedForCall,
} from '../../../utils/nativeCallAudioProbe';
import {
  setPersistedCallAudioRoute,
  scheduleReapplyPersistedCallAudioRoute,
  shouldPreserveCallAudioRouteInInAppPiP,
  getPersistedCallAudioRoute,
  restoreCallAudioForInAppPiPPlaque,
  isCallAudioPiPTransitionWindow,
  clearPersistedCallAudioRoute,
  resolveOngoingVideoCallAudioRoute,
} from '../../../utils/callAudioRoutePersist';
import { isInAudioOnlyCallUi } from '../../../src/pip/pipPlaceholderOnly';
import {
  rememberBuiltinCallRouteBeforeHeadset,
  resolveCallRouteAfterHeadsetDisconnect,
  readBuiltinCallRouteBeforeHeadset,
  readDirectCallAudioRouteBeforeVideo,
  rememberDirectCallAudioRouteBeforeVideo,
} from '../../../utils/callHeadsetAudioFallback';
import {
  isOngoingCallSession,
  shouldDeferCallAudioStopOnHookUnmount,
  readActiveExternalCallAudioRoute,
  readLastAppliedCallAudioRoute,
  readConnectedExternalCallAudioRoute,
  resolveActiveCallInCallMedia,
  markInCallAudioSessionStarted,
  isInCallAudioSessionStarted,
  setUserSelectedCallAudioRoute,
  readUserSelectedCallAudioRoute,
  readUserLockedBuiltinCallAudioRoute,
  rememberManualBuiltinCallAudioRoute,
  markUserSelectedExternalCallAudioRoute,
  isDirectAudioEarpieceStabilizeWindow,
  ongoingCallPrefersVideoMedia,
  readAuthoritativeCallAudioRouteAfterPiP,
  isPiPBuiltinCallAudioRouteLockActive,
} from '../../../utils/activeCallSession';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  nextRouteInCycleForContext,
  normalizeInCallRoute,
} from './audioRouteTypes';

/**
 * Хук для управления аудио-рутированием
 * ВАЖНО: без агрессивных таймеров/пинков — они часто ухудшают стабильность (особенно на Android/ColorOS).
 * Делаем один предсказуемый старт/стоп аудио-сессии, остальное оставляем LiveKit/WebRTC.
 */
export type AudioRoutingOptions = {
  /** Старт с разговорного динамика (earpiece); громкий — только по кнопке. */
  defaultToEarpiece?: boolean;
  /** Выбранный пользователем маршрут (кнопка цикла + авто при подключении гарнитуры). */
  userRouteRef?: MutableRefObject<InCallAudioRoute>;
  /** @deprecated совместимость: true когда userRoute === SPEAKER_PHONE */
  speakerOnRef?: MutableRefObject<boolean>;
};

function readGlobalBuiltinRouteForSync(): InCallAudioRoute | null {
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked) return locked;
  const explicit = readExplicitUserSelectedBuiltInRoute();
  if (explicit) return explicit;
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'SPEAKER_PHONE') return userSel;
  try {
    const g = global as any;
    const cycled = normalizeInCallRoute(g.__lastCycleUserRouteResultRef?.current || '');
    const cycledAt = Number(g.__lastCycleUserRouteAtRef?.current || 0);
    const cycledCallId = String(g.__lastCycleUserRouteCallIdRef?.current || '').trim();
    const activeCallId = String(g.__activeCallAudioRouteCallIdRef?.current || '').trim();
    if (
      (cycled === 'SPEAKER_PHONE' || cycled === 'EARPIECE') &&
      activeCallId &&
      cycledCallId === activeCallId &&
      Date.now() - cycledAt < 120_000
    ) {
      return cycled;
    }
  } catch {}
  return null;
}

function isHeadsetDisconnectFallbackReason(reason: string): boolean {
  return (
    reason === 'headset_unplug' ||
    reason === 'headset_bt_unplug' ||
    reason === 'headset_poll_unplug' ||
    reason.startsWith('headset_unplug')
  );
}

/** Явный выбор разговорного/громкого — не подменять Bluetooth вне PiP-перехода. */
function readExplicitBuiltInFromGlobal(): boolean {
  try {
    return !!(global as any).__explicitBuiltInCallAudioRouteRef?.current;
  } catch {
    return false;
  }
}

function setExplicitBuiltInGlobal(explicit: boolean): void {
  try {
    const g = global as any;
    g.__explicitBuiltInCallAudioRouteRef =
      g.__explicitBuiltInCallAudioRouteRef || { current: false };
    g.__explicitBuiltInCallAudioRouteRef.current = explicit;
  } catch {}
}

function readUserSelectedBuiltInRoute(): InCallAudioRoute | null {
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') return userSel;
  return null;
}

function readExplicitUserSelectedBuiltInRoute(): InCallAudioRoute | null {
  const locked = readUserLockedBuiltinCallAudioRoute();
  if (locked) return locked;
  const userSel = readUserSelectedBuiltInRoute();
  if (!userSel) return null;
  if (readExplicitBuiltInFromGlobal()) return userSel;
  return null;
}

function hasExplicitBuiltInIntent(route?: InCallAudioRoute | null): boolean {
  const explicit = readExplicitUserSelectedBuiltInRoute();
  if (explicit) return !route || explicit === route;
  return readExplicitBuiltInFromGlobal();
}

function isManualRouteReason(reason: string): boolean {
  return (
    reason.startsWith('cycle') ||
    reason.startsWith('toggle') ||
    reason === 'in_app_pip_audio_route_toggle'
  );
}

function readUserSelectedExternalRoute(): InCallAudioRoute | null {
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === 'BLUETOOTH' || userSel === 'WIRED_HEADSET') return userSel;
  return null;
}

function isExplicitBuiltInRouteChoice(reason: string, route: InCallAudioRoute): boolean {
  if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return false;
  const lockedBuiltin = readExplicitUserSelectedBuiltInRoute();
  if (lockedBuiltin === route) {
    return true;
  }
  if (isManualRouteReason(reason)) {
    return true;
  }
  if (reason === 'return_to_audio_ui' && readUserSelectedCallAudioRoute() === route) {
    return true;
  }
  if (
    reason === 'direct_call_accept_audio_route' ||
    reason === 'applyRouting_locked_bootstrap' ||
    reason === 'applyRouting_deferred_earpiece' ||
    reason.endsWith('_native_repin')
  ) {
    return route === 'EARPIECE' || route === 'SPEAKER_PHONE';
  }
  if (readExplicitBuiltInFromGlobal()) {
    const userSel = readUserSelectedBuiltInRoute();
    if (userSel === route) {
      return true;
    }
    return reason === 'preferAudioMode' || reason === 'return_to_audio_ui';
  }
  const userSel = readUserSelectedCallAudioRoute();
  if (userSel === route && reason.startsWith('cycle')) {
    return true;
  }
  return false;
}

function shouldPreferBluetoothEarlyInCall(reason: string): boolean {
  return (
    reason === 'bootstrap' ||
    reason.startsWith('poll_') ||
    reason === 'applyRouting' ||
    reason === 'applyRouting_repin' ||
    reason === 'onAudioDeviceChanged' ||
    reason === 'remote_stream' ||
    reason === 'remote_stream_repin' ||
    reason === 'session_re_enable' ||
    reason === 'preferAudioMode' ||
    reason === 'native_probe'
  );
}

const MIN_HARD_ROUTE_MS = 500;
const MIN_NATIVE_ROUTE_MS = 600;

const defaultUserRoute = (opts?: AudioRoutingOptions): InCallAudioRoute =>
  opts?.defaultToEarpiece ? 'EARPIECE' : 'SPEAKER_PHONE';

export const useAudioRouting = (
  enabled: boolean,
  remoteStream: any,
  preferAudioMode = false,
  routingOptions?: AudioRoutingOptions,
) => {
  const routingOptionsRef = useRef(routingOptions);
  routingOptionsRef.current = routingOptions;

  const [selectedRoute, setSelectedRoute] = useState<InCallAudioRoute>('EARPIECE');
  const [availableRoutes, setAvailableRoutes] = useState<string[]>([]);

  const didStartRef = useRef(false);
  const bootstrapPendingRef = useRef(false);
  const lastAvailableRef = useRef<string[]>([]);
  const lastSelectedRef = useRef<string>('');
  const lastLogAtRef = useRef(0);
  const btPermissionRequestedRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const lastRefreshAtRef = useRef(0);
  const lastHardRouteAtRef = useRef(0);
  const lastHardRouteSpeakerRef = useRef<boolean | null>(null);
  const lastNativeRouteAtRef = useRef(0);
  const lastNativeSpeakerRef = useRef<boolean | null>(null);
  const lastRemoteStreamRoutedIdRef = useRef<string | null>(null);
  const lastAppliedRouteRef = useRef<InCallAudioRoute | ''>('');
  const previousAvailableRef = useRef<string[]>([]);
  const deviceChangeContextRef = useRef({ gainedWired: false, gainedBt: false });
  /** Пользователь явно выбрал earpiece/speaker (цикл кнопки) — не подменять на BT в manualSync. */
  const explicitBuiltInChoiceRef = useRef(false);
  const incallOpChainRef = useRef(Promise.resolve());

  const enqueueInCallOp = (op: () => void | Promise<void>) => {
    incallOpChainRef.current = incallOpChainRef.current
      .then(() => op())
      .catch(() => {});
  };

  const routeLog = (event: string, data?: Record<string, unknown>) => {
    const reason = String(data?.reason ?? '');
    const noisy =
      event === 'refreshStatus' ||
      event === 'refreshStatus failed' ||
      event === 'onAudioDeviceChanged' ||
      reason === 'bootstrap' ||
      /^poll_\d+$/.test(reason);
    const now = Date.now();
    if (noisy && now - lastLogAtRef.current < 2500) {
      return;
    }
    if (!noisy) {
      lastLogAtRef.current = now;
    }
    try {
      logger.info('[useAudioRouting]', event, {
        userRoute: getUserRoute(),
        selectedRoute: lastAppliedRouteRef.current,
        defaultToEarpiece: !!routingOptionsRef.current?.defaultToEarpiece,
        ...data,
      });
    } catch {}
  };

  const getUserRoute = (): InCallAudioRoute => {
    const opts = routingOptionsRef.current;
    const fromRef = normalizeInCallRoute(opts?.userRouteRef?.current || '');
    if (fromRef) return fromRef;
    if (opts?.speakerOnRef?.current) return 'SPEAKER_PHONE';
    return defaultUserRoute(opts);
  };

  const shouldPersistAppliedRoute = (route: InCallAudioRoute, reason?: string): boolean => {
    if (isExternalHeadsetRoute(route)) return true;
    const r = String(reason || '');
    return (
      isManualRouteReason(r) ||
      isHeadsetDisconnectFallbackReason(r) ||
      r === 'WiredHeadset_unplug' ||
      r === 'headset_unplug' ||
      r === 'headset_poll_unplug' ||
      r === 'headset_bt_unplug' ||
      hasExplicitBuiltInIntent(route)
    );
  };

  const setUserRoute = (
    route: InCallAudioRoute,
    writeOpts?: { persist?: boolean },
  ) => {
    const opts = routingOptionsRef.current;
    if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
      rememberBuiltinCallRouteBeforeHeadset(route, !!opts?.defaultToEarpiece);
      if (opts?.defaultToEarpiece) {
        rememberDirectCallAudioRouteBeforeVideo(route);
      }
    }
    if (opts?.userRouteRef) {
      opts.userRouteRef.current = route;
    }
    if (opts?.speakerOnRef) {
      opts.speakerOnRef.current = route === 'SPEAKER_PHONE';
    }
    if (writeOpts?.persist !== false) {
      setPersistedCallAudioRoute(route);
    }
    try {
      (global as any).__lastAppliedCallAudioRouteRef = { current: route };
    } catch {}
  };

  const publishRouteState = (available: string[], selected: string) => {
    lastAvailableRef.current = available;
    setAvailableRoutes(available);
    const norm = normalizeInCallRoute(selected);
    try {
      const g = global as any;
      g.__inCallAvailableAudioRoutesRef = g.__inCallAvailableAudioRoutesRef || { current: [] };
      g.__inCallAvailableAudioRoutesRef.current = available;
      g.__inCallSelectedAudioRouteRef = g.__inCallSelectedAudioRouteRef || { current: null };
      g.__inCallSelectedAudioRouteRef.current = norm;
    } catch {}
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
    if (!norm) return;

    lastSelectedRef.current = selected;
    if (earpieceMode) {
      const user = getUserRoute();
      if (isExternalHeadsetRoute(norm)) {
        lastAppliedRouteRef.current = norm;
        setSelectedRoute(norm);
        setUserRoute(norm);
      } else if (norm === 'SPEAKER_PHONE' || norm === 'EARPIECE') {
        setSelectedRoute(norm);
        lastAppliedRouteRef.current = norm;
      } else {
        setSelectedRoute(user);
        lastAppliedRouteRef.current = user;
      }
      return;
    }

    const user = getUserRoute();
    if (
      isExternalHeadsetRoute(user) &&
      available.includes(user) &&
      (!isExternalHeadsetRoute(norm) || norm === user)
    ) {
      lastAppliedRouteRef.current = user;
      setSelectedRoute(user);
      return;
    }

    lastAppliedRouteRef.current = norm;
    setSelectedRoute(norm);
    setUserRoute(norm, {
      persist: isExternalHeadsetRoute(norm) || hasExplicitBuiltInIntent(norm),
    });
  };

  const wantsSpeakerOutput = () => getUserRoute() === 'SPEAKER_PHONE';

  const logRouteInfo = (msg: string, data?: Record<string, unknown>) => {
    routeLog(msg, data);
  };

  const applyNativeSpeakerThrottled = (wantSpeaker: boolean, force: boolean, forceBuiltIn = false) => {
    const now = Date.now();
    if (
      !force &&
      lastNativeSpeakerRef.current === wantSpeaker &&
      now - lastNativeRouteAtRef.current < MIN_NATIVE_ROUTE_MS
    ) {
      return;
    }
    lastNativeSpeakerRef.current = wantSpeaker;
    lastNativeRouteAtRef.current = now;
    void applyNativeVoiceCallSpeaker(wantSpeaker, { forceBuiltIn });
  };

  const chooseInCallRoute = async (route: InCallAudioRoute) => {
    try {
      const status = await (InCallManager as any).chooseAudioRoute?.(route);
      return status;
    } catch {
      return null;
    }
  };

  /** Android: earpiece или speaker через InCallManager + native fallback. */
  const applyBuiltInOutputRoute = (wantSpeaker: boolean, reason: string, force = false) => {
    const av = lastAvailableRef.current;
    const builtinTarget: InCallAudioRoute = wantSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE';
    const userIntent =
      reason === 'manualSync' ||
      reason.startsWith('toggle') ||
      reason.startsWith('cycle') ||
      reason === 'in_app_pip_audio_route_toggle' ||
      reason === 'return_to_audio_ui' ||
      isExplicitBuiltInRouteChoice(reason, builtinTarget);
    if (!wantSpeaker && !userIntent) {
      const nativeExt = readNativeProbedExternalRoute();
      if (nativeExt && (av.includes(nativeExt) || av.length === 0)) {
        applySpecificRoute(nativeExt, reason, force);
        return;
      }
      const connected = readConnectedExternalCallAudioRoute(getUserRoute());
      if (isExternalHeadsetRoute(connected) && av.includes(connected)) {
        applySpecificRoute(connected, reason, force);
        return;
      }
      if (av.includes('BLUETOOTH') && shouldPreferBluetoothEarlyInCall(reason)) {
        applySpecificRoute('BLUETOOTH', reason, force);
        return;
      }
    }
    if (
      !wantSpeaker &&
      !userIntent &&
      !force &&
      Platform.OS === 'android' &&
      isCallAudioBootstrapPending() &&
      reason !== 'native_probe'
    ) {
      return;
    }
    const now = Date.now();

    if (!userIntent) {
      if (
        !force &&
        lastHardRouteSpeakerRef.current === wantSpeaker &&
        now - lastHardRouteAtRef.current < MIN_HARD_ROUTE_MS
      ) {
        return;
      }
      if (
        force &&
        lastHardRouteSpeakerRef.current === wantSpeaker &&
        now - lastHardRouteAtRef.current < 220
      ) {
        return;
      }
    }

    lastHardRouteSpeakerRef.current = wantSpeaker;
    lastHardRouteAtRef.current = now;
    const route: InCallAudioRoute = wantSpeaker ? 'SPEAKER_PHONE' : 'EARPIECE';
    lastAppliedRouteRef.current = route;
    setSelectedRoute(route);
    setUserRoute(route, { persist: shouldPersistAppliedRoute(route, reason) });

    if (Platform.OS === 'android') {
      enqueueInCallOp(async () => {
        try {
          if (wantSpeaker) {
            (InCallManager as any).setForceSpeakerphoneOn?.(true);
            InCallManager.setSpeakerphoneOn(true);
            await (InCallManager as any).chooseAudioRoute?.('SPEAKER_PHONE');
          } else {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            await (InCallManager as any).chooseAudioRoute?.('EARPIECE');
          }
        } catch {}
      });
      applyNativeSpeakerThrottled(wantSpeaker, userIntent || force, userIntent);
      logRouteInfo(wantSpeaker ? 'speaker route' : 'earpiece route', { reason, force });
      return;
    }
    configureIOSAudioSession();
    try {
      InCallManager.setSpeakerphoneOn(wantSpeaker);
    } catch {}
  };

  const applyHardOutputRoute = (reason: string, force = false) => {
    applyBuiltInOutputRoute(wantsSpeakerOutput(), reason, force);
  };

  const configureIOSAudioSession = () => {
    if (Platform.OS !== 'ios') return;
    try {
      const webrtcMod = require('@livekit/react-native-webrtc');
      const RTCAudioSession = webrtcMod?.RTCAudioSession;
      if (!RTCAudioSession || typeof RTCAudioSession.sharedInstance !== 'function') return;
      const route = getUserRoute();
      const wantSpeaker = route === 'SPEAKER_PHONE';
      const s = RTCAudioSession.sharedInstance();
      s.setCategory('PlayAndRecord', {
        defaultToSpeaker: wantSpeaker,
        allowBluetooth: true,
        allowBluetoothA2DP: true,
        mixWithOthers: false,
      });
      s.setMode(wantSpeaker ? 'VideoChat' : 'VoiceChat');
      s.setActive(true);
    } catch (e) {
      logger.warn('[useAudioRouting] Error configuring iOS audio session:', e);
    }
  };

  const isHeadsetUnplugReason = (reason: string) =>
    reason === 'WiredHeadset_unplug' ||
    reason === 'headset_poll_unplug' ||
    reason === 'headset_bt_unplug' ||
    reason === 'headset_unplug';

  /** После отключения BT/провода — сохранённый разговорный или громкий. */
  const reconcileRouteAfterHeadsetDisconnect = (available: string[]): InCallAudioRoute | null => {
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;

    if (available.includes('WIRED_HEADSET')) {
      const user = getUserRoute();
      if (
        user === 'BLUETOOTH' ||
        user === 'WIRED_HEADSET' ||
        lastAppliedRouteRef.current === 'BLUETOOTH' ||
        lastAppliedRouteRef.current === 'WIRED_HEADSET'
      ) {
        return 'WIRED_HEADSET';
      }
    }

    const user = getUserRoute();
    const applied = lastAppliedRouteRef.current;
    const onBt = user === 'BLUETOOTH' || applied === 'BLUETOOTH';
    const onWired = user === 'WIRED_HEADSET' || applied === 'WIRED_HEADSET';

    if (onBt && !available.includes('BLUETOOTH')) {
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      setUserRoute(fallback);
      return fallback;
    }
    if (onWired && !available.includes('WIRED_HEADSET')) {
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      setUserRoute(fallback);
      return fallback;
    }
    return null;
  };

  const readStickyExternalRouteForAutoRepin = (
    available: string[],
    reason: string,
  ): InCallAudioRoute | null => {
    const autoReason =
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'remote_stream+1200ms' ||
      reason.startsWith('poll_') ||
      reason === 'manualSync' ||
      reason === 'bootstrap' ||
      reason === 'refresh' ||
      reason === 'bootstrap_done' ||
      reason === 'applyRouting_repin';
    if (!autoReason) return null;
    if (readExplicitUserSelectedBuiltInRoute()) return null;

    const userExt = readUserSelectedExternalRoute();
    if (userExt && (!available.length || available.includes(userExt))) return userExt;

    const last = normalizeInCallRoute(lastAppliedRouteRef.current);
    if (isExternalHeadsetRoute(last) && (!available.length || available.includes(last))) {
      return last;
    }
    const persisted = getPersistedCallAudioRoute();
    if (isExternalHeadsetRoute(persisted) && (!available.length || available.includes(persisted))) {
      return persisted;
    }
    return null;
  };

  const pickDesiredRoute = (available: string[], reason: string): InCallAudioRoute => {
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
    const { gainedWired, gainedBt } = deviceChangeContextRef.current;
    const stickyExt = readStickyExternalRouteForAutoRepin(available, reason);
    if (stickyExt) {
      return stickyExt;
    }
    const userSelExt = readUserSelectedExternalRoute();
    if (userSelExt && (!available.length || available.includes(userSelExt))) {
      return userSelExt;
    }
    const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
    if (userSelBuiltin) {
      return userSelBuiltin;
    }
    const userNow = getUserRoute();
    if (explicitBuiltInChoiceRef.current && (userNow === 'SPEAKER_PHONE' || userNow === 'EARPIECE')) {
      return userNow;
    }
    if (isExternalHeadsetRoute(userNow) && available.includes(userNow)) {
      return userNow;
    }
    if (
      available.includes('BLUETOOTH') &&
      shouldPreferBluetoothEarlyInCall(reason) &&
      !isExplicitBuiltInRouteChoice(reason, userNow)
    ) {
      return 'BLUETOOTH';
    }
    const extPersisted = readActiveExternalCallAudioRoute(userNow);
    if (extPersisted) {
      const keepHeadset =
        reason === 'manualSync' ||
        reason === 'applyRouting' ||
        reason === 'applyRouting_repin' ||
        reason === 'remote_stream' ||
        reason === 'remote_stream_repin' ||
        reason === 'remote_stream+1200ms' ||
        reason === 'bootstrap' ||
        reason === 'refresh' ||
        reason === 'session_re_enable' ||
        reason.startsWith('stopSpeaker') ||
        reason.startsWith('manualSync') ||
        isCallAudioPiPTransitionWindow();
      if (keepHeadset && (available.includes(extPersisted) || isExternalHeadsetRoute(extPersisted))) {
        return extPersisted;
      }
    }

    if (isDirectAudioEarpieceStabilizeWindow() && !readExplicitUserSelectedBuiltInRoute() && !explicitBuiltInChoiceRef.current) {
      const userIntentStabilize =
        reason.startsWith('cycle') ||
        reason.startsWith('toggle') ||
        reason === 'in_app_pip_audio_route_toggle';
      if (!userIntentStabilize) {
        const connected = readConnectedExternalCallAudioRoute(getUserRoute());
        if (isExternalHeadsetRoute(connected) && (!available.length || available.includes(connected))) {
          return connected;
        }
        const nativeExt = readNativeProbedExternalRoute();
        if (isExternalHeadsetRoute(nativeExt) && (!available.length || available.includes(nativeExt))) {
          return nativeExt;
        }
        const lockedExt = readUserSelectedExternalRoute();
        if (lockedExt && (!available.length || available.includes(lockedExt))) {
          return lockedExt;
        }
        if (isExternalHeadsetRoute(userNow) && available.includes(userNow)) {
          return userNow;
        }
        return 'EARPIECE';
      }
    }

    if (earpieceMode) {
      if (isHeadsetUnplugReason(reason)) {
        const nativeExt = readNativeProbedExternalRoute();
        if (nativeExt === 'BLUETOOTH' || nativeExt === 'WIRED_HEADSET') {
          return nativeExt;
        }
        if (available.includes('WIRED_HEADSET')) {
          return 'WIRED_HEADSET';
        }
        if (available.includes('BLUETOOTH')) {
          return 'BLUETOOTH';
        }
        const fallback = resolveCallRouteAfterHeadsetDisconnect();
        setUserRoute(fallback);
        return fallback;
      }

      const afterDisconnect = reconcileRouteAfterHeadsetDisconnect(available);
      if (afterDisconnect) {
        return afterDisconnect;
      }

      if (available.includes('WIRED_HEADSET')) {
        if (
          reason === 'WiredHeadset' ||
          reason === 'headset_poll' ||
          gainedWired ||
          (reason === 'onAudioDeviceChanged' && gainedWired) ||
          reason === 'remote_stream_repin'
        ) {
          rememberBuiltinCallRouteBeforeHeadset(getUserRoute(), true);
          return 'WIRED_HEADSET';
        }
      }
      if (available.includes('BLUETOOTH') && (gainedBt || reason === 'headset_poll_bt')) {
        rememberBuiltinCallRouteBeforeHeadset(getUserRoute(), true);
        return 'BLUETOOTH';
      }

      if (
        available.includes('BLUETOOTH') &&
        !explicitBuiltInChoiceRef.current &&
        (reason === 'manualSync' ||
          reason === 'remote_stream' ||
          reason === 'remote_stream_repin' ||
          reason === 'remote_stream+1200ms' ||
          reason === 'preferAudioMode' ||
          reason === 'bootstrap' ||
          reason.startsWith('poll_') ||
          reason === 'native_probe' ||
          reason === 'native_probe_bootstrap' ||
          gainedBt)
      ) {
        rememberBuiltinCallRouteBeforeHeadset(getUserRoute(), true);
        return 'BLUETOOTH';
      }

      const autoReapplyReason =
        reason === 'manualSync' ||
        reason === 'preferAudioMode' ||
        reason === 'applyRouting' ||
        reason === 'applyRouting_repin' ||
        reason === 'remote_stream' ||
        reason === 'remote_stream_repin' ||
        reason === 'remote_stream+1200ms' ||
        reason === 'session_re_enable' ||
        reason === 'bootstrap' ||
        reason === 'bootstrap_done' ||
        reason.startsWith('poll_');

      if (autoReapplyReason || isManualRouteReason(reason)) {
        const user = getUserRoute();
        const last = normalizeInCallRoute(lastAppliedRouteRef.current);
        if (
          isExternalHeadsetRoute(last) &&
          available.includes(last) &&
          (user === 'EARPIECE' || user === 'SPEAKER_PHONE') &&
          !explicitBuiltInChoiceRef.current &&
          !readExplicitUserSelectedBuiltInRoute()
        ) {
          return last;
        }
        if (available.includes(user) && isExternalHeadsetRoute(user)) {
          return user;
        }
        if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
          return hasExplicitBuiltInIntent(user) || isManualRouteReason(reason)
            ? user
            : defaultUserRoute(routingOptionsRef.current);
        }
      }

      const stable = lastAppliedRouteRef.current;
      if (stable && (stable === 'EARPIECE' || stable === 'SPEAKER_PHONE' || available.includes(stable))) {
        return stable as InCallAudioRoute;
      }
      return 'EARPIECE';
    }

    if (isHeadsetUnplugReason(reason)) {
      if (available.includes('WIRED_HEADSET')) {
        return 'WIRED_HEADSET';
      }
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      setUserRoute(fallback);
      return fallback;
    }

    const user = getUserRoute();
    if (user === 'BLUETOOTH' && available.includes('BLUETOOTH')) {
      return 'BLUETOOTH';
    }
    if (user === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) {
      return 'WIRED_HEADSET';
    }
    if (
      (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
      hasExplicitBuiltInIntent(user)
    ) {
      return user;
    }

    if (gainedBt && available.includes('BLUETOOTH')) {
      rememberBuiltinCallRouteBeforeHeadset(getUserRoute(), false);
      return 'BLUETOOTH';
    }
    if (gainedWired && available.includes('WIRED_HEADSET')) {
      rememberBuiltinCallRouteBeforeHeadset(getUserRoute(), false);
      return 'WIRED_HEADSET';
    }

    const autoReapplyReason =
      reason === 'manualSync' ||
      reason === 'preferAudioMode' ||
      reason === 'applyRouting' ||
      reason === 'applyRouting_repin' ||
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'session_re_enable';

    if (autoReapplyReason || isManualRouteReason(reason)) {
      if (available.includes(user) && isExternalHeadsetRoute(user)) {
        return user;
      }
      if (
        (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
        (hasExplicitBuiltInIntent(user) || isManualRouteReason(reason))
      ) {
        return user;
      }
      if (
        (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
        !hasExplicitBuiltInIntent(user) &&
        !isManualRouteReason(reason)
      ) {
        return defaultUserRoute(routingOptionsRef.current);
      }
    }

    if (reason === 'applyRouting' || reason === 'bootstrap' || reason === 'refresh') {
      const persisted = getPersistedCallAudioRoute();
      if (persisted === 'BLUETOOTH' && available.includes('BLUETOOTH')) {
        rememberBuiltinCallRouteBeforeHeadset(null, false);
        return 'BLUETOOTH';
      }
      if (persisted === 'WIRED_HEADSET' && available.includes('WIRED_HEADSET')) {
        rememberBuiltinCallRouteBeforeHeadset(null, false);
        return 'WIRED_HEADSET';
      }
      if (persisted === 'EARPIECE' || persisted === 'SPEAKER_PHONE') {
        return persisted;
      }
    }

    return 'SPEAKER_PHONE';
  };

  const applySpecificRoute = (route: InCallAudioRoute, reason: string, force = false) => {
    if (!enabled) return;

    let effectiveRoute = route;
    if (
      (effectiveRoute === 'EARPIECE' || effectiveRoute === 'SPEAKER_PHONE') &&
      !isExplicitBuiltInRouteChoice(reason, route) &&
      !isHeadsetDisconnectFallbackReason(reason)
    ) {
      const nativeExt = readNativeProbedExternalRoute();
      const connected = readConnectedExternalCallAudioRoute(getUserRoute());
      if (isExternalHeadsetRoute(connected)) {
        effectiveRoute = connected;
      } else if (isExternalHeadsetRoute(nativeExt)) {
        effectiveRoute = nativeExt;
      } else {
        const ext = readActiveExternalCallAudioRoute(getUserRoute());
        if (isExternalHeadsetRoute(ext)) {
          const av = lastAvailableRef.current;
          if (
            av.includes(ext) ||
            isCallAudioPiPTransitionWindow() ||
            (reason === 'manualSync' && lastAppliedRouteRef.current === ext)
          ) {
            effectiveRoute = ext;
          }
        }
      }
    }

    if (
      isDirectAudioEarpieceStabilizeWindow() &&
      (effectiveRoute === 'SPEAKER_PHONE' || effectiveRoute === 'EARPIECE') &&
      effectiveRoute === 'SPEAKER_PHONE' &&
      !isExplicitBuiltInRouteChoice(reason, 'SPEAKER_PHONE') &&
      !reason.startsWith('cycle') &&
      !reason.startsWith('toggle')
    ) {
      effectiveRoute = 'EARPIECE';
    }

    if (
      isPiPBuiltinCallAudioRouteLockActive() &&
      !!routingOptionsRef.current?.defaultToEarpiece
    ) {
      const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
      if (
        (authoritative === 'SPEAKER_PHONE' || authoritative === 'EARPIECE') &&
        effectiveRoute !== authoritative &&
        (reason === 'preferAudioMode' ||
          reason === 'remote_stream' ||
          reason === 'remote_stream_repin' ||
          reason === 'manualSync')
      ) {
        effectiveRoute = authoritative;
      }
    }

    const now = Date.now();
    const userIntent =
      reason === 'manualSync' ||
      reason.startsWith('cycle') ||
      reason.startsWith('toggle') ||
      reason === 'preferAudioMode' ||
      reason === 'applyRouting' ||
      reason === 'applyRouting_repin' ||
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'session_re_enable';

    if (
      !userIntent &&
      lastAppliedRouteRef.current === route &&
      now - lastHardRouteAtRef.current < MIN_HARD_ROUTE_MS
    ) {
      return;
    }

    const previousApplied = lastAppliedRouteRef.current;
    if (isExternalHeadsetRoute(effectiveRoute)) {
      const toRemember =
        previousApplied === 'EARPIECE' || previousApplied === 'SPEAKER_PHONE'
          ? previousApplied
          : getUserRoute();
      rememberBuiltinCallRouteBeforeHeadset(toRemember, !!routingOptionsRef.current?.defaultToEarpiece);
    }

    lastAppliedRouteRef.current = effectiveRoute;
    lastHardRouteAtRef.current = now;
    setUserRoute(effectiveRoute, {
      persist: shouldPersistAppliedRoute(effectiveRoute, reason),
    });
    setSelectedRoute(effectiveRoute);
    lastSelectedRef.current = effectiveRoute;
    if (
      isExternalHeadsetRoute(effectiveRoute) &&
      !readExplicitUserSelectedBuiltInRoute() &&
      !explicitBuiltInChoiceRef.current &&
      (reason === 'native_probe_bootstrap' ||
        reason === 'native_probe' ||
        reason === 'bootstrap' ||
        reason.startsWith('poll_') ||
        reason === 'applyRouting' ||
        reason === 'applyRouting_repin')
    ) {
      setUserSelectedCallAudioRoute(null);
    }
    try {
      (global as any).__inCallSelectedAudioRouteRef = { current: effectiveRoute };
    } catch {}

    if (isExternalHeadsetRoute(effectiveRoute)) {
      if (Platform.OS === 'android') {
        enqueueInCallOp(async () => {
          try {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            await chooseInCallRoute(effectiveRoute);
            await applyNativeVoiceCallRoute(effectiveRoute);
          } catch {}
        });
      } else {
        configureIOSAudioSession();
        try { InCallManager.setSpeakerphoneOn(false); } catch {}
      }
      logRouteInfo('headset route', { route: effectiveRoute, reason, force });
      return;
    }

    applyBuiltInOutputRoute(effectiveRoute === 'SPEAKER_PHONE', reason, force);
  };

  const applyRouting = () => {
    if (Platform.OS === 'android') {
      beginBackgroundMediaSuppression();
    }
    const earpieceProductMode = !!routingOptionsRef.current?.defaultToEarpiece;
    const media = earpieceProductMode || preferAudioMode ? 'audio' : 'video';
    const alreadyActive = didStartRef.current || isInCallAudioSessionStarted();
    const externalPref = readActiveExternalCallAudioRoute(getUserRoute());
    if (externalPref) {
      setUserRoute(externalPref);
    }
    if (
      Platform.OS === 'android' &&
      earpieceProductMode &&
      !alreadyActive &&
      !isInCallAudioSessionStarted()
    ) {
      try { InCallManager.stop(); } catch {}
    }
    if (!alreadyActive) {
      enqueueInCallOp(() => {
        try {
          InCallManager.start({ media, ringback: '' });
          if (earpieceProductMode) {
            try {
              (InCallManager as any).setForceSpeakerphoneOn?.(false);
              InCallManager.setSpeakerphoneOn(false);
            } catch {}
          }
          markInCallAudioSessionStarted(true);
        } catch {}
      });
      didStartRef.current = true;
    } else {
      didStartRef.current = true;
      const ext = readActiveExternalCallAudioRoute(getUserRoute());
      const skipMediaRestart =
        !!ext || isInCallAudioSessionStarted() || isOngoingCallSession();
      if (!skipMediaRestart && !earpieceProductMode) {
        enqueueInCallOp(() => {
          try { InCallManager.start({ media, ringback: '' }); } catch {}
        });
      }
    }
    try { (InCallManager as any).requestAudioFocus?.(); } catch {}
    const av = lastAvailableRef.current;
    const list = av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'];
    const external = readActiveExternalCallAudioRoute(getUserRoute());
    const nativeExt = readNativeProbedExternalRoute();
    if (
      Platform.OS === 'android' &&
      earpieceProductMode &&
      isCallAudioBootstrapPending() &&
      !external &&
      !nativeExt
    ) {
      const lockedBootstrap =
        readGlobalBuiltinRouteForSync() ||
        (earpieceProductMode ? ('EARPIECE' as InCallAudioRoute) : null);
      if (
        lockedBootstrap === 'SPEAKER_PHONE' ||
        lockedBootstrap === 'EARPIECE'
      ) {
        setUserRoute(lockedBootstrap);
        setSelectedRoute(lockedBootstrap);
        lastSelectedRef.current = lockedBootstrap;
        lastAppliedRouteRef.current = lockedBootstrap;
        applySpecificRoute(lockedBootstrap, 'applyRouting_locked_bootstrap', true);
        routeLog('applyRouting', {
          platform: Platform.OS,
          enabled,
          media,
          initial: 'locked_bootstrap',
          lockedRoute: lockedBootstrap,
          hasRemoteStream: !!remoteStream,
          streamId: remoteStream?.id,
        });
        return;
      }
      routeLog('applyRouting', {
        platform: Platform.OS,
        enabled,
        media,
        initial: 'deferred_bootstrap',
        hasRemoteStream: !!remoteStream,
        streamId: remoteStream?.id,
      });
      applySpecificRoute('EARPIECE', 'applyRouting_deferred_earpiece', true);
      return;
    }
    let initial: InCallAudioRoute;
    if (external) {
      initial = external;
      setUserRoute(external);
    } else if (nativeExt) {
      initial = nativeExt;
      setUserRoute(nativeExt);
    } else {
      initial = pickDesiredRoute(list, 'applyRouting');
    }
    applySpecificRoute(initial, alreadyActive && earpieceProductMode ? 'applyRouting_repin' : 'applyRouting', true);
    routeLog('applyRouting', {
      platform: Platform.OS,
      enabled,
      media,
      initial,
      hasRemoteStream: !!remoteStream,
      streamId: remoteStream?.id,
    });
  };

  const readStickyAppliedRoute = (): InCallAudioRoute | null => {
    const local = normalizeInCallRoute(lastAppliedRouteRef.current);
    if (local) return local;
    const globalLast = readLastAppliedCallAudioRoute();
    return globalLast || null;
  };

  const shouldSkipAutomaticBuiltInRoute = (reason: string, route: InCallAudioRoute): boolean => {
    if (!routingOptionsRef.current?.defaultToEarpiece) return false;
    if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return false;
    if (isManualRouteReason(reason)) return false;
    if (readExplicitUserSelectedBuiltInRoute()) return false;
    if (reason === 'applyRouting' || reason === 'applyRouting_locked_bootstrap') return false;
    // Direct audio calls default to earpiece; auto paths should not flip built-in output.
    return true;
  };

  /** UI уже на EARPIECE, но auto-path пропустил applySpecificRoute — дожать native. */
  const repinEarpieceNativeAfterUiSkip = (route: InCallAudioRoute, reason: string) => {
    if (route !== 'EARPIECE') return;
    if (readExplicitUserSelectedBuiltInRoute() === 'SPEAKER_PHONE') return;
    applySpecificRoute('EARPIECE', `${reason}_native_repin`, true);
  };

  const applyDesiredRoute = async (available: string[], reason: string, force = false) => {
    if (!enabled) return;

    let desired = pickDesiredRoute(available, reason);
    const lockedBuiltin = readExplicitUserSelectedBuiltInRoute();
    if (
      lockedBuiltin &&
      (reason.startsWith('poll_') ||
        reason === 'bootstrap' ||
        reason === 'bootstrap_done' ||
        reason === 'preferAudioMode' ||
        reason === 'remote_stream' ||
        reason === 'remote_stream_repin' ||
        reason === 'remote_stream+1200ms')
    ) {
      desired = lockedBuiltin;
    }
    const stickyApplied = readStickyAppliedRoute();
    if (
      (reason.startsWith('poll_') || reason === 'bootstrap' || reason === 'bootstrap_done') &&
      isExternalHeadsetRoute(stickyApplied) &&
      !readExplicitUserSelectedBuiltInRoute() &&
      (desired === 'EARPIECE' || desired === 'SPEAKER_PHONE')
    ) {
      desired = stickyApplied;
    }
    if (shouldSkipAutomaticBuiltInRoute(reason, desired)) {
      publishRouteState(available, desired);
      repinEarpieceNativeAfterUiSkip(desired, reason);
      routeLog('applyDesiredRoute skipped auto built-in', { desired, available, reason, force });
      return;
    }
    if (desired === lastAppliedRouteRef.current) {
      lastAvailableRef.current = available;
      setAvailableRoutes(available);
      if (!isHeadsetUnplugReason(reason)) {
        return;
      }
    }
    if (!force && desired && lastSelectedRef.current === desired && lastAppliedRouteRef.current === desired) {
      publishRouteState(available, desired);
      return;
    }

    if (Platform.OS === 'android') {
      applySpecificRoute(desired, reason, force);
      publishRouteState(available, desired);
      routeLog('applyDesiredRoute', { desired, available, reason, force });
      return;
    }

    applySpecificRoute(desired, reason, force);
    publishRouteState(available, desired);
  };

  const stopSpeaker = () => {
    try {
      const pipVisible = !!(global as any).__pipVisibleRef?.current;
      const inSystemPiP = (global as any).__pipInSystemModeRef?.current === true;
      const keepCallAudio = isOngoingCallSession();
      const preserveInAppAudioPiP = shouldPreserveCallAudioRouteInInAppPiP();
      if (pipVisible || inSystemPiP || keepCallAudio) {
        if (preserveInAppAudioPiP) {
          // Маршрут переприменит PiPContext (in_app_pip_from_*), без второго reapply при unmount VideoCall.
          return;
        }
        if (keepCallAudio || pipVisible || inSystemPiP) {
          scheduleReapplyPersistedCallAudioRoute('stopSpeaker_skip_active_call', {
            media: resolveActiveCallInCallMedia(),
          });
        }
        return;
      }
    } catch {}

    lastRemoteStreamRoutedIdRef.current = null;
    lastHardRouteAtRef.current = 0;
    lastNativeRouteAtRef.current = 0;
    lastAppliedRouteRef.current = '';
    previousAvailableRef.current = [];
    lastAvailableRef.current = [];
    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
    pauseBackgroundMediaAfterCall();
    try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
    markInCallAudioSessionStarted(false);
    didStartRef.current = false;
    setUserSelectedCallAudioRoute(null);
    try {
      (global as any).__explicitBuiltInCallAudioRouteRef = { current: false };
    } catch {}
    clearPersistedCallAudioRoute();
  };

  useEffect(() => {
    if (!enabled) {
      // Дубликат VideoCall в стеке (unfocused) / teardown: не сбрасывать маршрут — иначе гонка с owner ref.
      if (shouldDeferCallAudioStopOnHookUnmount()) {
        return;
      }
      setCallAudioBootstrapPending(false);
      stopSpeaker();
      return;
    }
    bootstrapPendingRef.current = true;
    setCallAudioBootstrapPending(true);
    const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
    explicitBuiltInChoiceRef.current =
      !!userSelBuiltin || readExplicitBuiltInFromGlobal();
    if (userSelBuiltin === 'SPEAKER_PHONE' || userSelBuiltin === 'EARPIECE') {
      setUserRoute(userSelBuiltin);
      setSelectedRoute(userSelBuiltin);
      lastSelectedRef.current = userSelBuiltin;
      lastAppliedRouteRef.current = userSelBuiltin;
    }
    previousAvailableRef.current = [];
    lastAvailableRef.current = [];

    const parseList = (raw: any): string[] => {
      if (Array.isArray(raw)) return raw.map((s) => String(s));
      if (typeof raw === 'string') {
        try {
          const j = JSON.parse(raw);
          if (Array.isArray(j)) return j.map((s) => String(s));
        } catch {}
      }
      return [];
    };

    const parseStatus = (data: any) => {
      const available = parseList(data?.availableAudioDeviceList);
      const selected = String(data?.selectedAudioDevice || '');
      const syncAvailableGlobal = (list: string[]) => {
        try {
          const g = global as any;
          g.__inCallAvailableAudioRoutesRef = g.__inCallAvailableAudioRoutesRef || { current: [] };
          g.__inCallAvailableAudioRoutesRef.current = list;
        } catch {}
      };
      if (selected) {
        publishRouteState(available, selected);
      } else {
        lastAvailableRef.current = available;
        setAvailableRoutes(available);
        syncAvailableGlobal(available);
      }
      return { available, selected };
    };

    const applyBluetoothUnplugFallback = async (icmAvailable: string[], reason: string) => {
      clearNativeProbeBluetoothRoute();
      const without = icmAvailable.filter((d) => d !== 'BLUETOOTH');
      lastAvailableRef.current = without;
      previousAvailableRef.current = without;
      setAvailableRoutes(without);
      try {
        (global as any).__inCallAvailableAudioRoutesRef = { current: without };
      } catch {}
      explicitBuiltInChoiceRef.current = false;
      const fallback = resolveCallRouteAfterHeadsetDisconnect();
      setPersistedCallAudioRoute(fallback);
      await applySpecificRoute(fallback, 'headset_unplug', true);
      publishRouteState(without.length ? without : ['EARPIECE', 'SPEAKER_PHONE'], fallback);
    };

    const applyBluetoothReconnect = async (reason: string) => {
      const probe = await probeNativeCallAudioRoutes();
      if (!probe.available.includes('BLUETOOTH')) return;
      const merged = mergeNativeProbeIntoGlobal(probe);
      const withBt = Array.from(
        new Set([...(merged.length ? merged : lastAvailableRef.current), 'BLUETOOTH']),
      );
      lastAvailableRef.current = withBt;
      previousAvailableRef.current = withBt;
      setAvailableRoutes(withBt);
      try {
        (global as any).__inCallAvailableAudioRoutesRef = { current: withBt };
      } catch {}
      if (hasExplicitBuiltInIntent()) {
        routeLog('bluetooth reconnect kept explicit builtin route', {
          reason,
          available: withBt,
          userRoute: getUserRoute(),
        });
        await applyDesiredRoute(withBt, reason, true);
        return;
      }
      try {
        if ((global as any).__explicitBuiltInCallAudioRouteRef) {
          (global as any).__explicitBuiltInCallAudioRouteRef.current = false;
        }
      } catch {}
      explicitBuiltInChoiceRef.current = false;
      setUserSelectedCallAudioRoute(null);
      deviceChangeContextRef.current = { gainedWired: false, gainedBt: true };
      await applySpecificRoute('BLUETOOTH', reason, true);
      deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
      publishRouteState(withBt, 'BLUETOOTH');
    };

    const onDeviceChanged = (data: any) => {
      const available = parseList(data?.availableAudioDeviceList);
      const selected = String(data?.selectedAudioDevice || '');
      const prev = previousAvailableRef.current;
      const wasOnBt =
        prev.includes('BLUETOOTH') ||
        lastAppliedRouteRef.current === 'BLUETOOTH' ||
        getUserRoute() === 'BLUETOOTH';
      const lostBt = wasOnBt && !available.includes('BLUETOOTH');
      const lostWired = prev.includes('WIRED_HEADSET') && !available.includes('WIRED_HEADSET');
      const gainedWired = available.includes('WIRED_HEADSET') && !prev.includes('WIRED_HEADSET');
      const gainedBt = available.includes('BLUETOOTH') && !prev.includes('BLUETOOTH');

      lastAvailableRef.current = available;
      setAvailableRoutes(available);
      try {
        const g = global as any;
        g.__inCallAvailableAudioRoutesRef = g.__inCallAvailableAudioRoutesRef || { current: [] };
        g.__inCallAvailableAudioRoutesRef.current = available;
      } catch {}
      previousAvailableRef.current = available;

      if (!(lostBt || lostWired || gainedWired || gainedBt)) {
        if (selected) {
          try {
            const selNorm = normalizeInCallRoute(selected);
            if (selNorm) {
              (global as any).__inCallSelectedAudioRouteRef = { current: selNorm };
              if (isExternalHeadsetRoute(selNorm)) {
                lastAppliedRouteRef.current = selNorm;
                setUserRoute(selNorm);
                setSelectedRoute(selNorm);
              }
            }
          } catch {}
        }
        routeLog('onAudioDeviceChanged', {
          available,
          selected,
          lostBt,
          lostWired,
          skipped: true,
        });
        return;
      }

      if (lostBt || lostWired) {
        routeLog('onAudioDeviceChanged', {
          available,
          selected,
          lostBt,
          lostWired,
          reason: 'headset_unplug_check',
          gainedWired,
          gainedBt,
        });
        void (async () => {
          if (lostBt && !available.includes('BLUETOOTH')) {
            await applyBluetoothUnplugFallback(available, 'headset_unplug');
            return;
          }
          if (lostWired && !available.includes('WIRED_HEADSET')) {
            deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
            await applyDesiredRoute(available, 'headset_unplug', true);
            return;
          }
          const probe = await probeNativeCallAudioRoutes();
          const merged = mergeNativeProbeIntoGlobal(probe);
          const list = merged.length ? merged : available;
          if (lostWired && (probe.available.includes('WIRED_HEADSET') || list.includes('WIRED_HEADSET'))) {
            lastAvailableRef.current = list;
            previousAvailableRef.current = list;
            setAvailableRoutes(list);
            deviceChangeContextRef.current = { gainedWired: true, gainedBt: false };
            await applyDesiredRoute(list, 'onAudioDeviceChanged', true);
            deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
            return;
          }
          deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
          await applyDesiredRoute(available, 'headset_unplug', true);
        })();
        return;
      }

      deviceChangeContextRef.current = { gainedWired, gainedBt };
      routeLog('onAudioDeviceChanged', {
        available,
        selected,
        lostBt,
        lostWired,
        reason: 'onAudioDeviceChanged',
        gainedWired,
        gainedBt,
      });
      if (gainedBt) {
        void applyBluetoothReconnect('onAudioDeviceChanged_gained_bt');
        deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
        return;
      }
      void applyDesiredRoute(available, 'onAudioDeviceChanged', true);
      deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
    };

    const onWired = (data: any) => {
      const plugged = data?.isPlugged === true;
      const available = plugged
        ? Array.from(new Set([...lastAvailableRef.current, 'WIRED_HEADSET']))
        : lastAvailableRef.current.filter((d) => d !== 'WIRED_HEADSET');
      lastAvailableRef.current = available;
      previousAvailableRef.current = available;
      setAvailableRoutes(available);
      routeLog('WiredHeadset', { plugged, available });
      if (!plugged) {
        if (!available.includes('BLUETOOTH')) {
          setUserRoute('EARPIECE');
        }
      }
      if (plugged) {
        deviceChangeContextRef.current = { gainedWired: true, gainedBt: false };
      }
      void applyDesiredRoute(available, plugged ? 'WiredHeadset' : 'WiredHeadset_unplug', true);
      deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
    };

    const addInCallEventListener = (event: string, handler: (data: any) => void) => {
      try {
        subs.push(DeviceEventEmitter.addListener(event, handler) as any);
      } catch {}
    };

    const subs: Array<{ remove: () => void }> = [];
    if (Platform.OS === 'android') {
      addInCallEventListener('onAudioDeviceChanged', onDeviceChanged);
      addInCallEventListener('WiredHeadset', onWired);
    }

    const pollHeadsetPlug = async () => {
      if (cancelled || !enabled) return;
      if (!routingOptionsRef.current?.defaultToEarpiece) return;
      try {
        const res = await InCallManager.getIsWiredHeadsetPluggedIn();
        const plugged = !!((res as { isWiredHeadsetPluggedIn?: boolean })?.isWiredHeadsetPluggedIn ?? res);
        const av = lastAvailableRef.current;
        if (plugged) {
          const withWired = Array.from(new Set([...av, 'WIRED_HEADSET']));
          lastAvailableRef.current = withWired;
          setAvailableRoutes(withWired);
          deviceChangeContextRef.current = { gainedWired: true, gainedBt: false };
          await applyDesiredRoute(withWired, 'headset_poll', true);
          deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
          return;
        }
        if (!plugged && av.includes('WIRED_HEADSET')) {
          const without = av.filter((d) => d !== 'WIRED_HEADSET');
          lastAvailableRef.current = without;
          previousAvailableRef.current = without;
          setAvailableRoutes(without);
          if (!without.includes('BLUETOOTH')) {
            setUserRoute('EARPIECE');
          }
          await applyDesiredRoute(without, 'headset_poll_unplug', true);
        }

        const probe = await probeNativeCallAudioRoutes();
        const btConnected = await isNativeBluetoothHeadsetConnectedForCall();
        if (btConnected && probe.available.includes('BLUETOOTH')) {
          const hadBt = lastAvailableRef.current.includes('BLUETOOTH');
          const withBt = Array.from(new Set([...lastAvailableRef.current, ...probe.available]));
          lastAvailableRef.current = withBt;
          previousAvailableRef.current = withBt;
          setAvailableRoutes(withBt);
          mergeNativeProbeIntoGlobal(probe);
          if (!hadBt) {
            await applyBluetoothReconnect('headset_poll_bt');
          }
        } else {
          const onBt =
            lastAppliedRouteRef.current === 'BLUETOOTH' ||
            getUserRoute() === 'BLUETOOTH' ||
            lastAvailableRef.current.includes('BLUETOOTH');
          if (onBt) {
            await applyBluetoothUnplugFallback(
              lastAvailableRef.current.filter((d) => d !== 'BLUETOOTH'),
              'headset_bt_unplug',
            );
          } else if (lastAvailableRef.current.includes('BLUETOOTH')) {
            clearNativeProbeBluetoothRoute();
            const without = lastAvailableRef.current.filter((d) => d !== 'BLUETOOTH');
            lastAvailableRef.current = without;
            previousAvailableRef.current = without;
            setAvailableRoutes(without);
          }
        }
      } catch {}
    };

    const headsetPollTimer =
      Platform.OS === 'android'
        ? setInterval(() => {
            void pollHeadsetPlug();
          }, 1500)
        : null;

    const ensureBluetoothConnectPermission = async (): Promise<boolean> => {
      if (Platform.OS !== 'android') return true;
      const ver = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
      if (!Number.isFinite(ver) || ver < 31) return true;

      const perm = (PermissionsAndroid as any)?.PERMISSIONS?.BLUETOOTH_CONNECT;
      if (!perm) return true;

      try {
        const already = await PermissionsAndroid.check(perm);
        if (already) return true;
      } catch {}

      if (btPermissionRequestedRef.current) return false;
      btPermissionRequestedRef.current = true;

      try {
        const res = await PermissionsAndroid.request(perm);
        return res === PermissionsAndroid.RESULTS.GRANTED;
      } catch (e) {
        logger.warn('[useAudioRouting] BLUETOOTH_CONNECT permission request failed', { e });
        return false;
      }
    };

    let cancelled = false;

    (async () => {
      if (didStartRef.current) {
        InteractionManager.runAfterInteractions(() => {
          if (cancelled) return;
          const av = lastAvailableRef.current;
          const ext = readActiveExternalCallAudioRoute(getUserRoute());
          const route =
            ext || pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'session_re_enable');
          applySpecificRoute(route, 'session_re_enable', true);
        });
        return;
      }
      const ok = await ensureBluetoothConnectPermission();
      if (Platform.OS === 'android') {
        const probe = await probeNativeCallAudioRoutes();
        const merged = mergeNativeProbeIntoGlobal(probe);
        if (merged.length) {
          lastAvailableRef.current = merged;
          setAvailableRoutes(merged);
          previousAvailableRef.current = merged;
        }
        const nativeExt = readNativeProbedExternalRoute();
        if (nativeExt) {
          applySpecificRoute(nativeExt, 'native_probe', true);
        }
      }
      didStartRef.current = true;
      InteractionManager.runAfterInteractions(() => {
        if (cancelled) return;
        applyRouting();
        if (!ok) {
          logger.warn('[useAudioRouting] BLUETOOTH_CONNECT not granted; Bluetooth routing may not work on Android 12+');
        }
      });
    })();

    const bootstrap = async () => {
      if (Platform.OS !== 'android') {
        bootstrapPendingRef.current = false;
        setCallAudioBootstrapPending(false);
        return;
      }

      const icm: any = InCallManager as any;

      try {
        const earlyProbe = await probeNativeCallAudioRoutes();
        const earlyMerged = mergeNativeProbeIntoGlobal(earlyProbe);
        if (earlyMerged.length) {
          lastAvailableRef.current = earlyMerged;
          setAvailableRoutes(earlyMerged);
          previousAvailableRef.current = earlyMerged;
        }
        const earlyExt = readNativeProbedExternalRoute();
        if (earlyExt) {
          applySpecificRoute(earlyExt, 'native_probe_bootstrap', true);
        }
      } catch {}

      const refresh = async (reason: string) => {
        if (cancelled) return;
        if (refreshInFlightRef.current) return;
        const now = Date.now();
        if (now - lastRefreshAtRef.current < 350) return;
        refreshInFlightRef.current = true;
        lastRefreshAtRef.current = now;
        try {
          const probe = await probeNativeCallAudioRoutes();
          const mergedProbe = mergeNativeProbeIntoGlobal(probe);
          const av = mergedProbe.length ? mergedProbe : lastAvailableRef.current;
          lastAvailableRef.current = av;
          setAvailableRoutes(av);
          let chosen = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], reason);
          const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
          const stickyApplied = readStickyAppliedRoute();
          if (
            (reason === 'bootstrap' || reason.startsWith('poll_')) &&
            isExternalHeadsetRoute(stickyApplied) &&
            !userSelBuiltin &&
            (chosen === 'EARPIECE' || chosen === 'SPEAKER_PHONE')
          ) {
            chosen = stickyApplied;
          }
          if (
            userSelBuiltin &&
            (reason === 'bootstrap' || reason.startsWith('poll_'))
          ) {
            chosen = userSelBuiltin;
          } else if (
            (reason === 'bootstrap' || reason.startsWith('poll_')) &&
            shouldPreferBluetoothEarlyInCall(reason) &&
            !readExplicitUserSelectedBuiltInRoute()
          ) {
            try {
              const btStatus = await icm.chooseAudioRoute?.('BLUETOOTH');
              const parsed = parseStatus(btStatus);
              if (parsed.available.includes('BLUETOOTH')) {
                chosen = 'BLUETOOTH';
                lastAvailableRef.current = parsed.available.length ? parsed.available : av;
              }
            } catch {}
          }
          const status = await icm.chooseAudioRoute?.(chosen);
          const { available, selected } = parseStatus(status);
          routeLog('refreshStatus', { reason, available, selected, chosen });
          if (chosen === 'BLUETOOTH' || chosen === 'WIRED_HEADSET') {
            await applyNativeVoiceCallRoute(chosen);
          }
          await applyDesiredRoute(available.length ? available : av, reason, true);
        } catch (e) {
          routeLog('refreshStatus failed', { reason, error: String(e) });
        } finally {
          refreshInFlightRef.current = false;
        }
      };

      await refresh('bootstrap');
      const delays = [150, 400, 900, 2000];
      for (const ms of delays) {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, ms));
        await refresh(`poll_${ms}`);
        if (readExplicitUserSelectedBuiltInRoute()) {
          break;
        }
        const av = lastAvailableRef.current;
        const desired = pickDesiredRoute(av, `poll_${ms}`);
        if (desired === lastSelectedRef.current && (av.includes('WIRED_HEADSET') || av.includes('BLUETOOTH'))) {
          break;
        }
      }
      if (!cancelled) {
        bootstrapPendingRef.current = false;
        setCallAudioBootstrapPending(false);
        let av = lastAvailableRef.current;
        try {
          const finalProbe = await probeNativeCallAudioRoutes();
          const finalMerged = mergeNativeProbeIntoGlobal(finalProbe);
          if (finalMerged.length) {
            av = finalMerged;
            lastAvailableRef.current = finalMerged;
            previousAvailableRef.current = finalMerged;
            setAvailableRoutes(finalMerged);
          }
        } catch {}
        const lastApplied = readStickyAppliedRoute();
        const probedExt = readNativeProbedExternalRoute();
        const connectedExt = readConnectedExternalCallAudioRoute(getUserRoute());
        const hasExternal =
          isExternalHeadsetRoute(lastApplied) ||
          isExternalHeadsetRoute(probedExt) ||
          isExternalHeadsetRoute(connectedExt) ||
          av.includes('BLUETOOTH') ||
          av.includes('WIRED_HEADSET');
        if (
          routingOptionsRef.current?.defaultToEarpiece &&
          !hasExternal &&
          !readNativeProbedExternalRoute()
        ) {
          const ext = readConnectedExternalCallAudioRoute(getUserRoute());
          if (!ext && !av.includes('BLUETOOTH') && !av.includes('WIRED_HEADSET')) {
            const syncedBuiltin = readGlobalBuiltinRouteForSync();
            const explicitDone = readExplicitUserSelectedBuiltInRoute();
            const userAtDone = getUserRoute();
            const doneRoute =
              (syncedBuiltin &&
              !isExternalHeadsetRoute(syncedBuiltin) &&
              (syncedBuiltin === 'SPEAKER_PHONE' || syncedBuiltin === 'EARPIECE')
                ? syncedBuiltin
                : null) ||
              explicitDone ||
              (explicitBuiltInChoiceRef.current &&
              (userAtDone === 'SPEAKER_PHONE' || userAtDone === 'EARPIECE')
                ? userAtDone
                : 'EARPIECE');
            if (shouldSkipAutomaticBuiltInRoute('bootstrap_done', doneRoute)) {
              publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], doneRoute);
              repinEarpieceNativeAfterUiSkip(doneRoute, 'bootstrap_done');
              routeLog('bootstrap_done skipped auto built-in', { doneRoute, available: av });
              return;
            }
            applySpecificRoute(doneRoute, 'bootstrap_done', true);
          }
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      bootstrapPendingRef.current = false;
      if (headsetPollTimer) clearInterval(headsetPollTimer);
      subs.forEach((s) => {
        try { s?.remove?.(); } catch {}
      });
      if (!shouldDeferCallAudioStopOnHookUnmount()) {
        setCallAudioBootstrapPending(false);
        stopSpeaker();
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const g = global as any;
    g.__applyCallAudioRouteFromParentRef = g.__applyCallAudioRouteFromParentRef || { current: null };
    g.__applyCallAudioRouteFromParentRef.current = (route: InCallAudioRoute, reason: string) => {
      if (isExternalHeadsetRoute(route)) {
        setUserSelectedCallAudioRoute(route);
      }
      setUserRoute(route);
      setSelectedRoute(route);
      lastSelectedRef.current = route;
      lastAppliedRouteRef.current = route;
      const av = lastAvailableRef.current;
      publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
      applySpecificRoute(route, reason, true);
    };
    return () => {
      if (g.__applyCallAudioRouteFromParentRef?.current) {
        g.__applyCallAudioRouteFromParentRef.current = null;
      }
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !routingOptionsRef.current?.defaultToEarpiece) return;
    const applyPrefer = () => {
      if (isPiPBuiltinCallAudioRouteLockActive() || isCallAudioPiPTransitionWindow()) {
        const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
        if (
          authoritative === 'SPEAKER_PHONE' ||
          authoritative === 'EARPIECE' ||
          isExternalHeadsetRoute(authoritative)
        ) {
          applySpecificRoute(authoritative, 'preferAudioMode', true);
          return;
        }
      }
      const userSel = readExplicitUserSelectedBuiltInRoute();
      if (userSel === 'SPEAKER_PHONE' || userSel === 'EARPIECE') {
        applySpecificRoute(userSel, 'preferAudioMode', true);
        return;
      }
      const sticky = readStickyAppliedRoute();
      if (sticky && isExternalHeadsetRoute(sticky) && !readExplicitUserSelectedBuiltInRoute()) {
        applySpecificRoute(sticky, 'preferAudioMode', true);
        return;
      }
      if (readExplicitBuiltInFromGlobal()) {
        const pinned = getUserRoute();
        if (pinned === 'SPEAKER_PHONE' || pinned === 'EARPIECE') {
          applySpecificRoute(pinned, 'preferAudioMode', true);
          return;
        }
      }
      const nativeExt = readNativeProbedExternalRoute();
      if (nativeExt) {
        applySpecificRoute(nativeExt, 'preferAudioMode', true);
        return;
      }
      const av = lastAvailableRef.current;
      const connected = readConnectedExternalCallAudioRoute(getUserRoute());
      if (connected && av.includes(connected)) {
        applySpecificRoute(connected, 'preferAudioMode', true);
        return;
      }
      if (av.includes('WIRED_HEADSET')) {
        applySpecificRoute('WIRED_HEADSET', 'preferAudioMode', true);
        return;
      }
      if (av.includes('BLUETOOTH')) {
        applySpecificRoute('BLUETOOTH', 'preferAudioMode', true);
        return;
      }
      const ext = readActiveExternalCallAudioRoute(getUserRoute());
      if (isExternalHeadsetRoute(ext) && (av.includes(ext) || isCallAudioPiPTransitionWindow())) {
        applySpecificRoute(ext, 'preferAudioMode', true);
        return;
      }
      if (isCallAudioPiPTransitionWindow()) {
        const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
        if (
          authoritative === 'SPEAKER_PHONE' ||
          authoritative === 'EARPIECE' ||
          isExternalHeadsetRoute(authoritative)
        ) {
          applySpecificRoute(authoritative, 'preferAudioMode', true);
          return;
        }
        const lastApplied = readLastAppliedCallAudioRoute();
        if (isExternalHeadsetRoute(lastApplied)) {
          applySpecificRoute(lastApplied, 'preferAudioMode', true);
          return;
        }
      }
      if (bootstrapPendingRef.current || isCallAudioBootstrapPending()) {
        return;
      }
      const restoreBuiltin =
        readDirectCallAudioRouteBeforeVideo() || readBuiltinCallRouteBeforeHeadset();
      if (restoreBuiltin === 'SPEAKER_PHONE' || restoreBuiltin === 'EARPIECE') {
        setUserRoute(restoreBuiltin);
        setSelectedRoute(restoreBuiltin);
        applySpecificRoute(restoreBuiltin, 'preferAudioMode', true);
        return;
      }
      if (explicitBuiltInChoiceRef.current) {
        const pinned = getUserRoute();
        if (pinned === 'SPEAKER_PHONE' || pinned === 'EARPIECE') {
          applySpecificRoute(pinned, 'preferAudioMode', true);
          return;
        }
      }
      const plaqueActive =
        shouldPreserveCallAudioRouteInInAppPiP() ||
        isCallAudioPiPTransitionWindow() ||
        (() => {
          try {
            return (global as any).__pipVisibleRef?.current === true;
          } catch {
            return false;
          }
        })();
      if (plaqueActive) {
        const authoritative = readAuthoritativeCallAudioRouteAfterPiP();
        if (
          authoritative === 'SPEAKER_PHONE' ||
          authoritative === 'EARPIECE' ||
          isExternalHeadsetRoute(authoritative)
        ) {
          applySpecificRoute(authoritative, 'preferAudioMode', true);
          return;
        }
        const persisted = getPersistedCallAudioRoute();
        if (persisted === 'SPEAKER_PHONE') {
          applySpecificRoute('SPEAKER_PHONE', 'preferAudioMode', true);
          return;
        }
      }
      setUserRoute('EARPIECE', { persist: false });
      setSelectedRoute('EARPIECE');
      applySpecificRoute('EARPIECE', 'preferAudioMode', true);
    };
    applyPrefer();
    const defer = setTimeout(applyPrefer, 120);
    return () => clearTimeout(defer);
  }, [enabled, preferAudioMode]);

  useEffect(() => {
    if (!enabled || preferAudioMode) return;
    const av = lastAvailableRef.current;
    const user = getUserRoute();
    if (user === 'BLUETOOTH' && av.includes('BLUETOOTH')) {
      applySpecificRoute('BLUETOOTH', 'leave_audio_only_ui', true);
      return;
    }
    if (user === 'WIRED_HEADSET' && av.includes('WIRED_HEADSET')) {
      applySpecificRoute('WIRED_HEADSET', 'leave_audio_only_ui', true);
    }
  }, [enabled, preferAudioMode]);

  const syncRouteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !routingOptionsRef.current?.defaultToEarpiece) return;
    const streamId = remoteStream?.id ? String(remoteStream.id) : '';
    if (!streamId || !remoteStream?.getAudioTracks?.()?.length) return;
    if (lastRemoteStreamRoutedIdRef.current === streamId) return;
    if (isCallAudioBootstrapPending()) return;
    const userSelBuiltinEarly = readExplicitUserSelectedBuiltInRoute();
    const last = readStickyAppliedRoute();
    if (last && isExternalHeadsetRoute(last) && !userSelBuiltinEarly) {
      lastRemoteStreamRoutedIdRef.current = streamId;
      return;
    }
    lastRemoteStreamRoutedIdRef.current = streamId;

    const av = lastAvailableRef.current;
    const route = userSelBuiltinEarly
      ? userSelBuiltinEarly
      : pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'remote_stream');
    if (route === lastAppliedRouteRef.current) {
      if (
        routingOptionsRef.current?.defaultToEarpiece &&
        route === 'EARPIECE' &&
        !readExplicitUserSelectedBuiltInRoute()
      ) {
        applySpecificRoute('EARPIECE', 'remote_stream_confirm', true);
      }
      return;
    }
    if (shouldSkipAutomaticBuiltInRoute('remote_stream', route)) {
      publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
      repinEarpieceNativeAfterUiSkip(route, 'remote_stream');
      return;
    }
    applySpecificRoute(route, 'remote_stream', true);
    const timer = setTimeout(() => {
      if (isCallAudioBootstrapPending()) return;
      const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
      if (userSelBuiltin) {
        applySpecificRoute(userSelBuiltin, 'remote_stream+1200ms', true);
        return;
      }
      const last2 = normalizeInCallRoute(lastAppliedRouteRef.current);
      if (isExternalHeadsetRoute(last2)) return;
      const av2 = lastAvailableRef.current;
      const repin = pickDesiredRoute(av2.length ? av2 : ['EARPIECE', 'SPEAKER_PHONE'], 'remote_stream_repin');
      if (repin === lastAppliedRouteRef.current) return;
      if (shouldSkipAutomaticBuiltInRoute('remote_stream_repin', repin)) {
        publishRouteState(av2.length ? av2 : ['EARPIECE', 'SPEAKER_PHONE'], repin);
        repinEarpieceNativeAfterUiSkip(repin, 'remote_stream_repin');
        return;
      }
      applySpecificRoute(repin, 'remote_stream+1200ms', true);
    }, 1200);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, remoteStream?.id, preferAudioMode]);

  const syncRouteNow = useCallback(() => {
    if (syncRouteDebounceRef.current) {
      clearTimeout(syncRouteDebounceRef.current);
    }
    syncRouteDebounceRef.current = setTimeout(() => {
      syncRouteDebounceRef.current = null;
      void (async () => {
        if (Platform.OS === 'android') {
          try {
            const probe = await probeNativeCallAudioRoutes();
            mergeNativeProbeIntoGlobal(probe);
          } catch {}
        }
        const av = lastAvailableRef.current;
        const videoUiSync =
          !preferAudioModeRef.current &&
          ongoingCallPrefersVideoMedia() &&
          !routingOptionsRef.current?.defaultToEarpiece;
        if (videoUiSync) {
          const route = resolveOngoingVideoCallAudioRoute();
          applySpecificRoute(route, 'manualSync_video_ctx', true);
          publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
          return;
        }
        const lockedBuiltinSync = readGlobalBuiltinRouteForSync();
        if (
          lockedBuiltinSync &&
          !isExternalHeadsetRoute(lockedBuiltinSync) &&
          !(
            !routingOptionsRef.current?.defaultToEarpiece &&
            ongoingCallPrefersVideoMedia() &&
            !isInAudioOnlyCallUi()
          )
        ) {
          if (lockedBuiltinSync !== normalizeInCallRoute(lastAppliedRouteRef.current)) {
            applySpecificRoute(lockedBuiltinSync, 'manualSync', true);
            publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], lockedBuiltinSync);
          }
          return;
        }
        const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
        const user = getUserRoute();
        const ext = readActiveExternalCallAudioRoute(user);
        const pipPreserve = isCallAudioPiPTransitionWindow();
        const connected = readConnectedExternalCallAudioRoute(user);
        let route: InCallAudioRoute;
        const nativeExt = readNativeProbedExternalRoute();
        if (isExternalHeadsetRoute(connected)) {
          route = connected;
        } else if (nativeExt) {
          route = nativeExt;
        } else if (isExternalHeadsetRoute(ext) && (av.includes(ext) || pipPreserve)) {
          route = ext;
        } else if (earpieceMode) {
          const userSelBuiltin = readExplicitUserSelectedBuiltInRoute();
          const sticky = readStickyAppliedRoute();
          if (userSelBuiltin) {
            route = userSelBuiltin;
          } else if (sticky && isExternalHeadsetRoute(sticky)) {
            route = sticky;
          } else if (
            !explicitBuiltInChoiceRef.current &&
            av.includes('BLUETOOTH')
          ) {
            route = 'BLUETOOTH';
          } else if (
            !explicitBuiltInChoiceRef.current &&
            av.includes('WIRED_HEADSET')
          ) {
            route = 'WIRED_HEADSET';
          } else if (isExternalHeadsetRoute(user) && (av.includes(user) || pipPreserve)) {
            route = user;
          } else if (isExternalHeadsetRoute(normalizeInCallRoute(lastAppliedRouteRef.current))) {
            route = normalizeInCallRoute(lastAppliedRouteRef.current) as InCallAudioRoute;
          } else if (
            (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
            hasExplicitBuiltInIntent(user)
          ) {
            route = user;
          } else {
            route = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'manualSync');
          }
        } else if (user === 'BLUETOOTH' && av.includes('BLUETOOTH')) {
          route = 'BLUETOOTH';
        } else if (user === 'WIRED_HEADSET' && av.includes('WIRED_HEADSET')) {
          route = 'WIRED_HEADSET';
        } else if (
          (user === 'SPEAKER_PHONE' || user === 'EARPIECE') &&
          hasExplicitBuiltInIntent(user)
        ) {
          route = user;
        } else {
          route = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'manualSync');
        }
        if (shouldSkipAutomaticBuiltInRoute('manualSync', route)) {
          publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
          repinEarpieceNativeAfterUiSkip(route, 'manualSync');
          routeLog('manualSync skipped auto built-in', { route, available: av });
          return;
        }
        applySpecificRoute(route, 'manualSync', true);
        publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
      })();
    }, 140);
  }, [enabled]);

  const preferAudioModeRef = useRef(preferAudioMode);
  preferAudioModeRef.current = preferAudioMode;

  const cycleUserRoute = useCallback((): Promise<InCallAudioRoute | null> => {
    return (async () => {
      const now = Date.now();
      try {
        const g = global as any;
        const lastAt = Number(g.__lastCycleUserRouteAtRef?.current || 0);
        const lastRoute = normalizeInCallRoute(g.__lastCycleUserRouteResultRef?.current || '');
        const lastCallId = String(g.__lastCycleUserRouteCallIdRef?.current || '').trim();
        const activeCallId = String(g.__activeCallAudioRouteCallIdRef?.current || '').trim();
        if (activeCallId && lastCallId === activeCallId && now - lastAt < 1200) {
          routeLog('cycleUserRoute skipped (dedup)', { lastRoute, msSince: now - lastAt });
          return lastRoute || readUserSelectedCallAudioRoute();
        }
        g.__lastCycleUserRouteAtRef = { current: now };
      } catch {}
      let av = [...lastAvailableRef.current];
      if (Platform.OS === 'android') {
        try {
          const probe = await probeNativeCallAudioRoutes();
          mergeNativeProbeIntoGlobal(probe);
          av = Array.from(new Set([...av, ...probe.available]));
          const btConnected = await isNativeBluetoothHeadsetConnectedForCall();
          if (btConnected) {
            av = Array.from(new Set([...av, 'BLUETOOTH']));
          }
        } catch {}
      }
      try {
        const gAv = (global as any).__inCallAvailableAudioRoutesRef?.current;
        if (Array.isArray(gAv)) {
          av = Array.from(new Set([...av, ...gAv.map((s: unknown) => String(s))]));
        }
      } catch {}
      lastAvailableRef.current = av;
      const current =
        normalizeInCallRoute(lastAppliedRouteRef.current) ||
        normalizeInCallRoute(getUserRoute()) ||
        'EARPIECE';
      const cycleCtx = preferAudioModeRef.current ? 'audio_ui' : 'video_ui';
      const next = nextRouteInCycleForContext(
        current,
        av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'],
        cycleCtx,
      );
      routeLog('cycleUserRoute', { from: current, next, available: av, cycleCtx });
      explicitBuiltInChoiceRef.current = next === 'EARPIECE' || next === 'SPEAKER_PHONE';
      setExplicitBuiltInGlobal(explicitBuiltInChoiceRef.current);
      setUserRoute(next);
      setSelectedRoute(next);
      lastSelectedRef.current = next;
      lastAppliedRouteRef.current = next;
      setUserSelectedCallAudioRoute(next);
      setPersistedCallAudioRoute(next);
      rememberManualBuiltinCallAudioRoute(next);
      if (isExternalHeadsetRoute(next)) {
        markUserSelectedExternalCallAudioRoute(next);
      }
      try {
        const params = (global as any).__currentCallPiPParamsRef?.current;
        if (params && typeof params === 'object') {
          params.audioOutputRoute = next;
        }
        (global as any).__onInAppPiPAudioRouteChanged?.(next);
      } catch {}
      applySpecificRoute(next, 'cycleUserRoute', true);
      publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], next);
      try {
        (global as any).__lastCycleUserRouteResultRef = { current: next };
        (global as any).__lastCycleUserRouteCallIdRef = {
          current: String((global as any).__activeCallAudioRouteCallIdRef?.current || '').trim(),
        };
      } catch {}
      return next;
    })();
  }, []);

  return {
    syncRouteNow,
    cycleUserRoute,
    selectedRoute,
    availableRoutes,
    stopSpeaker,
    applyHardOutputRoute,
  };
};
