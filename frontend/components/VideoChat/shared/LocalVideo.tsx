import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { RTCView, MediaStream } from 'react-native-webrtc';
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
  const isVideoTrackActive = videoTrack && videoTrack.readyState === 'live';

  // Уведомляем о готовности стрима
  useEffect(() => {
    if (localStream && isValidStream(localStream) && onStreamReady) {
      onStreamReady(localStream);
    }
  }, [localStream, onStreamReady]);

  // Если камера выключена, но трек активен, проверяем и включаем камеру
  useEffect(() => {
    if (!camOn && isVideoTrackActive && started && hasLocalStream && localStream) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      if (videoTrack && !videoTrack.enabled) {
        videoTrack.enabled = true;
        logger.info('[LocalVideo] Камера включена для отображения локального видео');
      }
    }
  }, [camOn, isVideoTrackActive, started, hasLocalStream, localStream]);

  // После завершения звонка показываем черный экран
  if (isInactiveState || wasFriendCallEnded) {
    return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
  }

  // КРИТИЧНО: Если камера выключена (camOn === false), показываем заглушку "Вы"
  if (!camOn) {
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('you')}</Text>
      </View>
    );
  }

  // Показываем видео если есть стрим и трек live
  if (hasLocalStream && isVideoTrackActive) {
    const localStreamURL = localStream.toURL?.();
    if (!localStreamURL) {
      logger.warn('[LocalVideo] Local stream URL is null, cannot show video', {
        streamId: localStream.id,
        hasToURL: typeof localStream.toURL === 'function',
        hasVideoTrack: !!(localStream as any)?.getVideoTracks?.()?.[0]
      });
      return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
    }

    logger.info('[LocalVideo] ✅ Showing local video', {
      streamId: localStream.id,
      localRenderKey,
      streamURL: localStreamURL.substring(0, 50) + '...',
      hasStreamURL: !!localStreamURL
    });

    return (
      <RTCView
        key={`local-video-${localRenderKey}`}
        streamURL={localStreamURL}
        style={styles.rtc}
        objectFit="cover"
        mirror
        zOrder={0}
      />
    );
  }

  // Если нет стрима или трек не live - показываем черный экран
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
