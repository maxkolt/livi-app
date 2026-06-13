import { useEffect, useRef, type MutableRefObject } from 'react';
import { DeviceEventEmitter, InteractionManager, PermissionsAndroid, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { beginBackgroundMediaSuppression, pauseBackgroundMediaAfterCall } from '../../../utils/callKeep';
import { logger } from '../../../utils/logger';
import { applyNativeVoiceCallSpeaker } from '../../../utils/voiceCallAudioRoute';

/**
 * Хук для управления аудио-рутированием
 * ВАЖНО: без агрессивных таймеров/пинков — они часто ухудшают стабильность (особенно на Android/ColorOS).
 * Делаем один предсказуемый старт/стоп аудио-сессии, остальное оставляем LiveKit/WebRTC.
 */
export type AudioRoutingOptions = {
  /** Старт с разговорного динамика (earpiece); громкий — только по кнопке. */
  defaultToEarpiece?: boolean;
  speakerOnRef?: MutableRefObject<boolean>;
};

const MIN_HARD_ROUTE_MS = 500;
const MIN_NATIVE_ROUTE_MS = 600;

export const useAudioRouting = (
  enabled: boolean,
  remoteStream: any,
  preferAudioMode = false,
  routingOptions?: AudioRoutingOptions,
) => {
  const routingOptionsRef = useRef(routingOptions);
  routingOptionsRef.current = routingOptions;

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
  const incallOpChainRef = useRef(Promise.resolve());

  const enqueueInCallOp = (op: () => void | Promise<void>) => {
    incallOpChainRef.current = incallOpChainRef.current
      .then(() => op())
      .catch(() => {});
  };

  const log = (msg: string, data?: any) => {
    const now = Date.now();
    const allow = __DEV__ || now - lastLogAtRef.current > 1200;
    if (!allow) return;
    lastLogAtRef.current = now;
    try { logger.debug(msg, data); } catch {}
  };

  const setSpeakerAuto = () => {
    try {
      const fn = (InCallManager as any).setForceSpeakerphoneOn;
      if (typeof fn === 'function') {
        try {
          fn('auto');
          return;
        } catch {}
        try {
          fn(false);
          return;
        } catch {}
      }
    } catch {}
  };

  const setSpeakerOff = () => {
    try { (InCallManager as any).setForceSpeakerphoneOn?.(false); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
  };

  const wantsSpeakerOutput = () => {
    const opts = routingOptionsRef.current;
    if (opts?.defaultToEarpiece) {
      return !!opts.speakerOnRef?.current;
    }
    return true;
  };

  const logRouteInfo = (msg: string, data?: Record<string, unknown>) => {
    try {
      logger.debug(`[useAudioRouting] ${msg}`, {
        speakerOn: wantsSpeakerOutput(),
        defaultToEarpiece: !!routingOptionsRef.current?.defaultToEarpiece,
        ...data,
      });
    } catch {}
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

  /** Android: жёстко выставить earpiece или speaker (InCallManager user selection). */
  const applyHardOutputRoute = (reason: string, force = false) => {
    const wantSpeaker = wantsSpeakerOutput();
    const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
    const now = Date.now();
    const userIntent = reason === 'manualSync' || reason.startsWith('toggle');

    if (!userIntent) {
      if (earpieceMode && (reason.startsWith('poll_') || reason === 'onAudioDeviceChanged')) {
        return;
      }
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
      InCallManager.setSpeakerphoneOn(wantsSpeakerOutput());
    } catch {}
  };

  const configureIOSAudioSession = () => {
    if (Platform.OS !== 'ios') return;
    try {
      const webrtcMod = require('@livekit/react-native-webrtc');
      const RTCAudioSession = webrtcMod?.RTCAudioSession;
      if (!RTCAudioSession || typeof RTCAudioSession.sharedInstance !== 'function') return;
      const s = RTCAudioSession.sharedInstance();
      s.setCategory('PlayAndRecord', {
        defaultToSpeaker: wantsSpeakerOutput(),
        allowBluetooth: true,
        allowBluetoothA2DP: true,
        mixWithOthers: false,
      });
      s.setMode(wantsSpeakerOutput() ? 'VideoChat' : 'VoiceChat');
      s.setActive(true);
    } catch (e) {
      logger.warn('[useAudioRouting] Error configuring iOS audio session:', e);
    }
  };

  const applyRouting = () => {
    if (Platform.OS === 'android') {
      beginBackgroundMediaSuppression();
    }
    const earpieceProductMode = !!routingOptionsRef.current?.defaultToEarpiece;
    const media = earpieceProductMode || preferAudioMode ? 'audio' : 'video';
    const alreadyActive = didStartRef.current;
    if (Platform.OS === 'android' && earpieceProductMode && !alreadyActive) {
      try { InCallManager.stop(); } catch {}
    }
    if (!alreadyActive) {
      enqueueInCallOp(() => {
        try { InCallManager.start({ media, ringback: '' }); } catch {}
      });
    } else if (!earpieceProductMode) {
      enqueueInCallOp(() => {
        try { InCallManager.start({ media, ringback: '' }); } catch {}
      });
    }
    try { (InCallManager as any).requestAudioFocus?.(); } catch {}
    applyHardOutputRoute(alreadyActive && earpieceProductMode ? 'applyRouting_repin' : 'applyRouting', true);
    log('[useAudioRouting] applyRouting()', {
      platform: Platform.OS,
      enabled,
      media,
      hasRemoteStream: !!remoteStream,
      streamId: remoteStream?.id,
    });
  };

  const pickDesiredRoute = (available: string[]) => {
    if (available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
    if (available.includes('BLUETOOTH')) return 'BLUETOOTH';
    return wantsSpeakerOutput() ? 'SPEAKER_PHONE' : 'EARPIECE';
  };

  const applyDesiredRoute = async (available: string[], reason: string, force = false) => {
    if (!enabled) return;
    if (Platform.OS !== 'android') return;
    if (routingOptionsRef.current?.defaultToEarpiece) {
      applyHardOutputRoute(reason, force);
      const desired = pickDesiredRoute(available);
      if (desired) lastSelectedRef.current = desired;
      return;
    }
    const desired = pickDesiredRoute(available);
    if (!force && desired && lastSelectedRef.current === desired) return;
    lastSelectedRef.current = desired;
    try {
      enqueueInCallOp(() => {
        void (InCallManager as any).chooseAudioRoute?.(desired);
      });
      log('[useAudioRouting] ✅ chooseAudioRoute()', { desired, available, reason });
      logger.debug('[useAudioRouting] chooseAudioRoute', { desired, available, reason });
      return;
    } catch (e) {
      log('[useAudioRouting] ❌ chooseAudioRoute() failed', { desired, available, reason, e });
      logger.warn('[useAudioRouting] chooseAudioRoute failed, fallback to speaker toggle', { desired, reason, e });
    }

    try {
      if (desired === 'SPEAKER_PHONE') {
        InCallManager.setSpeakerphoneOn(true);
      } else {
        InCallManager.setSpeakerphoneOn(false);
      }
    } catch {}
  };

  const stopSpeaker = () => {
    try {
      const pipVisible = !!(global as any).__pipVisibleRef?.current;
      const inSystemPiP = (global as any).__pipInSystemModeRef?.current === true;
      if (pipVisible || inSystemPiP) {
        return;
      }
    } catch {}

    lastRemoteStreamRoutedIdRef.current = null;
    lastHardRouteAtRef.current = 0;
    lastNativeRouteAtRef.current = 0;
    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
    pauseBackgroundMediaAfterCall();
    try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
    didStartRef.current = false;
  };

  useEffect(() => {
    if (!enabled) {
      stopSpeaker();
      return;
    }

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
      lastAvailableRef.current = available;
      if (selected) lastSelectedRef.current = selected;
      return { available, selected };
    };

    const onDeviceChanged = (data: any) => {
      const { available, selected } = parseStatus(data);
      log('[useAudioRouting] onAudioDeviceChanged', { available, selected });
      void applyDesiredRoute(available, 'onAudioDeviceChanged');
    };

    const onWired = (data: any) => {
      const plugged = data?.isPlugged === true;
      const available = plugged
        ? Array.from(new Set([...lastAvailableRef.current, 'WIRED_HEADSET']))
        : lastAvailableRef.current.filter((d) => d !== 'WIRED_HEADSET');
      lastAvailableRef.current = available;
      log('[useAudioRouting] WiredHeadset', { plugged, available });
      void applyDesiredRoute(available, 'WiredHeadset', true);
    };

    const subs: Array<{ remove: () => void }> = [];
    if (Platform.OS === 'android') {
      try { subs.push(DeviceEventEmitter.addListener('onAudioDeviceChanged', onDeviceChanged) as any); } catch {}
      try { subs.push(DeviceEventEmitter.addListener('WiredHeadset', onWired) as any); } catch {}
    }

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
          applyHardOutputRoute('session_re_enable', true);
        });
        return;
      }
      const ok = await ensureBluetoothConnectPermission();
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
      if (Platform.OS !== 'android') return;
      const earpieceMode = !!routingOptionsRef.current?.defaultToEarpiece;
      if (earpieceMode) {
        applyHardOutputRoute('bootstrap', true);
        return;
      }

      const icm: any = InCallManager as any;

      const refresh = async (reason: string) => {
        if (cancelled) return;
        if (refreshInFlightRef.current) return;
        const now = Date.now();
        if (now - lastRefreshAtRef.current < 350) return;
        refreshInFlightRef.current = true;
        lastRefreshAtRef.current = now;
        try {
          const av = lastAvailableRef.current;
          const chosen = pickDesiredRoute(av.length ? av : ['EARPIECE', 'SPEAKER_PHONE']);
          const status = await icm.chooseAudioRoute?.(chosen);
          const { available, selected } = parseStatus(status);
          log('[useAudioRouting] refreshStatus', { reason, available, selected });
          await applyDesiredRoute(available, reason);
        } catch (e) {
          log('[useAudioRouting] refreshStatus failed', { reason, e });
        } finally {
          refreshInFlightRef.current = false;
        }
      };

      await refresh('bootstrap');
      const delays = [700, 2000];
      for (const ms of delays) {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, ms));
        await refresh(`poll_${ms}`);
        const av = lastAvailableRef.current;
        const desired = pickDesiredRoute(av);
        if (desired === lastSelectedRef.current && (av.includes('WIRED_HEADSET') || av.includes('BLUETOOTH'))) {
          break;
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
      subs.forEach((s) => {
        try { s?.remove?.(); } catch {}
      });
      stopSpeaker();
    };
  }, [enabled]);

  const syncRouteDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled || !routingOptionsRef.current?.defaultToEarpiece) return;
    const streamId = remoteStream?.id ? String(remoteStream.id) : '';
    if (!streamId || !remoteStream?.getAudioTracks?.()?.length) return;
    if (lastRemoteStreamRoutedIdRef.current === streamId) return;
    lastRemoteStreamRoutedIdRef.current = streamId;

    applyHardOutputRoute('remote_stream', true);
    const timer = setTimeout(() => applyHardOutputRoute('remote_stream+1200ms', false), 1200);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, remoteStream?.id, preferAudioMode]);

  return {
    syncRouteNow: () => {
      if (syncRouteDebounceRef.current) {
        clearTimeout(syncRouteDebounceRef.current);
      }
      syncRouteDebounceRef.current = setTimeout(() => {
        syncRouteDebounceRef.current = null;
        applyHardOutputRoute('manualSync', true);
        if (!routingOptionsRef.current?.defaultToEarpiece) {
          void applyDesiredRoute(lastAvailableRef.current, 'manualSync', true);
        }
      }, 140);
    },
    stopSpeaker,
    applyHardOutputRoute,
  };
};
