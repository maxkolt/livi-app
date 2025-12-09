import { MediaStream, RTCPeerConnection } from 'react-native-webrtc';
import { Platform } from 'react-native';
import { isValidStream } from '../../../../utils/streamUtils';
import { logger } from '../../../../utils/logger';
import type { WebRTCSessionConfig } from '../../types';

/**
 * Менеджер локальных и удаленных стримов
 * Управляет жизненным циклом стримов, проверкой треков и созданием unified streams из receivers
 */
export class StreamManager {
  private localStreamRef: MediaStream | null = null;
  private remoteStreamRef: MediaStream | null = null;
  private remoteStreamEstablishedAtRef: number = 0;
  private trackCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  private config: WebRTCSessionConfig;

  constructor(config: WebRTCSessionConfig) {
    this.config = config;
  }

  // ==================== Local Stream ====================

  /**
   * Получить локальный стрим
   */
  getLocalStream(): MediaStream | null {
    return this.localStreamRef;
  }

  /**
   * Установить локальный стрим
   * Вызывает callbacks для уведомления об изменении
   */
  setLocalStream(stream: MediaStream | null): void {
    this.localStreamRef = stream;
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
  }

  // ==================== Remote Stream ====================

  /**
   * Получить удаленный стрим
   */
  getRemoteStream(): MediaStream | null {
    return this.remoteStreamRef;
  }

  /**
   * Установить удаленный стрим
   * Сохраняет время установки и вызывает callbacks
   * КРИТИЧНО: Проверяем, что видеотрек правильно добавлен в MediaStream
   */
  setRemoteStream(stream: MediaStream | null, emit?: (event: string, ...args: any[]) => void): void {
    const prevStream = this.remoteStreamRef;
    
    // КРИТИЧНО: Проверяем наличие видеотрека перед установкой стрима
    if (stream) {
      const allTracks = stream.getTracks?.() || [];
      const videoTracks = (stream as any)?.getVideoTracks?.() || [];
      const audioTracks = (stream as any)?.getAudioTracks?.() || [];
      
      // Проверяем, что видеотрек доступен через getVideoTracks()
      const hasVideoTrackInAllTracks = allTracks.some((t: any) => {
        const kind = t.kind || (t as any).type;
        return kind === 'video';
      });
      
      if (hasVideoTrackInAllTracks && videoTracks.length === 0) {
        logger.error('[StreamManager] КРИТИЧЕСКАЯ ОШИБКА: Видеотрек есть в getTracks(), но НЕ доступен через getVideoTracks()!', {
          streamId: stream.id,
          allTracksCount: allTracks.length,
          allTracksKinds: allTracks.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type })),
          videoTracksCount: videoTracks.length,
          audioTracksCount: audioTracks.length
        });
      }
      
      logger.info('[StreamManager] setRemoteStream called', {
        prevStreamId: prevStream?.id,
        newStreamId: stream?.id,
        prevStreamExists: !!prevStream,
        newStreamExists: !!stream,
        streamsAreSame: prevStream === stream,
        streamsHaveSameId: prevStream?.id === stream?.id,
        allTracksCount: allTracks.length,
        videoTracksCount: videoTracks.length,
        audioTracksCount: audioTracks.length,
        hasVideoInAllTracks: hasVideoTrackInAllTracks,
        stackTrace: new Error().stack?.split('\n').slice(1, 5).join('\n')
      });
    } else {
      logger.info('[StreamManager] setRemoteStream called', {
        prevStreamId: prevStream?.id,
        newStreamId: null,
        prevStreamExists: !!prevStream,
        newStreamExists: false,
        streamsAreSame: false,
        streamsHaveSameId: false,
        stackTrace: new Error().stack?.split('\n').slice(1, 5).join('\n')
      });
    }
    
    this.remoteStreamRef = stream;
    this.remoteStreamEstablishedAtRef = stream ? Date.now() : 0;
    
    logger.info('[StreamManager] Calling onRemoteStreamChange callbacks', {
      streamId: stream?.id,
      hasCallbacks: !!this.config.callbacks.onRemoteStreamChange,
      hasOnRemoteStreamChange: !!this.config.onRemoteStreamChange,
      videoTracksCount: stream ? ((stream as any)?.getVideoTracks?.() || []).length : 0
    });
    
    this.config.callbacks.onRemoteStreamChange?.(stream);
    this.config.onRemoteStreamChange?.(stream);
    
    // КРИТИЧНО: Финальная проверка после установки remoteStream
    if (stream) {
      const finalAllTracks = stream.getTracks?.() || [];
      const finalVideoTracks = (stream as any)?.getVideoTracks?.() || [];
      const finalAudioTracks = (stream as any)?.getAudioTracks?.() || [];
      const finalVideoTrack = finalVideoTracks[0];
      const finalAudioTrack = finalAudioTracks[0];
      
      logger.info('[StreamManager] ✅ RemoteStream успешно установлен', {
        streamId: stream.id,
        allTracksCount: finalAllTracks.length,
        videoTracksCount: finalVideoTracks.length,
        audioTracksCount: finalAudioTracks.length,
        hasVideoTrack: finalVideoTracks.length > 0,
        hasAudioTrack: finalAudioTracks.length > 0,
        videoTrackId: finalVideoTrack?.id,
        videoTrackEnabled: finalVideoTrack?.enabled,
        videoTrackReadyState: finalVideoTrack?.readyState,
        audioTrackId: finalAudioTrack?.id,
        audioTrackEnabled: finalAudioTrack?.enabled,
        audioTrackReadyState: finalAudioTrack?.readyState,
        trackDetails: finalAllTracks.map((t: any) => ({
          id: t.id,
          kind: t.kind || (t as any).type,
          enabled: t.enabled,
          readyState: t.readyState
        }))
      });
      
      // КРИТИЧНО: Проверяем, что видеотрек действительно доступен
      if (finalVideoTracks.length === 0 && finalAllTracks.some((t: any) => (t.kind || (t as any).type) === 'video')) {
        logger.error('[StreamManager] ❌ КРИТИЧЕСКАЯ ОШИБКА: Видеотрек есть в getTracks(), но НЕ доступен через getVideoTracks() после установки!', {
          streamId: stream.id,
          allTracksCount: finalAllTracks.length,
          videoTracksCount: finalVideoTracks.length,
          trackKinds: finalAllTracks.map((t: any) => t.kind || (t as any).type)
        });
      }
    } else {
      logger.info('[StreamManager] ✅ RemoteStream установлен в null (очищен)');
    }
    
    if (emit) {
      const videoTracksCount = stream ? ((stream as any)?.getVideoTracks?.() || []).length : 0;
      const audioTracksCount = stream ? ((stream as any)?.getAudioTracks?.() || []).length : 0;
      logger.info('[StreamManager] 📤 Emitting remoteStream event', { 
        streamId: stream?.id,
        videoTracksCount,
        audioTracksCount,
        hasVideoTrack: videoTracksCount > 0,
        hasAudioTrack: audioTracksCount > 0
      });
      emit('remoteStream', stream);
    }
  }

  /**
   * Получить время установки удаленного стрима
   * Используется для проверки стабильности треков
   */
  getRemoteStreamEstablishedAt(): number {
    return this.remoteStreamEstablishedAtRef;
  }

  // ==================== Stream Cleanup ====================

  /**
   * Остановить локальный стрим (внутренний метод)
   * Проверяет, что стрим не используется активным PC перед остановкой
   * @param force - принудительно остановить стрим даже если PC активен (для завершения звонка)
   */
  stopLocalStreamInternal(pc: RTCPeerConnection | null, emit?: (event: string, ...args: any[]) => void, force: boolean = false): void {
    if (!this.localStreamRef) {
      return;
    }
    
    // КРИТИЧНО: При завершении звонка (force=true) принудительно останавливаем стрим
    // даже если PC еще активен. PC будет закрыт отдельно.
    if (!force && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      const senders = pc.getSenders?.() || [];
      const streamTracks = this.localStreamRef.getTracks?.() || [];
      const tracksInUse = streamTracks.filter(track => 
        senders.some((s: any) => s.track === track)
      );
      
      if (tracksInUse.length > 0) {
        logger.warn('[StreamManager] Cannot stop local stream - tracks are in use by active PC', {
          tracksInUse: tracksInUse.length,
          totalTracks: streamTracks.length,
          signalingState: pc.signalingState
        });
        return;
      }
    }
    
    // КРИТИЧНО: На Android нужно более агрессивно останавливать треки
    // Собираем все треки перед остановкой для гарантированной очистки
    const allTracks: any[] = [];
    try {
      const tracks = this.localStreamRef.getTracks?.() || [];
      const videoTracks = (this.localStreamRef as any)?.getVideoTracks?.() || [];
      const audioTracks = (this.localStreamRef as any)?.getAudioTracks?.() || [];
      
      // Собираем все треки из разных источников для гарантии
      allTracks.push(...tracks);
      videoTracks.forEach((t: any) => {
        if (t && !allTracks.includes(t)) {
          allTracks.push(t);
        }
      });
      audioTracks.forEach((t: any) => {
        if (t && !allTracks.includes(t)) {
          allTracks.push(t);
        }
      });
      
      // Удаляем дубликаты
      const uniqueTracks = Array.from(new Set(allTracks));
      
      logger.info('[StreamManager] 🛑 Останавливаем локальный стрим', {
        totalTracks: uniqueTracks.length,
        videoTracks: uniqueTracks.filter((t: any) => (t.kind || (t as any).type) === 'video').length,
        audioTracks: uniqueTracks.filter((t: any) => (t.kind || (t as any).type) === 'audio').length,
        force
      });
      
      // КРИТИЧНО: Останавливаем каждый трек несколько раз для гарантии на Android
      uniqueTracks.forEach((t: any, index: number) => {
        try {
          if (t) {
            const trackKind = t.kind || (t as any).type;
            const trackId = t.id;
            const readyState = t.readyState;
            
            // Первая попытка: стандартная остановка
            if (readyState !== 'ended' && readyState !== null) {
              t.enabled = false;
              t.stop();
              
              // КРИТИЧНО: На Android вызываем release() несколько раз для гарантии
              try {
                (t as any).release?.();
              } catch {}
              
              // КРИТИЧНО: Дополнительные методы для Android
              try {
                if ((t as any)._stop) {
                  (t as any)._stop();
                }
              } catch {}
              
              try {
                if ((t as any).dispose) {
                  (t as any).dispose();
                }
              } catch {}
              
              logger.info('[StreamManager] ✅ Трек остановлен', {
                index,
                trackKind,
                trackId,
                readyState: t.readyState
              });
            } else {
              logger.info('[StreamManager] Трек уже остановлен', {
                index,
                trackKind,
                trackId,
                readyState
              });
            }
            
            // КРИТИЧНО: Вторая попытка через небольшую задержку для Android
            // На Android треки могут не останавливаться сразу
            setTimeout(() => {
              try {
                if (t && t.readyState !== 'ended' && t.readyState !== null) {
                  t.enabled = false;
                  t.stop();
                  try { (t as any).release?.(); } catch {}
                }
              } catch (e) {
                logger.warn('[StreamManager] Error in delayed track stop:', e);
              }
            }, 100);
          }
        } catch (e) {
          logger.warn('[StreamManager] Error stopping track:', e);
        }
      });
    } catch (e) {
      logger.error('[StreamManager] Error in stopLocalStreamInternal:', e);
    }
    
    // КРИТИЧНО: Очищаем ссылку на стрим только после остановки всех треков
    this.localStreamRef = null;
    this.setLocalStream(null);
    if (emit) {
      emit('localStream', null);
    }
    
    logger.info('[StreamManager] ✅ Локальный стрим остановлен и очищен', {
      tracksStopped: allTracks.length
    });
  }

  /**
   * Остановить удаленный стрим (внутренний метод)
   * Не очищает стрим если соединение активно
   */
  stopRemoteStreamInternal(pc: RTCPeerConnection | null, emit?: (event: string, ...args: any[]) => void): void {
    if (this.remoteStreamRef && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      const isPcActive = pc.iceConnectionState === 'checking' || 
                        pc.iceConnectionState === 'connected' || 
                        pc.iceConnectionState === 'completed' ||
                        (pc as any).connectionState === 'connecting' ||
                        (pc as any).connectionState === 'connected';
      
      if (isPcActive) {
        return;
      }
    }
    
    if (this.remoteStreamRef) {
      try {
        const tracks = (this.remoteStreamRef as any)?.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          } catch {}
        });
      } catch {}
    }
    
    this.remoteStreamRef = null;
    this.remoteStreamEstablishedAtRef = 0;
    this.setRemoteStream(null, emit);
  }

  // ==================== Track Checker ====================

  /**
   * Запустить проверку удаленного видео трека
   * Для дружеских звонков используем больший интервал (300ms) для оптимизации производительности
   * Для рандомного чата используем меньший интервал (150ms) для быстрого обнаружения изменений
   */
  startTrackChecker(checkCallback: () => void, isFriendCall: boolean = false): void {
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
    
    checkCallback();
    
    // КРИТИЧНО: Для масштабируемости используем больший интервал для дружеских звонков
    // Дружеские звонки более стабильны, поэтому не требуют частой проверки
    const interval = isFriendCall ? 300 : 150;
    
    this.trackCheckIntervalRef = setInterval(() => {
      checkCallback();
    }, interval);
  }

  /**
   * Остановить проверку треков
   */
  stopTrackChecker(): void {
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
  }

  // ==================== Receivers Check ====================

  /**
   * Проверить удаленные receivers для получения стрима
   * Создает unified MediaStream из всех receivers (важно для iOS, где треки приходят отдельно)
   */
  checkReceiversForRemoteStream(
    pc: RTCPeerConnection,
    isFriendCall: () => boolean,
    onRemoteStreamSet: (stream: MediaStream) => void
  ): void {
    if (!pc || pc.signalingState === 'closed') {
      return;
    }
    
    const connectionState = (pc as any)?.connectionState || pc.iceConnectionState;
    if (connectionState === 'closed' || connectionState === 'failed') {
      return;
    }
    
    if (this.remoteStreamRef) {
      const existingVideoTracks = (this.remoteStreamRef as any)?.getVideoTracks?.() || [];
      const existingAudioTracks = (this.remoteStreamRef as any)?.getAudioTracks?.() || [];
      const hasActiveVideoTracks = existingVideoTracks.some((t: any) => t && t.readyState !== 'ended');
      const hasActiveAudioTracks = existingAudioTracks.some((t: any) => t && t.readyState !== 'ended');
      
      if (hasActiveVideoTracks || hasActiveAudioTracks) {
        return;
      }
    }
    
    try {
      const getReceiversFn = (pc as any).getReceivers;
      if (typeof getReceiversFn !== 'function') {
        return;
      }
      const receivers: Array<RTCRtpReceiver | any> = getReceiversFn.call(pc);
      
      if (!receivers || receivers.length === 0) {
        return;
      }
      
      const unifiedStream = this.createUnifiedStreamFromReceivers(receivers);
      
      if (unifiedStream) {
        const existingStream = this.remoteStreamRef;
        const existingTracks = existingStream?.getTracks?.() || [];
        const unifiedTracks = unifiedStream.getTracks?.() || [];
        const hasNewTracks = unifiedTracks.some((ut: any) => {
          return !existingTracks.some((et: any) => et && et.id === ut.id);
        });
        const isDifferentStream = !existingStream || existingStream !== unifiedStream;
        
        if (isDifferentStream || hasNewTracks) {
          const allTracks = unifiedStream.getTracks?.() || [];
          const videoTracks = (unifiedStream as any)?.getVideoTracks?.() || [];
          const audioTracks = (unifiedStream as any)?.getAudioTracks?.() || [];
          const videoTrack = videoTracks[0];
          const audioTrack = audioTracks[0];
          
          logger.info('[StreamManager] ✅ Remote stream создан из receivers', {
            streamId: unifiedStream.id,
            isFriendCall: isFriendCall(),
            allTracksCount: allTracks.length,
            videoTracksCount: videoTracks.length,
            audioTracksCount: audioTracks.length,
            hasVideoTrack: videoTracks.length > 0,
            hasAudioTrack: audioTracks.length > 0,
            videoTrackId: videoTrack?.id,
            videoTrackEnabled: videoTrack?.enabled,
            videoTrackReadyState: videoTrack?.readyState,
            audioTrackId: audioTrack?.id,
            audioTrackEnabled: audioTrack?.enabled,
            audioTrackReadyState: audioTrack?.readyState,
            trackDetails: allTracks.map((t: any) => ({
              id: t.id,
              kind: t.kind || (t as any).type,
              enabled: t.enabled,
              readyState: t.readyState
            }))
          });
          
          // КРИТИЧНО: Проверяем, что видеотрек действительно доступен
          if (videoTracks.length === 0 && allTracks.some((t: any) => (t.kind || (t as any).type) === 'video')) {
            logger.error('[StreamManager] ❌ КРИТИЧЕСКАЯ ОШИБКА: Видеотрек есть в getTracks(), но НЕ доступен через getVideoTracks() при создании из receivers!', {
              streamId: unifiedStream.id,
              allTracksCount: allTracks.length,
              videoTracksCount: videoTracks.length,
              trackKinds: allTracks.map((t: any) => t.kind || (t as any).type)
            });
          }
          
          this.setRemoteStream(unifiedStream);
          onRemoteStreamSet(unifiedStream);
        }
      }
    } catch (e) {
      logger.warn('[StreamManager] Error checking receivers:', e);
    }
  }

  /**
   * Создать unified MediaStream из receivers
   * Защищает от дубликатов треков
   * КРИТИЧНО: Убеждаемся, что видеотрек правильно добавляется в MediaStream
   */
  private createUnifiedStreamFromReceivers(receivers: Array<RTCRtpReceiver | any>): MediaStream | null {
    const { MediaStream } = require('react-native-webrtc');
    const newStream = new MediaStream();
    
    let videoTracksAdded = 0;
    let audioTracksAdded = 0;
    
    receivers.forEach((receiver: any) => {
      const track = receiver.track;
      if (track && track.readyState !== 'ended') {
        try {
          const existingTracks = newStream.getTracks?.() || [];
          const alreadyAdded = existingTracks.some((et: any) => et && et.id === track.id);
          
          if (!alreadyAdded) {
            // КРИТИЧНО: Добавляем трек в MediaStream
            (newStream as any).addTrack(track);
            
            // Отслеживаем добавленные треки для логирования
            const trackKind = track.kind || (track as any).type;
            if (trackKind === 'video') {
              videoTracksAdded++;
            } else if (trackKind === 'audio') {
              audioTracksAdded++;
            }
            
            logger.info('[StreamManager] Track added to unified stream', {
              trackId: track.id,
              trackKind: trackKind,
              trackReadyState: track.readyState,
              trackEnabled: track.enabled
            });
          }
        } catch (e) {
          logger.warn('[StreamManager] Error adding track from receiver:', e);
        }
      }
    });
    
    const unifiedTracks = newStream.getTracks?.() || [];
    const videoTracks = (newStream as any)?.getVideoTracks?.() || [];
    const audioTracks = (newStream as any)?.getAudioTracks?.() || [];
    
    // КРИТИЧНО: Проверяем, что видеотрек действительно добавлен и доступен через getVideoTracks()
    if (videoTracks.length === 0 && videoTracksAdded > 0) {
      logger.error('[StreamManager] ВИДЕОТРЕК НЕ ДОСТУПЕН через getVideoTracks() после добавления!', {
        videoTracksAdded,
        totalTracks: unifiedTracks.length,
        trackIds: unifiedTracks.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type }))
      });
    }
    
    logger.info('[StreamManager] Unified stream created from receivers', {
      totalTracks: unifiedTracks.length,
      videoTracksCount: videoTracks.length,
      audioTracksCount: audioTracks.length,
      videoTracksAdded,
      audioTracksAdded,
      isValid: isValidStream(newStream)
    });
    
    if (unifiedTracks.length > 0 && isValidStream(newStream)) {
      // КРИТИЧНО: Финальная проверка - видеотрек должен быть доступен
      if (videoTracks.length === 0) {
        logger.warn('[StreamManager] Unified stream создан, но видеотрек отсутствует', {
          totalTracks: unifiedTracks.length,
          trackKinds: unifiedTracks.map((t: any) => t.kind || (t as any).type)
        });
      }
      return newStream;
    }
    
    return null;
  }

  // ==================== Track Management ====================

  /**
   * Добавить трек в существующий удаленный стрим
   * КРИТИЧНО: Если remoteStream уже существует, добавляем трек в него
   * Если remoteStream не существует, создаем новый стрим с этим треком
   */
  addTrackToRemoteStream(track: any, emit?: (event: string, ...args: any[]) => void): MediaStream | null {
    if (!track || track.readyState === 'ended') {
      return null;
    }

    const trackKind = track.kind || (track as any).type;
    logger.info('[StreamManager] Adding track to remote stream', {
      trackId: track.id,
      trackKind: trackKind,
      trackReadyState: track.readyState,
      trackEnabled: track.enabled,
      hasExistingRemoteStream: !!this.remoteStreamRef
    });

    // Получаем или создаем targetStream
    let targetStream: MediaStream;
    
    if (this.remoteStreamRef) {
      targetStream = this.remoteStreamRef;
    } else {
      const { MediaStream } = require('react-native-webrtc');
      targetStream = new MediaStream() as MediaStream;
      logger.info('[StreamManager] Created new remote stream for track', {
        trackId: track.id,
        trackKind: trackKind
      });
    }

    // TypeScript теперь знает, что targetStream не null
    const nonNullTargetStream: MediaStream = targetStream;

    // Проверяем, не добавлен ли уже этот трек
    const existingTracks = nonNullTargetStream.getTracks?.() || [];
    const alreadyAdded = existingTracks.some((et: any) => et && et.id === track.id);

    if (!alreadyAdded) {
      try {
        // КРИТИЧНО: Добавляем трек в MediaStream
        (nonNullTargetStream as any).addTrack(track);

        // Проверяем, что трек действительно добавлен
        const tracksAfterAdd = nonNullTargetStream.getTracks?.() || [];
        const videoTracks = (nonNullTargetStream as any)?.getVideoTracks?.() || [];
        const audioTracks = (nonNullTargetStream as any)?.getAudioTracks?.() || [];

        // КРИТИЧНО: Проверяем, что видеотрек доступен через getVideoTracks()
        if (trackKind === 'video' && videoTracks.length === 0) {
          logger.error('[StreamManager] ВИДЕОТРЕК НЕ ДОСТУПЕН через getVideoTracks() после добавления!', {
            trackId: track.id,
            trackKind: trackKind,
            totalTracks: tracksAfterAdd.length,
            trackIds: tracksAfterAdd.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type }))
          });
        }

        logger.info('[StreamManager] Track successfully added to remote stream', {
          trackId: track.id,
          trackKind: trackKind,
          totalTracks: tracksAfterAdd.length,
          videoTracksCount: videoTracks.length,
          audioTracksCount: audioTracks.length,
          isNewStream: !this.remoteStreamRef
        });

        // Если это новый стрим, устанавливаем его
        if (!this.remoteStreamRef) {
          logger.info('[StreamManager] ✅ Устанавливаем новый remoteStream с добавленным треком', {
            streamId: nonNullTargetStream.id,
            trackId: track.id,
            trackKind: trackKind,
            allTracksCount: nonNullTargetStream.getTracks?.()?.length || 0,
            videoTracksCount: (nonNullTargetStream as any)?.getVideoTracks?.()?.length || 0,
            audioTracksCount: (nonNullTargetStream as any)?.getAudioTracks?.()?.length || 0
          });
          this.setRemoteStream(nonNullTargetStream, emit);
        } else {
          // Если это существующий стрим, просто обновляем callbacks
          const allTracks = nonNullTargetStream.getTracks?.() || [];
          const videoTracks = (nonNullTargetStream as any)?.getVideoTracks?.() || [];
          const audioTracks = (nonNullTargetStream as any)?.getAudioTracks?.() || [];
          
          logger.info('[StreamManager] ✅ Трек добавлен в существующий remoteStream', {
            streamId: nonNullTargetStream.id,
            trackId: track.id,
            trackKind: trackKind,
            allTracksCount: allTracks.length,
            videoTracksCount: videoTracks.length,
            audioTracksCount: audioTracks.length,
            hasVideoTrack: videoTracks.length > 0,
            hasAudioTrack: audioTracks.length > 0
          });
          
          this.config.callbacks.onRemoteStreamChange?.(nonNullTargetStream);
          this.config.onRemoteStreamChange?.(nonNullTargetStream);
          if (emit) {
            logger.info('[StreamManager] 📤 Emitting remoteStream event после добавления трека', {
              streamId: nonNullTargetStream.id,
              trackId: track.id,
              trackKind: trackKind
            });
            emit('remoteStream', targetStream);
          }
        }

        return targetStream;
      } catch (e) {
        logger.error('[StreamManager] Error adding track to remote stream:', e);
        return null;
      }
    } else {
      logger.info('[StreamManager] Track already exists in remote stream', {
        trackId: track.id,
        trackKind: trackKind
      });
      return targetStream;
    }
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние менеджера
   */
  reset(): void {
    this.localStreamRef = null;
    this.remoteStreamRef = null;
    this.remoteStreamEstablishedAtRef = 0;
    this.stopTrackChecker();
  }
}

