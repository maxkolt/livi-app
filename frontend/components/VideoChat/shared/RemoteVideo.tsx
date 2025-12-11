import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { RTCView, MediaStream } from 'react-native-webrtc';
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
}) => {
  const L = (key: string) => t(key, lang);

  // Берём актуальный стрим: сначала из пропсов, затем из session (fallback)
  const streamToUse = useMemo(() => {
    const stream = remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined) || null;
    if (stream) {
      const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
      logger.info('[RemoteVideo] streamToUse обновлен', {
        platform: Platform.OS,
        streamId: stream.id,
        hasVideoTrack: !!videoTrack,
        videoTrackReady: videoTrack?.readyState === 'live',
        videoTrackEnabled: videoTrack?.enabled,
        hasStreamURL: typeof stream.toURL === 'function'
      });
    }
    return stream;
  }, [remoteStream, session, remoteViewKey]);


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
        setForceUpdateKey(prev => prev + 1);
        logger.info('[RemoteVideo] Android: force-update RTCView', {
          streamId: streamToUse.id,
          trackId: videoTrack.id,
          trackEnabled: videoTrack.enabled,
          key: forceUpdateKey + 1
        });
      }
    }
  }, [streamToUse?.id, remoteViewKey, streamToUse]);

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
  if (wasFriendCallEnded || isInactiveState) {
    return (
      <View style={[styles.rtc, styles.placeholderContainer]}>
        <Text style={styles.placeholder}>{L('peer')}</Text>
      </View>
    );
  }

  // Нет стрима — показываем лоадер при загрузке или чёрный экран
  if (!streamToUse) {
    if (loading) {
      return <ActivityIndicator size="large" color="#fff" />;
    }
    return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
  }

  const videoTrack = (streamToUse as any)?.getVideoTracks?.()?.[0] || null;
  const hasVideoTrack = !!videoTrack;
  const videoTrackReady = !!videoTrack && videoTrack.readyState === 'live';
  const videoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true);
  const hasRenderableVideo = !!videoTrack && videoTrackReady && videoTrackEnabled;

  // КРИТИЧНО: Показываем видео если есть готовый трек, даже если remoteCamOn еще не обновлен
  // remoteCamOn может обновиться позже через onRemoteCamStateChange
  if (hasRenderableVideo) {
    // КРИТИЧНО: На Android используем prop `stream` напрямую вместо `streamURL`
    // Это более надежный способ для react-native-webrtc на Android
    const streamURL = streamToUse.toURL?.();
    const rtcViewKey = Platform.OS === 'android' 
      ? `remote-${streamToUse.id}-${remoteViewKey}-${forceUpdateKey}`
      : `remote-${streamToUse.id}-${remoteViewKey}`;
    
    logger.info('[RemoteVideo] ✅ Рендерим RTCView', {
      platform: Platform.OS,
      streamURL: streamURL ? streamURL.substring(0, 50) + '...' : 'null',
      key: rtcViewKey,
      hasVideoTrack,
      videoTrackReady,
      videoTrackEnabled,
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
      return <ActivityIndicator size="large" color="#fff" />;
    }
    
    const rtcViewProps = Platform.OS === 'android' 
      ? { stream: streamToUse } // Android: используем stream напрямую
      : { streamURL: streamURL! }; // iOS: используем streamURL (уже проверили выше)
    
    // КРИТИЧНО: На Android RTCView должен быть прямым потомком View без лишних оберток
    return (
      <View style={styles.videoContainer}>
        <RTCView
          key={rtcViewKey}
          {...rtcViewProps}
          style={styles.rtc}
          objectFit="cover"
          mirror={false}
          zOrder={1}
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
  if (!remoteCamOn && !hasRenderableVideo) {
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

  // Стрим есть, но видеотрек не готов — показываем лоадер
  if (streamToUse && hasVideoTrack) {
    return <ActivityIndicator size="large" color="#fff" />;
  }

  // Fallback
  return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
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
}); 
