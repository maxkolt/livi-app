import React, { useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
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
  const streamToUse = useMemo(
    () => remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined) || null,
    [remoteStream, session]
  );

  // Сообщаем о готовности стрима
  useEffect(() => {
    if (streamToUse && onStreamReady) {
      onStreamReady(streamToUse);
    }
  }, [streamToUse, onStreamReady]);

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

  // Неактивное состояние звонка
  if (wasFriendCallEnded || isInactiveState) {
    return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
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

  // Камера собеседника выключена — показываем заглушку
  if (!remoteCamOn && hasVideoTrack) {
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

  // Камера включена и есть видеотрек — рендерим RTCView
  if (remoteCamOn && hasVideoTrack) {
    const streamURL = streamToUse.toURL?.();
    if (streamURL) {
      const rtcViewKey = `remote-${streamToUse.id}-${remoteViewKey}-${videoTrack?.id || 'novideo'}`;
      return (
        <View style={styles.videoContainer}>
          <RTCView
            key={rtcViewKey}
            streamURL={streamURL}
            style={styles.rtc}
            objectFit="cover"
            mirror={false}
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
    return <ActivityIndicator size="large" color="#fff" />;
  }

  // Стрим есть, но видеотрек не готов — показываем лоадер
  if (streamToUse && !hasVideoTrack) {
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
    overflow: 'hidden',
    zIndex: 1,
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
});

