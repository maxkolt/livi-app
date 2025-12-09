import { RTCPeerConnection, MediaStream, mediaDevices } from 'react-native-webrtc';
import { Platform } from 'react-native';
import { isValidStream } from '../../../utils/streamUtils';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';
import { SimpleEventEmitter } from './SimpleEventEmitter';
import type { CamSide, WebRTCSessionConfig } from '../types';

import { PcLifecycleManager } from './managers/PcLifecycleManager';
import { IceAndSignalingManager } from './managers/IceAndSignalingManager';
import { StreamManager } from './managers/StreamManager';
import { MicMeter } from './managers/MicMeter';
import { PiPManager } from './managers/PiPManager';
import { AppStateHandler } from './managers/AppStateHandler';
import { RemoteStateManager } from './managers/RemoteStateManager';
import { ConnectionStateManager } from './managers/ConnectionStateManager';
import { hashString } from './utils/hashUtils';

/**
 * Базовый класс для WebRTC сессий
 * Содержит общую логику для работы с PeerConnection, стримами, ICE, signaling
 * Наследуется VideoCallSession и RandomChatSession
 */
export abstract class BaseWebRTCSession extends SimpleEventEmitter {
  // PeerConnection references
  protected peerRef: RTCPeerConnection | null = null;
  protected preCreatedPcRef: RTCPeerConnection | null = null;
  
  // Connection identifiers
  protected partnerIdRef: string | null = null; // userId партнера
  protected partnerSocketIdRef: string | null = null; // socket.id партнера (для ICE кандидатов)
  protected roomIdRef: string | null = null;
  protected callIdRef: string | null = null;
  
  // Auto-search management (для рандомного чата)
  protected autoSearchTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  protected lastAutoSearchRef: number = 0;
  protected manuallyRequestedNextRef: boolean = false;
  protected roomJoinedRef: Set<string> = new Set();
  protected callAcceptedProcessingRef: boolean = false;
  protected iceRestartInProgressRef: boolean = false;
  protected camToggleSeenRef: boolean = false;
  protected endedStreamIgnoredAtRef: number = 0;
  protected endedStreamTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  protected endedRef: boolean = false; // Флаг завершенного звонка, блокирует авто-переключения после endCall
  
  // Managers
  protected pcLifecycleManager: PcLifecycleManager;
  protected iceAndSignalingManager: IceAndSignalingManager;
  protected streamManager: StreamManager;
  protected micMeter: MicMeter;
  protected pipManager: PiPManager;
  protected appStateHandler: AppStateHandler;
  protected remoteStateManager: RemoteStateManager;
  protected connectionStateManager: ConnectionStateManager;
  
  protected config: WebRTCSessionConfig;
  
  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    
    this.pcLifecycleManager = new PcLifecycleManager();
    this.iceAndSignalingManager = new IceAndSignalingManager();
    this.streamManager = new StreamManager(config);
    this.micMeter = new MicMeter(config);
    this.pipManager = new PiPManager(config);
    this.appStateHandler = new AppStateHandler();
    this.remoteStateManager = new RemoteStateManager(config);
    this.connectionStateManager = new ConnectionStateManager(config);
    
    this.startTrackChecker();
    this.appStateHandler.setupAppStateListener(
      () => this.handleForeground(),
      () => this.handleBackground()
    );
  }
  
  // ==================== ICE Configuration ====================
  
  /**
   * Загрузить ICE конфигурацию
   */
  protected async loadIceConfiguration(): Promise<void> {
    await this.iceAndSignalingManager.loadIceConfiguration();
  }
  
  /**
   * Получить ICE конфигурацию
   */
  protected getIceConfig(): RTCConfiguration {
    return this.iceAndSignalingManager.getIceConfig();
  }
  
  // ==================== Stream Management ====================
  
  /**
   * Создать локальный стрим
   * Проверяет PiP стрим, существующий стрим, затем создает новый с fallback стратегией
   */
  async startLocalStream(side: CamSide = 'front'): Promise<MediaStream | null> {
    if (this.endedRef) return null; // Не создаем стрим после завершения звонка
    const pipStream = this.tryGetPiPStream();
    if (pipStream) {
      return pipStream;
    }
    
    const existingStream = this.tryGetExistingStream();
    if (existingStream) {
      return existingStream;
    }
    
    return this.createNewLocalStream();
  }

  /**
   * Попытаться получить стрим из PiP
   */
  private tryGetPiPStream(): MediaStream | null {
    const resume = this.config.getResume?.() ?? false;
    const fromPiP = this.config.getFromPiP?.() ?? false;
    const pipLocalStream = this.config.getPipLocalStream?.();
    
    if (resume && fromPiP && pipLocalStream && isValidStream(pipLocalStream)) {
      this.streamManager.setLocalStream(pipLocalStream);
      this.emit('localStream', pipLocalStream);
      return pipLocalStream;
    }
    
    return null;
  }

  /**
   * Попытаться использовать существующий стрим
   */
  private tryGetExistingStream(): MediaStream | null {
    const existingStream = this.streamManager.getLocalStream();
    
    if (existingStream && isValidStream(existingStream)) {
      const tracks = existingStream.getTracks?.() || [];
      const activeTracks = tracks.filter((t: any) => t.readyState === 'live');
      
      if (activeTracks.length > 0) {
        this.config.callbacks.onLocalStreamChange?.(existingStream);
        this.config.onLocalStreamChange?.(existingStream);
        this.emit('localStream', existingStream);
        return existingStream;
      } else {
        this.cleanupStream(existingStream);
        this.streamManager.setLocalStream(null);
        this.emit('localStream', null);
      }
    } else if (existingStream && !isValidStream(existingStream)) {
      this.cleanupStream(existingStream);
      this.streamManager.setLocalStream(null);
      this.emit('localStream', null);
    }
    
    return null;
  }

  /**
   * Очистить стрим (остановить все треки)
   */
  private cleanupStream(stream: MediaStream): void {
    try {
      const tracks = stream.getTracks?.() || [];
      tracks.forEach((t: any) => {
        try { t.stop(); } catch {}
      });
    } catch {}
  }

  /**
   * Создать новый локальный стрим
   * Использует fallback стратегию: сначала общий запрос, затем с facingMode, затем с deviceId
   */
  private async createNewLocalStream(): Promise<MediaStream> {
    const audioConstraints = this.getAudioConstraints();
    
    const stream = await this.tryGetUserMediaWithFallback(audioConstraints);
    
    if (!stream || !isValidStream(stream)) {
      if (stream) {
        this.cleanupStream(stream);
      }
      throw new Error('Failed to create valid media stream');
    }
    
    this.enableStreamTracks(stream);
    this.streamManager.setLocalStream(stream);
    this.emitStreamState(stream);
    
    return stream;
  }

  /**
   * Получить аудио констрейнты
   */
  private getAudioConstraints(): any {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googAutoGainControl: true,
    };
  }

  /**
   * Попытаться получить медиа с fallback стратегией
   */
  private async tryGetUserMediaWithFallback(audioConstraints: any): Promise<MediaStream | null> {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
      if (stream && (stream as any)?.getVideoTracks?.()?.[0]) {
        return stream;
      }
    } catch (e1) {
      try {
        const stream = await mediaDevices.getUserMedia({ 
          audio: audioConstraints, 
          video: { facingMode: 'user' as any } 
        });
        if (stream && (stream as any)?.getVideoTracks?.()?.[0]) {
          return stream;
        }
      } catch (e2) {
        try {
          const devs = await mediaDevices.enumerateDevices();
          const cams = (devs as any[]).filter(d => d.kind === 'videoinput');
          const front = cams.find(d => /front|user/i.test(d.facing || d.label || '')) || cams[0];
          return await mediaDevices.getUserMedia({ 
            audio: audioConstraints, 
            video: { deviceId: (front as any)?.deviceId } as any 
          });
        } catch (e3) {
          logger.error('[BaseWebRTCSession] All getUserMedia attempts failed:', e3);
          throw new Error(`All getUserMedia attempts failed. Last error: ${e3 instanceof Error ? e3.message : String(e3)}`);
        }
      }
    }
    
    return null;
  }

  /**
   * Включить треки стрима и настроить их
   */
  private enableStreamTracks(stream: MediaStream): void {
    const audioTracks = (stream as any)?.getAudioTracks?.() || [];
    const videoTracks = (stream as any)?.getVideoTracks?.() || [];
    const audioTrack = audioTracks[0];
    const videoTrack = videoTracks[0];
    
    if (audioTrack) {
      audioTrack.enabled = true;
      try { (audioTrack as any).contentHint = 'speech'; } catch {}
    }
    
    if (videoTrack) {
      videoTrack.enabled = true;
    }
  }

  /**
   * Отправить состояние стрима через callbacks и events
   */
  private emitStreamState(stream: MediaStream): void {
    const audioTracks = (stream as any)?.getAudioTracks?.() || [];
    const videoTracks = (stream as any)?.getVideoTracks?.() || [];
    const audioTrack = audioTracks[0];
    const videoTrack = videoTracks[0];
    
    // КРИТИЧНО: Для локального стрима всегда считаем камеру включенной если трек live
    // Это гарантирует, что при создании стрима камера показывается как включенная
    const micEnabled = !!audioTrack?.enabled;
    const isVideoTrackLive = videoTrack?.readyState === 'live';
    // Если трек live, считаем камеру включенной даже если enabled=false (временное состояние)
    const camEnabled = isVideoTrackLive ? true : !!videoTrack?.enabled;
    
    this.config.callbacks.onMicStateChange?.(micEnabled);
    this.config.callbacks.onCamStateChange?.(camEnabled);
    this.config.onMicStateChange?.(micEnabled);
    this.config.onCamStateChange?.(camEnabled);
    this.emit('localStream', stream);
  }
  
  /**
   * Остановить локальный стрим (приватный метод)
   * @param force - принудительно остановить стрим даже если PC активен (для завершения звонка)
   */
  protected stopLocalStreamInternal(force: boolean = false): void {
    this.streamManager.stopLocalStreamInternal(this.peerRef, (event, ...args) => this.emit(event, ...args), force);
  }
  
  /**
   * Остановить удаленный стрим (публичный метод)
   */
  stopRemoteStream(): void {
    this.stopRemoteStreamInternal();
  }
  
  /**
   * Остановить удаленный стрим (приватный метод)
   */
  protected stopRemoteStreamInternal(): void {
    this.stopMicMeter();
    this.streamManager.stopRemoteStreamInternal(this.peerRef, (event, ...args) => this.emit(event, ...args));
    this.remoteStateManager.reset((event, ...args) => this.emit(event, ...args));
    this.stopTrackChecker();
  }
  
  // ==================== PC Token Management ====================
  
  /**
   * Инкрементировать токен PC
   */
  protected incrementPcToken(forceReset: boolean = true): void {
    this.pcLifecycleManager.incrementPcToken(forceReset);
  }
  
  /**
   * Пометить PC токеном
   */
  protected markPcWithToken(pc: RTCPeerConnection): void {
    this.pcLifecycleManager.markPcWithToken(pc);
  }
  
  /**
   * Проверить валидность токена PC
   */
  protected isPcTokenValid(pc: RTCPeerConnection | null): boolean {
    return this.pcLifecycleManager.isPcTokenValid(pc);
  }
  
  /**
   * Проверить валидность PC (не закрыт и имеет правильный токен)
   */
  protected isPcValid(pc: RTCPeerConnection | null): boolean {
    return this.pcLifecycleManager.isPcValid(pc, this.pcLifecycleManager.getPcToken());
  }
  
  // ==================== PeerConnection Cleanup ====================
  
  /**
   * Очистить PeerConnection
   */
  protected cleanupPeer(pc?: RTCPeerConnection | null): void {
    this.pcLifecycleManager.cleanupPeer(pc);
  }
  
  // ==================== Track Checker ====================
  
  /**
   * Запустить проверку удаленного видео трека
   */
  protected startTrackChecker(): void {
    const isFriendCall = this.isFriendCall();
    this.streamManager.startTrackChecker(() => this.checkRemoteVideoTrack(), isFriendCall);
  }
  
  /**
   * Проверка удаленного видео трека
   * Обновляет состояние камеры на основе фактического состояния трека
   */
  checkRemoteVideoTrack(): void {
    const remoteStream = this.streamManager.getRemoteStream();
    if (!remoteStream || (this.config.getIsInactiveState?.() ?? false)) {
      return;
    }
    
    try {
      const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
      if (!videoTrack || videoTrack.readyState === 'ended') {
        return;
      }
      
      if (this.remoteStateManager.isRemoteForcedOff()) {
        return;
      }
      
      const shouldBeEnabled = this.determineCameraState(videoTrack);
      if (shouldBeEnabled === null) {
        return;
      }
      
      if (this.remoteStateManager.isRemoteCamOn() !== shouldBeEnabled) {
        this.remoteStateManager.setRemoteForcedOff(false);
        this.remoteStateManager.setRemoteCamOn(shouldBeEnabled, (event, ...args) => this.emit(event, ...args));
        this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
        this.remoteStateManager.emitRemoteState((event, ...args) => this.emit(event, ...args), this.pipManager.isRemoteInPiP());
      }
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error checking remote video track:', e);
    }
  }

  /**
   * Определить состояние камеры на основе трека
   * Возвращает null если состояние не должно обновляться
   */
  private determineCameraState(videoTrack: any): boolean | null {
    const isFriendCall = this.isFriendCall();
    const isCameraEnabled = videoTrack.enabled === true;
    const isTrackEnded = videoTrack.readyState === 'ended';
    
    // УБРАНО: Автоматическое возвращение true для дружеских звонков
    // Теперь используем только фактическое состояние трека (enabled)
    // Это предотвращает лишние переключения remoteCamOn на Android без реальной причины
    // remoteCamOn будет обновляться только при реальных изменениях (cam-toggle, wasFriendCallEnded, переворот камеры)
    
    if (isTrackEnded) {
      return false;
    }
    
    // Используем только фактическое состояние трека
    return isCameraEnabled;
    
    const now = Date.now();
    const streamAge = this.streamManager.getRemoteStreamEstablishedAt() 
      ? now - this.streamManager.getRemoteStreamEstablishedAt() 
      : Infinity;
    const isNewTrack = streamAge < 250;
    
    if (!isCameraEnabled && isNewTrack && videoTrack.readyState === 'live') {
      return null;
    }
    
    return isCameraEnabled;
  }
  
  /**
   * Установить состояние PiP
   */
  setInPiP(inPiP: boolean): void {
    this.pipManager.setInPiP(inPiP);
  }
  
  /**
   * Покинуть комнату
   */
  leaveRoom(roomId?: string): void {
    const roomIdToLeave = roomId || this.roomIdRef;
    if (!roomIdToLeave) {
      return;
    }
    
    try {
      socket.emit('room:leave', { roomId: roomIdToLeave });
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error emitting room:leave:', e);
    }
  }
  
  /**
   * Войти в режим Picture-in-Picture
   * НЕ выключает камеру - она остается в режиме ожидания/сна
   */
  enterPiP(): void {
    this.pipManager.enterPiP(
      () => this.isFriendCall(),
      this.roomIdRef,
      this.partnerIdRef,
      this.streamManager.getLocalStream(),
      (event, ...args) => this.emit(event, ...args)
    );
  }
  
  /**
   * Выключить камеру при сворачивании приложения (AppState === 'background')
   * Это отличается от PiP - при сворачивании камера выключается и показывается "Отошел"
   * Микрофон (звук) НЕ выключается - продолжает работать в фоне
   */
  handleAppBackground(): void {
    if (this.endedRef) return; // После завершения звонка ничего не трогаем
    const localStream = this.streamManager.getLocalStream();
    if (localStream) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      const audioTrack = (localStream as any)?.getAudioTracks?.()?.[0];
      
      // Выключаем только камеру, микрофон остается включенным
      if (videoTrack && videoTrack.enabled) {
        // Сохраняем состояние камеры перед выключением
        this.pipManager['pipPrevCamOnRef'] = true;
        // Выключаем камеру при сворачивании приложения
        videoTrack.enabled = false;
        this.config.callbacks.onCamStateChange?.(false);
        this.config.onCamStateChange?.(false);
        
        // КРИТИЧНО: Не отправляем cam-toggle(false) если звонок только что принят (в течение 30 секунд)
        // Это предотвращает гашение камеры собеседника сразу после принятия звонка
        const connectionEstablishedAt = this.remoteStateManager.getConnectionEstablishedAt();
        const timeSinceConnection = connectionEstablishedAt ? Date.now() - connectionEstablishedAt : Infinity;
        const FILTER_DURATION_MS = 30000; // 30 секунд
        
        if (timeSinceConnection < FILTER_DURATION_MS) {
          logger.info('[BaseWebRTCSession] Не отправляем cam-toggle(false) - соединение только что установлено', {
            timeSinceConnection,
            roomId: this.roomIdRef
          });
        } else {
          // Отправляем cam-toggle(false) партнеру - показываем "Отошел"
          if (this.roomIdRef) {
            try {
              const payload: any = { enabled: false, from: socket.id };
              if (this.roomIdRef) {
                payload.roomId = this.roomIdRef;
              }
              socket.emit('cam-toggle', payload);
            } catch (e) {
              logger.warn('[BaseWebRTCSession] Error emitting cam-toggle on background:', e);
            }
          }
        }
        
        // Отправляем bg:entered
        try {
          socket.emit('bg:entered', {
            callId: this.callIdRef || this.roomIdRef,
            partnerId: this.partnerIdRef
          });
        } catch (e) {
          logger.warn('[BaseWebRTCSession] Error emitting bg:entered:', e);
        }
        
        logger.info('[BaseWebRTCSession] Камера выключена при сворачивании приложения', {
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackState: audioTrack?.readyState
        });
      }
      
      // Убеждаемся, что микрофон остается включенным
      if (audioTrack && !audioTrack.enabled) {
        audioTrack.enabled = true;
        logger.info('[BaseWebRTCSession] Микрофон включен при сворачивании приложения (должен работать в фоне)');
      }
    }
  }
  
  /**
   * Восстановить камеру при возврате из фона (AppState === 'active')
   * Микрофон уже работает в фоне, его не нужно восстанавливать
   */
  handleAppForeground(): void {
    if (this.endedRef) return; // После завершения звонка не восстанавливаем камеру
    const localStream = this.streamManager.getLocalStream();
    if (localStream) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      const audioTrack = (localStream as any)?.getAudioTracks?.()?.[0];
      const pipManager = this.pipManager as any;
      
      // Восстанавливаем камеру если она была включена перед сворачиванием
      if (videoTrack && !videoTrack.enabled && pipManager.pipPrevCamOnRef === true) {
        videoTrack.enabled = true;
        this.config.callbacks.onCamStateChange?.(true);
        this.config.onCamStateChange?.(true);
        
        // Отправляем cam-toggle(true) партнеру
        if (this.roomIdRef) {
          try {
            const payload: any = { enabled: true, from: socket.id };
            if (this.roomIdRef) {
              payload.roomId = this.roomIdRef;
            }
            socket.emit('cam-toggle', payload);
          } catch (e) {
            logger.warn('[BaseWebRTCSession] Error emitting cam-toggle on foreground:', e);
          }
        }
        
        pipManager.pipPrevCamOnRef = null;
        logger.info('[BaseWebRTCSession] Камера восстановлена при возврате из фона', {
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackState: audioTrack?.readyState
        });
      }
      
      // Убеждаемся, что микрофон остается включенным при возврате из фона
      if (audioTrack && !audioTrack.enabled) {
        audioTrack.enabled = true;
        logger.info('[BaseWebRTCSession] Микрофон включен при возврате из фона');
      }
    }
  }
  
  /**
   * Возобновить из PiP
   * Восстанавливает сохраненные стримы из конфигурации
   */
  async resumeFromPiP(): Promise<void> {
    this.pipManager.resumeFromPiP(
      (stream) => {
        this.streamManager.setLocalStream(stream);
        this.emit('localStream', stream);
      },
      (stream) => {
        this.streamManager.setRemoteStream(stream);
        this.emit('remoteStream', stream);
      }
    );
  }
  
  /**
   * Выйти из режима Picture-in-Picture
   * Восстанавливает локальную камеру и отправляет pip:state партнеру
   */
  exitPiP(): void {
    this.pipManager.exitPiP(
      () => this.isFriendCall(),
      this.roomIdRef,
      this.partnerIdRef,
      this.streamManager.getLocalStream(),
      (event, ...args) => this.emit(event, ...args),
      (stream) => {
        this.streamManager.setLocalStream(stream);
        this.emit('localStream', stream);
      },
      (stream) => {
        this.streamManager.setRemoteStream(stream);
        this.emit('remoteStream', stream);
      }
    );
  }
  
  /**
   * Остановить проверку треков
   */
  protected stopTrackChecker(): void {
    this.streamManager.stopTrackChecker();
  }
  
  // ==================== Mic Meter ====================
  
  /**
   * Запустить измерение уровня микрофона
   */
  protected startMicMeter(): void {
    const isMicReallyOn = () => {
      const stream = this.streamManager.getLocalStream();
      const audioTrack = stream?.getAudioTracks?.()?.[0];
      return !!(audioTrack && audioTrack.enabled && (audioTrack as any).readyState === 'live');
    };
    
    this.micMeter.start(
      this.peerRef,
      this.partnerIdRef,
      this.roomIdRef,
      this.callIdRef,
      () => this.isPcConnected(),
      isMicReallyOn,
      () => this.config.getIsInactiveState?.() ?? false
    );
  }
  
  /**
   * Остановить измерение уровня микрофона
   */
  protected stopMicMeter(): void {
    this.micMeter.stop();
  }
  
  // ==================== Connection Timers ====================
  
  /**
   * Очистить таймер переподключения
   */
  protected clearReconnectTimer(): void {
    this.connectionStateManager.clearReconnectTimer();
  }
  
  /**
   * Очистить все таймеры соединения
   */
  protected clearConnectionTimers(): void {
    this.connectionStateManager.clearConnectionTimers();
  }
  
  /**
   * Запустить периодическую проверку состояния соединения
   */
  protected startConnectionCheckInterval(pc: RTCPeerConnection): void {
    this.connectionStateManager.startConnectionCheckInterval(
      pc,
      this.peerRef,
      this.partnerIdRef,
      this.streamManager.getRemoteStream(),
      () => this.isRandomChat(),
      (pc) => this.checkReceiversForRemoteStream(pc),
      () => {
        const handleConnectionState = (pc as any).onconnectionstatechange;
        if (handleConnectionState) {
          handleConnectionState();
        }
      }
    );
  }
  
  /**
   * Обработать сбой соединения
   */
  protected handleConnectionFailure(pc: RTCPeerConnection): void {
    this.connectionStateManager.handleConnectionFailure(
      pc,
      this.peerRef,
      this.partnerIdRef,
      this.roomIdRef,
      this.callIdRef,
      () => this.config.getIsInactiveState?.() ?? false,
      (pc, toId) => this.scheduleReconnection(pc, toId)
    );
  }
  
  /**
   * Запланировать переподключение
   */
  protected scheduleReconnection(pc: RTCPeerConnection, toId: string): void {
    this.connectionStateManager.scheduleReconnection(
      pc,
      toId,
      () => {
        // ICE restart должен быть реализован в наследниках
      }
    );
  }
  
  /**
   * Установка обработчиков соединения (ICE кандидаты, состояние соединения)
   */
  protected bindConnHandlers(pc: RTCPeerConnection, expectedPartnerId?: string): void {
    this.clearConnectionTimers();
    this.setupIceCandidateHandler(pc, expectedPartnerId);
    this.setupConnectionStateHandler(pc);
    this.startConnectionCheckInterval(pc);
  }

  /**
   * Настроить обработчик ICE кандидатов
   * КРИТИЧНО: Кеширует исходящие кандидаты, если нет partnerSocketId/roomId
   */
  private setupIceCandidateHandler(pc: RTCPeerConnection, expectedPartnerId?: string): void {
    (pc as any).onicecandidate = (event: any) => {
      if (!this.isPcValid(pc)) {
        return;
      }
      
      if (event.candidate) {
        // КРИТИЧНО: Для видеозвонков используем roomId или partnerSocketId
        // Для рандомного чата используем partnerId
        const isFriendCall = this.isFriendCall();
        const hasRoomId = !!this.roomIdRef;
        const hasPartnerSocketId = !!this.partnerSocketIdRef;
        const hasPartnerId = !!this.partnerIdRef || !!expectedPartnerId;
        
        // КРИТИЧНО: Если нет идентификаторов, кешируем кандидат
        if (isFriendCall) {
          // Для видеозвонков требуем roomId или partnerSocketId
          if (!hasRoomId && !hasPartnerSocketId) {
            this.iceAndSignalingManager.cacheOutgoingIce(event.candidate);
            const cacheCount = (this as any).__outgoingIceCacheCount = ((this as any).__outgoingIceCacheCount || 0) + 1;
            if (cacheCount <= 3) {
              logger.debug('[BaseWebRTCSession] Outgoing ICE candidate cached (no roomId/partnerSocketId)', {
                cacheCount,
                hasRoomId,
                hasPartnerSocketId
              });
            }
            return;
          }
        } else {
          // Для рандомного чата требуем partnerId
          if (!hasPartnerId) {
            this.iceAndSignalingManager.cacheOutgoingIce(event.candidate);
            const cacheCount = (this as any).__outgoingIceCacheCount = ((this as any).__outgoingIceCacheCount || 0) + 1;
            if (cacheCount <= 3) {
              logger.debug('[BaseWebRTCSession] Outgoing ICE candidate cached (no partnerId)', {
                cacheCount
              });
            }
            return;
          }
        }
        
        // Отправляем кандидат
        const toId = this.partnerIdRef || expectedPartnerId;
        if (toId || hasRoomId || hasPartnerSocketId) {
          const payload: any = { candidate: event.candidate };
          
          // КРИТИЧНО: Для видеозвонков используем roomId (приоритет)
          if (isFriendCall && hasRoomId) {
            payload.roomId = this.roomIdRef;
          } else if (toId) {
            // Для рандомного чата или если нет roomId, используем to
            payload.to = toId;
          }
          
          socket.emit('ice-candidate', payload);
        } else {
          // Если нет ни одного идентификатора, кешируем
          this.iceAndSignalingManager.cacheOutgoingIce(event.candidate);
        }
      }
    };
  }

  /**
   * Настроить обработчик состояния соединения
   */
  private setupConnectionStateHandler(pc: RTCPeerConnection): void {
    const handleConnectionState = () => {
      // Проверка валидности PC
      if (!pc || pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        if (this.connectionStateManager.isConnected()) {
          this.connectionStateManager.setConnected(
            false,
            pc,
            this.partnerIdRef,
            () => {},
            () => {}
          );
        }
        return;
      }
      
      // Проверка что это актуальный PC
      if (!this.peerRef || this.peerRef !== pc) {
        return;
      }
      
      // Проверка активного звонка
      const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
      if (!hasActiveCall) {
        if (this.connectionStateManager.isConnected()) {
          this.connectionStateManager.setConnected(
            false,
            pc,
            this.partnerIdRef,
            () => {},
            () => {}
          );
        }
        return;
      }
      
      // Проверка неактивного состояния
      const isInactiveState = this.config.getIsInactiveState?.() ?? false;
      if (isInactiveState) {
        return;
      }
      
      // Получаем состояние подключения
      const st = (pc as any).connectionState || pc.iceConnectionState;
      const isConnected = st === 'connected' || st === 'completed';
      
      // Обновляем состояние только если оно изменилось
      this.connectionStateManager.setConnected(
        isConnected,
        pc,
        this.partnerIdRef,
        () => {},
        () => {}
      );
      
      // Обработка сбоев и автоматический reconnection
      if (st === 'failed' || st === 'disconnected') {
        this.handleConnectionFailure(pc);
      }
    };
    
    // Устанавливаем обработчик изменения состояния
    (pc as any).onconnectionstatechange = handleConnectionState;
    
    // Также слушаем iceConnectionState для совместимости
    try {
      (pc as any).oniceconnectionstatechange = handleConnectionState;
    } catch {}
    
    // Проверяем состояние сразу
    handleConnectionState();
    
    // Запускаем периодическую проверку состояния
    this.startConnectionCheckInterval(pc);
  }
  
  /**
   * Установка обработчиков удаленного стрима (ontrack и onaddstream)
   * КРИТИЧНО: Обрабатываем оба события для максимальной совместимости
   */
  protected attachRemoteHandlers(pc: RTCPeerConnection, setToId?: string): void {
    // Проверяем наличие обработчика
    const hasHandler = !!(pc as any)?.ontrack;
    const hasFlag = (pc as any)?._remoteHandlersAttached === true;
    
    if (hasFlag && hasHandler) {
      return;
    }
    
    // Если флаг установлен, но обработчика нет - сбрасываем флаг
    if (hasFlag && !hasHandler) {
      (pc as any)._remoteHandlersAttached = false;
    }
    
    /**
     * Обработчик события ontrack
     * КРИТИЧНО: Это ОБЯЗАТЕЛЬНЫЙ код для приема удаленных треков
     * Без этого remoteStream всегда пустой → RemoteVideo = чёрный экран и тишина
     * 
     * Минимальный обязательный код:
     * pc.ontrack = (event) => {
     *   const stream = event.streams[0];
     *   this.remoteStream = stream;
     *   this.emit("remoteStream", stream);
     * };
     */
    const handleRemote = (e: any) => {
      try {
        // Проверяем, что PC не закрыт и токен актуален
        if (!this.isPcValid(pc)) {
          logger.warn('[BaseWebRTCSession] PC невалиден, игнорируем ontrack событие');
          return;
        }
        
        // КРИТИЧНО: Получаем стрим из события ontrack (как в минимальном коде)
        // event.streams[0] - это стандартный способ получения стрима
        const stream = e?.streams?.[0] ?? e?.stream;
        const track = e?.track;
        
        logger.info('[BaseWebRTCSession] 📥 ontrack событие получено', {
          hasStream: !!stream,
          hasTrack: !!track,
          streamId: stream?.id,
          trackId: track?.id,
          trackKind: track?.kind || (track as any)?.type,
          streamsCount: e?.streams?.length || 0
        });
        
        // ============================================================
        // КРИТИЧНО: МИНИМАЛЬНЫЙ ОБЯЗАТЕЛЬНЫЙ КОД для приема удаленных треков
        // Без этого remoteStream всегда пустой → RemoteVideo = чёрный экран и тишина
        // ============================================================
        // 
        // Минимальный код:
        // pc.ontrack = (event) => {
        //   const stream = event.streams[0];
        //   this.remoteStream = stream;
        //   this.emit("remoteStream", stream);
        // };
        //
        // ============================================================
        
        // КРИТИЧНО: Если stream есть в событии - используем его напрямую (как в минимальном коде)
        if (stream && isValidStream(stream)) {
          const videoTracks = (stream as any)?.getVideoTracks?.() || [];
          const audioTracks = (stream as any)?.getAudioTracks?.() || [];
          
          logger.info('[BaseWebRTCSession] ✅ Используем stream из event.streams[0] (МИНИМАЛЬНЫЙ КОД)', {
            streamId: stream.id,
            videoTracksCount: videoTracks.length,
            audioTracksCount: audioTracks.length,
            hasVideo: videoTracks.length > 0,
            hasAudio: audioTracks.length > 0
          });
          
          // КРИТИЧНО: Устанавливаем remoteStream (эквивалент: this.remoteStream = stream)
          // Используем streamManager для централизованного управления
          this.streamManager.setRemoteStream(stream, (event, ...args) => {
            logger.info('[BaseWebRTCSession] 📤 Emitting remoteStream event (МИНИМАЛЬНЫЙ КОД)', {
              event,
              streamId: stream.id,
              videoTracksCount: videoTracks.length,
              audioTracksCount: audioTracks.length
            });
            // КРИТИЧНО: Эмитим событие (эквивалент: this.emit("remoteStream", stream))
            this.emit(event, ...args);
          });
          
          // КРИТИЧНО: Обновляем remoteViewKey для обновления UI
          this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          
          // УБРАНО: Автоматическое обновление remoteCamOn при получении стрима
          // Используем только фактическое состояние трека (enabled/readyState)
          // Это предотвращает лишние переключения remoteCamOn на Android без реальной причины
          // remoteCamOn будет обновляться только при реальных изменениях (cam-toggle, wasFriendCallEnded, переворот камеры)
          
          // Выходим - стрим установлен, как в минимальном коде
          logger.info('[BaseWebRTCSession] ✅ МИНИМАЛЬНЫЙ КОД выполнен: remoteStream установлен и событие отправлено', {
            streamId: stream.id
          });
          return;
        }
        
        // ============================================================
        // FALLBACK: Если stream не пришел напрямую в событии (например, на iOS)
        // Используем unified подход для создания stream из receivers
        // ============================================================
        
        // КРИТИЧНО: На iOS треки могут приходить отдельно, поэтому используем unified подход
        // Сначала пытаемся использовать stream из события, если он валиден
        let rs = stream;
        
        // Если stream из события невалиден или отсутствует, создаем unified stream из receivers
        if (!rs || !isValidStream(rs)) {
          try {
            const getReceiversFn = (pc as any).getReceivers;
            if (typeof getReceiversFn === 'function') {
              const receivers: Array<RTCRtpReceiver | any> = getReceiversFn.call(pc);
              
              if (receivers && receivers.length > 0) {
                const { MediaStream } = require('react-native-webrtc');
                const unifiedStream = new MediaStream();
                
                let videoTracksAdded = 0;
                let audioTracksAdded = 0;
                
                receivers.forEach((receiver: any) => {
                  const receiverTrack = receiver.track;
                  if (receiverTrack && receiverTrack.readyState !== 'ended') {
                    try {
                      // КРИТИЧНО: Добавляем трек в MediaStream
                      (unifiedStream as any).addTrack(receiverTrack);
                      
                      // Отслеживаем добавленные треки для логирования
                      const trackKind = receiverTrack.kind || (receiverTrack as any).type;
                      if (trackKind === 'video') {
                        videoTracksAdded++;
                      } else if (trackKind === 'audio') {
                        audioTracksAdded++;
                      }
                      
                      logger.info('[BaseWebRTCSession] Track added to unified stream from receiver', {
                        trackId: receiverTrack.id,
                        trackKind: trackKind,
                        trackReadyState: receiverTrack.readyState,
                        trackEnabled: receiverTrack.enabled
                      });
                    } catch (e) {
                      logger.warn('[BaseWebRTCSession] Error adding track from receiver:', e);
                    }
                  }
                });
                
                const unifiedTracks = unifiedStream.getTracks?.() || [];
                const videoTracks = (unifiedStream as any)?.getVideoTracks?.() || [];
                const audioTracks = (unifiedStream as any)?.getAudioTracks?.() || [];
                
                // КРИТИЧНО: Проверяем, что видеотрек действительно добавлен и доступен через getVideoTracks()
                if (videoTracks.length === 0 && videoTracksAdded > 0) {
                  logger.error('[BaseWebRTCSession] ВИДЕОТРЕК НЕ ДОСТУПЕН через getVideoTracks() после добавления!', {
                    videoTracksAdded,
                    totalTracks: unifiedTracks.length,
                    trackIds: unifiedTracks.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type }))
                  });
                }
                
                logger.info('[BaseWebRTCSession] Unified stream created from receivers in ontrack', {
                  totalTracks: unifiedTracks.length,
                  videoTracksCount: videoTracks.length,
                  audioTracksCount: audioTracks.length,
                  videoTracksAdded,
                  audioTracksAdded,
                  isValid: isValidStream(unifiedStream)
                });
                
                if (unifiedTracks.length > 0 && isValidStream(unifiedStream)) {
                  // КРИТИЧНО: Финальная проверка - видеотрек должен быть доступен
                  if (videoTracks.length === 0) {
                    logger.warn('[BaseWebRTCSession] Unified stream создан, но видеотрек отсутствует', {
                      totalTracks: unifiedTracks.length,
                      trackKinds: unifiedTracks.map((t: any) => t.kind || (t as any).type)
                    });
                  }
                  rs = unifiedStream;
                }
              }
            }
          } catch (receiverError) {
            logger.warn('[BaseWebRTCSession] Error getting receivers:', receiverError);
          }
        }
        
        // Если все еще нет валидного stream, используем track из события
        // КРИТИЧНО: Если есть существующий remoteStream, добавляем трек в него
        if (!rs || !isValidStream(rs)) {
          if (track && track.readyState !== 'ended') {
            // КРИТИЧНО: Используем StreamManager для добавления трека
            // Это гарантирует, что трек будет добавлен в существующий стрим или создан новый
            const existingRemoteStream = this.streamManager.getRemoteStream();
            if (existingRemoteStream) {
              logger.info('[BaseWebRTCSession] Adding track to existing remote stream', {
                trackId: track.id,
                trackKind: track.kind || (track as any).type,
                existingStreamId: existingRemoteStream.id
              });
              
              // Добавляем трек в существующий стрим
              rs = this.streamManager.addTrackToRemoteStream(track, (event, ...args) => {
                this.emit(event, ...args);
              });
              
              if (!rs) {
                logger.warn('[BaseWebRTCSession] Failed to add track to existing remote stream');
                return;
              }
            } else {
              // Создаем новый стрим с треком
              try {
                const { MediaStream } = require('react-native-webrtc');
                rs = new MediaStream();
                
                // КРИТИЧНО: Добавляем трек в MediaStream
                (rs as any).addTrack(track);
                
                const trackKind = track.kind || (track as any).type;
                const videoTracks = (rs as any)?.getVideoTracks?.() || [];
                const audioTracks = (rs as any)?.getAudioTracks?.() || [];
                
                // КРИТИЧНО: Проверяем, что видеотрек действительно добавлен и доступен через getVideoTracks()
                if (trackKind === 'video' && videoTracks.length === 0) {
                  logger.error('[BaseWebRTCSession] ВИДЕОТРЕК НЕ ДОСТУПЕН через getVideoTracks() после добавления из события!', {
                    trackId: track.id,
                    trackKind: trackKind,
                    trackReadyState: track.readyState,
                    totalTracks: rs.getTracks?.()?.length || 0
                  });
                }
                
                logger.info('[BaseWebRTCSession] Stream created from single track', {
                  trackId: track.id,
                  trackKind: trackKind,
                  trackReadyState: track.readyState,
                  videoTracksCount: videoTracks.length,
                  audioTracksCount: audioTracks.length,
                  isValid: isValidStream(rs)
                });
              } catch (e) {
                logger.warn('[BaseWebRTCSession] Error creating stream from track:', e);
                return;
              }
            }
          } else {
            return;
          }
        }
        
        if (!rs || !isValidStream(rs)) {
          return;
        }
        
        // Проверка на локальный stream (только для iOS, для рандомного чата)
        if (Platform.OS !== 'android') {
          try {
            const localStream = this.streamManager.getLocalStream();
            if (localStream && (rs as any)?.id === (localStream as any)?.id) {
              const localVideoTrack = localStream?.getVideoTracks?.()?.[0];
              const remoteVideoTrack = rs?.getVideoTracks?.()?.[0];
              const isSameTrack = localVideoTrack && remoteVideoTrack && localVideoTrack.id === remoteVideoTrack.id;
              
              if (isSameTrack && !this.isFriendCall()) {
                return;
              }
            }
          } catch (e) {
            logger.warn('[BaseWebRTCSession] Error checking local stream:', e);
          }
        }
        
        // Останавливаем старый стрим, если он реально другой
        const existingRemoteStream = this.streamManager.getRemoteStream();
        logger.info('[BaseWebRTCSession] Processing ontrack event', {
          existingStreamId: existingRemoteStream?.id,
          newStreamId: rs.id,
          streamsAreSame: existingRemoteStream === rs,
          streamsHaveSameId: existingRemoteStream?.id === rs.id,
          existingHasVideo: !!(existingRemoteStream as any)?.getVideoTracks?.()?.[0],
          existingHasAudio: !!(existingRemoteStream as any)?.getAudioTracks?.()?.[0],
          newHasVideo: !!(rs as any)?.getVideoTracks?.()?.[0],
          newHasAudio: !!(rs as any)?.getAudioTracks?.()?.[0]
        });
        
        if (existingRemoteStream && existingRemoteStream !== rs) {
          // КРИТИЧНО: Проверяем, не является ли новый стрим обновлением старого (с тем же ID)
          // На iOS треки могут приходить отдельно, но в одном стриме
          if (existingRemoteStream.id === rs.id) {
            logger.info('[BaseWebRTCSession] Новый стрим имеет тот же ID - это обновление, не останавливаем старый');
            // Это обновление существующего стрима, не останавливаем старый
          } else {
            logger.warn('[BaseWebRTCSession] Останавливаем старый стрим - это другой стрим', {
              oldStreamId: existingRemoteStream.id,
              newStreamId: rs.id
            });
            try {
              const oldTracks = existingRemoteStream.getTracks?.() || [];
              oldTracks.forEach((t: any) => {
                try {
                  t.enabled = false;
                  t.stop();
                } catch {}
              });
            } catch {}
          }
        }
        
        // Проверяем состояние треков
        const videoTrack = (rs as any)?.getVideoTracks?.()?.[0];
        const audioTrack = (rs as any)?.getAudioTracks?.()?.[0];
        
        // Предотвращаем множественные emit для одного и того же stream
        const existingStream = this.streamManager.getRemoteStream();
        const isSameStream = existingStream === rs || (existingStream && existingStream.id === rs.id);
        const streamChanged = !isSameStream;
        
        logger.info('[BaseWebRTCSession] Stream comparison', {
          isSameStream,
          streamChanged,
          existingStreamId: existingStream?.id,
          newStreamId: rs.id
        });
        
        // Если это новый стрим и видео-трек приходит с readyState=ended, игнорируем
        if (streamChanged && videoTrack && videoTrack.readyState === 'ended') {
          logger.warn('[BaseWebRTCSession] Игнорируем новый стрим с ended видео-треком');
          return;
        }
        
        // КРИТИЧНО: Проверяем наличие видеотрека перед установкой remoteStream
        const allTracks = rs.getTracks?.() || [];
        const videoTracks = (rs as any)?.getVideoTracks?.() || [];
        const audioTracks = (rs as any)?.getAudioTracks?.() || [];
        const hasVideoTrack = videoTracks.length > 0;
        const hasAudioTrack = audioTracks.length > 0;
        
        // Устанавливаем remoteStream
        logger.info('[BaseWebRTCSession] ✅ RemoteStream обновлен из ontrack события', {
          streamId: rs.id,
          partnerId: this.partnerIdRef,
          isFriendCall: this.isFriendCall(),
          allTracksCount: allTracks.length,
          videoTracksCount: videoTracks.length,
          audioTracksCount: audioTracks.length,
          hasVideoTrack: hasVideoTrack,
          hasAudioTrack: hasAudioTrack,
          videoTrackId: videoTrack?.id,
          videoTrackEnabled: videoTrack?.enabled,
          videoTrackReadyState: videoTrack?.readyState,
          audioTrackId: audioTrack?.id,
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackReadyState: audioTrack?.readyState,
          trackIds: allTracks.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type, enabled: t.enabled, readyState: t.readyState }))
        });
        
        // КРИТИЧНО: Проверяем, что видеотрек действительно доступен
        if (!hasVideoTrack && allTracks.some((t: any) => (t.kind || (t as any).type) === 'video')) {
          logger.error('[BaseWebRTCSession] ❌ КРИТИЧЕСКАЯ ОШИБКА: Видеотрек есть в getTracks(), но НЕ доступен через getVideoTracks()!', {
            streamId: rs.id,
            allTracksCount: allTracks.length,
            videoTracksCount: videoTracks.length,
            trackKinds: allTracks.map((t: any) => t.kind || (t as any).type)
          });
        }
        
        // КРИТИЧНО: Устанавливаем remoteStream перед обновлением состояния камеры
        // Это гарантирует, что remoteStream будет доступен в компоненте при обновлении remoteCamOn
        this.streamManager.setRemoteStream(rs, (event, ...args) => {
          logger.info('[BaseWebRTCSession] 📤 Emitting remoteStream event', {
            event,
            streamId: rs.id,
            hasVideoTrack: hasVideoTrack,
            hasAudioTrack: hasAudioTrack,
            videoTracksCount: videoTracks.length,
            audioTracksCount: audioTracks.length,
            videoTrackId: videoTrack?.id,
            videoTrackReadyState: videoTrack?.readyState
          });
          this.emit(event, ...args);
        });
        
        // КРИТИЧНО: Обновляем remoteViewKey при установке удаленного стрима
        // Это гарантирует обновление видео в UI
        this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
        
        // Обновляем состояние камеры
        if (videoTrack) {
          // КРИТИЧНО: Для дружеских звонков считаем камеру включенной если трек существует и не ended
          // даже если enabled=false или readyState еще не live (это может быть временное начальное состояние)
          const isFriendCall = this.isFriendCall();
          const isTrackLive = videoTrack.readyState === 'live';
          const isTrackEnded = videoTrack.readyState === 'ended';
          
          // УБРАНО: Автоматическая установка remoteCamOn=true для дружеских звонков
          // Теперь используем только фактическое состояние трека (enabled/readyState)
          // Это предотвращает лишние переключения remoteCamOn на Android без реальной причины
          // remoteCamOn будет обновляться только при реальных изменениях (cam-toggle, wasFriendCallEnded, переворот камеры)
          const camEnabled = videoTrack.enabled && !isTrackEnded;
          
          // КРИТИЧНО: Устанавливаем remoteCamOn ТОЛЬКО если значение изменилось
          // Это предотвращает лишние переключения на Android
          const currentRemoteCamOn = this.remoteStateManager.isRemoteCamOn();
          if (currentRemoteCamOn !== camEnabled) {
            this.remoteStateManager.setRemoteCamOn(camEnabled, (event, ...args) => this.emit(event, ...args));
            this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          } else {
            // Если значение не изменилось, обновляем только remoteViewKey для обновления UI
            this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          }
          
          logger.info('[BaseWebRTCSession] Remote camera state set and view key updated', {
            camEnabled,
            isFriendCall,
            isTrackLive,
            videoTrackEnabled: videoTrack.enabled
          });
          
          // КРИТИЧНО: Применяем отложенное состояние cam-toggle, если оно было сохранено
          const pendingCamToggle = this.remoteStateManager.getPendingCamToggle();
          if (pendingCamToggle && pendingCamToggle.from === setToId) {
            if (videoTrack.readyState !== 'ended') {
              // КРИТИЧНО: Не устанавливаем enabled=false, если трек readyState === 'live' и камера не выключена пользователем
              // Используем фактическое состояние трека вместо внешнего флага
              const isTrackLive = videoTrack.readyState === 'live';
              const isTrackCurrentlyEnabled = videoTrack.enabled === true;
              
              // Если трек live и включен, и мы получаем cam-toggle(false), не выключаем трек
              // Используем фактическое состояние трека - если трек live и enabled, значит камера работает
              if (!pendingCamToggle.enabled && isTrackLive && isTrackCurrentlyEnabled) {
                logger.info('[BaseWebRTCSession] Не применяем отложенное enabled=false для live трека - используем фактическое состояние', {
                  readyState: videoTrack.readyState,
                  currentEnabled: videoTrack.enabled
                });
                // Не устанавливаем enabled=false - трек остается enabled=true, так как это фактическое состояние
                // Используем фактическое состояние трека для UI
                this.remoteStateManager.setRemoteForcedOff(false);
                this.remoteStateManager.setRemoteCamOn(true, (event, ...args) => this.emit(event, ...args)); // Используем фактическое состояние
              } else {
                // Устанавливаем enabled только если трек не live или уже выключен
                videoTrack.enabled = pendingCamToggle.enabled;
                this.remoteStateManager.setRemoteForcedOff(!pendingCamToggle.enabled);
                this.remoteStateManager.setRemoteCamOn(pendingCamToggle.enabled, (event, ...args) => this.emit(event, ...args));
              }
              
              this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
              this.remoteStateManager.emitRemoteState((event, ...args) => this.emit(event, ...args), this.pipManager.isRemoteInPiP());
            }
            this.remoteStateManager.setPendingCamToggle(null);
          }
        }
      } catch (e) {
        logger.error('[BaseWebRTCSession] Error in ontrack handler:', e);
      }
    };
    
    /**
     * Обработчик события onaddstream (устаревший API, но используется для совместимости)
     * КРИТИЧНО: Некоторые реализации WebRTC могут использовать onaddstream вместо ontrack
     */
    const handleAddStream = (e: any) => {
      try {
        // Проверяем, что PC не закрыт и токен актуален
        if (!this.isPcValid(pc)) {
          return;
        }

        const stream = e?.stream;
        if (!stream || !isValidStream(stream)) {
          return;
        }

        logger.info('[BaseWebRTCSession] onaddstream event received', {
          streamId: stream.id,
          hasVideo: !!(stream as any)?.getVideoTracks?.()?.[0],
          hasAudio: !!(stream as any)?.getAudioTracks?.()?.[0]
        });

        // Получаем все треки из стрима и добавляем их
        const tracks = stream.getTracks?.() || [];
        let hasNewTracks = false;

        tracks.forEach((track: any) => {
          if (track && track.readyState !== 'ended') {
            const existingRemoteStream = this.streamManager.getRemoteStream();
            if (existingRemoteStream) {
              // Добавляем трек в существующий стрим
              const result = this.streamManager.addTrackToRemoteStream(track, (event, ...args) => {
                this.emit(event, ...args);
              });
              if (result) {
                hasNewTracks = true;
              }
            } else {
              // Если remoteStream не существует, устанавливаем весь стрим
              this.streamManager.setRemoteStream(stream, (event, ...args) => {
                this.emit(event, ...args);
              });
              hasNewTracks = true;
              return; // Выходим из цикла, так как установили весь стрим
            }
          }
        });

        if (hasNewTracks) {
          // Обновляем состояние камеры
          const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            const isFriendCall = this.isFriendCall();
            const isTrackEnded = videoTrack.readyState === 'ended';
            // УБРАНО: Автоматическое обновление remoteCamOn при получении стрима через onaddstream
            // Используем только фактическое состояние трека (enabled/readyState)
            // Это предотвращает лишние переключения remoteCamOn на Android без реальной причины
            // remoteCamOn будет обновляться только при реальных изменениях (cam-toggle, wasFriendCallEnded, переворот камеры)
            // Обновляем только remoteViewKey для обновления UI
            this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          }
        }
      } catch (e) {
        logger.error('[BaseWebRTCSession] Error in onaddstream handler:', e);
      }
    };

    // ============================================================
    // КРИТИЧНО: УСТАНОВКА ОБРАБОТЧИКА ontrack (МИНИМАЛЬНЫЙ ОБЯЗАТЕЛЬНЫЙ КОД)
    // Без этого remoteStream всегда пустой → RemoteVideo = чёрный экран и тишина
    // ============================================================
    // 
    // Минимальный код:
    // pc.ontrack = (event) => {
    //   const stream = event.streams[0];
    //   this.remoteStream = stream;
    //   this.emit("remoteStream", stream);
    // };
    //
    // ============================================================
    
    // КРИТИЧНО: Устанавливаем обработчик ontrack (МИНИМАЛЬНЫЙ ОБЯЗАТЕЛЬНЫЙ КОД)
    (pc as any).ontrack = handleRemote;
    
    logger.info('[BaseWebRTCSession] ✅ Обработчик ontrack установлен (МИНИМАЛЬНЫЙ КОД)', {
      partnerId: setToId,
      pcSignalingState: pc.signalingState,
      hasOntrack: !!(pc as any).ontrack,
      handlerType: typeof handleRemote
    });
    
    // onaddstream - устаревший API, но некоторые реализации могут его использовать
    try {
      (pc as any).onaddstream = handleAddStream;
      logger.info('[BaseWebRTCSession] ✅ Обработчик onaddstream также установлен для совместимости');
    } catch (e) {
      // Игнорируем ошибку, если onaddstream не поддерживается
      logger.debug('[BaseWebRTCSession] onaddstream not supported, using ontrack only');
    }
    
    (pc as any)._remoteHandlersAttached = true;
    
    // КРИТИЧНО: Проверяем наличие существующего remoteStream и синхронизируем с компонентами
    // Это гарантирует, что стрим не потеряется при установке обработчиков на новый PC
    const existingRemoteStream = this.streamManager.getRemoteStream();
    if (existingRemoteStream && isValidStream(existingRemoteStream)) {
      const videoTracks = (existingRemoteStream as any)?.getVideoTracks?.() || [];
      const audioTracks = (existingRemoteStream as any)?.getAudioTracks?.() || [];
      
      logger.info('[BaseWebRTCSession] ✅ Обнаружен существующий remoteStream при установке обработчиков, синхронизируем с компонентами', {
        streamId: existingRemoteStream.id,
        hasVideo: videoTracks.length > 0,
        hasAudio: audioTracks.length > 0,
        videoTracksCount: videoTracks.length,
        audioTracksCount: audioTracks.length,
        partnerId: setToId
      });
      
      // КРИТИЧНО: Эмитим событие remoteStream для синхронизации с компонентами
      // Это гарантирует, что компоненты получат стрим даже после пересоздания PC
      setTimeout(() => {
        // Используем setTimeout для асинхронной отправки, чтобы не блокировать установку обработчиков
        const currentRemoteStream = this.streamManager.getRemoteStream();
        if (currentRemoteStream === existingRemoteStream) {
          logger.info('[BaseWebRTCSession] 📤 Emitting existing remoteStream event для синхронизации', {
            streamId: existingRemoteStream.id,
            videoTracksCount: videoTracks.length,
            audioTracksCount: audioTracks.length
          });
          this.emit('remoteStream', existingRemoteStream);
          this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
        }
      }, 0);
    }
    
    logger.info('[BaseWebRTCSession] Remote handlers attached', {
      hasOntrack: true,
      hasOnaddstream: typeof (pc as any).onaddstream !== 'undefined',
      partnerId: setToId,
      hasExistingRemoteStream: !!existingRemoteStream
    });
  }
  
  /**
   * Проверка receivers для получения удаленного стрима
   */
  protected checkReceiversForRemoteStream(pc: RTCPeerConnection): void {
    if (!this.partnerIdRef) {
      return;
    }
    
    logger.info('[BaseWebRTCSession] 🔍 Проверяем receivers для получения remoteStream', {
      partnerId: this.partnerIdRef,
      isFriendCall: this.isFriendCall(),
      pcSignalingState: pc.signalingState,
      pcConnectionState: (pc as any).connectionState
    });
    
    this.streamManager.checkReceiversForRemoteStream(
      pc,
      () => this.isFriendCall(),
      (stream) => {
        // КРИТИЧНО: Проверяем наличие видеотрека перед установкой remoteStream
        const allTracks = stream.getTracks?.() || [];
        const videoTracks = (stream as any)?.getVideoTracks?.() || [];
        const audioTracks = (stream as any)?.getAudioTracks?.() || [];
        const videoTrack = videoTracks[0];
        const audioTrack = audioTracks[0];
        const hasVideoTrack = videoTracks.length > 0;
        const hasAudioTrack = audioTracks.length > 0;
        
        logger.info('[BaseWebRTCSession] ✅ RemoteStream обновлен из receivers', {
          streamId: stream.id,
          partnerId: this.partnerIdRef,
          isFriendCall: this.isFriendCall(),
          allTracksCount: allTracks.length,
          videoTracksCount: videoTracks.length,
          audioTracksCount: audioTracks.length,
          hasVideoTrack: hasVideoTrack,
          hasAudioTrack: hasAudioTrack,
          videoTrackId: videoTrack?.id,
          videoTrackEnabled: videoTrack?.enabled,
          videoTrackReadyState: videoTrack?.readyState,
          audioTrackId: audioTrack?.id,
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackReadyState: audioTrack?.readyState,
          trackIds: allTracks.map((t: any) => ({ id: t.id, kind: t.kind || (t as any).type, enabled: t.enabled, readyState: t.readyState }))
        });
        
        // КРИТИЧНО: Проверяем, что видеотрек действительно доступен
        if (!hasVideoTrack && allTracks.some((t: any) => (t.kind || (t as any).type) === 'video')) {
          logger.error('[BaseWebRTCSession] ❌ КРИТИЧЕСКАЯ ОШИБКА: Видеотрек есть в getTracks(), но НЕ доступен через getVideoTracks()!', {
            streamId: stream.id,
            allTracksCount: allTracks.length,
            videoTracksCount: videoTracks.length,
            trackKinds: allTracks.map((t: any) => t.kind || (t as any).type)
          });
        }
        
        // Эмитим событие
        logger.info('[BaseWebRTCSession] 📤 Emitting remoteStream event из receivers', {
          streamId: stream.id,
          hasVideoTrack: hasVideoTrack,
          hasAudioTrack: hasAudioTrack
        });
        this.emit('remoteStream', stream);
        
        // КРИТИЧНО: Обновляем remoteViewKey при установке удаленного стрима из receivers
        // Это гарантирует обновление видео в UI
        this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
        
        // Обновляем состояние камеры если есть видео-трек
        if (videoTrack) {
          // КРИТИЧНО: Для дружеских звонков считаем камеру включенной если трек существует и не ended
          // даже если enabled=false или readyState еще не live (это может быть временное начальное состояние)
          const isFriendCall = this.isFriendCall();
          const isTrackLive = videoTrack.readyState === 'live';
          const isTrackEnded = videoTrack.readyState === 'ended';
          
          let camEnabled: boolean;
          if (isFriendCall && !isTrackEnded) {
            // Для дружеских звонков с существующим треком (не ended) считаем камеру включенной
            // даже если enabled=false или readyState еще не live (это может быть временное состояние)
            camEnabled = true;
            logger.info('[BaseWebRTCSession] Remote camera enabled for friend call with existing track (from receivers)', {
              videoTrackEnabled: videoTrack.enabled,
              videoTrackReadyState: videoTrack.readyState,
              isTrackLive
            });
          } else {
            // Для рандомного чата или если трек ended, используем фактическое состояние
            camEnabled = videoTrack.enabled && !isTrackEnded;
          }
          
          this.remoteStateManager.setRemoteCamOn(camEnabled, (event, ...args) => this.emit(event, ...args));
          logger.info('[BaseWebRTCSession] Remote camera state updated', { camEnabled, isFriendCall, isTrackLive });
        }
      }
    );
  }
  
  // ==================== Remote State ====================
  
  protected emitRemoteState(): void {
    this.remoteStateManager.emitRemoteState(
      (event, ...args) => this.emit(event, ...args),
      this.pipManager.isRemoteInPiP()
    );
  }
  
  protected emitSessionUpdate(): void {
    this.emit('sessionUpdate', {
      partnerId: this.partnerIdRef,
      roomId: this.roomIdRef,
      callId: this.callIdRef,
      hasLocalStream: !!this.streamManager.getLocalStream(),
      hasRemoteStream: !!this.streamManager.getRemoteStream(),
      isConnected: this.connectionStateManager.isConnected(),
    });
  }
  
  // ==================== AppState Listener ====================
  
  protected setupAppStateListener(): void {
    // Уже настроено в конструкторе
  }
  
  protected handleAppStateChange(nextAppState: string): void {
    // Обрабатывается через AppStateHandler
  }
  
  protected handleForeground(): void {
    // Восстанавливаем камеру при возврате из фона
    // Это отличается от PiP - при сворачивании приложения камера выключалась
    this.handleAppForeground();
  }
  
  protected handleBackground(): void {
    // Выключаем камеру при сворачивании приложения
    // Это отличается от PiP - при PiP камера остается включенной
    this.handleAppBackground();
  }
  
  // ==================== ICE Candidate Queue ====================
  
  /**
   * Отправляет кешированные исходящие ICE кандидаты после установки partnerId
   */
  protected flushOutgoingIceCache(): void {
    const pc = this.peerRef;
    if (pc && !this.isPcValid(pc)) {
      this.iceAndSignalingManager.clearOutgoingIceCache();
      return;
    }
    
    this.iceAndSignalingManager.flushOutgoingIceCache(
      this.partnerIdRef,
      () => this.isFriendCall(),
      this.roomIdRef
    );
  }
  
  protected enqueueIce(from: string, candidate: any, roomId?: string | null): void {
    this.iceAndSignalingManager.enqueueIce(from, candidate, roomId);
  }
  
  protected async flushIceFor(from: string): Promise<void> {
    await this.iceAndSignalingManager.flushIceFor(
      from,
      this.peerRef,
      (pc) => this.isPcValid(pc),
      this.partnerIdRef
    );
  }
  
  /**
   * Прожечь буфер кандидатов после получения идентификаторов
   * Вызывается после сохранения partnerSocketId/partnerUserId/roomId
   * КРИТИЧНО: Кандидаты кешируются по ключу from (socket.id), поэтому прожигаем
   * по partnerSocketIdRef в первую очередь. partnerIdRef (userId) используется
   * как fallback для обратной совместимости.
   */
  protected async flushBufferedCandidates(): Promise<void> {
    const pc = this.peerRef;
    if (!pc || !this.isPcValid(pc)) {
      return;
    }
    
    // Проверяем наличие remoteDescription
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      return;
    }
    
    // КРИТИЧНО: Прожигаем кандидаты для всех возможных ключей
    // Если remoteDescription установлен, это означает, что мы уже знаем партнера
    // (offer/answer пришли от конкретного партнера), поэтому безопасно обрабатывать
    // ВСЕ ключи в очереди - все кандидаты на момент установки remoteDescription
    // должны быть от этого партнера
    const allPendingKeys = this.iceAndSignalingManager.getAllPendingKeys();
    const keysToFlush: string[] = [];
    
    // Сначала добавляем известные ключи (приоритет)
    if (this.partnerSocketIdRef) {
      keysToFlush.push(this.partnerSocketIdRef);
    }
    if (this.partnerIdRef) {
      keysToFlush.push(this.partnerIdRef);
    }
    if (this.roomIdRef) {
      keysToFlush.push(this.roomIdRef);
    }
    
    // КРИТИЧНО: Если remoteDescription установлен, но идентификаторы ещё не установлены,
    // обрабатываем ВСЕ ключи в очереди. Это безопасно, т.к. remoteDescription устанавливается
    // только после получения offer/answer от конкретного партнера, и все кандидаты в очереди
    // на этот момент должны быть от этого партнера
    const hasAnyIdentifier = this.partnerSocketIdRef || this.partnerIdRef || this.roomIdRef;
    
    if (!hasAnyIdentifier) {
      // Идентификаторы ещё не установлены, но remoteDescription есть
      // Обрабатываем все ключи в очереди
      for (const key of allPendingKeys) {
        if (!keysToFlush.includes(key)) {
          keysToFlush.push(key);
        }
      }
    } else {
      // Идентификаторы установлены - проверяем соответствие
      for (const key of allPendingKeys) {
        const isPartnerSocket = this.partnerSocketIdRef && this.partnerSocketIdRef === key;
        const isPartnerId = this.partnerIdRef && this.partnerIdRef === key;
        const isRoomId = this.roomIdRef && this.roomIdRef === key;
        
        // Если ключ соответствует одному из идентификаторов, добавляем его
        if (isPartnerSocket || isPartnerId || isRoomId) {
          if (!keysToFlush.includes(key)) {
            keysToFlush.push(key);
          }
        }
      }
    }
    
    // Убираем дубликаты ключей
    const uniqueKeys = Array.from(new Set(keysToFlush));
    
    // КРИТИЧНО: Дедуплицируем кандидаты перед добавлением
    // Один и тот же кандидат может быть в разных ключах (from и roomId),
    // поэтому собираем все уникальные кандидаты и добавляем их один раз
    const allUniqueCandidates = this.iceAndSignalingManager.getAllUniqueCandidates(uniqueKeys);
    
    if (allUniqueCandidates.length > 0) {
      const pc = this.peerRef;
      if (pc && this.isPcValid(pc)) {
        const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
        if (hasRemoteDesc) {
          logger.debug('[BaseWebRTCSession] Flushing unique ICE candidates', {
            totalKeys: uniqueKeys.length,
            uniqueCandidates: allUniqueCandidates.length,
            keys: uniqueKeys
          });
          
          // Добавляем все уникальные кандидаты
          for (const candidate of allUniqueCandidates) {
            try {
              await pc.addIceCandidate(candidate);
            } catch (e: any) {
              const errorMsg = String(e?.message || '');
              if (!errorMsg.includes('InvalidStateError') && 
                  !errorMsg.includes('already exists') && 
                  !errorMsg.includes('closed')) {
                logger.warn('[BaseWebRTCSession] Error adding unique ICE candidate:', e);
              }
            }
          }
          
          // Удаляем очереди для всех обработанных ключей
          this.iceAndSignalingManager.deletePendingQueues(uniqueKeys);
        }
      }
    }
    
    // КРИТИЧНО: Прожигаем кеш исходящих ICE кандидатов
    this.iceAndSignalingManager.flushOutgoingIceCache(
      this.partnerIdRef,
      () => this.isFriendCall(),
      this.roomIdRef
    );
    
    logger.debug('[BaseWebRTCSession] Flushed buffered candidates', {
      keysFlushed: uniqueKeys.length,
      partnerSocketId: this.partnerSocketIdRef,
      partnerId: this.partnerIdRef,
      roomId: this.roomIdRef
    });
  }
  
  // ==================== Connection State ====================
  
  protected isPcConnected(): boolean {
    return this.connectionStateManager.isPcConnected(this.peerRef);
  }
  
  protected setConnected(connected: boolean): void {
    this.connectionStateManager.setConnected(
      connected,
      this.peerRef,
      this.partnerIdRef,
      () => {
        // Подключение установлено
        this.emit('connected');
        
        // Устанавливаем время установки соединения
        this.remoteStateManager.setConnectionEstablishedAt(Date.now());
        
        // Убеждаемся, что обработчик ontrack установлен
        const pc = this.peerRef;
        if (pc && this.partnerIdRef) {
          const hasOntrack = !!(pc as any)?.ontrack;
          if (!hasOntrack) {
            const partnerId = this.partnerIdRef;
            if (partnerId) {
              this.attachRemoteHandlers(pc, partnerId);
            }
          }
          
          // КРИТИЧНО: Проверяем наличие remoteStream и синхронизируем с компонентами
          const existingRemoteStream = this.streamManager.getRemoteStream();
          if (existingRemoteStream) {
            const videoTracks = (existingRemoteStream as any)?.getVideoTracks?.() || [];
            const audioTracks = (existingRemoteStream as any)?.getAudioTracks?.() || [];
            
            logger.info('[BaseWebRTCSession] ✅ Remote stream уже существует при установке соединения, синхронизируем с компонентами', {
              streamId: existingRemoteStream.id,
              hasVideo: videoTracks.length > 0,
              hasAudio: audioTracks.length > 0,
              videoTracksCount: videoTracks.length,
              audioTracksCount: audioTracks.length,
              isFriendCall: this.isFriendCall(),
              partnerId: this.partnerIdRef
            });
            
            // КРИТИЧНО: Эмитим событие remoteStream для синхронизации с компонентами
            // Это гарантирует, что компоненты получат стрим даже если событие было пропущено
            this.emit('remoteStream', existingRemoteStream);
            
            // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
            this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
          } else {
            // Fallback - проверяем receivers напрямую (оптимизировано для быстрого соединения)
            logger.info('[BaseWebRTCSession] Connection established but no remote stream, checking receivers...', {
              isFriendCall: this.isFriendCall(),
              partnerId: this.partnerIdRef
            });
            
            // КРИТИЧНО: Для масштабируемости используем более короткие и оптимизированные задержки
            // Проверяем сразу и затем с минимальными задержками
            this.checkReceiversForRemoteStream(pc);
            
            const delays = this.isFriendCall() ? [200, 500, 1000] : [500, 1000, 2000];
            delays.forEach((delay) => {
              setTimeout(() => {
                const currentPc = this.peerRef;
                const currentPartnerId = this.partnerIdRef;
                
                if (currentPc === pc && currentPartnerId && !this.streamManager.getRemoteStream()) {
                  this.checkReceiversForRemoteStream(currentPc);
                }
              }, delay);
            });
          }
        }
        
        // Очищаем таймеры reconnection
        this.connectionStateManager.clearReconnectTimer();
        
        // Запускаем метры и обновляем состояние загрузки
        this.startMicMeter();
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
        this.config.setIsNexting?.(false);
      },
      () => {
        // Подключение потеряно
        this.emit('disconnected');
        this.stopMicMeter();
      }
    );
  }
  
  /**
   * Проверка, является ли это дружеским звонком
   */
  protected isFriendCall(): boolean {
    return (this.config.getIsDirectCall?.() ?? false) ||
           (this.config.getInDirectCall?.() ?? false) ||
           (this.config.getFriendCallAccepted?.() ?? false);
  }
  
  /**
   * Проверка, является ли это рандомным чатом
   */
  protected isRandomChat(): boolean {
    return !this.isFriendCall();
  }
  
  // ==================== SDP Optimization ====================
  
  protected optimizeSdpForFastConnection(sdp: string): string {
    return this.iceAndSignalingManager.optimizeSdpForFastConnection(sdp);
  }
  
  // ==================== Hash Utility ====================
  
  protected hashString(str: string): string {
    return hashString(str);
  }
  
  // ==================== Public Getters ====================
  
  /**
   * Получить текущий локальный стрим
   */
  getLocalStream(): MediaStream | null {
    return this.streamManager.getLocalStream();
  }
  
  /**
   * Получить текущий удаленный стрим
   */
  getRemoteStream(): MediaStream | null {
    return this.streamManager.getRemoteStream();
  }
  
  /**
   * Получить текущий partnerId
   */
  getPartnerId(): string | null {
    return this.partnerIdRef;
  }
  
  /**
   * Получить текущий roomId
   */
  getRoomId(): string | null {
    return this.roomIdRef;
  }
  
  /**
   * Получить текущий callId
   */
  getCallId(): string | null {
    return this.callIdRef;
  }
  
  /**
   * Получить текущий PeerConnection
   */
  getPeerConnection(): RTCPeerConnection | null {
    return this.peerRef;
  }
  
  /**
   * Проверить, подключены ли мы
   */
  isConnected(): boolean {
    return this.connectionStateManager.isConnected();
  }
  
  // ==================== Protected Setters ====================
  
  /**
   * Установить partnerId
   */
  protected setPartnerId(partnerId: string | null): void {
    const wasNull = !this.partnerIdRef;
    this.partnerIdRef = partnerId;
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    this.emit('partnerId', partnerId);
    // КРИТИЧНО: Если идентификатор установлен впервые, прожигаем буфер кандидатов
    if (wasNull && partnerId) {
      this.flushBufferedCandidates().catch((e) => {
        logger.warn('[BaseWebRTCSession] Error flushing buffered candidates after setPartnerId:', e);
      });
    }
  }
  
  /**
   * Установить partnerSocketId (socket.id партнера для ICE кандидатов)
   */
  protected setPartnerSocketId(socketId: string | null): void {
    const wasNull = !this.partnerSocketIdRef;
    this.partnerSocketIdRef = socketId;
    logger.debug('[BaseWebRTCSession] PartnerSocketId установлен', { socketId });
    // КРИТИЧНО: Если идентификатор установлен впервые, прожигаем буфер кандидатов
    if (wasNull && socketId) {
      this.flushBufferedCandidates().catch((e) => {
        logger.warn('[BaseWebRTCSession] Error flushing buffered candidates after setPartnerSocketId:', e);
      });
    }
  }
  
  /**
   * Получить partnerSocketId
   */
  protected getPartnerSocketId(): string | null {
    return this.partnerSocketIdRef;
  }
  
  /**
   * Установить roomId
   */
  protected setRoomId(roomId: string | null): void {
    const wasNull = !this.roomIdRef;
    this.roomIdRef = roomId;
    this.config.callbacks.onRoomIdChange?.(roomId);
    this.config.onRoomIdChange?.(roomId);
    this.emit('roomId', roomId);
    // КРИТИЧНО: Если идентификатор установлен впервые, прожигаем буфер кандидатов
    if (wasNull && roomId) {
      this.flushBufferedCandidates().catch((e) => {
        logger.warn('[BaseWebRTCSession] Error flushing buffered candidates after setRoomId:', e);
      });
    }
  }
  
  /**
   * Установить callId
   */
  protected setCallId(callId: string | null): void {
    this.callIdRef = callId;
    this.config.callbacks.onCallIdChange?.(callId);
    this.config.onCallIdChange?.(callId);
    this.emit('callId', callId);
  }
  
  // ==================== Media Control ====================
  
  /**
   * Переключить микрофон
   */
  toggleMic(): void {
    const stream = this.streamManager.getLocalStream();
    if (!stream) return;
    
    const t = stream?.getAudioTracks?.()[0];
    if (!t) return;
    
    t.enabled = !t.enabled;
    this.config.callbacks.onMicStateChange?.(t.enabled);
    this.config.onMicStateChange?.(t.enabled);
    
    if (!t.enabled) {
      this.stopMicMeter();
    } else {
      setTimeout(() => {
        this.startMicMeter();
      }, 300);
    }
  }
  
  /**
   * Переключить камеру
   */
  toggleCam(): void {
    const localStream = this.streamManager.getLocalStream();
    if (!localStream) {
      logger.warn('[BaseWebRTCSession] toggleCam: No local stream');
      return;
    }
    
    const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
    if (!videoTrack) {
      logger.warn('[BaseWebRTCSession] toggleCam: No video track');
      return;
    }
    
    const oldValue = videoTrack.enabled;
    const newValue = !oldValue;
    videoTrack.enabled = newValue;
    
    this.config.callbacks.onCamStateChange?.(newValue);
    this.config.onCamStateChange?.(newValue);
    
    // Отправка состояния камеры через сокет
    this.sendCameraState(undefined, newValue);
  }
  
  /**
   * Отправить состояние камеры партнеру
   * Должен быть переопределен в наследниках для отправки через socket
   */
  sendCameraState(toPartnerId?: string, enabled?: boolean): void {
    // Базовая реализация - будет переопределена в наследниках
    // Пока оставляем пустым, так как логика зависит от типа звонка
  }
  
  /**
   * Перевернуть камеру (передняя/задняя)
   */
  async flipCam(): Promise<void> {
    const ls = this.streamManager.getLocalStream();
    if (!ls) return;
    
    const videoTrack = ls.getVideoTracks?.()?.[0];
    if (!videoTrack) return;
    
    // Пытаемся использовать нативный метод переключения
    if (typeof (videoTrack as any)._switchCamera === 'function') {
      (videoTrack as any)._switchCamera();
      return;
    }
    
    // Fallback: пересоздаем стрим с другой камерой
    try {
      const { mediaDevices } = require('react-native-webrtc');
      const currentFacing = 'front'; // TODO: track facing state
      const newFacing: CamSide = currentFacing === 'front' ? 'back' : 'front';
      const newStream = await mediaDevices.getUserMedia({
        video: { facingMode: newFacing },
        audio: true,
      });
      
      const newVideoTrack = (newStream as any)?.getVideoTracks?.()?.[0];
      const newAudioTracks = (newStream as any)?.getAudioTracks?.() || [];
      
      if (newVideoTrack && this.peerRef) {
        const sender = this.peerRef
          ?.getSenders()
          .find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
        
        (ls as any).addTrack(newVideoTrack);
        
        // КРИТИЧНО: Останавливаем старый трек немедленно, а не через setTimeout
        // Это предотвращает накопление "висячих" треков на Android
        try {
          (ls as any).removeTrack(videoTrack);
          videoTrack.enabled = false;
          videoTrack.stop();
          try { (videoTrack as any).release?.(); } catch {}
        } catch (e) {
          logger.warn('[BaseWebRTCSession] Error stopping old video track in flipCam:', e);
        }
      } else {
        // Если новый трек не удалось использовать, останавливаем весь новый стрим
        // чтобы не оставлять "висячие" треки
        try {
          const allNewTracks = newStream.getTracks?.() || [];
          allNewTracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
              try { (t as any).release?.(); } catch {}
            } catch {}
          });
        } catch (e) {
          logger.warn('[BaseWebRTCSession] Error stopping unused new stream in flipCam:', e);
        }
      }
    } catch (err) {
      logger.warn('[BaseWebRTCSession] flipCam fallback error', err);
    }
  }
  
  /**
   * Переключить удаленное аудио (динамик)
   */
  toggleRemoteAudio(): void {
    const stream = this.streamManager.getRemoteStream();
    if (!stream) {
      return;
    }

    try {
      const audioTracks = (stream as any)?.getAudioTracks?.() || [];
      if (audioTracks.length === 0) {
        return;
      }

      // Определяем текущее состояние (muted = все треки выключены)
      const currentlyMuted = audioTracks.every((track: any) => !track.enabled);

      // Переключаем состояние: если сейчас muted, то включаем, иначе выключаем
      const newEnabledState = currentlyMuted;

      // Применяем новое состояние ко всем аудио трекам
      audioTracks.forEach((track: any) => {
        if (track) {
          track.enabled = newEnabledState;
        }
      });

      // Обновляем внутреннее состояние
      this.remoteStateManager.setRemoteMuted(!newEnabledState);
      
      this.emitRemoteState();
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error toggling remote audio:', e);
    }
  }
  
  /**
   * Перезапустить локальную камеру
   */
  async restartLocalCamera(): Promise<void> {
    logger.warn('[BaseWebRTCSession] restartLocalCamera called - restarting local camera');
    
    // Сохраняем текущее состояние камеры
    const localStream = this.streamManager.getLocalStream();
    const currentVideoTrack = localStream ? (localStream as any)?.getVideoTracks?.()?.[0] : null;
    const wasEnabled = currentVideoTrack?.enabled ?? true;
    
    // Останавливаем старый стрим
    if (localStream) {
      try {
        const tracks = (localStream as any)?.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      this.streamManager.setLocalStream(null);
      this.emit('localStream', null);
    }
    
    // Пересоздаем стрим
    try {
      const newStream = await this.startLocalStream('front');
      if (newStream && isValidStream(newStream)) {
        const newVideoTrack = (newStream as any)?.getVideoTracks?.()?.[0];
        if (newVideoTrack) {
          newVideoTrack.enabled = wasEnabled;
        }
      } else {
        logger.error('[BaseWebRTCSession] restartLocalCamera: Failed to create valid stream');
      }
    } catch (e) {
      logger.error('[BaseWebRTCSession] restartLocalCamera: Error recreating stream:', e);
    }
  }
  
  /**
   * Остановить локальный стрим
   */
  async stopLocalStream(preserveStreamForConnection: boolean = false, force: boolean = false): Promise<void> {
    const started = this.config.getStarted?.() ?? false;
    const isSearching = started && !this.partnerIdRef && !this.roomIdRef;
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasStream = !!this.streamManager.getLocalStream();
    
    // Не останавливаем стрим если пользователь только что начал поиск
    if (isSearching && !preserveStreamForConnection && !force) {
      return;
    }
    
    // Сохраняем стрим только если есть активное соединение
    if (preserveStreamForConnection && hasActiveConnection) {
      try {
        if (this.peerRef || this.preCreatedPcRef) {
          this.incrementPcToken();
        }
        if (this.peerRef) {
          this.cleanupPeer(this.peerRef);
          this.peerRef = null;
        }
        if (this.preCreatedPcRef) {
          this.cleanupPeer(this.preCreatedPcRef);
          this.preCreatedPcRef = null;
        }
      } catch {}
      return;
    }
    
    if (!hasStream) {
      try {
        if (this.peerRef || this.preCreatedPcRef) {
          this.incrementPcToken();
        }
        if (this.peerRef) {
          this.cleanupPeer(this.peerRef);
          this.peerRef = null;
        }
        if (this.preCreatedPcRef) {
          this.cleanupPeer(this.preCreatedPcRef);
          this.preCreatedPcRef = null;
        }
      } catch {}
      return;
    }
    
    const ls = this.streamManager.getLocalStream();
    if (!ls) {
      try {
        if (this.peerRef || this.preCreatedPcRef) {
          this.incrementPcToken();
        }
        if (this.peerRef) {
          this.cleanupPeer(this.peerRef);
          this.peerRef = null;
        }
        if (this.preCreatedPcRef) {
          this.cleanupPeer(this.preCreatedPcRef);
          this.preCreatedPcRef = null;
        }
      } catch {}
      return;
    }
    
    const tracks = ls.getTracks?.() || [];
    const allTracksEnded = tracks.length === 0 || tracks.every((t: any) => t.readyState === 'ended');
    if (allTracksEnded && tracks.length > 0) {
      try {
        if (this.peerRef || this.preCreatedPcRef) {
          this.incrementPcToken();
        }
        if (this.peerRef) {
          this.cleanupPeer(this.peerRef);
          this.peerRef = null;
        }
        if (this.preCreatedPcRef) {
          this.cleanupPeer(this.preCreatedPcRef);
          this.preCreatedPcRef = null;
        }
      } catch {}
      this.streamManager.setLocalStream(null);
      this.emit('localStream', null);
      return;
    }
    
    try {
      // Инкрементируем токен перед очисткой
      if (this.peerRef || this.preCreatedPcRef) {
        this.incrementPcToken();
      }
      
      const pc = this.peerRef;
      if (pc) {
        this.peerRef = null;
        const senders = pc.getSenders() || [];
        const replacePromises = senders.map(async (sender: any) => {
          try {
            const track = sender.track;
            if (track) track.enabled = false;
            await sender.replaceTrack(null);
          } catch {}
        });
        await Promise.all(replacePromises);
        this.cleanupPeer(pc);
      }
      
      if (this.preCreatedPcRef) {
        try {
          const prePc = this.preCreatedPcRef;
          this.preCreatedPcRef = null;
          const preSenders = prePc.getSenders() || [];
          const preReplacePromises = preSenders.map(async (sender: any) => {
            try {
              const track = sender.track;
              if (track) track.enabled = false;
              await sender.replaceTrack(null);
            } catch {}
          });
          await Promise.all(preReplacePromises);
          this.cleanupPeer(prePc);
        } catch {}
      }
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error removing tracks from PeerConnection:', e);
    }
    
    // Очищаем стрим
    const { cleanupStream } = require('../../../utils/streamUtils');
    await cleanupStream(ls);
    this.streamManager.setLocalStream(null);
    this.emit('localStream', null);
  }
  
  // ==================== Socket Handlers ====================
  // Базовые методы обработки socket событий
  
  /**
   * Обработка offer (базовая логика)
   * Должен быть переопределен в наследниках для специфичной логики
   */
  protected async handleOffer({ from, offer, fromUserId, roomId }: { from: string; offer: any; fromUserId?: string; roomId?: string }): Promise<void> {
    // Базовая проверка дубликатов
    const pc = this.peerRef;
    const currentPcToken = this.pcLifecycleManager.getPcToken();
    const offerSdp = offer?.sdp || '';
    const offerKey = this.iceAndSignalingManager.createOfferKey(from, currentPcToken, offerSdp);
    
    if (this.iceAndSignalingManager.isProcessingOffer(offerKey) || this.iceAndSignalingManager.isOfferProcessed(offerKey)) {
      return;
    }
    
    if (pc) {
      const pcToken = (pc as any)?._pcToken ?? currentPcToken;
      if (pcToken !== currentPcToken) {
        return;
      }
      
      if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        return;
      }
      
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      if (hasRemoteDesc) {
        return;
      }
    }
    
    this.iceAndSignalingManager.markOfferProcessing(offerKey);
    
    // Устанавливаем roomId если он пришел
    if (roomId && !this.roomIdRef) {
      this.setRoomId(roomId);
    }
    
    // Устанавливаем partnerId
    if (from && !this.partnerIdRef) {
      this.setPartnerId(from);
      this.flushOutgoingIceCache();
    }
    
    // Получаем или создаем локальный стрим
    let stream = this.streamManager.getLocalStream();
    if (!stream) {
      stream = await this.startLocalStream('front');
      if (!stream || !isValidStream(stream)) {
        this.iceAndSignalingManager.markOfferProcessed(offerKey);
        return;
      }
    }
    
    // Создаем или получаем PC
    let pcForOffer = this.peerRef;
    if (!pcForOffer) {
      pcForOffer = await this.ensurePcWithLocal(stream);
      if (!pcForOffer) {
        this.iceAndSignalingManager.markOfferProcessed(offerKey);
        return;
      }
    }
    
    // Проверяем состояние PC
    if (pcForOffer.signalingState === 'closed' || (pcForOffer as any).connectionState === 'closed') {
      this.iceAndSignalingManager.markOfferProcessed(offerKey);
      return;
    }
    
    if (!this.isPcValid(pcForOffer)) {
      this.iceAndSignalingManager.markOfferProcessed(offerKey);
      return;
    }
    
    // Устанавливаем remote description
    const hasRemoteDesc = !!(pcForOffer as any).remoteDescription;
    if (!hasRemoteDesc) {
      // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен
      // Проверяем не только наличие обработчика, но и флаг
      if (from) {
        const hasHandler = !!(pcForOffer as any)?.ontrack;
        const hasFlag = (pcForOffer as any)?._remoteHandlersAttached === true;
        if (!hasHandler || !hasFlag) {
          logger.info('[BaseWebRTCSession] Устанавливаем обработчики удаленного стрима в handleOffer', {
            hasHandler,
            hasFlag,
            from
          });
          this.attachRemoteHandlers(pcForOffer, from);
        }
      }
      
      try {
        let offerDesc = offer;
        if (offer && typeof offer === 'object' && !offer.type) {
          offerDesc = { type: 'offer', sdp: offer.sdp || offer } as any;
        }
        
        await pcForOffer.setRemoteDescription(offerDesc as any);
        this.iceAndSignalingManager.markOfferProcessed(offerKey);
        
        // КРИТИЧНО: Прожигаем отложенные ICE кандидаты после установки remoteDescription
        // На Android offer/answer ставятся позже, поэтому первые кандидаты ждут
        await this.flushBufferedCandidates();
        
        // Создаем и отправляем answer
        await this.createAndSendAnswer(from, roomId);
      } catch (error: any) {
        const errorMsg = String(error?.message || '');
        if (!errorMsg.includes('closed') && !errorMsg.includes('null')) {
          logger.error('[BaseWebRTCSession] Error setting remote description:', error);
        }
        this.iceAndSignalingManager.markOfferProcessed(offerKey);
        return;
      }
    }
    
    this.iceAndSignalingManager.markOfferProcessed(offerKey);
  }
  
  /**
   * Создать и отправить answer
   */
  protected async createAndSendAnswer(from: string, roomId?: string): Promise<void> {
    const pc = this.peerRef;
    if (!pc) {
      return;
    }
    
    try {
      // Проверяем состояние
      if (pc.signalingState !== 'have-remote-offer') {
        return;
      }
      
      // Создаем answer
      const answer = await pc.createAnswer();
      
      // Оптимизация SDP
      if (answer.sdp) {
        answer.sdp = this.iceAndSignalingManager.optimizeSdpForFastConnection(answer.sdp);
      }
      
      // Устанавливаем local description
      await pc.setLocalDescription(answer);
      
      // Отправляем answer
      const answerPayload: any = {
        to: from,
        answer,
        fromUserId: this.config.myUserId
      };
      
      if (this.isFriendCall() && (roomId || this.roomIdRef)) {
        answerPayload.roomId = roomId || this.roomIdRef;
      }
      
      socket.emit('answer', answerPayload);
      
      // Прожигаем отложенные ICE кандидаты
      await this.flushIceFor(from);
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error creating/sending answer:', e);
    }
  }
  
  /**
   * Обработка answer (базовая логика)
   * Должен быть переопределен в наследниках для специфичной логики
   */
  protected async handleAnswer({ from, answer, roomId }: { from: string; answer: any; roomId?: string }): Promise<void> {
    // Базовая проверка дубликатов
    const pc = this.peerRef;
    if (!pc) {
      return;
    }
    
    // КРИТИЧНО: Проверяем состояние PC в самом начале - если уже stable, игнорируем answer
    const initialState = pc.signalingState;
    const initialHasRemoteDesc = !!(pc as any).remoteDescription;
    
    if (initialState === 'stable' || initialHasRemoteDesc) {
      // Не логируем - это нормальная ситуация (дубликат answer)
      return;
    }
    
    const currentPcToken = this.pcLifecycleManager.getPcToken();
    const answerSdp = answer?.sdp || '';
    const answerKey = this.iceAndSignalingManager.createAnswerKey(from, currentPcToken, answerSdp);
    
    if (this.iceAndSignalingManager.isProcessingAnswer(answerKey) || this.iceAndSignalingManager.isAnswerProcessed(answerKey)) {
      logger.info('[BaseWebRTCSession] Answer already processed or processing - ignoring duplicate', { from, answerKey });
      return;
    }
    
    if ((pc.signalingState as any) === 'closed' || (pc.connectionState as any) === 'closed' || !this.peerRef || this.peerRef !== pc) {
      return;
    }
    
    if (!this.isPcValid(pc)) {
      return;
    }
    
    this.iceAndSignalingManager.markAnswerProcessing(answerKey);
    
    // Устанавливаем roomId если он пришел
    if (roomId && !this.roomIdRef) {
      this.setRoomId(roomId);
    }
    
    // Проверяем состояние PC
    const hasLocalDesc = !!(pc as any).localDescription;
    const hasRemoteDesc = !!(pc as any).remoteDescription;
    const currentState = pc.signalingState;
    
    // КРИТИЧНО: Если PC уже в stable, оба SDP установлены - не обрабатываем answer
    if (currentState === 'stable') {
      logger.info('[BaseWebRTCSession] PC already in stable state - answer already processed, ignoring duplicate', {
        from,
        signalingState: currentState,
        hasLocalDesc,
        hasRemoteDesc
      });
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    // КРИТИЧНО: Если remoteDescription уже установлен, answer уже обработан
    if (hasRemoteDesc) {
      logger.info('[BaseWebRTCSession] remoteDescription already set - answer already processed, ignoring duplicate', {
        from,
        signalingState: currentState,
        hasLocalDesc,
        hasRemoteDesc
      });
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    // КРИТИЧНО: Проверяем что PC в правильном состоянии для обработки answer
    if (currentState !== 'have-local-offer' || !hasLocalDesc) {
      logger.warn('[BaseWebRTCSession] Cannot process answer - wrong state', {
        from,
        signalingState: currentState,
        hasLocalDesc,
        hasRemoteDesc,
        expectedState: 'have-local-offer'
      });
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    // КРИТИЧНО: Убрана задержка для оптимизации производительности
    // Проверки состояния PC уже достаточно для предотвращения гонок
    
    const currentPc = this.peerRef;
    if (!currentPc || currentPc !== pc) {
      logger.warn('[BaseWebRTCSession] PC changed during answer processing');
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    // КРИТИЧНО: Проверяем состояние еще раз после задержки
    const finalState = currentPc.signalingState;
    const finalHasLocalDesc = !!(currentPc as any).localDescription;
    const finalHasRemoteDesc = !!(currentPc as any).remoteDescription;
    
    // КРИТИЧНО: Если PC уже в stable, answer уже был обработан - игнорируем дубликат
    if (finalState === 'stable') {
      logger.info('[BaseWebRTCSession] PC already in stable state after delay, answer already processed - ignoring duplicate', {
        from,
        signalingState: finalState,
        hasLocalDesc: finalHasLocalDesc,
        hasRemoteDesc: finalHasRemoteDesc
      });
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    if (finalState !== 'have-local-offer' || !finalHasLocalDesc || finalHasRemoteDesc) {
      logger.warn('[BaseWebRTCSession] PC state changed during delay', {
        signalingState: finalState,
        hasLocalDesc: finalHasLocalDesc,
        hasRemoteDesc: finalHasRemoteDesc
      });
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    // КРИТИЧНО: Проверяем что PC все еще валиден
    if (!this.isPcValid(currentPc)) {
      logger.warn('[BaseWebRTCSession] PC became invalid during answer processing');
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    try {
      // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен
      // Проверяем не только наличие обработчика, но и флаг
      if (from) {
        const hasHandler = !!(currentPc as any)?.ontrack;
        const hasFlag = (currentPc as any)?._remoteHandlersAttached === true;
        if (!hasHandler || !hasFlag) {
          logger.info('[BaseWebRTCSession] Устанавливаем обработчики удаленного стрима в handleAnswer', {
            hasHandler,
            hasFlag,
            from
          });
          this.attachRemoteHandlers(currentPc, from);
        }
      }
      
      // Преобразуем answer в RTCSessionDescription если нужно
      let answerDesc = answer;
      if (answer && typeof answer === 'object' && !answer.type) {
        answerDesc = { type: 'answer', sdp: answer.sdp || answer } as any;
      }
      
      // КРИТИЧНО: Проверяем состояние еще раз перед setRemoteDescription
      const stateBeforeSet = currentPc.signalingState;
      const hasLocalDescBeforeSet = !!(currentPc as any).localDescription;
      const hasRemoteDescBeforeSet = !!(currentPc as any).remoteDescription;
      
      // КРИТИЧНО: Если PC уже в stable, оба SDP установлены - не устанавливаем remoteDescription для answer
      if (stateBeforeSet === 'stable') {
        logger.info('[BaseWebRTCSession] PC already in stable before setRemoteDescription for answer - answer already processed, skipping', {
          from,
          signalingState: stateBeforeSet,
          hasLocalDesc: hasLocalDescBeforeSet,
          hasRemoteDesc: hasRemoteDescBeforeSet
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      // КРИТИЧНО: Если remoteDescription уже установлен, не устанавливаем снова
      if (hasRemoteDescBeforeSet) {
        logger.info('[BaseWebRTCSession] remoteDescription already set before setRemoteDescription for answer - skipping', {
          from,
          signalingState: stateBeforeSet,
          hasRemoteDesc: hasRemoteDescBeforeSet
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что PC в правильном состоянии для установки answer
      if (stateBeforeSet !== 'have-local-offer' || !hasLocalDescBeforeSet) {
        logger.warn('[BaseWebRTCSession] PC not in have-local-offer state before setRemoteDescription for answer', {
          signalingState: stateBeforeSet,
          hasLocalDesc: hasLocalDescBeforeSet,
          hasRemoteDesc: hasRemoteDescBeforeSet
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      // КРИТИЧНО: Финальная проверка непосредственно перед вызовом
      const finalCheckState = currentPc.signalingState;
      const finalHasRemoteDesc = !!(currentPc as any).remoteDescription;
      
      // КРИТИЧНО: Если PC уже в stable или remoteDescription установлен, не устанавливаем
      if (finalCheckState === 'stable') {
        logger.info('[BaseWebRTCSession] PC already in stable at final check - answer already processed, skipping setRemoteDescription', {
          from,
          previousState: stateBeforeSet,
          currentState: finalCheckState,
          hasRemoteDesc: finalHasRemoteDesc
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      if (finalHasRemoteDesc) {
        logger.info('[BaseWebRTCSession] remoteDescription already set at final check - skipping setRemoteDescription', {
          from,
          signalingState: finalCheckState,
          hasRemoteDesc: finalHasRemoteDesc
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      if (finalCheckState !== 'have-local-offer') {
        logger.warn('[BaseWebRTCSession] PC not in have-local-offer at final check - aborting', {
          from,
          previousState: stateBeforeSet,
          currentState: finalCheckState
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      logger.info('[BaseWebRTCSession] 📥 Setting remote description for answer', {
        from,
        signalingState: finalCheckState,
        hasRemoteDesc: finalHasRemoteDesc
      });
      
      // КРИТИЧНО: Последняя проверка прямо перед вызовом (синхронно, без await)
      const immediateState = currentPc.signalingState;
      if (immediateState === 'stable' || !!(currentPc as any).remoteDescription) {
        logger.warn('[BaseWebRTCSession] PC state changed to stable IMMEDIATELY before setRemoteDescription - aborting', {
          from,
          stateBeforeSet,
          finalCheckState,
          immediateState
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      await currentPc.setRemoteDescription(answerDesc as any);
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      
      // КРИТИЧНО: Прожигаем отложенные ICE кандидаты после установки remoteDescription
      // На Android offer/answer ставятся позже, поэтому первые кандидаты ждут
      // Используем flushBufferedCandidates вместо flushIceFor для обработки всех ключей
      await this.flushBufferedCandidates();
    } catch (error: any) {
      const errorMsg = String(error?.message || '');
      const currentState = currentPc?.signalingState;
      const hasRemoteDesc = !!(currentPc as any)?.remoteDescription;
      
      // КРИТИЧНО: Если ошибка "Called in wrong state: stable", это значит answer уже был обработан
      if (errorMsg.includes('wrong state') && errorMsg.includes('stable')) {
        logger.info('[BaseWebRTCSession] Answer already processed (PC in stable) - ignoring error', {
          from,
          error: errorMsg,
          signalingState: currentState,
          hasRemoteDesc
        });
        this.iceAndSignalingManager.markAnswerProcessed(answerKey);
        return;
      }
      
      if (!errorMsg.includes('closed') && !errorMsg.includes('null')) {
        logger.error('[BaseWebRTCSession] Error setting remote description for answer:', {
          from,
          error: errorMsg,
          signalingState: currentState,
          hasRemoteDesc,
          errorObj: error
        });
      }
      this.iceAndSignalingManager.markAnswerProcessed(answerKey);
      return;
    }
    
    this.iceAndSignalingManager.markAnswerProcessed(answerKey);
  }
  
  /**
   * Обработка ICE candidate (базовая логика)
   * КРИТИЧНО: Буферизует все входящие кандидаты, если нет идентификаторов или PC не создан
   */
  protected async handleCandidate({ from, candidate, fromUserId, roomId }: { from: string; candidate: any; fromUserId?: string; roomId?: string }): Promise<void> {
    const pc = this.peerRef;
    
    // КРИТИЧНО: Если PC не создан или невалиден, буферизуем кандидат
    if (!pc || !this.isPcValid(pc)) {
      this.enqueueIce(from, candidate, roomId);
      const bufferCount = (this as any).__iceBufferCount = ((this as any).__iceBufferCount || 0) + 1;
      if (bufferCount <= 3) {
        logger.debug('[BaseWebRTCSession] ICE candidate buffered (no PC)', {
          from,
          fromUserId,
          roomId,
          bufferCount
        });
      }
      return;
    }
    
    // КРИТИЧНО: Проверяем наличие идентификаторов
    // Если нет ни одного идентификатора, буферизуем все кандидаты
    const hasAnyIdentifier = this.partnerSocketIdRef || this.partnerIdRef || this.roomIdRef;
    
    if (!hasAnyIdentifier) {
      // Нет идентификаторов - буферизуем все кандидаты
      this.enqueueIce(from, candidate, roomId);
      const bufferCount = (this as any).__iceBufferCount = ((this as any).__iceBufferCount || 0) + 1;
      if (bufferCount <= 3) {
        logger.debug('[BaseWebRTCSession] ICE candidate buffered (no identifiers)', {
          from,
          fromUserId,
          roomId,
          bufferCount
        });
      }
      return;
    }
    
    // КРИТИЧНО: Максимально гибкий фильтр ICE
    // Принимаем кандидаты, если совпадает хотя бы одно:
    // 1. from == partnerSocketIdRef (socket.id партнера)
    // 2. from == partnerIdRef (userId партнера, для обратной совместимости)
    // 3. roomId == roomIdRef
    // 4. fromUserId == partnerIdRef
    const isFromPartnerSocket = this.partnerSocketIdRef && this.partnerSocketIdRef === from;
    const isFromPartnerUserId = this.partnerIdRef && this.partnerIdRef === from;
    const isFromSameRoom = roomId && this.roomIdRef && roomId === this.roomIdRef;
    const isFromPartnerByUserId = fromUserId && this.partnerIdRef && fromUserId === this.partnerIdRef;
    
    // КРИТИЧНО: Если фильтр не прошёл, НЕ делаем жёсткий return - буферизуем
    if (!isFromPartnerSocket && !isFromPartnerUserId && !isFromSameRoom && !isFromPartnerByUserId) {
      // Буферизуем кандидат на случай, если идентификаторы появятся позже
      this.enqueueIce(from, candidate, roomId);
      const bufferCount = (this as any).__iceBufferCount = ((this as any).__iceBufferCount || 0) + 1;
      if (bufferCount <= 3) {
        logger.debug('[BaseWebRTCSession] ICE candidate buffered (filter not passed, waiting for identifiers)', {
          from,
          fromUserId,
          roomId,
          partnerSocketIdRef: this.partnerSocketIdRef,
          partnerIdRef: this.partnerIdRef,
          roomIdRef: this.roomIdRef,
          isFromPartnerSocket,
          isFromPartnerUserId,
          isFromSameRoom,
          isFromPartnerByUserId
        });
      }
      return;
    }
    
    // Если remoteDescription еще не установлен, кешируем кандидат
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      this.enqueueIce(from, candidate, roomId);
      return;
    }
    
    // Добавляем кандидат сразу
    try {
      await pc.addIceCandidate(candidate);
    } catch (e: any) {
      const errorMsg = String(e?.message || '');
      if (!errorMsg.includes('InvalidStateError') && 
          !errorMsg.includes('already exists') && 
          !errorMsg.includes('closed')) {
        logger.warn('[BaseWebRTCSession] Error adding ICE candidate:', e);
      }
    }
  }
  
  /**
   * Создать и отправить offer
   * Должен быть переопределен в наследниках для специфичной логики
   */
  protected async createAndSendOffer(toPartnerId: string, roomId?: string): Promise<void> {
    const pc = this.peerRef;
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
        offer.sdp = this.iceAndSignalingManager.optimizeSdpForFastConnection(offer.sdp);
      }
      
      // Устанавливаем local description
      await pc.setLocalDescription(offer);
      
      // Отправляем offer (логика отправки будет в наследниках)
      const offerPayload: any = {
        to: toPartnerId,
        offer,
        fromUserId: this.config.myUserId
      };
      
      if (this.isFriendCall() && (roomId || this.roomIdRef)) {
        offerPayload.roomId = roomId || this.roomIdRef;
      }
      
      socket.emit('offer', offerPayload);
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error creating/sending offer:', e);
    }
  }
  
  /**
   * Обработка cam-toggle события
   */
  protected handleCamToggle({ enabled, from, roomId }: { enabled: boolean; from: string; roomId?: string }): void {
    const currentPartnerId = this.partnerIdRef;
    const currentRoomId = this.roomIdRef;
    const isDirectFriendCall = this.isFriendCall();
    
    // Проверяем, нужно ли обрабатывать это событие
    const shouldProcess = isDirectFriendCall 
      ? (currentPartnerId === from || !currentPartnerId || (roomId && roomId === currentRoomId) || (currentRoomId && roomId === currentRoomId)) 
      : (currentPartnerId === from);
    
    if (!shouldProcess) {
      return;
    }
    
    // Восстанавливаем partnerId если нужно
    if (!isDirectFriendCall && !currentPartnerId) {
      this.setPartnerId(from);
    }
    
    // Для рандомного чата проверяем фактическое состояние видео трека
    if (!isDirectFriendCall) {
      const rs = this.streamManager.getRemoteStream();
      if (rs) {
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        if (vt && vt.readyState !== 'ended' && !enabled) {
          const now = Date.now();
          const connectionAge = now - this.remoteStateManager.getConnectionEstablishedAt();
          const isRecentConnection = connectionAge < 5000;
          const streamAge = this.streamManager.getRemoteStreamEstablishedAt() ? now - this.streamManager.getRemoteStreamEstablishedAt() : Infinity;
          const isTrackStable = vt.readyState === 'live' && streamAge >= 300;
          
          if ((vt.readyState !== 'live' || !isTrackStable) && isRecentConnection) {
            return;
          }
        }
      } else if (!enabled) {
        const now = Date.now();
        const connectionAge = now - this.remoteStateManager.getConnectionEstablishedAt();
        if (connectionAge < 5000) {
          return;
        }
      }
    }
    
    // Проверяем, нужно ли обновлять remoteCamOn
    // КРИТИЧНО: Для friend-call всегда обновляем remoteCamOn, чтобы UI сразу реагировал на изменения
    // Для рандом-чата оставляем защиту от преждевременного обновления
    let shouldUpdateRemoteCamOn = true;
    
    if (!isDirectFriendCall && !enabled) {
      // Для рандомного чата используем защиту от преждевременного обновления
      const now = Date.now();
      const connectionAge = now - this.remoteStateManager.getConnectionEstablishedAt();
      const isRecentConnection = connectionAge < 5000;
      
      const rs = this.streamManager.getRemoteStream();
      if (rs) {
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        const streamAge = this.streamManager.getRemoteStreamEstablishedAt() ? now - this.streamManager.getRemoteStreamEstablishedAt() : Infinity;
        const isTrackStable = vt && vt.readyState === 'live' && streamAge >= 300;
        
        if (isRecentConnection && vt && vt.readyState !== 'ended' && (!isTrackStable || vt.readyState !== 'live')) {
          shouldUpdateRemoteCamOn = false;
        }
      } else if (isRecentConnection) {
        shouldUpdateRemoteCamOn = false;
      }
    }
    
    // Обновляем состояние трека
    try {
      const rs = this.streamManager.getRemoteStream();
      const vt = rs ? (rs as any)?.getVideoTracks?.()?.[0] : null;
      const pc = this.peerRef;
      
      if (vt) {
        if (vt.readyState !== 'ended') {
          // Проверяем стабильность трека перед применением cam-toggle для рандомного чата
          if (!isDirectFriendCall && !enabled) {
            const now = Date.now();
            const streamAge = this.streamManager.getRemoteStreamEstablishedAt() ? now - this.streamManager.getRemoteStreamEstablishedAt() : Infinity;
            const isTrackLive = vt.readyState === 'live';
            const isTrackStable = isTrackLive && streamAge >= 300;
            
            if (!isTrackStable) {
              return;
            }
          }
          
          // Для дружеских звонков всегда применяем cam-toggle напрямую к треку,
          // чтобы показать заглушку "Отошел" у собеседника.
          // Для рандомных оставляем защиту от преждевременного выключения.
          if (isDirectFriendCall) {
            // Для friend-call всегда применяем vt.enabled = enabled
            vt.enabled = enabled;
          } else {
            // Для рандом-чата оставляем защиту
            const isTrackLive = vt.readyState === 'live';
            const isTrackCurrentlyEnabled = vt.enabled === true;
            
            if (!enabled && isTrackLive && isTrackCurrentlyEnabled) {
              logger.info('[BaseWebRTCSession] Не устанавливаем enabled=false для live трека - используем фактическое состояние', {
                readyState: vt.readyState,
                currentEnabled: vt.enabled,
                isDirectFriendCall
              });
              // Не устанавливаем enabled=false - трек остается enabled=true, так как это фактическое состояние
              // Используем фактическое состояние трека для UI
              shouldUpdateRemoteCamOn = false; // Не обновляем remoteCamOn, так как трек фактически включен
            } else {
              // Устанавливаем enabled для рандом-чата
              vt.enabled = enabled;
            }
          }
          
          this.remoteStateManager.setPendingCamToggle(null);
        } else {
          const isPcActive = pc && 
            pc.signalingState !== 'closed' && 
            (pc as any).connectionState !== 'closed';
          const isPartnerMatch = !this.partnerIdRef || this.partnerIdRef === from;
          
          if (isPcActive && isPartnerMatch) {
            this.remoteStateManager.setPendingCamToggle(null);
          } else {
            return;
          }
        }
      } else {
        if (!rs) {
          this.remoteStateManager.setPendingCamToggle({
            enabled,
            from,
            timestamp: Date.now()
          });
        }
      }
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error updating remote track:', e);
    }
    
    // Обновляем состояние
    this.camToggleSeenRef = true;
    this.remoteStateManager.updateRemoteViewKey((event, ...args) => this.emit(event, ...args));
    
    if (shouldUpdateRemoteCamOn) {
      const oldRemoteCamOn = this.remoteStateManager.isRemoteCamOn();
      this.remoteStateManager.setRemoteForcedOff(!enabled);
      this.remoteStateManager.setRemoteCamOn(enabled, (event, ...args) => this.emit(event, ...args));
      
      if (oldRemoteCamOn !== enabled) {
        this.emitRemoteState();
      }
    }
  }
  
  /**
   * Настройка обработчиков socket
   * Должен быть переопределен в наследниках
   */
  protected setupSocketHandlers(): void {
    // КРИТИЧНО: Логируем регистрацию обработчиков для отладки
    logger.info('[BaseWebRTCSession] 🔧 Registering socket handlers', {
      socketId: socket.id,
      socketConnected: socket.connected,
      currentRoomId: this.roomIdRef,
      currentPartnerId: this.partnerIdRef
    });
    
    // Базовые обработчики для всех типов сессий
    socket.on('offer', async (data: any) => {
      logger.info('[BaseWebRTCSession] 📥 Offer received from server', {
        from: data.from || socket.id,
        fromUserId: data.fromUserId,
        roomId: data.roomId,
        hasOffer: !!data.offer,
        currentRoomId: this.roomIdRef,
        currentPartnerId: this.partnerIdRef
      });
      await this.handleOffer({
        from: data.from || socket.id,
        offer: data.offer,
        fromUserId: data.fromUserId,
        roomId: data.roomId
      });
    });
    
    socket.on('answer', async (data: any) => {
      logger.info('[BaseWebRTCSession] 📥 Answer received from server', {
        from: data.from || socket.id,
        roomId: data.roomId,
        hasAnswer: !!data.answer,
        currentRoomId: this.roomIdRef,
        currentPartnerId: this.partnerIdRef
      });
      await this.handleAnswer({
        from: data.from || socket.id,
        answer: data.answer,
        roomId: data.roomId
      });
    });
    
    socket.on('ice-candidate', async (data: any) => {
      // Логируем только первые несколько кандидатов для отладки
      const candidateCount = (this as any).__iceCandidateCount = ((this as any).__iceCandidateCount || 0) + 1;
      if (candidateCount <= 3) {
        logger.info('[BaseWebRTCSession] 📥 ICE candidate received from server', {
          from: data.from || socket.id,
          fromUserId: data.fromUserId,
          roomId: data.roomId,
          candidateCount,
          hasCandidate: !!data.candidate,
          currentRoomId: this.roomIdRef,
          currentPartnerId: this.partnerIdRef,
          currentPartnerSocketId: this.partnerSocketIdRef
        });
      }
      await this.handleCandidate({
        from: data.from || socket.id,
        candidate: data.candidate,
        fromUserId: data.fromUserId,
        roomId: data.roomId
      });
    });
    
    logger.info('[BaseWebRTCSession] ✅ Socket handlers registered', {
      socketId: socket.id,
      hasOfferHandler: true,
      hasAnswerHandler: true,
      hasIceCandidateHandler: true
    });
    
    socket.on('cam-toggle', (data: { enabled: boolean; from: string; roomId?: string }) => {
      this.handleCamToggle({
        enabled: data.enabled,
        from: data.from || socket.id || '',
        roomId: data.roomId
      });
    });
    
    socket.on('pip:state', (data: { inPiP: boolean; from: string; roomId: string }) => {
      this.handlePiPState(data);
    });
  }
  
  /**
   * Обработка pip:state события
   */
  protected handlePiPState(data: { inPiP: boolean; from: string; roomId: string }): void {
    this.pipManager.handlePiPState(
      data,
      this.partnerIdRef,
      this.roomIdRef,
      (event, ...args) => this.emit(event, ...args)
    );
    this.emitRemoteState();
  }
  
  // ==================== Abstract Methods ====================
  // Эти методы должны быть реализованы в наследниках
  
  /**
   * Очистка ресурсов при завершении сессии
   */
  abstract cleanup(): void;
  
  /**
   * Создать PeerConnection с локальным стримом
   * Логика зависит от типа сессии (видеозвонок vs рандомный чат)
   */
  abstract ensurePcWithLocal(stream: MediaStream): Promise<RTCPeerConnection | null>;
}
