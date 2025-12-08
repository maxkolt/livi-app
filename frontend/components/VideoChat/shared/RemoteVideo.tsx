import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { RTCView, MediaStream } from 'react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import AwayPlaceholder from '../../AwayPlaceholder';
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
 * Компонент для отображения удаленного видео
 * Обрабатывает логику отображения удаленного видео, заглушки "Собеседник",
 * анимации исчезновения, реакцию на remoteCamOn, remoteMuted
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

  // КРИТИЧНО: ВСЕ хуки должны быть объявлены ДО любых условных возвратов
  // Это правило React Hooks - все хуки должны вызываться в одном порядке при каждом рендере
  
  // КРИТИЧНО: Используем actualRemoteStream (prop или session) для получения стрима
  const actualRemoteStreamForReady = remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined);
  const actualRemoteStreamForUpdate = remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined);
  const actualRemoteStreamForAudio = remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined);
  const actualRemoteStream = remoteStream || (session?.getRemoteStream?.() as MediaStream | null | undefined);
  const streamToUse = actualRemoteStream;
  
  const [forceUpdate, setForceUpdate] = React.useState(0);
  
  // Уведомляем о готовности стрима
  React.useEffect(() => {
    if (actualRemoteStreamForReady && onStreamReady) {
      onStreamReady(actualRemoteStreamForReady);
    }
  }, [actualRemoteStreamForReady, onStreamReady]);
  
  // КРИТИЧНО: Принудительное обновление компонента при изменении стрима
  // Это гарантирует, что компонент обновится при получении нового стрима или видеотрека
  React.useEffect(() => {
    if (actualRemoteStreamForUpdate) {
      const videoTrack = (actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0];
      const videoTrackId = videoTrack?.id;
      const streamId = actualRemoteStreamForUpdate.id;
      
      logger.info('[RemoteVideo] Принудительное обновление при изменении стрима', {
        streamId,
        videoTrackId,
        hasVideoTrack: !!videoTrack,
        remoteViewKey
      });
      
      // КРИТИЧНО: Принудительно обновляем компонент при любом изменении стрима
      setForceUpdate(prev => prev + 1);
    }
  }, [actualRemoteStreamForUpdate?.id, actualRemoteStreamForUpdate]);
  
  // КРИТИЧНО: Принудительное обновление при изменении видеотрека
  // Отслеживаем изменения ID видеотрека для немедленного обновления
  React.useEffect(() => {
    if (actualRemoteStreamForUpdate) {
      const videoTrack = (actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0];
      if (videoTrack) {
        const videoTrackId = videoTrack.id;
        const videoTrackReadyState = videoTrack.readyState;
        const videoTrackEnabled = videoTrack.enabled;
        
        logger.info('[RemoteVideo] Принудительное обновление при изменении видеотрека', {
          videoTrackId,
          videoTrackReadyState,
          videoTrackEnabled,
          streamId: actualRemoteStreamForUpdate.id
        });
        
        // КРИТИЧНО: Принудительно обновляем компонент при изменении видеотрека
        setForceUpdate(prev => prev + 1);
      }
    }
  }, [
    actualRemoteStreamForUpdate ? ((actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0]?.id) : null,
    actualRemoteStreamForUpdate ? ((actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0]?.readyState) : null,
    actualRemoteStreamForUpdate ? ((actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0]?.enabled) : null
  ]);
  
  // КРИТИЧНО: Принудительное обновление при изменении remoteViewKey
  // Это гарантирует обновление компонента при изменении ключа просмотра
  React.useEffect(() => {
    if (actualRemoteStreamForUpdate) {
      logger.info('[RemoteVideo] Принудительное обновление при изменении remoteViewKey', {
        remoteViewKey,
        streamId: actualRemoteStreamForUpdate.id
      });
      
      // КРИТИЧНО: Принудительно обновляем компонент при изменении remoteViewKey
      setForceUpdate(prev => prev + 1);
    }
  }, [remoteViewKey, actualRemoteStreamForUpdate?.id]);
  
  // КРИТИЧНО: Принудительное обновление при изменении remoteStream prop напрямую
  // Это гарантирует обновление при получении нового стрима через props
  React.useEffect(() => {
    if (remoteStream) {
      const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
      logger.info('[RemoteVideo] Принудительное обновление при изменении remoteStream prop', {
        streamId: remoteStream.id,
        hasVideoTrack: !!videoTrack,
        videoTrackId: videoTrack?.id,
        remoteViewKey
      });
      
      // КРИТИЧНО: Принудительно обновляем компонент при изменении remoteStream prop
      setForceUpdate(prev => prev + 1);
    }
  }, [remoteStream?.id, remoteStream]);
  
  // КРИТИЧНО: Отслеживаем изменения видеотрека и его состояния
  // Это решает проблему, когда трек появляется, но readyState еще не 'live'
  // Используем fallback механизм для периодической проверки появления трека
  React.useEffect(() => {
    if (actualRemoteStreamForUpdate) {
      let checkForTrackInterval: ReturnType<typeof setInterval> | null = null;
      let checkTrackStateInterval: ReturnType<typeof setInterval> | null = null;
      let trackStateTimeout: ReturnType<typeof setTimeout> | null = null;
      
      const checkVideoTrack = () => {
        const videoTrack = (actualRemoteStreamForUpdate as any)?.getVideoTracks?.()?.[0];
        const videoTrackReadyState = videoTrack?.readyState;
        const videoTrackId = videoTrack?.id;
        const videoTrackEnabled = videoTrack?.enabled;
        
        logger.info('[RemoteVideo] Проверка видеотрека', {
          streamId: actualRemoteStreamForUpdate.id,
          remoteViewKey,
          forceUpdate,
          hasVideoTrack: !!videoTrack,
          videoTrackId,
          videoTrackReadyState,
          videoTrackEnabled,
          hasPropStream: !!remoteStream,
          hasSessionStream: !!session?.getRemoteStream?.()
        });
        
        return { videoTrack, videoTrackReadyState, videoTrackId, videoTrackEnabled };
      };
      
      // Первоначальная проверка
      const initialCheck = checkVideoTrack();
      
      // КРИТИЧНО: Обновляем компонент при любом изменении трека
      // НЕ требуем readyState === 'live' - показываем видео сразу, как только трек появляется
      // Это решает проблему, когда трек есть, но еще не 'live'
      setForceUpdate(prev => prev + 1);
      
      // КРИТИЧНО: Если трека еще нет, проверяем периодически его появление
      // Это решает проблему, когда стрим есть, но видеотрек еще не добавлен
      if (!initialCheck.videoTrack) {
        logger.info('[RemoteVideo] Видеотрек отсутствует, запускаем периодическую проверку', {
          streamId: actualRemoteStreamForUpdate.id
        });
        
        let checkCount = 0;
        const maxChecks = 50; // Максимум 50 проверок (5 секунд при интервале 100ms)
        
        checkForTrackInterval = setInterval(() => {
          checkCount++;
          const currentCheck = checkVideoTrack();
          
          if (currentCheck.videoTrack) {
            logger.info('[RemoteVideo] ✅ Видеотрек появился в стриме, принудительно обновляем', {
              trackId: currentCheck.videoTrackId,
              readyState: currentCheck.videoTrackReadyState,
              checkCount,
              streamId: actualRemoteStreamForUpdate.id
            });
            setForceUpdate(prev => prev + 1);
            
            // Очищаем интервал проверки появления трека
            if (checkForTrackInterval) {
              clearInterval(checkForTrackInterval);
              checkForTrackInterval = null;
            }
            
            // Запускаем проверку состояния трека
            startTrackStateCheck(currentCheck.videoTrack, currentCheck.videoTrackId, currentCheck.videoTrackReadyState);
          } else if (checkCount >= maxChecks) {
            logger.warn('[RemoteVideo] Видеотрек не появился после максимального количества проверок', {
              checkCount,
              streamId: actualRemoteStreamForUpdate.id
            });
            if (checkForTrackInterval) {
              clearInterval(checkForTrackInterval);
              checkForTrackInterval = null;
            }
          }
        }, 100); // Проверяем каждые 100ms
        
        // Останавливаем проверку через 5 секунд, чтобы не проверять бесконечно
        trackStateTimeout = setTimeout(() => {
          if (checkForTrackInterval) {
            logger.info('[RemoteVideo] Останавливаем проверку появления трека по таймауту', {
              streamId: actualRemoteStreamForUpdate.id
            });
            clearInterval(checkForTrackInterval);
            checkForTrackInterval = null;
          }
        }, 5000);
      } else {
        // Если трек уже есть, запускаем проверку его состояния
        startTrackStateCheck(initialCheck.videoTrack, initialCheck.videoTrackId, initialCheck.videoTrackReadyState);
      }
      
      // Функция для проверки состояния трека
      function startTrackStateCheck(videoTrack: any, videoTrackId: string | undefined, initialReadyState: string | undefined) {
        if (!videoTrack) return;
        
        let lastReadyState = initialReadyState;
        let lastEnabled = videoTrack?.enabled;
        
        // КРИТИЧНО: Подписываемся на события изменения трека
        // Это гарантирует перерисовку, когда трек становится 'live'
        const handleTrackStateChange = () => {
          const currentState = videoTrack.readyState;
          const currentEnabled = videoTrack.enabled;
          
          logger.info('[RemoteVideo] Видеотрек изменил состояние (событие), принудительно обновляем', {
            trackId: videoTrackId,
            readyState: currentState,
            previousState: lastReadyState,
            enabled: currentEnabled,
            previousEnabled: lastEnabled
          });
          
          lastReadyState = currentState;
          lastEnabled = currentEnabled;
          setForceUpdate(prev => prev + 1);
        };
        
        // Подписываемся на события трека (если доступны)
        if (videoTrack.addEventListener) {
          try {
            videoTrack.addEventListener('ended', handleTrackStateChange);
            videoTrack.addEventListener('mute', handleTrackStateChange);
            videoTrack.addEventListener('unmute', handleTrackStateChange);
            // Некоторые реализации могут поддерживать 'started' или 'live'
            if (typeof (videoTrack as any).addEventListener === 'function') {
              try {
                (videoTrack as any).addEventListener('started', handleTrackStateChange);
              } catch {}
            }
          } catch (e) {
            logger.warn('[RemoteVideo] Ошибка при подписке на события трека:', e);
          }
        }
        
        // КРИТИЧНО: Также проверяем периодически (fallback для случаев, когда события не работают)
        // Это особенно важно, если readyState еще не 'live'
        checkTrackStateInterval = setInterval(() => {
          const currentState = videoTrack.readyState;
          const currentEnabled = videoTrack.enabled;
          
          // Обновляем, если изменилось состояние или enabled
          if (currentState !== lastReadyState || currentEnabled !== lastEnabled) {
            logger.info('[RemoteVideo] Видеотрек изменил состояние (периодическая проверка), принудительно обновляем', {
              trackId: videoTrackId,
              readyState: currentState,
              previousState: lastReadyState,
              enabled: currentEnabled,
              previousEnabled: lastEnabled
            });
            
            lastReadyState = currentState;
            lastEnabled = currentEnabled;
            setForceUpdate(prev => prev + 1);
          }
          
          // КРИТИЧНО: Если трек стал 'live', обновляем компонент
          if (currentState === 'live' && lastReadyState !== 'live') {
            logger.info('[RemoteVideo] ✅ Видеотрек стал live, принудительно обновляем', {
              trackId: videoTrackId,
              readyState: currentState
            });
            setForceUpdate(prev => prev + 1);
          }
        }, 200); // Проверяем каждые 200ms
        
        // Останавливаем проверку состояния через 10 секунд после появления трека
        setTimeout(() => {
          if (checkTrackStateInterval) {
            logger.info('[RemoteVideo] Останавливаем проверку состояния трека по таймауту', {
              trackId: videoTrackId,
              finalReadyState: videoTrack.readyState
            });
            clearInterval(checkTrackStateInterval);
            checkTrackStateInterval = null;
          }
        }, 10000);
      }
      
      // Cleanup функция
      return () => {
        if (checkForTrackInterval) {
          clearInterval(checkForTrackInterval);
        }
        if (checkTrackStateInterval) {
          clearInterval(checkTrackStateInterval);
        }
        if (trackStateTimeout) {
          clearTimeout(trackStateTimeout);
        }
        // Очищаем слушатели событий, если трек был найден
        if (initialCheck.videoTrack && initialCheck.videoTrack.removeEventListener) {
          try {
            initialCheck.videoTrack.removeEventListener('ended', () => {});
            initialCheck.videoTrack.removeEventListener('mute', () => {});
            initialCheck.videoTrack.removeEventListener('unmute', () => {});
          } catch {}
        }
      };
    }
  }, [actualRemoteStreamForUpdate?.id, remoteViewKey, actualRemoteStreamForUpdate, remoteStream, session]);

  // КРИТИЧНО: Убеждаемся, что аудио трек включен для звука
  // Это должно быть на уровне компонента, не внутри условного блока
  React.useEffect(() => {
    if (actualRemoteStreamForAudio) {
      const audioTracks = (actualRemoteStreamForAudio as any)?.getAudioTracks?.() || [];
      logger.info('[RemoteVideo] Проверяем аудио треки', {
        streamId: actualRemoteStreamForAudio.id,
        audioTracksCount: audioTracks.length,
        remoteMuted,
        tracksEnabled: audioTracks.map((t: any) => ({ id: t?.id, enabled: t?.enabled, readyState: t?.readyState }))
      });
      
      audioTracks.forEach((track: any, index: number) => {
        if (track) {
          if (!remoteMuted && !track.enabled) {
            track.enabled = true;
            logger.info('[RemoteVideo] ✅ Аудио трек включен для звука', {
              trackId: track.id,
              trackIndex: index,
              streamId: actualRemoteStreamForAudio.id,
              remoteMuted,
              readyState: track.readyState
            });
          } else if (remoteMuted && track.enabled) {
            track.enabled = false;
            logger.info('[RemoteVideo] 🔇 Аудио трек выключен (muted)', {
              trackId: track.id,
              trackIndex: index,
              streamId: remoteStream.id
            });
          } else {
            logger.info('[RemoteVideo] Аудио трек уже в правильном состоянии', {
              trackId: track.id,
              trackIndex: index,
              enabled: track.enabled,
              remoteMuted,
              readyState: track.readyState
            });
          }
        }
      });
    }
  }, [actualRemoteStreamForAudio, remoteMuted]);

  // КРИТИЧНО: Форс-обновление при изменении streamToUse
  // Это гарантирует, что RTCView обновится, когда появится удалённый видеотрек
  React.useEffect(() => {
    if (streamToUse) {
      logger.info('[RemoteVideo] streamToUse изменился, форс-обновляем компонент', {
        streamId: streamToUse.id,
        hasVideoTracks: !!(streamToUse as any)?.getVideoTracks?.()?.[0]
      });
      setForceUpdate(v => v + 1);
    }
  }, [streamToUse?.id]);

  // ============================================================
  // КРИТИЧНО: ВСЕ хуки объявлены выше, теперь можно делать условные возвраты
  // ============================================================
  
  // МАКСИМАЛЬНО УПРОЩЕННАЯ ЛОГИКА: Показываем видео, если есть remoteStream
  // Для 1-на-1 звонков всегда показываем видео, если стрим есть

  // Если звонок завершен или неактивен - показываем черный экран
  if (wasFriendCallEnded || isInactiveState) {
    logger.info('[RemoteVideo] Звонок завершен или неактивен, показываем черный экран', {
      wasFriendCallEnded,
      isInactiveState
    });
    return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
  }

  // Получаем актуальное состояние видео трека
  const vt = streamToUse ? (streamToUse as any)?.getVideoTracks?.()?.[0] : null;
  const videoTrackReadyState = vt?.readyState ?? 'new';
  const hasVideoTrack = !!vt;
  const isTrackLive = videoTrackReadyState === 'live';
  const videoTrackEnabled = vt?.enabled ?? false;

  logger.info('[RemoteVideo] Состояние удаленного видео', {
    hasRemoteStream: !!streamToUse,
    hasPropStream: !!remoteStream,
    hasSessionStream: !!session?.getRemoteStream?.(),
    streamId: streamToUse?.id,
    hasVideoTrack,
    videoTrackReadyState,
    videoTrackEnabled,
    isTrackLive,
    remoteViewKey,
    started,
    loading
  });

  // Если нет стрима - показываем лоадер при загрузке, иначе черный экран
  // КРИТИЧНО: Не требуем started - если есть loading, показываем лоадер
  // КРИТИЧНО: Используем streamToUse, который уже определен выше
  if (!streamToUse) {
    if (loading) {
      logger.info('[RemoteVideo] Нет стрима, показываем лоадер', { 
        loading, 
        started,
        hasPropStream: !!remoteStream,
        hasSessionStream: !!session?.getRemoteStream?.()
      });
      return <ActivityIndicator size="large" color="#fff" />;
    }
    logger.info('[RemoteVideo] Нет стрима, показываем черный экран', { 
      loading, 
      started,
      hasPropStream: !!remoteStream,
      hasSessionStream: !!session?.getRemoteStream?.()
    });
    return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
  }

  // КРИТИЧНО: Для 1-на-1 звонков показываем видео, если есть стрим и видео трек
  // Не требуем, чтобы трек был 'live' - показываем сразу, как только есть трек
  if (hasVideoTrack) {
    const streamURL = streamToUse.toURL?.();
    
    logger.info('[RemoteVideo] Есть видео трек, проверяем streamURL', {
      streamId: streamToUse.id,
      hasStreamURL: !!streamURL,
      streamURL: streamURL ? streamURL.substring(0, 50) + '...' : null,
      videoTrackReadyState,
      videoTrackEnabled,
      remoteViewKey
    });

    if (streamURL) {
      // КРИТИЧНО: Формируем уникальный key для принудительного обновления RTCView
      // Используем stream.id, remoteViewKey и forceUpdate для гарантированного обновления
      const rtcViewKey = `remote-${streamToUse.id}-${remoteViewKey}-${forceUpdate}`;
      
      logger.info('[RemoteVideo] ✅ Показываем удаленное видео', {
        streamId: streamToUse.id,
        remoteViewKey,
        forceUpdate,
        rtcViewKey,
        streamURL: streamURL.substring(0, 50) + '...',
        videoTrackReadyState,
        videoTrackEnabled,
        hasStreamURL: !!streamURL
      });

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
          {/* Бейдж "Друг" */}
          {showFriendBadge && (
            <View style={styles.friendBadge}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
      );
    } else {
      logger.warn('[RemoteVideo] Нет streamURL, показываем лоадер', {
        streamId: streamToUse.id,
        hasToURL: typeof streamToUse.toURL === 'function'
      });
      return <ActivityIndicator size="large" color="#fff" />;
    }
  }

  // Если нет видео трека, но есть стрим - показываем лоадер (возможно, трек еще загружается)
  if (!hasVideoTrack && streamToUse) {
    logger.info('[RemoteVideo] Есть стрим, но нет видео трека, показываем лоадер');
    return <ActivityIndicator size="large" color="#fff" />;
  }

  // Fallback - черный экран
  logger.warn('[RemoteVideo] Fallback - показываем черный экран');
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
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
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
