import { RTCPeerConnection, MediaStream, mediaDevices } from 'react-native-webrtc';
import { AppState, Platform } from 'react-native';
import { getIceConfiguration, getEnvFallbackConfiguration } from '../../utils/iceConfig';
import { isValidStream, cleanupStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import socket from '../../sockets/socket';

// ==================== Simple EventEmitter for React Native ====================

type EventHandler = (...args: any[]) => void;

class SimpleEventEmitter {
  private events: Map<string, EventHandler[]> = new Map();

  on(event: string, handler: EventHandler): this {
    const handlers = this.events.get(event) || [];
    handlers.push(handler);
    this.events.set(event, handlers);
    return this;
  }

  off(event: string, handler?: EventHandler): this {
    if (!handler) {
      this.events.delete(event);
      return this;
    }
    const handlers = this.events.get(event) || [];
    const filtered = handlers.filter(h => h !== handler);
    if (filtered.length === 0) {
      this.events.delete(event);
    } else {
      this.events.set(event, filtered);
    }
    return this;
  }

  once(event: string, handler: EventHandler): this {
    const onceHandler = (...args: any[]) => {
      handler(...args);
      this.off(event, onceHandler);
    };
    return this.on(event, onceHandler);
  }

  emit(event: string, ...args: any[]): boolean {
    const handlers = this.events.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(...args);
      } catch (error) {
        logger.error(`[SimpleEventEmitter] Error in handler for event "${event}":`, error);
      }
    });
    return handlers.length > 0;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
    return this;
  }
}

// ==================== Types ====================

export type CamSide = 'front' | 'back';

export interface WebRTCSessionCallbacks {
  // Stream callbacks
  onLocalStreamChange?: (stream: MediaStream | null) => void;
  onRemoteStreamChange?: (stream: MediaStream | null) => void;
  
  // State callbacks
  onMicStateChange?: (enabled: boolean) => void;
  onCamStateChange?: (enabled: boolean) => void;
  onRemoteCamStateChange?: (enabled: boolean) => void;
  onPcConnectedChange?: (connected: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
  onMicLevelChange?: (level: number) => void; // Уровень микрофона для эквалайзера
  
  // Connection callbacks
  onPartnerIdChange?: (partnerId: string | null) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onCallIdChange?: (callId: string | null) => void;
  
  // Error callbacks
  onError?: (error: Error) => void;
}

export interface WebRTCSessionConfig {
  myUserId?: string;
  callbacks: WebRTCSessionCallbacks;
  
  // State getters (для проверки состояния из компонента)
  getIsInactiveState?: () => boolean;
  getIsDirectCall?: () => boolean;
  getInDirectCall?: () => boolean;
  getFriendCallAccepted?: () => boolean;
  getStarted?: () => boolean;
  getIsNexting?: () => boolean;
  getIsDirectInitiator?: () => boolean;
  getHasIncomingCall?: () => boolean;
  
  // State setters (для обновления состояния из компонента)
  setIsInactiveState?: (value: boolean) => void;
  setWasFriendCallEnded?: (value: boolean) => void;
  setFriendCallAccepted?: (value: boolean) => void;
  setInDirectCall?: (value: boolean) => void;
  setStarted?: (value: boolean) => void;
  setIsNexting?: (value: boolean) => void;
  setAddBlocked?: (value: boolean) => void;
  setAddPending?: (value: boolean) => void;
  
  // External functions
  clearDeclinedBlock?: () => void;
  fetchFriends?: () => Promise<void>;
  sendCameraState?: (toPartnerId?: string, enabled?: boolean) => void;
  getDeclinedBlock?: () => { userId?: string; until?: number } | null;
  getIncomingFriendCall?: () => any;
  getWasFriendCallEnded?: () => boolean;
  getFriends?: () => any[];
  
  // PiP support
  getPipLocalStream?: () => MediaStream | null;
  getPipRemoteStream?: () => MediaStream | null;
  getResume?: () => boolean;
  getFromPiP?: () => boolean;
  
  // Callbacks shortcuts (для удобства доступа)
  onLocalStreamChange?: (stream: MediaStream | null) => void;
  onRemoteStreamChange?: (stream: MediaStream | null) => void;
  onMicStateChange?: (enabled: boolean) => void;
  onCamStateChange?: (enabled: boolean) => void;
  onRemoteCamStateChange?: (enabled: boolean) => void;
  onPcConnectedChange?: (connected: boolean) => void;
  onLoadingChange?: (loading: boolean) => void;
  onMicLevelChange?: (level: number) => void;
  onPartnerIdChange?: (partnerId: string | null) => void;
  onRoomIdChange?: (roomId: string | null) => void;
  onCallIdChange?: (callId: string | null) => void;
  onError?: (error: Error) => void;
}

// ==================== WebRTCSession Class ====================

export class WebRTCSession extends SimpleEventEmitter {
  private peerRef: RTCPeerConnection | null = null;
  private preCreatedPcRef: RTCPeerConnection | null = null;
  private localStreamRef: MediaStream | null = null;
  private remoteStreamRef: MediaStream | null = null;
  
  private partnerIdRef: string | null = null;
  private roomIdRef: string | null = null;
  private callIdRef: string | null = null;
  
  private iceConfigRef: RTCConfiguration | null = null;
  private iceCandidateQueue: Map<string, any[]> = new Map();
  private pendingIceByFromRef: Record<string, any[]> = {};
  private outgoingIceCache: any[] = []; // Кеш для исходящих ICE кандидатов до установки partnerId
  
  private processingOffersRef: Set<string> = new Set();
  private processingAnswersRef: Set<string> = new Set();
  // Set для обработанных offer/answer (ключ: from + pcToken + sdpHash + counter)
  // Используем hash SDP и счетчик для разрешения легитимных re-negotiation на том же PC
  private processedOffersRef: Set<string> = new Set();
  private processedAnswersRef: Set<string> = new Set();
  // Счетчики для offer/answer на каждый pcToken+from (для разрешения re-negotiation)
  private offerCounterByKeyRef: Map<string, number> = new Map();
  private answerCounterByKeyRef: Map<string, number> = new Map();
  private iceRestartInProgressRef: boolean = false;
  private restartCooldownRef: number = 0;
  private isInPiPRef: boolean = false; // Флаг для защиты от закрытия PC во время PiP
  
  // PC creation lock - защита от множественного создания PC
  private pcCreationInProgressRef: boolean = false;
  private roomJoinedRef: Set<string> = new Set(); // Множество комнат, к которым мы уже присоединились
  private callAcceptedProcessingRef: boolean = false; // Защита от множественной обработки call:accepted
  
  // PC token protection - защита от отложенных событий после Next/cleanup
  private pcToken: number = 0;
  
  // Connection state management
  private isConnectedRef: boolean = false;
  private reconnectTimerRef: ReturnType<typeof setTimeout> | null = null;
  private connectionCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  
  // Remote camera state management
  private remoteCamOnRef: boolean = true;
  private remoteForcedOffRef: boolean = false;
  private camToggleSeenRef: boolean = false;
  private remoteViewKeyRef: number = 0;
  private trackCheckIntervalRef: ReturnType<typeof setInterval> | null = null;
  private connectionEstablishedAtRef: number = 0; // Время установки соединения для защиты от ранних cam-toggle
  private pendingCamToggleRef: { enabled: boolean; from: string; timestamp: number } | null = null; // Отложенное состояние cam-toggle до установки remoteStream
  private remoteStreamEstablishedAtRef: number = 0; // Время установки remoteStream для проверки возраста трека
  private endedStreamIgnoredAtRef: number = 0; // Время последнего игнорирования ended стрима
  private endedStreamTimeoutRef: ReturnType<typeof setTimeout> | null = null; // Таймаут для обработки ended стримов
  
  // Remote audio state management
  private remoteMutedRef: boolean = false;
  
  // Remote PiP state management
  private remoteInPiPRef: boolean = false;
  
  // PiP state management
  private pipPrevCamOnRef: boolean | null = null; // Состояние камеры перед входом в PiP
  
  // Mic meter management
  private micStatsTimerRef: ReturnType<typeof setInterval> | null = null;
  private energyRef: number | null = null;
  private durRef: number | null = null;
  private lowLevelCountRef: number = 0;
  
  // Auto-search management
  private autoSearchTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  private lastAutoSearchRef: number = 0;
  private manuallyRequestedNextRef: boolean = false;
  
  // AppState management
  private appStateSubscription: any = null;
  private wasInBackgroundRef: boolean = false;
  
  private config: WebRTCSessionConfig;
  
  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    this.loadIceConfiguration();
    
    // КРИТИЧНО: Регистрируем обработчики только если socket уже подключен
    // Иначе регистрируем при подключении
    if (socket.connected) {
      try {
        this.setupSocketHandlers();
      } catch (e) {
        console.error('[WebRTCSession] ❌❌❌ CONSTRUCTOR: ERROR calling setupSocketHandlers ❌❌❌', e);
      }
    }
    
    this.startTrackChecker();
    this.setupAppStateListener();
    
    // КРИТИЧНО: Перерегистрируем обработчики при каждом подключении socket
    // Это гарантирует, что обработчики всегда зарегистрированы
    const onConnect = () => {
      // Небольшая задержка, чтобы socket точно был готов
      setTimeout(() => {
        try {
          this.setupSocketHandlers();
        } catch (e) {
          console.error('[WebRTCSession] ❌❌❌ CONNECT EVENT: ERROR calling setupSocketHandlers ❌❌❌', e);
        }
      }, 100);
    };
    
    const onReconnect = () => {
      setTimeout(() => {
        try {
          this.setupSocketHandlers();
        } catch (e) {
          console.error('[WebRTCSession] ❌❌❌ RECONNECT EVENT: ERROR calling setupSocketHandlers ❌❌❌', e);
        }
      }, 100);
    };
    
    // Регистрируем обработчики подключения
    try {
      socket.on('connect', onConnect);
      socket.on('reconnect', onReconnect);
    } catch (e) {
      console.error('[WebRTCSession] ❌❌❌ CONSTRUCTOR: ERROR registering connect/reconnect handlers ❌❌❌', e);
    }
    
    // Сохраняем ссылки для возможной очистки
    (this as any)._connectHandler = onConnect;
    (this as any)._reconnectHandler = onReconnect;
  }
  
  // ==================== ICE Configuration ====================
  
  private async loadIceConfiguration() {
    try {
      const config = await getIceConfiguration();
      this.iceConfigRef = config;
    } catch (error) {
      logger.error('[WebRTCSession] Failed to load ICE configuration:', error);
      this.iceConfigRef = getEnvFallbackConfiguration();
    }
  }
  
  private getIceConfig(): RTCConfiguration {
    if (this.iceConfigRef) {
      return this.iceConfigRef;
    }
    return getEnvFallbackConfiguration();
  }
  
  // ==================== Stream Management ====================
  
  async startLocalStream(side: CamSide = 'front'): Promise<MediaStream | null> {
    // Проверка неактивного состояния
    const isInactiveState = this.config.getIsInactiveState?.() ?? false;
    const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
    const hasFriendCallIntent = 
      (this.config.getFriendCallAccepted?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getIsDirectCall?.() ?? false);
    const isRandomChat = this.config.getStarted?.() ?? false;
    
    // КРИТИЧНО: Для рандомного чата всегда разрешаем создание стрима
    // isInactiveState уже сброшен в startRandomChat перед вызовом startLocalStream
    if (isInactiveState && !hasActiveCall && !isRandomChat) {
      if (!hasFriendCallIntent) {
        return null;
      }
      // Выходим из неактивного состояния для дружеских звонков
      this.config.setIsInactiveState?.(false);
      this.config.setWasFriendCallEnded?.(false);
    }
    
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
      // КРИТИЧНО: Проверяем, что треки действительно активны
      const tracks = existingStream.getTracks?.() || [];
      const activeTracks = tracks.filter((t: any) => t.readyState === 'live');
      
      if (activeTracks.length > 0) {
        // Убеждаемся, что событие было отправлено (на случай если компонент еще не подписался)
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
          logger.error('[WebRTCSession] All getUserMedia attempts failed:', e3);
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
   * Остановить удаленный стрим и очистить все связанные состояния
   */
  stopRemoteStream(): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new');
    
    
    // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
    // Проверяем наличие remoteStream И состояние PeerConnection
    // Если есть remoteStream и PC не закрыт - это активное соединение
    if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
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
    
    // КРИТИЧНО: Всегда очищаем remote stream при остановке
    this.remoteStreamRef = null;
    this.remoteStreamEstablishedAtRef = 0; // Сбрасываем время установки
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
    this.pendingCamToggleRef = null; // Очищаем отложенное состояние cam-toggle
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.emit('remoteCamStateChanged', false);
    this.emit('remoteViewKeyChanged', 0);
    this.emitRemoteState();
    
    // Останавливаем track checker
    this.stopTrackChecker();
  }
  
  /**
   * Очистка после неуспешного дружеского звонка (timeout или busy)
   * Останавливает удаленный стрим, сбрасывает флаги дружеского звонка, но не трогает локальный стрим
   */
  cleanupAfterFriendCallFailure(reason: 'timeout' | 'busy'): void {
    
    // 1. Останавливаем удаленный стрим (если есть)
    if (this.remoteStreamRef) {
      this.stopRemoteStream();
    }
    
    // 2. Локальный стрим НЕ трогаем (чтобы камера не мигала)
    
    // 3. Сбрасываем флаги через config
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    // started — на усмотрение: если это просто неуспешный звонок друга, можно оставить started как есть.
    
    // 4. Эмитим soft-событие для UI
    this.emit('callEnded');
  }
  
  /**
   * Приватный метод для остановки локального стрима без лишних проверок и сайд-эффектов
   */
  private stopLocalStreamInternal(): void {
    if (!this.localStreamRef) {
      return;
    }
    
    // КРИТИЧНО: Принудительно останавливаем все треки локального стрима
    // Это гарантирует, что камера полностью остановится после завершения звонка
    try {
      const tracks = this.localStreamRef.getTracks?.() || [];
      console.log('🛑 [stopLocalStreamInternal] Останавливаем треки локального стрима', {
        tracksCount: tracks.length,
        tracks: tracks.map((t: any) => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState
        }))
      });
      
      tracks.forEach((t: any) => {
        try {
          // КРИТИЧНО: Проверяем, что трек еще не был остановлен
          if (t && t.readyState !== 'ended' && t.readyState !== null) {
            // Сначала отключаем трек
            t.enabled = false;
            // Затем останавливаем трек
            t.stop();
            // Пытаемся освободить ресурсы (если метод доступен)
            try { (t as any).release?.(); } catch {}
            
            console.log('🛑 [stopLocalStreamInternal] Трек остановлен', {
              kind: t.kind,
              readyState: t.readyState
            });
          }
        } catch (e) {
          logger.warn('[WebRTCSession] Error stopping track in stopLocalStreamInternal:', e);
        }
      });
      
      // КРИТИЧНО: Дополнительная проверка - убеждаемся, что все треки действительно остановлены
      const remainingTracks = this.localStreamRef.getTracks?.() || [];
      const activeTracks = remainingTracks.filter((t: any) => t.readyState !== 'ended');
      if (activeTracks.length > 0) {
        logger.warn('🛑 [stopLocalStreamInternal] ⚠️ Некоторые треки не остановлены, повторная попытка', {
          activeTracksCount: activeTracks.length
        });
        // Повторная попытка остановки
        activeTracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          } catch {}
        });
      }
    } catch (e) {
      logger.error('[WebRTCSession] Error in stopLocalStreamInternal:', e);
    }
    
    // Очищаем ссылку на стрим
    this.localStreamRef = null;
    this.config.callbacks.onLocalStreamChange?.(null);
    this.config.onLocalStreamChange?.(null);
    this.emit('localStream', null);
    
    console.log('🛑 [stopLocalStreamInternal] ✅ Локальный стрим полностью остановлен');
  }
  
  /**
   * Приватный метод для остановки удаленного стрима без лишних проверок
   */
  private stopRemoteStreamInternal(): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new');
    
    
    // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
    // Проверяем наличие remoteStream И состояние PeerConnection
    // Если есть remoteStream и PC не закрыт - это активное соединение
    if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
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
    
    // Очищаем remote stream только если соединение действительно разорвано
    this.remoteStreamRef = null;
    this.remoteStreamEstablishedAtRef = 0; // Сбрасываем время установки
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
  
  /**
   * Обработка внешнего события завершения звонка (call:ended)
   * Содержит логику очистки WebRTC состояния
   */
  handleExternalCallEnded(reason?: string, data?: any): void {
    console.log('🔥🔥🔥 [handleExternalCallEnded] 📥 ПОЛУЧЕНО call:ended СОБЫТИЕ', {
      reason,
      data,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef,
      hasPeerConnection: !!this.peerRef,
      hasLocalStream: !!this.localStreamRef,
      hasRemoteStream: !!this.remoteStreamRef
    });
    
    // КРИТИЧНО: Обрабатываем call:ended ТОЛЬКО для дружеских звонков
    // Для рандомного чата используется handleRandomDisconnected
    const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                         (this.config.getInDirectCall?.() ?? false) || 
                         (this.config.getFriendCallAccepted?.() ?? false);
    
    console.log('🔥 [handleExternalCallEnded] ПРОВЕРКА ТИПА ЗВОНКА', {
      isFriendCall,
      isDirectCall: this.config.getIsDirectCall?.() ?? false,
      inDirectCall: this.config.getInDirectCall?.() ?? false,
      friendCallAccepted: this.config.getFriendCallAccepted?.() ?? false
    });
    
    if (!isFriendCall) {
      // Это не дружеский звонок - игнорируем call:ended
      // Для рандомного чата используется handleRandomDisconnected
      console.log('🔥 [handleExternalCallEnded] ИГНОРИРУЕМ call:ended - НЕ ДРУЖЕСКИЙ ЗВОНОК');
      return;
    }
    
    console.log('🔥🔥 [handleExternalCallEnded] НАЧАЛО ОБРАБОТКИ ЗАВЕРШЕНИЯ ДРУЖЕСКОГО ЗВОНКА');
    
    // КРИТИЧНО: Для дружеских звонков ВСЕГДА обрабатываем call:ended, даже если соединение активно
    // Это нужно чтобы завершить звонок у обоих участников
    // Не проверяем активность соединения - завершаем звонок принудительно
    
    // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
    if (this.peerRef) {
      this.incrementPcToken();
    }
    
    // 1. Остановить локальный стрим (без лишних emit'ов)
    // КРИТИЧНО: Для дружеских звонков принудительно останавливаем все треки
    this.stopLocalStreamInternal();
    
    // 2. Очищаем remoteStream
    // КРИТИЧНО: Для дружеских звонков принудительно останавливаем remote stream
    // НЕ используем stopRemoteStreamInternal, так как он проверяет активность соединения
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
    
    // Останавливаем метры
    this.stopMicMeter();
    
    // 3. Закрываем PeerConnection для дружеских звонков
    if (this.peerRef) {
      try {
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[WebRTCSession] Error closing PC in handleExternalCallEnded:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // 4. Останавливаем все таймеры и интервалы
    // КРИТИЧНО: Останавливаем ВСЕ процессы, чтобы ничего не работало в фоне
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    
    // КРИТИЧНО: Дополнительная проверка - убеждаемся, что локальный стрим полностью остановлен
    // Вызываем stopLocalStreamInternal еще раз для гарантии
    this.stopLocalStreamInternal();
    
    // Дополнительная проверка - если стрим все еще существует, принудительно останавливаем
    if (this.localStreamRef) {
      logger.warn('🛑 [handleExternalCallEnded] ⚠️ Локальный стрим все еще существует после stopLocalStreamInternal, принудительная остановка');
      try {
        const tracks = this.localStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            if (t && t.readyState !== 'ended' && t.readyState !== null) {
              t.enabled = false;
              t.stop();
              try { (t as any).release?.(); } catch {}
            }
          } catch {}
        });
      } catch {}
      // Очищаем ссылку на стрим
      this.localStreamRef = null;
      this.config.callbacks.onLocalStreamChange?.(null);
      this.config.onLocalStreamChange?.(null);
      this.emit('localStream', null);
    }
    
    // 5. Сбрасываем состояние через config:
    this.config.setStarted?.(false);
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setIsInactiveState?.(true);
    this.config.setWasFriendCallEnded?.(true);
    
    // 6. Выходим из комнаты перед очисткой идентификаторов
    const roomIdToLeave = this.roomIdRef;
    if (roomIdToLeave) {
      try {
        socket.emit('room:leave', { roomId: roomIdToLeave });
        console.log('📥 [handleExternalCallEnded] ✅ Left room', { roomId: roomIdToLeave });
      } catch (e) {
        logger.warn('[WebRTCSession] Error emitting room:leave in handleExternalCallEnded:', e);
      }
    }
    
    // 7. Очищаем все идентификаторы
    this.partnerIdRef = null;
    this.roomIdRef = null;
    this.callIdRef = null;
    this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
    this.callAcceptedProcessingRef = false; // Сбрасываем флаг обработки call:accepted
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.onCallIdChange?.(null);
    
    console.log('📥 [handleExternalCallEnded] State reset completed', {
      roomId: this.roomIdRef,
      callId: this.callIdRef,
      partnerId: this.partnerIdRef
    });
    
    // 8. Эмитим 'callEnded' для UI
    this.emit('callEnded');
    
    console.log('✅ [handleExternalCallEnded] Friend call ended successfully - all processes stopped, room left');
  }
  
  /**
   * Обработка отключения для рандомного чата (disconnected/hangup)
   * Останавливает стримы и сбрасывает флаги только для рандомного чата
   */
  handleRandomDisconnected(source: 'server' | 'local'): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new');
    
    
    // КРИТИЧНО: НЕ обрабатываем handleRandomDisconnected если соединение активно
    // Проверяем наличие remoteStream И состояние PeerConnection
    if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      const isPcActive = pc.iceConnectionState === 'checking' || 
                        pc.iceConnectionState === 'connected' || 
                        pc.iceConnectionState === 'completed' ||
                        (pc as any).connectionState === 'connecting' ||
                        (pc as any).connectionState === 'connected';
      
      if (isPcActive) {
        return;
      }
    }
    
    // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
    if (this.peerRef) {
      this.incrementPcToken();
    }
    
    // 1. Останавливаем локальный стрим, но НЕ трогаем autoNext и friend-call флаги
    this.stopLocalStreamInternal();
    
    // 2. Чистим remoteStream
    if (this.remoteStreamRef) {
      this.stopRemoteStreamInternal();
    }
    
    // 3. Сбрасываем started только если это рандом-чат (можно проверить через getIsDirectCall / getInDirectCall)
    const isDirect = this.config.getIsDirectCall?.() ?? false;
    const inDirect = this.config.getInDirectCall?.() ?? false;
    const isRandom = !isDirect && !inDirect;
    
    if (isRandom) {
      this.config.setStarted?.(false);
    }
    
    // 4. Эмитим 'disconnected', чтобы UI мог отреагировать
    this.emit('disconnected');
  }
  
  async stopLocalStream(preserveStreamForConnection: boolean = false, force: boolean = false): Promise<void> {
    const started = this.config.getStarted?.() ?? false;
    const isSearching = started && !this.partnerIdRef && !this.roomIdRef;
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasStream = !!this.localStreamRef;
    
    
    // КРИТИЧНО: Не останавливаем стрим если пользователь только что начал поиск
    // Это предотвращает остановку стрима сразу после нажатия "Начать"
    // НО: если force=true, останавливаем принудительно (например, при нажатии "Стоп")
    if (isSearching && !preserveStreamForConnection && !force) {
      return;
    }
    
    // КРИТИЧНО: Если preserveStreamForConnection=false, останавливаем стрим полностью
    // Это нужно для правильной остановки при нажатии "Стоп"
    // Сохраняем стрим только если есть активное соединение И preserveStreamForConnection=true
    if (preserveStreamForConnection && hasActiveConnection) {
      try {
        const needCleanupPc = this.peerRef || this.preCreatedPcRef;
        if (needCleanupPc) {
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
        const needCleanupPc = this.peerRef || this.preCreatedPcRef;
        if (needCleanupPc) {
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
        const needCleanupPc = this.peerRef || this.preCreatedPcRef;
        if (needCleanupPc) {
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
        const needCleanupPc = this.peerRef || this.preCreatedPcRef;
        if (needCleanupPc) {
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
      // КРИТИЧНО: Инкрементируем токен один раз перед очисткой всех PC
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
      logger.error('[WebRTCSession] Error removing tracks from PeerConnection:', e);
    }
    
    await cleanupStream(ls);
    this.localStreamRef = null;
    this.config.callbacks.onLocalStreamChange?.(null);
    this.config.onLocalStreamChange?.(null);
  }
  
  async flipCam(): Promise<void> {
    const ls = this.localStreamRef;
    if (!ls) return;
    
    const videoTrack = ls.getVideoTracks?.()?.[0];
    if (!videoTrack) return;
    
    if (typeof (videoTrack as any)._switchCamera === 'function') {
      (videoTrack as any)._switchCamera();
      return;
    }
    
    try {
      const currentFacing = 'front'; // TODO: track facing state
      const newFacing: CamSide = currentFacing === 'front' ? 'back' : 'front';
      const newStream = await mediaDevices.getUserMedia({
        video: { facingMode: newFacing },
        audio: true,
      });
      
      const newVideoTrack = (newStream as any)?.getVideoTracks?.()?.[0];
      if (newVideoTrack) {
        const sender = this.peerRef
          ?.getSenders()
          .find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
        
        ls.addTrack(newVideoTrack);
        
        setTimeout(() => {
          try { ls.removeTrack(videoTrack); } catch {}
          try { videoTrack.stop(); } catch {}
        }, 50);
      }
    } catch (err) {
      console.warn('[WebRTCSession] flipCam fallback error', err);
    }
  }
  
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
   * Отправляет состояние камеры партнеру через сокет
   * @param toPartnerId - ID партнера (socket.id), если не указан, используется текущий partnerId
   * @param enabled - Состояние камеры (включена/выключена), если не указано, берется из текущего трека
   */
  sendCameraState(toPartnerId?: string, enabled?: boolean): void {
    const targetPartnerId = toPartnerId || this.partnerIdRef;
    
    // Определяем текущее состояние камеры
    let isEnabled: boolean;
    if (enabled !== undefined) {
      isEnabled = enabled;
    } else {
      // Берем состояние из текущего трека
      const videoTrack = this.localStreamRef ? (this.localStreamRef as any)?.getVideoTracks?.()?.[0] : null;
      isEnabled = videoTrack?.enabled ?? true;
    }
    
    // КРИТИЧНО: Для прямых звонков не требуем partnerId, так как используем roomId
    const isFriendCall = 
      (this.config.getIsDirectCall?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getFriendCallAccepted?.() ?? false);
    const currentRoomId = this.roomIdRef;
    
    // Для рандомного чата требуем partnerId
    if (!isFriendCall && !targetPartnerId) {
      console.warn('[WebRTCSession] sendCameraState: No partner ID available for random chat', {
        toPartnerId,
        currentPartnerId: this.partnerIdRef
      });
      return;
    }
    
    try {
      const payload: any = { 
        enabled: isEnabled, 
        from: socket.id
      };
      
      if (isFriendCall && currentRoomId) {
        // Для прямых звонков используем roomId
        payload.roomId = currentRoomId;
      } else if (!isFriendCall && targetPartnerId) {
        // Для рандомного чата добавляем to: targetPartnerId
        payload.to = targetPartnerId;
      }
      
      socket.emit('cam-toggle', payload);
    } catch (e) {
      logger.warn('[WebRTCSession] Error sending camera state:', e);
    }
  }
  
  toggleCam(): void {
    if (!this.localStreamRef) {
      console.warn('[WebRTCSession] toggleCam: No local stream');
      return;
    }
    
    const videoTrack = (this.localStreamRef as any)?.getVideoTracks?.()?.[0];
    if (!videoTrack) {
      console.warn('[WebRTCSession] toggleCam: No video track');
      return;
    }
    
    const oldValue = videoTrack.enabled;
    const newValue = !oldValue;
    videoTrack.enabled = newValue;
    
    this.config.callbacks.onCamStateChange?.(newValue);
    this.config.onCamStateChange?.(newValue);
    
    // Отправка состояния камеры через сокет используя новый метод
    this.sendCameraState(undefined, newValue);
  }
  
  async restartLocalCamera(): Promise<void> {
    console.warn('[WebRTCSession] restartLocalCamera called - restarting local camera');
    
    // Сохраняем текущее состояние камеры (enabled)
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
          // Восстанавливаем состояние enabled
          newVideoTrack.enabled = wasEnabled;
        }
      } else {
        console.error('[WebRTCSession] restartLocalCamera: Failed to create valid stream');
      }
    } catch (e) {
      logger.error('[WebRTCSession] restartLocalCamera: Error recreating stream:', e);
    }
  }
  
  // ==================== PeerConnection Management ====================
  
  private cleanupPeer(pc?: RTCPeerConnection | null): void {
    if (!pc) return;
    
    // КРИТИЧНО: Защита от закрытия PC во время PiP
    if (this.isInPiPRef) {
      return;
    }
    
    // Очищаем таймеры если это текущий PC
    if (this.peerRef === pc) {
      this.clearConnectionTimers();
      if (this.isConnectedRef) {
        this.setConnected(false);
      }
    }
    
    if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
      try {
        (pc as any).ontrack = null;
        (pc as any).onaddstream = null;
        (pc as any).onicecandidate = null;
        (pc as any).onconnectionstatechange = null;
        (pc as any).oniceconnectionstatechange = null;
        (pc as any).onsignalingstatechange = null;
        (pc as any).onicegatheringstatechange = null;
        (pc as any)._remoteHandlersAttached = false;
      } catch {}
      return;
    }
    
    if (this.preCreatedPcRef === pc) {
      this.preCreatedPcRef = null;
    }
    
    try {
      // КРИТИЧНО: replaceTrack(null) удаляет треки из PC, но НЕ останавливает сами треки локального стрима
      // Это правильно - треки локального стрима должны продолжать работать для автопоиска
      pc.getSenders?.().forEach((s: any) => {
        try { 
          // Удаляем треки из PC, но НЕ вызываем track.stop() - треки должны остаться активными
          s.replaceTrack?.(null); 
        } catch {}
      });
    } catch {}
    
    try {
      (pc as any).ontrack = null;
      (pc as any).onaddstream = null;
      (pc as any).onicecandidate = null;
      (pc as any).onconnectionstatechange = null;
      (pc as any).oniceconnectionstatechange = null;
      (pc as any).onsignalingstatechange = null;
      (pc as any).onicegatheringstatechange = null;
      (pc as any)._remoteHandlersAttached = false;
    } catch {}
    
    try {
      const closeTime = Date.now();
      pc.close();
      (global as any).__lastPcClosedAt = closeTime;
    } catch {}
  }
  
  // Метод для установки флага PiP (вызывается из компонента)
  setInPiP(inPiP: boolean): void {
    this.isInPiPRef = inPiP;
  }
  
  // Приватный метод для эмита события sessionUpdate при изменении идентификаторов
  private emitSessionUpdate(): void {
    this.emit('sessionUpdate', {
      roomId: this.roomIdRef,
      partnerId: this.partnerIdRef,
      callId: this.callIdRef
    });
  }
  
  // Приватный метод для эмита события remoteState при изменении remote состояний
  private emitRemoteState(): void {
    this.emit('remoteState', {
      remoteCamOn: this.remoteCamOnRef,
      remoteMuted: this.remoteMutedRef,
      remoteInPiP: this.remoteInPiPRef,
      remoteViewKey: this.remoteViewKeyRef
    });
  }
  
  // ==================== PC Token Protection ====================
  
  /**
   * Инкрементирует токен PC и помечает текущий PC этим токеном, очищая очереди ICE
   * Вызывается перед принудительным закрытием PC (next/stop/force cleanup/disconnectCompletely)
   */
  /**
   * Простая функция для вычисления hash строки (для SDP)
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Инкрементирует токен PC только при реальной смене/закрытии PC
   * Если PC переиспользуется (тот же объект), не сбрасывает processed-сеты
   */
  private incrementPcToken(forceReset: boolean = true): void {
    this.pcToken++;
    const currentPc = this.peerRef;
    if (currentPc) {
      (currentPc as any)._pcToken = this.pcToken;
    }
    // Очищаем очереди ICE для предотвращения обработки отложенных кандидатов
    this.iceCandidateQueue.clear();
    this.pendingIceByFromRef = {};
    // КРИТИЧНО: Очищаем кеш исходящих ICE кандидатов при next/cleanup
    this.outgoingIceCache = [];
    
    // КРИТИЧНО: Очищаем обработанные offer/answer и счетчики только при явной смене PC
    // Если PC переиспользуется (тот же объект), не сбрасываем processed-сеты
    if (forceReset) {
      this.processedOffersRef.clear();
      this.processedAnswersRef.clear();
      this.offerCounterByKeyRef.clear();
      this.answerCounterByKeyRef.clear();
    }
  }
  
  /**
   * Помечает PC актуальным токеном при создании/переиспользовании
   */
  private markPcWithToken(pc: RTCPeerConnection): void {
    (pc as any)._pcToken = this.pcToken;
  }
  
  /**
   * Проверяет, актуален ли токен PC (PC не был закрыт/заменен)
   */
  private isPcTokenValid(pc: RTCPeerConnection | null): boolean {
    if (!pc) return false;
    const pcToken = (pc as any)?._pcToken;
    return pcToken === this.pcToken;
  }
  
  /**
   * Проверяет, что PC не закрыт и токен актуален
   */
  private isPcValid(pc: RTCPeerConnection | null): boolean {
    if (!pc) return false;
    if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') return false;
    return this.isPcTokenValid(pc);
  }
  
  // ==================== PeerConnection Creation ====================
  
  async ensurePcWithLocal(stream: MediaStream): Promise<RTCPeerConnection | null> {
    // КРИТИЧНО: Защита от множественного создания PC
    if (this.pcCreationInProgressRef) {
      console.log('[WebRTCSession] PC creation already in progress, waiting...');
      // Ждем завершения текущего создания PC (максимум 5 секунд)
      let attempts = 0;
      while (this.pcCreationInProgressRef && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }
      // Если PC уже создан, возвращаем его
      if (this.peerRef && this.peerRef.signalingState !== 'closed') {
        console.log('[WebRTCSession] Returning existing PC after waiting');
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
            // КРИТИЧНО: Помечаем переиспользуемый PC актуальным токеном
            this.markPcWithToken(existingPc);
            return existingPc;
          }
        } catch {}
      }
    }
    
    let pc = this.peerRef;
    
    // КРИТИЧНО: Для дружеских звонков НЕ пересоздаем PC, если он уже существует
    const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                         (this.config.getInDirectCall?.() ?? false) || 
                         (this.config.getFriendCallAccepted?.() ?? false);
    
    // Проверка существующего PC
    if (pc) {
      try {
        const state = pc.signalingState;
        const hasLocalDesc = !!(pc as any)?.currentLocalDescription || !!(pc as any)?.localDescription;
        const hasRemoteDesc = !!(pc as any)?.currentRemoteDescription || !!(pc as any)?.remoteDescription;
        const hasNoDescriptions = !hasLocalDesc && !hasRemoteDesc;
        const isInitial = state === 'stable' && hasNoDescriptions;
        const isClosed = state === 'closed' || (pc as any).connectionState === 'closed';
        
        if (isClosed) {
          // Для дружеских звонков закрытый PC - критическая ошибка
          if (isFriendCall) {
            console.log('[WebRTCSession] ⚠️ [FRIEND CALL] PC is closed, cleaning up', {
              roomId: this.roomIdRef,
              partnerId: this.partnerIdRef
            });
          }
          try {
            this.cleanupPeer(pc);
          } catch (e) {
            console.warn('[WebRTCSession] Error cleaning up closed PC:', e);
          }
          pc = null;
          this.peerRef = null;
        } else if (!isInitial) {
          // КРИТИЧНО: Для дружеских звонков ВСЕГДА переиспользуем существующий PC
          // Для рандомного чата тоже переиспользуем, если PC не в начальном состоянии
          if (isFriendCall) {
            console.log('[WebRTCSession] ✅ [FRIEND CALL] Reusing existing PC', {
              state,
              hasLocalDesc,
              hasRemoteDesc,
              roomId: this.roomIdRef
            });
          }
          // КРИТИЧНО: Помечаем переиспользуемый PC актуальным токеном
          this.markPcWithToken(pc);
          return pc;
        } else if (isInitial && isFriendCall) {
          // Для дружеских звонков даже если PC в начальном состоянии, переиспользуем его
          // Это предотвращает создание нескольких PC
          console.log('[WebRTCSession] ✅ [FRIEND CALL] Reusing PC in initial state', {
            state,
            roomId: this.roomIdRef
          });
          this.markPcWithToken(pc);
          return pc;
        }
      } catch (e) {
        if (isFriendCall) {
          console.log('[WebRTCSession] ⚠️ [FRIEND CALL] Cannot access PC state', e);
        } else {
          console.warn('[WebRTCSession] Cannot access PC state, creating new one:', e);
        }
        // Для дружеских звонков не пересоздаем PC при ошибке доступа к состоянию
        if (!isFriendCall) {
          try {
            this.cleanupPeer(pc);
          } catch {}
          pc = null;
          this.peerRef = null;
          (global as any).__lastPcClosedAt = Date.now();
        }
      }
    }
    
    // Очистка preCreatedPcRef
    if (this.preCreatedPcRef) {
      try {
        this.cleanupPeer(this.preCreatedPcRef);
        this.preCreatedPcRef = null;
      } catch (e) {
        console.warn('[WebRTCSession] Error cleaning up preCreatedPcRef:', e);
      }
    }
    
    const lastPcClosedAt = (global as any).__lastPcClosedAt;
    const savedLastPcClosedAt = lastPcClosedAt;
    
    if (!pc) {
      try {
        if (!stream || !isValidStream(stream)) {
          console.error('[WebRTCSession] Cannot create PC - stream is invalid or null', {
            streamExists: !!stream,
            streamValid: stream ? isValidStream(stream) : false,
            streamId: stream?.id
          });
          return null;
        }
        
        let videoTrack = stream.getVideoTracks()?.[0];
        let audioTrack = stream.getAudioTracks()?.[0];
        
        if (!videoTrack && !audioTrack) {
          console.error('[WebRTCSession] Stream has no tracks, cannot create PC', {
            streamId: stream.id,
            tracksLength: (stream as any).getTracks?.()?.length
          });
          return null;
        }
        
        // КРИТИЧНО: Если трек завершен, пересоздаем стрим перед созданием PC
        const videoTrackEnded = videoTrack && videoTrack.readyState === 'ended';
        const audioTrackEnded = audioTrack && audioTrack.readyState === 'ended';
        
        if (videoTrackEnded || audioTrackEnded) {
          console.warn('[WebRTCSession] Track(s) ended, attempting to recreate stream', {
            videoTrackEnded,
            audioTrackEnded
          });
          try {
            // Останавливаем старый стрим
            if (this.localStreamRef) {
              this.localStreamRef.getTracks().forEach((track: any) => track.stop());
              this.localStreamRef = null;
            }
            // Пересоздаем стрим
            const newStream = await this.startLocalStream();
            if (newStream && isValidStream(newStream)) {
              stream = newStream;
              // Обновляем videoTrack и audioTrack для нового стрима
              const newVideoTrack = stream.getVideoTracks()?.[0];
              const newAudioTrack = stream.getAudioTracks()?.[0];
              
              // Проверяем новые треки
              if (newVideoTrack && newVideoTrack.readyState === 'ended') {
                console.error('[WebRTCSession] Recreated video track is still ended, cannot create PC');
                return null;
              }
              if (newAudioTrack && newAudioTrack.readyState === 'ended') {
                console.error('[WebRTCSession] Recreated audio track is still ended, cannot create PC');
                return null;
              }
              
              // Обновляем ссылки на треки для дальнейшего использования
              videoTrack = newVideoTrack;
              audioTrack = newAudioTrack;
            } else {
              console.error('[WebRTCSession] Failed to recreate stream after track(s) ended');
              return null;
            }
          } catch (e) {
            console.error('[WebRTCSession] Error recreating stream after track(s) ended:', e);
            return null;
          }
        }
        
        const iceConfig = this.getIceConfig();
        
        // Логирование конфигурации для отладки
        const hasTurn = iceConfig.iceServers?.some((server: any) => {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          return urls.some((u: string) => u && u.startsWith('turn:'));
        }) ?? false;
        
        // КРИТИЧНО: Для рандомного чата создаем PC немедленно, без задержек
        // Это гарантирует быстрое установление соединения
        const isRandomChat = 
          !(this.config.getIsDirectCall?.() ?? false) &&
          !(this.config.getInDirectCall?.() ?? false) &&
          !(this.config.getFriendCallAccepted?.() ?? false);
        
        if (!isRandomChat) {
          // Для прямых звонков используем задержки для стабильности
          const PC_CREATION_DELAY = 2000; // Уменьшено с 7000 до 2000 для прямых звонков
          
          if (lastPcClosedAt) {
            const timeSinceClose = Date.now() - lastPcClosedAt;
            if (timeSinceClose < PC_CREATION_DELAY) {
              const delay = PC_CREATION_DELAY - timeSinceClose;
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } else {
            if (this.peerRef) {
              await new Promise(resolve => setTimeout(resolve, 500)); // Уменьшено с 1000 до 500
            } else {
              const INITIAL_PC_DELAY = 200; // Уменьшено с 500 до 200
              await new Promise(resolve => setTimeout(resolve, INITIAL_PC_DELAY));
            }
          }
        } else {
          // Для рандомного чата - минимальная задержка только если PC был закрыт недавно
          if (lastPcClosedAt) {
            const timeSinceClose = Date.now() - lastPcClosedAt;
            const MIN_DELAY = 100; // Минимальная задержка 100ms для рандомного чата
            if (timeSinceClose < MIN_DELAY) {
              const delay = MIN_DELAY - timeSinceClose;
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
          // Для рандомного чата без lastPcClosedAt - создаем PC немедленно
        }
        
        // Защита от одновременного создания
        // КРИТИЧНО: Для рандомного чата уменьшаем время ожидания
        const pcCreationLock = (global as any).__pcCreationLock;
        const lockTimeout = isRandomChat ? 500 : 2000; // Для рандомного чата 500ms, для прямых звонков 2000ms
        if (pcCreationLock && (Date.now() - pcCreationLock) < lockTimeout) {
          const waitTime = lockTimeout - (Date.now() - pcCreationLock);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        (global as any).__pcCreationLock = Date.now();
        this.pcCreationInProgressRef = true; // КРИТИЧНО: Устанавливаем флаг создания PC
        
        try {
          const oldPc = this.peerRef;
          pc = new RTCPeerConnection(iceConfig);
          this.peerRef = pc;
          (global as any).__pcCreationLock = null;
          this.pcCreationInProgressRef = false; // КРИТИЧНО: Сбрасываем флаг после успешного создания
          
          // КРИТИЧНО: Если создан новый PC (не переиспользован), инкрементируем токен и сбрасываем processed-сеты
          if (oldPc !== pc) {
            this.incrementPcToken(true); // forceReset=true при создании нового PC
          } else {
            // PC переиспользован - только помечаем токеном, не сбрасываем processed-сеты
            this.markPcWithToken(pc);
          }
          
          // Устанавливаем обработчики
          // КРИТИЧНО: Всегда вызываем attachRemoteHandlers, даже если partnerIdRef еще не установлен
          // partnerIdRef может быть установлен позже, но обработчик ontrack должен быть установлен сразу
          // для получения remoteStream при установке соединения
          this.bindConnHandlers(pc, this.partnerIdRef || undefined);
          // КРИТИЧНО: Для рандомного чата partnerIdRef устанавливается в handleMatchFound ДО создания PC
          // но на всякий случай вызываем attachRemoteHandlers всегда, так как он проверяет наличие partnerIdRef внутри
          this.attachRemoteHandlers(pc, this.partnerIdRef || undefined);
        } catch (createError: any) {
          (global as any).__pcCreationLock = null;
          this.pcCreationInProgressRef = false; // КРИТИЧНО: Сбрасываем флаг при ошибке
          console.error('[WebRTCSession] RTCPeerConnection constructor failed:', createError);
          (global as any).__lastPcClosedAt = Date.now();
          throw createError;
        }
      } catch (e) {
        (global as any).__pcCreationLock = null;
        this.pcCreationInProgressRef = false; // КРИТИЧНО: Сбрасываем флаг при ошибке
        const errorTime = Date.now();
        console.error('[WebRTCSession] Failed to create PeerConnection:', e);
        if (!(global as any).__lastPcClosedAt || (errorTime - ((global as any).__lastPcClosedAt || 0)) > 0) {
          (global as any).__lastPcClosedAt = errorTime;
        }
        return null;
      }
    }
    
    // КРИТИЧНО: Добавляем медиа-треки в PC - БЕЗ ЭТОГО камера работает, но в WebRTC не участвует
    // Без addTrack локальное видео не будет передаваться собеседнику
    const senders: RTCRtpSender[] = (pc.getSenders?.() || []) as any;
    const audioTracks = stream?.getAudioTracks?.() || [];
    const videoTracks = stream?.getVideoTracks?.() || [];
    
    // КРИТИЧНО: Проверяем, что треки не ended перед добавлением в PC
    // Если треки ended, это проблема на стороне отправителя - треки не должны останавливаться при next/cleanup
    const endedAudioTracks = audioTracks.filter((t: any) => t && t.readyState === 'ended');
    const endedVideoTracks = videoTracks.filter((t: any) => t && t.readyState === 'ended');
    if (endedAudioTracks.length > 0 || endedVideoTracks.length > 0) {
      console.error('[WebRTCSession] ❌❌❌ CRITICAL: Local stream tracks are ended before adding to PC!', {
        endedAudioCount: endedAudioTracks.length,
        endedVideoCount: endedVideoTracks.length,
        totalAudioTracks: audioTracks.length,
        totalVideoTracks: videoTracks.length,
        message: 'Tracks should NOT be stopped during next/cleanup - this is a bug!'
      });
    }
    
    let addedTracksCount = 0;
    let skippedTracksCount = 0;
    let replacedTracksCount = 0;
    let newTracksCount = 0;
    
    const replaceOrAdd = (track: any) => {
      // КРИТИЧНО: Не добавляем треки с readyState === 'ended' - они уже мертвы
      if (track && track.readyState === 'ended') {
        console.warn('[WebRTCSession] Skipping track with readyState=ended', {
          kind: track.kind,
          id: track.id,
          readyState: track.readyState
        });
        skippedTracksCount++;
        return;
      }
      
      if (!track) {
        console.warn('[WebRTCSession] Skipping null/undefined track');
        skippedTracksCount++;
        return;
      }
      
      const sameKind = senders.find((s: any) => s?.track?.kind === track.kind);
      if (sameKind) {
        try {
          sameKind.replaceTrack(track);
          replacedTracksCount++;
          addedTracksCount++;
        } catch (e) {
          console.error('[WebRTCSession] ❌ Error replacing track:', e);
        }
      } else {
        try {
          // КРИТИЧНО: Используем addTrack для добавления трека в PC
          // pc.addTrack(track, stream) - правильный способ добавления треков
          (pc as any).addTrack?.(track, stream as any);
          newTracksCount++;
          addedTracksCount++;
        } catch (e) {
          console.error('[WebRTCSession] ❌ Error adding track:', e);
        }
      }
    };
    
    // КРИТИЧНО: Добавляем аудио треки
    (audioTracks as any[]).forEach((t) => {
      if (t) {
        replaceOrAdd(t as any);
      }
    });
    
    // КРИТИЧНО: Добавляем видео треки
    (videoTracks as any[]).forEach((t) => {
      if (t) {
        replaceOrAdd(t as any);
      }
    });
    
    // КРИТИЧНО: Проверяем что треки действительно добавлены в PC
    const finalSenders = pc.getSenders?.() || [];
    const finalAudioSenders = finalSenders.filter((s: any) => s?.track?.kind === 'audio');
    const finalVideoSenders = finalSenders.filter((s: any) => s?.track?.kind === 'video');
    
    
    // КРИТИЧНО: Если все треки пропущены (readyState='ended'), это проблема
    if (addedTracksCount === 0 && (audioTracks.length > 0 || videoTracks.length > 0)) {
      console.error('[WebRTCSession] ❌❌❌ CRITICAL: Все треки пропущены из-за readyState=ended! Нужно пересоздать стрим', {
        audioTracksCount: audioTracks.length,
        videoTracksCount: videoTracks.length,
        skippedTracksCount,
        finalSendersCount: finalSenders.length
      });
      // Закрываем PC, так как он бесполезен без треков
      try {
        pc.close();
      } catch {}
      return null;
    }
    
    // КРИТИЧНО: Проверяем что хотя бы один трек добавлен
    if (finalSenders.length === 0 && (audioTracks.length > 0 || videoTracks.length > 0)) {
      console.error('[WebRTCSession] ❌❌❌ CRITICAL: Треки не добавлены в PC! Камера работает, но в WebRTC не участвует', {
        audioTracksCount: audioTracks.length,
        videoTracksCount: videoTracks.length,
        finalSendersCount: finalSenders.length
      });
      // Пытаемся использовать addStream как fallback (устаревший метод, но может помочь)
      try {
        (pc as any).addStream?.(stream as any);
        const afterAddStreamSenders = pc.getSenders?.() || [];
        if (afterAddStreamSenders.length === 0) {
          console.error('[WebRTCSession] ❌ addStream fallback also failed - PC has no tracks!');
          return null;
        }
      } catch (e) {
        console.error('[WebRTCSession] ❌ addStream fallback error:', e);
        return null;
      }
    } else {
      // Успешно добавили треки
    }
    
    // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен после создания PC
    // БЕЗ ontrack вы НИКОГДА не увидите собеседника - это критично для ВСЕХ типов звонков
    if (this.partnerIdRef) {
      const hasOntrack = !!(pc as any)?.ontrack;
      
      if (!hasOntrack) {
        console.warn('[WebRTCSession] ⚠️⚠️⚠️ КРИТИЧНО: ontrack handler missing after PC creation - MUST attach!', {
          partnerId: this.partnerIdRef,
          hasOntrack: false,
          willAttach: true
        });
        this.attachRemoteHandlers(pc, this.partnerIdRef);
      } else {
      }
    } else {
      // Даже если partnerIdRef еще не установлен, нужно убедиться что ontrack установлен
      // Он может быть установлен позже, но лучше установить сразу
      const hasOntrack = !!(pc as any)?.ontrack;
      if (!hasOntrack) {
        console.warn('[WebRTCSession] ⚠️ ontrack handler missing after PC creation (no partnerId yet)', {
          hasOntrack: false,
          willAttachOnPartnerId: true
        });
      }
    }
    
    return pc;
  }
  
  // ==================== Connection Handlers ====================
  
  private bindConnHandlers(pc: RTCPeerConnection, expectedPartnerId?: string): void {
    // Очищаем предыдущие таймеры если есть
    this.clearConnectionTimers();
    
    // КРИТИЧНО: Устанавливаем обработчик onicecandidate для отправки ICE-кандидатов через сервер
    // Без этого ICE-кандидаты не будут пересылаться и P2P-канал не сформируется
    (pc as any).onicecandidate = (event: any) => {
      // КРИТИЧНО: Проверяем, что PC не закрыт и токен актуален
      // Ранний return для предотвращения обработки отложенных кандидатов после Next/cleanup
      if (!this.isPcValid(pc)) {
        return;
      }
      
      if (event.candidate) {
        const toId = this.partnerIdRef || expectedPartnerId;
        if (toId) {
          const payload: any = { to: toId, candidate: event.candidate };
          // КРИТИЧНО: Для дружеских звонков добавляем roomId
          const isFriendCall = 
            (this.config.getIsDirectCall?.() ?? false) ||
            (this.config.getInDirectCall?.() ?? false) ||
            (this.config.getFriendCallAccepted?.() ?? false);
          if (isFriendCall && this.roomIdRef) {
            payload.roomId = this.roomIdRef;
          }
          socket.emit('ice-candidate', payload);
        } else {
          // КРИТИЧНО: Кешируем ICE кандидаты до установки partnerId
          // Они будут отправлены после match_found
          this.outgoingIceCache.push(event.candidate);
          console.log('[WebRTCSession] ICE candidate cached (no partnerId yet)', {
            cachedCount: this.outgoingIceCache.length,
            candidate: event.candidate
          });
        }
      } else {
        // null candidate означает завершение сбора кандидатов
        // Если partnerId еще не установлен, помечаем что кеш завершен
        if (!this.partnerIdRef && !expectedPartnerId) {
          console.log('[WebRTCSession] ICE gathering completed, cache ready for partnerId', {
            cachedCount: this.outgoingIceCache.length
          });
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
    
    // Запускаем периодическую проверку состояния (на случай если события не срабатывают)
    this.startConnectionCheckInterval(pc);
  }
  
  // ==================== Fallback: Check Receivers for Remote Stream ====================
  
  private checkReceiversForRemoteStream(pc: RTCPeerConnection): void {
    
    // КРИТИЧНО: Проверяем даже если соединение еще не установлено (может быть 'connecting' или 'checking')
    // Треки могут появиться до установки соединения
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
    
    // КРИТИЧНО: Проверяем даже если remoteStreamRef уже установлен, но может быть неправильным
    // Если remoteStreamRef есть, но у него нет активных треков, пересоздаем
    if (this.remoteStreamRef) {
      const existingVideoTracks = (this.remoteStreamRef as any)?.getVideoTracks?.() || [];
      const existingAudioTracks = (this.remoteStreamRef as any)?.getAudioTracks?.() || [];
      const hasActiveVideoTracks = existingVideoTracks.some((t: any) => t && t.readyState !== 'ended');
      const hasActiveAudioTracks = existingAudioTracks.some((t: any) => t && t.readyState !== 'ended');
      
      // Если есть активные треки (видео или аудио), не пересоздаем
      if (hasActiveVideoTracks || hasActiveAudioTracks) {
        return;
      } else {
      }
    }
    
    try {
      // Некоторые реализации WebRTC (или старые версии react-native-webrtc)
      // могут не иметь метода getReceivers. В этом случае просто выходим,
      // чтобы не получать TypeError: undefined is not a function.
      const getReceiversFn = (pc as any).getReceivers;
      if (typeof getReceiversFn !== 'function') {
        console.warn('[WebRTCSession] getReceivers is not available on RTCPeerConnection - skipping receiver-based remote stream creation');
        return;
      }
      const receivers: Array<RTCRtpReceiver | any> = getReceiversFn.call(pc);
      
      if (receivers.length === 0) {
        return;
      }
      
      // Создаем MediaStream из receivers
      const tracks: any[] = [];
      receivers.forEach((receiver: any) => {
        const track = receiver.track;
        if (track && track.readyState !== 'ended') {
          tracks.push(track);
        }
      });
      
      if (tracks.length === 0) {
        return;
      }
      
      // Создаем новый MediaStream из треков
      const stream = new MediaStream(tracks);
      
      if (!isValidStream(stream)) {
        console.warn('[WebRTCSession] Stream created from receivers is invalid');
        return;
      }
      
      
      // КРИТИЧНО: Предотвращаем множественные emit для одного и того же stream
      const existingStream = this.remoteStreamRef;
      const isSameStream = existingStream === stream || (existingStream && existingStream.id === stream.id);
      const streamChanged = !isSameStream;
      
      // Устанавливаем remoteStream
      this.remoteStreamRef = stream;
      
      // Обновляем только при реальном изменении stream
      if (streamChanged) {
        // КРИТИЧНО: Сохраняем время установки remoteStream для проверки возраста трека
        this.remoteStreamEstablishedAtRef = Date.now();
        this.remoteForcedOffRef = false;
        
        // КРИТИЧНО: Очищаем таймаут для ended стримов, так как валидный стрим пришел
        if (this.endedStreamTimeoutRef) {
          clearTimeout(this.endedStreamTimeoutRef);
          this.endedStreamTimeoutRef = null;
        }
        this.endedStreamIgnoredAtRef = 0;
        this.remoteViewKeyRef = Date.now();
        
        // Эмитим события только при изменении stream
        this.emit('remoteStream', stream);
        this.config.callbacks.onRemoteStreamChange?.(stream);
        this.config.onRemoteStreamChange?.(stream);
        this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
        
        // КРИТИЧНО: Применяем отложенное состояние cam-toggle, если оно было сохранено
        this.applyPendingCamToggle();
        
        // Проверяем состояние трека
        this.checkRemoteVideoTrack();
        this.startTrackChecker();
        this.emitRemoteState();
      } else {
        // Stream не изменился - только проверяем состояние трека без emit
        this.checkRemoteVideoTrack();
      }
    } catch (error) {
      console.error('[WebRTCSession] Error checking receivers for remote stream:', error);
    }
  }
  
  private setConnected(connected: boolean): void {
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
      
      // Устанавливаем время установки соединения для защиты от ранних cam-toggle событий
      this.connectionEstablishedAtRef = Date.now();
      
      // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен после установки соединения
      // Это важно для ВСЕХ типов звонков (рандомный чат и дружеские звонки)
      const pc = this.peerRef;
      if (pc && this.partnerIdRef) {
        const hasOntrack = !!(pc as any)?.ontrack;
        const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                             (this.config.getInDirectCall?.() ?? false) || 
                             (this.config.getFriendCallAccepted?.() ?? false);
        
        // Для всех типов звонков проверяем и переустанавливаем ontrack если нужно
        if (!hasOntrack) {
          if (isFriendCall) {
            console.log('[WebRTCSession] [FRIEND CALL] ontrack handler missing after connection established, reattaching');
          } else {
            console.warn('[WebRTCSession] ontrack handler missing after connection established, reattaching');
          }
          const partnerId = this.partnerIdRef;
          if (partnerId) {
            this.attachRemoteHandlers(pc, partnerId);
            // Проверяем еще раз после переустановки
            const hasOntrackAfterReattach = !!(pc as any)?.ontrack;
            if (!hasOntrackAfterReattach) {
              if (isFriendCall) {
                console.log('[WebRTCSession] [FRIEND CALL] ❌❌❌ CRITICAL: Failed to attach ontrack handler after connection established!');
              } else {
                console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler after connection established!');
              }
            }
          }
        }
        
        // КРИТИЧНО: Fallback - проверяем receivers напрямую, если ontrack не сработал
        // Это важно для ВСЕХ типов звонков (рандомный чат и дружеские звонки)
        // Событие ontrack может не сработать по разным причинам
        if (!this.remoteStreamRef) {
          const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                               (this.config.getInDirectCall?.() ?? false) || 
                               (this.config.getFriendCallAccepted?.() ?? false);
          
          // Для дружеских звонков проверяем чаще и раньше
          const delays = isFriendCall ? [500, 1000, 2000] : [1000, 2000, 3000];
          
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
  
  private handleConnectionFailure(pc: RTCPeerConnection): void {
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
  
  private scheduleReconnection(pc: RTCPeerConnection, toId: string): void {
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
    
    // Запускаем ICE restart
    this.tryIceRestart(pc, toId);
  }
  
  private startConnectionCheckInterval(pc: RTCPeerConnection): void {
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
        
        // КРИТИЧНО: Если соединение установлено, но remoteStream отсутствует, проверяем receivers
        const isRandomChat = 
          !(this.config.getIsDirectCall?.() ?? false) &&
          !(this.config.getInDirectCall?.() ?? false) &&
          !(this.config.getFriendCallAccepted?.() ?? false);
        
        if (isConnected && isRandomChat && this.partnerIdRef && !this.remoteStreamRef) {
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
  
  private clearReconnectTimer(): void {
    if (this.reconnectTimerRef) {
      clearTimeout(this.reconnectTimerRef);
      this.reconnectTimerRef = null;
    }
  }
  
  private clearConnectionTimers(): void {
    this.clearReconnectTimer();
    if (this.connectionCheckIntervalRef) {
      clearInterval(this.connectionCheckIntervalRef);
      this.connectionCheckIntervalRef = null;
    }
  }
  
  private async tryIceRestart(pc: RTCPeerConnection, toId: string): Promise<void> {
    try {
      if (!pc) return;
      
      if (this.iceRestartInProgressRef) return;
      
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
      
      const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
      const isInactiveState = this.config.getIsInactiveState?.() ?? false;
      if (isInactiveState || !hasActiveCall) return;
      
      // КРИТИЧНО: Проверяем pcToken и что PC не закрыт
      if (!this.isPcValid(pc)) {
        console.warn('[WebRTCSession] Cannot try ICE restart - PC is closed or token invalid', {
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken,
          signalingState: pc.signalingState
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем состояние PC - должно быть 'stable' для ICE restart
      if (pc.signalingState !== 'stable') {
        console.warn('[WebRTCSession] Cannot try ICE restart - PC not in stable state', {
          signalingState: pc.signalingState,
          expectedState: 'stable'
        });
        // При ошибке "have-remote-offer" прекращаем попытки для этого PC
        if (pc.signalingState === 'have-remote-offer') {
          console.warn('[WebRTCSession] PC in have-remote-offer state, stopping ICE restart attempts for this PC');
          return;
        }
        return;
      }
      
      const now = Date.now();
      if (this.restartCooldownRef > now) {
        // Планируем повторную попытку после cooldown
        this.scheduleReconnection(pc, toId);
        return;
      }
      
      this.restartCooldownRef = now + 10000;
      this.iceRestartInProgressRef = true;
      
      if (!this.peerRef || this.peerRef !== pc) {
        this.iceRestartInProgressRef = false;
        return;
      }
      
      // КРИТИЧНО: Проверяем еще раз перед createOffer
      if (!this.isPcValid(pc) || pc.signalingState !== 'stable') {
        console.warn('[WebRTCSession] PC state changed before ICE restart offer creation', {
          signalingState: pc.signalingState,
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken
        });
        this.iceRestartInProgressRef = false;
        return;
      }
      
      // КРИТИЧНО: При ICE restart также нужно указать offerToReceiveAudio и offerToReceiveVideo
      // Иначе может получиться sendonly вместо sendrecv
      // Оптимизация: используем voiceActivityDetection: false для уменьшения задержки
      const offer = await pc.createOffer({ 
        iceRestart: true,
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        voiceActivityDetection: false, // Отключаем VAD для уменьшения задержки
      } as any);
      
      // КРИТИЧНО: Проверяем SDP на наличие sendrecv
      if (offer.sdp) {
        const hasSendRecv = offer.sdp.includes('a=sendrecv');
        const hasSendOnly = offer.sdp.includes('a=sendonly');
        if (hasSendOnly && !hasSendRecv) {
          console.warn('[WebRTCSession] ⚠️ WARNING: Offer has sendonly instead of sendrecv!');
        }
        
        // Оптимизация SDP для быстрого установления соединения
        // Устанавливаем приоритет VP8/VP9 для лучшей совместимости и скорости
        offer.sdp = this.optimizeSdpForFastConnection(offer.sdp);
      }
      
      await pc.setLocalDescription(offer);
      const offerPayload: any = { to: toId, offer };
      // КРИТИЧНО: Для дружеских звонков добавляем roomId
      const isFriendCall = 
        (this.config.getIsDirectCall?.() ?? false) ||
        (this.config.getInDirectCall?.() ?? false) ||
        (this.config.getFriendCallAccepted?.() ?? false);
      if (isFriendCall && this.roomIdRef) {
        offerPayload.roomId = this.roomIdRef;
      }
      socket.emit('offer', offerPayload);
      this.emit('ice-restart');
      this.emit('reconnecting');
      
      // Автоматически сбрасываем флаг через 5 секунд
      setTimeout(() => {
        this.iceRestartInProgressRef = false;
        
        // Проверяем состояние подключения после ICE restart
        // Если все еще не подключено, планируем следующую попытку
        if (!this.isConnectedRef && this.peerRef === pc) {
          const st = (pc as any).connectionState || pc.iceConnectionState;
          if (st === 'failed' || st === 'disconnected') {
            this.scheduleReconnection(pc, toId);
          }
        }
      }, 5000);
    } catch (err: any) {
      logger.error('[WebRTCSession] tryIceRestart error:', err);
      this.iceRestartInProgressRef = false;
      
      // КРИТИЧНО: При ошибке "have-remote-offer" прекращаем попытки для этого PC
      const errorMsg = String(err?.message || '');
      if (errorMsg.includes('have-remote-offer') || (pc && pc.signalingState === 'have-remote-offer')) {
        console.warn('[WebRTCSession] PC in have-remote-offer state during ICE restart, stopping attempts for this PC');
        return;
      }
      
      // При другой ошибке планируем повторную попытку только если PC все еще актуален
      if (this.peerRef === pc && this.isPcValid(pc)) {
        this.scheduleReconnection(pc, toId);
      }
    }
  }
  
  // ==================== Remote Stream Handlers ====================
  
  private attachRemoteHandlers(pc: RTCPeerConnection, setToId?: string): void {
    
    // КРИТИЧНО: Проверяем не только флаг, но и наличие самого обработчика
    // Если обработчик был сброшен, но флаг остался, нужно переустановить
    const hasHandler = !!(pc as any)?.ontrack;
    const hasFlag = (pc as any)?._remoteHandlersAttached === true;
    
    if (hasFlag && hasHandler) {
      return;
    }
    
    // Если флаг установлен, но обработчика нет - сбрасываем флаг и переустанавливаем
    if (hasFlag && !hasHandler) {
      console.warn('[WebRTCSession] ⚠️ Flag is set but handler is missing, reattaching handlers');
      (pc as any)._remoteHandlersAttached = false;
    }
    
    const handleRemote = (e: any) => {
      
      try {
        // КРИТИЧНО: Проверяем, что PC не закрыт и токен актуален
        // Ранний return для предотвращения обработки отложенных событий после Next/cleanup
        if (!this.isPcValid(pc)) {
          return;
        }
        
        // КРИТИЧНО: Получаем стрим из события ontrack
        const stream = e?.streams?.[0] ?? e?.stream;
        
        if (!stream) {
          console.warn('[WebRTCSession] No stream in ontrack', {
            hasStreams: !!e?.streams,
            streamsLength: e?.streams?.length,
            hasStream: !!e?.stream
          });
          return;
        }
        
        // Проверка валидности стрима
        if (!isValidStream(stream)) {
          console.warn('[WebRTCSession] Invalid stream in ontrack', {
            streamId: stream?.id,
            streamValid: false
          });
          return;
        }
        
        const rs = stream;
        
        // Проверка на локальный stream (только для iOS, для рандомного чата)
        if (Platform.OS !== 'android') {
          try {
            const isDirectFriendCall = 
              (this.config.getIsDirectCall?.() ?? false) ||
              (this.config.getInDirectCall?.() ?? false) ||
              (this.config.getFriendCallAccepted?.() ?? false);
            
            if (this.localStreamRef && (rs as any)?.id === (this.localStreamRef as any)?.id) {
              const localVideoTrack = this.localStreamRef?.getVideoTracks?.()?.[0];
              const remoteVideoTrack = rs?.getVideoTracks?.()?.[0];
              const isSameTrack = localVideoTrack && remoteVideoTrack && localVideoTrack.id === remoteVideoTrack.id;
              
              if (isSameTrack && !isDirectFriendCall) {
                return;
              }
            }
          } catch (e) {
            console.warn('[WebRTCSession] Error checking local stream:', e);
          }
        }
        
        // КРИТИЧНО: Упрощенная логика - устанавливаем стрим ВСЕГДА, если он валиден
        // НЕ игнорируем обновления стрима - всегда обновляем, даже если трек ещё не пришёл
        // Видео-трек может появиться позже, поэтому всегда обновляем remoteStream
        const existingRemoteStream = this.remoteStreamRef;
        
        // Останавливаем старый стрим, если он реально другой
        // Важный фикс: ontrack может вызываться несколько раз с ОДНИМ и тем же MediaStream.
        // В этом случае existingRemoteStream === rs, и остановка треков приведёт к их смерти
        // сразу после прихода (видео/аудио исчезают). Поэтому гасим только другой объект.
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
        
        // КРИТИЧНО: Проверяем состояние треков перед установкой remoteStream
        const videoTrack = (rs as any)?.getVideoTracks?.()?.[0];
        const audioTrack = (rs as any)?.getAudioTracks?.()?.[0];
        
        console.log('🔥🔥🔥 [ontrack] ПОЛУЧЕН REMOTE STREAM', {
          streamId: stream?.id,
          hasVideoTrack: !!videoTrack,
          hasAudioTrack: !!audioTrack,
          videoTrackReadyState: videoTrack?.readyState,
          videoTrackEnabled: videoTrack?.enabled,
          audioTrackReadyState: audioTrack?.readyState,
          audioTrackEnabled: audioTrack?.enabled,
          currentRemoteStreamId: this.remoteStreamRef?.id,
          partnerId: this.partnerIdRef,
          roomId: this.roomIdRef,
          callId: this.callIdRef
        });
        
        // КРИТИЧНО: Предотвращаем множественные emit для одного и того же stream
        // Это устраняет мелькания видеопотока
        const existingStream = this.remoteStreamRef;
        const isSameStream = existingStream === rs || (existingStream && existingStream.id === rs.id);
        const streamChanged = !isSameStream;
        
        // КРИТИЧНО: Если это НОВЫЙ стрим и видео-трек приходит с readyState=ended,
        // это означает, что трек уже завершен (скорее всего из-за быстрого переключения).
        // НЕ устанавливаем такой стрим - ждем следующего трека от нового соединения.
        // Если это тот же стрим, но трек стал ended - это нормально (камера выключена).
        if (streamChanged && videoTrack && videoTrack.readyState === 'ended') {
          console.warn('[WebRTCSession] Remote video track arrived with readyState=ended in new stream (likely due to fast switching). Ignoring this stream and waiting for next track.', {
            trackId: videoTrack.id,
            enabled: videoTrack.enabled,
            streamId: rs.id
          });
          
          // КРИТИЧНО: Устанавливаем таймаут - если валидный стрим не придет в течение 500ms,
          // явно устанавливаем remoteCamOnRef = false для показа заглушки
          this.endedStreamIgnoredAtRef = Date.now();
          
          // Очищаем предыдущий таймаут если есть
          if (this.endedStreamTimeoutRef) {
            clearTimeout(this.endedStreamTimeoutRef);
            this.endedStreamTimeoutRef = null;
          }
          
          // Устанавливаем новый таймаут
          this.endedStreamTimeoutRef = setTimeout(() => {
            // Проверяем, что валидный стрим все еще не пришел
            const currentStream = this.remoteStreamRef;
            const currentPc = this.peerRef;
            const timeSinceIgnore = Date.now() - this.endedStreamIgnoredAtRef;
            
            // Если прошло более 500ms и стрим все еще не установлен, устанавливаем remoteCamOnRef = false
            if (timeSinceIgnore >= 500 && (!currentStream || currentStream.id !== rs.id)) {
              if (this.remoteCamOnRef !== false) {
                this.remoteCamOnRef = false;
                this.config.callbacks.onRemoteCamStateChange?.(false);
                this.config.onRemoteCamStateChange?.(false);
                this.emitRemoteState();
              }
            }
            
            this.endedStreamTimeoutRef = null;
          }, 500);
          
          return;
        }
        
        // Если это новый стрим и есть только аудио-трек с ended (без видео) - тоже игнорируем
        if (streamChanged && audioTrack && audioTrack.readyState === 'ended' && !videoTrack) {
          console.warn('[WebRTCSession] Remote audio track arrived with readyState=ended in new stream (no video track). Ignoring this stream and waiting for next track.');
          
          // КРИТИЧНО: Устанавливаем таймаут - если валидный стрим не придет в течение 500ms,
          // явно устанавливаем remoteCamOnRef = false для показа заглушки
          this.endedStreamIgnoredAtRef = Date.now();
          
          // Очищаем предыдущий таймаут если есть
          if (this.endedStreamTimeoutRef) {
            clearTimeout(this.endedStreamTimeoutRef);
            this.endedStreamTimeoutRef = null;
          }
          
          // Устанавливаем новый таймаут
          this.endedStreamTimeoutRef = setTimeout(() => {
            // Проверяем, что валидный стрим все еще не пришел
            const currentStream = this.remoteStreamRef;
            const timeSinceIgnore = Date.now() - this.endedStreamIgnoredAtRef;
            
            // Если прошло более 500ms и стрим все еще не установлен, устанавливаем remoteCamOnRef = false
            if (timeSinceIgnore >= 500 && !currentStream) {
              if (this.remoteCamOnRef !== false) {
                this.remoteCamOnRef = false;
                this.config.callbacks.onRemoteCamStateChange?.(false);
                this.config.onRemoteCamStateChange?.(false);
                this.emitRemoteState();
              }
            }
            
            this.endedStreamTimeoutRef = null;
          }, 500);
          
          return;
        }
        
        // КРИТИЧНО: Если нет видео-трека, трек ended или трек disabled, ставим remoteCamOn=false
        // UI на основе remoteCamOn покажет заглушку, а не RTCView на "мертвый" или выключенный трек
        // Это гарантирует, что при переходе к следующему собеседнику сразу показывается заглушка,
        // если у него камера выключена, без промежуточного черного фона
        const hasLiveVideoTrack = videoTrack && videoTrack.readyState === 'live';
        const isVideoTrackEnabled = videoTrack && videoTrack.enabled === true;
        const shouldShowVideo = hasLiveVideoTrack && isVideoTrackEnabled;
        
        // КРИТИЧНО: Если трек live, но enabled=false, это может быть временное состояние при инициализации
        // Подождем немного перед установкой remoteCamOnRef = false, чтобы дать треку время инициализироваться
        const isLiveButDisabled = hasLiveVideoTrack && !isVideoTrackEnabled;
        
        // КРИТИЧНО: Для дружеских звонков устанавливаем remoteCamOn=true по умолчанию
        // если есть живой видео-трек, даже если enabled еще не установлен
        // Это гарантирует, что видео показывается сразу при подключении
        const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                            (this.config.getInDirectCall?.() ?? false) || 
                            (this.config.getFriendCallAccepted?.() ?? false);
        
        console.log('🔥 [ontrack] ПРОВЕРКА УСЛОВИЙ ОТОБРАЖЕНИЯ ВИДЕО', {
          shouldShowVideo,
          isFriendCall,
          hasLiveVideoTrack,
          isVideoTrackEnabled,
          streamChanged,
          currentRemoteCamOn: this.remoteCamOnRef
        });
        
        if (shouldShowVideo) {
          // Есть живой и включенный видео-трек - устанавливаем remoteCamOn=true сразу
          // Это гарантирует, что видео показывается сразу при подключении
          if (this.remoteCamOnRef !== true) {
            console.log('🔥✅ [ontrack] УСТАНАВЛИВАЕМ remoteCamOn=true (shouldShowVideo)', {
              videoTrackReadyState: videoTrack?.readyState,
              videoTrackEnabled: videoTrack?.enabled
            });
            this.remoteCamOnRef = true;
            this.config.callbacks.onRemoteCamStateChange?.(true);
            this.config.onRemoteCamStateChange?.(true);
            this.emitRemoteState();
          }
        } else if (isFriendCall && hasLiveVideoTrack) {
          // КРИТИЧНО: Для дружеских звонков если трек live, устанавливаем remoteCamOn=true
          // даже если enabled еще не установлен (может быть временное состояние)
          // Убираем проверку streamChanged - устанавливаем remoteCamOn для любого live трека
          if (this.remoteCamOnRef !== true) {
            console.log('🔥✅ [ontrack] УСТАНАВЛИВАЕМ remoteCamOn=true (friend call + live track)', {
              videoTrackReadyState: videoTrack?.readyState,
              videoTrackEnabled: videoTrack?.enabled,
              streamChanged
            });
            this.remoteCamOnRef = true;
            this.config.callbacks.onRemoteCamStateChange?.(true);
            this.config.onRemoteCamStateChange?.(true);
            this.emitRemoteState();
          }
        } else if (isLiveButDisabled && streamChanged) {
          // Трек live, но enabled=false - это может быть временное состояние при инициализации
          // Подождем 100ms и проверим еще раз перед установкой remoteCamOnRef = false
          setTimeout(() => {
            // Проверяем, что это все еще тот же стрим и PC не закрыт
            const currentStream = this.remoteStreamRef;
            const currentPc = this.peerRef;
            if (currentStream === rs && currentPc && currentPc.signalingState !== 'closed') {
              const currentVideoTrack = (rs as any)?.getVideoTracks?.()?.[0];
              const isStillLive = currentVideoTrack && currentVideoTrack.readyState === 'live';
              const isStillDisabled = currentVideoTrack && currentVideoTrack.enabled === false;
              
              // Если трек все еще live и disabled - это реальное выключение камеры
              // Если трек стал enabled - камера включилась, устанавливаем remoteCamOnRef = true
              if (isStillLive && isStillDisabled) {
                if (this.remoteCamOnRef !== false) {
                  this.remoteCamOnRef = false;
                  this.config.callbacks.onRemoteCamStateChange?.(false);
                  this.config.onRemoteCamStateChange?.(false);
                  this.emitRemoteState();
                }
              } else if (isStillLive && currentVideoTrack.enabled === true) {
                // Трек стал enabled - камера включилась
                if (this.remoteCamOnRef !== true) {
                  this.remoteCamOnRef = true;
                  this.config.callbacks.onRemoteCamStateChange?.(true);
                  this.config.onRemoteCamStateChange?.(true);
                  this.emitRemoteState();
                }
              }
            }
          }, 100);
        } else {
          // Нет видео-трека или трек ended - устанавливаем remoteCamOn=false сразу
          // Всё равно устанавливаем stream - UI на основе remoteCamOn покажет заглушку
          if (this.remoteCamOnRef !== false) {
            this.remoteCamOnRef = false;
            this.config.callbacks.onRemoteCamStateChange?.(false);
            this.config.onRemoteCamStateChange?.(false);
            this.emitRemoteState();
          }
        }
        
        // Устанавливаем remoteStream
        this.remoteStreamRef = rs;
        
        console.log('🔥✅✅✅ [ontrack] REMOTE STREAM УСТАНОВЛЕН', {
          streamId: rs?.id,
          streamChanged,
          hasVideoTrack: !!videoTrack,
          videoTrackReadyState: videoTrack?.readyState,
          videoTrackEnabled: videoTrack?.enabled,
          remoteCamOn: this.remoteCamOnRef,
          partnerId: this.partnerIdRef,
          roomId: this.roomIdRef
        });
        
        // КРИТИЧНО: Сохраняем время установки remoteStream для проверки возраста трека
        if (streamChanged) {
          this.remoteStreamEstablishedAtRef = Date.now();
          this.remoteForcedOffRef = false;
          
          // КРИТИЧНО: Очищаем таймаут для ended стримов, так как валидный стрим пришел
          if (this.endedStreamTimeoutRef) {
            clearTimeout(this.endedStreamTimeoutRef);
            this.endedStreamTimeoutRef = null;
          }
          this.endedStreamIgnoredAtRef = 0;
        }
        
        // Устанавливаем время установки соединения для защиты от ранних cam-toggle событий
        if (!this.connectionEstablishedAtRef) {
          this.connectionEstablishedAtRef = Date.now();
        }
        
        // КРИТИЧНО: Применяем отложенное состояние cam-toggle, если оно было сохранено
        // Это решает проблему, когда cam-toggle приходит до установки remoteStream
        if (streamChanged) {
          this.applyPendingCamToggle();
        }
        
        // КРИТИЧНО: Обновляем remoteViewKey ТОЛЬКО при реальном изменении stream
        // Это предотвращает мелькания видеопотока
        if (streamChanged) {
          this.remoteViewKeyRef = Date.now();
          
          console.log('🔥✅ [ontrack] ЭМИТИМ remoteStream СОБЫТИЕ', {
            streamId: rs?.id,
            remoteViewKey: this.remoteViewKeyRef
          });
          
          // КРИТИЧНО: ВАЖНО - триггер UI через emit только при изменении stream
          this.emit('remoteStream', rs);
          
          // Также вызываем callbacks
          this.config.callbacks.onRemoteStreamChange?.(rs);
          this.config.onRemoteStreamChange?.(rs);
          
          // Эмитим изменение viewKey
          this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
          
          console.log('🔥✅ [ontrack] remoteStream СОБЫТИЕ ОТПРАВЛЕНО В UI');
        }
        
        // Проверяем состояние трека и обновляем remoteCamOn
        // Это делаем всегда, но без лишних emit
        this.checkRemoteVideoTrack();
        
        // КРИТИЧНО: Для нового стрима добавляем дополнительную проверку через задержку
        // Это дает треку время полностью инициализироваться перед финальной проверкой состояния
        if (streamChanged) {
          // Проверяем еще раз через 50ms для быстрой реакции
          setTimeout(() => {
            const currentStream = this.remoteStreamRef;
            const currentPc = this.peerRef;
            // Проверяем, что это все еще тот же стрим и PC не закрыт
            if (currentStream === rs && currentPc && currentPc.signalingState !== 'closed') {
              const currentVideoTrack = (rs as any)?.getVideoTracks?.()?.[0];
              if (currentVideoTrack) {
                const isLive = currentVideoTrack.readyState === 'live';
                const isEnabled = currentVideoTrack.enabled === true;
                
                // Если трек стал live и enabled - устанавливаем remoteCamOnRef = true
                if (isLive && isEnabled && this.remoteCamOnRef !== true) {
                  this.remoteCamOnRef = true;
                  this.config.callbacks.onRemoteCamStateChange?.(true);
                  this.config.onRemoteCamStateChange?.(true);
                  this.emitRemoteState();
                }
              }
            }
          }, 50);
          
          // Запускаем периодическую проверку состояния трека
          this.startTrackChecker();
          this.emitRemoteState();
        }
      } catch (error) {
        logger.error('[WebRTCSession] Error in handleRemote:', error);
      }
    };
    
    // КРИТИЧНО: Устанавливаем обработчик ontrack - БЕЗ ЭТОГО вы НИКОГДА не увидите собеседника
    // Это обязательный обработчик для получения удаленных треков (видео/аудио)
    // Устанавливаем обработчик синхронно и проверяем сразу
    (pc as any).ontrack = handleRemote;
    (pc as any)._remoteHandlersAttached = true;
    (pc as any)._ontrackHandler = handleRemote; // Сохраняем ссылку для проверки
    
    // КРИТИЧНО: Проверяем что обработчик действительно установлен СРАЗУ после присваивания
    let verifyOntrack = !!(pc as any)?.ontrack;
    if (!verifyOntrack) {
      console.error('[WebRTCSession] ❌❌❌ CRITICAL ERROR: ontrack handler was NOT set after assignment! Retrying...', {
        pcExists: !!pc,
        setToId,
        handlerType: typeof (pc as any)?.ontrack
      });
      // Пытаемся установить еще раз
      (pc as any).ontrack = handleRemote;
      verifyOntrack = !!(pc as any)?.ontrack;
      if (!verifyOntrack) {
        console.error('[WebRTCSession] ❌❌❌ CRITICAL ERROR: Failed to set ontrack handler even after retry!', {
          pcExists: !!pc,
          setToId
        });
      }
    }
    
    // КРИТИЧНО: Проверяем, что обработчик действительно установлен через небольшую задержку
    // Иногда обработчик может быть потерян из-за внутренних операций WebRTC или race condition
    // Используем несколько проверок с разными задержками для максимальной надежности
    setTimeout(() => {
      const currentPc = this.peerRef;
      if (currentPc === pc) {
        const hasOntrack = !!(currentPc as any)?.ontrack;
        if (!hasOntrack) {
          const partnerId = this.partnerIdRef || setToId;
          if (partnerId) {
            console.warn('[WebRTCSession] ontrack handler was lost after attachment (50ms check), reattaching', {
              partnerId,
              setToId
            });
            this.attachRemoteHandlers(currentPc, partnerId);
          }
        }
      }
    }, 50);
    
    // Дополнительная проверка через 200ms для защиты от более поздних race conditions
    setTimeout(() => {
      const currentPc = this.peerRef;
      if (currentPc === pc) {
        const hasOntrack = !!(currentPc as any)?.ontrack;
        if (!hasOntrack) {
          const partnerId = this.partnerIdRef || setToId;
          if (partnerId) {
            console.warn('[WebRTCSession] ontrack handler was lost after attachment (200ms check), reattaching', {
              partnerId,
              setToId
            });
            this.attachRemoteHandlers(currentPc, partnerId);
          }
        }
      }
    }, 200);
  }
  
  // ==================== Remote Camera State Management ====================
  
  private canAutoShowRemote(): boolean {
    if (this.remoteForcedOffRef) return false;
    const isDirectFriendCall = 
      (this.config.getIsDirectCall?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getFriendCallAccepted?.() ?? false);
    if (isDirectFriendCall && this.camToggleSeenRef) return false;
    return true;
  }
  
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
      
      const isDirectFriendCall = 
        (this.config.getIsDirectCall?.() ?? false) ||
        (this.config.getInDirectCall?.() ?? false) ||
        (this.config.getFriendCallAccepted?.() ?? false);
      
      // Обновляем состояние на основе фактического состояния трека
      // КРИТИЧНО: Устанавливаем remoteCamOn=true если трек существует и не завершен,
      // даже если enabled=false (может быть false при установке соединения)
      // Это работает и для рандомного чата, и для прямых звонков
      const isTrackActive = videoTrack.readyState !== 'ended';
      
      if (isTrackActive) {
        // КРИТИЧНО: Проверяем реальное состояние трека (enabled)
        // Если трек активен, но enabled=false, это означает что камера выключена
        // Если enabled=true, камера включена
        const isCameraEnabled = videoTrack.enabled === true;
        
        // КРИТИЧНО: НЕ перезаписываем remoteCamOn если он был установлен через cam-toggle (remoteForcedOffRef)
        // Это гарантирует, что заглушка "Отошел" показывается при выключении камеры
        if (this.remoteForcedOffRef) {
          // Камера была выключена через cam-toggle - не перезаписываем
          return;
        }
        
        // КРИТИЧНО: Для дружеских звонков устанавливаем remoteCamOn=true если трек live
        // независимо от enabled (enabled может быть false временно при инициализации)
        // Для рандомного чата используем реальное состояние enabled
        const now = Date.now();
        const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
        const isNewTrack = streamAge < 250; // Трек появился менее 250ms назад
        
        let shouldBeEnabled: boolean;
        
        if (isDirectFriendCall) {
          // КРИТИЧНО: Для дружеских звонков показываем видео если трек live
          // enabled может быть false временно при инициализации, но если трек live - показываем видео
          // КРИТИЧНО: Для дружеских звонков приоритет - readyState === 'live'
          // Если трек live, показываем видео независимо от enabled (enabled может быть false временно)
          // Только если трек явно ended или не live - не показываем
          if (videoTrack.readyState === 'live') {
            // Трек live - показываем видео независимо от enabled для дружеских звонков
            // enabled может быть false временно при инициализации, но трек уже live
            shouldBeEnabled = true;
          } else {
            // Трек не live - не показываем
            shouldBeEnabled = false;
          }
        } else {
          // Для рандомного чата используем реальное состояние enabled
          // КРИТИЧНО: Игнорируем enabled=false если трек только что появился (менее 250ms с момента установки remoteStream)
          // Это предотвращает ложное отображение заглушки при быстром переключении
          shouldBeEnabled = isCameraEnabled;
          
          // Если трек новый и disabled, но live - не устанавливаем false сразу
          // Это может быть временное состояние при инициализации
          if (!isCameraEnabled && isNewTrack && videoTrack.readyState === 'live') {
            // Игнорируем enabled=false для новых треков - не обновляем состояние
            return;
          }
        }
        
        // КРИТИЧНО: Проверяем возраст трека перед установкой remoteCamOnRef = false
        // Если трек достаточно старый (более 250ms) и disabled - это реальное выключение камеры
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
      logger.error('[WebRTCSession] Error checking remote video track:', e);
    }
  }
  
  private startTrackChecker(): void {
    // Останавливаем предыдущий интервал если есть
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
    
    // Проверяем сразу
    this.checkRemoteVideoTrack();
    
    // Проверяем каждые 150ms для быстрого переключения и случаев плохого интернета
    // Уменьшено с 500ms для более быстрой реакции на изменения состояния трека
    this.trackCheckIntervalRef = setInterval(() => {
      this.checkRemoteVideoTrack();
    }, 150);
  }
  
  private stopTrackChecker(): void {
    if (this.trackCheckIntervalRef) {
      clearInterval(this.trackCheckIntervalRef);
      this.trackCheckIntervalRef = null;
    }
  }
  
  // ==================== SDP Optimization ====================
  
  /**
   * Оптимизирует SDP для быстрого установления соединения
   * - Устанавливает приоритет VP8/VP9 для лучшей совместимости
   * - Оптимизирует битрейт для уменьшения задержек
   * - Устанавливает оптимальные настройки для мобильных устройств
   */
  private optimizeSdpForFastConnection(sdp: string): string {
    if (!sdp) return sdp;
    
    // Простая оптимизация SDP - возвращаем как есть, так как WebRTC сам оптимизирует
    // В будущем можно добавить более сложную логику оптимизации
    return sdp;
  }
  
  // ==================== Mic Meter Management ====================
  
  private isMicReallyOn(): boolean {
    const stream = this.localStreamRef;
    const a = stream?.getAudioTracks?.()?.[0];
    return !!(a && a.enabled && a.readyState === 'live');
  }
  
  startMicMeter(): void {
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
            // Нормализуем для iOS
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
                const inst = Math.sqrt(Math.max(0, dE / dD)); // нормализация
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
  
  stopMicMeter(): void {
    if (this.micStatsTimerRef) {
      clearInterval(this.micStatsTimerRef);
      this.micStatsTimerRef = null;
    }
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
    this.emit('micLevelChanged', 0);
    this.energyRef = null;
    this.durRef = null;
    this.lowLevelCountRef = 0;
  }
  
  private isPcConnected(): boolean {
    const pc = this.peerRef;
    if (!pc) return false;
    const st = (pc as any).connectionState || pc.iceConnectionState;
    return st === 'connected' || st === 'completed';
  }
  
  // ==================== ICE Candidate Queue ====================
  
  /**
   * Отправляет кешированные исходящие ICE кандидаты после установки partnerId
   */
  private flushOutgoingIceCache(): void {
    if (this.outgoingIceCache.length === 0 || !this.partnerIdRef) {
      return;
    }
    
    // КРИТИЧНО: Проверяем, что PC актуален перед отправкой кешированных кандидатов
    // Если pcToken сменился, кеш уже очищен в incrementPcToken, но проверяем на всякий случай
    const pc = this.peerRef;
    if (pc && !this.isPcValid(pc)) {
      console.warn('[WebRTCSession] Cannot flush outgoing ICE cache - PC is closed or token invalid', {
        pcToken: (pc as any)?._pcToken,
        currentToken: this.pcToken
      });
      // Очищаем кеш, так как PC больше не актуален
      this.outgoingIceCache = [];
      return;
    }
    
    const toId = this.partnerIdRef;
    const cachedCount = this.outgoingIceCache.length;
    
    console.log('[WebRTCSession] Flushing cached outgoing ICE candidates', {
      toId,
      cachedCount
    });
    
    // Отправляем все кешированные кандидаты
    for (const candidate of this.outgoingIceCache) {
      try {
        const payload: any = { to: toId, candidate };
        // КРИТИЧНО: Для дружеских звонков добавляем roomId
        const isFriendCall = 
          (this.config.getIsDirectCall?.() ?? false) ||
          (this.config.getInDirectCall?.() ?? false) ||
          (this.config.getFriendCallAccepted?.() ?? false);
        if (isFriendCall && this.roomIdRef) {
          payload.roomId = this.roomIdRef;
        }
        socket.emit('ice-candidate', payload);
      } catch (e) {
        console.warn('[WebRTCSession] Error sending cached ICE candidate:', e);
      }
    }
    
    // Очищаем кеш после отправки
    this.outgoingIceCache = [];
    console.log('[WebRTCSession] Outgoing ICE cache flushed and cleared', { sentCount: cachedCount });
  }
  
  private enqueueIce(from: string, candidate: any): void {
    const key = String(from || '');
    if (!this.pendingIceByFromRef[key]) {
      this.pendingIceByFromRef[key] = [];
    }
    this.pendingIceByFromRef[key].push(candidate);
  }
  
  private async flushIceFor(from: string): Promise<void> {
    const key = String(from || '');
    const list = this.pendingIceByFromRef[key] || [];
    const pc = this.peerRef;
    
    if (!pc || !list.length) {
      if (list.length > 0) {
        console.warn('[WebRTCSession] ⚠️ Cannot flush ICE candidates - no PC', { from, count: list.length });
      }
      return;
    }
    
    // КРИТИЧНО: Проверяем, что PC не закрыт и токен актуален
    // Ранний return для предотвращения обработки отложенных кандидатов после Next/cleanup
    if (!this.isPcValid(pc)) {
      console.warn('[WebRTCSession] ⚠️ Cannot flush ICE candidates - PC is closed or token invalid', { 
        from, 
        count: list.length,
        signalingState: pc.signalingState,
        connectionState: (pc as any).connectionState,
        pcToken: (pc as any)?._pcToken,
        currentToken: this.pcToken
      });
      // Очищаем очередь для этого from, так как PC больше не актуален
      delete this.pendingIceByFromRef[key];
      return;
    }
    
    // КРИТИЧНО: Проверяем partnerId - если установлен, должен совпадать
    if (this.partnerIdRef && this.partnerIdRef !== from) {
      console.warn('[WebRTCSession] ⚠️ Cannot flush ICE candidates - different partner', {
        from,
        currentPartnerId: this.partnerIdRef,
        count: list.length
      });
      // Очищаем очередь для этого from, так как partnerId не совпадает
      delete this.pendingIceByFromRef[key];
      return;
    }
    
    // КРИТИЧНО: Проверяем что remoteDescription установлен перед добавлением ICE-кандидатов
    // Но если pcToken актуален, не дропаем - кандидаты останутся в pendingIceByFromRef
    const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
    if (!hasRemoteDesc) {
      // pcToken актуален (проверено выше через isPcValid), но remoteDescription еще нет
      // Кандидаты остаются в pendingIceByFromRef и будут обработаны после setRemoteDescription
      // Не логируем как ошибку - это нормальная ситуация
      return;
    }
    
    
    let addedCount = 0;
    let failedCount = 0;
    
    for (const cand of list) {
      try {
        await pc.addIceCandidate(cand);
        addedCount++;
      } catch (e: any) {
        const errorMsg = String(e?.message || '');
        // Игнорируем ошибки о дубликатах или неправильном состоянии
        if (errorMsg.includes('InvalidStateError') || errorMsg.includes('already exists') || errorMsg.includes('closed')) {
          console.warn('[WebRTCSession] ICE candidate add failed (expected):', errorMsg);
        } else {
          console.warn('[WebRTCSession] Error adding queued ICE candidate:', e);
        }
        failedCount++;
      }
    }
    
    
    delete this.pendingIceByFromRef[key];
  }
  
  // ==================== Socket Handlers ====================
  
  private async handleOffer({ from, offer, fromUserId, roomId }: { from: string; offer: any; fromUserId?: string; roomId?: string }): Promise<void> {
    // КРИТИЧНО: Объявляем isRandomChat и isFriendCall в начале функции, чтобы они были доступны во всех блоках
    const isRandomChat = 
      !(this.config.getIsDirectCall?.() ?? false) &&
      !(this.config.getInDirectCall?.() ?? false) &&
      !(this.config.getFriendCallAccepted?.() ?? false);
    const isFriendCall = !isRandomChat;
    
    // КРИТИЧНО: Устанавливаем roomId если он пришел в событии и еще не установлен
    if (isFriendCall && roomId && !this.roomIdRef) {
      console.log('📥 [handleOffer] УСТАНАВЛИВАЕМ roomId ИЗ СОБЫТИЯ', {
        receivedRoomId: roomId,
        currentRoomId: this.roomIdRef
      });
      this.roomIdRef = roomId;
      this.config.callbacks.onRoomIdChange?.(roomId);
      this.config.onRoomIdChange?.(roomId);
      this.emitSessionUpdate();
    }
    
    // КРИТИЧНО: Устанавливаем partnerUserId для receiver из fromUserId в offer
    // Это гарантирует, что partnerUserId установлен даже если он не был передан в call:accepted
    // Для receiver: fromUserId в offer - это ID инициатора (который отправил offer)
    if (isFriendCall && fromUserId && !this.partnerIdRef) {
      console.log('📥 [handleOffer] УСТАНАВЛИВАЕМ partnerId ИЗ fromUserId ДЛЯ RECEIVER', {
        fromUserId,
        currentPartnerId: this.partnerIdRef
      });
      this.partnerIdRef = fromUserId;
      this.config.callbacks.onPartnerIdChange?.(fromUserId);
      this.config.onPartnerIdChange?.(fromUserId);
      this.emit('partnerChanged', { partnerId: fromUserId, oldPartnerId: null });
      this.emitSessionUpdate();
    }
    
    console.log('📥 [handleOffer] Received offer', {
      from,
      roomId,
      fromUserId,
      isFriendCall,
      hasOffer: !!offer,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef,
      hasPC: !!this.peerRef
    });
    
    // КРИТИЧНО: Проверка partnerId - если уже установлен, должен совпадать
    // Для дружеских звонков проверяем fromUserId, для рандомного чата - from (socket id)
    const expectedPartnerId = isFriendCall && fromUserId ? fromUserId : from;
    if (this.partnerIdRef && this.partnerIdRef !== expectedPartnerId) {
      console.warn('[WebRTCSession] ⚠️ Offer from different partner, ignoring', {
        from,
        fromUserId,
        expectedPartnerId,
        currentPartnerId: this.partnerIdRef,
        isFriendCall
      });
      return;
    }
    
    // КРИТИЧНО: Защита от дубликатов offer с привязкой к pcToken, hash SDP и счетчику
    // Используем hash SDP и счетчик для разрешения легитимных re-negotiation на том же PC
    const pc = this.peerRef;
    const currentPcToken = pc ? ((pc as any)?._pcToken ?? this.pcToken) : this.pcToken;
    const offerType = offer?.type || 'offer';
    const offerSdp = offer?.sdp || '';
    const sdpHash = this.hashString(offerSdp);
    
    // Базовый ключ для счетчика (pcToken + from)
    const counterKey = `${from}_${currentPcToken}`;
    
    // Получаем текущий счетчик для этого ключа
    let counter = this.offerCounterByKeyRef.get(counterKey) || 0;
    
    // Если это новая SDP (новый hash), инкрементируем счетчик для разрешения re-negotiation
    // Проверяем, был ли уже обработан offer с таким же hash на этом pcToken+from
    const existingKeyWithSameHash = Array.from(this.processedOffersRef).find(key => 
      key.startsWith(`offer_${from}_${currentPcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      // Это новая SDP - инкрементируем счетчик перед обработкой
      counter++;
      this.offerCounterByKeyRef.set(counterKey, counter);
    }
    
    // Формируем ключ с hash SDP и счетчиком
    let offerKey = `offer_${from}_${currentPcToken}_${sdpHash}_${counter}`;
    
    // Ранний return если offer с тем же ключом уже обрабатывался (настоящий дубликат)
    if (this.processingOffersRef.has(offerKey)) {
      console.warn('[WebRTCSession] ⚠️ Duplicate offer detected (already processing)', {
        from,
        offerKey,
        pcToken: currentPcToken,
        sdpHash
      });
      return;
    }
    
    // Ранний return если offer уже был успешно обработан (настоящий дубликат)
    if (this.processedOffersRef.has(offerKey)) {
      console.warn('[WebRTCSession] ⚠️ Offer already processed, ignoring duplicate', {
        from,
        offerKey,
        pcToken: currentPcToken,
        sdpHash
      });
      return;
    }
    
    // Проверяем, что pcToken актуален (если есть PC)
    if (pc) {
      const pcToken = (pc as any)?._pcToken ?? this.pcToken;
      if (pcToken !== this.pcToken) {
        console.warn('[WebRTCSession] ⚠️ Offer for outdated PC token, ignoring', {
          from,
          offerPcToken: pcToken,
          currentPcToken: this.pcToken
        });
        return;
      }
      
      // Проверяем, что PC не закрыт
      if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        console.warn('[WebRTCSession] ⚠️ PC is closed, ignoring offer', {
          from,
          signalingState: pc.signalingState
        });
        return;
      }
      
      // Проверяем, что у текущего peerRef уже не стоит remoteDescription
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      if (hasRemoteDesc) {
        console.warn('[WebRTCSession] ⚠️ PC already has remote description, ignoring duplicate offer', {
          from,
          existingRemoteDesc: (pc as any).remoteDescription?.type,
          signalingState: pc.signalingState
        });
        return;
      }
    }
    
    this.processingOffersRef.add(offerKey);
    
    try {
      this.config.setAddBlocked?.(false);
      this.config.setAddPending?.(false);
      this.config.clearDeclinedBlock?.();
      
      // Проверка declined block
      const declinedBlock = this.config.getDeclinedBlock?.();
      const declinedUid = declinedBlock?.userId ? String(declinedBlock.userId) : null;
      if (fromUserId && declinedUid && declinedUid === String(fromUserId) && Date.now() < (declinedBlock?.until || 0)) {
        return;
      }
      
      // Получаем или создаем локальный стрим
      let stream = this.localStreamRef;
      if (!stream) {
        
        const isIncomingFriendCall = !!this.config.getIncomingFriendCall?.();
        const isInactiveState = this.config.getIsInactiveState?.() ?? false;
        const wasFriendCallEnded = this.config.getWasFriendCallEnded?.() ?? false;
        
        if (isIncomingFriendCall && isInactiveState) {
          if (wasFriendCallEnded) {
            return;
          }
          
          if (!this.config.getIncomingFriendCall?.()) {
            return;
          }
          
          this.config.setFriendCallAccepted?.(true);
          this.config.setIsInactiveState?.(false);
          this.config.setWasFriendCallEnded?.(false);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        stream = await this.startLocalStream('front');
        
        if (stream && !isValidStream(stream)) {
          console.warn('[WebRTCSession] Stream is invalid after startLocalStream, recreating');
          try {
            const tracks = stream.getTracks() || [];
            tracks.forEach((t: any) => {
              try { t.stop(); } catch {}
            });
          } catch {}
          stream = null;
        }
        
        if (!stream) {
          const isRandomChat = 
            !(this.config.getIsDirectCall?.() ?? false) &&
            !(this.config.getInDirectCall?.() ?? false) &&
            !(this.config.getFriendCallAccepted?.() ?? false);
          const started = this.config.getStarted?.() ?? false;
          const shouldCreate = !stream && (
            (isRandomChat && started) ||
            (isIncomingFriendCall || (this.config.getFriendCallAccepted?.() ?? false) || (this.config.getIsDirectCall?.() ?? false) || (this.config.getInDirectCall?.() ?? false))
          );
          
          if (shouldCreate) {
            try {
              const audioConstraints: any = {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                googEchoCancellation: true,
                googNoiseSuppression: true,
                googAutoGainControl: true,
              };
              stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
              if (stream && isValidStream(stream)) {
                this.localStreamRef = stream;
                this.config.callbacks.onLocalStreamChange?.(stream);
                this.config.onLocalStreamChange?.(stream);
                const videoTrack = stream.getVideoTracks()?.[0];
                const audioTrack = stream.getAudioTracks()?.[0];
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
              }
            } catch (directError) {
              console.error('[WebRTCSession] Error creating stream directly:', directError);
              return;
            }
          }
        }
      }
      
      if (!stream || !isValidStream(stream)) {
        console.error('[WebRTCSession] Stream is invalid or null, cannot create PC');
        return;
      }
      
      // Устанавливаем partnerId и roomId
      if (from && !this.partnerIdRef) {
        const oldPartnerId = this.partnerIdRef;
        this.partnerIdRef = from;
        this.config.callbacks.onPartnerIdChange?.(from);
        this.config.onPartnerIdChange?.(from);
        this.emit('partnerChanged', { partnerId: from, oldPartnerId });
        this.emitSessionUpdate();
        // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId
        this.flushOutgoingIceCache();
      }
      
      if (roomId) {
        this.roomIdRef = roomId;
        this.config.callbacks.onRoomIdChange?.(roomId);
        this.config.onRoomIdChange?.(roomId);
        this.emitSessionUpdate();
      }
      
      // Эмитим событие matchFound если это новый партнер
      if (from && roomId) {
        this.emit('matchFound', { partnerId: from, roomId });
      }
      
      // Создаем или получаем PC
      // КРИТИЧНО: Для дружеских звонков НЕ создаем новый PC если он уже существует
      // isFriendCall уже объявлен в начале функции
      
      let pc = this.peerRef;
      
      // КРИТИЧНО: Для дружеских звонков проверяем, что существующий PC в правильном состоянии
      if (pc && isFriendCall) {
        const state = pc.signalingState;
        const isClosed = state === 'closed' || (pc as any).connectionState === 'closed';
        const hasRemoteDesc = !!(pc as any).remoteDescription;
        const hasLocalDesc = !!(pc as any).localDescription;
        
        // Если PC закрыт - очищаем и создаем новый
        if (isClosed) {
          console.log('[WebRTCSession] [FRIEND CALL] Existing PC is closed, cleaning up', { from, roomId, state });
          try {
            this.cleanupPeer(pc);
          } catch {}
          pc = null;
          this.peerRef = null;
        } else if (hasRemoteDesc) {
          // PC уже имеет remote description - это означает, что offer уже был обработан
          console.log('[WebRTCSession] [FRIEND CALL] PC already has remote description, ignoring duplicate offer', {
            from,
            roomId,
            state,
            existingRemoteDesc: (pc as any).remoteDescription?.type
          });
          this.processingOffersRef.delete(offerKey);
          return;
        } else if (hasLocalDesc && state === 'have-local-offer') {
          // КРИТИЧНО: Ситуация "glare" - оба участника отправили offer одновременно
          // Если у нас есть local offer, но мы получаем входящий offer - отменяем свой offer
          // и обрабатываем входящий (стандартное поведение WebRTC для разрешения glare)
          console.log('[WebRTCSession] [FRIEND CALL] ⚠️ GLARE detected: we have local offer but received incoming offer - rolling back', {
            from,
            roomId,
            state
          });
          try {
            // Отменяем локальный offer (rollback) - устанавливаем пустое localDescription
            await pc.setLocalDescription({ type: 'rollback' } as any);
            // После rollback PC должен быть в состоянии 'stable' без localDescription
            const newState = pc.signalingState;
            const newHasLocalDesc = !!(pc as any).localDescription;
            console.log('[WebRTCSession] [FRIEND CALL] ✅ Rolled back local offer, will process incoming offer', {
              from,
              roomId,
              oldState: state,
              newState,
              hadLocalDesc: hasLocalDesc,
              hasLocalDesc: newHasLocalDesc
            });
            // Проверяем, что rollback успешен
            if (newState !== 'stable' || newHasLocalDesc) {
              throw new Error(`Rollback failed: PC state is ${newState}, hasLocalDesc=${newHasLocalDesc}`);
            }
          } catch (rollbackError) {
            // Если rollback не поддерживается или не сработал, очищаем PC и создаем новый
            console.log('[WebRTCSession] [FRIEND CALL] ⚠️ Rollback failed, cleaning up PC and will recreate', {
              from,
              roomId,
              error: rollbackError
            });
            try {
              this.cleanupPeer(pc);
            } catch {}
            pc = null;
            this.peerRef = null;
          }
        } else {
          // PC существует и в правильном состоянии - переиспользуем
          // КРИТИЧНО: Если у нас нет localDescription, мы можем обработать входящий offer
          // Это разрешает ситуацию "glare" - если оба участника отправили offer одновременно,
          // тот, кто получит offer первым, обработает его как receiver
          console.log('[WebRTCSession] [FRIEND CALL] Reusing existing PC for offer', {
            from,
            roomId,
            signalingState: state,
            hasLocalDesc,
            hasRemoteDesc: false
          });
        }
      }
      
      if (!pc) {
        // КРИТИЧНО: Если PC не существует, создаем его для обработки входящего offer
        // Это разрешает ситуацию "glare" - если оба участника отправили offer одновременно,
        // тот, кто получит offer первым, создаст PC и обработает его как receiver
        // КРИТИЧНО: Проверяем еще раз после await, так как PC мог быть создан в другом месте
        if (this.peerRef && this.peerRef.signalingState !== 'closed') {
          console.log('[WebRTCSession] [FRIEND CALL] PC already exists, reusing', { 
            from, 
            roomId,
            signalingState: this.peerRef.signalingState
          });
          pc = this.peerRef;
        } else {
          if (isFriendCall) {
            console.log('[WebRTCSession] [FRIEND CALL] Creating PC for incoming offer', { 
              from, 
              roomId
            });
          }
          pc = await this.ensurePcWithLocal(stream);
        }
        if (!pc) {
          if (isFriendCall) {
            console.log('[WebRTCSession] [FRIEND CALL] Failed to create PC - attempting to recreate stream', { from, roomId });
          } else {
            console.error('[WebRTCSession] Failed to create PC - attempting to recreate stream');
          }
          // Если PC не создан из-за мертвых треков, пытаемся пересоздать стрим
          try {
            if (this.localStreamRef) {
              this.localStreamRef.getTracks().forEach((track: any) => track.stop());
              this.localStreamRef = null;
            }
            const newStream = await this.startLocalStream();
            if (newStream && isValidStream(newStream)) {
              stream = newStream;
              pc = await this.ensurePcWithLocal(stream);
              if (!pc) {
                if (isFriendCall) {
                  console.log('[WebRTCSession] [FRIEND CALL] Failed to create PC even after stream recreation', { from, roomId });
                } else {
                  console.error('[WebRTCSession] Failed to create PC even after stream recreation');
                }
                this.processingOffersRef.delete(offerKey);
                return;
              }
            } else {
              if (isFriendCall) {
                console.log('[WebRTCSession] [FRIEND CALL] Failed to recreate stream', { from, roomId });
              } else {
                console.error('[WebRTCSession] Failed to recreate stream');
              }
              this.processingOffersRef.delete(offerKey);
              return;
            }
          } catch (e) {
            if (isFriendCall) {
              console.log('[WebRTCSession] [FRIEND CALL] Error recreating stream', e, { from, roomId });
            } else {
              console.error('[WebRTCSession] Error recreating stream:', e);
            }
            this.processingOffersRef.delete(offerKey);
            return;
          }
        }
      }
      
      // Проверяем состояние PC
      if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        console.error('[WebRTCSession] ❌❌❌ CRITICAL: PC is closed - CANNOT call setRemoteDescription for offer!', {
          from,
          hasOffer: !!offer,
          signalingState: pc.signalingState,
          connectionState: (pc as any).connectionState
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем pcToken перед setRemoteDescription
      if (!this.isPcValid(pc)) {
        console.warn('[WebRTCSession] ⚠️ PC token invalid, dropping offer', {
          from,
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем состояние PC перед setRemoteDescription
      // Для offer ожидаем состояние 'stable' без localDescription и remoteDescription
      // НО для дружеских звонков разрешаем обработку если PC в have-local-offer (уже есть локальный offer)
      const hasLocalDesc = !!(pc as any).localDescription;
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      // isFriendCall уже объявлен в начале функции
      
      // Для дружеских звонков: если PC в have-local-offer и нет remoteDesc, это может быть re-negotiation
      // Для рандомного чата: строго требуем stable без описаний
      if (isFriendCall) {
        // Для дружеских звонков разрешаем если:
        // 1. stable без описаний (обычный случай)
        // 2. have-local-offer без remoteDesc (re-negotiation)
        if (pc.signalingState === 'stable' && !hasLocalDesc && !hasRemoteDesc) {
          // Обычный случай - все ок
        } else if (pc.signalingState === 'have-local-offer' && !hasRemoteDesc) {
          // Re-negotiation - разрешаем
          console.log('[WebRTCSession] [FRIEND CALL] Processing offer for re-negotiation', {
            from,
            roomId,
            signalingState: pc.signalingState
          });
        } else if (hasRemoteDesc) {
          // Уже есть remoteDesc - это дубликат
          console.log('[WebRTCSession] [FRIEND CALL] PC already has remote description, ignoring duplicate offer', {
            from,
            roomId,
            existingRemoteDesc: (pc as any).remoteDescription?.type,
            signalingState: pc.signalingState
          });
          this.processingOffersRef.delete(offerKey);
          return;
        } else {
          // Неподходящее состояние
          console.log('[WebRTCSession] [FRIEND CALL] PC in wrong state for offer', {
            from,
            roomId,
            signalingState: pc.signalingState,
            hasLocalDesc,
            hasRemoteDesc
          });
          this.processingOffersRef.delete(offerKey);
          return;
        }
      } else {
        // Для рандомного чата строгая проверка
        if (pc.signalingState !== 'stable' || hasLocalDesc || hasRemoteDesc) {
          console.warn('[WebRTCSession] ⚠️ PC not in stable state (without descriptions), dropping offer', {
            from,
            signalingState: pc.signalingState,
            hasLocalDesc,
            hasRemoteDesc,
            expectedState: 'stable (no descriptions)'
          });
          this.processingOffersRef.delete(offerKey);
          return;
        }
      }
      
      // КРИТИЧНО: Устанавливаем remote description - ОБЯЗАТЕЛЬНО для работы WebRTC
      // Без этого соединение не установится
      // hasRemoteDesc уже проверен выше, если мы дошли сюда, значит его нет
      if (!hasRemoteDesc) {
        // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен ДО setRemoteDescription
        // БЕЗ ontrack вы НИКОГДА не увидите собеседника - это критично для всех типов звонков
        let hasOntrack = !!(pc as any)?.ontrack;
        if (!hasOntrack && from) {
          this.attachRemoteHandlers(pc, from);
          // Проверяем еще раз после установки
          hasOntrack = !!(pc as any)?.ontrack;
          if (!hasOntrack) {
            console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler BEFORE setRemoteDescription in handleOffer!');
          }
        } else if (!hasOntrack) {
          console.warn('[WebRTCSession] ⚠️ Cannot attach ontrack handler - no from ID', {
            from,
            hasOntrack: false
          });
        }
        
        // КРИТИЧНО: Преобразуем offer в RTCSessionDescription если нужно
        let offerDesc = offer;
        if (offer && typeof offer === 'object' && !offer.type) {
          // Если offer пришел как объект без type, создаем RTCSessionDescription
          offerDesc = { type: 'offer', sdp: offer.sdp || offer } as any;
        }
        
        try {
          await pc.setRemoteDescription(offerDesc as any);
          
          // КРИТИЧНО: Фиксируем успешную обработку offer в processedOffersRef
          // Это предотвращает повторные setRemoteDescription при повторной доставке
          // Используем ключ с hash SDP и счетчиком для разрешения re-negotiation
          this.processedOffersRef.add(offerKey);
          // НЕ удаляем из processingOffersRef - оставляем для защиты от дубликатов
          
          // КРИТИЧНО: Проверяем, что обработчик ontrack установлен после setRemoteDescription
          // setRemoteDescription может сбросить обработчик из-за внутренних операций WebRTC
          let hasOntrackAfterOffer = !!(pc as any)?.ontrack;
          
          // Если обработчик отсутствует, устанавливаем его снова СРАЗУ
          if (!hasOntrackAfterOffer && from) {
            console.warn('[WebRTCSession] ontrack handler missing after setRemoteDescription in handleOffer, reattaching immediately');
            this.attachRemoteHandlers(pc, from);
            // Проверяем еще раз после переустановки
            hasOntrackAfterOffer = !!(pc as any)?.ontrack;
            if (!hasOntrackAfterOffer) {
              console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler after setRemoteDescription in handleOffer!');
            }
          }
          
          // КРИТИЧНО: Дополнительная проверка через небольшую задержку для защиты от race condition
          // Это гарантирует, что обработчик не потеряется из-за асинхронных операций
          setTimeout(() => {
            const pcAfterDelay = this.peerRef;
            if (pcAfterDelay === pc && from) {
              const hasOntrackAfterDelay = !!(pcAfterDelay as any)?.ontrack;
              if (!hasOntrackAfterDelay) {
                console.warn('[WebRTCSession] ontrack handler lost after setRemoteDescription in handleOffer (delayed check), reattaching');
                this.attachRemoteHandlers(pcAfterDelay, from);
              }
            }
          }, 50);
          
          // КРИТИЧНО: Проверяем receivers после установки offer (для всех типов звонков)
          // Это fallback механизм на случай, если ontrack не сработал
          if (from) {
            setTimeout(() => {
              const pcAfterOffer = this.peerRef;
              if (pcAfterOffer === pc && this.partnerIdRef && !this.remoteStreamRef) {
                this.checkReceiversForRemoteStream(pcAfterOffer);
              }
            }, 500);
          }
        } catch (error: any) {
          const errorMsg = String(error?.message || '');
          if (errorMsg.includes('closed') || errorMsg.includes('null')) {
            console.warn('[WebRTCSession] PC was closed during setRemoteDescription');
            return;
          }
          console.error('[WebRTCSession] Error setting remote description:', error);
          return;
        }
      } else {
        console.warn('[WebRTCSession] ⚠️ PC already has remote description - skipping setRemoteDescription for offer', {
          existingRemoteDesc: (pc as any).remoteDescription?.type,
          currentSignalingState: pc.signalingState
        });
      }
      
      // Прожигаем отложенные ICE кандидаты
      try {
        await this.flushIceFor(from);
      } catch {}
      
      // Создаем answer
      // КРИТИЧНО: Если мы дошли до этого шага, значит мы успешно обработали входящий offer
      // и должны создать answer. Это разрешает ситуацию "glare" - тот, кто получил offer первым,
      // обрабатывает его и создает answer, независимо от конфигурации isInitiator
      
      // КРИТИЧНО: Сохраняем ссылку на PC ДО любых асинхронных операций
      // Это гарантирует, что мы используем тот же PC для создания answer
      const currentPcForAnswer = this.peerRef;
      // isFriendCall уже объявлен в начале handleOffer
      
      // КРИТИЧНО: Для дружеских звонков проверяем, что PC не изменился
      if (!currentPcForAnswer) {
        if (isFriendCall) {
          console.log('[WebRTCSession] [FRIEND CALL] No PC exists for answer creation', {
            from,
            roomId: this.roomIdRef
          });
        } else {
          console.warn('[WebRTCSession] No PC exists for answer creation');
        }
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      if (currentPcForAnswer !== pc) {
        if (isFriendCall) {
          // Для дружеских звонков это критическая ошибка - не создаем answer если PC изменился
          console.log('[WebRTCSession] ⚠️ [FRIEND CALL] PC was changed before answer creation - aborting', {
            from,
            roomId: this.roomIdRef,
            hasPc: !!currentPcForAnswer,
            pcMatches: currentPcForAnswer === pc,
            originalPcState: pc?.signalingState,
            currentPcState: currentPcForAnswer?.signalingState
          });
        } else {
          // Для рандомного чата это нормально - PC может пересоздаваться
          console.warn('[WebRTCSession] PC was changed before answer creation');
        }
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем, что PC не закрыт
      if (currentPcForAnswer.signalingState === 'closed' || (currentPcForAnswer as any).connectionState === 'closed') {
        if (isFriendCall) {
          console.log('[WebRTCSession] [FRIEND CALL] PC is closed, cannot create answer', {
            from,
            roomId: this.roomIdRef
          });
        } else {
          console.error('[WebRTCSession] PC is closed, cannot create answer');
        }
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Для дружеских звонков логируем состояние перед созданием answer
      if (isFriendCall) {
        console.log('[WebRTCSession] [FRIEND CALL] Creating answer', {
          from,
          roomId: this.roomIdRef,
          callId: this.callIdRef,
          partnerId: this.partnerIdRef,
          signalingState: currentPcForAnswer.signalingState,
          hasLocalDesc: !!(currentPcForAnswer as any).localDescription,
          hasRemoteDesc: !!(currentPcForAnswer as any).remoteDescription
        });
      }
      
      if (currentPcForAnswer.signalingState === 'have-remote-offer') {
        try {
          if (this.peerRef !== currentPcForAnswer) {
            console.warn('[WebRTCSession] PC was changed during answer creation');
            return;
          }
          
          // КРИТИЧНО: Проверяем что треки добавлены в PC перед созданием answer
          const sendersBeforeAnswer = currentPcForAnswer.getSenders?.() || [];
          const audioSendersBeforeAnswer = sendersBeforeAnswer.filter((s: any) => s?.track?.kind === 'audio');
          const videoSendersBeforeAnswer = sendersBeforeAnswer.filter((s: any) => s?.track?.kind === 'video');
          
          // КРИТИЧНО: Проверяем, что треки не ended
          const endedAudioTracksBeforeAnswer = audioSendersBeforeAnswer.filter((s: any) => s?.track?.readyState === 'ended');
          const endedVideoTracksBeforeAnswer = videoSendersBeforeAnswer.filter((s: any) => s?.track?.readyState === 'ended');
          if (endedAudioTracksBeforeAnswer.length > 0 || endedVideoTracksBeforeAnswer.length > 0) {
            console.error('[WebRTCSession] ❌❌❌ CRITICAL: Tracks are ended before createAnswer!', {
              endedAudioCount: endedAudioTracksBeforeAnswer.length,
              endedVideoCount: endedVideoTracksBeforeAnswer.length,
              totalAudioSenders: audioSendersBeforeAnswer.length,
              totalVideoSenders: videoSendersBeforeAnswer.length
            });
          }
          
          if (sendersBeforeAnswer.length === 0) {
            console.error('[WebRTCSession] ❌❌❌ CRITICAL: No tracks in PC before createAnswer! This will result in sendonly!');
          }
          
          // КРИТИЧНО: Проверяем состояние PC перед созданием answer
          const stateBeforeAnswer = currentPcForAnswer.signalingState;
          if (stateBeforeAnswer !== 'have-remote-offer') {
            console.warn('[WebRTCSession] ⚠️ PC state changed before createAnswer', {
              expected: 'have-remote-offer',
              actual: stateBeforeAnswer,
              from
            });
            return;
          }
          
          // Оптимизация: создаем answer без дополнительных опций для совместимости
          const answer = await currentPcForAnswer.createAnswer();
          
          // КРИТИЧНО: Проверяем, что PC не изменился и состояние корректно
          if (this.peerRef !== currentPcForAnswer) {
            console.warn('[WebRTCSession] ⚠️ PC was changed during createAnswer');
            return;
          }
          
          const stateAfterCreate: string = currentPcForAnswer.signalingState;
          // После createAnswer состояние должно остаться 'have-remote-offer'
          // Если состояние изменилось на 'stable', это означает проблему
          if (stateAfterCreate === 'stable') {
            console.warn('[WebRTCSession] ⚠️ PC state is stable after createAnswer, before setLocalDescription', {
              from,
              stateAfterCreate,
              hasRemoteDesc: !!currentPcForAnswer.remoteDescription
            });
            // Если состояние stable, значит remote description был потерян - не можем установить answer
            return;
          }
          
          // Если состояние уже 'have-local-answer', значит answer уже был установлен
          if (stateAfterCreate === 'have-local-answer') {
            console.warn('[WebRTCSession] ⚠️ PC already has local answer, skipping setLocalDescription', {
              from,
              stateAfterCreate
            });
            return;
          }
          
          // КРИТИЧНО: Проверяем SDP answer на наличие sendrecv
          if (answer.sdp) {
            const hasSendRecv = answer.sdp.includes('a=sendrecv');
            const hasSendOnly = answer.sdp.includes('a=sendonly');
            const hasRecvOnly = answer.sdp.includes('a=recvonly');
            if (hasSendOnly && !hasSendRecv) {
              console.error('[WebRTCSession] ❌❌❌ CRITICAL: Answer has sendonly instead of sendrecv! This means remote video will not work!');
            }
            if (!hasSendRecv && !hasSendOnly && !hasRecvOnly) {
              console.warn('[WebRTCSession] ⚠️ Answer SDP has no explicit direction - may default to sendonly');
            }
          }
          
          // КРИТИЧНО: Проверяем состояние перед setLocalDescription
          const stateBeforeSetLocal: string = currentPcForAnswer.signalingState;
          const hasLocalDescBefore = !!currentPcForAnswer.localDescription;
          if (stateBeforeSetLocal === 'stable' || hasLocalDescBefore) {
            console.error('[WebRTCSession] ❌ Cannot set local answer: PC is in stable state', {
              from,
              stateBeforeSetLocal,
              hasRemoteDesc: !!currentPcForAnswer.remoteDescription,
              hasLocalDesc: hasLocalDescBefore
            });
            return;
          }
          
          try {
            await currentPcForAnswer.setLocalDescription(answer);
          } catch (error: any) {
            const errorMsg = String(error?.message || '');
            if (errorMsg.includes('wrong state') || errorMsg.includes('stable')) {
              // Это означает, что к этому моменту PC уже перешёл в стабильное состояние
              // (answer/offer уже согласованы либо на этом, либо на новом PC).
              // Считаем это бенign race-condition и просто выходим без дополнительного лога.
              return;
            }
            throw error; // Пробрасываем другие ошибки
          }
          
          const currentRoomId = this.roomIdRef;
          const answerPayload: any = { to: from, answer };
          const isDirectFriendCall = 
            (this.config.getIsDirectCall?.() ?? false) ||
            (this.config.getInDirectCall?.() ?? false) ||
            (this.config.getFriendCallAccepted?.() ?? false);
          
          if (isDirectFriendCall && currentRoomId) {
            if (currentRoomId.startsWith('room_')) {
              answerPayload.roomId = currentRoomId;
            } else {
              const offerRoomId = roomId;
              if (offerRoomId && offerRoomId.startsWith('room_')) {
                this.roomIdRef = offerRoomId;
                this.config.callbacks.onRoomIdChange?.(offerRoomId);
                this.config.onRoomIdChange?.(offerRoomId);
                this.emitSessionUpdate();
                answerPayload.roomId = offerRoomId;
              } else {
                const ids = [socket.id, from].sort();
                const generatedRoomId = `room_${ids[0]}_${ids[1]}`;
                this.roomIdRef = generatedRoomId;
                this.config.callbacks.onRoomIdChange?.(generatedRoomId);
                this.config.onRoomIdChange?.(generatedRoomId);
                this.emitSessionUpdate();
                answerPayload.roomId = generatedRoomId;
              }
            }
          }
          
          socket.emit('answer', answerPayload);
          
          // КРИТИЧНО: Для дружеских звонков логируем успешную отправку answer
          if (isFriendCall) {
            console.log('[WebRTCSession] [FRIEND CALL] ✅ Answer sent', {
              from,
              roomId: currentRoomId,
              hasRoomId: !!currentRoomId
            });
          }
        } catch (e) {
          if (isFriendCall) {
            console.log('[WebRTCSession] [FRIEND CALL] Error creating/setting answer', e, {
              from,
              roomId: this.roomIdRef
            });
          } else {
            console.error('[WebRTCSession] Error creating/setting answer:', e);
          }
        }
      } else {
        // КРИТИЧНО: Для дружеских звонков логируем если состояние неправильное
        if (isFriendCall) {
          console.log('[WebRTCSession] [FRIEND CALL] Cannot create answer - wrong PC state', {
            from,
            roomId: this.roomIdRef,
            signalingState: currentPcForAnswer.signalingState,
            expectedState: 'have-remote-offer'
          });
        }
      }
      
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      
      // Обновляем список друзей
      try {
        await this.config.fetchFriends?.();
      } catch {}
      
      // Отправляем состояние камеры
      setTimeout(() => {
        this.sendCameraState(from);
      }, 500);
    } catch (e) {
      console.error('[WebRTCSession] handleOffer error:', e);
    } finally {
      this.processingOffersRef.delete(offerKey);
    }
  }
  
  private async handleAnswer({ from, answer, roomId }: { from: string; answer: any; roomId?: string }): Promise<void> {
    // КРИТИЧНО: Объявляем isRandomChat и isFriendCall в начале функции, чтобы они были доступны во всех блоках
    const isRandomChat = 
      !(this.config.getIsDirectCall?.() ?? false) &&
      !(this.config.getInDirectCall?.() ?? false) &&
      !(this.config.getFriendCallAccepted?.() ?? false);
    const isFriendCall = !isRandomChat;
    
    // КРИТИЧНО: Проверка partnerId - если уже установлен, должен совпадать
    if (this.partnerIdRef && this.partnerIdRef !== from) {
      console.warn('[WebRTCSession] ⚠️ Answer from different partner, ignoring', {
        from,
        currentPartnerId: this.partnerIdRef
      });
      return;
    }
    
    // КРИТИЧНО: Защита от дубликатов answer с привязкой к pcToken, hash SDP и счетчику
    // Используем hash SDP и счетчик для разрешения легитимных re-negotiation на том же PC
    const pc = this.peerRef;
    const currentPcToken = pc ? ((pc as any)?._pcToken ?? this.pcToken) : this.pcToken;
    const answerType = answer?.type || 'answer';
    const answerSdp = answer?.sdp || '';
    const sdpHash = this.hashString(answerSdp);
    
    // Базовый ключ для счетчика (pcToken + from)
    const counterKey = `${from}_${currentPcToken}`;
    
    // Получаем текущий счетчик для этого ключа
    let counter = this.answerCounterByKeyRef.get(counterKey) || 0;
    
    // Если это новая SDP (новый hash), инкрементируем счетчик для разрешения re-negotiation
    // Проверяем, был ли уже обработан answer с таким же hash на этом pcToken+from
    const existingKeyWithSameHash = Array.from(this.processedAnswersRef).find(key => 
      key.startsWith(`answer_${from}_${currentPcToken}_${sdpHash}_`)
    );
    
    if (!existingKeyWithSameHash) {
      // Это новая SDP - инкрементируем счетчик перед обработкой
      counter++;
      this.answerCounterByKeyRef.set(counterKey, counter);
    }
    
    // Формируем ключ с hash SDP и счетчиком
    let answerKey = `answer_${from}_${currentPcToken}_${sdpHash}_${counter}`;
    
    // Ранний return если answer с тем же ключом уже обрабатывался (настоящий дубликат)
    if (this.processingAnswersRef.has(answerKey)) {
      console.warn('[WebRTCSession] ⚠️ Duplicate answer detected (already processing)', {
        from,
        answerKey,
        pcToken: currentPcToken,
        sdpHash
      });
      return;
    }
    
    // Ранний return если answer уже был успешно обработан (настоящий дубликат)
    if (this.processedAnswersRef.has(answerKey)) {
      console.warn('[WebRTCSession] ⚠️ Answer already processed, ignoring duplicate', {
        from,
        answerKey,
        pcToken: currentPcToken,
        sdpHash
      });
      return;
    }
    
    // Проверяем, что pcToken актуален (если есть PC)
    if (pc) {
      const pcToken = (pc as any)?._pcToken ?? this.pcToken;
      if (pcToken !== this.pcToken) {
        console.warn('[WebRTCSession] ⚠️ Answer for outdated PC token, ignoring', {
          from,
          answerPcToken: pcToken,
          currentPcToken: this.pcToken
        });
        return;
      }
      
      // Проверяем, что PC не закрыт
      if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        console.warn('[WebRTCSession] ⚠️ PC is closed, ignoring answer', {
          from,
          signalingState: pc.signalingState
        });
        return;
      }
      
      // Проверяем, что у текущего peerRef уже не стоит remoteDescription
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      if (hasRemoteDesc) {
        console.warn('[WebRTCSession] ⚠️ PC already has remote description, ignoring duplicate answer', {
          from,
          existingRemoteDesc: (pc as any).remoteDescription?.type,
          signalingState: pc.signalingState
        });
        return;
      }
    }
    
    // КРИТИЧНО: Для дружеских звонков проверяем роль
    // Инициатор ДОЛЖЕН обработать answer от принимающего, чтобы установить remote description
    // Это необходимо для получения remote stream у инициатора
    const isDirectCall = this.config.getIsDirectCall?.() ?? false;
    const inDirectCall = this.config.getInDirectCall?.() ?? false;
    const isDirectInitiator = this.config.getIsDirectInitiator?.() ?? false;
    const hasIncomingCall = this.config.getHasIncomingCall?.() ?? false;
    const isInitiator = isDirectInitiator || (!hasIncomingCall && isDirectCall && !inDirectCall);
    const isReceiver = !isDirectInitiator && (hasIncomingCall || inDirectCall);
    
    // КРИТИЧНО: Инициатор ДОЛЖЕН обработать answer, чтобы установить remote description
    // Только если инициатор получает answer от себя (что неправильно) - игнорируем
    // Но если answer от принимающего - обрабатываем
    
    this.processingAnswersRef.add(answerKey);
    
    try {
      // Устанавливаем partnerId если не установлен
      if (from && !this.partnerIdRef) {
        const oldPartnerId = this.partnerIdRef;
        this.partnerIdRef = from;
        this.config.callbacks.onPartnerIdChange?.(from);
        this.config.onPartnerIdChange?.(from);
        this.emit('partnerChanged', { partnerId: from, oldPartnerId });
        this.emitSessionUpdate();
        // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId
        this.flushOutgoingIceCache();
      }
      
      if (roomId) {
        this.roomIdRef = roomId;
        this.config.callbacks.onRoomIdChange?.(roomId);
        this.config.onRoomIdChange?.(roomId);
        this.emitSessionUpdate();
      }
      
      let pc = this.peerRef;
      // isFriendCall уже объявлен в начале функции (isRandomChat)
      
      // КРИТИЧНО: Для дружеских звонков проверяем наличие PC
      // Для инициатора PC должен быть создан в callFriend и иметь local description (offer)
      // Для принимающего PC должен быть создан в handleOffer
      if (!pc) {
        if (isFriendCall) {
          // Для инициатора PC должен существовать с offer - если его нет, пытаемся восстановить
          if (isInitiator && !isReceiver) {
            console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ⚠️ No PC exists for answer - attempting to recover', {
              from,
              roomId: this.roomIdRef,
              hasLocalStream: !!this.localStreamRef,
              hasPeerRef: !!this.peerRef
            });
            
            // КРИТИЧНО: Создаем локальный стрим, если его нет
            let stream = this.localStreamRef;
            if (!stream) {
              console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ⚠️ No local stream, creating one', {
                from,
                roomId: this.roomIdRef
              });
              try {
                stream = await this.startLocalStream('front');
                if (!stream) {
                  console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ❌ Failed to create local stream for recovery', {
                    from,
                    roomId: this.roomIdRef
                  });
                  this.processingAnswersRef.delete(answerKey);
                  return;
                }
                console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ✅ Local stream created for recovery', {
                  streamId: stream.id
                });
              } catch (e) {
                console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ❌ Error creating local stream for recovery:', e);
                this.processingAnswersRef.delete(answerKey);
                return;
              }
            }
            
            // Пытаемся восстановить PC с локальным стримом
            try {
              pc = await this.ensurePcWithLocal(stream);
              if (pc && from) {
                this.attachRemoteHandlers(pc, from);
                
                // КРИТИЧНО: Если PC восстановлен, но нет local description (offer), создаем его
                const hasLocalDesc = !!(pc as any).localDescription;
                if (pc.signalingState === 'stable' && !hasLocalDesc) {
                  console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ⚠️ Recovered PC has no offer, creating one', {
                    from,
                    signalingState: pc.signalingState
                  });
                  
                  const offer = await pc.createOffer({
                    offerToReceiveAudio: true,
                    offerToReceiveVideo: true
                  });
                  await pc.setLocalDescription(offer);
                  this.markPcWithToken(pc);
                  
                  // Отправляем offer
                  const toId = this.partnerIdRef || from;
                  const roomId = this.roomIdRef;
                  if (toId || roomId) {
                    socket.emit('offer', {
                      offer,
                      to: toId,
                      roomId: roomId
                    });
                    console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ✅ Offer created and sent after recovery');
                  }
                }
                
                console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ✅ PC recovered for answer', {
                  from,
                  signalingState: pc.signalingState,
                  hasLocalDesc: !!(pc as any).localDescription
                });
              } else {
                console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ❌ Failed to recover PC', {
                  from,
                  roomId: this.roomIdRef
                });
                this.processingAnswersRef.delete(answerKey);
                return;
              }
            } catch (e) {
              console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ❌ Error recovering PC:', e);
              this.processingAnswersRef.delete(answerKey);
              return;
            }
          } else {
            // Для принимающего PC должен быть создан в handleOffer
            console.log('[WebRTCSession] [FRIEND CALL] No PC exists for answer - PC should be created in handleOffer', {
              from,
              roomId: this.roomIdRef,
              isInitiator,
              isReceiver
            });
            this.processingAnswersRef.delete(answerKey);
            return;
          }
        }
        
        // Для рандомного чата создаем PC если его нет
        let stream = this.localStreamRef;
        
        if (!stream) {
          stream = await this.startLocalStream('front');
          if (!stream) {
            try {
              const audioConstraints: any = {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                googEchoCancellation: true,
                googNoiseSuppression: true,
                googAutoGainControl: true,
              };
              stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
              if (stream && isValidStream(stream)) {
                this.localStreamRef = stream;
                this.config.callbacks.onLocalStreamChange?.(stream);
                this.config.onLocalStreamChange?.(stream);
                const videoTrack = stream.getVideoTracks()?.[0];
                const audioTrack = stream.getAudioTracks()?.[0];
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
              }
            } catch (directError) {
              console.error('[WebRTCSession] Error creating stream directly:', directError);
              return;
            }
          }
        }
        
        if (stream) {
          try {
            pc = await this.ensurePcWithLocal(stream);
            if (pc && from) {
              this.attachRemoteHandlers(pc, from);
            }
          } catch (e) {
            console.error('[WebRTCSession] Error creating PC:', e);
          }
        }
      } else if (isFriendCall) {
        // КРИТИЧНО: Для дружеских звонков PC должен быть создан в handleOffer
        // Если PC отсутствует в handleAnswer - это ошибка
        if (!pc) {
          console.log('[WebRTCSession] [FRIEND CALL] No PC exists for answer - PC should be created in handleOffer', {
            from,
            roomId: this.roomIdRef,
            partnerId: this.partnerIdRef
          });
          this.processingAnswersRef.delete(answerKey);
          return;
        }
        console.log('[WebRTCSession] [FRIEND CALL] Reusing existing PC for answer', {
          from,
          roomId: this.roomIdRef,
          signalingState: pc.signalingState,
          hasLocalDesc: !!(pc as any).localDescription,
          hasRemoteDesc: !!(pc as any).remoteDescription
        });
      }
      
      if (!pc) {
        // Для рандомного чата это может быть нормально, но логируем
        if (!isFriendCall) {
          console.error('[WebRTCSession] ❌❌❌ CRITICAL: PeerConnection not found - CANNOT call setRemoteDescription for answer!', {
            from,
            hasAnswer: !!answer,
            partnerIdRef: this.partnerIdRef
          });
        }
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // Проверяем что PC валиден
      if ((pc.signalingState as any) === 'closed' || (pc.connectionState as any) === 'closed' || !this.peerRef || this.peerRef !== pc) {
        console.error('[WebRTCSession] ❌❌❌ CRITICAL: PC is closed or changed - CANNOT call setRemoteDescription for answer!', {
          from,
          hasAnswer: !!answer,
          signalingState: pc.signalingState,
          connectionState: (pc as any).connectionState,
          peerRefMatches: this.peerRef === pc
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем pcToken перед обработкой
      if (!this.isPcValid(pc)) {
        console.warn('[WebRTCSession] ⚠️ PC token invalid, dropping answer', {
          from,
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken
        });
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем состояние PC перед setRemoteDescription
      // Для answer ожидаем состояние 'have-local-offer' (есть localDescription, нет remoteDescription)
      const hasLocalDesc = !!(pc as any).localDescription;
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      // isFriendCall уже объявлен в начале функции (isRandomChat)
      
      if (pc.signalingState !== 'have-local-offer' || !hasLocalDesc || hasRemoteDesc) {
        // Для дружеских звонков: если PC в stable и нет описаний, это означает что offer еще не был установлен
        // Для инициатора пытаемся создать offer на лету
        if (isFriendCall && pc.signalingState === 'stable' && !hasLocalDesc && !hasRemoteDesc) {
          const isDirectCall = this.config.getIsDirectCall?.() ?? false;
          const inDirectCall = this.config.getInDirectCall?.() ?? false;
          const isDirectInitiator = this.config.getIsDirectInitiator?.() ?? false;
          const hasIncomingCall = this.config.getHasIncomingCall?.() ?? false;
          const isInitiator = isDirectInitiator || (!hasIncomingCall && isDirectCall && !inDirectCall);
          if (isInitiator) {
            console.log('[WebRTCSession] ⚠️ [FRIEND CALL] [INITIATOR] PC in stable state without offer - creating offer now', {
              from,
              hasAnswer: !!answer,
              currentState: pc.signalingState,
              hasLocalDesc,
              hasRemoteDesc,
              roomId: this.roomIdRef
            });
            
            // КРИТИЧНО: Создаем offer на лету перед обработкой answer
            try {
              const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
              });
              await pc.setLocalDescription(offer);
              this.markPcWithToken(pc);
              
              // Отправляем offer
              const toId = this.partnerIdRef || from;
              const roomId = this.roomIdRef;
              if (toId || roomId) {
                socket.emit('offer', {
                  offer,
                  to: toId,
                  roomId: roomId
                });
                console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ✅ Offer created and sent before answer processing');
              }
              
              // Продолжаем обработку answer после создания offer
            } catch (e) {
              console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] ❌ Failed to create offer before answer:', e);
              this.processingAnswersRef.delete(answerKey);
              return;
            }
          } else {
            console.log('[WebRTCSession] ❌ [FRIEND CALL] [RECEIVER] PC in stable state without offer - this should not happen', {
              from,
              hasAnswer: !!answer,
              currentState: pc.signalingState,
              hasLocalDesc,
              hasRemoteDesc,
              roomId: this.roomIdRef
            });
            this.processingAnswersRef.delete(answerKey);
            return;
          }
        } else {
          // PC не в stable или уже имеет описания - проверяем другие состояния
          console.log('[WebRTCSession] ⚠️ [FRIEND CALL] PC in unexpected state for answer', {
            from,
            hasAnswer: !!answer,
            currentState: pc.signalingState,
            hasLocalDesc,
            hasRemoteDesc,
            roomId: this.roomIdRef,
            isFriendCall
          });
          // Для дружеских звонков не игнорируем answer - возможно offer придет позже
          // Но лучше подождать offer перед обработкой answer
          this.processingAnswersRef.delete(answerKey);
          return;
        }
        
        // Для рандомного чата обрабатываем другие состояния
        if (!isFriendCall) {
          if (pc.signalingState === 'stable' && !hasLocalDesc && !hasRemoteDesc) {
            // Для рандомного чата игнорируем answer в stable состоянии
            console.warn('[WebRTCSession] ⚠️ PC in stable state without local description, ignoring answer', {
              from,
              hasAnswer: !!answer,
              currentState: pc.signalingState,
              hasLocalDesc,
              hasRemoteDesc
            });
          } else {
            console.warn('[WebRTCSession] ⚠️ PC not in have-local-offer state (with local, without remote), dropping answer', {
              from,
              hasAnswer: !!answer,
              currentState: pc.signalingState,
              hasLocalDesc,
              hasRemoteDesc,
              expectedState: 'have-local-offer (with local, without remote)'
            });
          }
          this.processingAnswersRef.delete(answerKey);
          return;
        }
      }
      
      // Задержка для снятия гонки
      await new Promise(res => setTimeout(res, 150));
      
      const currentPcForAnswer = this.peerRef;
      if (!currentPcForAnswer || currentPcForAnswer !== pc) {
        console.warn('[WebRTCSession] PC was changed or removed');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      if (currentPcForAnswer.signalingState === 'have-local-offer') {
        try {
          if (currentPcForAnswer.connectionState === 'closed' || this.peerRef !== currentPcForAnswer) {
            console.warn('[WebRTCSession] PC is closed or changed');
            this.processingAnswersRef.delete(answerKey);
            return;
          }
          
          if (currentPcForAnswer.signalingState !== 'have-local-offer') {
            console.warn('[WebRTCSession] ⚠️ PC not in have-local-offer state before setRemoteDescription', {
              currentState: currentPcForAnswer.signalingState,
              expectedState: 'have-local-offer'
            });
            this.processingAnswersRef.delete(answerKey);
            return;
          }
          
          // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен ДО setRemoteDescription
          // БЕЗ ontrack вы НИКОГДА не увидите собеседника - это критично для всех типов звонков
          let hasOntrack = !!(currentPcForAnswer as any)?.ontrack;
          if (!hasOntrack && from) {
            this.attachRemoteHandlers(currentPcForAnswer, from);
            // Проверяем еще раз после установки
            hasOntrack = !!(currentPcForAnswer as any)?.ontrack;
            if (!hasOntrack) {
              console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler BEFORE setRemoteDescription in handleAnswer!');
            }
          } else if (!hasOntrack) {
            console.warn('[WebRTCSession] ⚠️ Cannot attach ontrack handler - no from ID', {
              from,
              hasOntrack: false
            });
          }
          
          // КРИТИЧНО: Преобразуем answer в RTCSessionDescription если нужно
          let answerDesc = answer;
          if (answer && typeof answer === 'object' && !answer.type) {
            // Если answer пришел как объект без type, создаем RTCSessionDescription
            answerDesc = { type: 'answer', sdp: answer.sdp || answer } as any;
          }
          
          // КРИТИЧНО: setRemoteDescription ОБЯЗАТЕЛЕН для работы WebRTC
          // Без этого соединение не установится
          await currentPcForAnswer.setRemoteDescription(answerDesc as any);
          
          // КРИТИЧНО: Фиксируем успешную обработку answer в processedAnswersRef
          // Это предотвращает повторные setRemoteDescription при повторной доставке
          this.processedAnswersRef.add(answerKey);
          // НЕ удаляем из processingAnswersRef - оставляем для защиты от дубликатов
          
          // КРИТИЧНО: Прожигаем отложенные ICE кандидаты ПОСЛЕ setRemoteDescription
          // Правильная последовательность: setRemoteDescription -> flushIceFor
          try {
            await this.flushIceFor(from);
          } catch (flushError) {
            console.warn('[WebRTCSession] Error flushing ICE candidates after setRemoteDescription:', flushError);
          }
          
          // КРИТИЧНО: Проверяем, что обработчик ontrack установлен после setRemoteDescription
          // setRemoteDescription может сбросить обработчик из-за внутренних операций WebRTC
          let hasOntrackAfterAnswer = !!(currentPcForAnswer as any)?.ontrack;
          
          // Если обработчик отсутствует, устанавливаем его снова СРАЗУ
          if (!hasOntrackAfterAnswer && from) {
            console.warn('[WebRTCSession] ontrack handler missing after setRemoteDescription in handleAnswer, reattaching immediately');
            this.attachRemoteHandlers(currentPcForAnswer, from);
            // Проверяем еще раз после переустановки
            hasOntrackAfterAnswer = !!(currentPcForAnswer as any)?.ontrack;
            if (!hasOntrackAfterAnswer) {
              console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler after setRemoteDescription in handleAnswer!');
            }
          }
          
          // КРИТИЧНО: Дополнительная проверка через небольшую задержку для защиты от race condition
          // Это гарантирует, что обработчик не потеряется из-за асинхронных операций
          setTimeout(() => {
            const pcAfterDelay = this.peerRef;
            if (pcAfterDelay === currentPcForAnswer && from) {
              const hasOntrackAfterDelay = !!(pcAfterDelay as any)?.ontrack;
              if (!hasOntrackAfterDelay) {
                console.warn('[WebRTCSession] ontrack handler lost after setRemoteDescription in handleAnswer (delayed check), reattaching');
                this.attachRemoteHandlers(pcAfterDelay, from);
              }
            }
          }, 50);
          
          // КРИТИЧНО: Проверяем receivers после установки answer (для всех типов звонков)
          // Это fallback механизм на случай, если ontrack не сработал
          // КРИТИЧНО: Для инициатора это особенно важно, так как он получает remote stream после answer
          if (from) {
            const isFriendCall = (this.config.getIsDirectCall?.() ?? false) ||
                                 (this.config.getInDirectCall?.() ?? false) ||
                                 (this.config.getFriendCallAccepted?.() ?? false);
            const isDirectCall = this.config.getIsDirectCall?.() ?? false;
            const inDirectCall = this.config.getInDirectCall?.() ?? false;
            const isDirectInitiator = this.config.getIsDirectInitiator?.() ?? false;
            const hasIncomingCall = this.config.getHasIncomingCall?.() ?? false;
            const isInitiator = isDirectInitiator || (!hasIncomingCall && isDirectCall && !inDirectCall);
            
            // Для дружеских звонков проверяем раньше и чаще
            // Для инициатора проверяем еще чаще, так как он получает remote stream после answer
            const delays = isFriendCall && isInitiator ? [200, 400, 800] : isFriendCall ? [300, 600, 1000] : [500];
            
            delays.forEach((delay) => {
              setTimeout(() => {
                const pcAfterAnswer = this.peerRef;
                if (pcAfterAnswer === currentPcForAnswer && this.partnerIdRef && !this.remoteStreamRef) {
                  if (isFriendCall && isInitiator) {
                    console.log('[WebRTCSession] [FRIEND CALL] [INITIATOR] Checking receivers for remote stream after answer', {
                      delay,
                      from
                    });
                  }
                  this.checkReceiversForRemoteStream(pcAfterAnswer);
                }
              }, delay);
            });
          }
          
          // КРИТИЧНО: Проверяем receivers через 2 секунды после установки answer
          // Это покажет, передаются ли треки от партнера
          setTimeout(() => {
            const pc = this.peerRef;
            if (!pc) {
              return;
            }
            
            try {
              const getReceiversFn = (pc as any).getReceivers;
              if (typeof getReceiversFn !== 'function') {
                console.warn('[WebRTCSession] getReceivers is not available on RTCPeerConnection - skipping receiver diagnostics');
                return;
              }
              const receivers: Array<RTCRtpReceiver | any> = getReceiversFn.call(pc);
              
              receivers.forEach((r: any, index: number) => {
              });
              
              // Проверяем наличие video receiver
              const videoReceiver = receivers.find((r: any) => r.track?.kind === 'video');
              if (!videoReceiver) {
                console.warn('[WebRTCSession] КРИТИЧНО: No video receiver found! Трек не передается или peer не присоединился правильно.');
              } else {
              }
              
              // Проверяем наличие audio receiver
              const audioReceiver = receivers.find((r: any) => r.track?.kind === 'audio');
              if (!audioReceiver) {
                console.warn('[WebRTCSession] No audio receiver found');
              } else {
              }
              
              // КРИТИЧНО: Fallback - если remoteStream не установлен, но есть receivers, создаем stream из них
              const isRandomChat = 
                !(this.config.getIsDirectCall?.() ?? false) &&
                !(this.config.getInDirectCall?.() ?? false) &&
                !(this.config.getFriendCallAccepted?.() ?? false);
              
              if (isRandomChat && !this.remoteStreamRef && receivers.length > 0) {
                this.checkReceiversForRemoteStream(pc);
              }
            } catch (e) {
              console.error('[WebRTCSession] Error checking receivers:', e);
            }
          }, 2000);
        } catch (error: any) {
          const errorMsg = String(error?.message || '');
          if (errorMsg.includes('closed') || errorMsg.includes('null') || errorMsg.includes('receiver') || errorMsg.includes('undefined') || errorMsg.includes('wrong state') || errorMsg.includes('stable')) {
            console.warn('[WebRTCSession] PC was closed or in wrong state during setRemoteDescription');
            return;
          }
          console.error('[WebRTCSession] Error setting remote description:', error);
          return;
        }
      }
      
      this.config.setStarted?.(true);
      
      // КРИТИЧНО: flushIceFor уже вызван сразу после setRemoteDescription выше
      // Не нужно вызывать здесь еще раз
      
      // Обновляем список друзей
      try {
        await this.config.fetchFriends?.();
      } catch {}
      
      // Отправляем состояние камеры
      setTimeout(() => {
        this.sendCameraState(from);
      }, 500);
    } catch (e) {
      console.error('[WebRTCSession] handleAnswer error:', e);
      // Удаляем из processingAnswersRef при ошибке, чтобы можно было повторить
      const pc = this.peerRef;
      const currentPcToken = pc ? ((pc as any)?._pcToken ?? this.pcToken) : this.pcToken;
      const answerKey = `answer_${from}_${currentPcToken}`;
      this.processingAnswersRef.delete(answerKey);
    }
  }
  
  private async handleCandidate({ from, candidate }: { from: string; candidate: any }): Promise<void> {
    const hasCandidate = !!candidate;
    
    if (!hasCandidate) {
      console.warn('[WebRTCSession] Received invalid candidate', { from });
      return;
    }
    
    try {
      const key = String(from || '');
      const pc = this.peerRef;
      
      // КРИТИЧНО: Проверяем наличие PC
      const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                           (this.config.getInDirectCall?.() ?? false) || 
                           (this.config.getFriendCallAccepted?.() ?? false);
      
      if (!pc) {
        if (isFriendCall) {
          // Для дружеских звонков кешируем ICE кандидаты, но с ограничением
          console.log('[WebRTCSession] ⚠️ [FRIEND CALL] ICE candidate received but no PC exists, queueing', { 
            from,
            roomId: this.roomIdRef
          });
        } else {
          // Для рандомного чата это нормально
          console.warn('[WebRTCSession] ⚠️ ICE candidate received but no PC exists, queueing', { from });
        }
        this.enqueueIce(key, candidate);
        return;
      }
      
      // КРИТИЧНО: Проверяем, что PC не закрыт и токен актуален
      // Ранний return для предотвращения обработки отложенных кандидатов после Next/cleanup
      if (!this.isPcValid(pc)) {
        console.warn('[WebRTCSession] ⚠️ ICE candidate received but PC is closed or token invalid, ignoring', {
          from,
          signalingState: pc.signalingState,
          connectionState: (pc as any).connectionState,
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем partnerId - если установлен, должен совпадать
      if (this.partnerIdRef && this.partnerIdRef !== from) {
        console.warn('[WebRTCSession] ⚠️ ICE candidate from different partner, ignoring', {
          from,
          currentPartnerId: this.partnerIdRef
        });
        return;
      }
      
      // КРИТИЧНО: Если remoteDescription ещё не установлен, но pcToken актуален — складируем кандидата
      // Правильная логика: setRemoteDescription должен быть вызван ПЕРЕД добавлением ICE-кандидатов
      // НЕ дропаем кандидат, если pcToken актуален, даже если remoteDescription еще нет или partnerId не установлен
      const hasRemoteDesc = !!(pc as any).remoteDescription && !!(pc as any).remoteDescription?.type;
      if (!hasRemoteDesc) {
        // pcToken актуален (проверено выше через isPcValid), но remoteDescription еще нет
        // Аккумулируем в pendingIceByFromRef для последующей обработки после setRemoteDescription
        const pendingCount = this.pendingIceByFromRef[key]?.length || 0;
        if (pendingCount === 0) {
        }
        this.enqueueIce(key, candidate);
        return;
      }
      
      // КРИТИЧНО: Добавляем ICE-кандидат ПОСЛЕ setRemoteDescription
      // Это правильная последовательность для WebRTC
      await pc.addIceCandidate(candidate);
    } catch (e: any) {
      const errorMsg = String(e?.message || '');
      // Игнорируем ошибки о дубликатах или неправильном состоянии
      if (errorMsg.includes('InvalidStateError') || errorMsg.includes('already exists') || errorMsg.includes('closed')) {
        console.warn('[WebRTCSession] ICE candidate add failed (expected in some cases):', errorMsg);
      } else {
        console.error('[WebRTCSession] ❌ Error adding ICE candidate:', e);
      }
    }
  }
  
  // ==================== Offer Creation (для инициатора) ====================
  
  async createAndSendOffer(toPartnerId: string, roomId?: string): Promise<void> {
    const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                         (this.config.getInDirectCall?.() ?? false) || 
                         (this.config.getFriendCallAccepted?.() ?? false);
    
    console.log('📤 [createAndSendOffer] Starting', {
      toPartnerId,
      roomId: roomId || this.roomIdRef,
      isFriendCall,
      hasPC: !!this.peerRef
    });
    
    try {
      const pc = this.peerRef;
      if (!pc) {
        if (isFriendCall) {
          console.log('📤 [createAndSendOffer] [FRIEND CALL] ❌ Cannot create offer - no PC', {
            toPartnerId,
            roomId: roomId || this.roomIdRef
          });
        } else {
          console.warn('[WebRTCSession] Cannot create offer - no PC');
        }
        return;
      }
      
      // КРИТИЧНО: Проверяем pcToken и что PC не закрыт
      if (!this.isPcValid(pc)) {
        console.warn('[WebRTCSession] Cannot create offer - PC is closed or token invalid', {
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken,
          signalingState: pc.signalingState
        });
        return;
      }
      
      // Проверяем состояние PC - должно быть 'stable' без localDescription и remoteDescription
      const signalingState = pc.signalingState;
      const hasLocalDesc = !!(pc as any)?.localDescription;
      const hasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (signalingState !== 'stable' || hasLocalDesc || hasRemoteDesc) {
        console.warn('[WebRTCSession] PC not in stable state (without descriptions) for offer creation', {
          signalingState,
          hasLocalDesc,
          hasRemoteDesc,
          expectedState: 'stable (no descriptions)'
        });
        return;
      }
      
      // Проверяем еще раз перед созданием
      const currentState = pc.signalingState;
      const currentHasLocalDesc = !!(pc as any)?.localDescription;
      const currentHasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (currentState !== 'stable' || currentHasLocalDesc || currentHasRemoteDesc) {
        console.warn('[WebRTCSession] PC state changed before offer creation', {
          signalingState: currentState,
          hasLocalDesc: currentHasLocalDesc,
          hasRemoteDesc: currentHasRemoteDesc
        });
        return;
      }
      
      // Проверка на завершенный звонок
      const isInactiveState = this.config.getIsInactiveState?.() ?? false;
      if (isInactiveState) {
        return;
      }
      
      // КРИТИЧНО: Проверяем что треки добавлены в PC перед созданием offer
      // Без треков может получиться sendonly вместо sendrecv
      const sendersBeforeOffer = pc.getSenders?.() || [];
      const audioSenders = sendersBeforeOffer.filter((s: any) => s?.track?.kind === 'audio');
      const videoSenders = sendersBeforeOffer.filter((s: any) => s?.track?.kind === 'video');
      
      // КРИТИЧНО: Проверяем, что треки не ended
      const endedAudioTracks = audioSenders.filter((s: any) => s?.track?.readyState === 'ended');
      const endedVideoTracks = videoSenders.filter((s: any) => s?.track?.readyState === 'ended');
      if (endedAudioTracks.length > 0 || endedVideoTracks.length > 0) {
        console.error('[WebRTCSession] ❌❌❌ CRITICAL: Tracks are ended before createOffer!', {
          endedAudioCount: endedAudioTracks.length,
          endedVideoCount: endedVideoTracks.length,
          totalAudioSenders: audioSenders.length,
          totalVideoSenders: videoSenders.length
        });
      }
      
      if (sendersBeforeOffer.length === 0) {
        console.error('[WebRTCSession] ❌❌❌ CRITICAL: No tracks in PC before createOffer! This will result in sendonly!');
      }
      
      // КРИТИЧНО: offerToReceiveAudio и offerToReceiveVideo должны быть true
      // Иначе получится sendonly вместо sendrecv
      // Оптимизация: используем voiceActivityDetection: false для уменьшения задержки
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true, 
        offerToReceiveVideo: true,
        voiceActivityDetection: false, // Отключаем VAD для уменьшения задержки
      } as any);
      
      // КРИТИЧНО: Проверяем SDP на наличие sendrecv
      if (offer.sdp) {
        const hasSendRecv = offer.sdp.includes('a=sendrecv');
        const hasSendOnly = offer.sdp.includes('a=sendonly');
        const hasRecvOnly = offer.sdp.includes('a=recvonly');
        if (hasSendOnly && !hasSendRecv) {
          console.error('[WebRTCSession] ❌❌❌ CRITICAL: Offer has sendonly instead of sendrecv! This means remote video will not work!');
        }
        if (!hasSendRecv && !hasSendOnly && !hasRecvOnly) {
          console.warn('[WebRTCSession] ⚠️ Offer SDP has no explicit direction - may default to sendonly');
        }
        
        // Оптимизация SDP для быстрого установления соединения
        offer.sdp = this.optimizeSdpForFastConnection(offer.sdp);
      }
      
      // Проверяем состояние еще раз перед setLocalDescription
      const finalState = pc.signalingState;
      const finalHasLocalDesc = !!(pc as any)?.localDescription;
      const finalHasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (finalState !== 'stable' || finalHasLocalDesc || finalHasRemoteDesc) {
        console.warn('[WebRTCSession] PC state changed between createOffer and setLocalDescription');
        return;
      }
      
      try {
        await pc.setLocalDescription(offer);
      } catch (setLocalError: any) {
        const errorState = pc.signalingState;
        const errorHasRemoteDesc = !!(pc as any)?.remoteDescription;
        if (errorState === 'have-remote-offer' || errorHasRemoteDesc) {
          console.warn('[WebRTCSession] PC state changed to have-remote-offer during setLocalDescription');
          return;
        }
        throw setLocalError;
      }
      
      // Отправляем offer
      const currentRoomId = roomId || this.roomIdRef;
      const isDirectFriendCall = 
        (this.config.getIsDirectCall?.() ?? false) ||
        (this.config.getInDirectCall?.() ?? false) ||
        (this.config.getFriendCallAccepted?.() ?? false);
      
      const offerPayload: any = {
        to: toPartnerId,
        offer,
        fromUserId: this.config.myUserId
      };
      
      if (isDirectFriendCall && currentRoomId) {
        offerPayload.roomId = currentRoomId;
      }
      
      socket.emit('offer', offerPayload);
      
      // КРИТИЧНО: Для дружеских звонков логируем успешную отправку offer
      if (isDirectFriendCall) {
        console.log('📤 [createAndSendOffer] [FRIEND CALL] ✅ Offer sent', {
          to: toPartnerId,
          roomId: currentRoomId,
          hasRoomId: !!currentRoomId
        });
      }
    } catch (e) {
      const isDirectFriendCall = 
        (this.config.getIsDirectCall?.() ?? false) ||
        (this.config.getInDirectCall?.() ?? false) ||
        (this.config.getFriendCallAccepted?.() ?? false);
      
      if (isDirectFriendCall) {
        console.log('📤 [createAndSendOffer] [FRIEND CALL] ❌ Error creating/sending offer', e, {
          to: toPartnerId,
          roomId: roomId || this.roomIdRef
        });
      } else {
        console.error('[WebRTCSession] Error creating/sending offer:', e);
      }
    }
  }
  
  // ==================== Stop/Next Handlers ====================
  
  private handleStop(force: boolean = false): void {
    const started = this.config.getStarted?.() ?? false;
    const isJustStarted = started && !this.partnerIdRef && !this.roomIdRef;
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new');
    
    
    // КРИТИЧНО: Не останавливаем если пользователь только что начал поиск
    // Это предотвращает остановку стрима сразу после нажатия "Начать"
    // НО: если force=true, останавливаем принудительно (например, при нажатии "Стоп")
    if (isJustStarted && !force) {
      return;
    }
    
    // КРИТИЧНО: НЕ обрабатываем handleStop если соединение активно
    // Проверяем наличие remoteStream И состояние PeerConnection
    // Даже при force=true НЕ очищаем remoteStream если соединение активно
    if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      const isPcActive = pc.iceConnectionState === 'checking' || 
                        pc.iceConnectionState === 'connected' || 
                        pc.iceConnectionState === 'completed' ||
                        (pc as any).connectionState === 'connecting' ||
                        (pc as any).connectionState === 'connected';
      
      if (isPcActive) {
        // КРИТИЧНО: Даже при force=true не очищаем remoteStream если соединение активно
        // Останавливаем только локальный стрим и сбрасываем флаги, но НЕ трогаем remoteStream
        if (force) {
          this.stopLocalStream(false).catch(() => {});
          this.config.setStarted?.(false);
          this.config.callbacks.onLoadingChange?.(false);
          this.config.onLoadingChange?.(false);
        }
        return;
      }
    }
    
    const oldPartnerId = this.partnerIdRef;
    
    // Останавливаем локальный стрим
    this.stopLocalStream(false).catch(() => {});
    
    // Очищаем PC
    if (this.peerRef) {
      // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
      this.incrementPcToken();
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // КРИТИЧНО: Очищаем remote stream только если соединение действительно разорвано
    // КРИТИЧНО: Всегда очищаем remote stream при остановке
    if (this.remoteStreamRef) {
      try {
        const tracks = this.remoteStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      this.remoteStreamRef = null;
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.emit('remoteStreamRemoved');
    }
    
    // Сбрасываем состояние remoteCamOn
    this.remoteCamOnRef = true;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.remoteInPiPRef = false;
    this.config.callbacks.onRemoteCamStateChange?.(true);
    this.config.onRemoteCamStateChange?.(true);
    this.emitRemoteState();
    
    // Очищаем идентификаторы
    this.partnerIdRef = null;
    this.roomIdRef = null;
    this.callIdRef = null;
    this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.onCallIdChange?.(null);
    this.emitSessionUpdate();
    
    // Эмитим события для UI
    this.emit('stopped');
    if (oldPartnerId) {
      this.emit('partnerChanged', { partnerId: null, oldPartnerId });
    }
  }
  
  private handleNext(force: boolean = false): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking');
    const isManualRequest = this.manuallyRequestedNextRef;
    
    
    // КРИТИЧНО: НЕ обрабатываем handleNext если соединение активно
    // Проверяем наличие remoteStream И состояние PeerConnection
    // КРИТИЧНО: Если есть remoteStream и PC не закрыт - это активное соединение
    // НО: при ручном запросе (isManualRequest) или принудительном разрыве (force) принудительно разрываем соединение
    if (!isManualRequest && !force && hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      // КРИТИЧНО: PC в состоянии 'new' тоже считается активным, если есть remoteStream
      // Это означает, что соединение только что установилось
      const isPcActive = pc.iceConnectionState === 'new' ||
                        pc.iceConnectionState === 'checking' || 
                        pc.iceConnectionState === 'connected' || 
                        pc.iceConnectionState === 'completed' ||
                        (pc as any).connectionState === 'new' ||
                        (pc as any).connectionState === 'connecting' ||
                        (pc as any).connectionState === 'connected';
      
      if (isPcActive) {
        return;
      }
    }
    
    // КРИТИЧНО: При ручном запросе или принудительном разрыве принудительно разрываем активное соединение
    if ((isManualRequest || force) && hasRemoteStream && pc) {
      // КРИТИЧНО: Инкрементируем токен перед закрытием, чтобы отложенные события игнорировались
      this.incrementPcToken();
      // Закрываем PeerConnection принудительно
      try {
        if (pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
          pc.close();
        }
      } catch (e) {
        logger.warn('[WebRTCSession] Error closing PC in handleNext:', e);
      }
    }
    
    const oldPartnerId = this.partnerIdRef;
    
    // КРИТИЧНО: НЕ останавливаем локальный стрим при переходе к следующему
    // Локальный стрим должен продолжать работать для автопоиска
    
    // КРИТИЧНО: Останавливаем только удаленный стрим, но НЕ если соединение активно
    if (this.remoteStreamRef) {
      try {
        const tracks = this.remoteStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      this.remoteStreamRef = null;
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.emit('remoteStreamRemoved');
    }
    
    // КРИТИЧНО: Обнуляем remoteCamOn в false при переходе к следующему пользователю
    // Это гарантирует, что UI сразу покажет заглушку "Отошел", пока не придет реальный видео-трек
    // Состояние камеры нового пользователя будет определено при получении remoteStream
    // через checkRemoteVideoTrack() на основе реального состояния трека
    this.remoteCamOnRef = false;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.remoteInPiPRef = false;
    // КРИТИЧНО: Эмитим состояние сразу, чтобы UI сразу выбрал заглушку
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.emitRemoteState();
    
    // Очищаем PC
    if (this.peerRef) {
      // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
      this.incrementPcToken();
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // КРИТИЧНО: Очищаем идентификаторы партнера и комнаты
    this.partnerIdRef = null;
    this.roomIdRef = null; // КРИТИЧНО: Очищаем roomId чтобы hasActiveConnection стал false
    this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.emitSessionUpdate();
    
    // Эмитим события для UI
    this.emit('nexted');
    if (oldPartnerId) {
      this.emit('partnerChanged', { partnerId: null, oldPartnerId });
    }
  }
  
  // ==================== Public Methods for Stop/Next ====================
  
  stop(): void {
    this.handleStop();
    try {
      socket.emit('stop');
    } catch (e) {
      logger.warn('[WebRTCSession] Error emitting stop:', e);
    }
  }
  
  next(): void {
    const wasStarted = this.config.getStarted?.() ?? false;
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking');
    
    
    // КРИТИЧНО: НЕ вызываем handleNext если соединение активно, НО разрешаем при ручном вызове
    // Проверяем наличие remoteStream И состояние PeerConnection
    // Если это ручной вызов (через nextRandom), всегда разрешаем переход к следующему
    const isManualRequest = this.manuallyRequestedNextRef;
    
    if (!isManualRequest && hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
      const isPcActive = pc.iceConnectionState === 'checking' || 
                        pc.iceConnectionState === 'connected' || 
                        pc.iceConnectionState === 'completed' ||
                        (pc as any).connectionState === 'connecting' ||
                        (pc as any).connectionState === 'connected';
      
      if (isPcActive) {
        return;
      }
    }
    
    if (isManualRequest) {
    }
    
    // КРИТИЧНО: Сначала отправляем событие на сервер, чтобы другой пользователь получил peer:left
    // Это гарантирует, что автопоиск запустится у обоих одновременно
    try {
      socket.emit('next');
    } catch (e) {
      logger.warn('[WebRTCSession] Error emitting next:', e);
    }
    
    // Затем обрабатываем локально (handleNext использует isManualRequest для принудительного разрыва)
    this.handleNext();
    
    // Сбрасываем флаг ручного запроса ПОСЛЕ handleNext, чтобы handleNext мог его использовать
    if (isManualRequest) {
      this.manuallyRequestedNextRef = false;
    }
    
    // КРИТИЧНО: После перехода к следующему запускаем автопоиск
    // Если это ручной запрос (isManualRequest), всегда запускаем поиск, даже если wasStarted=false
    // Это гарантирует, что при нажатии "Далее" всегда начинается новый поиск
    if (isManualRequest || wasStarted) {
      // КРИТИЧНО: Устанавливаем started=true перед autoNext, чтобы поиск точно запустился
      if (!wasStarted) {
        this.config.setStarted?.(true);
      }
      this.autoNext('manual_next');
    } else {
    }
  }
  
  // ==================== Socket Handlers Setup ====================
  
  private setupSocketHandlers(): void {
    
    // КРИТИЧНО: Добавляем глобальный обработчик для отладки всех событий socket
    // Это поможет увидеть, какие события приходят от сервера
    // Удаляем старый обработчик если он есть
    try {
      if ((socket as any)._webrtcDebugHandler) {
        socket.offAny((socket as any)._webrtcDebugHandler);
      }
      (socket as any)._webrtcDebugHandler = (event: string, ...args: any[]) => {
        // Логируем ВСЕ события для отладки
        if (event === 'offer' || event === 'answer' || event === 'ice-candidate' || event === 'match_found' || event === 'connect' || event === 'disconnect') {
        }
      };
      
      // Проверяем, что onAny существует
      if (typeof socket.onAny === 'function') {
        socket.onAny((socket as any)._webrtcDebugHandler);
      } else {
        console.error('[WebRTCSession] ⚠️⚠️⚠️ КРИТИЧНО: socket.onAny is NOT a function! ⚠️⚠️⚠️', {
          socketId: socket.id,
          socketConnected: socket.connected,
          socketType: typeof socket,
          socketKeys: Object.keys(socket || {}).slice(0, 20)
        });
      }
    } catch (e) {
      console.error('[WebRTCSession] ⚠️⚠️⚠️ КРИТИЧНО: Error setting up onAny handler ⚠️⚠️⚠️', e);
    }
    
    // КРИТИЧНО: НЕ удаляем обработчики перед регистрацией - это может привести к потере обработчиков
    // Вместо этого используем именованные функции для возможности удаления при необходимости
    // socket.off('offer');
    // socket.off('answer');
    
    // Создаем именованные обработчики для возможности их удаления
    const offerHandler = (data: any) => {
      this.handleOffer(data).catch(err => {
        logger.error('[WebRTCSession] Error in offer handler:', err);
      });
    };
    
    // КРИТИЧНО: Проверяем, есть ли уже обработчик перед удалением
    if ((this as any)._offerHandler) {
      socket.off('offer', (this as any)._offerHandler);
    }
    (this as any)._offerHandler = offerHandler;
    
    // КРИТИЧНО: Проверяем, что обработчик зарегистрирован
    
    // КРИТИЧНО: Регистрируем обработчик с проверкой
    try {
      socket.on('offer', offerHandler);
    } catch (e) {
      console.error('[WebRTCSession] ❌❌❌ ERROR registering offer handler ❌❌❌', e);
    }
    
    // КРИТИЧНО: Проверяем, что обработчик действительно зарегистрирован
    setTimeout(() => {
      // Проверяем, что обработчик все еще зарегистрирован
      const hasListener = (socket as any).listeners && (socket as any).listeners('offer')?.length > 0;
      const listenerCount = (socket as any).listeners?.('offer')?.length || 0;
    }, 100);
    
    const answerHandler = (data: any) => {
      this.handleAnswer(data).catch(err => {
        logger.error('[WebRTCSession] Error in answer handler:', err);
      });
    };
    
    // КРИТИЧНО: Проверяем, есть ли уже обработчик перед удалением
    if ((this as any)._answerHandler) {
      socket.off('answer', (this as any)._answerHandler);
    }
    (this as any)._answerHandler = answerHandler;
    
    // КРИТИЧНО: Проверяем, что обработчик зарегистрирован
    
    // КРИТИЧНО: Регистрируем обработчик с проверкой
    try {
      socket.on('answer', answerHandler);
    } catch (e) {
      console.error('[WebRTCSession] ❌❌❌ ERROR registering answer handler ❌❌❌', e);
    }
    
    // КРИТИЧНО: Проверяем, что обработчик действительно зарегистрирован
    setTimeout(() => {
      // Проверяем, что обработчик все еще зарегистрирован
      const hasListener = (socket as any).listeners && (socket as any).listeners('answer')?.length > 0;
      const listenerCount = (socket as any).listeners?.('answer')?.length || 0;
    }, 100);
    
    socket.on('ice-candidate', (data: any) => {
      this.handleCandidate(data).catch(err => {
        logger.error('[WebRTCSession] Error in candidate handler:', err);
      });
    });
    
    socket.on('peer:stopped', () => {
      // КРИТИЧНО: peer:stopped может прийти как при stop, так и при next
      // Если есть активное соединение (partnerId или roomId), это означает что партнер нажал "Далее"
      // В этом случае вызываем handleNext() вместо handleStop(), чтобы не останавливать локальный стрим
      const wasStarted = this.config.getStarted?.() ?? false;
      const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
      const hasRemoteStream = !!this.remoteStreamRef;
      const pc = this.peerRef;
      const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking');
      
      
      // КРИТИЧНО: Если есть активное соединение (hasActiveConnection), это означает что партнер нажал "Далее"
      // В этом случае ПРИНУДИТЕЛЬНО разрываем соединение и запускаем новый поиск
      // Проверяем hasActiveConnection вместо wasStarted, так как wasStarted может быть false
      if (hasActiveConnection || wasStarted) {
        
        // КРИТИЧНО: Принудительно разрываем соединение если оно еще активно
        if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
          const isPcActive = pc.iceConnectionState === 'checking' || 
                            pc.iceConnectionState === 'connected' || 
                            pc.iceConnectionState === 'completed' ||
                            (pc as any).connectionState === 'connecting' ||
                            (pc as any).connectionState === 'connected';
          
          if (isPcActive) {
            try {
              // КРИТИЧНО: Инкрементируем токен перед закрытием, чтобы отложенные события игнорировались
              this.incrementPcToken();
              pc.close();
              // КРИТИЧНО: Сразу очищаем PC после закрытия, чтобы новый match_found не использовал старый PC
              this.cleanupPeer(pc);
              this.peerRef = null;
            } catch (e) {
              logger.warn('[WebRTCSession] Error force closing PC in peer:stopped:', e);
            }
          }
        }
        
        // КРИТИЧНО: Сразу устанавливаем loading=true и started=true, чтобы не было мелькания "Собеседник"
        this.config.setStarted?.(true);
        this.config.onLoadingChange?.(true);
        this.config.setIsInactiveState?.(false);
        this.emit('searching');
        
        // Обрабатываем разрыв соединения с флагом force=true, чтобы принудительно обработать разрыв
        this.handleNext(true);
        // Запускаем автопоиск если чат был запущен (без задержки)
        this.autoNext('peer_stopped_during_search');
      } else {
        // Если поиск не активен и нет активного соединения, это действительно stop
        this.handleStop();
      }
    });
    
    socket.on('peer:left', () => {
      const wasStarted = this.config.getStarted?.() ?? false;
      const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
      const hasRemoteStream = !!this.remoteStreamRef;
      const pc = this.peerRef;
      const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking');
      
      
      // КРИТИЧНО: НЕ обрабатываем peer:left если соединение активно
      // Проверяем наличие remoteStream И состояние PeerConnection
      if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
        const isPcActive = pc.iceConnectionState === 'checking' || 
                          pc.iceConnectionState === 'connected' || 
                          pc.iceConnectionState === 'completed' ||
                          (pc as any).connectionState === 'connecting' ||
                          (pc as any).connectionState === 'connected';
        
        if (isPcActive) {
          return;
        }
      }
      
      // КРИТИЧНО: При получении peer:left обрабатываем переход к следующему
      // НЕ останавливаем локальный стрим - он должен продолжать работать
      
      // КРИТИЧНО: При отключении партнера запускаем автопоиск если чат был запущен
      // Это гарантирует, что автопоиск запустится у обоих пользователей одновременно
      if (wasStarted) {
        
        // КРИТИЧНО: Сразу устанавливаем loading=true и started=true, чтобы не было мелькания "Собеседник"
        this.config.setStarted?.(true);
        this.config.onLoadingChange?.(true);
        this.config.setIsInactiveState?.(false);
        this.emit('searching');
        
        this.handleNext();
        this.autoNext('partner_left');
      } else {
        this.handleNext();
      }
    });
    
    socket.on('pip:state', (data: { inPiP: boolean; from: string; roomId: string }) => {
      this.handlePiPState(data);
    });
    
    // Обработчики для дружеских звонков (call:incoming, call:accepted, call:declined)
    // Эти события обрабатываются в основном в компоненте, но session может помочь с WebRTC частью
    socket.on('call:incoming', (data: any) => {
      this.handleCallIncoming(data);
    });
    
    socket.on('call:accepted', (data: any) => {
      this.handleCallAccepted(data).catch(err => {
        logger.error('[WebRTCSession] Error in handleCallAccepted:', err);
      });
    });
    
    socket.on('call:declined', (data: any) => {
      this.handleCallDeclined(data);
    });
    
    socket.on('call:ended', (data: any) => {
      console.log('📥 [socket.on] Received call:ended event', {
        data,
        roomId: this.roomIdRef,
        callId: this.callIdRef,
        partnerId: this.partnerIdRef
      });
      this.handleExternalCallEnded('server_call_ended', data);
    });
    
    socket.on('disconnected', () => {
      this.handleRandomDisconnected('server');
    });
    
    socket.on('hangup', () => {
      this.handleRandomDisconnected('server');
    });
    
    // Обработчик match_found для рандомного чата
    const matchFoundHandler = (data: { id: string; userId?: string; roomId?: string }) => {
      this.handleMatchFound(data).catch(err => {
        logger.error('[WebRTCSession] Error in match_found handler:', err);
      });
    };
    
    // Удаляем старый обработчик если он есть
    if ((this as any)._matchFoundHandler) {
      socket.off('match_found', (this as any)._matchFoundHandler);
    }
    (this as any)._matchFoundHandler = matchFoundHandler;
    
    
    // КРИТИЧНО: Регистрируем обработчик с проверкой
    try {
      socket.on('match_found', matchFoundHandler);
    } catch (e) {
      console.error('[WebRTCSession] ❌❌❌ ERROR registering match_found handler ❌❌❌', e);
    }
    
    // КРИТИЧНО: Проверяем, что обработчик действительно зарегистрирован
    setTimeout(() => {
      const hasListener = (socket as any).listeners && (socket as any).listeners('match_found')?.length > 0;
      const listenerCount = (socket as any).listeners?.('match_found')?.length || 0;
    }, 100);
    
    // Обработчик cam-toggle для управления состоянием удаленной камеры
    socket.on('cam-toggle', (data: { enabled: boolean; from: string; roomId?: string }) => {
      this.handleCamToggle(data);
    });
  }
  
  // ==================== Cam Toggle Handler ====================
  
  private handleCamToggle({ enabled, from, roomId }: { enabled: boolean; from: string; roomId?: string }): void {
    const currentPartnerId = this.partnerIdRef;
    const currentRoomId = this.roomIdRef;
    const isDirectFriendCall = 
      (this.config.getIsDirectCall?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getFriendCallAccepted?.() ?? false);
    
    // Проверяем, нужно ли обрабатывать это событие
    // Для прямых звонков: обрабатываем если from совпадает с partnerId, или если partnerId еще не установлен, или если roomId совпадает
    // Для рандомного чата: обрабатываем только если from совпадает с partnerId
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
    
    // КРИТИЧНО: Для рандомного чата проверяем фактическое состояние видео трека
    // Игнорируем ТОЛЬКО ложные cam-toggle с enabled=false при установке соединения
    // НЕ игнорируем реальные события выключения камеры от пользователя
    // Для прямых звонков НЕ игнорируем - если пришло enabled=false, значит камера действительно выключена
    if (!isDirectFriendCall) {
      const rs = this.remoteStreamRef;
      if (rs) {
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        // КРИТИЧНО: Для рандомного чата игнорируем enabled=false ТОЛЬКО если:
        // 1. Трек существует и не завершен (readyState !== 'ended')
        // 2. И соединение установлено недавно (менее 5 секунд назад) И трек еще не полностью инициализирован
        // НЕ проверяем vt.enabled === true, так как это может быть реальное выключение камеры
        // Это предотвращает только ложное отключение видео при установке соединения
        if (vt && vt.readyState !== 'ended' && !enabled) {
          const now = Date.now();
          const connectionAge = now - this.connectionEstablishedAtRef;
          const isRecentConnection = connectionAge < 5000; // 5 секунд после установки соединения (увеличено с 3)
          const isTrackNotFullyLive = vt.readyState !== 'live';
          
          // КРИТИЧНО: Проверяем стабильность трека - трек должен быть live и иметь достаточный возраст
          const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
          const isTrackStable = vt.readyState === 'live' && streamAge >= 300; // Трек должен быть live и существовать минимум 300ms
          
          // Игнорируем enabled=false ТОЛЬКО если:
          // - Трек еще не полностью инициализирован (readyState !== 'live') И соединение установлено недавно
          // ИЛИ трек не стабилен (не live или слишком новый)
          // НЕ игнорируем если трек уже live и стабилен - это может быть реальное выключение камеры
          if ((isTrackNotFullyLive || !isTrackStable) && isRecentConnection) {
            return;
          }
        }
      } else if (!enabled) {
        // Если remoteStream еще не установлен и приходит enabled=false - игнорируем только если соединение недавно
        const now = Date.now();
        const connectionAge = now - this.connectionEstablishedAtRef;
        const isRecentConnection = connectionAge < 5000; // 5 секунд после установки соединения (увеличено с 3)
        
        if (isRecentConnection) {
          return;
        }
      }
    }
    
    // КРИТИЧНО: Сначала проверяем, нужно ли обновлять remoteCamOn
    // Затем обновляем vt.enabled и remoteCamOn одновременно
    // Это гарантирует, что заглушка "Отошел" показывается сразу при выключении камеры
    let shouldUpdateRemoteCamOn = true;
    
    if (!isDirectFriendCall) {
      // Для рандомного чата игнорируем enabled=false ТОЛЬКО если соединение установлено недавно
      // И трек еще не полностью инициализирован или не стабилен - это предотвращает ложное отключение при установке соединения
      // НЕ проверяем vt.enabled === true, так как это может быть реальное выключение камеры
      if (!enabled) {
        const now = Date.now();
        const connectionAge = now - this.connectionEstablishedAtRef;
        const isRecentConnection = connectionAge < 5000; // 5 секунд после установки соединения (увеличено с 3)
        
        const rs = this.remoteStreamRef;
        if (rs) {
          const vt = (rs as any)?.getVideoTracks?.()?.[0];
          
          // КРИТИЧНО: Проверяем стабильность трека - трек должен быть live и иметь достаточный возраст
          const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
          const isTrackStable = vt && vt.readyState === 'live' && streamAge >= 300; // Трек должен быть live и существовать минимум 300ms
          
          // КРИТИЧНО: Игнорируем enabled=false ТОЛЬКО если:
          // - Соединение установлено недавно (менее 5 секунд) И трек еще не полностью инициализирован (readyState !== 'live')
          // ИЛИ трек не стабилен (не live или слишком новый)
          // НЕ игнорируем если трек уже live и стабилен - это может быть реальное выключение камеры
          // НЕ проверяем vt.enabled, так как это может быть реальное выключение камеры
          if (isRecentConnection && vt && vt.readyState !== 'ended' && (!isTrackStable || vt.readyState !== 'live')) {
            shouldUpdateRemoteCamOn = false;
          }
        } else if (isRecentConnection) {
          // Если remoteStream еще не установлен и соединение недавно - игнорируем
          shouldUpdateRemoteCamOn = false;
        }
      }
      // Если enabled=true - всегда обновляем
    }
    
    // КРИТИЧНО: Обновляем состояние трека
    // Обновляем enabled для всех состояний трека, кроме 'ended'
    // Это важно, чтобы заглушка "Отошел" показывалась сразу при выключении камеры
    try {
      const rs = this.remoteStreamRef;
      const vt = rs ? (rs as any)?.getVideoTracks?.()?.[0] : null;
      const pc = this.peerRef;
      
      if (vt) {
        if (vt.readyState !== 'ended') {
          // КРИТИЧНО: Проверяем стабильность трека перед применением cam-toggle для рандомного чата
          // Трек должен быть live и иметь достаточный возраст (минимум 300ms) для стабильности
          // Это предотвращает применение cam-toggle к нестабильным трекам при быстром переключении
          if (!isDirectFriendCall && !enabled) {
            const now = Date.now();
            const streamAge = this.remoteStreamEstablishedAtRef ? now - this.remoteStreamEstablishedAtRef : Infinity;
            const isTrackLive = vt.readyState === 'live';
            const isTrackStable = isTrackLive && streamAge >= 300; // Трек должен быть live и существовать минимум 300ms
            
            if (!isTrackStable) {
              // Трек не стабилен и приходит enabled=false - это может быть временное состояние
              // Не применяем сразу, подождем стабилизации трека
              // Оставляем отложенное состояние для последующего применения
              return;
            }
          }
          
          // Для enabled=true всегда применяем, даже если трек не стабилен
          // Для enabled=false применяем только если трек стабилен (для рандомного чата) или это прямой звонок
          
          // Трек активен и стабилен (или это прямой звонок) - обновляем его enabled
          vt.enabled = enabled;
          // Очищаем отложенное состояние, так как мы успешно применили его
          this.pendingCamToggleRef = null;
        } else {
          // Трек уже завершен (ended) - это может быть из-за быстрого переключения или закрытия соединения
          // Проверяем, что соединение еще активно и партнер тот же (или партнер еще не установлен, но from совпадает)
          const isPcActive = pc && 
            pc.signalingState !== 'closed' && 
            (pc as any).connectionState !== 'closed';
          
          // Проверяем, что партнер совпадает (или еще не установлен, но событие прошло проверку shouldProcess)
          const isPartnerMatch = !this.partnerIdRef || this.partnerIdRef === from;
          
          if (isPcActive && isPartnerMatch) {
            // Соединение активно, но трек ended - это может быть временное состояние
            // Обновляем только состояние remoteCamOnRef, не трогая трек
            // Это позволит UI правильно отобразить состояние камеры
            // Трек может быть восстановлен позже через новый ontrack
            // Не выводим предупреждение - это нормальная ситуация при быстрых переключениях
            // Очищаем отложенное состояние, так как мы обработали событие
            this.pendingCamToggleRef = null;
          } else {
            // Соединение закрыто или партнер изменился - игнорируем событие
            // Это событие относится к уже закрытому соединению или другому партнеру
            // Не выводим предупреждение - это нормальная ситуация при быстрых переключениях
            return; // Выходим раньше, не обновляя состояние
          }
        }
      } else {
        // КРИТИЧНО: Если remoteStream еще не установлен, сохраняем состояние для последующего применения
        // Это решает проблему, когда cam-toggle приходит до установки remoteStream
        if (!rs) {
          this.pendingCamToggleRef = {
            enabled,
            from,
            timestamp: Date.now()
          };
          // Не выводим предупреждение - это нормальная ситуация при быстрых переключениях
        } else {
          // Если remoteStream есть, но нет видео трека - это реальная проблема
          console.warn('[WebRTCSession] cam-toggle: No video track found in remoteStream', {
            enabled,
            from,
            hasRemoteStream: !!rs
          });
        }
      }
    } catch (e) {
      logger.warn('[WebRTCSession] Error updating remote track:', e);
    }
    
    // Обновляем состояние
    this.camToggleSeenRef = true;
    
    // КРИТИЧНО: ВСЕГДА обновляем remoteViewKey для принудительного перерендера UI
    // Это гарантирует, что UI увидит изменения в vt.enabled даже если remoteCamOn не обновляется
    this.remoteViewKeyRef = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
    
    if (shouldUpdateRemoteCamOn) {
      const oldRemoteCamOn = this.remoteCamOnRef;
      this.remoteForcedOffRef = !enabled;
      this.remoteCamOnRef = enabled;
      
      // Уведомляем UI
      this.config.callbacks.onRemoteCamStateChange?.(enabled);
      this.config.onRemoteCamStateChange?.(enabled);
      this.emit('remoteCamStateChanged', enabled);
      this.emitRemoteState();
    } else {
      // КРИТИЧНО: Даже если не обновляем remoteCamOn через shouldUpdateRemoteCamOn,
      // ВСЕГДА обновляем remoteCamOn согласно полученному enabled для правильного отображения заглушки
      // Это важно для рандомного чата, где shouldUpdateRemoteCamOn может быть false
      const oldRemoteCamOn = this.remoteCamOnRef;
      this.remoteForcedOffRef = !enabled;
      this.remoteCamOnRef = enabled;
      this.remoteViewKeyRef = Date.now();
      
      // Уведомляем UI
      this.config.callbacks.onRemoteCamStateChange?.(enabled);
      this.config.onRemoteCamStateChange?.(enabled);
      this.emit('remoteCamStateChanged', enabled);
      this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
      this.emitRemoteState();
    }
  }
  
  // ==================== Apply Pending Cam Toggle ====================
  
  /**
   * Применяет отложенное состояние cam-toggle, если оно было сохранено до установки remoteStream
   * Вызывается автоматически при установке remoteStream
   */
  private applyPendingCamToggle(): void {
    if (!this.pendingCamToggleRef) {
      return;
    }
    
    const pending = this.pendingCamToggleRef;
    const currentPartnerId = this.partnerIdRef;
    
    // Проверяем, что отложенное состояние актуально:
    // 1. partnerId совпадает (или еще не установлен)
    // 2. Не слишком старое (менее 5 секунд)
    const isRecent = Date.now() - pending.timestamp < 5000;
    const isRelevant = !currentPartnerId || currentPartnerId === pending.from;
    
    if (!isRecent || !isRelevant) {
      // Отложенное состояние устарело или не относится к текущему партнеру
      this.pendingCamToggleRef = null;
      return;
    }
    
    // Проверяем, что remoteStream теперь установлен
    const rs = this.remoteStreamRef;
    if (!rs) {
      return; // remoteStream еще не установлен, оставляем состояние отложенным
    }
    
    const vt = (rs as any)?.getVideoTracks?.()?.[0];
    if (!vt || vt.readyState === 'ended') {
      // Трек еще не готов или уже завершен
      this.pendingCamToggleRef = null;
      return;
    }
    
    // Применяем отложенное состояние
    try {
      vt.enabled = pending.enabled;
      
      // Обновляем состояние камеры
      this.remoteForcedOffRef = !pending.enabled;
      this.remoteCamOnRef = pending.enabled;
      this.camToggleSeenRef = true;
      
      // Уведомляем UI
      this.config.callbacks.onRemoteCamStateChange?.(pending.enabled);
      this.config.onRemoteCamStateChange?.(pending.enabled);
      this.emit('remoteCamStateChanged', pending.enabled);
      this.emitRemoteState();
      
      // Очищаем отложенное состояние
      this.pendingCamToggleRef = null;
    } catch (e) {
      logger.warn('[WebRTCSession] Error applying pending cam-toggle:', e);
      this.pendingCamToggleRef = null;
    }
  }
  
  // ==================== Match Found Handler ====================
  
  private async handleMatchFound(data: { id: string; userId?: string | null; roomId?: string }): Promise<void> {
    
    const partnerId = data.id;
    const roomId = data.roomId;
    const { userId } = data;
    
    // КРИТИЧНО: Обнуляем remoteCamOn в false при новом match_found
    // Это гарантирует, что UI сразу покажет заглушку "Отошел", пока не придет реальный видео-трек
    this.remoteCamOnRef = false;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.emitRemoteState();
    
    // КРИТИЧНО: Очищаем отложенное состояние cam-toggle при новом match_found
    // Старое отложенное состояние не относится к новому партнеру
    this.pendingCamToggleRef = null;
    
    // Устанавливаем partnerId
    if (partnerId) {
      const oldPartnerId = this.partnerIdRef;
      this.partnerIdRef = partnerId;
      this.config.callbacks.onPartnerIdChange?.(partnerId);
      this.config.onPartnerIdChange?.(partnerId);
      this.emit('partnerChanged', { partnerId, oldPartnerId });
      this.emitSessionUpdate();
      
      // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId
      this.flushOutgoingIceCache();
      // КРИТИЧНО: Также вызываем flushIceFor для обработки pending ICE кандидатов
      this.flushIceFor(partnerId).catch(err => {
        console.warn('[WebRTCSession] Error flushing ICE for partnerId in handleMatchFound:', err);
      });
    }
    
    // Устанавливаем roomId если есть
    if (roomId) {
      this.roomIdRef = roomId;
      this.config.callbacks.onRoomIdChange?.(roomId);
      this.config.onRoomIdChange?.(roomId);
      this.emitSessionUpdate();
    }
    
    // КРИТИЧНО: Создаем PC сразу после match_found для рандомного чата
    // Это гарантирует, что PC существует и обработчик ontrack установлен ДО получения offer/answer
    const isRandomChat = 
      !(this.config.getIsDirectCall?.() ?? false) &&
      !(this.config.getInDirectCall?.() ?? false) &&
      !(this.config.getFriendCallAccepted?.() ?? false);
    
    // КРИТИЧНО: Проверяем наличие PC и его состояние
    // Если PC закрыт, очищаем его перед созданием нового
    if (this.peerRef) {
      const pc = this.peerRef;
      if (pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        this.cleanupPeer(pc);
        this.peerRef = null;
      }
    }
    
    if (isRandomChat && partnerId && !this.peerRef) {
      
      // Получаем локальный стрим
      let stream = this.localStreamRef;
      if (!stream || !isValidStream(stream)) {
        stream = await this.startLocalStream();
        if (!stream || !isValidStream(stream)) {
          console.error('[WebRTCSession] Failed to start local stream after match_found');
          return;
        }
      }
      
      // Создаем PC с локальным стримом
      const pc = await this.ensurePcWithLocal(stream);
      if (!pc) {
        console.error('[WebRTCSession] Failed to create PC after match_found');
        return;
      }
      
      
      // КРИТИЧНО: Убеждаемся, что обработчик ontrack установлен
      this.attachRemoteHandlers(pc, partnerId);
      
      // КРИТИЧНО: Проверяем еще раз, что обработчик установлен СРАЗУ
      let hasOntrack = !!(pc as any)?.ontrack;
      if (!hasOntrack) {
        console.error('[WebRTCSession] КРИТИЧНО: ontrack handler missing after attachRemoteHandlers in handleMatchFound! Retrying...');
        this.attachRemoteHandlers(pc, partnerId);
        // Проверяем еще раз после повторной установки
        hasOntrack = !!(pc as any)?.ontrack;
        if (!hasOntrack) {
          console.error('[WebRTCSession] ❌❌❌ CRITICAL: Failed to attach ontrack handler in handleMatchFound even after retry!');
        }
      }
      
      // КРИТИЧНО: Дополнительная проверка через небольшую задержку для защиты от race condition
      setTimeout(() => {
        const pcAfterDelay = this.peerRef;
        if (pcAfterDelay === pc && partnerId) {
          const hasOntrackAfterDelay = !!(pcAfterDelay as any)?.ontrack;
          if (!hasOntrackAfterDelay) {
            console.warn('[WebRTCSession] ontrack handler lost after attachRemoteHandlers in handleMatchFound (delayed check), reattaching');
            this.attachRemoteHandlers(pcAfterDelay, partnerId);
          }
        }
      }, 50);
    }
    
    // Эмитим событие matchFound
    this.emit('matchFound', {
      partnerId,
      roomId: roomId || null,
      userId: userId ?? null,
    });
  }
  
  // ==================== Call Event Handlers ====================
  
  private handleCallIncoming(data: { from: string; nick?: string; callId?: string }): void {
    
    // Устанавливаем callId если есть
    if (data.callId) {
      this.callIdRef = data.callId;
      this.config.callbacks.onCallIdChange?.(data.callId);
      this.config.onCallIdChange?.(data.callId);
      this.emitSessionUpdate();
    }
    
    // Устанавливаем partnerId если есть
    if (data.from && !this.partnerIdRef) {
      const oldPartnerId = this.partnerIdRef;
      this.partnerIdRef = data.from;
      this.config.callbacks.onPartnerIdChange?.(data.from);
      this.config.onPartnerIdChange?.(data.from);
      this.emit('partnerChanged', { partnerId: data.from, oldPartnerId });
      this.emitSessionUpdate();
      // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId
      this.flushOutgoingIceCache();
    }
    
    // Эмитим событие входящего звонка
    this.emit('incomingCall', {
      callId: data.callId,
      fromUser: data.from,
      fromNick: data.nick
    });
  }
  
  private   async handleCallAccepted(data: any): Promise<void> {
    console.log('🔥🔥🔥 [handleCallAccepted] ПОЛУЧЕНО call:accepted СОБЫТИЕ', {
      callId: data.callId,
      roomId: data.roomId,
      from: data.from,
      fromUserId: data.fromUserId,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef,
      hasPeerConnection: !!this.peerRef,
      hasLocalStream: !!this.localStreamRef,
      isProcessing: this.callAcceptedProcessingRef
    });
    
    // КРИТИЧНО: Защита от множественной обработки call:accepted
    if (this.callAcceptedProcessingRef) {
      console.log('🔥⏭️ [handleCallAccepted] Уже обрабатывается, пропускаем дубликат', {
        callId: data.callId
      });
      return;
    }
    this.callAcceptedProcessingRef = true;
    
    try {
    // Устанавливаем callId
    if (data.callId) {
      this.callIdRef = data.callId;
      this.config.callbacks.onCallIdChange?.(data.callId);
      this.config.onCallIdChange?.(data.callId);
      console.log('🔥✅ [handleCallAccepted] CALLID УСТАНОВЛЕН В SESSION', { 
        callId: data.callId,
        previousCallId: this.callIdRef 
      });
      this.emitSessionUpdate();
    } else {
      logger.error('🔥❌ [handleCallAccepted] НЕТ CALLID В СОБЫТИИ!', { data });
    }
    
    // Устанавливаем roomId если есть
    if (data.roomId) {
      this.roomIdRef = data.roomId;
      this.config.callbacks.onRoomIdChange?.(data.roomId);
      this.config.onRoomIdChange?.(data.roomId);
      console.log('🔥✅ [handleCallAccepted] ROOMID УСТАНОВЛЕН В SESSION', { 
        roomId: data.roomId,
        previousRoomId: this.roomIdRef 
      });
      this.emitSessionUpdate();
      
      // Отправляем подтверждение присоединения к комнате
      // КРИТИЧНО: Проверяем, не присоединились ли мы уже к этой комнате
      if (!this.roomJoinedRef.has(data.roomId)) {
        try {
          socket.emit('room:join:ack', { roomId: data.roomId });
          this.roomJoinedRef.add(data.roomId); // Отмечаем, что присоединились
          console.log('🔥✅ [handleCallAccepted] room:join:ack ОТПРАВЛЕН', { roomId: data.roomId });
        } catch (e) {
          logger.error('🔥❌ [handleCallAccepted] ОШИБКА ОТПРАВКИ room:join:ack', e);
        }
      } else {
        console.log('🔥⏭️ [handleCallAccepted] room:join:ack УЖЕ ОТПРАВЛЕН', { roomId: data.roomId });
      }
    } else {
      logger.error('🔥❌ [handleCallAccepted] НЕТ ROOMID В СОБЫТИИ!', { data });
    }
    
    // Устанавливаем partnerId если есть
    if (data.fromUserId) {
      const oldPartnerId = this.partnerIdRef;
      this.partnerIdRef = data.fromUserId;
      this.config.callbacks.onPartnerIdChange?.(data.fromUserId);
      this.config.onPartnerIdChange?.(data.fromUserId);
      this.emit('partnerChanged', { partnerId: data.fromUserId, oldPartnerId });
      this.emitSessionUpdate();
      // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId
      this.flushOutgoingIceCache();
    }
    
    // Сбрасываем неактивное состояние если оно было установлено
    const isInactiveState = this.config.getIsInactiveState?.() ?? false;
    if (isInactiveState) {
      this.config.setIsInactiveState?.(false);
      this.config.setWasFriendCallEnded?.(false);
    }
    
    // КРИТИЧНО: Для получателя звонка НЕ создаем PC заранее
    // PC будет создан в handleOffer когда придет offer
    // Это предотвращает создание дублирующих PC
    const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                         (this.config.getInDirectCall?.() ?? false) || 
                         (this.config.getFriendCallAccepted?.() ?? false);
    
    if (isFriendCall) {
      const isDirectCall = this.config.getIsDirectCall?.() ?? false;
      const inDirectCall = this.config.getInDirectCall?.() ?? false;
      const isDirectInitiator = this.config.getIsDirectInitiator?.() ?? false;
      const hasIncomingCall = this.config.getHasIncomingCall?.() ?? false;
      
      // КРИТИЧНО: Инициатор определяется по isDirectInitiator из route params
      // Если isDirectInitiator = true, то это инициатор (начал звонок)
      // Если isDirectInitiator = false И inDirectCall = true, то это receiver (принял входящий звонок)
      // Если оба false, используем fallback: инициатор = isDirectCall && !inDirectCall
      const isInitiator = isDirectInitiator || (!hasIncomingCall && isDirectCall && !inDirectCall);
      const isReceiver = !isDirectInitiator && (hasIncomingCall || inDirectCall);

      if (isInitiator && !isReceiver) {
        // КРИТИЧНО: Для инициатора создаем и отправляем offer после принятия звонка
        console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] Call accepted, creating and sending offer', {
          roomId: this.roomIdRef,
          callId: this.callIdRef,
          partnerId: this.partnerIdRef,
          hasPC: !!this.peerRef
        });
        
        // Убеждаемся, что есть локальный стрим
        let stream = this.localStreamRef;
        if (!stream) {
          try {
            stream = await this.startLocalStream('front');
            if (!stream) {
              console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ❌ Failed to create local stream');
              return;
            }
          } catch (e) {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] Error creating stream', e);
            return;
          }
        }
        
        // КРИТИЧНО: Убеждаемся, что есть PC (должен быть создан в callFriend)
        // Если PC отсутствует, создаем его, но это не должно происходить в нормальном сценарии
        let pc = this.peerRef;
        if (!pc) {
          console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ⚠️ No PC found, creating one', {
            roomId: this.roomIdRef,
            hasLocalStream: !!stream
          });
          pc = await this.ensurePcWithLocal(stream);
          if (!pc) {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ❌ Failed to create PC');
            return;
          }
          // КРИТИЧНО: Убеждаемся, что PC сохранен в peerRef
          if (this.peerRef !== pc) {
            this.peerRef = pc;
          }
          if (this.partnerIdRef) {
            this.attachRemoteHandlers(pc, this.partnerIdRef);
          }
        } else {
          // КРИТИЧНО: Убеждаемся, что PC сохранен в peerRef
          if (this.peerRef !== pc) {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ⚠️ PC mismatch, updating peerRef');
            this.peerRef = pc;
          }
        }
        
        // КРИТИЧНО: Создаем и отправляем offer если его еще нет
        // Проверяем состояние PC и наличие local description
        try {
          const hasLocalDesc = !!(pc as any).localDescription;
          const signalingState = pc.signalingState;
          
          // КРИТИЧНО: Создаем offer если:
          // 1. PC в stable и нет local description (offer еще не создан)
          // 2. PC в have-local-offer но local description потерян (восстанавливаем)
          const needsOffer = (signalingState === 'stable' && !hasLocalDesc) || 
                            (signalingState === 'have-local-offer' && !hasLocalDesc);
          
          if (needsOffer) {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] Creating offer...', {
              signalingState,
              hasLocalDesc,
              needsOffer
            });
            
            const offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true
            });
            
            await pc.setLocalDescription(offer);
            
            // КРИТИЧНО: Помечаем PC актуальным токеном после создания offer
            this.markPcWithToken(pc);
            
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ✅ Offer created and set', {
              signalingState: pc.signalingState,
              hasLocalDesc: !!(pc as any).localDescription
            });
            
            // Отправляем offer через сокет
            const toId = this.partnerIdRef;
            const roomId = this.roomIdRef;
            
            if (toId || roomId) {
              socket.emit('offer', {
                offer,
                to: toId,
                roomId: roomId
              });
              console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ✅ Offer sent', {
                to: toId,
                roomId: roomId
              });
            } else {
              console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] ⚠️ No partnerId or roomId to send offer');
            }
          } else {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] PC already has local description, skipping offer creation', {
              signalingState,
              hasLocalDesc: !!(pc as any).localDescription
            });
            
            // КРИТИЧНО: Убеждаемся, что PC помечен актуальным токеном
            this.markPcWithToken(pc);
          }
        } catch (e) {
          console.log('📥 [handleCallAccepted] [FRIEND CALL] [INITIATOR] Error creating/sending offer', e);
        }
      } else {
        // Для принимающего НЕ создаем PC - он будет создан в handleOffer
        console.log('📥 [handleCallAccepted] [FRIEND CALL] [RECEIVER] Call accepted, waiting for offer', {
          roomId: this.roomIdRef,
          callId: this.callIdRef,
          partnerId: this.partnerIdRef,
          hasPC: !!this.peerRef
        });
        
        // Создаем только локальный стрим если его нет, но НЕ создаем PC
        let stream = this.localStreamRef;
        if (!stream) {
          try {
            stream = await this.startLocalStream('front');
            if (stream && isValidStream(stream)) {
              this.localStreamRef = stream;
              this.config.callbacks.onLocalStreamChange?.(stream);
              this.config.onLocalStreamChange?.(stream);
              console.log('📥 [handleCallAccepted] [FRIEND CALL] [RECEIVER] ✅ Local stream created (PC will be created when offer arrives)', {
                roomId: this.roomIdRef
              });
            }
          } catch (e) {
            console.log('📥 [handleCallAccepted] [FRIEND CALL] [RECEIVER] Error creating stream', e, {
              roomId: this.roomIdRef
            });
          }
        }
      }
    }
    
    // Эмитим событие принятия звонка
    this.emit('callAnswered');
    } finally {
      this.callAcceptedProcessingRef = false;
      console.log('🔥✅ [handleCallAccepted] Обработка завершена, флаг сброшен');
    }
  }
  
  private handleCallDeclined(data: any): void {
    
    // Очищаем WebRTC состояние при отклонении звонка
    if (this.peerRef) {
      try {
        const senders = this.peerRef.getSenders?.() || [];
        senders.forEach((s: any) => {
          try { s.replaceTrack?.(null); } catch {}
        });
      } catch {}
      
      try {
        (this.peerRef as any).ontrack = null;
        (this.peerRef as any).onaddstream = null;
        (this.peerRef as any).onicecandidate = null;
      } catch {}
      
      try {
        // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
        this.incrementPcToken();
        this.cleanupPeer(this.peerRef);
      } catch {}
      this.peerRef = null;
    }
    
    // КРИТИЧНО: Очищаем remote stream только если соединение действительно разорвано
    // НЕ очищаем если соединение активно (есть partnerId или roomId) или недавно установлено
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const isConnectionRecent = this.connectionEstablishedAtRef && (Date.now() - this.connectionEstablishedAtRef) < 5000;
    
    // КРИТИЧНО: Всегда очищаем remote stream при отклонении звонка
    if (this.remoteStreamRef) {
      try {
        const tracks = this.remoteStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      this.remoteStreamRef = null;
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.emit('remoteStreamRemoved');
    }
    
    // Сбрасываем состояние remoteCamOn
    this.remoteCamOnRef = true;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.remoteInPiPRef = false;
    this.emitRemoteState();

    // Очищаем идентификаторы
    this.partnerIdRef = null;
    this.roomIdRef = null;
    this.callIdRef = null;
    this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.onCallIdChange?.(null);
    this.emitSessionUpdate();
  }
  
  // ==================== PiP State Handler ====================
  
  private handlePiPState(data: { inPiP: boolean; from: string; roomId: string }): void {
    const { inPiP, from, roomId: eventRoomId } = data;
    const currentRoomId = this.roomIdRef;
    const partnerId = this.partnerIdRef;
    
    
    // Игнорируем свои эхо-события
    if (String(from || '') === String(socket.id || '')) {
      return;
    }
    
    // Проверяем что это наш партнер
    const roomOk = !!eventRoomId && !!currentRoomId && eventRoomId === currentRoomId;
    const fromOk = String(from || '') === String(partnerId || '');
    const inCall = !!this.remoteStreamRef;
    
    if (roomOk || fromOk || inCall) {
      
      // Обновляем состояние remoteInPiP
      this.remoteInPiPRef = inPiP;
      
      // Эмитим событие для UI
      this.emit('partnerPiPStateChanged', { inPiP, from });
      this.emitRemoteState();
      
      // Если партнёр вернулся из PiP - восстанавливаем видео
      if (!inPiP) {
        const remoteStreamFromRef = this.remoteStreamRef;
        if (remoteStreamFromRef) {
          const videoTrack = remoteStreamFromRef.getVideoTracks?.()?.[0];
          
          if (videoTrack && remoteStreamFromRef) {
            // Включаем трек для отображения
            videoTrack.enabled = true;
            
            // Проверяем состояние трека и обновляем remoteCamOn
            this.checkRemoteVideoTrack();
            
            // Отправляем состояние камеры партнеру
            try {
              this.sendCameraState(from);
            } catch (e) {
              logger.warn('[WebRTCSession] Error sending camera state after partner PiP return:', e);
            }
          }
        }
      }
    } else {
    }
  }
  
  // ==================== Getters ====================
  
  getLocalStream(): MediaStream | null {
    return this.localStreamRef;
  }
  
  getRemoteStream(): MediaStream | null {
    return this.remoteStreamRef;
  }
  
  getPeerConnection(): RTCPeerConnection | null {
    return this.peerRef;
  }
  
  getPartnerId(): string | null {
    return this.partnerIdRef;
  }
  
  getRoomId(): string | null {
    return this.roomIdRef;
  }
  
  getCallId(): string | null {
    return this.callIdRef;
  }
  
  getRemoteCamOn(): boolean {
    return this.remoteCamOnRef;
  }
  
  getRemoteViewKey(): number {
    return this.remoteViewKeyRef;
  }
  
  getRemoteMuted(): boolean {
    return this.remoteMutedRef;
  }
  
  getRemoteInPiP(): boolean {
    return this.remoteInPiPRef;
  }
  
  // ==================== Remote Audio Control ====================
  
  /**
   * Переключить состояние удаленного аудио (mute/unmute)
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
      
      // КРИТИЧНО: Определяем текущее состояние (muted = все треки выключены)
      // Если хотя бы один трек включен, значит звук не выключен
      const currentlyMuted = audioTracks.every((track: any) => !track.enabled);
      
      // Переключаем состояние: если сейчас muted, то включаем, иначе выключаем
      const newEnabledState = currentlyMuted;
      
      // Применяем новое состояние ко всем аудио трекам
      audioTracks.forEach((track: any) => {
        if (track) {
          track.enabled = newEnabledState;
        }
      });
      
      // Обновляем состояние (muted = все треки выключены)
      this.remoteMutedRef = !newEnabledState;
      this.emitRemoteState();
      
    } catch (e) {
      logger.error('[WebRTCSession] Error toggling remote audio:', e);
    }
  }
  
  // ==================== Setters ====================
  
  setPartnerId(partnerId: string | null): void {
    const oldPartnerId = this.partnerIdRef;
    this.partnerIdRef = partnerId;
    // Сбрасываем принудительную блокировку при смене собеседника
    if (partnerId) {
      this.remoteForcedOffRef = false;
    }
    
    // КРИТИЧНО: Очищаем отложенное состояние cam-toggle при смене партнера
    // Старое отложенное состояние не относится к новому партнеру
    if (oldPartnerId !== partnerId && this.pendingCamToggleRef) {
      this.pendingCamToggleRef = null;
    }
    
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    
    // КРИТИЧНО: Отправляем кешированные ICE кандидаты после установки partnerId (если не null)
    if (partnerId) {
      this.flushOutgoingIceCache();
      // КРИТИЧНО: Также вызываем flushIceFor для обработки pending ICE кандидатов
      this.flushIceFor(partnerId).catch(err => {
        console.warn('[WebRTCSession] Error flushing ICE for partnerId:', err);
      });
    }
    
    // Эмитим событие изменения партнера
    if (oldPartnerId !== partnerId) {
      this.emit('partnerChanged', { partnerId, oldPartnerId });
    }
    this.emitSessionUpdate();
  }
  
  setRoomId(roomId: string | null): void {
    console.log('🔥🔥🔥 [setRoomId] УСТАНАВЛИВАЕМ ROOMID', {
      newRoomId: roomId,
      oldRoomId: this.roomIdRef,
      partnerId: this.partnerIdRef,
      callId: this.callIdRef
    });
    this.roomIdRef = roomId;
    this.config.callbacks.onRoomIdChange?.(roomId);
    this.config.onRoomIdChange?.(roomId);
    this.emitSessionUpdate();
    console.log('🔥✅ [setRoomId] ROOMID УСТАНОВЛЕН И CALLBACKS ВЫЗВАНЫ', { roomId });
  }
  
  setCallId(callId: string | null): void {
    console.log('🔥🔥🔥 [setCallId] УСТАНАВЛИВАЕМ CALLID', {
      newCallId: callId,
      oldCallId: this.callIdRef,
      roomId: this.roomIdRef,
      partnerId: this.partnerIdRef
    });
    this.callIdRef = callId;
    this.config.callbacks.onCallIdChange?.(callId);
    this.config.onCallIdChange?.(callId);
    this.emitSessionUpdate();
    console.log('🔥✅ [setCallId] CALLID УСТАНОВЛЕН И CALLBACKS ВЫЗВАНЫ', { callId });
  }
  
  // ==================== High-Level API ====================
  
  // ==================== Рандом чат ====================
  
  /**
   * Начать рандомный чат
   * Создает локальный стрим и начинает поиск собеседника
   */
  async startRandomChat(): Promise<void> {
    // КРИТИЧНО: Логируем СРАЗУ в начале метода, до любых других операций
    // Используем несколько способов логирования для гарантии, что логи не фильтруются
    console.log('[WebRTCSession] ⚡ startRandomChat called - METHOD START');
    try {
      (global.console as any)._originalLog?.('[WebRTCSession] ⚡ startRandomChat called - METHOD START _originalLog');
    } catch {}
    
    try {
      // Сбрасываем неактивное состояние ПЕРЕД созданием стрима
      console.log('[WebRTCSession] Resetting inactive state...');
      const wasInactive = this.config.getIsInactiveState?.() ?? false;
      console.log('[WebRTCSession] Previous inactive state:', wasInactive);
      this.config.setIsInactiveState?.(false);
      this.config.setWasFriendCallEnded?.(false);
      
      // КРИТИЧНО: Устанавливаем started и эмитим searching ДО создания стрима
      // Это гарантирует, что лоадер показывается сразу при нажатии "Начать"
      console.log('[WebRTCSession] Setting started to true and emitting searching event BEFORE stream creation');
      this.config.setStarted?.(true);
      this.config.callbacks.onLoadingChange?.(true);
      this.config.onLoadingChange?.(true);
      this.emit('searching');
      console.log('[WebRTCSession] Searching event emitted, loading state set to true');
      
      // Создаем локальный стрим
      console.log('[WebRTCSession] Creating local stream...');
      const stream = await this.startLocalStream('front');
      if (!stream) {
        console.error('[WebRTCSession] Failed to create local stream - startLocalStream returned null');
        // Откатываем состояние при ошибке
        this.config.setStarted?.(false);
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
        throw new Error('Failed to start local stream');
      }
    
      console.log('[WebRTCSession] Local stream created successfully', {
        streamId: stream.id,
        hasVideoTrack: !!(stream as any)?.getVideoTracks?.()?.[0],
        hasAudioTrack: !!(stream as any)?.getAudioTracks?.()?.[0]
      });
      
      // Отправляем событие начала поиска через сокет для добавления в очередь матчинга
      try {
        
        if (!socket || !socket.connected) {
          console.warn('[WebRTCSession] Socket not connected, waiting for connection...');
          // Ждем подключения socket
          await new Promise<void>((resolve, reject) => {
            if (socket.connected) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => {
              socket.off('connect', onConnect);
              reject(new Error('Socket connection timeout'));
            }, 5000);
            const onConnect = () => {
              clearTimeout(timeout);
              socket.off('connect', onConnect);
              resolve();
            };
            socket.on('connect', onConnect);
            // Пробуем подключиться если не подключен
            if (!socket.connected) {
              try { socket.connect(); } catch {}
            }
          });
        }
        socket.emit('start');
      } catch (e) {
        console.error('[WebRTCSession] Error sending start event:', e);
        logger.error('[WebRTCSession] Error sending start event:', e);
        // Не бросаем ошибку, чтобы не прерывать процесс
        console.warn('[WebRTCSession] Continuing despite socket error');
      }
      
    } catch (error) {
      console.error('[WebRTCSession] Error in startRandomChat:', error);
      throw error;
    }
  }
  
  /**
   * Остановить рандомный чат
   * Останавливает поиск и очищает соединение
   */
  stopRandomChat(): void {
    
    // КРИТИЧНО: Сначала сбрасываем started, чтобы проверки в stopLocalStream и handleStop не блокировали остановку
    this.config.setStarted?.(false);
    
    // КРИТИЧНО: Сначала останавливаем локальный стрим полностью с force=true
    // Это гарантирует, что камера выключится при нажатии "Стоп"
    this.stopLocalStream(false, true).catch(() => {});
    
    // Затем вызываем handleStop для очистки остального состояния с force=true
    this.handleStop(true);
    
    // КРИТИЧНО: Отправляем событие stop на сервер для сброса busy статуса
    // Это гарантирует, что друзья увидят, что пользователь больше не занят
    try {
      socket.emit('stop');
    } catch (e) {
      logger.warn('[WebRTCSession] Error emitting stop:', e);
    }
    
    // Сбрасываем loading
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    
    // КРИТИЧНО: Сбрасываем lastAutoSearchRef чтобы автопоиск мог запуститься сразу после остановки
    // Это важно для случая, когда пользователь уходит в фон и нужно запустить автопоиск
    this.lastAutoSearchRef = 0;
    
    // Эмитим событие остановки
    this.emit('stopped');
    
  }
  
  /**
   * Перейти к следующему собеседнику в рандомном чате (ручной вызов)
   */
  nextRandom(): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    const pcConnected = pc && (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'checking');
    
    
    // КРИТИЧНО: НЕ вызываем next если соединение активно (кроме ручного вызова)
    // Для ручного вызова всегда разрешаем, но логируем
    this.manuallyRequestedNextRef = true;
    this.next();
  }
  
  /**
   * Автоматический поиск следующего собеседника с защитой от множественных вызовов
   * @param reason - причина автопоиска (для логирования)
   */
  autoNext(reason?: string): void {
    const now = Date.now();
    const timeSinceLastSearch = now - this.lastAutoSearchRef;
    
    // Если прошло меньше 1 секунды с последнего поиска - игнорируем (уменьшено с 2 секунд)
    if (timeSinceLastSearch < 1000) {
      return;
    }
    
    // Отменяем предыдущий таймер если есть
    if (this.autoSearchTimeoutRef) {
      clearTimeout(this.autoSearchTimeoutRef);
      this.autoSearchTimeoutRef = null;
    }
    
    this.lastAutoSearchRef = now;
    
    // Обновляем состояние через конфиг (если еще не установлено)
    this.config.setStarted?.(true);
    this.config.onLoadingChange?.(true);
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    
    // КРИТИЧНО: Запускаем поиск сразу или с минимальной задержкой (100ms вместо 1000ms)
    // Это предотвращает мелькание "Собеседник"
    this.autoSearchTimeoutRef = setTimeout(() => {
      try {
        // Отправляем событие start для начала нового поиска
        socket.emit('start');
        // Эмитим событие searching для UI
        this.config.callbacks.onLoadingChange?.(true);
        this.config.onLoadingChange?.(true);
        this.emit('searching');
      } catch (e) {
        logger.error('[WebRTCSession] autoNext error:', e);
      }
      this.autoSearchTimeoutRef = null;
    }, 100); // Уменьшено с 1000ms до 100ms для мгновенного запуска
  }
  
  /**
   * Отменить автоматический поиск
   */
  cancelAutoNext(): void {
    if (this.autoSearchTimeoutRef) {
      clearTimeout(this.autoSearchTimeoutRef);
      this.autoSearchTimeoutRef = null;
    }
  }
  
  /**
   * Сбросить флаг ручного запроса
   */
  resetManualNextFlag(): void {
    this.manuallyRequestedNextRef = false;
  }
  
  /**
   * Проверить, был ли запрос ручным
   */
  wasManuallyRequested(): boolean {
    return this.manuallyRequestedNextRef;
  }
  
  /**
   * Остановить рандомный чат
   */
  stopRandom(): void {
    this.stopRandomChat();
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
      logger.warn('[WebRTCSession] Error emitting room:leave:', e);
    }
  }
  
  // ==================== Видеозвонок другу ====================
  
  /**
   * Позвонить другу
   * @param friendId - ID друга для звонка
   */
  async callFriend(friendId: string): Promise<void> {
    console.log('🔥🔥🔥 [callFriend] 📞 НАЧАЛО ЗВОНКА ДРУГУ', { 
      friendId,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef
    });
    
    // Сбрасываем неактивное состояние
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    console.log('🔥 [callFriend] Неактивное состояние сброшено');
    
    // Устанавливаем флаги для прямого звонка
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    console.log('🔥✅ [callFriend] ФЛАГИ УСТАНОВЛЕНЫ', { 
      friendCallAccepted: true, 
      inDirectCall: true 
    });
    
    // Устанавливаем partnerId
    this.setPartnerId(friendId);
    console.log('📞 [callFriend] ✅ PartnerId set', { partnerId: friendId });
    
    // Создаем локальный стрим
    console.log('📞 [callFriend] Creating local stream...');
    const stream = await this.startLocalStream('front');
    if (!stream) {
      logger.error('📞 [callFriend] ❌ Failed to start local stream');
      throw new Error('Failed to start local stream for friend call');
    }
    console.log('📞 [callFriend] ✅ Local stream created', { 
      streamId: stream.id,
      hasVideo: stream.getVideoTracks().length > 0,
      hasAudio: stream.getAudioTracks().length > 0
    });
    
    // Создаем PC с локальным стримом
    console.log('📞 [callFriend] Creating PC...');
    const pc = await this.ensurePcWithLocal(stream);
    if (!pc) {
      logger.error('📞 [callFriend] ❌ Failed to create PC');
      throw new Error('Failed to create PeerConnection for friend call');
    }
    console.log('📞 [callFriend] ✅ PC created', { 
      signalingState: pc.signalingState,
      hasLocalDesc: !!(pc as any).localDescription
    });
    
    // КРИТИЧНО: Убеждаемся, что PC сохранен в peerRef
    // Это необходимо для обработки answer после принятия звонка
    if (this.peerRef !== pc) {
      logger.warn('📞 [callFriend] ⚠️ PC mismatch, updating peerRef', {
        currentPeerRef: !!this.peerRef,
        newPc: !!pc,
        currentPeerRefState: this.peerRef ? (this.peerRef as any).signalingState : null,
        newPcState: pc ? (pc as any).signalingState : null
      });
      this.peerRef = pc;
    }
    
    // КРИТИЧНО: Помечаем PC актуальным токеном, чтобы он не был очищен
    this.markPcWithToken(pc);
    
    // КРИТИЧНО: Убеждаемся, что локальный стрим сохранен в localStreamRef
    // Это необходимо для восстановления PC при получении answer
    if (this.localStreamRef !== stream) {
      console.log('📞 [callFriend] ✅ Local stream saved to localStreamRef', {
        streamId: stream.id,
        previousStreamId: this.localStreamRef ? (this.localStreamRef as any).id : null
      });
      this.localStreamRef = stream;
      this.config.callbacks.onLocalStreamChange?.(stream);
      this.config.onLocalStreamChange?.(stream);
      this.emit('localStream', stream);
    }
    
    // Устанавливаем обработчики
    this.attachRemoteHandlers(pc, friendId);
    console.log('📞 [callFriend] ✅ Remote handlers attached', {
      peerRef: !!this.peerRef,
      peerRefMatches: this.peerRef === pc,
      pcToken: (pc as any)?._pcToken,
      currentToken: this.pcToken
    });
    
    // Отправляем запрос на звонок через сокет
    // Используем requestFriend из socket.ts, который отправляет friend:call
    try {
      console.log('🔥🔥 [callFriend] ОТПРАВЛЯЕМ friend:call НА СЕРВЕР...', { to: friendId });
      socket.emit('friend:call', { to: friendId });
      console.log('🔥✅✅ [callFriend] friend:call УСПЕШНО ОТПРАВЛЕН', { to: friendId });
    } catch (e) {
      logger.error('🔥❌❌❌ [callFriend] ОШИБКА ОТПРАВКИ friend:call', e);
      throw e;
    }
    
    // Устанавливаем started
    this.config.setStarted?.(true);
    console.log('🔥✅✅✅ [callFriend] ЗВОНОК ИНИЦИИРОВАН, ОЖИДАЕМ ПРИНЯТИЯ', {
      partnerId: friendId,
      hasPeerConnection: !!this.peerRef,
      hasLocalStream: !!this.localStreamRef,
      roomId: this.roomIdRef,
      callId: this.callIdRef
    });
  }
  
  /**
   * Принять входящий звонок от друга
   * @param callId - ID звонка (опционально)
   */
  async acceptCall(callId?: string): Promise<void> {
    console.log('🔥🔥🔥 [acceptCall] НАЧАЛО ПРИНЯТИЯ ЗВОНКА', { 
      callId,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef
    });
    
    // Устанавливаем callId если есть
    if (callId) {
      this.setCallId(callId);
      console.log('🔥✅ [acceptCall] CALLID УСТАНОВЛЕН', { callId });
    }
    
    // Сбрасываем неактивное состояние
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    console.log('🔥 [acceptCall] Неактивное состояние сброшено');
    
    // Устанавливаем флаги
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    console.log('🔥✅ [acceptCall] ФЛАГИ УСТАНОВЛЕНЫ', {
      friendCallAccepted: true,
      inDirectCall: true
    });
    
    // Создаем локальный стрим если его нет
    let stream = this.localStreamRef;
    if (!stream) {
      console.log('🔥 [acceptCall] СОЗДАЕМ ЛОКАЛЬНЫЙ СТРИМ...');
      stream = await this.startLocalStream('front');
      if (!stream) {
        logger.error('🔥❌❌❌ [acceptCall] НЕ УДАЛОСЬ СОЗДАТЬ ЛОКАЛЬНЫЙ СТРИМ');
        throw new Error('Failed to start local stream for accepting call');
      }
      console.log('🔥✅ [acceptCall] ЛОКАЛЬНЫЙ СТРИМ СОЗДАН', { streamId: stream.id });
    } else {
      console.log('🔥 [acceptCall] ИСПОЛЬЗУЕМ СУЩЕСТВУЮЩИЙ ЛОКАЛЬНЫЙ СТРИМ', { streamId: stream.id });
    }
    
    // Создаем PC если его нет
    let pc = this.peerRef;
    if (!pc) {
      console.log('🔥 [acceptCall] СОЗДАЕМ PEERCONNECTION...');
      pc = await this.ensurePcWithLocal(stream);
      if (pc && this.partnerIdRef) {
        this.attachRemoteHandlers(pc, this.partnerIdRef);
        console.log('🔥✅ [acceptCall] PC СОЗДАН И ОБРАБОТЧИКИ УСТАНОВЛЕНЫ');
      } else if (!pc) {
        logger.error('🔥❌ [acceptCall] НЕ УДАЛОСЬ СОЗДАТЬ PC');
      }
    } else {
      console.log('🔥 [acceptCall] ИСПОЛЬЗУЕМ СУЩЕСТВУЮЩИЙ PC', { 
        signalingState: pc.signalingState 
      });
    }
    
    // Отправляем подтверждение через сокет
    try {
      const acceptPayload: any = { callId: callId || this.callIdRef };
      if (this.partnerIdRef) {
        acceptPayload.to = this.partnerIdRef;
      }
      console.log('🔥🔥 [acceptCall] ОТПРАВЛЯЕМ call:accept НА СЕРВЕР', acceptPayload);
      socket.emit('call:accept', acceptPayload);
      console.log('🔥✅✅ [acceptCall] call:accept УСПЕШНО ОТПРАВЛЕН');
    } catch (e) {
      logger.error('🔥❌ [acceptCall] ОШИБКА ОТПРАВКИ call:accept', e);
    }
    
    // Устанавливаем started
    this.config.setStarted?.(true);
    console.log('🔥✅✅✅ [acceptCall] ЗВОНОК ПРИНЯТ');
  }
  
  /**
   * Отклонить входящий звонок
   * @param callId - ID звонка (опционально)
   */
  declineCall(callId?: string): void {
    
    // Отправляем отклонение через сокет
    try {
      const declinePayload: any = { callId: callId || this.callIdRef };
      if (this.partnerIdRef) {
        declinePayload.to = this.partnerIdRef;
      }
      socket.emit('call:decline', declinePayload);
    } catch (e) {
      logger.warn('[WebRTCSession] Error emitting call:decline:', e);
    }
    
    // Очищаем состояние
    this.handleCallDeclined({});
    
    // Сбрасываем флаги
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    
    // Эмитим событие отклонения звонка
    this.emit('callDeclined');
  }
  
  /**
   * Завершить текущий звонок (работает для любого режима)
   * Для видеозвонков другу принудительно останавливает все стримы и закрывает PC
   */
  endCall(): void {
    // Сохраняем идентификаторы ДО очистки (нужны для отправки на сервер)
    const savedRoomId = this.roomIdRef;
    const savedCallId = this.callIdRef;
    const savedPartnerId = this.partnerIdRef;
    
    console.log('🔥🔥🔥 [endCall] 🛑 НАЧАЛО ЗАВЕРШЕНИЯ ЗВОНКА', {
      savedRoomId,
      savedCallId,
      savedPartnerId,
      currentRoomId: this.roomIdRef,
      currentCallId: this.callIdRef,
      currentPartnerId: this.partnerIdRef,
      hasPeerConnection: !!this.peerRef,
      hasLocalStream: !!this.localStreamRef,
      hasRemoteStream: !!this.remoteStreamRef,
      pcSignalingState: this.peerRef?.signalingState,
      pcConnectionState: (this.peerRef as any)?.connectionState
    });
    
    // Проверяем, это звонок другу или рандомный чат
    const isFriendCall = (this.config.getIsDirectCall?.() ?? false) || 
                         (this.config.getInDirectCall?.() ?? false) || 
                         (this.config.getFriendCallAccepted?.() ?? false);
    
    console.log('🔥 [endCall] ОПРЕДЕЛЕН ТИП ЗВОНКА', {
      isFriendCall,
      isDirectCall: this.config.getIsDirectCall?.() ?? false,
      inDirectCall: this.config.getInDirectCall?.() ?? false,
      friendCallAccepted: this.config.getFriendCallAccepted?.() ?? false
    });
    
    // КРИТИЧНО: Отправляем call:end ДО очистки стримов и идентификаторов
    // Это гарантирует, что идентификаторы доступны для отправки на сервер
    if (isFriendCall) {
      try {
        // КРИТИЧНО: Для дружеских звонков используем сохраненные значения ИЛИ текущие
        // Это гарантирует, что roomId будет отправлен даже если он был установлен после сохранения
        const roomIdToSend = savedRoomId || this.roomIdRef;
        const callIdToSend = savedCallId || this.callIdRef;
        
        console.log('🔥🔥🔥 [endCall] 📤 ПОДГОТОВКА К ОТПРАВКЕ call:end', {
          savedRoomId,
          savedCallId,
          currentRoomId: this.roomIdRef,
          currentCallId: this.callIdRef,
          roomIdToSend,
          callIdToSend,
          partnerId: savedPartnerId,
          hasRoomId: !!roomIdToSend,
          hasCallId: !!callIdToSend,
          isFriendCall
        });
        
        // КРИТИЧНО: Отправляем оба параметра (roomId и callId) для надежного завершения звонка
        // Сервер использует roomId в первую очередь, но callId может быть полезен как fallback
        const finalRoomId = roomIdToSend;
        const finalCallId = callIdToSend;
        
        console.log('🔥 [endCall] ФИНАЛЬНЫЕ ИДЕНТИФИКАТОРЫ ДЛЯ ОТПРАВКИ', {
          finalRoomId,
          finalCallId,
          hasFinalRoomId: !!finalRoomId,
          hasFinalCallId: !!finalCallId
        });
        
        // КРИТИЧНО: Отправляем call:end даже если roomId/callId не установлены
        // Сервер может использовать fallback из activeCallBySocket для завершения звонка
        // Это гарантирует, что звонок завершится у обоих участников
        console.log('🔥🔥 [endCall] 📤 ОТПРАВЛЯЕМ call:end НА СЕРВЕР', {
          roomId: finalRoomId,
          callId: finalCallId,
          hasRoomId: !!finalRoomId,
          hasCallId: !!finalCallId,
          savedRoomId: roomIdToSend,
          savedCallId: callIdToSend
        });
        
        socket.emit('call:end', {
          roomId: finalRoomId || undefined,
          callId: finalCallId || undefined
        });
        
        console.log('🔥✅✅✅ [endCall] call:end УСПЕШНО ОТПРАВЛЕН', {
          roomId: finalRoomId,
          callId: finalCallId,
          hasRoomId: !!finalRoomId,
          hasCallId: !!finalCallId,
          savedRoomId: roomIdToSend,
          savedCallId: callIdToSend,
          timestamp: Date.now()
        });
        
        // Если ни один идентификатор не был установлен, логируем предупреждение
        if (!finalRoomId && !finalCallId) {
          logger.warn('🛑 [endCall] ⚠️ No roomId or callId to send call:end, but sent anyway (server will use fallback)', {
            savedRoomId,
            savedCallId,
            currentRoomId: this.roomIdRef,
            currentCallId: this.callIdRef,
            savedPartnerId
          });
        }
      } catch (e) {
        logger.error('🛑 [endCall] ❌ Error emitting call:end:', e);
      }
    }
    
    if (isFriendCall) {
      console.log('🛑 [endCall] Processing friend call end - cleaning up streams and PC');
      // Для видеозвонков другу принудительно останавливаем все стримы и закрываем PC
      // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
      if (this.peerRef) {
        this.incrementPcToken();
        // Принудительно закрываем PeerConnection
        try {
          if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
            this.peerRef.close();
          }
        } catch (e) {
          logger.warn('[WebRTCSession] Error closing PC in endCall:', e);
        }
        this.cleanupPeer(this.peerRef);
        this.peerRef = null;
      }
      
      // Принудительно останавливаем локальный стрим
      console.log('🛑 [endCall] Stopping local stream');
      this.stopLocalStreamInternal();
      
      // Останавливаем все таймеры и интервалы
      console.log('🛑 [endCall] Stopping all timers and intervals');
      this.clearConnectionTimers();
      this.stopTrackChecker();
      this.stopMicMeter();
      
      // Принудительно останавливаем удаленный стрим
      if (this.remoteStreamRef) {
        console.log('🛑 [endCall] Stopping remote stream');
        try {
          const tracks = this.remoteStreamRef.getTracks?.() || [];
          console.log('🛑 [endCall] Remote stream tracks', { count: tracks.length });
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
        this.emit('remoteStreamRemoved');
      }
      
      // Выходим из комнаты перед очисткой идентификаторов
      const roomIdToLeave = savedRoomId || this.roomIdRef;
      if (roomIdToLeave) {
        try {
          socket.emit('room:leave', { roomId: roomIdToLeave });
          console.log('🛑 [endCall] ✅ Left room', { roomId: roomIdToLeave });
        } catch (e) {
          logger.warn('[WebRTCSession] Error emitting room:leave in endCall:', e);
        }
      }
      
      // Очищаем идентификаторы
      console.log('🛑 [endCall] Clearing identifiers', {
        savedPartnerId,
        savedRoomId,
        savedCallId
      });

      this.partnerIdRef = null;
      this.roomIdRef = null;
      this.callIdRef = null;
      this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
      this.config.callbacks.onPartnerIdChange?.(null);
      this.config.callbacks.onRoomIdChange?.(null);
      this.config.callbacks.onCallIdChange?.(null);
      this.config.onPartnerIdChange?.(null);
      this.config.onRoomIdChange?.(null);
      this.config.onCallIdChange?.(null);
      
      // Сбрасываем состояние remoteCamOn
      this.remoteCamOnRef = true;
      this.remoteForcedOffRef = false;
      this.camToggleSeenRef = false;
      this.remoteViewKeyRef = 0;
      this.remoteMutedRef = false;
      this.remoteInPiPRef = false;
      this.config.callbacks.onRemoteCamStateChange?.(true);
      this.config.onRemoteCamStateChange?.(true);
      this.emitRemoteState();
      
      // КРИТИЧНО: Дополнительная проверка - убеждаемся, что локальный стрим полностью остановлен
      // Это гарантирует, что камера не будет работать в фоне
      // Вызываем stopLocalStreamInternal еще раз для гарантии
      this.stopLocalStreamInternal();
      
      // Дополнительная проверка - если стрим все еще существует, принудительно останавливаем
      if (this.localStreamRef) {
        logger.warn('🛑 [endCall] ⚠️ Локальный стрим все еще существует после stopLocalStreamInternal, принудительная остановка');
        try {
          const tracks = this.localStreamRef.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              if (t && t.readyState !== 'ended' && t.readyState !== null) {
                t.enabled = false;
                t.stop();
                try { (t as any).release?.(); } catch {}
              }
            } catch {}
          });
        } catch {}
        // Очищаем ссылку на стрим
        this.localStreamRef = null;
        this.config.callbacks.onLocalStreamChange?.(null);
        this.config.onLocalStreamChange?.(null);
        this.emit('localStream', null);
      }
      
      this.emitSessionUpdate();
    } else {
      // Для рандомного чата используем стандартный stop()
      this.stop();
    }
    
    // КРИТИЧНО: Сбрасываем флаги ПОСЛЕ остановки всех процессов
    // Это гарантирует, что UI получит правильное состояние после завершения
    console.log('🔥🔥 [endCall] СБРАСЫВАЕМ ФЛАГИ');
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    this.config.setIsInactiveState?.(true);
    this.config.setWasFriendCallEnded?.(true);
    console.log('🔥✅ [endCall] ФЛАГИ СБРОШЕНЫ', {
      friendCallAccepted: false,
      inDirectCall: false,
      started: false,
      isInactiveState: true,
      wasFriendCallEnded: true
    });
    
    // КРИТИЧНО: Останавливаем все таймеры и интервалы еще раз для гарантии
    // Это предотвращает работу процессов в фоне после завершения звонка
    console.log('🔥 [endCall] ОСТАНАВЛИВАЕМ ВСЕ ПРОЦЕССЫ');
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    console.log('🔥✅ [endCall] ВСЕ ПРОЦЕССЫ ОСТАНОВЛЕНЫ');
    
    // Эмитим событие завершения звонка
    console.log('🔥🔥 [endCall] ЭМИТИМ callEnded СОБЫТИЕ');
    this.emit('callEnded');
    console.log('🔥✅ [endCall] callEnded СОБЫТИЕ ОТПРАВЛЕНО');
    
    console.log('🔥✅✅✅ [endCall] ЗВОНОК УСПЕШНО ЗАВЕРШЕН - ВСЕ ПРОЦЕССЫ ОСТАНОВЛЕНЫ');
  }
  
  // ==================== Управление устройствами ====================
  
  /**
   * Переключить микрофон (уже реализован)
   */
  // toggleMic() - уже есть выше
  
  /**
   * Переключить камеру (уже реализован)
   */
  // toggleCam() - уже есть выше
  
  /**
   * Переключить камеру (передняя/задняя)
   */
  flipCamera(): Promise<void> {
    return this.flipCam();
  }
  
  // ==================== PiP ====================
  
  /**
   * Войти в режим Picture-in-Picture
   * Выключает локальную камеру и отправляет pip:state партнеру
   */
  enterPiP(): void {
    
    const isFriendCall = 
      (this.config.getIsDirectCall?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getFriendCallAccepted?.() ?? false);
    
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
            logger.warn('[WebRTCSession] Error emitting cam-toggle on enterPiP:', e);
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
      logger.warn('[WebRTCSession] Error emitting pip:state on enterPiP:', e);
    }
  }
  
  /**
   * Выйти из режима Picture-in-Picture
   * Восстанавливает локальную камеру и отправляет pip:state партнеру
   */
  exitPiP(): void {
    
    const isFriendCall = 
      (this.config.getIsDirectCall?.() ?? false) ||
      (this.config.getInDirectCall?.() ?? false) ||
      (this.config.getFriendCallAccepted?.() ?? false);
    
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
      logger.warn('[WebRTCSession] Error emitting pip:state on exitPiP:', e);
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
            logger.warn('[WebRTCSession] Error emitting cam-toggle on exitPiP:', e);
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
      
      // Проверяем состояние трека
      this.checkRemoteVideoTrack();
    }
  }
  
  /**
   * Восстановить соединение после выхода из PiP
   * Обычно вызывается автоматически при возврате из PiP
   */
  async resumeFromPiP(): Promise<void> {
    
    // Сбрасываем флаг PiP
    this.setInPiP(false);
    
    // Восстанавливаем локальный стрим из PiP если есть
    const pipLocalStream = this.config.getPipLocalStream?.();
    if (pipLocalStream && isValidStream(pipLocalStream)) {
      this.localStreamRef = pipLocalStream;
      this.config.callbacks.onLocalStreamChange?.(pipLocalStream);
      this.config.onLocalStreamChange?.(pipLocalStream);
    } else {
      // Если стрима из PiP нет, создаем новый
      const stream = await this.startLocalStream('front');
      if (!stream) {
        throw new Error('Failed to resume local stream from PiP');
      }
    }
    
    // Восстанавливаем remote stream из PiP если есть
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      this.remoteStreamRef = pipRemoteStream;
      this.config.callbacks.onRemoteStreamChange?.(pipRemoteStream);
      this.config.onRemoteStreamChange?.(pipRemoteStream);
    }
    
    // Проверяем PC - если он существует и валиден, используем его
    const pc = this.peerRef;
    if (pc) {
      const state = pc.signalingState;
      if (state !== 'closed') {
        // PC валиден, просто обновляем обработчики
        if (this.partnerIdRef) {
          this.attachRemoteHandlers(pc, this.partnerIdRef);
        }
        return;
      }
    }
    
    // Если PC нет или он закрыт, создаем новый
    const stream = this.localStreamRef;
    if (stream) {
      const newPc = await this.ensurePcWithLocal(stream);
      if (newPc && this.partnerIdRef) {
        this.attachRemoteHandlers(newPc, this.partnerIdRef);
      }
    }
  }
  
  // ==================== Системное управление ====================
  
  /**
   * Полный сброс всего состояния для начала с нуля
   * Очищает все соединения, стримы и состояние
   */
  disconnectCompletely(force: boolean = false): void {
    const started = this.config.getStarted?.() ?? false;
    const isJustStarted = started && !this.partnerIdRef && !this.roomIdRef;
    const isSearching = started && !this.partnerIdRef;
    
    
    // КРИТИЧНО: Не отключаемся если пользователь только что начал поиск
    // Это предотвращает остановку стрима сразу после нажатия "Начать"
    // НО: если force=true, отключаемся принудительно (например, при нажатии "Стоп")
    if ((isJustStarted || isSearching) && !force) {
      return;
    }
    
    // Останавливаем локальный стрим с force
    this.stopLocalStream(false, force).catch(() => {});
    
    // Очищаем PC
    if (this.peerRef) {
      // КРИТИЧНО: Инкрементируем токен перед очисткой, чтобы отложенные события игнорировались
      this.incrementPcToken();
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    if (this.preCreatedPcRef) {
      // КРИТИЧНО: Инкрементируем токен перед очисткой preCreatedPcRef
      this.incrementPcToken();
      this.cleanupPeer(this.preCreatedPcRef);
      this.preCreatedPcRef = null;
    }
    
    // КРИТИЧНО: Очищаем remote stream только если соединение действительно разорвано
    // НЕ очищаем если соединение активно (есть partnerId или roomId) или недавно установлено
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const isConnectionRecent = this.connectionEstablishedAtRef && (Date.now() - this.connectionEstablishedAtRef) < 5000;
    
    // КРИТИЧНО: Всегда очищаем remote stream при полном отключении
    if (this.remoteStreamRef) {
      try {
        const tracks = this.remoteStreamRef.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      this.remoteStreamRef = null;
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.emit('remoteStreamRemoved');
    }

    // Очищаем все идентификаторы
    this.partnerIdRef = null;
    this.roomIdRef = null;
    this.callIdRef = null;
    this.roomJoinedRef.clear(); // КРИТИЧНО: Очищаем список присоединенных комнат
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.onCallIdChange?.(null);
    
    // Очищаем очереди
    this.iceCandidateQueue.clear();
    this.pendingIceByFromRef = {};
    this.processingOffersRef.clear();
    this.processingAnswersRef.clear();
    // КРИТИЧНО: Очищаем обработанные offer/answer при полном отключении
    this.processedOffersRef.clear();
    this.processedAnswersRef.clear();
    
    // Останавливаем track checker
    this.stopTrackChecker();
    
    // Сбрасываем флаги
    this.iceRestartInProgressRef = false;
    this.restartCooldownRef = 0;
    this.isInPiPRef = false;
    
    // Сбрасываем состояние remoteCamOn
    this.remoteCamOnRef = true;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.remoteViewKeyRef = 0;
    this.remoteMutedRef = false;
    this.remoteInPiPRef = false;
    this.connectionEstablishedAtRef = 0; // Сбрасываем время установки соединения
    this.emitRemoteState();
    
    // Сбрасываем состояние через конфиг
    this.config.setFriendCallAccepted?.(false);
    this.config.setInDirectCall?.(false);
    this.config.setStarted?.(false);
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    this.config.setIsNexting?.(false);
    this.config.setAddBlocked?.(false);
    this.config.setAddPending?.(false);
    
    // Останавливаем метры
    this.stopMicMeter();
    
    // Очищаем таймеры подключения
    this.clearConnectionTimers();
    this.isConnectedRef = false;
    
  }
  
  // ==================== AppState Management ====================
  
  private setupAppStateListener(): void {
    this.appStateSubscription = AppState.addEventListener('change', (nextAppState: string) => {
      this.handleAppStateChange(nextAppState);
    });
  }
  
  private handleAppStateChange(nextAppState: string): void {
    if (nextAppState === 'active') {
      this.handleForeground();
    } else if (nextAppState === 'background' || nextAppState === 'inactive') {
      this.handleBackground();
    }
  }
  
  private handleForeground(): void {
    const wasInBackground = this.wasInBackgroundRef;
    this.wasInBackgroundRef = false;
    
    if (!wasInBackground) {
      return;
    }
    
    
    // Проверяем есть ли активное соединение
    const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
    const isFriendCall = this.config.getIsDirectCall?.() || 
                        this.config.getInDirectCall?.() || 
                        this.config.getFriendCallAccepted?.();
    
    if (!hasActiveCall) {
      return;
    }
    
    // Для дружеских звонков - восстанавливаем соединение
    if (isFriendCall) {
      this.reconnectAfterReturn();
    } else {
      // Для рандомного чата - не восстанавливаем, пользователь должен сам продолжить
    }
  }
  
  private handleBackground(): void {
    this.wasInBackgroundRef = true;
    
    const isFriendCall = this.config.getIsDirectCall?.() || 
                        this.config.getInDirectCall?.() || 
                        this.config.getFriendCallAccepted?.();
    const hasActiveCall = !!this.roomIdRef || !!this.callIdRef;
    
    // Для дружеских звонков - сохраняем состояние и отправляем уведомление
    if (isFriendCall && hasActiveCall) {
      try {
        socket.emit('bg:entered', {
          callId: this.callIdRef || this.roomIdRef,
          partnerId: this.partnerIdRef
        });
      } catch (e) {
        logger.warn('[WebRTCSession] Error emitting bg:entered:', e);
      }
      return;
    }
    
    // Для рандомного чата - останавливаем поиск и очищаем соединение
    if (!isFriendCall && (this.roomIdRef || this.partnerIdRef)) {
      this.stopRandom();
      this.stopLocalStream(false);
      this.disconnectCompletely();
      
      // Обновляем состояние через конфиг
      this.config.setStarted?.(false);
      this.config.onLoadingChange?.(false);
      this.config.setIsInactiveState?.(true);
    }
  }
  
  /**
   * Восстановить состояние звонка после возврата из background или при монтировании
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
    
    const isFriendCall = this.config.getIsDirectCall?.() || 
                        this.config.getInDirectCall?.() || 
                        this.config.getFriendCallAccepted?.();
    const isInactiveState = this.config.getIsInactiveState?.() ?? false;
    const wasFriendCallEnded = this.config.getWasFriendCallEnded?.() ?? false;
    
    // КРИТИЧНО: Если это возврат из PiP (returnToActiveCall === true), 
    // НЕ проверяем isInactiveState - восстанавливаем состояние в любом случае
    // Это гарантирует, что звонок будет восстановлен даже если он был в неактивном состоянии
    if (!returnToActiveCall && (isInactiveState || wasFriendCallEnded)) {
      console.log('[WebRTCSession] restoreCallState: Call is inactive, skipping restore', {
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
        console.log('[WebRTCSession] restoreCallState: No minimal refs for returnToActiveCall', {
          roomId: roomId || this.roomIdRef,
          callId: callId || this.callIdRef
        });
        return;
      }
    } else {
      // Для обычного восстановления требуем все идентификаторы
      if (!hasActiveRefs || !hasActiveCallId) {
        console.log('[WebRTCSession] restoreCallState: Missing required refs', {
          hasActiveRefs,
          hasActiveCallId
        });
        return;
      }
    }
    
    
    // Восстанавливаем идентификаторы если они были переданы
    // КРИТИЧНО: Для возврата из PiP устанавливаем идентификаторы даже если они уже установлены
    // Это гарантирует, что все идентификаторы актуальны
    if (roomId) {
      this.roomIdRef = roomId;
      this.config.callbacks.onRoomIdChange?.(roomId);
      this.config.onRoomIdChange?.(roomId);
      this.emitSessionUpdate();
    }
    if (partnerId) {
      this.partnerIdRef = partnerId;
      this.config.callbacks.onPartnerIdChange?.(partnerId);
      this.config.onPartnerIdChange?.(partnerId);
      this.emitSessionUpdate();
    }
    if (callId) {
      this.callIdRef = callId;
      this.config.callbacks.onCallIdChange?.(callId);
      this.config.onCallIdChange?.(callId);
      this.emitSessionUpdate();
    }
    
    // Обновляем состояние через конфиг
    this.config.setStarted?.(true);
    this.config.setFriendCallAccepted?.(true);
    this.config.setInDirectCall?.(true);
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    
    // Если это возврат из background - не пересоздаем PC, просто восстанавливаем стримы
    if (isFromBackground || returnToActiveCall) {
      // Восстанавливаем стримы если они есть
      this.restoreStreams();
      return;
    }
    
    // Иначе пытаемся переподключиться
    this.reconnectAfterReturn();
  }
  
  /**
   * Переподключиться после возврата из background
   */
  reconnectAfterReturn(): void {
    
    const hasActiveCall = !!this.partnerIdRef || !!this.roomIdRef || !!this.callIdRef;
    if (!hasActiveCall) {
      return;
    }
    
    // Проверяем состояние PC
    const pc = this.peerRef;
    if (pc) {
      const connectionState = pc.connectionState;
      const iceConnectionState = pc.iceConnectionState;
      
      
      // Если соединение разорвано - пытаемся восстановить
      if (connectionState === 'disconnected' || connectionState === 'failed' ||
          iceConnectionState === 'disconnected' || iceConnectionState === 'failed') {
        const toId = this.partnerIdRef || '';
        if (toId) {
          this.tryIceRestart(pc, toId);
        }
      } else if (connectionState === 'connected' && iceConnectionState === 'connected') {
        this.restoreStreams();
      }
    } else {
      // PC не существует - возможно нужно пересоздать
      // Восстанавливаем стримы
      this.restoreStreams();
    }
  }
  
  /**
   * Восстановить стримы после возврата
   */
  private restoreStreams(): void {
    // Восстанавливаем локальный стрим если он был сохранен
    const pipLocalStream = this.config.getPipLocalStream?.();
    if (pipLocalStream && isValidStream(pipLocalStream)) {
      this.localStreamRef = pipLocalStream;
      this.config.callbacks.onLocalStreamChange?.(pipLocalStream);
      this.config.onLocalStreamChange?.(pipLocalStream);
      this.emit('localStream', pipLocalStream);
    }
    
    // Восстанавливаем удаленный стрим если он был сохранен
    const pipRemoteStream = this.config.getPipRemoteStream?.();
    if (pipRemoteStream && isValidStream(pipRemoteStream)) {
      this.remoteStreamRef = pipRemoteStream;
      this.config.callbacks.onRemoteStreamChange?.(pipRemoteStream);
      this.config.onRemoteStreamChange?.(pipRemoteStream);
      this.emit('remoteStream', pipRemoteStream);
    }
    
    // Обновляем ключ рендера для принудительного обновления UI
    this.remoteViewKeyRef++;
    this.emit('remoteViewKeyChanged', this.remoteViewKeyRef);
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    const started = this.config.getStarted?.() ?? false;
    const isJustStarted = started && !this.partnerIdRef && !this.roomIdRef;
    const isSearching = started && !this.partnerIdRef;
    
    
    // КРИТИЧНО: При destroy всегда принудительно очищаем все
    // Это гарантирует полную очистку при размонтировании компонента
    
    // Отменяем автопоиск
    this.cancelAutoNext();
    
    // Удаляем AppState listener
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    
    // Принудительно отключаемся
    this.disconnectCompletely(true);
  }
}