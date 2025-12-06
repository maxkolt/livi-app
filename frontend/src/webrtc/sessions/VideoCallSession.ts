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
    // Защита от множественного создания PC
    if (this.pcCreationInProgressRef) {
      let attempts = 0;
      while (this.pcCreationInProgressRef && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      if (this.peerRef && this.peerRef.signalingState !== 'closed') {
        return this.peerRef;
      }
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
    
    // КРИТИЧНО: Для дружеских звонков НЕ пересоздаем PC, если он уже существует
    if (pc) {
      try {
        const state = pc.signalingState;
        const hasLocalDesc = !!(pc as any)?.currentLocalDescription || !!(pc as any)?.localDescription;
        const hasRemoteDesc = !!(pc as any)?.currentRemoteDescription || !!(pc as any)?.remoteDescription;
        const hasNoDescriptions = !hasLocalDesc && !hasRemoteDesc;
        const isInitial = state === 'stable' && hasNoDescriptions;
        const isClosed = state === 'closed' || (pc as any).connectionState === 'closed';
        
        if (isClosed) {
          try {
            this.cleanupPeer(pc);
          } catch (e) {
            logger.warn('[VideoCallSession] Error cleaning up closed PC:', e);
          }
          pc = null;
          this.peerRef = null;
        } else {
          // Для дружеских звонков ВСЕГДА переиспользуем существующий PC
          this.markPcWithToken(pc);
          return pc;
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Cannot access PC state:', e);
      }
    }
    
    // Создание нового PC
    if (!pc) {
      try {
        if (!stream || !isValidStream(stream)) {
          logger.error('[VideoCallSession] Cannot create PC - stream is invalid');
          return null;
        }
        
        const iceConfig = this.getIceConfig();
        
        // Для прямых звонков используем задержки для стабильности
        const lastPcClosedAt = (global as any).__lastPcClosedAt;
        if (lastPcClosedAt) {
          const timeSinceClose = Date.now() - lastPcClosedAt;
          const PC_CREATION_DELAY = 2000;
          if (timeSinceClose < PC_CREATION_DELAY) {
            const delay = PC_CREATION_DELAY - timeSinceClose;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        this.pcCreationInProgressRef = true;
        
        try {
          pc = new RTCPeerConnection(iceConfig);
          this.peerRef = pc;
          this.pcCreationInProgressRef = false;
          
          this.incrementPcToken(true);
          this.markPcWithToken(pc);
          
          // Устанавливаем обработчики
          this.bindConnHandlers(pc, this.partnerIdRef || undefined);
          this.attachRemoteHandlers(pc, this.partnerIdRef || undefined);
        } catch (createError: any) {
          this.pcCreationInProgressRef = false;
          logger.error('[VideoCallSession] RTCPeerConnection constructor failed:', createError);
          (global as any).__lastPcClosedAt = Date.now();
          throw createError;
        }
      } catch (e) {
        this.pcCreationInProgressRef = false;
        logger.error('[VideoCallSession] Failed to create PeerConnection:', e);
        (global as any).__lastPcClosedAt = Date.now();
        return null;
      }
    }
    
    // Добавляем треки в PC
    const senders: RTCRtpSender[] = (pc.getSenders?.() || []) as any;
    const audioTracks = stream?.getAudioTracks?.() || [];
    const videoTracks = stream?.getVideoTracks?.() || [];
    
    for (const track of [...audioTracks, ...videoTracks]) {
      if (track && (track as any).readyState !== 'ended') {
        const sameKind = senders.find((s: any) => s?.track?.kind === (track as any).kind);
        if (sameKind) {
          try {
            sameKind.replaceTrack(track as any);
          } catch (e) {
            logger.error('[VideoCallSession] Error replacing track:', e);
          }
        } else {
          try {
            (pc as any).addTrack?.(track as any, stream as any);
          } catch (e) {
            logger.error('[VideoCallSession] Error adding track:', e);
          }
        }
      }
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
    
    if (this.localStreamRef !== stream) {
      this.localStreamRef = stream;
      this.config.callbacks.onLocalStreamChange?.(stream);
      this.config.onLocalStreamChange?.(stream);
      this.emit('localStream', stream);
    }
    
    // Создаем и отправляем offer
    // roomId будет установлен в call:accepted
    await this.createAndSendOffer(friendId);
  }
  
  /**
   * Принять входящий звонок
   */
  async acceptCall(callId?: string): Promise<void> {
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    
    let stream = this.localStreamRef;
    if (!stream) {
      stream = await this.startLocalStream('front');
      if (!stream) {
        throw new Error('Failed to start local stream for accepting call');
      }
    }
    
    let pc = this.peerRef;
    if (!pc) {
      pc = await this.ensurePcWithLocal(stream);
      if (pc && this.partnerIdRef) {
        this.attachRemoteHandlers(pc, this.partnerIdRef);
      }
    }
    
    try {
      const acceptPayload: any = { callId: callId || this.callIdRef };
      if (this.partnerIdRef) {
        acceptPayload.to = this.partnerIdRef;
      }
      socket.emit('call:accept', acceptPayload);
    } catch (e) {
      logger.error('[VideoCallSession] Error sending call:accept', e);
    }
    
    this.config.setStarted?.(true);
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
    
    // Очистка
    if (this.peerRef) {
      this.incrementPcToken();
    }
    
    this.stopLocalStreamInternal();
    
    if (this.remoteStreamRef) {
      try {
        const tracks = this.remoteStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          } catch {}
        });
      } catch {}
      this.remoteStreamRef = null;
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.emit('remoteStream', null);
    }
    
    this.stopMicMeter();
    
    if (this.peerRef) {
      try {
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Error closing PC:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    
    // Сброс флагов
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    
    this.setPartnerId(null);
    this.setRoomId(null);
    this.setCallId(null);
    
    this.emit('callEnded');
  }
  
  /**
   * Очистка ресурсов
   */
  cleanup(): void {
    // Останавливаем локальный стрим
    this.stopLocalStreamInternal();
    
    // Останавливаем удаленный стрим
    if (this.remoteStreamRef) {
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
    this.setRoomId(null);
    this.setCallId(null);
    
    // Удаляем AppState listener если есть
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    
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
      isEnabled = videoTrack?.enabled ?? true;
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
    
    socket.on('call:accepted', (data: any) => {
      // Обработка принятия звонка
      this.emit('callAccepted', data);
    });
    
    socket.on('call:declined', (data: any) => {
      // Обработка отклонения звонка
      this.emit('callDeclined', data);
    });
    
    socket.on('call:ended', (data: any) => {
      // Обработка завершения звонка
      this.endCall();
    });
  }
  
  /**
   * Переопределяем handleOffer для видеозвонков
   * Добавляем специфичную логику для дружеских звонков
   */
  protected async handleOffer({ from, offer, fromUserId, roomId }: { from: string; offer: any; fromUserId?: string; roomId?: string }): Promise<void> {
    // Устанавливаем partnerId из fromUserId для receiver
    if (fromUserId && !this.getPartnerId()) {
      this.setPartnerId(fromUserId);
    }
    
    // Вызываем базовую реализацию
    await super.handleOffer({ from, offer, fromUserId, roomId });
  }
  
  /**
   * Переопределяем handleAnswer для видеозвонков
   * Добавляем специфичную логику для дружеских звонков
   */
  protected async handleAnswer({ from, answer, roomId }: { from: string; answer: any; roomId?: string }): Promise<void> {
    // Вызываем базовую реализацию
    await super.handleAnswer({ from, answer, roomId });
  }
  
  /**
   * Переопределяем createAndSendOffer для видеозвонков
   * Используем roomId для видеозвонков
   */
  protected async createAndSendOffer(toPartnerId: string, roomId?: string): Promise<void> {
    const pc = this.getPeerConnection();
    if (!pc) {
      return;
    }
    
    try {
      // Проверяем состояние PC
      const state = pc.signalingState;
      if (state !== 'stable') {
        return;
      }
      
      const hasLocalDesc = !!(pc as any)?.localDescription;
      const hasRemoteDesc = !!(pc as any)?.remoteDescription;
      if (hasLocalDesc || hasRemoteDesc) {
        return;
      }
      
      // Создаем offer
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true, 
        offerToReceiveVideo: true,
        voiceActivityDetection: false,
      } as any);
      
      // Оптимизация SDP
      if (offer.sdp) {
        offer.sdp = this.optimizeSdpForFastConnection(offer.sdp);
      }
      
      // Устанавливаем local description
      await pc.setLocalDescription(offer);
      this.markPcWithToken(pc);
      
      // Отправляем offer с roomId
      const currentRoomId = roomId || this.getRoomId();
      const offerPayload: any = {
        to: toPartnerId,
        offer,
        fromUserId: this.config.myUserId
      };
      
      if (currentRoomId) {
        offerPayload.roomId = currentRoomId;
      }
      
      socket.emit('offer', offerPayload);
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

