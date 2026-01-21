import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { RTCView, MediaStream } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import AwayPlaceholder from '../../../components/AwayPlaceholder';
import { t, type Lang } from '../../../utils/i18n';
import { logger } from '../../../utils/logger';

interface RemoteVideoProps {
  remoteStream: MediaStream | null;
  remoteCamOn: boolean;
  remoteMuted: boolean;
  isInactiveState: boolean;
  wasFriendCallEnded: boolean;
  started: boolean;
  loading: boolean;
  remoteViewKey: number;
  showFriendBadge: boolean;
  lang: Lang;
  session?: any; // VideoCallSession
  onStreamReady?: (stream: MediaStream) => void;
  remoteStreamReceivedAt?: number | null; // Время получения remoteStream для предотвращения мерцания
  partnerInPiP?: boolean; // Партнер в режиме PiP
}

/**
 * Упрощенный компонент отображения удаленного видео.
 * Доверяем контролю стрима/камеры сессии, не дублируем force-update циклы.
 */
export const RemoteVideo: React.FC<RemoteVideoProps> = ({
  remoteStream,
  remoteCamOn,
  remoteMuted,
  isInactiveState,
  wasFriendCallEnded,
  started,
  loading,
  remoteViewKey,
  showFriendBadge,
  lang,
  session,
  onStreamReady,
  remoteStreamReceivedAt,
  partnerInPiP = false,
}) => {
  const L = (key: string) => t(key, lang);
  // На Android 8.1 и старше (API <= 27) SurfaceView overlay/z-order часто ломает отображение (особенно на OPPO/ColorOS).
  // Для таких устройств отключаем zOrderMediaOverlay, чтобы Surface корректно композировался в окне.
  const isLegacyAndroidSurface = Platform.OS === 'android' && Number(Platform.Version) <= 27;
  // На старых Android используем TextureView, чтобы RN-оверлеи (кнопки) гарантированно рисовались поверх видео.
  const useTextureViewOnAndroid = Platform.OS === 'android' && isLegacyAndroidSurface;
  const logRenderState = useCallback(
    (reason: string, extra?: Record<string, unknown>) => {
      logger.info('[RemoteVideo] Render state', { reason, ...extra });
    },
    []
  );

  // КРИТИЧНО: Логируем значение partnerInPiP при каждом рендере для отладки
  useEffect(() => {
    logger.info('[RemoteVideo] partnerInPiP prop changed', { 
      partnerInPiP,
      hasStream: !!remoteStream,
      remoteCamOn,
      started,
      loading,
      willShowAwayPlaceholder: partnerInPiP === true
    });
  }, [partnerInPiP, remoteStream, remoteCamOn, started, loading]);
  
  // КРИТИЧНО: Логируем каждый рендер для отладки отображения заглушки
  useEffect(() => {
    if (partnerInPiP) {
      logger.info('[RemoteVideo] 🔴 partnerInPiP=true - заглушка "Отошел" ДОЛЖНА быть видна', {
        partnerInPiP,
        hasStream: !!remoteStream,
        streamId: remoteStream?.id,
        remoteCamOn,
        started,
        loading,
        isInactiveState,
        wasFriendCallEnded
      });
    }
  }, [partnerInPiP, remoteStream, remoteCamOn, started, loading, isInactiveState, wasFriendCallEnded]);

  // Берём актуальный стрим только из пропсов.
  // Fallback на session часто приводит к рендеру "старого" MediaStream после next/переподключений.
  const streamToUse = useMemo(() => {
    const stream = remoteStream || null;
    if (stream) {
      const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
      logger.debug('[RemoteVideo] streamToUse обновлен', {
        platform: Platform.OS,
        streamId: stream.id,
        hasVideoTrack: !!videoTrack,
        videoTrackReady: videoTrack?.readyState === 'live',
        videoTrackEnabled: videoTrack?.enabled,
        hasStreamURL: typeof stream.toURL === 'function'
      });
    }
    return stream;
  }, [remoteStream, remoteViewKey]);


  // Сообщаем о готовности стрима
  useEffect(() => {
    if (streamToUse && onStreamReady) {
      onStreamReady(streamToUse);
    }
  }, [streamToUse, onStreamReady]);

  // КРИТИЧНО: На Android нужен force-update для RTCView при изменении стрима
  const [forceUpdateKey, setForceUpdateKey] = useState(0);
  
  useEffect(() => {
    if (Platform.OS === 'android' && streamToUse) {
      const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0];
      // На Android используем stream prop, поэтому проверяем только наличие трека
      if (videoTrack && videoTrack.readyState === 'live') {
        setForceUpdateKey((prev) => {
          const next = prev + 1;
          logger.info('[RemoteVideo] Android: force-update RTCView', {
            streamId: streamToUse.id,
            trackId: videoTrack.id,
            trackEnabled: videoTrack.enabled,
            key: next,
          });
          return next;
        });
      }
    }
  }, [streamToUse?.id, remoteViewKey]);

  // Управление аудио треками под mute/unmute
  useEffect(() => {
    if (!streamToUse) return;
    const audioTracks = (streamToUse as any)?.getAudioTracks?.() || [];
    audioTracks.forEach((track: any, index: number) => {
      if (!track) return;
      if (!remoteMuted && !track.enabled) {
        track.enabled = true;
        logger.info('[RemoteVideo] Включаем аудио трек', { trackId: track.id, index, streamId: streamToUse.id });
      } else if (remoteMuted && track.enabled) {
        track.enabled = false;
        logger.info('[RemoteVideo] Отключаем аудио трек (muted)', { trackId: track.id, index, streamId: streamToUse.id });
      }
    });
  }, [streamToUse, remoteMuted]);

  // Неактивное состояние звонка - показываем надпись "Собеседник" как в эталонном файле
  // КРИТИЧНО: Завершение звонка имеет приоритет над заглушкой "Отошел".
  if (wasFriendCallEnded || isInactiveState) {
    logRenderState('inactive-call', { remoteCamOn, wasFriendCallEnded, started });
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('peer')}</Text>
      </View>
    );
  }

  // КРИТИЧНО: Если партнер в PiP, показываем заглушку "Отошел"
  // Это гарантирует, что заглушка покажется в любом случае, даже если нет стрима или он еще загружается
  // Заглушка должна показываться автоматически при уходе партнера в PiP и исчезать при возврате
  if (partnerInPiP) {
    logger.info('[RemoteVideo] 🔴 ПОКАЗЫВАЕМ ЗАГЛУШКУ "Отошел" - partnerInPiP=true', {
      partnerInPiP,
      streamId: streamToUse?.id,
      hasStream: !!streamToUse,
      remoteCamOn,
      started,
      loading,
      isInactiveState,
      wasFriendCallEnded
    });
    logRenderState('partner-in-pip', {
      streamId: streamToUse?.id,
      partnerInPiP: true,
      hasStream: !!streamToUse,
    });
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Нет стрима — показываем лоадер при загрузке или если звонок активен (started)
  // КРИТИЧНО: При активном звонке (started=true) показываем ActivityIndicator вместо черного экрана
  // Это предотвращает черный экран при принятии звонка, когда remoteStream еще не установлен
  // КРИТИЧНО: Показываем бейдж друга даже когда нет стрима (для инициатора звонка)
  if (!streamToUse) {
    if (loading || started) {
      logRenderState('no-stream-loading', { loading, started });
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    logRenderState('no-stream-idle');
    return (
      <View style={styles.videoContainer}>
        <View style={[styles.rtc, { backgroundColor: 'black' }]} />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0] || null;
  const hasVideoTrack = !!videoTrack;
  const videoTrackReady = !!videoTrack && videoTrack.readyState === 'live';
  const videoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true);
  const videoTrackMuted = !!videoTrack && (videoTrack.muted ?? false);
  const hasRenderableVideo = !!videoTrack && videoTrackReady && videoTrackEnabled && !videoTrackMuted;

  // КРИТИЧНО: Если партнер вернулся из PiP (remoteCamOn=true, partnerInPiP=false),
  // показываем видео даже если трек временно не готов - LiveKit восстановит его
  const isReturningFromPiP = remoteCamOn && !partnerInPiP && hasVideoTrack;
  
  // Логируем состояние для отладки восстановления видео
  if (isReturningFromPiP) {
    logger.info('[RemoteVideo] 🔄 Партнер вернулся из PiP - показываем видео для восстановления', {
      remoteCamOn,
      partnerInPiP,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      hasRenderableVideo,
      streamId: streamToUse?.id,
    });
  }
  
  // КРИТИЧНО: Показываем видео если есть готовый трек, даже если remoteCamOn еще не обновлен
  // remoteCamOn может обновиться позже через onRemoteCamStateChange
  // НО: НЕ показываем видео если партнер в PiP (это уже проверено выше, но для безопасности)
  // ИЛИ: Показываем видео если партнер вернулся из PiP (даже если трек временно не готов)
  if ((hasRenderableVideo || isReturningFromPiP) && !partnerInPiP) {
    // КРИТИЧНО: На Android используем prop `stream` напрямую вместо `streamURL`
    // Это более надежный способ для @livekit/react-native-webrtc на Android, но дублируем streamURL как fallback
    const streamURL = streamToUse.toURL?.();
    const rtcViewKey = Platform.OS === 'android' 
      ? `remote-${streamToUse.id}-${remoteViewKey}-${forceUpdateKey}`
      : `remote-${streamToUse.id}-${remoteViewKey}`;
    
    logRenderState('render-video', {
      platform: Platform.OS,
      streamURL: streamURL ? streamURL.substring(0, 50) + '...' : 'null',
      key: rtcViewKey,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
      streamId: streamToUse.id,
      usingStreamProp: Platform.OS === 'android'
    });
    
    // КРИТИЧНО: На Android используем prop `stream` напрямую, на iOS - `streamURL`
    // На iOS проверяем, что streamURL существует
    if (Platform.OS === 'ios' && (!streamURL || streamURL.length === 0)) {
      logger.warn('[RemoteVideo] ⚠️ На iOS нет streamURL или он пустой', { 
        streamId: streamToUse?.id,
        hasToURL: typeof streamToUse.toURL === 'function',
        streamURL: streamURL
      });
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
        </View>
      );
    }
    
    // На Android пробрасываем и stream, и streamURL (некоторые сборки webrtc требуют streamURL)
    const rtcViewProps = Platform.OS === 'android' 
      ? { 
          stream: streamToUse, 
          streamURL, 
          // На legacy Android (8.1/API27) у некоторых устройств Surface/HW-texture даёт "черный экран".
          renderToHardwareTextureAndroid: !isLegacyAndroidSurface,
          // Удаленное видео - фон. Не используем overlay, чтобы не перекрывать локальное превью.
          zOrderMediaOverlay: false,
          // prop может отсутствовать в типах, но поддерживается нативно в webrtc-view на Android.
          useTextureView: useTextureViewOnAndroid,
        }
      : { streamURL: streamURL! }; // iOS: используем streamURL (уже проверили выше)
    
    // КРИТИЧНО: На Android RTCView должен быть прямым потомком View без лишних оберток
    return (
      <View style={styles.videoContainer}>
        <RTCView
          key={rtcViewKey}
          {...(rtcViewProps as any)}
          style={styles.rtc}
          objectFit="cover"
          mirror={false}
          // Удаленное видео - базовый слой
          zOrder={0}
        />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Камера явно выключена И нет готового трека — показываем заглушку "Отошёл"
  // КРИТИЧНО: Если стрим только что получен (менее 2000ms назад), показываем ActivityIndicator
  // вместо AwayPlaceholder, чтобы дать треку время стать готовым и избежать мерцания
  // НО: НЕ показываем заглушку если партнер в PiP (это уже обработано выше)
  if (!remoteCamOn && !hasRenderableVideo && !partnerInPiP) {
    const isRecentlyReceived = remoteStreamReceivedAt && (Date.now() - remoteStreamReceivedAt) < 2000;
    
    if (isRecentlyReceived) {
      // Стрим только что получен - показываем загрузку вместо заглушки
      logRenderState('remote-cam-off-recently-received', {
        streamId: streamToUse.id,
        hasVideoTrack,
        videoTrackReady,
        videoTrackEnabled,
        videoTrackMuted,
        timeSinceReceived: Date.now() - (remoteStreamReceivedAt || 0),
      });
      return (
        <View style={styles.videoContainer}>
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#fff" />
          </View>
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    }
    
    logRenderState('remote-cam-off', {
      streamId: streamToUse.id,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
    });
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Стрим есть, но видеотрек не готов/замьючен — показываем лоадер (камера не "явно выключена")
  if (streamToUse && hasVideoTrack && !partnerInPiP && !isReturningFromPiP) {
    // Обычный случай: видеотрек не готов/замьючен - показываем лоадер
    logRenderState('video-track-not-renderable', {
      streamId: streamToUse.id,
      videoTrackReady,
      videoTrackEnabled,
      videoTrackMuted,
    });
    return (
      <View style={styles.videoContainer}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#fff" />
        </View>
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Нет видеотрека (например, только аудио) — показываем заглушку, если камера "выключена" по состоянию
  if (!remoteCamOn) {
    return (
      <View style={styles.videoContainer}>
        <AwayPlaceholder />
        {showFriendBadge && (
          <View style={styles.friendBadge}>
            <MaterialIcons name="check-circle" size={16} color="#0f0" />
            <Text style={styles.friendBadgeText}>{L('friend')}</Text>
          </View>
        )}
      </View>
    );
  }

  // Fallback (стрим есть, но видео не появилось)
  // КРИТИЧНО: Показываем бейдж друга даже когда нет стрима (для инициатора звонка)
  return (
    <View style={styles.videoContainer}>
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
      {showFriendBadge && (
        <View style={styles.friendBadge}>
          <MaterialIcons name="check-circle" size={16} color="#0f0" />
          <Text style={styles.friendBadgeText}>{L('friend')}</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  videoContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    overflow: 'visible',
    zIndex: 0,
  },
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    height: '100%',
    backgroundColor: 'black',
  },
  friendBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,255,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,255,0,0.3)',
  },
  friendBadgeText: {
    color: '#0f0',
    fontSize: 12,
    fontWeight: '600',
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
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'black',
  },
}); 
