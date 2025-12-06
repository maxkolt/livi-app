import { RTCPeerConnection, MediaStream, mediaDevices } from 'react-native-webrtc';
import { AppState, Platform } from 'react-native';
import { getIceConfiguration, getEnvFallbackConfiguration } from '../../../utils/iceConfig';
import { isValidStream } from '../../../utils/streamUtils';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';
import { SimpleEventEmitter } from './SimpleEventEmitter';
import type { CamSide, WebRTCSessionConfig } from '../types';

/**
 * Базовый класс для WebRTC сессий
 * Содержит общую логику для работы с PeerConnection, стримами, ICE
 * Наследуется VideoCallSession и RandomChatSession
 */
export abstract class BaseWebRTCSession extends SimpleEventEmitter {
  // PeerConnection
  protected peerRef: RTCPeerConnection | null = null;
  protected preCreatedPcRef: RTCPeerConnection | null = null;
  
  // Streams
  protected localStreamRef: MediaStream | null = null;
  protected remoteStreamRef: MediaStream | null = null;
  
  // Connection identifiers
  protected partnerIdRef: string | null = null;
  protected roomIdRef: string | null = null;
  protected callIdRef: string | null = null;
  
  // ICE Configuration
  protected iceConfigRef: RTCConfiguration | null = null;
  protected iceCandidateQueue: Map<string, any[]> = new Map();
  protected pendingIceByFromRef: Record<string, any[]> = {};
  protected outgoingIceCache: any[] = [];
  
  // Offer/Answer processing
  protected processingOffersRef: Set<string> = new Set();
  protected processingAnswersRef: Set<string> = new Set();
  protected processedOffersRef: Set<string> = new Set();
  protected processedAnswersRef: Set<string> = new Set();
  protected offerCounterByKeyRef: Map<string, number> = new Map();
  protected answerCounterByKeyRef: Map<string, number> = new Map();
  protected iceRestartInProgressRef: boolean = false;
  protected restartCooldownRef: number = 0;
  protected isInPiPRef: boolean = false;
  
  // PC creation lock
  protected pcCreationInProgressRef: boolean = false;
  protected roomJoinedRef: Set<string> = new Set();
  protected callAcceptedProcessingRef: boolean = false;
  
  // PC token protection
  protected pcToken: number = 0;
  
  // Connection state management
  protected isConnectedRef: boolean = false;
  protected reconnectTimerRef: ReturnType<typeof setTimeout> | null = null;
  protected connectionCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  
  // Remote camera state management
  protected remoteCamOnRef: boolean = true;
  protected remoteForcedOffRef: boolean = false;
  protected camToggleSeenRef: boolean = false;
  protected remoteViewKeyRef: number = 0;
  protected trackCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  protected connectionEstablishedAtRef: number = 0;
  protected pendingCamToggleRef: { enabled: boolean; from: string; timestamp: number } | null = null;
  protected remoteStreamEstablishedAtRef: number = 0;
  protected endedStreamIgnoredAtRef: number = 0;
  protected endedStreamTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  
  // Remote audio state management
  protected remoteMutedRef: boolean = false;
  
  // Remote PiP state management
  protected remoteInPiPRef: boolean = false;
  
  // PiP state management
  protected pipPrevCamOnRef: boolean | null = null;
  
  // Mic meter management
  protected micStatsTimerRef: ReturnType<typeof setInterval> | null = null;
  protected energyRef: number | null = null;
  protected durRef: number | null = null;
  protected lowLevelCountRef: number = 0;
  
  // Auto-search management (для рандомного чата)
  protected autoSearchTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  protected lastAutoSearchRef: number = 0;
  protected manuallyRequestedNextRef: boolean = false;
  
  // AppState management
  protected appStateSubscription: any = null;
  protected wasInBackgroundRef: boolean = false;
  
  protected config: WebRTCSessionConfig;
  
  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    this.loadIceConfiguration();
    this.startTrackChecker();
    this.setupAppStateListener();
  }
  
  // ==================== ICE Configuration ====================
  
  protected async loadIceConfiguration() {
    try {
      const config = await getIceConfiguration();
      this.iceConfigRef = config;
      
      // КРИТИЧНО: Проверяем наличие TURN серверов для отладки
      const hasTurn = config.iceServers?.some((server: any) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((u: string) => u && u.startsWith('turn:'));
      }) ?? false;
      
      if (!hasTurn) {
        logger.warn('[BaseWebRTCSession] ⚠️ NO TURN SERVER in ICE configuration - NAT traversal may fail!');
      } else {
        logger.info('[BaseWebRTCSession] ✅ TURN server found in ICE configuration');
      }
    } catch (error) {
      logger.error('[BaseWebRTCSession] Failed to load ICE configuration:', error);
      this.iceConfigRef = getEnvFallbackConfiguration();
      
      // Проверяем fallback конфигурацию
      const hasTurn = this.iceConfigRef.iceServers?.some((server: any) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((u: string) => u && u.startsWith('turn:'));
      }) ?? false;
      
      if (!hasTurn) {
        logger.warn('[BaseWebRTCSession] ⚠️ NO TURN SERVER in fallback configuration - NAT traversal may fail!');
      }
    }
  }
  
  protected getIceConfig(): RTCConfiguration {
    if (this.iceConfigRef) {
      return this.iceConfigRef;
    }
    return getEnvFallbackConfiguration();
  }
  
  // ==================== Stream Management ====================
  
  /**
   * Создать локальный стрим
   * Общая логика для всех типов сессий
   */
  async startLocalStream(side: CamSide = 'front'): Promise<MediaStream | null> {
    // Проверка PiP стрима
    const resume = this.config.getResume?.() ?? false;
    const fromPiP = this.config.getFromPiP?.() ?? false;
    const pipLocalStream = this.config.getPipLocalStream?.();
    
    if (resume && fromPiP && pipLocalStream && isValidStream(pipLocalStream)) {
      this.localStreamRef = pipLocalStream;
      this.config.callbacks.onLocalStreamChange?.(pipLocalStream);
      this.config.onLocalStreamChange?.(pipLocalStream);
      this.emit('localStream', pipLocalStream);
      return pipLocalStream;
    }
    
    // Проверка существующего стрима
    const existingStream = this.localStreamRef;
    if (existingStream && isValidStream(existingStream)) {
      const tracks = existingStream.getTracks?.() || [];
      const activeTracks = tracks.filter((t: any) => t.readyState === 'live');
      
      if (activeTracks.length > 0) {
        this.config.callbacks.onLocalStreamChange?.(existingStream);
        this.config.onLocalStreamChange?.(existingStream);
        this.emit('localStream', existingStream);
        return existingStream;
      } else {
        // Очищаем неактивный стрим
        try {
          tracks.forEach((t: any) => {
            try { t.stop(); } catch {}
          });
        } catch {}
        this.localStreamRef = null;
        this.config.callbacks.onLocalStreamChange?.(null);
        this.config.onLocalStreamChange?.(null);
        this.emit('localStream', null);
      }
    }
    
    // Очистка невалидного стрима
    if (existingStream && !isValidStream(existingStream)) {
      try {
        const tracks = existingStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      this.localStreamRef = null;
      this.config.callbacks.onLocalStreamChange?.(null);
      this.config.onLocalStreamChange?.(null);
      this.emit('localStream', null);
    }
    
    // Создание нового стрима
    const audioConstraints: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googAutoGainControl: true,
    };
    
    const try1 = () => mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
    const try2 = () => mediaDevices.getUserMedia({ audio: audioConstraints, video: { facingMode: 'user' as any } });
    const try3 = async () => {
      const devs = await mediaDevices.enumerateDevices();
      const cams = (devs as any[]).filter(d => d.kind === 'videoinput');
      const front = cams.find(d => /front|user/i.test(d.facing || d.label || '')) || cams[0];
      return mediaDevices.getUserMedia({ audio: audioConstraints, video: { deviceId: (front as any)?.deviceId } as any });
    };
    
    let stream: MediaStream | null = null;
    try {
      stream = await try1();
      if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try1');
    } catch (e1) {
      try {
        stream = await try2();
        if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try2');
      } catch (e2) {
        try {
          stream = await try3();
        } catch (e3) {
          logger.error('[BaseWebRTCSession] All getUserMedia attempts failed:', e3);
          throw new Error(`All getUserMedia attempts failed. Last error: ${e3 instanceof Error ? e3.message : String(e3)}`);
        }
      }
    }
    
    if (!stream) {
      throw new Error('Failed to get media stream from all attempts');
    }
    
    // Проверяем валидность стрима
    if (!isValidStream(stream)) {
      try {
        const tracks = (stream as any)?.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      throw new Error('Stream is not valid');
    }
    
    // Убеждаемся что камера включена
    const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
    if (videoTrack) {
      videoTrack.enabled = true;
    }
    
    // Убеждаемся что микрофон включен
    const audioTrack = (stream as any)?.getAudioTracks?.()?.[0];
    if (audioTrack) {
      audioTrack.enabled = true;
    }
    
    const audioTracks = (stream as any)?.getAudioTracks?.() || [];
    const videoTracks = (stream as any)?.getVideoTracks?.() || [];
    const a = audioTracks[0];
    const v = videoTracks[0];
    
    if (a) {
      a.enabled = true;
      try { (a as any).contentHint = 'speech'; } catch {}
    }
    if (v) {
      v.enabled = true;
    }
    
    this.localStreamRef = stream;
    
    // КРИТИЧНО: Сначала устанавливаем стрим, потом состояние камеры
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
    
    // Затем устанавливаем состояние микрофона и камеры
    const micEnabled = !!a?.enabled;
    const camEnabled = !!v?.enabled;
    this.config.callbacks.onMicStateChange?.(micEnabled);
    this.config.callbacks.onCamStateChange?.(camEnabled);
    this.config.onMicStateChange?.(micEnabled);
    this.config.onCamStateChange?.(!!v?.enabled);
    this.emit('localStream', stream);
    
    return stream;
  }
  
  /**
   * Остановить локальный стрим (приватный метод)
   */
  protected stopLocalStreamInternal(): void {
    if (!this.localStreamRef) {
      return;
    }
    
    try {
      const tracks = this.localStreamRef.getTracks?.() || [];
      tracks.forEach((t: any) => {
        try {
          if (t && t.readyState !== 'ended' && t.readyState !== null) {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          }
        } catch (e) {
          logger.warn('[BaseWebRTCSession] Error stopping track:', e);
        }
      });
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error in stopLocalStreamInternal:', e);
    }
    
    this.localStreamRef = null;
    this.config.callbacks.onLocalStreamChange?.(null);
    this.config.onLocalStreamChange?.(null);
    this.emit('localStream', null);
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
    const pc = this.peerRef;
    
    // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
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
    
    // Останавливаем метры
    this.stopMicMeter();
    
    // Останавливаем треки удаленного потока
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
    this.config.callbacks.onRemoteStreamChange?.(null);
    this.config.onRemoteStreamChange?.(null);
    this.emit('remoteStream', null);
    
    // Сбрасываем состояние remoteCamOn
    this.remoteCamOnRef = false;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.remoteInPiPRef = false;
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.emit('remoteCamStateChanged', false);
    this.emit('remoteViewKeyChanged', 0);
    this.emitRemoteState();
    
    // Останавливаем track checker
    this.stopTrackChecker();
  }
  
  // ==================== PC Token Management ====================
  
  protected incrementPcToken(forceReset: boolean = true): void {
    if (forceReset) {
      this.pcToken = 0;
    }
    this.pcToken++;
  }
  
  protected markPcWithToken(pc: RTCPeerConnection): void {
    (pc as any)._pcToken = this.pcToken;
  }
  
  protected isPcTokenValid(pc: RTCPeerConnection | null): boolean {
    if (!pc) return false;
    const token = (pc as any)?._pcToken;
    return token === this.pcToken;
  }
  
  protected isPcValid(pc: RTCPeerConnection | null): boolean {
    if (!pc) return false;
    if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') return false;
    return this.isPcTokenValid(pc);
  }
  
  // ==================== PeerConnection Cleanup ====================
  
  protected cleanupPeer(pc?: RTCPeerConnection | null): void {
    if (!pc) return;
    
    try {
      // Удаляем все треки из senders
      const senders = pc.getSenders();
      senders.forEach((sender: any) => {
        try {
          if (sender.track) {
            sender.track.stop();
          }
          pc.removeTrack(sender);
        } catch (e) {
          logger.warn('[BaseWebRTCSession] Error removing sender:', e);
        }
      });
      
      // Закрываем соединение
      if (pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
        pc.close();
      }
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error cleaning up peer:', e);
    }
  }
  
  // ==================== Track Checker ====================
  
  protected startTrackChecker(): void {
    // Останавливаем предыдущий интервал если есть
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
    
    // Проверяем сразу
    this.checkRemoteVideoTrack();
    
    // Проверяем каждые 150ms для быстрого переключения
    this.trackCheckIntervalRef = setInterval(() => {
      this.checkRemoteVideoTrack();
    }, 150);
  }
  
  /**
   * Проверка удаленного видео трека
   */
  checkRemoteVideoTrack(): void {
    const remoteStream = this.remoteStreamRef;
    if (!remoteStream || (this.config.getIsInactiveState?.() ?? false)) {
      return;
    }
    
    try {
      const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
      if (!videoTrack || videoTrack.readyState === 'ended') {
        return;
      }
      
      // Обновляем состояние на основе фактического состояния трека
      const isTrackActive = videoTrack.readyState !== 'ended';
      
      if (isTrackActive) {
        const isCameraEnabled = videoTrack.enabled === true;
        
        // НЕ перезаписываем remoteCamOn если он был установлен через cam-toggle
        if (this.remoteForcedOffRef) {
          return;
        }
        
        const now = Date.now();
        const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
        const isNewTrack = streamAge < 250;
        
        let shouldBeEnabled: boolean;
        
        if (this.isFriendCall()) {
          // Для дружеских звонков показываем видео если трек live
          shouldBeEnabled = videoTrack.readyState === 'live';
        } else {
          // Для рандомного чата используем реальное состояние enabled
          shouldBeEnabled = isCameraEnabled;
          
          // Игнорируем enabled=false для новых треков
          if (!isCameraEnabled && isNewTrack && videoTrack.readyState === 'live') {
            return;
          }
        }
        
        if (this.remoteCamOnRef !== shouldBeEnabled) {
          this.remoteForcedOffRef = false;
          this.remoteCamOnRef = shouldBeEnabled;
          this.remoteViewKeyRef = Date.now();
          this.config.callbacks.onRemoteCamStateChange?.(shouldBeEnabled);
          this.config.onRemoteCamStateChange?.(shouldBeEnabled);
          this.emit('remoteCamStateChanged', shouldBeEnabled);
          this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
          this.emitRemoteState();
        }
      }
    } catch (e) {
      logger.error('[BaseWebRTCSession] Error checking remote video track:', e);
    }
  }
  
  /**
   * Установить состояние PiP
   */
  setInPiP(inPiP: boolean): void {
    this.isInPiPRef = inPiP;
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
   * Выключает локальную камеру и отправляет pip:state партнеру
   */
  enterPiP(): void {
    const isFriendCall = this.isFriendCall();
    
    if (!isFriendCall || !this.roomIdRef) {
      return;
    }
    
    // Сохраняем состояние камеры перед входом в PiP
    const localStream = this.localStreamRef;
    if (localStream) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      if (videoTrack) {
        this.pipPrevCamOnRef = videoTrack.enabled;
        
        // Выключаем локальную камеру
        if (videoTrack.enabled) {
          videoTrack.enabled = false;
          this.config.callbacks.onCamStateChange?.(false);
          this.config.onCamStateChange?.(false);
          
          // Отправляем cam-toggle(false) партнеру
          try {
            const payload: any = { enabled: false, from: socket.id };
            if (this.roomIdRef) {
              payload.roomId = this.roomIdRef;
            }
            socket.emit('cam-toggle', payload);
          } catch (e) {
            logger.warn('[BaseWebRTCSession] Error emitting cam-toggle on enterPiP:', e);
          }
        }
      }
    }
    
    // Устанавливаем флаг PiP
    this.setInPiP(true);
    
    // Эмитим событие изменения PiP состояния
    this.emit('pipStateChanged', { inPiP: true });
    
    // Отправляем событие через сокет
    try {
      const payload: any = {
        inPiP: true,
        roomId: this.roomIdRef,
        from: socket.id
      };
      if (this.partnerIdRef) {
        payload.to = this.partnerIdRef;
      }
      socket.emit('pip:state', payload);
      // Дублируем отправку для надежности
      setTimeout(() => {
        try { socket.emit('pip:state', payload); } catch {}
      }, 300);
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error emitting pip:state on enterPiP:', e);
    }
  }
  
  /**
   * Возобновить из PiP
   * Должен быть переопределен в наследниках для специфичной логики
   */
  async resumeFromPiP(): Promise<void> {
    // Базовая реализация - восстановление стримов
    const pipLocalStream = this.config.getPipLocalStream?.();
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    
    if (pipLocalStream && isValidStream(pipLocalStream)) {
      this.localStreamRef = pipLocalStream;
      this.config.callbacks.onLocalStreamChange?.(pipLocalStream);
      this.config.onLocalStreamChange?.(pipLocalStream);
      this.emit('localStream', pipLocalStream);
    }
    
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      this.remoteStreamRef = pipRemoteStream;
      this.config.callbacks.onRemoteStreamChange?.(pipRemoteStream);
      this.config.onRemoteStreamChange?.(pipRemoteStream);
      this.emit('remoteStream', pipRemoteStream);
    }
    
    this.isInPiPRef = false;
  }
  
  /**
   * Выйти из режима Picture-in-Picture
   * Восстанавливает локальную камеру и отправляет pip:state партнеру
   */
  exitPiP(): void {
    const isFriendCall = this.isFriendCall();
    
    if (!isFriendCall || !this.roomIdRef) {
      return;
    }
    
    // Сбрасываем флаг PiP
    this.setInPiP(false);
    
    // Эмитим событие изменения PiP состояния
    this.emit('pipStateChanged', { inPiP: false });
    
    // Отправляем событие через сокет
    try {
      const payload: any = {
        inPiP: false,
        roomId: this.roomIdRef,
        from: socket.id
      };
      if (this.partnerIdRef) {
        payload.to = this.partnerIdRef;
      }
      socket.emit('pip:state', payload);
      // Дублируем отправку для надежности
      setTimeout(() => {
        try { socket.emit('pip:state', payload); } catch {}
      }, 300);
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error emitting pip:state on exitPiP:', e);
    }
    
    // Восстанавливаем локальную камеру если она была включена
    const localStream = this.localStreamRef;
    if (localStream && this.pipPrevCamOnRef !== null) {
      const videoTrack = (localStream as any)?.getVideoTracks?.()?.[0];
      if (videoTrack) {
        const shouldEnable = this.pipPrevCamOnRef !== false;
        
        if (shouldEnable && !videoTrack.enabled) {
          videoTrack.enabled = true;
          this.config.callbacks.onCamStateChange?.(true);
          this.config.onCamStateChange?.(true);
          
          // Отправляем cam-toggle(true) партнеру
          try {
            const payload: any = { enabled: true, from: socket.id };
            if (this.roomIdRef) {
              payload.roomId = this.roomIdRef;
            }
            socket.emit('cam-toggle', payload);
          } catch (e) {
            logger.warn('[BaseWebRTCSession] Error emitting cam-toggle on exitPiP:', e);
          }
        } else if (!shouldEnable && videoTrack.enabled) {
          videoTrack.enabled = false;
          this.config.callbacks.onCamStateChange?.(false);
          this.config.onCamStateChange?.(false);
        }
        
        // Сбрасываем сохраненное состояние
        this.pipPrevCamOnRef = null;
      }
    }
    
    // Восстанавливаем remote stream если нужно
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      this.remoteStreamRef = pipRemoteStream;
      this.config.callbacks.onRemoteStreamChange?.(pipRemoteStream);
      this.config.onRemoteStreamChange?.(pipRemoteStream);
      this.emit('remoteStream', pipRemoteStream);
    }
  }
  
  protected stopTrackChecker(): void {
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
  }
  
  // ==================== Mic Meter ====================
  
  protected startMicMeter(): void {
    const pc = this.peerRef;
    if (!pc) {
      this.stopMicMeter();
      return;
    }
    
    const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
    const isPcConnected = this.isPcConnected();
    
    if (!hasActiveCall && !isPcConnected) {
      this.stopMicMeter();
      return;
    }
    
    if (this.micStatsTimerRef) return;
    
    this.micStatsTimerRef = setInterval(async () => {
      try {
        const currentPc = this.peerRef;
        if (!currentPc || currentPc.signalingState === 'closed' || (currentPc as any).connectionState === 'closed') {
          this.stopMicMeter();
          return;
        }
        
        const isInactiveState = this.config.getIsInactiveState?.() ?? false;
        if (isInactiveState) {
          this.stopMicMeter();
          return;
        }
        
        const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
        const isPcConnected = this.isPcConnected();
        if (!isPcConnected && !hasActiveCall) {
          this.stopMicMeter();
          return;
        }
        
        if (!this.isMicReallyOn()) {
          this.config.callbacks.onMicLevelChange?.(0);
          this.config.onMicLevelChange?.(0);
          this.emit('micLevelChanged', 0);
          return;
        }
        
        const stats: any = await currentPc.getStats();
        let lvl = 0;
        
        stats.forEach((r: any) => {
          const isAudio =
            r.kind === 'audio' || r.mediaType === 'audio' || r.type === 'media-source' || r.type === 'track' || r.type === 'outbound-rtp';
          
          if (!isAudio) return;
          
          // 1) Прямо из audioLevel если есть
          if (typeof r.audioLevel === 'number') {
            // На iOS audioLevel может быть в диапазоне 0-127, на Android 0-1
            const audioLvl = Platform.OS === 'ios' && r.audioLevel > 1 
              ? r.audioLevel / 127 
              : r.audioLevel;
            lvl = Math.max(lvl, audioLvl);
          }
          
          // 2) Fallback: по totalAudioEnergy/totalSamplesDuration
          if (typeof r.totalAudioEnergy === 'number' && typeof r.totalSamplesDuration === 'number') {
            const prevE = this.energyRef;
            const prevD = this.durRef;
            if (prevE != null && prevD != null) {
              const dE = r.totalAudioEnergy - prevE;
              const dD = r.totalSamplesDuration - prevD;
              if (dD > 0) {
                const inst = Math.sqrt(Math.max(0, dE / dD));
                lvl = Math.max(lvl, inst);
              }
            }
            this.energyRef = r.totalAudioEnergy;
            this.durRef = r.totalSamplesDuration;
          }
        });
        
        // clamp [0..1]
        let normalized = Math.max(0, Math.min(1, lvl));
        
        // Для iOS - если уровень очень низкий несколько раз подряд, сбрасываем до 0
        if (Platform.OS === 'ios') {
          if (normalized < 0.015) {
            this.lowLevelCountRef += 1;
            if (this.lowLevelCountRef >= 2) {
              normalized = 0;
              this.energyRef = null;
              this.durRef = null;
            }
          } else {
            this.lowLevelCountRef = 0;
          }
        }
        
        this.config.callbacks.onMicLevelChange?.(normalized);
        this.config.onMicLevelChange?.(normalized);
        this.emit('micLevelChanged', normalized);
      } catch {
        this.stopMicMeter();
      }
    }, 180);
  }
  
  private isMicReallyOn(): boolean {
    const stream = this.localStreamRef;
    const a = stream?.getAudioTracks?.()?.[0];
    return !!(a && a.enabled && (a as any).readyState === 'live');
  }
  
  protected stopMicMeter(): void {
    if (this.micStatsTimerRef) {
      clearInterval(this.micStatsTimerRef);
      this.micStatsTimerRef = null;
    }
    this.energyRef = null;
    this.durRef = null;
    this.lowLevelCountRef = 0;
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
    this.emit('micLevelChanged', 0);
  }
  
  // ==================== Connection Timers ====================
  
  protected clearReconnectTimer(): void {
    if (this.reconnectTimerRef) {
      clearTimeout(this.reconnectTimerRef);
      this.reconnectTimerRef = null;
    }
  }
  
  protected clearConnectionTimers(): void {
    this.clearReconnectTimer();
    if (this.connectionCheckIntervalRef) {
      clearInterval(this.connectionCheckIntervalRef);
      this.connectionCheckIntervalRef = null;
    }
  }
  
  protected startConnectionCheckInterval(pc: RTCPeerConnection): void {
    // Очищаем предыдущий интервал если есть
    if (this.connectionCheckIntervalRef) {
      clearInterval(this.connectionCheckIntervalRef);
    }
    
    // Проверяем состояние каждые 2 секунды
    this.connectionCheckIntervalRef = setInterval(() => {
      if (!this.peerRef || this.peerRef !== pc) {
        this.clearConnectionTimers();
        return;
      }
      
      try {
        const st = (pc as any).connectionState || pc.iceConnectionState;
        if (st === 'closed') {
          this.clearConnectionTimers();
          if (this.isConnectedRef) {
            this.setConnected(false);
          }
          return;
        }
        
        const isConnected = st === 'connected' || st === 'completed';
        
        // Если соединение установлено, но remoteStream отсутствует, проверяем receivers
        if (isConnected && this.isRandomChat() && this.partnerIdRef && !this.remoteStreamRef) {
          this.checkReceiversForRemoteStream(pc);
        }
        if (isConnected !== this.isConnectedRef) {
          const handleConnectionState = (pc as any).onconnectionstatechange;
          if (handleConnectionState) {
            handleConnectionState();
          }
        }
      } catch (e) {
        // PC может быть закрыт
        this.clearConnectionTimers();
      }
    }, 2000);
  }
  
  protected handleConnectionFailure(pc: RTCPeerConnection): void {
    // Проверка валидности
    if (!pc || !this.peerRef || this.peerRef !== pc) {
      return;
    }
    
    // Проверка активного звонка
    const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
    if (!hasActiveCall) {
      return;
    }
    
    // Проверка неактивного состояния
    const isInactiveState = this.config.getIsInactiveState?.() ?? false;
    if (isInactiveState) {
      return;
    }
    
    // Проверка состояния приложения
    if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
      return;
    }
    
    // Запускаем автоматический reconnection
    const toId = this.partnerIdRef;
    if (toId) {
      this.scheduleReconnection(pc, String(toId));
    }
  }
  
  protected scheduleReconnection(pc: RTCPeerConnection, toId: string): void {
    // Очищаем предыдущий таймер если есть
    this.clearReconnectTimer();
    
    // Проверяем cooldown
    const now = Date.now();
    if (this.restartCooldownRef > now) {
      const delay = this.restartCooldownRef - now;
      this.reconnectTimerRef = setTimeout(() => {
        this.scheduleReconnection(pc, toId);
      }, delay);
      return;
    }
    
    // Запускаем ICE restart (будет реализован в наследниках или здесь)
    // this.tryIceRestart(pc, toId);
  }
  
  /**
   * Установка обработчиков соединения (ICE кандидаты, состояние соединения)
   */
  protected bindConnHandlers(pc: RTCPeerConnection, expectedPartnerId?: string): void {
    // Очищаем предыдущие таймеры если есть
    this.clearConnectionTimers();
    
    // Устанавливаем обработчик onicecandidate для отправки ICE-кандидатов
    (pc as any).onicecandidate = (event: any) => {
      // Проверяем, что PC не закрыт и токен актуален
      if (!this.isPcValid(pc)) {
        return;
      }
      
      if (event.candidate) {
        const toId = this.partnerIdRef || expectedPartnerId;
        if (toId) {
          const payload: any = { to: toId, candidate: event.candidate };
          // Для дружеских звонков добавляем roomId
          if (this.isFriendCall() && this.roomIdRef) {
            payload.roomId = this.roomIdRef;
          }
          socket.emit('ice-candidate', payload);
        } else {
          // Кешируем ICE кандидаты до установки partnerId
          this.outgoingIceCache.push(event.candidate);
        }
      }
    };
    
    const handleConnectionState = () => {
      // Проверка валидности PC
      if (!pc || pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        if (this.isConnectedRef) {
          this.setConnected(false);
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
        if (this.isConnectedRef) {
          this.setConnected(false);
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
      if (isConnected !== this.isConnectedRef) {
        this.setConnected(isConnected);
      }
      
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
   * Установка обработчиков удаленного стрима (ontrack)
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
    
    const handleRemote = (e: any) => {
      try {
        // Проверяем, что PC не закрыт и токен актуален
        if (!this.isPcValid(pc)) {
          return;
        }
        
        // Получаем стрим из события ontrack
        const stream = e?.streams?.[0] ?? e?.stream;
        const track = e?.track;
        
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
                
                receivers.forEach((receiver: any) => {
                  const receiverTrack = receiver.track;
                  if (receiverTrack && receiverTrack.readyState !== 'ended') {
                    try {
                      (unifiedStream as any).addTrack(receiverTrack);
                    } catch (e) {
                      logger.warn('[BaseWebRTCSession] Error adding track from receiver:', e);
                    }
                  }
                });
                
                const unifiedTracks = unifiedStream.getTracks?.() || [];
                if (unifiedTracks.length > 0 && isValidStream(unifiedStream)) {
                  rs = unifiedStream;
                }
              }
            }
          } catch (receiverError) {
            logger.warn('[BaseWebRTCSession] Error getting receivers:', receiverError);
          }
        }
        
        // Если все еще нет валидного stream, используем track из события
        if (!rs || !isValidStream(rs)) {
          if (track && track.readyState !== 'ended') {
            try {
              const { MediaStream } = require('react-native-webrtc');
              rs = new MediaStream();
              (rs as any).addTrack(track);
            } catch (e) {
              logger.warn('[BaseWebRTCSession] Error creating stream from track:', e);
              return;
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
            if (this.localStreamRef && (rs as any)?.id === (this.localStreamRef as any)?.id) {
              const localVideoTrack = this.localStreamRef?.getVideoTracks?.()?.[0];
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
        const existingRemoteStream = this.remoteStreamRef;
        if (existingRemoteStream && existingRemoteStream !== rs) {
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
        
        // Проверяем состояние треков
        const videoTrack = (rs as any)?.getVideoTracks?.()?.[0];
        const audioTrack = (rs as any)?.getAudioTracks?.()?.[0];
        
        // Предотвращаем множественные emit для одного и того же stream
        const existingStream = this.remoteStreamRef;
        const isSameStream = existingStream === rs || (existingStream && existingStream.id === rs.id);
        const streamChanged = !isSameStream;
        
        // Если это новый стрим и видео-трек приходит с readyState=ended, игнорируем
        if (streamChanged && videoTrack && videoTrack.readyState === 'ended') {
          return;
        }
        
        // Устанавливаем remoteStream
        this.remoteStreamRef = rs;
        this.remoteStreamEstablishedAtRef = Date.now();
        this.config.callbacks.onRemoteStreamChange?.(rs);
        this.config.onRemoteStreamChange?.(rs);
        this.emit('remoteStream', rs);
        
        // Обновляем состояние камеры
        if (videoTrack) {
          const camEnabled = videoTrack.enabled && videoTrack.readyState !== 'ended';
          this.remoteCamOnRef = camEnabled;
          this.config.callbacks.onRemoteCamStateChange?.(camEnabled);
          this.config.onRemoteCamStateChange?.(camEnabled);
          this.emit('remoteCamStateChanged', camEnabled);
          
          // КРИТИЧНО: Применяем отложенное состояние cam-toggle, если оно было сохранено
          if (this.pendingCamToggleRef && this.pendingCamToggleRef.from === setToId) {
            const pending = this.pendingCamToggleRef;
            if (videoTrack.readyState !== 'ended') {
              videoTrack.enabled = pending.enabled;
              this.remoteForcedOffRef = !pending.enabled;
              this.remoteCamOnRef = pending.enabled;
              this.remoteViewKeyRef = Date.now();
              this.config.callbacks.onRemoteCamStateChange?.(pending.enabled);
              this.config.onRemoteCamStateChange?.(pending.enabled);
              this.emit('remoteCamStateChanged', pending.enabled);
              this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
              this.emitRemoteState();
            }
            this.pendingCamToggleRef = null;
          }
        }
      } catch (e) {
        logger.error('[BaseWebRTCSession] Error in ontrack handler:', e);
      }
    };
    
    (pc as any).ontrack = handleRemote;
    (pc as any)._remoteHandlersAttached = true;
  }
  
  /**
   * Проверка receivers для получения удаленного стрима
   */
  protected checkReceiversForRemoteStream(pc: RTCPeerConnection): void {
    // Проверяем даже если соединение еще не установлено
    if (!pc || pc.signalingState === 'closed') {
      return;
    }
    
    const connectionState = (pc as any)?.connectionState || pc.iceConnectionState;
    if (connectionState === 'closed' || connectionState === 'failed') {
      return;
    }
    
    if (!this.partnerIdRef) {
      return;
    }
    
    // Проверяем даже если remoteStreamRef уже установлен
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
      
      // КРИТИЧНО: Создаем unified MediaStream из всех receivers для синхронизации аудио и видео
      // Это особенно важно на iOS, где треки могут приходить отдельно
      const { MediaStream } = require('react-native-webrtc');
      const newStream = new MediaStream();
      
      // Собираем все активные треки из receivers
      receivers.forEach((receiver: any) => {
        const track = receiver.track;
        if (track && track.readyState !== 'ended') {
          try {
            // Проверяем, что трек еще не добавлен (защита от дубликатов)
            const existingTracks = newStream.getTracks?.() || [];
            const alreadyAdded = existingTracks.some((et: any) => et && et.id === track.id);
            
            if (!alreadyAdded) {
              (newStream as any).addTrack(track);
            }
          } catch (e) {
            logger.warn('[BaseWebRTCSession] Error adding track from receiver:', e);
          }
        }
      });
      
      // КРИТИЧНО: Проверяем, что unified stream содержит треки перед установкой
      const unifiedTracks = newStream.getTracks?.() || [];
      if (unifiedTracks.length > 0 && isValidStream(newStream)) {
        // Проверяем, что это действительно новый stream или содержит новые треки
        const existingStream = this.remoteStreamRef;
        const existingTracks = existingStream?.getTracks?.() || [];
        const hasNewTracks = unifiedTracks.some((ut: any) => {
          return !existingTracks.some((et: any) => et && et.id === ut.id);
        });
        const isDifferentStream = !existingStream || existingStream !== newStream;
        
        if (isDifferentStream || hasNewTracks) {
          this.remoteStreamRef = newStream;
          this.remoteStreamEstablishedAtRef = Date.now();
          this.config.callbacks.onRemoteStreamChange?.(newStream);
          this.config.onRemoteStreamChange?.(newStream);
          this.emit('remoteStream', newStream);
          
          // Обновляем состояние камеры если есть видео-трек
          const videoTrack = (newStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            const camEnabled = videoTrack.enabled && videoTrack.readyState !== 'ended';
            this.remoteCamOnRef = camEnabled;
            this.config.callbacks.onRemoteCamStateChange?.(camEnabled);
            this.config.onRemoteCamStateChange?.(camEnabled);
            this.emit('remoteCamStateChanged', camEnabled);
          }
        }
      }
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error checking receivers:', e);
    }
  }
  
  // ==================== Remote State ====================
  
  protected emitRemoteState(): void {
    this.emit('remoteState', {
      camOn: this.remoteCamOnRef,
      muted: this.remoteMutedRef,
      inPiP: this.remoteInPiPRef,
      remoteViewKey: this.remoteViewKeyRef,
    });
  }
  
  protected emitSessionUpdate(): void {
    this.emit('sessionUpdate', {
      partnerId: this.partnerIdRef,
      roomId: this.roomIdRef,
      callId: this.callIdRef,
      hasLocalStream: !!this.localStreamRef,
      hasRemoteStream: !!this.remoteStreamRef,
      isConnected: this.isConnectedRef,
    });
  }
  
  // ==================== AppState Listener ====================
  
  protected setupAppStateListener(): void {
    if (this.appStateSubscription) {
      return;
    }
    
    this.appStateSubscription = AppState.addEventListener('change', (nextAppState) => {
      this.handleAppStateChange(nextAppState);
    });
  }
  
  protected handleAppStateChange(nextAppState: string): void {
    if (nextAppState === 'active' && this.wasInBackgroundRef) {
      this.handleForeground();
    } else if (nextAppState !== 'active') {
      this.handleBackground();
    }
  }
  
  protected handleForeground(): void {
    this.wasInBackgroundRef = false;
    // Логика восстановления будет в наследниках
  }
  
  protected handleBackground(): void {
    this.wasInBackgroundRef = true;
    // Логика обработки фона будет в наследниках
  }
  
  // ==================== ICE Candidate Queue ====================
  
  /**
   * Отправляет кешированные исходящие ICE кандидаты после установки partnerId
   */
  protected flushOutgoingIceCache(): void {
    if (this.outgoingIceCache.length === 0 || !this.partnerIdRef) {
      return;
    }
    
    const pc = this.peerRef;
    if (pc && !this.isPcValid(pc)) {
      this.outgoingIceCache = [];
      return;
    }
    
    const toId = this.partnerIdRef;
    
    // Отправляем все кешированные кандидаты
    for (const candidate of this.outgoingIceCache) {
      try {
        const payload: any = { to: toId, candidate };
        if (this.isFriendCall() && this.roomIdRef) {
          payload.roomId = this.roomIdRef;
        }
        socket.emit('ice-candidate', payload);
      } catch (e) {
        logger.warn('[BaseWebRTCSession] Error sending cached ICE candidate:', e);
      }
    }
    
    // Очищаем кеш после отправки
    this.outgoingIceCache = [];
  }
  
  protected enqueueIce(from: string, candidate: any): void {
    const key = String(from || '');
    if (!this.pendingIceByFromRef[key]) {
      this.pendingIceByFromRef[key] = [];
    }
    this.pendingIceByFromRef[key].push(candidate);
  }
  
  protected async flushIceFor(from: string): Promise<void> {
    const key = String(from || '');
    const list = this.pendingIceByFromRef[key] || [];
    const pc = this.peerRef;
    
    if (!pc || !list.length) {
      return;
    }
    
    if (!this.isPcValid(pc)) {
      delete this.pendingIceByFromRef[key];
      return;
    }
    
    if (this.partnerIdRef && this.partnerIdRef !== from) {
      delete this.pendingIceByFromRef[key];
      return;
    }
    
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      return;
    }
    
    for (const cand of list) {
      try {
        await pc.addIceCandidate(cand);
      } catch (e: any) {
        // Игнорируем ошибки о дубликатах
        const errorMsg = String(e?.message || '');
        if (!errorMsg.includes('InvalidStateError') && 
            !errorMsg.includes('already exists') && 
            !errorMsg.includes('closed')) {
          logger.warn('[BaseWebRTCSession] Error adding queued ICE candidate:', e);
        }
      }
    }
    
    delete this.pendingIceByFromRef[key];
  }
  
  // ==================== Connection State ====================
  
  protected isPcConnected(): boolean {
    const pc = this.peerRef;
    if (!pc) return false;
    const st = (pc as any).connectionState || pc.iceConnectionState;
    return st === 'connected' || st === 'completed';
  }
  
  protected setConnected(connected: boolean): void {
    if (this.isConnectedRef === connected) {
      return;
    }
    
    this.isConnectedRef = connected;
    
    // Уведомляем через callbacks
    this.config.callbacks.onPcConnectedChange?.(connected);
    this.config.onPcConnectedChange?.(connected);
    
    if (connected) {
      // Подключение установлено
      this.emit('connected');
      
      // Устанавливаем время установки соединения
      this.connectionEstablishedAtRef = Date.now();
      
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
        
        // Fallback - проверяем receivers напрямую
        if (!this.remoteStreamRef) {
          const delays = this.isFriendCall() ? [500, 1000, 2000] : [1000, 2000, 3000];
          delays.forEach((delay) => {
            setTimeout(() => {
              const currentPc = this.peerRef;
              const currentPartnerId = this.partnerIdRef;
              
              if (currentPc === pc && currentPartnerId && !this.remoteStreamRef) {
                this.checkReceiversForRemoteStream(currentPc);
              }
            }, delay);
          });
        }
      }
      
      // Очищаем таймеры reconnection
      this.clearReconnectTimer();
      
      // Запускаем метры и обновляем состояние загрузки
      this.startMicMeter();
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      this.config.setIsNexting?.(false);
    } else {
      // Подключение потеряно
      this.emit('disconnected');
      this.stopMicMeter();
    }
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
    // Упрощение SDP для быстрого соединения
    let optimized = sdp;
    // Удаляем неиспользуемые кодеки
    optimized = optimized.replace(/a=rtpmap:\d+ (red|ulpfec|rtx|flexfec)/gi, '');
    return optimized;
  }
  
  // ==================== Hash Utility ====================
  
  protected hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }
  
  // ==================== Public Getters ====================
  
  /**
   * Получить текущий локальный стрим
   */
  getLocalStream(): MediaStream | null {
    return this.localStreamRef;
  }
  
  /**
   * Получить текущий удаленный стрим
   */
  getRemoteStream(): MediaStream | null {
    return this.remoteStreamRef;
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
    return this.isConnectedRef;
  }
  
  // ==================== Protected Setters ====================
  
  /**
   * Установить partnerId
   */
  protected setPartnerId(partnerId: string | null): void {
    this.partnerIdRef = partnerId;
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    this.emit('partnerId', partnerId);
  }
  
  /**
   * Установить roomId
   */
  protected setRoomId(roomId: string | null): void {
    this.roomIdRef = roomId;
    this.config.callbacks.onRoomIdChange?.(roomId);
    this.config.onRoomIdChange?.(roomId);
    this.emit('roomId', roomId);
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
    const stream = this.localStreamRef;
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
    if (!this.localStreamRef) {
      logger.warn('[BaseWebRTCSession] toggleCam: No local stream');
      return;
    }
    
    const videoTrack = (this.localStreamRef as any)?.getVideoTracks?.()?.[0];
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
    const ls = this.localStreamRef;
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
      if (newVideoTrack && this.peerRef) {
        const sender = this.peerRef
          ?.getSenders()
          .find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
        
        (ls as any).addTrack(newVideoTrack);
        
        setTimeout(() => {
          try { (ls as any).removeTrack(videoTrack); } catch {}
          try { videoTrack.stop(); } catch {}
        }, 50);
      }
    } catch (err) {
      logger.warn('[BaseWebRTCSession] flipCam fallback error', err);
    }
  }
  
  /**
   * Переключить удаленное аудио (динамик)
   */
  toggleRemoteAudio(): void {
    const stream = this.remoteStreamRef;
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
      this.remoteMutedRef = !newEnabledState;
      
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
    const currentVideoTrack = this.localStreamRef ? (this.localStreamRef as any)?.getVideoTracks?.()?.[0] : null;
    const wasEnabled = currentVideoTrack?.enabled ?? true;
    
    // Останавливаем старый стрим
    if (this.localStreamRef) {
      try {
        const tracks = (this.localStreamRef as any)?.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      this.localStreamRef = null;
      this.config.callbacks.onLocalStreamChange?.(null);
      this.config.onLocalStreamChange?.(null);
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
    const hasStream = !!this.localStreamRef;
    
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
    
    const ls = this.localStreamRef;
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
      this.localStreamRef = null;
      this.config.callbacks.onLocalStreamChange?.(null);
      this.config.onLocalStreamChange?.(null);
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
    this.localStreamRef = null;
    this.config.callbacks.onLocalStreamChange?.(null);
    this.config.onLocalStreamChange?.(null);
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
    const currentPcToken = pc ? ((pc as any)?._pcToken ?? this.pcToken) : this.pcToken;
    const offerSdp = offer?.sdp || '';
    const sdpHash = this.hashString(offerSdp);
    const counterKey = `${from}_${currentPcToken}`;
    let counter = this.offerCounterByKeyRef.get(counterKey) || 0;
    
    const existingKeyWithSameHash = Array.from(this.processedOffersRef).find(key => 
      key.startsWith(`offer_${from}_${currentPcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      counter++;
      this.offerCounterByKeyRef.set(counterKey, counter);
    }
    
    const offerKey = `offer_${from}_${currentPcToken}_${sdpHash}_${counter}`;
    
    if (this.processingOffersRef.has(offerKey) || this.processedOffersRef.has(offerKey)) {
      return;
    }
    
    if (pc) {
      const pcToken = (pc as any)?._pcToken ?? this.pcToken;
      if (pcToken !== this.pcToken) {
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
    
    this.processingOffersRef.add(offerKey);
    
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
    let stream = this.localStreamRef;
    if (!stream) {
      stream = await this.startLocalStream('front');
      if (!stream || !isValidStream(stream)) {
        this.processingOffersRef.delete(offerKey);
        return;
      }
    }
    
    // Создаем или получаем PC
    let pcForOffer = this.peerRef;
    if (!pcForOffer) {
      pcForOffer = await this.ensurePcWithLocal(stream);
      if (!pcForOffer) {
        this.processingOffersRef.delete(offerKey);
        return;
      }
    }
    
    // Проверяем состояние PC
    if (pcForOffer.signalingState === 'closed' || (pcForOffer as any).connectionState === 'closed') {
      this.processingOffersRef.delete(offerKey);
      return;
    }
    
    if (!this.isPcValid(pcForOffer)) {
      this.processingOffersRef.delete(offerKey);
      return;
    }
    
    // Устанавливаем remote description
    const hasRemoteDesc = !!(pcForOffer as any).remoteDescription;
    if (!hasRemoteDesc) {
      // Убеждаемся, что обработчик ontrack установлен
      if (from && !(pcForOffer as any)?.ontrack) {
        this.attachRemoteHandlers(pcForOffer, from);
      }
      
      try {
        let offerDesc = offer;
        if (offer && typeof offer === 'object' && !offer.type) {
          offerDesc = { type: 'offer', sdp: offer.sdp || offer } as any;
        }
        
        await pcForOffer.setRemoteDescription(offerDesc as any);
        this.processedOffersRef.add(offerKey);
        
        // Создаем и отправляем answer
        await this.createAndSendAnswer(from, roomId);
      } catch (error: any) {
        const errorMsg = String(error?.message || '');
        if (!errorMsg.includes('closed') && !errorMsg.includes('null')) {
          logger.error('[BaseWebRTCSession] Error setting remote description:', error);
        }
        this.processingOffersRef.delete(offerKey);
        return;
      }
    }
    
    this.processingOffersRef.delete(offerKey);
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
        answer.sdp = this.optimizeSdpForFastConnection(answer.sdp);
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
    
    const currentPcToken = (pc as any)?._pcToken ?? this.pcToken;
    const answerSdp = answer?.sdp || '';
    const sdpHash = this.hashString(answerSdp);
    const counterKey = `${from}_${currentPcToken}`;
    let counter = this.answerCounterByKeyRef.get(counterKey) || 0;
    
    const existingKeyWithSameHash = Array.from(this.processedAnswersRef).find(key => 
      key.startsWith(`answer_${from}_${currentPcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      counter++;
      this.answerCounterByKeyRef.set(counterKey, counter);
    }
    
    const answerKey = `answer_${from}_${currentPcToken}_${sdpHash}_${counter}`;
    
    if (this.processingAnswersRef.has(answerKey) || this.processedAnswersRef.has(answerKey)) {
      return;
    }
    
    if ((pc.signalingState as any) === 'closed' || (pc.connectionState as any) === 'closed' || !this.peerRef || this.peerRef !== pc) {
      return;
    }
    
    if (!this.isPcValid(pc)) {
      return;
    }
    
    this.processingAnswersRef.add(answerKey);
    
    // Устанавливаем roomId если он пришел
    if (roomId && !this.roomIdRef) {
      this.setRoomId(roomId);
    }
    
    // Проверяем состояние PC
    const hasLocalDesc = !!(pc as any).localDescription;
    const hasRemoteDesc = !!(pc as any).remoteDescription;
    
    if (pc.signalingState !== 'have-local-offer' || !hasLocalDesc || hasRemoteDesc) {
      this.processingAnswersRef.delete(answerKey);
      return;
    }
    
    // Задержка для снятия гонки
    await new Promise(res => setTimeout(res, 150));
    
    const currentPc = this.peerRef;
    if (!currentPc || currentPc !== pc || currentPc.signalingState !== 'have-local-offer') {
      this.processingAnswersRef.delete(answerKey);
      return;
    }
    
    try {
      // Убеждаемся, что обработчик ontrack установлен
      if (from && !(currentPc as any)?.ontrack) {
        this.attachRemoteHandlers(currentPc, from);
      }
      
      // Преобразуем answer в RTCSessionDescription если нужно
      let answerDesc = answer;
      if (answer && typeof answer === 'object' && !answer.type) {
        answerDesc = { type: 'answer', sdp: answer.sdp || answer } as any;
      }
      
      await currentPc.setRemoteDescription(answerDesc as any);
      this.processedAnswersRef.add(answerKey);
      
      // Прожигаем отложенные ICE кандидаты
      await this.flushIceFor(from);
    } catch (error: any) {
      const errorMsg = String(error?.message || '');
      if (!errorMsg.includes('closed') && !errorMsg.includes('null')) {
        logger.error('[BaseWebRTCSession] Error setting remote description for answer:', error);
      }
      this.processingAnswersRef.delete(answerKey);
      return;
    }
    
    this.processingAnswersRef.delete(answerKey);
  }
  
  /**
   * Обработка ICE candidate (базовая логика)
   */
  protected async handleCandidate({ from, candidate }: { from: string; candidate: any }): Promise<void> {
    const pc = this.peerRef;
    
    if (!pc || !this.isPcValid(pc)) {
      return;
    }
    
    // Проверяем partnerId
    if (this.partnerIdRef && this.partnerIdRef !== from) {
      return;
    }
    
    // Если remoteDescription еще не установлен, кешируем кандидат
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      this.enqueueIce(from, candidate);
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
        offer.sdp = this.optimizeSdpForFastConnection(offer.sdp);
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
      const rs = this.remoteStreamRef;
      if (rs) {
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        if (vt && vt.readyState !== 'ended' && !enabled) {
          const now = Date.now();
          const connectionAge = now - this.connectionEstablishedAtRef;
          const isRecentConnection = connectionAge < 5000;
          const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
          const isTrackStable = vt.readyState === 'live' && streamAge >= 300;
          
          if ((vt.readyState !== 'live' || !isTrackStable) && isRecentConnection) {
            return;
          }
        }
      } else if (!enabled) {
        const now = Date.now();
        const connectionAge = now - this.connectionEstablishedAtRef;
        if (connectionAge < 5000) {
          return;
        }
      }
    }
    
    // Проверяем, нужно ли обновлять remoteCamOn
    let shouldUpdateRemoteCamOn = true;
    
    if (!isDirectFriendCall && !enabled) {
      const now = Date.now();
      const connectionAge = now - this.connectionEstablishedAtRef;
      const isRecentConnection = connectionAge < 5000;
      
      const rs = this.remoteStreamRef;
      if (rs) {
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
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
      const rs = this.remoteStreamRef;
      const vt = rs ? (rs as any)?.getVideoTracks?.()?.[0] : null;
      const pc = this.peerRef;
      
      if (vt) {
        if (vt.readyState !== 'ended') {
          // Проверяем стабильность трека перед применением cam-toggle для рандомного чата
          if (!isDirectFriendCall && !enabled) {
            const now = Date.now();
            const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
            const isTrackLive = vt.readyState === 'live';
            const isTrackStable = isTrackLive && streamAge >= 300;
            
            if (!isTrackStable) {
              return;
            }
          }
          
          vt.enabled = enabled;
          this.pendingCamToggleRef = null;
        } else {
          const isPcActive = pc && 
            pc.signalingState !== 'closed' && 
            (pc as any).connectionState !== 'closed';
          const isPartnerMatch = !this.partnerIdRef || this.partnerIdRef === from;
          
          if (isPcActive && isPartnerMatch) {
            this.pendingCamToggleRef = null;
          } else {
            return;
          }
        }
      } else {
        if (!rs) {
          this.pendingCamToggleRef = {
            enabled,
            from,
            timestamp: Date.now()
          };
        }
      }
    } catch (e) {
      logger.warn('[BaseWebRTCSession] Error updating remote track:', e);
    }
    
    // Обновляем состояние
    this.camToggleSeenRef = true;
    this.remoteViewKeyRef = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
    
    if (shouldUpdateRemoteCamOn) {
      const oldRemoteCamOn = this.remoteCamOnRef;
      this.remoteForcedOffRef = !enabled;
      this.remoteCamOnRef = enabled;
      
      if (oldRemoteCamOn !== enabled) {
        this.config.callbacks.onRemoteCamStateChange?.(enabled);
        this.config.onRemoteCamStateChange?.(enabled);
        this.emit('remoteCamStateChanged', enabled);
        this.emitRemoteState();
      }
    }
  }
  
  /**
   * Настройка обработчиков socket
   * Должен быть переопределен в наследниках
   */
  protected setupSocketHandlers(): void {
    // Базовые обработчики для всех типов сессий
    socket.on('offer', async (data: any) => {
      await this.handleOffer({
        from: data.from || socket.id,
        offer: data.offer,
        fromUserId: data.fromUserId,
        roomId: data.roomId
      });
    });
    
    socket.on('answer', async (data: any) => {
      await this.handleAnswer({
        from: data.from || socket.id,
        answer: data.answer,
        roomId: data.roomId
      });
    });
    
    socket.on('ice-candidate', async (data: any) => {
      await this.handleCandidate({
        from: data.from || socket.id,
        candidate: data.candidate
      });
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
    const { inPiP, from, roomId } = data;
    
    // Проверяем, что это событие для текущего партнера/комнаты
    const isCurrentPartner = this.partnerIdRef === from || !this.partnerIdRef;
    const isCurrentRoom = this.roomIdRef === roomId || !this.roomIdRef;
    
    if (isCurrentPartner && isCurrentRoom) {
      this.remoteInPiPRef = inPiP;
      this.emit('partnerPiPStateChanged', { inPiP });
      this.emitRemoteState();
    }
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

