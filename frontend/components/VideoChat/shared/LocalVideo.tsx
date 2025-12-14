import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { RTCView, MediaStream } from '@livekit/react-native-webrtc';
import { isValidStream } from '../../../utils/streamUtils';
import { t, type Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

interface LocalVideoProps {
  localStream: MediaStream | null;
  camOn: boolean;
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
  isInactiveState,
  wasFriendCallEnded,
  started,
  localRenderKey,
  lang,
  onStreamReady,
}) => {
  const L = (key: string) => t(key, lang);

  // КРИТИЧНО: Все хуки должны быть вызваны ДО любых условных return
  // Проверяем готовность стрима
  const hasLocalStream = localStream && isValidStream(localStream);
  const videoTrack = hasLocalStream ? (localStream as any)?.getVideoTracks?.()?.[0] : null;
  const isVideoTrackLive = !!videoTrack && videoTrack.readyState === 'live';
  const isVideoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true) === true;
  const isVideoTrackMuted = !!videoTrack && (videoTrack.muted ?? false) === true;
  const canRenderVideo = isVideoTrackLive && isVideoTrackEnabled && !isVideoTrackMuted;
  
  // Логирование для отладки на Android
  useEffect(() => {
    if (Platform.OS === 'android' && localStream) {
      logger.info('[LocalVideo] Local stream state', {
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

  // КРИТИЧНО: На Android нужен force-update для RTCView при изменении стрима
  const [forceUpdateKey, setForceUpdateKey] = useState(0);
  
  useEffect(() => {
    if (Platform.OS === 'android' && localStream && isValidStream(localStream)) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      // На Android используем stream prop, поэтому проверяем только наличие трека
      if (videoTrack && videoTrack.readyState === 'live') {
        setForceUpdateKey((prev) => {
          const next = prev + 1;
          logger.info('[LocalVideo] Android: force-update RTCView', {
            streamId: localStream.id,
            trackId: videoTrack.id,
            trackEnabled: videoTrack.enabled,
            trackMuted: videoTrack.muted,
            key: next,
          });
          return next;
        });
      }
    }
  }, [localStream?.id, localRenderKey]);

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

  // КРИТИЧНО: Показываем видео если есть готовый трек, даже если camOn еще не обновлен
  // camOn может обновиться позже через onCamStateChange
  if (hasLocalStream && canRenderVideo) {
    // КРИТИЧНО: На Android используем prop `stream` напрямую вместо `streamURL`
    // Это более надежный способ для @livekit/react-native-webrtc на Android, но добавляем streamURL как fallback
    const localStreamURL = localStream.toURL?.();
    const rtcViewKey = Platform.OS === 'android'
      ? `local-video-${localStream.id}-${localRenderKey}-${forceUpdateKey}`
      : `local-video-${localStream.id}-${localRenderKey}`;
    
    logger.info('[LocalVideo] ✅ Рендерим RTCView', {
      platform: Platform.OS,
      streamURL: localStreamURL ? localStreamURL.substring(0, 50) + '...' : 'null',
      key: rtcViewKey,
      isVideoTrackLive,
      isVideoTrackEnabled,
      isVideoTrackMuted,
      streamId: localStream.id,
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
          renderToHardwareTextureAndroid: true, 
          zOrderMediaOverlay: true 
        } // Android: пробрасываем оба и форсим рендер на GPU
      : { streamURL: localStreamURL! }; // iOS: используем streamURL (уже проверили выше)

    return (
      <RTCView
        key={rtcViewKey}
        {...rtcViewProps}
        style={styles.rtc}
        objectFit="cover"
        mirror
        zOrder={0}
      />
    );
  }

  // Камера явно выключена И нет готового трека — показываем заглушку "Вы"
  if (!camOn && !canRenderVideo) {
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('you')}</Text>
      </View>
    );
  }

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
