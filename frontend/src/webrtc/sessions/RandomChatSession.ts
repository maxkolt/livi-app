import { RTCPeerConnection, MediaStream } from 'react-native-webrtc';
import { logger } from '../../../utils/logger';
import socket from '../../../sockets/socket';
import { BaseWebRTCSession } from '../base/BaseWebRTCSession';
import type { WebRTCSessionConfig } from '../types';
import { isValidStream } from '../../../utils/streamUtils';

/**
 * Сессия для рандомного видеочата
 * Наследуется от BaseWebRTCSession и добавляет логику специфичную для рандомного чата
 */
export class RandomChatSession extends BaseWebRTCSession {
  constructor(config: WebRTCSessionConfig) {
    super(config);
    this.setupSocketHandlers();
  }
  
  /**
   * Создать PeerConnection с локальным стримом
   * Для рандомного чата создаем PC немедленно, без задержек
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
    
    let pc = this.peerRef;
    
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
          try {
            this.cleanupPeer(pc);
          } catch (e) {
            logger.warn('[RandomChatSession] Error cleaning up closed PC:', e);
          }
          pc = null;
          this.peerRef = null;
        } else if (!isInitial) {
          // Переиспользуем существующий PC
          this.markPcWithToken(pc);
          return pc;
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Cannot access PC state, creating new one:', e);
        try {
          this.cleanupPeer(pc);
        } catch {}
        pc = null;
        this.peerRef = null;
        (global as any).__lastPcClosedAt = Date.now();
      }
    }
    
    // Создание нового PC
    if (!pc) {
      try {
        if (!stream || !isValidStream(stream)) {
          logger.error('[RandomChatSession] Cannot create PC - stream is invalid');
          return null;
        }
        
        const iceConfig = this.getIceConfig();
        
        // ОПТИМИЗИРОВАНО: Для рандомного чата - минимальная задержка только если PC был закрыт недавно
        // Уменьшено с 100ms до 50ms для быстрого создания PC
        const lastPcClosedAt = (global as any).__lastPcClosedAt;
        if (lastPcClosedAt) {
          const timeSinceClose = Date.now() - lastPcClosedAt;
          const MIN_DELAY = 50; // Минимальная задержка 50ms для рандомного чата (было 100ms)
          if (timeSinceClose < MIN_DELAY) {
            const delay = MIN_DELAY - timeSinceClose;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        // ОПТИМИЗИРОВАНО: Защита от одновременного создания - уменьшено с 500ms до 200ms
        const pcCreationLock = (global as any).__pcCreationLock;
        const lockTimeout = 200; // Для рандомного чата 200ms (было 500ms)
        if (pcCreationLock && (Date.now() - pcCreationLock) < lockTimeout) {
          const waitTime = lockTimeout - (Date.now() - pcCreationLock);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        (global as any).__pcCreationLock = Date.now();
        this.pcCreationInProgressRef = true;
        
        try {
          pc = new RTCPeerConnection(iceConfig);
          this.peerRef = pc;
          (global as any).__pcCreationLock = null;
          this.pcCreationInProgressRef = false;
          
          this.incrementPcToken(true);
          this.markPcWithToken(pc);
          
          // Устанавливаем обработчики
          this.bindConnHandlers(pc, this.partnerIdRef || undefined);
          this.attachRemoteHandlers(pc, this.partnerIdRef || undefined);
        } catch (createError: any) {
          (global as any).__pcCreationLock = null;
          this.pcCreationInProgressRef = false;
          logger.error('[RandomChatSession] RTCPeerConnection constructor failed:', createError);
          (global as any).__lastPcClosedAt = Date.now();
          throw createError;
        }
      } catch (e) {
        (global as any).__pcCreationLock = null;
        this.pcCreationInProgressRef = false;
        logger.error('[RandomChatSession] Failed to create PeerConnection:', e);
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
            logger.error('[RandomChatSession] Error replacing track:', e);
          }
        } else {
          try {
            (pc as any).addTrack?.(track as any, stream as any);
          } catch (e) {
            logger.error('[RandomChatSession] Error adding track:', e);
          }
        }
      }
    }
    
    return pc;
  }
  
  /**
   * Начать рандомный чат
   */
  async startRandomChat(): Promise<void> {
    // Сбрасываем неактивное состояние ПЕРЕД созданием стрима
    this.config.setIsInactiveState?.(false);
    this.config.setWasFriendCallEnded?.(false);
    
    // КРИТИЧНО: Устанавливаем started и эмитим searching ДО создания стрима
    // Это гарантирует, что лоадер показывается сразу при нажатии "Начать"
    this.config.setStarted?.(true);
    this.config.callbacks.onLoadingChange?.(true);
    this.config.onLoadingChange?.(true);
    this.emit('searching');
    
    // Создаем локальный стрим
    const stream = await this.startLocalStream('front');
    if (!stream) {
      // Откатываем состояние при ошибке
      this.config.setStarted?.(false);
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      throw new Error('Failed to start local stream for random chat');
    }
    
    // Отправляем событие start для начала поиска
    try {
      // Проверяем подключение socket
      if (!socket || !socket.connected) {
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
      logger.error('[RandomChatSession] Error sending start event:', e);
      // Не бросаем ошибку, чтобы не прерывать процесс
    }
  }
  
  /**
   * Остановить рандомный чат
   * ПРОСТАЯ ЛОГИКА: Полностью очищаем все соединения и комнаты, отправляем stop на сервер
   */
  stopRandomChat(): void {
    // 1. Сбрасываем started
    this.config.setStarted?.(false);
    
    // 2. Останавливаем локальный стрим (камера выключится)
    this.stopLocalStream(false, true).catch(() => {});
    
    // 3. Полностью очищаем все соединения и комнаты
    this.handleStop();
    
    // 4. Отправляем stop на сервер (сброс busy статуса, выход из очереди)
    try {
      socket.emit('stop');
    } catch (e) {
      logger.warn('[RandomChatSession] Error emitting stop:', e);
    }
    
    // 5. Сбрасываем loading и эмитим событие
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    this.lastAutoSearchRef = 0;
    this.emit('stopped');
  }
  
  /**
   * Перейти к следующему собеседнику
   * ПРОСТАЯ ЛОГИКА: Очищаем все, отправляем next на сервер, запускаем новый поиск
   */
  next(): void {
    // 1. Отправляем next на сервер (другой пользователь получит peer:left и начнет поиск)
    try {
      socket.emit('next');
    } catch (e) {
      logger.warn('[RandomChatSession] Error emitting next:', e);
    }
    
    // 2. Полностью очищаем текущее соединение (комната, стримы, PC)
    this.handleNext(true);
    
    // 3. Запускаем новый поиск
    this.config.setStarted?.(true);
    this.autoNext('manual_next');
  }
  
  /**
   * Автоматический поиск следующего собеседника
   * ПРОСТАЯ ЛОГИКА: Защита от спама, затем сразу запускаем поиск
   */
  autoNext(reason?: string): void {
    const now = Date.now();
    const timeSinceLastSearch = now - this.lastAutoSearchRef;
    
    // Защита от спама (минимум 200ms между запросами)
    if (timeSinceLastSearch < 200) {
      return;
    }
    
    // Отменяем предыдущий таймер если есть
    if (this.autoSearchTimeoutRef) {
      clearTimeout(this.autoSearchTimeoutRef);
      this.autoSearchTimeoutRef = null;
    }
    
    this.lastAutoSearchRef = now;
    
    // Обновляем состояние и запускаем поиск
    this.config.setStarted?.(true);
    this.config.onLoadingChange?.(true);
    this.config.setIsInactiveState?.(false);
    
    try {
      socket.emit('start');
      this.config.callbacks.onLoadingChange?.(true);
      this.config.onLoadingChange?.(true);
      this.emit('searching');
    } catch (e) {
      logger.error('[RandomChatSession] autoNext error:', e);
    }
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
   * Обработка остановки
   * ПРОСТАЯ ЛОГИКА: Полностью очищаем все соединения, комнаты, стримы, PC
   */
  protected handleStop(force: boolean = false): void {
    // 1. Закрываем и очищаем PC
    if (this.peerRef) {
      this.incrementPcToken();
      try {
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Error closing PC:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // 2. Останавливаем все стримы
    this.stopLocalStreamInternal();
    this.stopRemoteStreamInternal();
    
    // 3. Очищаем таймеры
    this.clearConnectionTimers();
    this.stopTrackChecker();
    this.stopMicMeter();
    
    // 4. Очищаем трекеры offer/answer
    this.processingOffersRef.clear();
    this.processedOffersRef.clear();
    this.processingAnswersRef.clear();
    this.processedAnswersRef.clear();
    this.offerCounterByKeyRef.clear();
    this.answerCounterByKeyRef.clear();
    
    // 5. Очищаем partnerId и roomId (комната полностью очищается)
    this.config.setStarted?.(false);
    this.setPartnerId(null);
    this.setRoomId(null);
    
    // 6. Эмитим событие
    this.emit('stopped');
  }
  
  /**
   * Обработка перехода к следующему
   * ПРОСТАЯ ЛОГИКА: Полностью очищаем соединение, комнату, стримы, PC
   */
  protected handleNext(force: boolean = false): void {
    // 1. Закрываем и очищаем PC
    if (this.peerRef) {
      this.incrementPcToken();
      try {
        if (this.peerRef.signalingState !== 'closed' && (this.peerRef as any).connectionState !== 'closed') {
          this.peerRef.close();
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Error closing PC:', e);
      }
      this.cleanupPeer(this.peerRef);
      this.peerRef = null;
    }
    
    // 2. Очищаем трекеры offer/answer
    this.processingOffersRef.clear();
    this.processedOffersRef.clear();
    this.processingAnswersRef.clear();
    this.processedAnswersRef.clear();
    this.offerCounterByKeyRef.clear();
    this.answerCounterByKeyRef.clear();
    
    // 3. Останавливаем удаленный стрим
    this.stopRemoteStreamInternal();
    
    // 4. Очищаем таймеры
    this.clearConnectionTimers();
    this.stopTrackChecker();
    
    // 5. Очищаем partnerId и roomId (комната очищается)
    this.setPartnerId(null);
    this.setRoomId(null);
    
    // 6. Эмитим событие для UI
    this.emit('next');
  }
  
  /**
   * Очистка ресурсов
   */
  cleanup(): void {
    this.stopRandomChat();
    this.removeAllListeners();
    
    if (this.appStateSubscription) {
      this.appStateSubscription.remove();
      this.appStateSubscription = null;
    }
    
    if (this.autoSearchTimeoutRef) {
      clearTimeout(this.autoSearchTimeoutRef);
      this.autoSearchTimeoutRef = null;
    }
  }
  
  /**
   * Отправить состояние камеры партнеру (для рандомного чата используем partnerId)
   */
  sendCameraState(toPartnerId?: string, enabled?: boolean): void {
    const targetPartnerId = toPartnerId || this.getPartnerId();
    
    if (!targetPartnerId) {
      logger.warn('[RandomChatSession] sendCameraState: No partner ID available', {
        toPartnerId,
        currentPartnerId: this.getPartnerId()
      });
      return;
    }
    
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
        from: socket.id,
        to: targetPartnerId
      };
      
      socket.emit('cam-toggle', payload);
    } catch (e) {
      logger.warn('[RandomChatSession] Error sending camera state:', e);
    }
  }
  
  /**
   * Настройка обработчиков socket для рандомного чата
   */
  protected setupSocketHandlers(): void {
    // Вызываем базовую реализацию
    super.setupSocketHandlers();
    
    // Добавляем специфичные обработчики для рандомного чата
    socket.on('match_found', async (data: { id: string; userId?: string | null; roomId?: string }) => {
      await this.handleMatchFound(data);
    });
    
    socket.on('peer:stopped', () => {
      // Партнер нажал "Стоп" или "Далее" - по принципу чатрулетки всегда запускаем новый поиск
      // если чат был запущен (started = true)
      const wasStarted = this.config.getStarted?.() ?? false;
      
      if (wasStarted) {
        // ЧАТРУЛЕТКА: Очищаем соединение и сразу запускаем новый поиск
        this.handleNext(true);
        this.autoNext('peer_stopped');
      } else {
        // Чат не запущен - просто очищаем
        this.handleStop();
      }
    });
    
    socket.on('peer:left', () => {
      // Партнер нажал "Далее" - по принципу чатрулетки всегда запускаем новый поиск
      // если чат был запущен (started = true)
      const wasStarted = this.config.getStarted?.() ?? false;
      
      if (wasStarted) {
        // ЧАТРУЛЕТКА: Очищаем соединение и сразу запускаем новый поиск
        this.handleNext(true);
        this.autoNext('partner_left');
      } else {
        // Чат не запущен - очищаем и запускаем поиск (на случай если чат был остановлен)
        this.handleNext(true);
        this.autoNext('partner_left_no_started');
      }
    });
    
    socket.on('disconnected', () => {
      this.handleRandomDisconnected('server');
    });
    
    socket.on('hangup', () => {
      this.handleRandomDisconnected('server');
    });
  }
  
  /**
   * Обработка match_found для рандомного чата
   * ПРОСТАЯ ЛОГИКА: Нашли собеседника - сразу подключаемся
   */
  private async handleMatchFound(data: { id: string; userId?: string | null; roomId?: string }): Promise<void> {
    const partnerId = data.id;
    const roomId = data.roomId;
    const { userId } = data;
    
    // Защита от дубликатов
    if (this.partnerIdRef === partnerId && this.peerRef) {
      const pc = this.peerRef;
      if (pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
        return;
      }
    }
    
    // Сбрасываем состояние камеры (покажем заглушку пока не придет видео)
    this.remoteCamOnRef = false;
    this.remoteForcedOffRef = false;
    this.camToggleSeenRef = false;
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.emitRemoteState();
    this.pendingCamToggleRef = null;
    
    // Устанавливаем partnerId и roomId
    this.setPartnerId(partnerId);
    if (roomId) {
      this.setRoomId(roomId);
    }
    
    // Отправляем кешированные ICE кандидаты
    this.flushOutgoingIceCache();
    this.flushIceFor(partnerId).catch(() => {});
    
    // Закрываем старый PC если есть
    if (this.peerRef) {
      const pc = this.peerRef;
      const isClosed = pc.signalingState === 'closed' || (pc as any).connectionState === 'closed';
      const isForDifferentPartner = this.partnerIdRef && this.partnerIdRef !== partnerId;
      
      if (isClosed || isForDifferentPartner) {
        try {
          if (!isClosed) pc.close();
        } catch {}
        this.cleanupPeer(pc);
        this.peerRef = null;
      } else {
        // PC уже для этого партнера - не создаем новый
        this.emit('matchFound', { partnerId, roomId: roomId || null, userId: userId ?? null });
        return;
      }
    }
    
    // Создаем PC и подключаемся
    if (partnerId && !this.peerRef) {
      let stream = this.localStreamRef;
      if (!stream || !isValidStream(stream)) {
        stream = await this.startLocalStream('front');
        if (!stream || !isValidStream(stream)) {
          logger.error('[RandomChatSession] Failed to start local stream');
          return;
        }
      }
      
      const pc = await this.ensurePcWithLocal(stream);
      if (!pc) {
        logger.error('[RandomChatSession] Failed to create PC');
        return;
      }
      
      // Устанавливаем обработчик ontrack
      this.attachRemoteHandlers(pc, partnerId);
      
      // Создаем и отправляем offer
      await this.createAndSendOffer(partnerId, roomId);
    }
    
    // Эмитим событие
    this.emit('matchFound', {
      partnerId,
      roomId: roomId || null,
      userId: userId ?? null,
    });
  }
  
  /**
   * Обработка отключения для рандомного чата (публичный метод)
   */
  handleRandomDisconnected(source: 'server' | 'local'): void {
    const hasActiveConnection = !!this.partnerIdRef || !!this.roomIdRef;
    const hasRemoteStream = !!this.remoteStreamRef;
    const pc = this.peerRef;
    
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
    
    // КРИТИЧНО: Проверяем, был ли чат запущен перед обработкой disconnected
    // Если чат был запущен (started=true), НЕ сбрасываем его, чтобы поиск продолжался
    const wasStarted = this.config.getStarted?.() ?? false;
    
    // 1. Останавливаем локальный стрим, но НЕ трогаем autoNext и friend-call флаги
    // КРИТИЧНО: НЕ останавливаем локальный стрим если чат был запущен - он нужен для продолжения поиска
    if (!wasStarted) {
      this.stopLocalStreamInternal();
    }
    
    // 2. Чистим remoteStream
    if (this.remoteStreamRef) {
      this.stopRemoteStreamInternal();
    }
    
    // 3. КРИТИЧНО: НЕ сбрасываем started если чат был запущен
    // Это позволяет продолжить поиск после disconnected
    // Сбрасываем started только если чат был остановлен пользователем
    if (!wasStarted) {
      this.config.setStarted?.(false);
    }
    
    // 4. Эмитим 'disconnected', чтобы UI мог отреагировать
    this.emit('disconnected');
  }
  
  /**
   * Переопределяем handleOffer для рандомного чата
   * Добавляем специфичную логику для рандомного чата
   */
  protected async handleOffer({ from, offer, fromUserId, roomId }: { from: string; offer: any; fromUserId?: string; roomId?: string }): Promise<void> {
    // Для рандомного чата используем from (socket.id) как partnerId
    if (from && !this.getPartnerId()) {
      this.setPartnerId(from);
    }
    
    // Вызываем базовую реализацию
    await super.handleOffer({ from, offer, fromUserId, roomId });
  }
  
  /**
   * Переопределяем handleAnswer для рандомного чата
   */
  protected async handleAnswer({ from, answer, roomId }: { from: string; answer: any; roomId?: string }): Promise<void> {
    // Вызываем базовую реализацию
    await super.handleAnswer({ from, answer, roomId });
  }
  
  /**
   * Переопределяем createAndSendAnswer для рандомного чата
   * НЕ используем оптимизацию SDP, так как она может вызвать ошибку "SessionDescription is NULL"
   */
  protected async createAndSendAnswer(from: string, roomId?: string): Promise<void> {
    const pc = this.getPeerConnection();
    if (!pc) {
      return;
    }
    
    // КРИТИЧНО: Защита от множественных вызовов для одного и того же PC
    const answerKey = `answer_${from}_${this.pcToken}`;
    if (this.processingAnswersRef.has(answerKey) || this.processedAnswersRef.has(answerKey)) {
      logger.warn('[RandomChatSession] Answer already being processed or processed for this PC', { from, answerKey });
      return;
    }
    
    // КРИТИЧНО: Проверяем что localDescription еще не установлен
    const hasLocalDesc = !!(pc as any)?.localDescription;
    if (hasLocalDesc) {
      logger.warn('[RandomChatSession] Answer already set for this PC', { from });
      return;
    }
    
    this.processingAnswersRef.add(answerKey);
    
    try {
      // Проверяем состояние
      if (pc.signalingState !== 'have-remote-offer') {
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем pcToken и что PC не закрыт
      if (!this.isPcValid(pc)) {
        logger.warn('[RandomChatSession] Cannot create answer - PC is closed or token invalid');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // Создаем answer
      const answer = await pc.createAnswer();
      
      // КРИТИЧНО: Проверяем что answer валиден
      if (!answer) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Answer is NULL!');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      if (!answer.sdp) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Answer has no SDP!');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      if (answer.type !== 'answer') {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Answer type is not "answer"!', { type: answer.type });
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Для рандомного чата НЕ используем оптимизацию SDP
      // Оптимизация может нарушить структуру SDP и вызвать ошибку "SessionDescription is NULL"
      
      // Проверяем состояние перед setLocalDescription
      if (pc.signalingState !== 'have-remote-offer') {
        logger.warn('[RandomChatSession] PC state changed before setLocalDescription for answer', {
          signalingState: pc.signalingState,
          expectedState: 'have-remote-offer'
        });
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что PC все еще валиден
      if (!this.isPcValid(pc)) {
        logger.warn('[RandomChatSession] PC became invalid before setLocalDescription for answer');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что answer все еще валиден перед setLocalDescription
      if (!answer || !answer.sdp || answer.type !== 'answer') {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Answer became invalid before setLocalDescription!');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что localDescription еще не установлен (защита от race condition)
      const hasLocalDescBefore = !!(pc as any)?.localDescription;
      if (hasLocalDescBefore) {
        logger.warn('[RandomChatSession] Local description already set, skipping answer creation');
        this.processingAnswersRef.delete(answerKey);
        return;
      }
      
      try {
        // Используем оригинальный answer без оптимизации
        await pc.setLocalDescription(answer);
      } catch (setLocalError: any) {
        const errorState = pc.signalingState;
        const errorHasRemoteDesc = !!(pc as any)?.remoteDescription;
        const errorMsg = String(setLocalError?.message || '');
        
        if (errorState !== 'have-remote-offer' || errorHasRemoteDesc) {
          logger.warn('[RandomChatSession] PC state changed during setLocalDescription for answer', {
            errorState,
            errorHasRemoteDesc
          });
          return;
        }
        
        if (errorMsg.includes('NULL') || errorMsg.includes('null')) {
          logger.error('[RandomChatSession] ❌❌❌ CRITICAL: setLocalDescription failed with NULL error for answer!', {
            error: errorMsg,
            answerType: answer.type,
            hasSdp: !!answer.sdp,
            sdpLength: answer.sdp?.length,
            signalingState: pc.signalingState,
            hasLocalDesc: !!(pc as any)?.localDescription,
            hasRemoteDesc: !!(pc as any)?.remoteDescription
          });
          
          // RETRY: Пробуем создать answer заново
          logger.warn('[RandomChatSession] Retrying answer creation...');
          try {
            // Проверяем состояние еще раз
            if (pc.signalingState === 'have-remote-offer' && !(pc as any)?.localDescription) {
              const retryAnswer = await pc.createAnswer();
              
              if (!retryAnswer || !retryAnswer.sdp || retryAnswer.type !== 'answer') {
                throw new Error('Retry answer is invalid');
              }
              
              await pc.setLocalDescription(retryAnswer);
              logger.warn('[RandomChatSession] ✅ Successfully set local description with retry answer');
              // Используем retry answer для отправки
              answer.sdp = retryAnswer.sdp;
              answer.type = retryAnswer.type;
            } else {
              throw new Error('PC state changed during retry');
            }
          } catch (retryError: any) {
            logger.error('[RandomChatSession] ❌ Retry answer creation also failed:', retryError);
            throw setLocalError; // Бросаем оригинальную ошибку
          }
        } else {
          throw setLocalError;
        }
      }
      
      // Отправляем answer
      const answerPayload: any = {
        to: from,
        answer,
        fromUserId: this.config.myUserId
      };
      
      // Для рандомного чата также добавляем roomId если есть
      const currentRoomId = roomId || this.getRoomId();
      if (currentRoomId) {
        answerPayload.roomId = currentRoomId;
      }
      
      socket.emit('answer', answerPayload);
      
      // Прожигаем отложенные ICE кандидаты
      await this.flushIceFor(from);
      
      // Помечаем answer как обработанный
      this.processedAnswersRef.add(answerKey);
      this.processingAnswersRef.delete(answerKey);
    } catch (e) {
      logger.error('[RandomChatSession] Error creating/sending answer:', e);
      this.processingAnswersRef.delete(answerKey);
    }
  }
  
  /**
   * Переопределяем createAndSendOffer для рандомного чата
   * Используем to (socket.id) для рандомного чата
   */
  protected async createAndSendOffer(toPartnerId: string, roomId?: string): Promise<void> {
    // КРИТИЧНО: Объявляем offerKey вне try, чтобы он был доступен в catch
    const offerKey = `offer_${toPartnerId}_${this.pcToken}`;
    
    try {
      const pc = this.getPeerConnection();
      if (!pc) {
        logger.warn('[RandomChatSession] Cannot create offer - no PC');
        return;
      }
      if (this.processingOffersRef.has(offerKey) || this.processedOffersRef.has(offerKey)) {
        logger.warn('[RandomChatSession] Offer already being processed or processed for this PC', { toPartnerId, offerKey });
        return;
      }
      
      // КРИТИЧНО: Проверяем что localDescription еще не установлен
      const hasLocalDesc = !!(pc as any)?.localDescription;
      if (hasLocalDesc) {
        logger.warn('[RandomChatSession] Offer already set for this PC', { toPartnerId });
        return;
      }
      
      this.processingOffersRef.add(offerKey);
      
      // КРИТИЧНО: Проверяем pcToken и что PC не закрыт
      if (!this.isPcValid(pc)) {
        logger.warn('[RandomChatSession] Cannot create offer - PC is closed or token invalid', {
          pcToken: (pc as any)?._pcToken,
          currentToken: this.pcToken,
          signalingState: pc.signalingState
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // Проверяем состояние PC - должно быть 'stable' без localDescription и remoteDescription
      const signalingState = pc.signalingState;
      const hasLocalDescCheck = !!(pc as any)?.localDescription;
      const hasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (signalingState !== 'stable' || hasLocalDescCheck || hasRemoteDesc) {
        logger.warn('[RandomChatSession] PC not in stable state (without descriptions) for offer creation', {
          signalingState,
          hasLocalDesc: hasLocalDescCheck,
          hasRemoteDesc,
          expectedState: 'stable (no descriptions)'
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // Проверяем еще раз перед созданием
      const currentState = pc.signalingState;
      const currentHasLocalDesc = !!(pc as any)?.localDescription;
      const currentHasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (currentState !== 'stable' || currentHasLocalDesc || currentHasRemoteDesc) {
        logger.warn('[RandomChatSession] PC state changed before offer creation', {
          signalingState: currentState,
          hasLocalDesc: currentHasLocalDesc,
          hasRemoteDesc: currentHasRemoteDesc
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // Проверка на завершенный звонок
      const isInactiveState = this.config.getIsInactiveState?.() ?? false;
      if (isInactiveState) {
        this.processingOffersRef.delete(offerKey);
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
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Tracks are ended before createOffer!', {
          endedAudioCount: endedAudioTracks.length,
          endedVideoCount: endedVideoTracks.length,
          totalAudioSenders: audioSenders.length,
          totalVideoSenders: videoSenders.length
        });
      }
      
      if (sendersBeforeOffer.length === 0) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: No tracks in PC before createOffer! This will result in sendonly!');
      }
      
      // КРИТИЧНО: offerToReceiveAudio и offerToReceiveVideo должны быть true
      // Иначе получится sendonly вместо sendrecv
      // Оптимизация: используем voiceActivityDetection: false для уменьшения задержки
      const offer = await pc.createOffer({ 
        offerToReceiveAudio: true, 
        offerToReceiveVideo: true,
        voiceActivityDetection: false, // Отключаем VAD для уменьшения задержки
      } as any);
      
      // КРИТИЧНО: Проверяем что offer валиден
      if (!offer) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Offer is NULL!');
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      if (!offer.sdp) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Offer has no SDP!');
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      if (offer.type !== 'offer') {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Offer type is not "offer"!', { type: offer.type });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем SDP на наличие sendrecv
      const hasSendRecv = offer.sdp.includes('a=sendrecv');
      const hasSendOnly = offer.sdp.includes('a=sendonly');
      const hasRecvOnly = offer.sdp.includes('a=recvonly');
      if (hasSendOnly && !hasSendRecv) {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Offer has sendonly instead of sendrecv! This means remote video will not work!');
      }
      if (!hasSendRecv && !hasSendOnly && !hasRecvOnly) {
        logger.warn('[RandomChatSession] ⚠️ Offer SDP has no explicit direction - may default to sendonly');
      }
      
      // КРИТИЧНО: Для рандомного чата НЕ используем оптимизацию SDP
      // Оптимизация может нарушить структуру SDP и вызвать ошибку "SessionDescription is NULL"
      // Используем оригинальный offer напрямую
      
      // Проверяем состояние еще раз перед setLocalDescription
      const finalState = pc.signalingState;
      const finalHasLocalDesc = !!(pc as any)?.localDescription;
      const finalHasRemoteDesc = !!(pc as any)?.remoteDescription;
      
      if (finalState !== 'stable' || finalHasLocalDesc || finalHasRemoteDesc) {
        logger.warn('[RandomChatSession] PC state changed between createOffer and setLocalDescription', {
          finalState,
          finalHasLocalDesc,
          finalHasRemoteDesc
        });
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что PC все еще валиден
      if (!this.isPcValid(pc)) {
        logger.warn('[RandomChatSession] PC became invalid before setLocalDescription');
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      // КРИТИЧНО: Проверяем что offer все еще валиден перед setLocalDescription
      if (!offer || !offer.sdp || offer.type !== 'offer') {
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: Offer became invalid before setLocalDescription!');
        this.processingOffersRef.delete(offerKey);
        return;
      }
      
      try {
        // КРИТИЧНО: Используем оригинальный offer без оптимизации для рандомного чата
        await pc.setLocalDescription(offer);
      } catch (setLocalError: any) {
        const errorState = pc.signalingState;
        const errorHasRemoteDesc = !!(pc as any)?.remoteDescription;
        const errorMsg = String(setLocalError?.message || '');
        
        if (errorState === 'have-remote-offer' || errorHasRemoteDesc) {
          logger.warn('[RandomChatSession] PC state changed to have-remote-offer during setLocalDescription');
          this.processingOffersRef.delete(offerKey);
          return;
        }
        
        logger.error('[RandomChatSession] ❌❌❌ CRITICAL: setLocalDescription failed!', {
          error: errorMsg,
          offerType: offer.type,
          hasSdp: !!offer.sdp,
          sdpLength: offer.sdp?.length,
          signalingState: pc.signalingState,
          hasLocalDesc: !!(pc as any)?.localDescription,
          hasRemoteDesc: !!(pc as any)?.remoteDescription,
          sendersCount: (pc.getSenders?.() || []).length
        });
        
        this.processingOffersRef.delete(offerKey);
        throw setLocalError;
      }
      
      this.markPcWithToken(pc);
      
      // Отправляем offer
      const currentRoomId = roomId || this.getRoomId();
      const offerPayload: any = {
        to: toPartnerId,
        offer,
        fromUserId: this.config.myUserId
      };
      
      // Для рандомного чата также добавляем roomId если есть
      if (currentRoomId) {
        offerPayload.roomId = currentRoomId;
      }
      
      socket.emit('offer', offerPayload);
      
      // Помечаем offer как обработанный
      this.processedOffersRef.add(offerKey);
      this.processingOffersRef.delete(offerKey);
    } catch (e) {
      logger.error('[RandomChatSession] Error creating/sending offer:', e);
      this.processingOffersRef.delete(offerKey);
    }
  }
}

