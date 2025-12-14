import { useEffect, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { mediaDevices } from '@livekit/react-native-webrtc';
import { logger } from '../../../utils/logger';

/**
 * Хук для управления аудио-рутированием
 * Обрабатывает speaker-on, bluetooth fallback, таймеры которые "пинают" систему
 */
export const useAudioRouting = (enabled: boolean, remoteStream: any) => {
  const speakerTimersRef = useRef<any[]>([]);

  const clearSpeakerTimers = () => {
    speakerTimersRef.current.forEach(t => clearTimeout(t));
    speakerTimersRef.current = [];
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
      const poke = () => { try { s.overrideOutputAudioPort('speaker'); } catch {} };
      poke();
      speakerTimersRef.current.push(setTimeout(poke, 80));
      speakerTimersRef.current.push(setTimeout(poke, 200));
    } catch (e) {
      logger.warn('[useAudioRouting] Error configuring iOS audio session:', e);
    }
  };

  const forceSpeakerOnHard = () => {
    if (!enabled) return;

    try { InCallManager.start({ media: 'video', ringback: '' }); } catch {}

    const kick = () => {
      try { (InCallManager as any).setForceSpeakerphoneOn?.('on'); } catch {}
      try { InCallManager.setForceSpeakerphoneOn?.(true as any); } catch {}
      try { InCallManager.setSpeakerphoneOn(true); } catch {}
      try { (mediaDevices as any)?.setSpeakerphoneOn?.(true); } catch {}
      try { (InCallManager as any).setBluetoothScoOn?.(false); } catch {}
    };

    kick();
    speakerTimersRef.current.push(setTimeout(kick, 120));
    speakerTimersRef.current.push(setTimeout(kick, 350));
    speakerTimersRef.current.push(setTimeout(kick, 800));

    configureIOSAudioSession();
  };

  const stopSpeaker = () => {
    clearSpeakerTimers();
    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
  };

  // Форсим спикер при активном звонке
  useEffect(() => {
    if (!enabled || !remoteStream) {
      logger.info('[useAudioRouting] Пропускаем forceSpeakerOnHard', {
        enabled,
        hasRemoteStream: !!remoteStream,
        streamId: remoteStream?.id
      });
      return;
    }

    logger.info('[useAudioRouting] ✅ Вызываем forceSpeakerOnHard', {
      enabled,
      streamId: remoteStream.id,
      hasAudioTracks: !!(remoteStream as any)?.getAudioTracks?.()?.[0],
      audioTrackEnabled: (remoteStream as any)?.getAudioTracks?.()?.[0]?.enabled
    });

    forceSpeakerOnHard();

    return () => {
      stopSpeaker();
    };
  }, [enabled, remoteStream]);

  // Обработка AppState - форсим спикер при активном звонке
  useEffect(() => {
    if (!enabled || !remoteStream) return;

    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        forceSpeakerOnHard();
      }
    });

    return () => sub.remove();
  }, [enabled, remoteStream]);

  return {
    forceSpeakerOnHard,
    stopSpeaker,
  };
};
