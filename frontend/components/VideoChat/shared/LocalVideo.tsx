import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { RTCView, MediaStream } from '@livekit/react-native-webrtc';
import { isValidStream } from '../../../utils/streamUtils';
import { t, type Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

interface LocalVideoProps {
  localStream: MediaStream | null;
  camOn: boolean;
  isFrontCamera: boolean;
  isInactiveState: boolean;
  wasFriendCallEnded: boolean;
  started: boolean;
  localRenderKey: number;
  lang: Lang;
  onStreamReady?: (stream: MediaStream) => void;
}

/**
 * Компонент для отображения локального видео
 * Обрабатывает рендер камеры, заглушки "Вы", проверки готовности стрима, контроль renderKey
 */
export const LocalVideo: React.FC<LocalVideoProps> = ({
  localStream,
  camOn,
  isFrontCamera,
  isInactiveState,
  wasFriendCallEnded,
  started,
  localRenderKey,
  lang,
  onStreamReady,
}) => {
  const L = (key: string) => t(key, lang);
  // На Android 8.1 и старше (API <= 27) SurfaceView overlay/z-order часто ломает отображение (особенно на OPPO/ColorOS).
  // Для таких устройств отключаем zOrderMediaOverlay, чтобы Surface корректно композировался в окне.
  const isLegacyAndroidSurface = Platform.OS === 'android' && Number(Platform.Version) <= 27;
  // На старых Android используем TextureView, чтобы RN-оверлеи (кнопки) гарантированно рисовались поверх видео.
  const useTextureViewOnAndroid = Platform.OS === 'android' && isLegacyAndroidSurface;

  const [trackLiveTick, setTrackLiveTick] = useState(0);
  const [forceUpdateKey, setForceUpdateKey] = useState(0);

  // КРИТИЧНО: Все хуки должны быть вызваны ДО любых условных return
  // Проверяем готовность стрима
  const hasLocalStream = localStream && isValidStream(localStream);
  const videoTrack = hasLocalStream ? (localStream as any)?.getVideoTracks?.()?.[0] : null;
  const localVideoTrackId = videoTrack?.id ?? null;
  const isVideoTrackLive = !!videoTrack && videoTrack.readyState === 'live';
  const isVideoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true) === true;
  const isVideoTrackMuted = !!videoTrack && (videoTrack.muted ?? false) === true;
  // На Android (особенно 8.1/ColorOS) `muted` у локального трека может быть true даже при реальных кадрах,
  // из-за чего UI ошибочно показывает плейсхолдер "Вы". Поэтому для Android игнорируем `muted` при решении рендера.
  const canRenderVideo =
    !!videoTrack &&
    isVideoTrackEnabled &&
    (Platform.OS === 'android' ? true : !isVideoTrackMuted) &&
    (isVideoTrackLive || trackLiveTick > 0);
  
  // Логирование для отладки на Android
  useEffect(() => {
    if (Platform.OS === 'android' && localStream) {
      logger.debug('[LocalVideo] Local stream state', {
        streamId: localStream.id,
        hasVideoTrack: !!videoTrack,
        isVideoTrackLive,
        isVideoTrackEnabled,
        isVideoTrackMuted,
        hasStreamURL: typeof localStream.toURL === 'function',
        streamURL: localStream.toURL?.()?.substring(0, 50) + '...'
      });
    }
  }, [localStream?.id, isVideoTrackLive, isVideoTrackEnabled, isVideoTrackMuted]);

  // После flip readyState может не быть 'live' сразу — один отложенный re-render (как у RemoteVideo).
  useEffect(() => {
    if (!localStream || !isValidStream(localStream)) return;
    const vt = (localStream as any)?.getVideoTracks?.()?.[0];
    if (!vt) return;
    setTrackLiveTick(0);
    const t = setTimeout(() => setTrackLiveTick((k) => k + 1), 150);
    return () => clearTimeout(t);
  }, [localStream?.id, localVideoTrackId]);

  // КРИТИЧНО: На Android нужен force-update для RTCView при изменении стрима
  useEffect(() => {
    if (Platform.OS === 'android' && localStream && isValidStream(localStream)) {
      const vt = (localStream as any)?.getVideoTracks?.()?.[0];
      if (!vt) return;
      const bump = () => {
        setForceUpdateKey((prev) => {
          const next = prev + 1;
          logger.debug('[LocalVideo] Android: force-update RTCView', {
            streamId: localStream.id,
            trackId: vt.id,
            trackEnabled: vt.enabled,
            trackReady: vt.readyState,
            key: next,
          });
          return next;
        });
      };
      if (vt.readyState === 'live') {
        bump();
        return;
      }
      const poll = setInterval(() => {
        if (vt.readyState === 'live') {
          clearInterval(poll);
          bump();
        }
      }, 80);
      const stop = setTimeout(() => clearInterval(poll), 3500);
      return () => {
        clearInterval(poll);
        clearTimeout(stop);
      };
    }
  }, [localStream?.id, localVideoTrackId, localRenderKey]);

  // КРИТИЧНО: На Android RTCView может "залипать" на черном экране при переключении enabled у videoTrack
  // (камера OFF -> ON). Поэтому при изменении enabled/ camOn форсим remount.
  const lastEnabledRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!localStream || !isValidStream(localStream)) return;
    const currentEnabled = !!(videoTrack?.enabled ?? false);
    if (lastEnabledRef.current === null) {
      lastEnabledRef.current = currentEnabled;
      return;
    }
    if (lastEnabledRef.current !== currentEnabled) {
      lastEnabledRef.current = currentEnabled;
      setForceUpdateKey((prev) => prev + 1);
    }
  }, [camOn, localStream?.id, isVideoTrackEnabled]);

  // Уведомляем о готовности стрима
  useEffect(() => {
    if (localStream && isValidStream(localStream) && onStreamReady) {
      onStreamReady(localStream);
    }
  }, [localStream, onStreamReady]);

  // После завершения звонка показываем надпись "Вы"
  if (isInactiveState || wasFriendCallEnded) {
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('you')}</Text>
      </View>
    );
  }

  // Если UI считает, что камера выключена — всегда показываем заглушку "Вы".
  // Это должно иметь приоритет над попытками рендера RTCView, иначе получаем "черный прямоугольник".
  if (!camOn) {
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('you')}</Text>
      </View>
    );
  }

  // КРИТИЧНО: Показываем видео если есть готовый трек, даже если camOn еще не обновлен
  // camOn может обновиться позже через onCamStateChange
  if (hasLocalStream && canRenderVideo) {
    // КРИТИЧНО: На Android используем prop `stream` напрямую вместо `streamURL`
    // Это более надежный способ для @livekit/react-native-webrtc на Android, но добавляем streamURL как fallback
    const localStreamURL = localStream.toURL?.();
    const mirrorKey = isFrontCamera ? 'mirror' : 'nomirror';
    const rtcViewKey = Platform.OS === 'android'
      ? `local-video-${localStream.id}-${localRenderKey}-${forceUpdateKey}-${mirrorKey}-${isVideoTrackEnabled ? 1 : 0}`
      : `local-video-${localStream.id}-${localRenderKey}-${mirrorKey}`;
    
    logger.debug('[LocalVideo] Render RTCView', {
      platform: Platform.OS,
      streamURL: localStreamURL ? localStreamURL.substring(0, 50) + '...' : 'null',
      key: rtcViewKey,
      isVideoTrackLive,
      isVideoTrackEnabled,
      isVideoTrackMuted,
      streamId: localStream.id,
      isFrontCamera,
      usingStreamProp: Platform.OS === 'android'
    });

    // КРИТИЧНО: На Android используем prop `stream` напрямую, на iOS - `streamURL`
    // На iOS проверяем, что streamURL существует
    if (Platform.OS === 'ios' && (!localStreamURL || localStreamURL.length === 0)) {
      logger.warn('[LocalVideo] ⚠️ На iOS нет streamURL или он пустой', { 
        streamId: localStream?.id,
        hasToURL: typeof localStream.toURL === 'function',
        streamURL: localStreamURL
      });
      return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
    }
    
    const rtcViewProps = Platform.OS === 'android' 
      ? { 
          stream: localStream, 
          streamURL: localStreamURL, 
          // На legacy Android (8.1/API27) у некоторых устройств (в т.ч. OPPO) Surface/overlay ломается при HW-texture.
          renderToHardwareTextureAndroid: !isLegacyAndroidSurface,
          // Важно: не используем overlay-слои для SurfaceView, иначе он может перекрывать RN-кнопки.
          zOrderMediaOverlay: false,
          // prop может отсутствовать в типах, но поддерживается нативно в webrtc-view на Android.
          useTextureView: useTextureViewOnAndroid,
        } // Android: пробрасываем оба
      : { streamURL: localStreamURL! }; // iOS: используем streamURL (уже проверили выше)

    return (
      <RTCView
        key={rtcViewKey}
        {...(rtcViewProps as any)}
        style={styles.rtc}
        objectFit="cover"
        mirror={isFrontCamera}
        // Не поднимаем Surface "наверх": на старых Android это прячет RN-кнопки.
        zOrder={0}
      />
    );
  }

  // Если camOn=true, но трек ещё не готов/не рендерится — показываем черный экран (как "идет восстановление"),
  // а не заглушку "Вы". Заглушка должна означать именно camOff по UI.

  // Если стрим есть, но трек еще не ready/замьючен - показываем черный экран
  return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
};

const styles = StyleSheet.create({
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'black',
  },
  placeholderContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(13,14,16,0.85)',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
});
