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
} from '../../../utils/nativeCallAudioProbe';
import {
  setPersistedCallAudioRoute,
  scheduleReapplyPersistedCallAudioRoute,
  shouldPreserveCallAudioRouteInInAppPiP,
  getPersistedCallAudioRoute,
  restoreCallAudioForInAppPiPPlaque,
  isCallAudioPiPTransitionWindow,
} from '../../../utils/callAudioRoutePersist';
import {
  rememberBuiltinCallRouteBeforeHeadset,
  resolveBuiltinCallRouteAfterHeadsetDisconnect,
} from '../../../utils/callHeadsetAudioFallback';
import {
  isOngoingCallSession,
  readActiveExternalCallAudioRoute,
  readLastAppliedCallAudioRoute,
  readConnectedExternalCallAudioRoute,
  resolveActiveCallInCallMedia,
  markInCallAudioSessionStarted,
  isInCallAudioSessionStarted,
} from '../../../utils/activeCallSession';
import {
  type InCallAudioRoute,
  isExternalHeadsetRoute,
  nextRouteInCycle,
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

/** Явный выбор разговорного/громкого — не подменять Bluetooth вне PiP-перехода. */
function isExplicitBuiltInRouteChoice(reason: string, route: InCallAudioRoute): boolean {
  if (route !== 'EARPIECE' && route !== 'SPEAKER_PHONE') return false;
  if (reason.startsWith('cycle') || reason.startsWith('toggle')) return true;
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

  const setUserRoute = (route: InCallAudioRoute) => {
    const opts = routingOptionsRef.current;
    if (route === 'EARPIECE' || route === 'SPEAKER_PHONE') {
      rememberBuiltinCallRouteBeforeHeadset(route, !!opts?.defaultToEarpiece);
    }
    if (opts?.userRouteRef) {
      opts.userRouteRef.current = route;
    }
    if (opts?.speakerOnRef) {
      opts.speakerOnRef.current = route === 'SPEAKER_PHONE';
    }
    setPersistedCallAudioRoute(route);
    try {
      (global as any).__lastAppliedCallAudioRouteRef = { current: route };
    } catch {}
  };

  const publishRouteState = (available: string[], selected: string) => {
    lastAvailableRef.current = available;
    setAvailableRoutes(available);
    try {
      const g = global as any;
      g.__inCallAvailableAudioRoutesRef = g.__inCallAvailableAudioRoutesRef || { current: [] };
      g.__inCallAvailableAudioRoutesRef.current = available;
      g.__inCallSelectedAudioRouteRef = g.__inCallSelectedAudioRouteRef || { current: null };
      g.__inCallSelectedAudioRouteRef.current = norm;
    } catch {}
    const norm = normalizeInCallRoute(selected);
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
    if (!norm) return;

    lastSelectedRef.current = selected;
    if (earpieceMode) {
      const user = getUserRoute();
      if (isExternalHeadsetRoute(norm)) {
        lastAppliedRouteRef.current = norm;
        setSelectedRoute(norm);
        setUserRoute(norm);
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
    setUserRoute(norm);
  };

  const wantsSpeakerOutput = () => getUserRoute() === 'SPEAKER_PHONE';

  const logRouteInfo = (msg: string, data?: Record<string, unknown>) => {
    routeLog(msg, data);
  };

  const applyNativeSpeakerThrottled = (wantSpeaker: boolean, force: boolean) => {
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
    void applyNativeVoiceCallSpeaker(wantSpeaker);
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
    if (!wantSpeaker) {
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
    const ext = readActiveExternalCallAudioRoute(getUserRoute());
    if (isExternalHeadsetRoute(ext)) {
      return;
    }
    const userIntent = reason === 'manualSync' || reason.startsWith('toggle') || reason.startsWith('cycle');
    if (
      !wantSpeaker &&
      !userIntent &&
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
    setUserRoute(route);

    if (Platform.OS === 'android') {
      enqueueInCallOp(() => {
        try {
          if (wantSpeaker) {
            (InCallManager as any).setForceSpeakerphoneOn?.(true);
            InCallManager.setSpeakerphoneOn(true);
            void (InCallManager as any).chooseAudioRoute?.('SPEAKER_PHONE');
          } else {
            (InCallManager as any).setForceSpeakerphoneOn?.(false);
            InCallManager.setSpeakerphoneOn(false);
            void (InCallManager as any).chooseAudioRoute?.('EARPIECE');
          }
        } catch {}
      });
      applyNativeSpeakerThrottled(wantSpeaker, userIntent || force);
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
      const fallback = resolveBuiltinCallRouteAfterHeadsetDisconnect(earpieceMode);
      setUserRoute(fallback);
      return fallback;
    }
    if (onWired && !available.includes('WIRED_HEADSET')) {
      const fallback = resolveBuiltinCallRouteAfterHeadsetDisconnect(earpieceMode);
      setUserRoute(fallback);
      return fallback;
    }
    return null;
  };

  const pickDesiredRoute = (available: string[], reason: string): InCallAudioRoute => {
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
    const { gainedWired, gainedBt } = deviceChangeContextRef.current;
    const userNow = getUserRoute();
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
        const fallback = resolveBuiltinCallRouteAfterHeadsetDisconnect(true);
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

      const userIntent =
        reason === 'manualSync' ||
        reason.startsWith('cycle') ||
        reason === 'preferAudioMode' ||
        reason === 'applyRouting' ||
        reason === 'applyRouting_repin' ||
        reason === 'remote_stream' ||
        reason === 'remote_stream_repin' ||
        reason === 'session_re_enable';

      if (userIntent) {
        const user = getUserRoute();
        if (available.includes(user)) {
          return user;
        }
        if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
          return user;
        }
      }

      const stable = lastAppliedRouteRef.current;
      if (stable && (stable === 'EARPIECE' || stable === 'SPEAKER_PHONE' || available.includes(stable))) {
        return stable;
      }
      return 'EARPIECE';
    }

    if (isHeadsetUnplugReason(reason)) {
      if (available.includes('WIRED_HEADSET')) {
        return 'WIRED_HEADSET';
      }
      const fallback = resolveBuiltinCallRouteAfterHeadsetDisconnect(false);
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
    if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
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

    const userIntent =
      reason === 'manualSync' ||
      reason.startsWith('cycle') ||
      reason === 'preferAudioMode' ||
      reason === 'applyRouting' ||
      reason === 'applyRouting_repin' ||
      reason === 'remote_stream' ||
      reason === 'remote_stream_repin' ||
      reason === 'session_re_enable';

    if (userIntent) {
      if (available.includes(user)) {
        return user;
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
      !isExplicitBuiltInRouteChoice(reason, route)
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
    setUserRoute(effectiveRoute);
    setSelectedRoute(effectiveRoute);
    lastSelectedRef.current = effectiveRoute;
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
          markInCallAudioSessionStarted(true);
        } catch {}
      });
      didStartRef.current = true;
    } else {
      didStartRef.current = true;
      const ext = readActiveExternalCallAudioRoute(getUserRoute());
      const skipMediaRestart = !!ext || isInCallAudioSessionStarted();
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
      routeLog('applyRouting', {
        platform: Platform.OS,
        enabled,
        media,
        initial: 'deferred_bootstrap',
        hasRemoteStream: !!remoteStream,
        streamId: remoteStream?.id,
      });
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

  const applyDesiredRoute = async (available: string[], reason: string, force = false) => {
    if (!enabled) return;

    const desired = pickDesiredRoute(available, reason);
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
          restoreCallAudioForInAppPiPPlaque('stopSpeaker_preserve_in_app_pip');
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
  };

  useEffect(() => {
    if (!enabled) {
      setCallAudioBootstrapPending(false);
      stopSpeaker();
      return;
    }
    setCallAudioBootstrapPending(true);
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

    const onDeviceChanged = (data: any) => {
      const available = parseList(data?.availableAudioDeviceList);
      const selected = String(data?.selectedAudioDevice || '');
      const prev = previousAvailableRef.current;
      const lostBt = prev.includes('BLUETOOTH') && !available.includes('BLUETOOTH');
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
          const probe = await probeNativeCallAudioRoutes();
          const merged = mergeNativeProbeIntoGlobal(probe);
          const list = merged.length ? merged : available;
          if (lostBt && (probe.available.includes('BLUETOOTH') || list.includes('BLUETOOTH'))) {
            lastAvailableRef.current = list;
            previousAvailableRef.current = list;
            setAvailableRoutes(list);
            deviceChangeContextRef.current = { gainedWired: false, gainedBt: true };
            await applyDesiredRoute(list, 'onAudioDeviceChanged', true);
            deviceChangeContextRef.current = { gainedWired: false, gainedBt: false };
            return;
          }
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
          if (
            (reason === 'bootstrap' || reason.startsWith('poll_')) &&
            shouldPreferBluetoothEarlyInCall(reason)
          ) {
            try {
              const btStatus = await icm.chooseAudioRoute?.('BLUETOOTH');
              const parsed = parseStatus(btStatus);
              if (parsed.available.includes('BLUETOOTH')) {
                chosen = 'BLUETOOTH';
                lastAvailableRef.current = parsed.available.length ? parsed.available : av;
              } else if (av.includes('BLUETOOTH')) {
                chosen = 'BLUETOOTH';
              }
            } catch {
              if (av.includes('BLUETOOTH')) chosen = 'BLUETOOTH';
            }
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
        const av = lastAvailableRef.current;
        const desired = pickDesiredRoute(av, `poll_${ms}`);
        if (desired === lastSelectedRef.current && (av.includes('WIRED_HEADSET') || av.includes('BLUETOOTH'))) {
          break;
        }
      }
      if (!cancelled) {
        setCallAudioBootstrapPending(false);
        const av = lastAvailableRef.current;
        if (routingOptionsRef.current?.defaultToEarpiece && !readNativeProbedExternalRoute()) {
          const ext = readConnectedExternalCallAudioRoute(getUserRoute());
          if (!ext && !av.includes('BLUETOOTH') && !av.includes('WIRED_HEADSET')) {
            applySpecificRoute('EARPIECE', 'bootstrap_done', true);
          }
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      setCallAudioBootstrapPending(false);
      if (headsetPollTimer) clearInterval(headsetPollTimer);
      subs.forEach((s) => {
        try { s?.remove?.(); } catch {}
      });
      stopSpeaker();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !routingOptionsRef.current?.defaultToEarpiece) return;
    const applyPrefer = () => {
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
        const lastApplied = readLastAppliedCallAudioRoute();
        if (isExternalHeadsetRoute(lastApplied)) {
          applySpecificRoute(lastApplied, 'preferAudioMode', true);
          return;
        }
      }
      if (isCallAudioBootstrapPending()) {
        return;
      }
      setUserRoute('EARPIECE');
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
    lastRemoteStreamRoutedIdRef.current = streamId;

    const av = lastAvailableRef.current;
    const route = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'remote_stream');
    applySpecificRoute(route, 'remote_stream', true);
    const timer = setTimeout(() => {
      const av2 = lastAvailableRef.current;
      const repin = pickDesiredRoute(av2.length ? av2 : ['EARPIECE', 'SPEAKER_PHONE'], 'remote_stream_repin');
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
          if (isExternalHeadsetRoute(user) && (av.includes(user) || pipPreserve)) {
            route = user;
          } else if (isExternalHeadsetRoute(lastAppliedRouteRef.current)) {
            route = lastAppliedRouteRef.current;
          } else if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
            route = user;
          } else {
            route = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'manualSync');
          }
        } else if (user === 'BLUETOOTH' && av.includes('BLUETOOTH')) {
          route = 'BLUETOOTH';
        } else if (user === 'WIRED_HEADSET' && av.includes('WIRED_HEADSET')) {
          route = 'WIRED_HEADSET';
        } else if (user === 'SPEAKER_PHONE' || user === 'EARPIECE') {
          route = user;
        } else {
          route = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], 'manualSync');
        }
        applySpecificRoute(route, 'manualSync', true);
        publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], route);
      })();
    }, 140);
  }, [enabled]);

  const cycleUserRoute = useCallback(() => {
    let av = lastAvailableRef.current;
    const nativeExt = readNativeProbedExternalRoute();
    if (nativeExt && !av.includes(nativeExt)) {
      av = Array.from(new Set([...av, nativeExt]));
      lastAvailableRef.current = av;
    }
    const current = getUserRoute();
    const next = nextRouteInCycle(current, av.length ? av : ['EARPIECE', 'SPEAKER_PHONE']);
    routeLog('cycleUserRoute', { from: current, next, available: av });
    setUserRoute(next);
    setSelectedRoute(next);
    lastSelectedRef.current = next;
    applySpecificRoute(next, 'cycleUserRoute', true);
    publishRouteState(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE'], next);
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
