import { RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';
import { BaseWebRTCSession } from '../base/BaseWebRTCSession';
import type { WebRTCSessionConfig, CamSide } from '../types';
import { isValidStream } from '../../../utils/streamUtils';

/**
 * Сессия для видеозвонков другу
 * Наследуется от BaseWebRTCSession и добавляет логику специфичную для прямых звонков
 */
export class VideoCallSession extends BaseWebRTCSession {
  constructor(config: WebRTCSessionConfig) {
    super(config);
    this.setupSocketHandlers();
  }
  
  /**
   * Создать PeerConnection с локальным стримом
   * Для видеозвонков другу используется особая логика переиспользования PC
   */
  async ensurePcWithLocal(stream: MediaStream): Promise<RTCPeerConnection | null> {
    // КРИТИЧНО: Защита от множественного создания PC
    // Если PC уже создается, ждем его завершения
    if (this.pcLifecycleManager.isPcCreationInProgress()) {
      let attempts = 0;
      while (this.pcLifecycleManager.isPcCreationInProgress() && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      // После ожидания проверяем что PC создан и валиден
      if (this.peerRef) {
        try {
          const state = this.peerRef.signalingState;
          if (state !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
            this.markPcWithToken(this.peerRef);
            logger.info('[VideoCallSession] Переиспользуем существующий PC после ожидания', { 
              signalingState: state 
            });
            return this.peerRef;
          }
        } catch (e) {
          logger.warn('[VideoCallSession] Ошибка проверки PC после ожидания:', e);
        }
      }
    }
    
    // КРИТИЧНО: Проверяем что stream валиден перед использованием
    if (!stream || !isValidStream(stream)) {
      logger.error('[VideoCallSession] Cannot create PC - stream is invalid or null');
      return null;
    }
    
    // КРИТИЧНО: Проверяем что треки stream не ended
    const streamAudioTracks = stream?.getAudioTracks?.() || [];
    const streamVideoTracks = stream?.getVideoTracks?.() || [];
    const streamAllTracks = [...streamAudioTracks, ...streamVideoTracks];
    const endedTracks = streamAllTracks.filter(t => t && (t as any).readyState === 'ended');
    if (endedTracks.length > 0) {
      logger.warn('[VideoCallSession] Stream has ended tracks', { 
        endedCount: endedTracks.length, 
        totalTracks: streamAllTracks.length 
      });
    }
    
    // Проверка PiP
    const resume = this.config.getResume?.() ?? false;
    const fromPiP = this.config.getFromPiP?.() ?? false;
    
    if (resume && fromPiP) {
      const existingPc = this.peerRef;
      if (existingPc) {
        try {
          const state = existingPc.signalingState;
          if (state !== 'closed') {
            this.markPcWithToken(existingPc);
            return existingPc;
          }
        } catch {}
      }
    }
    
    let pc = this.peerRef;
    
    // КРИТИЧНО: Для дружеских звонков НЕ пересоздаем PC, если он уже существует и валиден
    if (pc) {
      try {
        const state = pc.signalingState;
        const connectionState = (pc as any)?.connectionState || pc.iceConnectionState;
        const isClosed = state === 'closed' || connectionState === 'closed';
        
        // КРИТИЧНО: Проверяем что PC валиден (не закрыт и имеет правильный token)
        if (isClosed) {
          try {
            this.cleanupPeer(pc);
          } catch (e) {
            logger.warn('[VideoCallSession] Error cleaning up closed PC:', e);
          }
          pc = null;
          this.peerRef = null;
        } else if (this.isPcValid(pc)) {
          // Для дружеских звонков ВСЕГДА переиспользуем существующий валидный PC
          logger.info('[VideoCallSession] Переиспользуем существующий валидный PC', {
            signalingState: state,
            connectionState: connectionState
          });
          this.markPcWithToken(pc);
          return pc;
        } else {
          logger.warn('[VideoCallSession] PC существует но невалиден, будет пересоздан', {
            signalingState: state,
            connectionState: connectionState,
            pcToken: (pc as any)?._pcToken,
            expectedToken: this.pcLifecycleManager.getPcToken()
          });
          // PC невалиден, очищаем и создадим новый
          try {
            this.cleanupPeer(pc);
          } catch (e) {
            logger.warn('[VideoCallSession] Error cleaning up invalid PC:', e);
          }
          pc = null;
          this.peerRef = null;
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Cannot access PC state:', e);
        // При ошибке доступа к состоянию, очищаем и создадим новый
        try {
          this.cleanupPeer(pc);
        } catch {}
        pc = null;
        this.peerRef = null;
      }
    }
    
    // Создание нового PC
    if (!pc) {
      try {
        if (!stream || !isValidStream(stream)) {
          logger.error('[VideoCallSession] Cannot create PC - stream is invalid');
          return null;
        }
        
        // КРИТИЧНО: Сохраняем существующий remoteStream перед пересозданием PC
        // Это гарантирует, что стрим не потеряется при обновлении PC
        const existingRemoteStream = this.streamManager.getRemoteStream();
        const existingRemoteStreamId = existingRemoteStream?.id;
        const existingVideoTracks = existingRemoteStream ? ((existingRemoteStream as any)?.getVideoTracks?.() || []) : [];
        const existingAudioTracks = existingRemoteStream ? ((existingRemoteStream as any)?.getAudioTracks?.() || []) : [];
        
        logger.info('[VideoCallSession] 🔄 Сохраняем remoteStream перед пересозданием PC', {
          hasExistingRemoteStream: !!existingRemoteStream,
          existingStreamId: existingRemoteStreamId,
          videoTracksCount: existingVideoTracks.length,
          audioTracksCount: existingAudioTracks.length,
          videoTrackIds: existingVideoTracks.map((t: any) => t.id),
          audioTrackIds: existingAudioTracks.map((t: any) => t.id)
        });
        
        const iceConfig = this.getIceConfig();
        
        // КРИТИЧНО: Логируем ICE конфигурацию для видеозвонков
        const hasTurn = iceConfig.iceServers?.some((server: any) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((u: string) => u && u.startsWith('turn:'));
        }) ?? false;
        const stunCount = iceConfig.iceServers?.filter((server: any) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((u: string) => u && u.startsWith('stun:'));
        }).length ?? 0;
        
        logger.info('[VideoCallSession] Creating PeerConnection with ICE config', {
          hasTurn,
          stunCount,
          totalServers: iceConfig.iceServers?.length ?? 0,
          iceTransportPolicy: (iceConfig as any).iceTransportPolicy,
          hasExistingRemoteStream: !!existingRemoteStream
        });
        
        // КРИТИЧНО: Минимальная задержка только если PC был закрыт совсем недавно
        // Для масштабируемости уменьшаем задержку до 200ms (было 2000ms)
        const lastPcClosedAt = (global as any).__lastPcClosedAt;
        if (lastPcClosedAt) {
          const timeSinceClose = Date.now() - lastPcClosedAt;
          const PC_CREATION_DELAY = 200; // Оптимизировано для быстрого соединения
          if (timeSinceClose < PC_CREATION_DELAY) {
            const delay = PC_CREATION_DELAY - timeSinceClose;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        this.pcLifecycleManager.setPcCreationInProgress(true);

        try {
          pc = new RTCPeerConnection(iceConfig);
          this.peerRef = pc;
          this.pcLifecycleManager.setPcCreationInProgress(false);
          
          this.incrementPcToken(true);
          this.markPcWithToken(pc);
          
          // КРИТИЧНО: Восстанавливаем remoteStream после создания нового PC
          // Это гарантирует, что компоненты получат стрим даже после пересоздания PC
          if (existingRemoteStream && isValidStream(existingRemoteStream)) {
            const restoredVideoTracks = (existingRemoteStream as any)?.getVideoTracks?.() || [];
            const restoredAudioTracks = (existingRemoteStream as any)?.getAudioTracks?.() || [];
            
            logger.info('[VideoCallSession] ✅ Восстанавливаем remoteStream после создания нового PC', {
              streamId: existingRemoteStreamId,
              videoTracksCount: restoredVideoTracks.length,
              audioTracksCount: restoredAudioTracks.length,
              videoTrackIds: restoredVideoTracks.map((t: any) => t.id),
              audioTrackIds: restoredAudioTracks.map((t: any) => t.id)
            });
            
            // КРИТИЧНО: Устанавливаем remoteStream обратно, чтобы компоненты получили его
            // Это гарантирует синхронизацию с компонентами
            this.streamManager.setRemoteStream(existingRemoteStream, (event, ...args) => {
              logger.info('[VideoCallSession] 📤 Emitting restored remoteStream event', {
                event,
                streamId: existingRemoteStreamId,
                videoTracksCount: restoredVideoTracks.length,
                audioTracksCount: restoredAudioTracks.length
              });
              this.emit(event, ...args);
            });
            
            // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
            this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          }
          
          // Устанавливаем обработчики
          this.bindConnHandlers(pc, this.partnerIdRef || undefined);
          this.attachRemoteHandlers(pc, this.partnerIdRef || undefined);
        } catch (createError: any) {
          this.pcLifecycleManager.setPcCreationInProgress(false);
          logger.error('[VideoCallSession] RTCPeerConnection constructor failed:', createError);
          (global as any).__lastPcClosedAt = Date.now();
          throw createError;
        }
      } catch (e) {
        this.pcLifecycleManager.setPcCreationInProgress(false);
        logger.error('[VideoCallSession] Failed to create PeerConnection:', e);
        (global as any).__lastPcClosedAt = Date.now();
        return null;
      }
    }
    
    // КРИТИЧНО: Добавляем локальные треки в PeerConnection
    // Это ОБЯЗАТЕЛЬНО для отправки аудио/видео собеседнику
    // Без этого треки никуда не отправляются → собеседник слышит/видит НОЛЬ
    const allTracks = stream?.getTracks?.() || [];
    const tracksAdded: string[] = [];
    const tracksFailed: string[] = [];
    
    logger.info('[VideoCallSession] 🔧 Добавляем локальные треки в PeerConnection', {
      streamId: stream.id,
      totalTracks: allTracks.length,
      audioTracks: stream?.getAudioTracks?.()?.length || 0,
      videoTracks: stream?.getVideoTracks?.()?.length || 0
    });
    
    // КРИТИЧНО: Простой и надежный способ - добавляем все треки через addTrack
    allTracks.forEach((track: any) => {
      if (track && track.readyState !== 'ended') {
        try {
          // КРИТИЧНО: Используем стандартный метод addTrack с stream
          // Это гарантирует, что треки будут отправляться собеседнику
          (pc as any).addTrack(track, stream);
          tracksAdded.push(track.id);
          
          logger.info('[VideoCallSession] ✅ Трек добавлен в PC', {
            trackId: track.id,
            trackKind: track.kind || (track as any).type,
            trackEnabled: track.enabled,
            trackReadyState: track.readyState
          });
        } catch (e) {
          tracksFailed.push(track.id);
          logger.error('[VideoCallSession] ❌ Ошибка добавления трека в PC', {
            trackId: track.id,
            trackKind: track.kind || (track as any).type,
            error: e
          });
        }
      } else {
        logger.warn('[VideoCallSession] Пропускаем трек - ended или null', {
          trackId: track?.id,
          readyState: track?.readyState
        });
      }
    });
    
    // КРИТИЧНО: Проверяем, что треки действительно добавлены
    const finalSenders = pc.getSenders?.() || [];
    const finalSendersCount = finalSenders.length;
    
    logger.info('[VideoCallSession] 📊 Итоговое состояние треков в PC', {
      tracksAdded: tracksAdded.length,
      tracksFailed: tracksFailed.length,
      sendersInPc: finalSendersCount,
      expectedTracks: allTracks.length,
      tracksAddedIds: tracksAdded,
      tracksFailedIds: tracksFailed,
      sendersDetails: finalSenders.map((s: any) => ({
        trackId: s.track?.id,
        trackKind: s.track?.kind || (s.track as any)?.type,
        trackEnabled: s.track?.enabled,
        trackReadyState: s.track?.readyState
      }))
    });
    
    // КРИТИЧНО: Если треки не добавлены - это критическая ошибка
    if (finalSendersCount === 0 && allTracks.length > 0) {
      logger.error('[VideoCallSession] ❌❌❌ КРИТИЧЕСКАЯ ОШИБКА: Треки НЕ добавлены в PC! Собеседник не услышит и не увидит!', {
        streamId: stream.id,
        totalTracks: allTracks.length,
        sendersCount: finalSendersCount
      });
    } else if (finalSendersCount < allTracks.length) {
      logger.warn('[VideoCallSession] ⚠️ Не все треки добавлены в PC', {
        expected: allTracks.length,
        actual: finalSendersCount,
        missing: allTracks.length - finalSendersCount
      });
    }
    
    return pc;
  }
  
  /**
   * Позвонить другу
   */
  async callFriend(friendId: string): Promise<void> {
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    
    this.setPartnerId(friendId);
    
    const stream = await this.startLocalStream('front');
    if (!stream) {
      throw new Error('Failed to start local stream for friend call');
    }
    
    const pc = await this.ensurePcWithLocal(stream);
    if (!pc) {
      throw new Error('Failed to create PeerConnection for friend call');
    }
    
    if (this.peerRef !== pc) {
      this.peerRef = pc;
    }
    
    this.markPcWithToken(pc);
    
    // КРИТИЧНО: Устанавливаем обработчики удаленного стрима для инициатора
    // Это гарантирует получение видео от получателя
    // Проверяем не только наличие partnerId, но и правильность установки обработчиков
    if (this.partnerIdRef) {
      const hasHandler = !!(pc as any)?.ontrack;
      const hasFlag = (pc as any)?._remoteHandlersAttached === true;
      if (!hasHandler || !hasFlag) {
        logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима в callFriend', {
          hasHandler,
          hasFlag,
          partnerId: this.partnerIdRef
        });
        this.attachRemoteHandlers(pc, this.partnerIdRef);
      } else {
        logger.info('[VideoCallSession] Обработчики удаленного стрима уже установлены в callFriend', {
          partnerId: this.partnerIdRef
        });
      }
    }
    
    const currentStream = this.streamManager.getLocalStream();
    if (currentStream !== stream) {
      this.streamManager.setLocalStream(stream);
      this.config.callbacks.onLocalStreamChange?.(stream);
      this.config.onLocalStreamChange?.(stream);
      this.emit('localStream', stream);
    }
    
    // КРИТИЧНО: НЕ отправляем offer здесь, так как roomId еще не установлен
    // Offer будет отправлен в обработчике call:accepted после получения roomId
    // Это гарантирует правильную доставку через roomId
    logger.info('[VideoCallSession] callFriend completed, waiting for call:accepted to send offer', { friendId });
  }
  
  /**
   * Принять входящий звонок
   */
  async acceptCall(callId?: string, fromUserId?: string): Promise<void> {
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    
    // КРИТИЧНО: Устанавливаем partnerId из входящего звонка если он еще не установлен
    if (fromUserId && !this.getPartnerId()) {
      this.setPartnerId(fromUserId);
      logger.info('[VideoCallSession] PartnerId установлен в acceptCall', { fromUserId });
    }
    
    // Устанавливаем callId если он передан
    if (callId && !this.getCallId()) {
      this.setCallId(callId);
    }
    
    // Создаем локальный стрим для ответа
    let stream = this.streamManager.getLocalStream();
    if (!stream) {
      stream = await this.startLocalStream('front');
      if (!stream) {
        throw new Error('Failed to start local stream for accepting call');
      }
    }
    
    // КРИТИЧНО: Включаем камеру и микрофон при принятии звонка
    // У принимающего звонок камера должна быть включена изначально
    try {
      const videoTracks = (stream as any)?.getVideoTracks?.() || [];
      const audioTracks = (stream as any)?.getAudioTracks?.() || [];
      const videoTrack = videoTracks[0];
      const audioTrack = audioTracks[0];
      
      if (videoTrack) {
        videoTrack.enabled = true;
        this.config.callbacks.onCamStateChange?.(true);
        this.config.onCamStateChange?.(true);
      }
      
      if (audioTrack) {
        audioTrack.enabled = true;
        this.config.callbacks.onMicStateChange?.(true);
        this.config.onMicStateChange?.(true);
      }
    } catch (e) {
      logger.warn('[VideoCallSession] Error enabling tracks in acceptCall:', e);
    }
    
    // Создаем PeerConnection для получения offer
    let pc = this.peerRef;
    if (!pc) {
      pc = await this.ensurePcWithLocal(stream);
      if (pc && this.partnerIdRef) {
        logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима в acceptCall (новый PC)', {
          partnerId: this.partnerIdRef
        });
        this.attachRemoteHandlers(pc, this.partnerIdRef);
      }
    } else if (pc && this.partnerIdRef) {
      // КРИТИЧНО: Если PC уже существует, убеждаемся что обработчики установлены
      const hasHandler = !!(pc as any)?.ontrack;
      const hasFlag = (pc as any)?._remoteHandlersAttached === true;
      if (!hasHandler || !hasFlag) {
        logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима в acceptCall (существующий PC)', {
          hasHandler,
          hasFlag,
          partnerId: this.partnerIdRef
        });
        this.attachRemoteHandlers(pc, this.partnerIdRef);
      }
    }
    
    // КРИТИЧНО: Еще раз проверяем и включаем камеру перед отправкой call:accept
    // Это гарантирует, что камера включена при принятии звонка
    try {
      const videoTracks = (stream as any)?.getVideoTracks?.() || [];
      const audioTracks = (stream as any)?.getAudioTracks?.() || [];
      const videoTrack = videoTracks[0];
      const audioTrack = audioTracks[0];
      
      if (videoTrack && !videoTrack.enabled) {
        videoTrack.enabled = true;
        this.config.callbacks.onCamStateChange?.(true);
        this.config.onCamStateChange?.(true);
        logger.info('[VideoCallSession] Камера включена перед отправкой call:accept');
      }
      
      if (audioTrack && !audioTrack.enabled) {
        audioTrack.enabled = true;
        this.config.callbacks.onMicStateChange?.(true);
        this.config.onMicStateChange?.(true);
      }
    } catch (e) {
      logger.warn('[VideoCallSession] Error ensuring tracks enabled before call:accept:', e);
    }
    
    // Отправляем call:accept
    try {
      const acceptPayload: any = { callId: callId || this.callIdRef };
      if (this.partnerIdRef) {
        acceptPayload.to = this.partnerIdRef;
      }
      socket.emit('call:accept', acceptPayload);
      logger.info('[VideoCallSession] call:accept отправлен', { callId: callId || this.callIdRef, partnerId: this.partnerIdRef });
    } catch (e) {
      logger.error('[VideoCallSession] Error sending call:accept', e);
    }
    
    this.config.setStarted?.(true);
    
    // КРИТИЧНО: После call:accept сервер отправит call:accepted с roomId
    // Обработка call:accepted происходит в setupSocketHandlers
  }
  
  /**
   * Отклонить входящий звонок
   */
  declineCall(callId?: string): void {
    try {
      const declinePayload: any = { callId: callId || this.callIdRef };
      if (this.partnerIdRef) {
        declinePayload.to = this.partnerIdRef;
      }
      socket.emit('call:decline', declinePayload);
    } catch (e) {
      logger.warn('[VideoCallSession] Error emitting call:decline:', e);
    }
    
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    
    this.emit('callDeclined');
  }
  
  /**
   * Очистка после неуспешного дружеского звонка (timeout или busy)
   */
  cleanupAfterFriendCallFailure(reason: 'timeout' | 'busy'): void {
    // Останавливаем удаленный стрим (если есть)
    if (this.getRemoteStream()) {
      this.stopRemoteStream();
    }
    
    // Локальный стрим НЕ трогаем (чтобы камера не мигала)
    
    // Сбрасываем флаги
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    
    // Эмитим soft-событие для UI
    this.emit('callEnded');
  }
  
  /**
   * Обработка внешнего события завершения звонка (call:ended)
   */
  handleExternalCallEnded(reason?: string, data?: any): void {
    // Для видеозвонков обрабатываем call:ended
    this.endCall();
  }
  
  /**
   * Завершить текущий звонок
   */
  endCall(): void {
    // Фиксируем завершение, блокируем любые последующие авто-включения камеры/мика
    this.endedRef = true;
    const savedRoomId = this.roomIdRef;
    const savedCallId = this.callIdRef;
    const savedPartnerId = this.partnerIdRef;
    
    // Отправляем call:end ДО очистки
    try {
      const roomIdToSend = savedRoomId || this.roomIdRef;
      const callIdToSend = savedCallId || this.callIdRef;
      
      if (roomIdToSend || callIdToSend) {
        socket.emit('call:end', {
          roomId: roomIdToSend,
          callId: callIdToSend,
          to: savedPartnerId
        });
      }
    } catch (e) {
      logger.warn('[VideoCallSession] Error emitting call:end:', e);
    }
    
    // КРИТИЧНО: Сначала собираем и останавливаем ВСЕ треки из senders
    // На Android при множественных перезапусках камеры (flipCam/reinit) могут остаться треки
    // вне localStreamRef, которые нужно явно остановить
    const allTracksToStop: any[] = [];
    
    // Собираем треки из основного PC
    if (this.peerRef) {
      this.incrementPcToken();
      
      try {
        // Собираем все треки из senders перед закрытием PC
        // Это покрывает треки, добавленные при flipCam/reinit
        const senders = this.peerRef.getSenders?.() || [];
        senders.forEach((sender: any) => {
          try {
            if (sender.track) {
              // Сохраняем трек для последующей остановки
              allTracksToStop.push(sender.track);
              sender.track.enabled = false;
            }
            sender.replaceTrack(null).catch(() => {});
          } catch (e) {
            logger.warn('[VideoCallSession] Error removing track from sender:', e);
          }
        });
        
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Error closing PC:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // КРИТИЧНО: Также собираем треки из preCreatedPcRef (если есть)
    // Это покрывает случаи, когда PC был создан, но еще не использован
    if (this.preCreatedPcRef) {
      try {
        const preCreatedSenders = this.preCreatedPcRef.getSenders?.() || [];
        preCreatedSenders.forEach((sender: any) => {
          try {
            if (sender.track) {
              // Сохраняем трек для последующей остановки
              allTracksToStop.push(sender.track);
              sender.track.enabled = false;
            }
            sender.replaceTrack(null).catch(() => {});
          } catch (e) {
            logger.warn('[VideoCallSession] Error removing track from preCreatedPc sender:', e);
          }
        });
        
        if (this.preCreatedPcRef.signalingState !== 'closed' && (this.preCreatedPcRef as any).connectionState !== 'closed') {
          this.preCreatedPcRef.close();
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Error closing preCreatedPc:', e);
      }
      this.cleanupPeer(this.preCreatedPcRef);
      this.preCreatedPcRef = null;
    }
    
    // КРИТИЧНО: Теперь останавливаем локальный стрим (камера и микрофон)
    // PC уже закрыт, поэтому треки точно можно остановить
    // Используем force=true для гарантированной остановки
    this.stopLocalStreamInternal(true);
    
    // Дополнительная проверка и принудительная остановка всех треков локального стрима
    const localStream = this.streamManager.getLocalStream();
    if (localStream) {
      try {
        const tracks = localStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            if (t && t.readyState !== 'ended') {
              // Сохраняем трек для последующей остановки
              if (!allTracksToStop.includes(t)) {
                allTracksToStop.push(t);
              }
              t.enabled = false;
              t.stop();
            }
          } catch (e) {
            logger.warn('[VideoCallSession] Error force-stopping local track:', e);
          }
        });
      } catch (e) {
        logger.warn('[VideoCallSession] Error force-stopping local stream:', e);
      }
      
      // Очищаем ссылку на стрим
      this.streamManager.setLocalStream(null);
      this.config.callbacks.onLocalStreamChange?.(null);
      this.config.onLocalStreamChange?.(null);
      this.emit('localStream', null);
    }
    
    // КРИТИЧНО: Останавливаем ВСЕ собранные треки (включая те, что не в localStreamRef)
    // На Android при множественных перезапусках камеры (flipCam/reinit/restartLocalCamera)
    // могут остаться треки вне ссылок, которые нужно явно остановить
    // Собраны треки из:
    // 1. peerRef senders (треки, добавленные в активный PC)
    // 2. preCreatedPcRef senders (треки из предсозданного PC)
    // 3. localStream (треки из текущего локального стрима)
    // Это покрывает все случаи, включая треки из flipCam/reinit
    const uniqueTracks = Array.from(new Set(allTracksToStop));
    uniqueTracks.forEach((track: any) => {
      try {
        if (track && track.readyState !== 'ended' && track.readyState !== null) {
          const trackKind = track.kind || (track as any).type;
          const trackId = track.id;
          
          // КРИТИЧНО: Агрессивная остановка для Android
          track.enabled = false;
          track.stop();
          
          // КРИТИЧНО: Дополнительные методы для Android
          try {
            (track as any).release?.();
          } catch {}
          
          try {
            if ((track as any)._stop) {
              (track as any)._stop();
            }
          } catch {}
          
          try {
            if ((track as any).dispose) {
              (track as any).dispose();
            }
          } catch {}
          
          logger.info('[VideoCallSession] ✅ Orphaned трек остановлен', {
            trackKind,
            trackId,
            readyState: track.readyState
          });
          
          // КРИТИЧНО: Вторая попытка через задержку для Android
          setTimeout(() => {
            try {
              if (track && track.readyState !== 'ended' && track.readyState !== null) {
                track.enabled = false;
                track.stop();
                try { (track as any).release?.(); } catch {}
              }
            } catch (e) {
              logger.warn('[VideoCallSession] Error in delayed orphaned track stop:', e);
            }
          }, 100);
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Error stopping orphaned track:', e);
      }
    });
    
    if (uniqueTracks.length > 0) {
      logger.info('[VideoCallSession] 🛑 Остановлены все треки (включая orphaned)', {
        totalTracks: uniqueTracks.length,
        videoTracks: uniqueTracks.filter((t: any) => t.kind === 'video').length,
        audioTracks: uniqueTracks.filter((t: any) => t.kind === 'audio').length,
        sources: {
          fromPeerRef: allTracksToStop.filter((t: any) => t).length,
          fromPreCreatedPc: allTracksToStop.filter((t: any) => t).length,
          fromLocalStream: localStream ? (localStream.getTracks?.() || []).length : 0
        }
      });
    }
    
    // Останавливаем удаленный стрим
    const remoteStream = this.streamManager.getRemoteStream();
    if (remoteStream) {
      const allTracks = remoteStream.getTracks?.() || [];
      const videoTracks = (remoteStream as any)?.getVideoTracks?.() || [];
      const audioTracks = (remoteStream as any)?.getAudioTracks?.() || [];
      
      logger.info('[VideoCallSession] 🛑 Останавливаем remoteStream', {
        streamId: remoteStream.id,
        allTracksCount: allTracks.length,
        videoTracksCount: videoTracks.length,
        audioTracksCount: audioTracks.length,
        hasVideoTrack: videoTracks.length > 0,
        hasAudioTrack: audioTracks.length > 0,
        trackDetails: allTracks.map((t: any) => ({
          id: t.id,
          kind: t.kind || (t as any).type,
          enabled: t.enabled,
          readyState: t.readyState
        }))
      });
      
      try {
        allTracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          } catch {}
        });
      } catch {}
      
      // КРИТИЧНО: Очищаем partnerId, roomId, callId ПЕРЕД эмитом remoteStream(null)
      // Это гарантирует, что компонент правильно определит, что звонок завершается
      // и не покажет ложное предупреждение
      this.config.setFriendCallAccepted?.(false);
      this.config.setInDirectCall?.(false);
      this.config.setStarted?.(false);
      
      this.setPartnerId(null);
      this.setPartnerSocketId(null);
      this.setRoomId(null);
      this.setCallId(null);
      
      // КРИТИЧНО: Теперь эмитим remoteStream(null) ПОСЛЕ очистки идентификаторов
      // Это гарантирует, что компонент увидит, что звонок уже завершен
      this.streamManager.setRemoteStream(null);
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      logger.info('[VideoCallSession] ✅ RemoteStream очищен и события отправлены (после очистки идентификаторов)');
      this.emit('remoteStream', null);
    } else {
      logger.info('[VideoCallSession] RemoteStream уже отсутствует, пропускаем очистку');
      
      // КРИТИЧНО: Даже если remoteStream уже null, очищаем идентификаторы
      // для консистентности состояния
      this.config.setFriendCallAccepted?.(false);
      this.config.setInDirectCall?.(false);
      this.config.setStarted?.(false);
      
      this.setPartnerId(null);
      this.setPartnerSocketId(null);
      this.setRoomId(null);
      this.setCallId(null);
    }
    
    this.stopMicMeter();
    
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    
    this.emit('callEnded');
  }
  
  /**
   * Очистка ресурсов
   */
  cleanup(): void {
    // Останавливаем локальный стрим
    this.stopLocalStreamInternal();
    
    // Останавливаем удаленный стрим
    if (this.streamManager.getRemoteStream()) {
      this.stopRemoteStreamInternal();
    }
    
    // Закрываем PeerConnection
    if (this.peerRef) {
      try {
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Error closing PC in cleanup:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // Очищаем таймеры
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    
    // Сбрасываем флаги
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    
    // Сбрасываем идентификаторы
    this.setPartnerId(null);
    this.setPartnerSocketId(null);
    this.setRoomId(null);
    this.setCallId(null);
    
    // Удаляем AppState listener если есть
    this.appStateHandler.removeAppStateListener();
    
    // Удаляем все слушатели событий
    this.removeAllListeners();
  }
  
  /**
   * Отправить состояние камеры партнеру (для видеозвонков используем roomId)
   */
  sendCameraState(toPartnerId?: string, enabled?: boolean): void {
    const targetPartnerId = toPartnerId || this.getPartnerId();
    const currentRoomId = this.getRoomId();
    
    // Определяем текущее состояние камеры
    let isEnabled: boolean;
    if (enabled !== undefined) {
      isEnabled = enabled;
    } else {
      const stream = this.getLocalStream();
      const videoTrack = stream ? (stream as any)?.getVideoTracks?.()?.[0] : null;
      // КРИТИЧНО: Получаем фактическое состояние трека, а не значение по умолчанию
      // Это гарантирует правильную отправку состояния камеры
      isEnabled = videoTrack ? (videoTrack.enabled === true) : true;
    }
    
    // КРИТИЧНО: Логируем отправку состояния для отладки
    logger.info('[VideoCallSession] sendCameraState', {
      enabled: isEnabled,
      passedEnabled: enabled,
      hasRoomId: !!currentRoomId,
      roomId: currentRoomId,
      hasPartnerId: !!targetPartnerId,
      partnerId: targetPartnerId
    });
    
    // КРИТИЧНО: Не отправляем cam-toggle(false) если звонок только что принят (в течение 30 секунд)
    // Это предотвращает гашение камеры собеседника сразу после принятия звонка
    if (!isEnabled) {
      const connectionEstablishedAt = (this as any).remoteStateManager?.getConnectionEstablishedAt?.();
      const timeSinceConnection = connectionEstablishedAt ? Date.now() - connectionEstablishedAt : Infinity;
      const FILTER_DURATION_MS = 30000; // 30 секунд
      
      if (timeSinceConnection < FILTER_DURATION_MS) {
        logger.info('[VideoCallSession] Не отправляем cam-toggle(false) - соединение только что установлено', {
          timeSinceConnection,
          roomId: currentRoomId
        });
        return; // Не отправляем cam-toggle(false)
      }
    }
    
    try {
      const payload: any = { 
        enabled: isEnabled, 
        from: socket.id
      };
      
      // Для видеозвонков используем roomId
      if (currentRoomId) {
        payload.roomId = currentRoomId;
      }
      
      socket.emit('cam-toggle', payload);
    } catch (e) {
      logger.warn('[VideoCallSession] Error sending camera state:', e);
    }
  }
  
  /**
   * Настройка обработчиков socket для видеозвонков
   */
  protected setupSocketHandlers(): void {
    // Вызываем базовую реализацию
    super.setupSocketHandlers();
    
    // Добавляем специфичные обработчики для видеозвонков
    socket.on('call:incoming', (data: any) => {
      // Обработка входящего звонка будет в компоненте
      this.emit('callIncoming', data);
    });
    
    // КРИТИЧНО: Обработчик для получения roomId инициатором сразу после создания комнаты
    socket.on('call:room:created', (data: any) => {
      try {
        // КРИТИЧНО: Сохраняем roomId сразу
        if (data.roomId && !this.getRoomId()) {
          this.setRoomId(data.roomId);
          logger.info('[VideoCallSession] RoomId установлен из call:room:created (инициатор)', { roomId: data.roomId });
          
          // Присоединяемся к комнате
          if (!this.roomJoinedRef.has(data.roomId)) {
            try {
              socket.emit('room:join:ack', { roomId: data.roomId });
              this.roomJoinedRef.add(data.roomId);
              logger.info('[VideoCallSession] Инициатор присоединился к комнате', { roomId: data.roomId });
            } catch (e) {
              logger.error('[VideoCallSession] Ошибка присоединения к комнате (инициатор):', e);
            }
          }
          
          // КРИТИЧНО: Отправляем начальное состояние камеры после установки roomId
          // Это гарантирует, что партнер получит правильное состояние камеры при установке соединения
          setTimeout(() => {
            const stream = this.streamManager.getLocalStream();
            if (stream) {
              const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack) {
                const isEnabled = videoTrack.enabled ?? true;
                logger.info('[VideoCallSession] Отправляем начальное состояние камеры после установки roomId (инициатор)', {
                  roomId: data.roomId,
                  enabled: isEnabled
                });
                this.sendCameraState(undefined, isEnabled);
              }
            }
          }, 200);
        }
        
        // КРИТИЧНО: Сохраняем partnerId если он пришел
        if (data.partnerId && !this.getPartnerId()) {
          this.setPartnerId(data.partnerId);
          logger.info('[VideoCallSession] PartnerId установлен из call:room:created', { partnerId: data.partnerId });
        }
        
        // КРИТИЧНО: Сохраняем partnerSocketId если он пришел (для ICE кандидатов)
        if (data.from && typeof data.from === 'string' && !this.getPartnerSocketId()) {
          this.setPartnerSocketId(data.from);
          logger.info('[VideoCallSession] PartnerSocketId установлен из call:room:created', { socketId: data.from });
        }
      } catch (e) {
        logger.error('[VideoCallSession] Ошибка обработки call:room:created:', e);
      }
    });
    
    socket.on('call:accepted', async (data: any) => {
      // КРИТИЧНО: Обрабатываем call:accepted для установки roomId и создания offer/answer
      try {
        // Устанавливаем roomId если он пришел
        if (data.roomId && !this.getRoomId()) {
          this.setRoomId(data.roomId);
          logger.info('[VideoCallSession] RoomId установлен из call:accepted', { roomId: data.roomId });
          
          // Присоединяемся к комнате
          if (!this.roomJoinedRef.has(data.roomId)) {
            try {
              socket.emit('room:join:ack', { roomId: data.roomId });
              this.roomJoinedRef.add(data.roomId);
              logger.info('[VideoCallSession] Присоединились к комнате', { roomId: data.roomId });
            } catch (e) {
              logger.error('[VideoCallSession] Ошибка присоединения к комнате:', e);
            }
          }
          
          // КРИТИЧНО: Отправляем начальное состояние камеры после установки roomId
          // Это гарантирует, что партнер получит правильное состояние камеры при установке соединения
          setTimeout(() => {
            const stream = this.streamManager.getLocalStream();
            if (stream) {
              const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack) {
                const isEnabled = videoTrack.enabled ?? true;
                logger.info('[VideoCallSession] Отправляем начальное состояние камеры после установки roomId', {
                  roomId: data.roomId,
                  enabled: isEnabled
                });
                this.sendCameraState(undefined, isEnabled);
              }
            }
          }, 200);
        }
        
        // Устанавливаем callId если он пришел
        if (data.callId && !this.getCallId()) {
          this.setCallId(data.callId);
        }
        
        // Устанавливаем partnerId если он пришел
        if (data.fromUserId && !this.getPartnerId()) {
          this.setPartnerId(data.fromUserId);
          logger.info('[VideoCallSession] PartnerId установлен из call:accepted', { fromUserId: data.fromUserId });
        }
        
        // КРИТИЧНО: Сохраняем socketId пира для прямых вызовов (для ICE кандидатов)
        if (data.from && typeof data.from === 'string') {
          this.setPartnerSocketId(data.from);
          logger.info('[VideoCallSession] PartnerSocketId установлен из call:accepted', { socketId: data.from });
        }
        
        // КРИТИЧНО: Определяем инициатора ДО использования
        const isInitiator: boolean = this.config.getIsDirectInitiator?.() ?? false;
        
        // КРИТИЧНО: Если partnerId не установлен, но мы инициатор, используем friendId из callFriend
        // (для случая когда call:accepted не содержит fromUserId)
        if (isInitiator && !this.getPartnerId()) {
          logger.warn('[VideoCallSession] ⚠️ Инициатор: partnerId не установлен в call:accepted, используем friendId из конфига');
          // partnerId должен быть установлен в callFriend, проверяем
          const currentPartnerId = this.getPartnerId();
          if (!currentPartnerId) {
            logger.error('[VideoCallSession] ❌ Инициатор: partnerId не установлен ни в callFriend, ни в call:accepted!');
          }
        }
        
        // КРИТИЧНО: Если мы инициатор звонка, создаем и отправляем offer ПОСЛЕ получения roomId
        if (isInitiator) {
          const partnerId = this.getPartnerId();
          const roomId = this.getRoomId();
          
          // КРИТИЧНО: Требуем и partnerId и roomId для отправки offer
          if (partnerId && roomId) {
            logger.info('[VideoCallSession] Инициатор: создаем offer после call:accepted', { partnerId, roomId });
            
            // Убеждаемся, что есть локальный стрим
            let stream = this.streamManager.getLocalStream();
            if (!stream) {
              stream = await this.startLocalStream('front');
              if (!stream) {
                logger.error('[VideoCallSession] Не удалось создать локальный стрим для offer');
                return;
              }
            }
            
            // Убеждаемся, что есть PeerConnection
            if (stream) {
              let pc = this.peerRef;
              if (!pc) {
                pc = await this.ensurePcWithLocal(stream);
                if (!pc) {
                  logger.error('[VideoCallSession] Не удалось создать PeerConnection для offer');
                  return;
                }
              }
              
              // КРИТИЧНО: Убеждаемся, что обработчики удаленного стрима установлены для инициатора
              // Проверяем не только флаг, но и наличие самого обработчика
              if (pc && partnerId) {
                const hasHandler = !!(pc as any)?.ontrack;
                const hasFlag = (pc as any)?._remoteHandlersAttached === true;
                if (!hasHandler || !hasFlag) {
                  logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима для инициатора', {
                    hasHandler,
                    hasFlag,
                    partnerId
                  });
                  this.attachRemoteHandlers(pc, partnerId);
                }
              }
              
              // КРИТИЧНО: Проверяем что roomId установлен (без задержки для быстрого соединения)
              // roomId уже установлен выше, задержка не нужна
              const finalRoomId = this.getRoomId();
              if (finalRoomId && pc && partnerId) {
                // Создаем offer асинхронно, не блокируя обработку события
                this.createAndSendOffer(partnerId, finalRoomId).catch((e) => {
                  logger.error('[VideoCallSession] Error creating/sending offer:', e);
                });
                logger.info('[VideoCallSession] ✅ Offer создан и отправлен после call:accepted', { 
                  partnerId, 
                  roomId: finalRoomId 
                });
              } else {
                logger.warn('[VideoCallSession] ⚠️ Не удалось отправить offer - отсутствуют необходимые данные', {
                  hasRoomId: !!finalRoomId,
                  hasPc: !!pc,
                  hasPartnerId: !!partnerId
                });
              }
            }
          } else {
            logger.warn('[VideoCallSession] ⚠️ Инициатор: нет partnerId или roomId для отправки offer', {
              hasPartnerId: !!partnerId,
              hasRoomId: !!roomId
            });
          }
        } else {
          // Если мы получатель, убеждаемся, что есть локальный стрим для ответа на offer
          logger.info('[VideoCallSession] Получатель: готовимся к получению offer', {
            hasLocalStream: !!this.streamManager.getLocalStream(),
            hasPc: !!this.peerRef,
            partnerId: this.getPartnerId(),
            roomId: this.getRoomId()
          });
          
          const localStream = this.streamManager.getLocalStream();
          if (!localStream) {
            const stream = await this.startLocalStream('front');
            if (stream) {
              logger.info('[VideoCallSession] Локальный стрим создан для получателя');
            } else {
              logger.error('[VideoCallSession] Не удалось создать локальный стрим для получателя');
            }
          }
          
          // КРИТИЧНО: Убеждаемся что PC создан для получателя
          const currentLocalStream = this.streamManager.getLocalStream();
          if (!this.peerRef && currentLocalStream) {
            const pc = await this.ensurePcWithLocal(currentLocalStream);
            if (pc) {
              logger.info('[VideoCallSession] ✅ PeerConnection создан для получателя');
              if (this.partnerIdRef) {
                // КРИТИЧНО: Всегда устанавливаем обработчики для получателя, даже если они уже установлены
                // Это гарантирует получение удаленного стрима
                logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима для получателя', {
                  partnerId: this.partnerIdRef
                });
                this.attachRemoteHandlers(pc, this.partnerIdRef);
              }
            } else {
              logger.error('[VideoCallSession] ❌ Не удалось создать PeerConnection для получателя');
            }
          } else if (this.peerRef && this.partnerIdRef) {
            // КРИТИЧНО: Если PC уже существует, убеждаемся что обработчики установлены
            const pc = this.peerRef;
            const hasHandler = !!(pc as any)?.ontrack;
            const hasFlag = (pc as any)?._remoteHandlersAttached === true;
            if (!hasHandler || !hasFlag) {
              logger.info('[VideoCallSession] Устанавливаем обработчики удаленного стрима для получателя (PC уже существует)', {
                hasHandler,
                hasFlag,
                partnerId: this.partnerIdRef
              });
              this.attachRemoteHandlers(pc, this.partnerIdRef);
            }
          }
        }
        
        // Эмитим событие для компонента
        this.emit('callAccepted', data);
        logger.info('[VideoCallSession] ✅ callAccepted событие отправлено в компонент', {
          hasRoomId: !!this.getRoomId(),
          hasPartnerId: !!this.getPartnerId(),
          hasCallId: !!this.getCallId()
        });
      } catch (e) {
        logger.error('[VideoCallSession] Ошибка обработки call:accepted:', e);
        this.emit('callAccepted', data);
      }
    });
    
    socket.on('call:declined', (data: any) => {
      // Обработка отклонения звонка
      this.emit('callDeclined', data);
    });
    
    socket.on('call:ended', (data: any) => {
      // Обработка завершения звонка
      this.endCall();
    });
    
    // КРИТИЧНО: Обработчик peer:connected для сохранения socketId пира
    socket.on('peer:connected', (data: any) => {
      try {
        if (data.peerId && typeof data.peerId === 'string') {
          this.setPartnerSocketId(data.peerId);
          logger.info('[VideoCallSession] PartnerSocketId установлен из peer:connected', { socketId: data.peerId });
        }
      } catch (e) {
        logger.error('[VideoCallSession] Ошибка обработки peer:connected:', e);
      }
    });
  }
  
  /**
   * Переопределяем handleOffer для видеозвонков
   * Добавляем специфичную логику для дружеских звонков
   */
  protected async handleOffer({ from, offer, fromUserId, roomId }: { from: string; offer: any; fromUserId?: string; roomId?: string }): Promise<void> {
    // КРИТИЧНО: Устанавливаем partnerId из fromUserId для receiver
    if (fromUserId && !this.getPartnerId()) {
      this.setPartnerId(fromUserId);
      logger.info('[VideoCallSession] PartnerId установлен из offer', { fromUserId });
    }
    
    // КРИТИЧНО: Сохраняем socketId пира из offer для ICE кандидатов
    if (from && typeof from === 'string') {
      this.setPartnerSocketId(from);
      logger.info('[VideoCallSession] PartnerSocketId установлен из offer', { socketId: from });
    }
    
    // КРИТИЧНО: Устанавливаем roomId если он пришел в offer
    if (roomId && !this.getRoomId()) {
      this.setRoomId(roomId);
      logger.info('[VideoCallSession] RoomId установлен из offer', { roomId });
      
      // Присоединяемся к комнате если еще не присоединились
      if (!this.roomJoinedRef.has(roomId)) {
        try {
          socket.emit('room:join:ack', { roomId });
          this.roomJoinedRef.add(roomId);
          logger.info('[VideoCallSession] Присоединились к комнате из offer', { roomId });
        } catch (e) {
          logger.error('[VideoCallSession] Ошибка присоединения к комнате из offer:', e);
        }
      }
      
      // КРИТИЧНО: Отправляем начальное состояние камеры после установки roomId
      // Это гарантирует, что партнер получит правильное состояние камеры при установке соединения
      setTimeout(() => {
        const stream = this.streamManager.getLocalStream();
        if (stream) {
          const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            const isEnabled = videoTrack.enabled ?? true;
            logger.info('[VideoCallSession] Отправляем начальное состояние камеры после установки roomId из offer', {
              roomId,
              enabled: isEnabled
            });
            this.sendCameraState(undefined, isEnabled);
          }
        }
      }, 200);
    }
    
    // Вызываем базовую реализацию
    await super.handleOffer({ from, offer, fromUserId, roomId });
  }
  
  /**
   * Переопределяем handleAnswer для видеозвонков
   * Добавляем специфичную логику для дружеских звонков
   */
  protected async handleAnswer({ from, answer, roomId }: { from: string; answer: any; roomId?: string }): Promise<void> {
    // КРИТИЧНО: Устанавливаем roomId если он пришел в answer
    if (roomId && !this.getRoomId()) {
      this.setRoomId(roomId);
      logger.info('[VideoCallSession] RoomId установлен из answer', { roomId });
    }
    
    // КРИТИЧНО: Сохраняем socketId пира из answer для ICE кандидатов
    if (from && typeof from === 'string') {
      this.setPartnerSocketId(from);
      logger.info('[VideoCallSession] PartnerSocketId установлен из answer', { socketId: from });
    }
    
    // Вызываем базовую реализацию
    await super.handleAnswer({ from, answer, roomId });
  }
  
  /**
   * Переопределяем createAndSendAnswer для видеозвонков
   * НЕ используем оптимизацию SDP, чтобы избежать ошибки "SessionDescription is NULL"
   */
  protected async createAndSendAnswer(from: string, roomId?: string): Promise<void> {
    const pc = this.peerRef;
    if (!pc) {
      logger.warn('[VideoCallSession] No PC for createAndSendAnswer');
      return;
    }
    
    // КРИТИЧНО: Проверяем что PC валиден
    if (!this.isPcValid(pc)) {
      logger.warn('[VideoCallSession] PC is invalid for createAndSendAnswer');
      return;
    }
    
    // КРИТИЧНО: Проверяем что answer еще не был создан
    const hasLocalDesc = !!(pc as any).localDescription;
    const hasRemoteDesc = !!(pc as any).remoteDescription;
    if (hasLocalDesc && hasRemoteDesc) {
      logger.warn('[VideoCallSession] Answer already created - PC is in stable state', { 
        signalingState: pc.signalingState 
      });
      return;
    }
    
    try {
      // Проверяем состояние
      const currentState = pc.signalingState;
      if (currentState !== 'have-remote-offer') {
        logger.warn('[VideoCallSession] PC not in have-remote-offer state', { 
          state: currentState,
          hasLocalDesc,
          hasRemoteDesc
        });
        return;
      }
      
      // Создаем answer
      const answer = await pc.createAnswer();
      
      // КРИТИЧНО: Проверяем что answer валиден
      if (!answer || !answer.sdp) {
        logger.error('[VideoCallSession] ❌❌❌ CRITICAL: Answer is NULL or has no SDP!');
        return;
      }
      
      // КРИТИЧНО: Для видеозвонков НЕ используем оптимизацию SDP
      // Оптимизация может нарушить структуру SDP и вызвать ошибку "SessionDescription is NULL"
      const finalAnswer = answer;
      
      // Проверяем состояние еще раз перед setLocalDescription
      const finalState = pc.signalingState;
      const currentHasLocalDesc = !!(pc as any).localDescription;
      const currentHasRemoteDesc = !!(pc as any).remoteDescription;
      
      // КРИТИЧНО: Если PC уже в stable, answer уже был создан и установлен
      if (finalState === 'stable') {
        logger.info('[VideoCallSession] ✅ PC already in stable state before setLocalDescription for answer - answer already processed', {
          state: finalState,
          hasLocalDesc: currentHasLocalDesc,
          hasRemoteDesc: currentHasRemoteDesc
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем что состояние не изменилось
      if (finalState !== 'have-remote-offer') {
        logger.warn('[VideoCallSession] ⚠️ PC not in have-remote-offer state before setLocalDescription for answer', { 
          state: finalState,
          hasLocalDesc: currentHasLocalDesc,
          hasRemoteDesc: currentHasRemoteDesc
        });
        return;
      }
      
      // КРИТИЧНО: Если localDescription уже установлен, не устанавливаем снова
      if (currentHasLocalDesc) {
        logger.info('[VideoCallSession] ✅ Local description already set, skipping setLocalDescription for answer');
        return;
      }
      
      // Проверяем что PC все еще валиден
      if (!this.isPcValid(pc)) {
        logger.warn('[VideoCallSession] ⚠️ PC became invalid before setLocalDescription for answer');
        return;
      }
      
      // КРИТИЧНО: Финальная проверка непосредственно перед setLocalDescription
      const immediateState = pc.signalingState;
      const immediateHasLocalDesc = !!(pc as any).localDescription;
      if (immediateState === 'stable' || immediateHasLocalDesc) {
        logger.info('[VideoCallSession] ✅ PC already in stable or has localDescription IMMEDIATELY before setLocalDescription - skipping', {
          state: immediateState,
          hasLocalDesc: immediateHasLocalDesc
        });
        return;
      }
      
      // Устанавливаем local description
      try {
        await pc.setLocalDescription(finalAnswer);
        
        // Проверяем что localDescription установлен
        const localDesc = (pc as any).localDescription;
        if (!localDesc) {
          logger.error('[VideoCallSession] ❌❌❌ CRITICAL: localDescription is NULL after setLocalDescription for answer!');
          return;
        }
      } catch (setError: any) {
        const errorMsg = String(setError?.message || '');
        const errorState = pc.signalingState;
        const errorHasLocalDesc = !!(pc as any).localDescription;
        
        // КРИТИЧНО: Если ошибка "wrong state: stable", это значит answer уже был установлен
        if (errorMsg.includes('wrong state') && errorMsg.includes('stable')) {
          logger.info('[VideoCallSession] ✅ Answer already processed (PC in stable) - ignoring error', {
            error: errorMsg,
            signalingState: errorState,
            hasLocalDesc: errorHasLocalDesc
          });
          return;
        }
        
        if (errorMsg.includes('NULL') || errorMsg.includes('SessionDescription')) {
          logger.error('[VideoCallSession] ❌❌❌ CRITICAL: setLocalDescription failed with NULL error for answer!', setError);
          return;
        } else {
          throw setError;
        }
      }
      
      // Отправляем answer
      const currentRoomId = roomId ?? this.getRoomId() ?? undefined;
      const answerPayload: any = {
        to: from,
        answer: finalAnswer,
        fromUserId: this.config.myUserId
      };
      
      if (currentRoomId) {
        answerPayload.roomId = currentRoomId;
      }
      
      socket.emit('answer', answerPayload);
      logger.info('[VideoCallSession] Answer sent successfully', { to: from, roomId: currentRoomId });
      
      // Прожигаем отложенные ICE кандидаты
      await this.flushIceFor(from);
    } catch (e) {
      logger.error('[VideoCallSession] Error creating/sending answer:', e);
    }
  }
  
  /**
   * Переопределяем createAndSendOffer для видеозвонков
   * Используем roomId для видеозвонков
   */
  protected async createAndSendOffer(toPartnerId: string, roomId?: string): Promise<void> {
    const pc = this.getPeerConnection();
    if (!pc) {
      logger.warn('[VideoCallSession] No PC for createAndSendOffer');
      return;
    }
    
    // КРИТИЧНО: Проверяем что PC валиден
    if (!this.isPcValid(pc)) {
      logger.warn('[VideoCallSession] PC is invalid for createAndSendOffer');
      return;
    }
    
    try {
      // Проверяем состояние PC
      const state = pc.signalingState;
      const hasLocalDesc = !!(pc as any)?.localDescription;
      const hasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      // КРИТИЧНО: Если PC уже в stable с обоими SDP, offer уже был отправлен
      if (state === 'stable' && hasLocalDesc && hasRemoteDesc) {
        logger.warn('[VideoCallSession] PC already in stable state, offer already sent', { 
          state,
          hasLocalDesc,
          hasRemoteDesc
        });
        return;
      }
      
      if (state !== 'stable') {
        logger.warn('[VideoCallSession] PC not stable for createOffer', { 
          state,
          hasLocalDesc,
          hasRemoteDesc
        });
        return;
      }
      
      if (hasLocalDesc || hasRemoteDesc) {
        logger.warn('[VideoCallSession] PC already has description', { hasLocalDesc, hasRemoteDesc });
        return;
      }
      
      // КРИТИЧНО: Проверяем что треки добавлены в PC
      // Без треков offer будет sendonly → собеседник не услышит и не увидит
      const senders = pc.getSenders?.() || [];
      const hasTracks = senders.length > 0;
      
      if (!hasTracks) {
        logger.error('[VideoCallSession] ❌❌❌ КРИТИЧЕСКАЯ ОШИБКА: Нет треков в PC перед createOffer! Это приведет к sendonly!');
        
        // КРИТИЧНО: СРОЧНО добавляем треки из локального стрима
        // Используем простой и надежный способ, как указано в требованиях
        const stream = this.streamManager.getLocalStream();
        if (stream) {
          logger.info('[VideoCallSession] 🔧 СРОЧНО добавляем треки в PC перед createOffer', {
            streamId: stream.id,
            totalTracks: stream.getTracks?.()?.length || 0
          });
          
          // КРИТИЧНО: Простой и надежный способ - добавляем все треки через addTrack
          const allTracks = stream.getTracks?.() || [];
          allTracks.forEach((track: any) => {
            if (track && track.readyState !== 'ended') {
              try {
                // КРИТИЧНО: Используем стандартный метод addTrack с stream
                (pc as any).addTrack(track, stream);
                logger.info('[VideoCallSession] ✅ Трек добавлен в PC перед createOffer', {
                  trackId: track.id,
                  trackKind: track.kind || (track as any).type
                });
              } catch (e) {
                logger.error('[VideoCallSession] ❌ Ошибка добавления трека в PC перед createOffer', {
                  trackId: track.id,
                  trackKind: track.kind || (track as any).type,
                  error: e
                });
              }
            }
          });
          
          // Проверяем результат
          const finalSenders = pc.getSenders?.() || [];
          if (finalSenders.length === 0) {
            logger.error('[VideoCallSession] ❌❌❌ КРИТИЧЕСКАЯ ОШИБКА: Не удалось добавить треки в PC! Offer будет sendonly!');
          } else {
            logger.info('[VideoCallSession] ✅ Треки успешно добавлены в PC перед createOffer', {
              sendersCount: finalSenders.length,
              expectedTracks: allTracks.length
            });
          }
        } else {
          logger.error('[VideoCallSession] ❌❌❌ КРИТИЧЕСКАЯ ОШИБКА: Нет локального стрима для добавления треков!');
        }
      } else {
        logger.info('[VideoCallSession] ✅ Треки уже есть в PC перед createOffer', {
          sendersCount: senders.length,
          sendersDetails: senders.map((s: any) => ({
            trackId: s.track?.id,
            trackKind: s.track?.kind || (s.track as any)?.type
          }))
        });
      }
      
      // Проверяем что треки не ended
      const endedTracks = senders.filter((s: any) => {
        const track = s.track;
        return track && track.readyState === 'ended';
      });
      if (endedTracks.length > 0) {
        logger.error('[VideoCallSession] ❌❌❌ CRITICAL: Tracks are ended before createOffer!', { endedCount: endedTracks.length });
      }
      
      // Создаем offer
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true, 
        offerToReceiveVideo: true,
        voiceActivityDetection: false,
      } as any);
      
      // КРИТИЧНО: Проверяем что offer валиден
      if (!offer || !offer.sdp) {
        logger.error('[VideoCallSession] ❌❌❌ CRITICAL: Offer is NULL or has no SDP!');
        return;
      }
      
      // КРИТИЧНО: Для видеозвонков НЕ используем оптимизацию SDP
      // Оптимизация может нарушить структуру SDP и вызвать ошибку "SessionDescription is NULL"
      // Используем оригинальный offer напрямую
      const finalOffer = offer;
      
      // Проверяем состояние еще раз перед setLocalDescription
      const currentState = pc.signalingState;
      if (currentState !== 'stable') {
        logger.warn('[VideoCallSession] PC state changed between createOffer and setLocalDescription', { state: currentState });
        return;
      }
      
      // Проверяем что PC все еще валиден
      if (!this.isPcValid(pc)) {
        logger.warn('[VideoCallSession] PC became invalid before setLocalDescription');
        return;
      }
      
      // КРИТИЧНО: Проверяем что offer все еще валиден перед setLocalDescription
      if (!finalOffer || !finalOffer.sdp || finalOffer.sdp.trim().length === 0) {
        logger.error('[VideoCallSession] ❌❌❌ CRITICAL: Offer became invalid before setLocalDescription!');
        return;
      }
      
      // Устанавливаем local description
      try {
        await pc.setLocalDescription(finalOffer);
        this.markPcWithToken(pc);
        
        // Проверяем что localDescription установлен
        const localDesc = (pc as any).localDescription;
        if (!localDesc) {
          logger.error('[VideoCallSession] ❌❌❌ CRITICAL: localDescription is NULL after setLocalDescription!');
          return;
        }
      } catch (setError: any) {
        const errorMsg = String(setError?.message || '');
        if (errorMsg.includes('NULL') || errorMsg.includes('SessionDescription')) {
          logger.error('[VideoCallSession] ❌❌❌ CRITICAL: setLocalDescription failed with NULL error!', setError);
          
          // Пытаемся повторить без оптимизации SDP
          try {
            logger.info('[VideoCallSession] Retrying setLocalDescription with original offer (no optimization)');
            await pc.setLocalDescription(offer);
            this.markPcWithToken(pc);
          } catch (retryError) {
            logger.error('[VideoCallSession] Retry also failed:', retryError);
            return;
          }
        } else {
          throw setError;
        }
      }
      
      // Отправляем offer с roomId
      const currentRoomId = roomId ?? this.getRoomId() ?? undefined;
      
      // КРИТИЧНО: Проверяем что есть хотя бы to или roomId
      if (!toPartnerId && !currentRoomId) {
        logger.error('[VideoCallSession] ❌ Cannot send offer - no toPartnerId and no roomId!');
        return;
      }
      
      const offerPayload: any = {
        offer: finalOffer,
        fromUserId: this.config.myUserId
      };
      
      // КРИТИЧНО: Добавляем to только если есть partnerId
      if (toPartnerId) {
        offerPayload.to = toPartnerId;
      }
      
      // КРИТИЧНО: roomId обязателен для видеозвонков
      if (currentRoomId) {
        offerPayload.roomId = currentRoomId;
      } else {
        logger.warn('[VideoCallSession] ⚠️ Sending offer without roomId - delivery may fail!');
      }
      
      logger.info('[VideoCallSession] 📤 Sending offer', { 
        to: toPartnerId || 'none', 
        roomId: currentRoomId || 'none',
        hasOffer: !!finalOffer,
        hasSdp: !!finalOffer?.sdp
      });
      
      socket.emit('offer', offerPayload);
      logger.info('[VideoCallSession] ✅ Offer sent successfully', { to: toPartnerId, roomId: currentRoomId });
    } catch (e) {
      logger.error('[VideoCallSession] Error creating/sending offer:', e);
    }
  }
  
  /**
   * Восстановить состояние звонка (для возврата из PiP или восстановления после разрыва)
   */
  restoreCallState(params: {
    roomId?: string | null;
    partnerId?: string | null;
    callId?: string | null;
    partnerUserId?: string | null;
    returnToActiveCall?: boolean;
    isFromBackground?: boolean;
  }): void {
    const { roomId, partnerId, callId, partnerUserId, returnToActiveCall, isFromBackground } = params;
    
    const isFriendCall = this.isFriendCall();
    const isInactiveState = this.config.getIsInactiveState?.() ?? false;
    const wasFriendCallEnded = this.config.getWasFriendCallEnded?.() ?? false;
    
    // КРИТИЧНО: Если это возврат из PiP (returnToActiveCall === true), 
    // НЕ проверяем isInactiveState - восстанавливаем состояние в любом случае
    if (!returnToActiveCall && (isInactiveState || wasFriendCallEnded)) {
      logger.debug('[VideoCallSession] restoreCallState: Call is inactive, skipping restore', {
        isInactiveState,
        wasFriendCallEnded,
        returnToActiveCall
      });
      return;
    }
    
    // КРИТИЧНО: Для возврата из PiP (returnToActiveCall === true) 
    // проверяем наличие хотя бы roomId или callId
    // Для обычного восстановления требуем все идентификаторы
    const hasActiveRefs = (roomId || this.roomIdRef) && (partnerId || this.partnerIdRef) && (partnerUserId || this.partnerIdRef);
    const hasActiveCallId = callId || this.callIdRef;
    const hasMinimalRefs = (roomId || this.roomIdRef) || (callId || this.callIdRef);
    
    if (returnToActiveCall) {
      // Для возврата из PiP достаточно иметь roomId или callId
      if (!hasMinimalRefs) {
        logger.debug('[VideoCallSession] restoreCallState: No minimal refs for returnToActiveCall', {
          roomId: roomId || this.roomIdRef,
          callId: callId || this.callIdRef
        });
        return;
      }
    } else {
      // Для обычного восстановления требуем все идентификаторы
      if (!hasActiveRefs || !hasActiveCallId) {
        logger.debug('[VideoCallSession] restoreCallState: Missing required refs', {
          hasActiveRefs,
          hasActiveCallId
        });
        return;
      }
    }
    
    // Восстанавливаем идентификаторы если они были переданы
    // КРИТИЧНО: Для возврата из PiP устанавливаем идентификаторы даже если они уже установлены
    if (roomId) {
      this.setRoomId(roomId);
    }
    if (partnerId) {
      this.setPartnerId(partnerId);
    }
    if (callId) {
      this.setCallId(callId);
    }
    
    // Обновляем состояние через конфиг
    this.config.setStarted?.(true);
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    
    // Эмитим событие восстановления
    this.emit('callStateRestored', { roomId, partnerId, callId, returnToActiveCall });
  }
  
  /**
   * Полная очистка сессии (для размонтирования компонента)
   */
  destroy(): void {
    // Вызываем cleanup для полной очистки
    this.cleanup();
  }
}
