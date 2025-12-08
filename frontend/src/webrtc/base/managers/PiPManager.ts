import { MediaStream } from 'react-native-webrtc';
import { logger } from '../../../../utils/logger';
import socket from '../../../../sockets/socket';
import { isValidStream } from '../../../../utils/streamUtils';
import type { WebRTCSessionConfig } from '../../types';

/**
 * Менеджер Picture-in-Picture
 * Управляет входом/выходом из PiP, сохранением состояния камеры и синхронизацией с партнером
 */
export class PiPManager {
  private isInPiPRef: boolean = false;
  private pipPrevCamOnRef: boolean | null = null;
  private remoteInPiPRef: boolean = false;
  private userManuallyDisabledCameraRef: boolean = false; // Флаг: пользователь сам выключил камеру
  private config: WebRTCSessionConfig;

  constructor(config: WebRTCSessionConfig) {
    this.config = config;
  }

  // ==================== PiP State ====================

  /**
   * Получить состояние PiP
   */
  isInPiP(): boolean {
    return this.isInPiPRef;
  }

  /**
   * Установить состояние PiP
   */
  setInPiP(inPiP: boolean): void {
    this.isInPiPRef = inPiP;
  }

  /**
   * Получить состояние удаленного PiP
   */
  isRemoteInPiP(): boolean {
    return this.remoteInPiPRef;
  }

  /**
   * Установить состояние удаленного PiP
   */
  setRemoteInPiP(inPiP: boolean): void {
    this.remoteInPiPRef = inPiP;
  }

  // ==================== PiP Operations ====================

  /**
   * Войти в режим Picture-in-Picture
   * НЕ выключает камеру - она остается в режиме ожидания/сна
   * НЕ выключает микрофон - звук продолжает работать
   * Камера будет восстановлена при выходе из PiP, если пользователь сам ее не выключил
   */
  enterPiP(
    isFriendCall: () => boolean,
    roomId: string | null,
    partnerId: string | null,
    localStream: MediaStream | null,
    emit: (event: string, ...args: any[]) => void
  ): void {
    if (!isFriendCall() || !roomId) {
      return;
    }
    
    // Сохраняем состояние камеры, но НЕ выключаем ее
    // Камера остается включенной в режиме ожидания/сна
    // Микрофон НЕ трогаем - звук продолжает работать
    if (localStream) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      const audioTrack = (localStream as any)?.getAudioTracks?.()?.[0];
      
      if (videoTrack) {
        // Сохраняем состояние камеры перед входом в PiP
        this.pipPrevCamOnRef = videoTrack.enabled;
        // Сбрасываем флаг ручного выключения - при входе в PiP камера не выключается
        this.userManuallyDisabledCameraRef = false;
        
        logger.info('[PiPManager] Вход в PiP - камера остается включенной', {
          cameraWasEnabled: videoTrack.enabled,
          savedState: this.pipPrevCamOnRef,
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackState: audioTrack?.readyState
        });
      }
      
      // Убеждаемся, что микрофон включен в PiP
      if (audioTrack && !audioTrack.enabled) {
        audioTrack.enabled = true;
        logger.info('[PiPManager] Микрофон включен при входе в PiP (должен работать)');
      }
    }
    
    this.setInPiP(true);
    emit('pipStateChanged', { inPiP: true });
    // Отправляем только pip:state, НЕ отправляем cam-toggle(false)
    // Это позволяет партнеру знать, что мы в PiP, но камера работает
    this.sendPiPState(true, roomId, partnerId);
  }

  /**
   * Выйти из режима Picture-in-Picture
   * Восстанавливает локальную камеру и уведомляет партнера
   * Микрофон уже работает, его не нужно восстанавливать
   */
  exitPiP(
    isFriendCall: () => boolean,
    roomId: string | null,
    partnerId: string | null,
    localStream: MediaStream | null,
    emit: (event: string, ...args: any[]) => void,
    setLocalStream: (stream: MediaStream | null) => void,
    setRemoteStream: (stream: MediaStream | null) => void
  ): void {
    if (!isFriendCall() || !roomId) {
      return;
    }
    
    this.setInPiP(false);
    emit('pipStateChanged', { inPiP: false });
    this.sendPiPState(false, roomId, partnerId);
    
    // Восстанавливаем локальный стрим из PiP контекста если он есть
    // Приоритет: PiP стрим > текущий стрим (PiP стрим более актуален)
    const pipLocalStream = this.config.getPipLocalStream?.();
    let streamToRestore = localStream;
    
    // Если есть стрим в PiP, используем его (он более актуален)
    // Это важно, так как при выходе из PiP локальный стрим может быть потерян
    if (pipLocalStream && isValidStream(pipLocalStream)) {
      streamToRestore = pipLocalStream;
      setLocalStream(streamToRestore);
      logger.info('[PiPManager] Локальный стрим восстановлен из PiP контекста', {
        hasVideoTrack: !!(streamToRestore as any)?.getVideoTracks?.()?.[0],
        hasAudioTrack: !!(streamToRestore as any)?.getAudioTracks?.()?.[0],
        videoTrackEnabled: (streamToRestore as any)?.getVideoTracks?.()?.[0]?.enabled,
        audioTrackEnabled: (streamToRestore as any)?.getAudioTracks?.()?.[0]?.enabled,
        videoTrackReadyState: (streamToRestore as any)?.getVideoTracks?.()?.[0]?.readyState
      });
    } else if (localStream && isValidStream(localStream)) {
      // Локальный стрим уже есть, просто обновляем его в session
      setLocalStream(localStream);
      logger.info('[PiPManager] Локальный стрим уже существует, обновляем в session');
    } else {
      logger.warn('[PiPManager] Локальный стрим не найден ни в PiP, ни в session - видео может не отображаться');
    }
    
    this.restoreLocalCamera(streamToRestore, roomId);
    
    // Убеждаемся, что микрофон остается включенным при выходе из PiP
    if (streamToRestore) {
      const audioTrack = (streamToRestore as any)?.getAudioTracks?.()?.[0];
      if (audioTrack && !audioTrack.enabled) {
        audioTrack.enabled = true;
        logger.info('[PiPManager] Микрофон включен при выходе из PiP');
      }
    }
    
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      setRemoteStream(pipRemoteStream);
    }
  }

  /**
   * Восстановить локальную камеру после выхода из PiP
   * Восстанавливает камеру только если пользователь сам ее не выключил
   */
  private restoreLocalCamera(localStream: MediaStream | null, roomId: string | null): void {
    if (!localStream) {
      logger.warn('[PiPManager] restoreLocalCamera: нет локального стрима');
      return;
    }
    
    const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
    if (!videoTrack) {
      logger.warn('[PiPManager] restoreLocalCamera: нет видео трека');
      return;
    }
    
    // Если pipPrevCamOnRef не установлен, но трек live - считаем что камера была включена
    // Это важно для случаев, когда pipPrevCamOnRef может быть потерян
    const wasEnabled = this.pipPrevCamOnRef === true || (this.pipPrevCamOnRef === null && videoTrack.readyState === 'live');
    
    // Восстанавливаем камеру только если:
    // 1. Камера была включена перед входом в PiP (wasEnabled === true)
    // 2. Пользователь сам не выключил камеру (userManuallyDisabledCameraRef === false)
    const shouldEnable = wasEnabled && !this.userManuallyDisabledCameraRef;
    
    if (shouldEnable) {
      // Включаем камеру если она была включена перед входом в PiP
      if (!videoTrack.enabled) {
        videoTrack.enabled = true;
      }
      // Обновляем состояние камеры через callbacks
      this.config.callbacks.onCamStateChange?.(true);
      this.config.onCamStateChange?.(true);
      this.sendCamToggle(true, roomId);
      logger.info('[PiPManager] Камера восстановлена после выхода из PiP', {
        videoTrackEnabled: videoTrack.enabled,
        videoTrackReadyState: videoTrack.readyState,
        wasEnabled: this.pipPrevCamOnRef,
        inferredWasEnabled: this.pipPrevCamOnRef === null && videoTrack.readyState === 'live',
        userDisabled: this.userManuallyDisabledCameraRef
      });
    } else if (!shouldEnable) {
      // Если камера была выключена пользователем, не восстанавливаем
      logger.info('[PiPManager] Камера не восстановлена - была выключена пользователем', {
        wasEnabled: this.pipPrevCamOnRef,
        userDisabled: this.userManuallyDisabledCameraRef
      });
    }
    
    // Сбрасываем состояние после восстановления
    this.pipPrevCamOnRef = null;
    this.userManuallyDisabledCameraRef = false;
  }
  
  /**
   * Отметить, что пользователь сам выключил камеру
   * Это предотвращает автоматическое восстановление камеры при выходе из PiP
   */
  markCameraManuallyDisabled(): void {
    this.userManuallyDisabledCameraRef = true;
    logger.info('[PiPManager] Камера выключена пользователем вручную');
  }

  /**
   * Отправить cam-toggle событие партнеру
   */
  private sendCamToggle(enabled: boolean, roomId: string | null): void {
    try {
      const payload: any = { enabled, from: socket.id };
      if (roomId) {
        payload.roomId = roomId;
      }
      socket.emit('cam-toggle', payload);
    } catch (e) {
      logger.warn('[PiPManager] Error emitting cam-toggle:', e);
    }
  }

  /**
   * Отправить pip:state событие партнеру
   */
  private sendPiPState(inPiP: boolean, roomId: string | null, partnerId: string | null): void {
    try {
      const payload: any = {
        inPiP,
        roomId: roomId,
        from: socket.id
      };
      if (partnerId) {
        payload.to = partnerId;
      }
      socket.emit('pip:state', payload);
      setTimeout(() => {
        try { socket.emit('pip:state', payload); } catch {}
      }, 300);
    } catch (e) {
      logger.warn('[PiPManager] Error emitting pip:state:', e);
    }
  }

  /**
   * Возобновить из PiP
   * Восстанавливает сохраненные стримы из конфигурации
   */
  resumeFromPiP(
    setLocalStream: (stream: MediaStream | null) => void,
    setRemoteStream: (stream: MediaStream | null) => void
  ): void {
    const pipLocalStream = this.config.getPipLocalStream?.();
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    
    if (pipLocalStream && isValidStream(pipLocalStream)) {
      setLocalStream(pipLocalStream);
    }
    
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      setRemoteStream(pipRemoteStream);
    }
    
    this.isInPiPRef = false;
  }

  /**
   * Обработать событие pip:state от партнера
   */
  handlePiPState(
    data: { inPiP: boolean; from: string; roomId: string },
    partnerId: string | null,
    roomId: string | null,
    emit: (event: string, ...args: any[]) => void
  ): void {
    const { inPiP, from, roomId: eventRoomId } = data;
    
    const isCurrentPartner = partnerId === from || !partnerId;
    const isCurrentRoom = roomId === eventRoomId || !roomId;
    
    if (isCurrentPartner && isCurrentRoom) {
      this.remoteInPiPRef = inPiP;
      emit('partnerPiPStateChanged', { inPiP });
    }
  }

  // ==================== Reset ====================

  /**
   * Сбросить состояние менеджера
   */
  reset(): void {
    this.isInPiPRef = false;
    this.pipPrevCamOnRef = null;
    this.remoteInPiPRef = false;
    this.userManuallyDisabledCameraRef = false;
  }
}

