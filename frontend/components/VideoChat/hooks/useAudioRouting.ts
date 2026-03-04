import { useEffect, useRef } from 'react';
import { DeviceEventEmitter, InteractionManager, PermissionsAndroid, Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logger } from '../../../utils/logger';

/**
 * Хук для управления аудио-рутированием
 * ВАЖНО: без агрессивных таймеров/пинков — они часто ухудшают стабильность (особенно на Android/ColorOS).
 * Делаем один предсказуемый старт/стоп аудио-сессии, остальное оставляем LiveKit/WebRTC.
 */
export const useAudioRouting = (enabled: boolean, remoteStream: any) => {
  const didStartRef = useRef(false);
  const lastAvailableRef = useRef<string[]>([]);
  const lastSelectedRef = useRef<string>('');
  const lastLogAtRef = useRef(0);
  const btPermissionRequestedRef = useRef(false);
  const log = (msg: string, data?: any) => {
    // Keep logs useful but not too spammy.
    const now = Date.now();
    const allow = __DEV__ || now - lastLogAtRef.current > 1200;
    if (!allow) return;
    lastLogAtRef.current = now;
    // Noisy audio routing logs should be DEBUG-level (hidden by default LOG_LEVEL=info).
    try { logger.debug(msg, data); } catch {}
  };

  const setSpeakerAuto = () => {
    // Best-effort across incall-manager versions:
    // - prefer "auto" if supported
    // - fallback to boolean false (do not force speakerphone)
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

  const configureIOSAudioSession = () => {
    if (Platform.OS !== 'ios') return;
    try {
      const webrtcMod = require('@livekit/react-native-webrtc');
      const RTCAudioSession = webrtcMod?.RTCAudioSession;
      if (!RTCAudioSession || typeof RTCAudioSession.sharedInstance !== 'function') return;
      const s = RTCAudioSession.sharedInstance();
      s.setCategory('PlayAndRecord', {
        defaultToSpeaker: true,
        allowBluetooth: true,
        allowBluetoothA2DP: true,
        mixWithOthers: false,
      });
      s.setMode('VideoChat');
      s.setActive(true);
      // IMPORTANT: do NOT force speaker output. Let iOS route to wired/Bluetooth devices.
    } catch (e) {
      logger.warn('[useAudioRouting] Error configuring iOS audio session:', e);
    }
  };

  const applyRouting = () => {
    try { InCallManager.start({ media: 'video', ringback: '' }); } catch {}
    // Ensure Android audio focus is requested (some devices won't switch routes reliably without it).
    try { (InCallManager as any).requestAudioFocus?.(); } catch {}
    // Android: по умолчанию звук в видеозвонке идёт в громкий динамик, не в верхний (earpiece).
    if (Platform.OS === 'android') {
      try { InCallManager.setSpeakerphoneOn(true); } catch {}
    } else {
      setSpeakerAuto(); // iOS: keep "auto" so wired/Bluetooth can take over.
    }
    configureIOSAudioSession();
    log('[useAudioRouting] applyRouting()', {
      platform: Platform.OS,
      enabled,
      hasRemoteStream: !!remoteStream,
      streamId: remoteStream?.id,
    });
  };

  const pickDesiredRoute = (available: string[]) => {
    // Deterministic rule:
    // 1) Wired headset always wins
    // 2) Bluetooth headset next
    // 3) Otherwise default to speakerphone for video calls
    if (available.includes('WIRED_HEADSET')) return 'WIRED_HEADSET';
    if (available.includes('BLUETOOTH')) return 'BLUETOOTH';
    return 'SPEAKER_PHONE';
  };

  const applyDesiredRoute = async (available: string[], reason: string) => {
    if (!enabled) return;
    if (Platform.OS !== 'android') return; // iOS routes automatically (wired/BT has priority)
    const desired = pickDesiredRoute(available);
    if (desired && lastSelectedRef.current === desired) return;
    lastSelectedRef.current = desired;
    try {
      await (InCallManager as any).chooseAudioRoute?.(desired);
      log('[useAudioRouting] ✅ chooseAudioRoute()', { desired, available, reason });
      logger.debug('[useAudioRouting] chooseAudioRoute', { desired, available, reason });
      return;
    } catch (e) {
      log('[useAudioRouting] ❌ chooseAudioRoute() failed', { desired, available, reason, e });
      logger.warn('[useAudioRouting] chooseAudioRoute failed, fallback to speaker toggle', { desired, reason, e });
    }

    // Fallback: speaker toggle only (wired/BT should still work on most devices, but less deterministic).
    try {
      if (desired === 'SPEAKER_PHONE') {
        InCallManager.setSpeakerphoneOn(true);
      } else {
        InCallManager.setSpeakerphoneOn(false);
      }
    } catch {}
  };

  const stopSpeaker = () => {
    // КРИТИЧНО: Если мы в PiP (in-app или системный), НЕ останавливаем аудио-сессию.
    // При уходе в PiP экран звонка размонтируется, и cleanup этого хука иначе вызовет InCallManager.stop(),
    // что приводит к "тишине" в PiP. Учитываем оба режима — иначе при системном PiP без in-app один не слышит другого.
    try {
      const pipVisible = !!(global as any).__pipVisibleRef?.current;
      const inSystemPiP = (global as any).__pipInSystemModeRef?.current === true;
      if (pipVisible || inSystemPiP) {
        logger.debug('[useAudioRouting] Skip stopSpeaker because PiP is active', { pipVisible, inSystemPiP });
        return;
      }
    } catch {}

    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
    try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
    didStartRef.current = false;
  };

  // КРИТИЧНО: Форсим аудио-сессию/спикер при активном звонке.
  // Нельзя ждать remoteStream, т.к. на iOS иногда аудио не начинает играть, если аудио-сессия не поднята заранее.
  // Single effect: attach listeners BEFORE InCallManager.start() to avoid missing the first onAudioDeviceChanged event.
  useEffect(() => {
    if (!enabled) {
      stopSpeaker();
      return;
    }

    logger.info('[useAudioRouting] ✅ Starting call audio routing (pre-remoteStream)', {
      enabled,
      hasRemoteStream: !!remoteStream,
      streamId: remoteStream?.id,
      platform: Platform.OS,
    });

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
      // Android native emits {isPlugged:boolean}
      const plugged = data?.isPlugged === true;
      const available = plugged
        ? Array.from(new Set([...lastAvailableRef.current, 'WIRED_HEADSET']))
        : lastAvailableRef.current.filter((d) => d !== 'WIRED_HEADSET');
      lastAvailableRef.current = available;
      log('[useAudioRouting] WiredHeadset', { plugged, available });
      void applyDesiredRoute(available, 'WiredHeadset');
    };

    const subs: Array<{ remove: () => void }> = [];
    if (Platform.OS === 'android') {
      try { subs.push(DeviceEventEmitter.addListener('onAudioDeviceChanged', onDeviceChanged) as any); } catch {}
      try { subs.push(DeviceEventEmitter.addListener('WiredHeadset', onWired) as any); } catch {}
    }

    const ensureBluetoothConnectPermission = async (): Promise<boolean> => {
      if (Platform.OS !== 'android') return true;
      const ver = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
      if (!Number.isFinite(ver) || ver < 31) return true; // BLUETOOTH_CONNECT introduced in Android 12 (API 31)

      // react-native-incall-manager will refuse to start BT manager without this permission.
      const perm = (PermissionsAndroid as any)?.PERMISSIONS?.BLUETOOTH_CONNECT;
      if (!perm) return true;

      try {
        const already = await PermissionsAndroid.check(perm);
        if (already) return true;
      } catch {}

      // Request only once per hook lifetime to avoid spamming prompts.
      if (btPermissionRequestedRef.current) return false;
      btPermissionRequestedRef.current = true;

      try {
        const res = await PermissionsAndroid.request(perm);
        const ok = res === PermissionsAndroid.RESULTS.GRANTED;
        logger.info('[useAudioRouting] BLUETOOTH_CONNECT permission result', { ok, res });
        return ok;
      } catch (e) {
        logger.warn('[useAudioRouting] BLUETOOTH_CONNECT permission request failed', { e });
        return false;
      }
    };

    let cancelled = false;

    // Start routing after permission check; defer InCallManager.start until after navigation/animations
    // to avoid main-thread contention (Choreographer "Skipped N frames" / AudioDeviceBroker lock).
    (async () => {
      if (didStartRef.current) return;
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

    // Bootstrap + short polling window:
    // Bluetooth SCO may take 1-3s to become available; we actively query status via chooseAudioRoute()
    // (it returns availableAudioDeviceList/selectedAudioDevice) and then apply deterministic rule.
    const bootstrap = async () => {
      if (Platform.OS !== 'android') return;
      const icm: any = InCallManager as any;

      const refresh = async (reason: string) => {
        if (cancelled) return;
        try {
          const chosen = lastSelectedRef.current || 'SPEAKER_PHONE';
          const status = await icm.chooseAudioRoute?.(chosen);
          const { available, selected } = parseStatus(status);
          log('[useAudioRouting] refreshStatus', { reason, available, selected });
          await applyDesiredRoute(available, reason);
        } catch (e) {
          log('[useAudioRouting] refreshStatus failed', { reason, e });
        }
      };

      // 1) immediate refresh
      await refresh('bootstrap');
      // 2) poll a few times for BT/SCO to appear
      const delays = [300, 700, 1200, 2000, 3200];
      for (const ms of delays) {
        if (cancelled) break;
        await new Promise((r) => setTimeout(r, ms));
        await refresh(`poll_${ms}`);
        // stop early if we already see external devices
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

  return {
    // Re-apply routing rules (used after PiP/foreground transitions)
    syncRouteNow: () => applyDesiredRoute(lastAvailableRef.current, 'manualSync'),
    stopSpeaker,
  };
};
