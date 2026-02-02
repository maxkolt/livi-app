import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { mediaDevices } from '@livekit/react-native-webrtc';
import { logger } from '../../../utils/logger';

/**
 * Хук для управления аудио-рутированием
 * ВАЖНО: без агрессивных таймеров/пинков — они часто ухудшают стабильность (особенно на Android/ColorOS).
 * Делаем один предсказуемый старт/стоп аудио-сессии, остальное оставляем LiveKit/WebRTC.
 */
export const useAudioRouting = (enabled: boolean, remoteStream: any) => {
  const didStartRef = useRef(false);

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
    // IMPORTANT: do NOT force speakerphone. Use auto routing so headset/BT works correctly.
    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    // Do not call setSpeakerphoneOn(true) here; InCallManager.start({media:'video'}) will default appropriately.
    // Also do not force WebRTC mediaDevices speaker; let OS route.
    // Не трогаем BT SCO агрессивно — это ломает роутинг на части устройств.
    configureIOSAudioSession();
  };

  const stopSpeaker = () => {
    // КРИТИЧНО: Если мы в PiP, НЕ останавливаем аудио-сессию.
    // При уходе в PiP экран звонка размонтируется, и cleanup этого хука иначе вызовет InCallManager.stop(),
    // что приводит к "тишине" в PiP.
    try {
      const pipVisible = !!(global as any).__pipVisibleRef?.current;
      if (pipVisible) {
        logger.info('[useAudioRouting] Skip stopSpeaker because PiP is visible');
        return;
      }
    } catch {}

    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
    didStartRef.current = false;
  };

  // КРИТИЧНО: Форсим аудио-сессию/спикер при активном звонке.
  // Нельзя ждать remoteStream, т.к. на iOS иногда аудио не начинает играть, если аудио-сессия не поднята заранее.
  useEffect(() => {
    if (!enabled) {
      stopSpeaker();
      return;
    }

    logger.info('[useAudioRouting] ✅ Starting call audio routing (pre-remoteStream)', {
      enabled,
      hasRemoteStream: !!remoteStream,
      streamId: remoteStream?.id,
    });
    if (!didStartRef.current) {
      didStartRef.current = true;
      applyRouting();
    }

    return () => stopSpeaker();
  }, [enabled]);

  return {
    forceSpeakerOnHard: applyRouting,
    stopSpeaker,
  };
};
