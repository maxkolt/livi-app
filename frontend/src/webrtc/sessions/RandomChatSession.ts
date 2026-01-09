import { MediaStream } from '@livekit/react-native-webrtc';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrack,
  LocalAudioTrack,
  LocalVideoTrack,
  createLocalTracks,
} from 'livekit-client';
import { Buffer } from 'buffer';
import AudioRecord from 'react-native-audio-record';
import { Platform } from 'react-native';
import { SimpleEventEmitter } from '../base/SimpleEventEmitter';
import type { WebRTCSessionConfig, CamSide } from '../types';
import socket from '../../../sockets/socket';
import { logger } from '../../../utils/logger';

const LIVEKIT_URL = ((process.env.EXPO_PUBLIC_LIVEKIT_URL as string | undefined) ?? '').trim();

type MatchPayload = {
  id: string;
  roomId?: string;
  userId?: string | null;
  livekitToken?: string | null;
  livekitRoomName?: string | null;
};

export class RandomChatSession extends SimpleEventEmitter {
  private config: WebRTCSessionConfig;
  private room: Room | null = null;
  private localVideoTrack: LocalVideoTrack | null = null;
  private localAudioTrack: LocalAudioTrack | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private currentRemoteParticipant: RemoteParticipant | null = null;
  private remoteAudioTrack: RemoteTrack | null = null;
  private remoteVideoTrack: RemoteTrack | null = null;
  private remoteViewKey = 0;
  private started = false;
  private camSide: CamSide = 'front';
  private isMicOn = true;
  private isCamOn = true;
  private remoteAudioMuted = false;
  private remoteCamEnabled = false;
  private lastAutoSearchAt = 0;
  private socketOffs: Array<() => void> = [];
  private connectRequestId = 0;
  private disconnectReason: 'user' | 'server' | 'unknown' = 'unknown';
  private isDisconnecting = false;
  private disconnectHandled = false;
  private disconnectPromise: Promise<void> | null = null;
  private currentRoomName: string | null = null; // Имя текущей подключенной комнаты LiveKit
  private micLevelInterval: NodeJS.Timeout | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micLevelSource: MediaStreamAudioSourceNode | null = null;
  private audioRecordBuffer: number[] = [];
  private audioRecordSubscription: { remove: () => void } | null = null;
  private eqBarSeeds: number[] = [];
  private eqPhase = 0;
  private lastFrequencyLevels: number[] = [];
  private lastMicLevel = 0;
  private micMonitorLogCount = 0;
  private readonly micBarsCount = 21;
  private camToggleInProgress = false;
  private recoveringVideo = false;
  private detachLocalVideoEnded: (() => void) | null = null;
  private micToggleInProgress = false;
  private lastAudioEnergy = 0;
  private lastAudioDuration = 0;
  private isMicMonitoringActive = false;
  private flipCamInProgress = false;

  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    this.setupSocketHandlers();
  }

  /* ===================== Public API ===================== */

  async startRandomChat(): Promise<void> {
    this.started = true;
    this.isCamOn = true;
    this.isMicOn = true;
    this.config.setIsInactiveState?.(false);
    this.config.setStarted?.(true);
    this.config.callbacks.onLoadingChange?.(true);
    this.config.onLoadingChange?.(true);
    this.emit('searching');
    await this.ensureLocalTracks();
    this.autoNext('initial_start');
  }

  stopRandomChat(): void {
    this.started = false;
    this.config.setStarted?.(false);
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    void this.disconnectRoom('user');
    this.stopLocalTracks();
    this.resetRemoteState();
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
    try {
      socket.emit('stop');
    } catch (e) {
      logger.warn('[RandomChatSession] Error emitting stop', e);
    }
    this.emit('stopped');
    // Сбрасываем флаги после остановки
    this.disconnectHandled = false;
  }

  private lastNextCallTime = 0;
  private readonly NEXT_DEBOUNCE_MS = 1500; // Увеличено до 1.5 секунд для надежности
  private nextInProgress = false; // Флаг для защиты от параллельных вызовов

  async next(): Promise<void> {
    // УПРОЩЕНО: Объединенные проверки для максимальной производительности
    
    // 1. Базовые проверки
    if (this.nextInProgress || this.isDisconnecting || !this.started) {
      return;
    }
    
    // 2. Debounce защита
    const now = Date.now();
    const timeSinceLastCall = now - this.lastNextCallTime;
    if (timeSinceLastCall < this.NEXT_DEBOUNCE_MS) {
      return;
    }
    this.lastNextCallTime = now;
    
    // 3. КРИТИЧНО: Проверка состояния подключения комнаты
    // Защита от нажатий во время подключения к LiveKit
    if (this.room && (this.room.state === 'connecting' || this.room.state === 'reconnecting')) {
      logger.debug('[RandomChatSession] next: room is connecting/reconnecting, skipping');
      return;
    }

    // 4. Устанавливаем флаг выполнения
    this.nextInProgress = true;
    
    // КРИТИЧНО: Локальные треки НЕ останавливаем при next() - они должны продолжать работать
    // Останавливаем только удаленное соединение и сбрасываем состояние удаленного стрима
    
    try {
      socket.emit('next');
    } catch (e) {
      logger.warn('[RandomChatSession] Error emitting next', e);
    }
    
    // КРИТИЧНО: НЕ сбрасываем remoteStream сразу - это вызывает черный экран
    // Вместо этого сбрасываем только после отключения комнаты
    // Сохраняем текущий remoteStream для предотвращения мерцания
    const prevRemoteStream = this.remoteStream;
    
    // Сбрасываем только внутреннее состояние, но не эмитим null сразу
    this.remoteStream = null;
    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.currentRemoteParticipant = null;
    this.remoteCamEnabled = false;
    this.remoteAudioMuted = false;
    
    try {
      // КРИТИЧНО: Отключаем комнату и ждем полного отключения
      // Это гарантирует, что все ресурсы LiveKit очищены перед новым подключением
      // КРИТИЧНО: Обернуто в дополнительный try-catch для предотвращения крашей на Android
      try {
        await this.disconnectRoom('user');
      } catch (e: any) {
        // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей
        const errorMsg = e?.message || String(e || '');
        logger.warn('[RandomChatSession] Error disconnecting room in next()', {
          error: errorMsg,
          errorName: e?.name,
          // Не логируем stack trace на Android - это может вызвать проблемы
        });
        // Даже при ошибке продолжаем - комната может быть уже отключена
        // КРИТИЧНО: Принудительно сбрасываем состояние при ошибке
        try {
          if (this.room) {
            this.room = null;
            this.currentRoomName = null;
          }
          this.isDisconnecting = false;
          this.disconnectPromise = null;
        } catch (resetError) {
          logger.debug('[RandomChatSession] Error resetting state after disconnect error', resetError);
        }
      }
      
      // КРИТИЧНО: Сбрасываем pending connect request, чтобы разрешить новое подключение
      this.pendingConnectRequestId = null;
      this.lastMatchFoundRoomName = null;
      
      // КРИТИЧНО: Сбрасываем partnerId и roomId сразу, чтобы скрыть кнопку "Добавить в друзья"
      // Это должно быть сделано до эмита remoteStream, чтобы UI обновился правильно
      this.config.callbacks.onPartnerIdChange?.(null);
      this.config.onPartnerIdChange?.(null);
      this.config.callbacks.onRoomIdChange?.(null);
      this.config.onRoomIdChange?.(null);
      
      // КРИТИЧНО: Эмитим null для remoteStream ТОЛЬКО после полного отключения
      // Это предотвращает черный экран во время перехода к следующему собеседнику
      this.emit('remoteStream', null);
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
      this.config.callbacks.onRemoteCamStateChange?.(false);
      this.config.onRemoteCamStateChange?.(false);
      this.remoteViewKey = Date.now();
      this.emit('remoteViewKeyChanged', this.remoteViewKey);
      
      // КРИТИЧНО: Добавляем задержку перед обновлением UI, чтобы комната успела отключиться
      // Backend сам возвращает обоих в очередь и запускает tryMatch, поэтому тут НЕ шлем start,
      // иначе получаем дубликаты match_found и разрывы LiveKit комнаты.
      if (this.started) {
        setTimeout(() => {
          if (this.started && !this.isDisconnecting && !this.room) {
            this.emit('searching');
            this.config.callbacks.onLoadingChange?.(true);
            this.config.onLoadingChange?.(true);
          }
        }, 120);
        
        // КРИТИЧНО: Fallback - если через 1.5 секунды нет match_found, вызываем start()
        // Это гарантирует подключение к новому собеседнику даже если backend не вернул в очередь
        // Backend обычно возвращает в очередь быстро, но если что-то пошло не так, fallback поможет
        // КРИТИЧНО: Проверяем только started и room, isDisconnecting может быть true если disconnect еще не завершился
        setTimeout(() => {
          if (this.started && !this.room) {
            // Дополнительная проверка - если все еще disconnecting через 1.5 секунды, значит что-то пошло не так
            if (this.isDisconnecting) {
              logger.warn('[RandomChatSession] Still disconnecting after 1.5s, forcing reset');
              this.isDisconnecting = false;
            }
            logger.debug('[RandomChatSession] Fallback: no match_found after next(), calling start()');
            this.autoNext('next_fallback');
          }
        }, 1500);
      }
    } catch (e: any) {
      // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей на Android
      const errorMsg = e?.message || String(e || '');
      logger.error('[RandomChatSession] Error in next()', {
        error: errorMsg,
        errorName: e?.name,
        // Не логируем stack trace - это может вызвать проблемы на Android
      });
      
      // КРИТИЧНО: Принудительно сбрасываем состояние при ошибке
      try {
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        this.pendingConnectRequestId = null;
        this.lastMatchFoundRoomName = null;
        if (this.room) {
          this.room = null;
          this.currentRoomName = null;
        }
      } catch (resetError) {
        logger.debug('[RandomChatSession] Error resetting state in next() catch', resetError);
      }
    } finally {
      // КРИТИЧНО: Сбрасываем флаг выполнения через небольшую задержку
      // Это гарантирует, что следующий вызов next() не произойдет слишком быстро
      // КРИТИЧНО: Обернуто в try-catch для предотвращения крашей
      try {
        setTimeout(() => {
          try {
            this.nextInProgress = false;
          } catch (e) {
            logger.debug('[RandomChatSession] Error resetting nextInProgress', e);
          }
        }, this.NEXT_DEBOUNCE_MS);
      } catch (e) {
        logger.debug('[RandomChatSession] Error setting timeout in next() finally', e);
        // Принудительно сбрасываем флаг
        this.nextInProgress = false;
      }
    }
  }

  autoNext(_reason?: string): void {
    // КРИТИЧНО: Не запускаем поиск если идет отключение
    // КРИТИЧНО: Проверяем состояние комнаты - если она disconnected или null, можно запускать поиск
    // Это важно для fallback после next(), когда комната уже отключена, но еще не null
    if (this.isDisconnecting) {
      logger.debug('[RandomChatSession] autoNext: skipping (disconnecting)', {
        isDisconnecting: this.isDisconnecting
      });
      return;
    }
    
    // КРИТИЧНО: Проверяем состояние комнаты - если она connected или connecting, не запускаем поиск
    // Но если комната disconnected или null, можно запускать поиск (fallback после next())
    if (this.room && (this.room.state === 'connected' || this.room.state === 'connecting' || this.room.state === 'reconnecting')) {
      logger.debug('[RandomChatSession] autoNext: skipping (room is active)', {
        roomState: this.room.state
      });
      return;
    }
    
    const now = Date.now();
    if (now - this.lastAutoSearchAt < 200) return;
    this.lastAutoSearchAt = now;
    try {
      socket.emit('start');
      this.emit('searching');
      this.config.callbacks.onLoadingChange?.(true);
      this.config.onLoadingChange?.(true);
      logger.debug('[RandomChatSession] autoNext: emitted start', { reason: _reason });
    } catch (e) {
      logger.error('[RandomChatSession] autoNext error', e);
    }
  }

  toggleMic(): void {
    if (this.micToggleInProgress) return;
    this.micToggleInProgress = true;
    this.isMicOn = !this.isMicOn;
    if (this.room) {
      this.room.localParticipant.setMicrophoneEnabled(this.isMicOn).catch((e) => {
        logger.warn('[RandomChatSession] Failed to toggle microphone', e);
      });
    } else if (this.localAudioTrack) {
      try {
        this.isMicOn ? this.localAudioTrack.unmute() : this.localAudioTrack.mute();
      } catch {}
    }
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
    setTimeout(() => {
      this.micToggleInProgress = false;
    }, 200);
  }

  async toggleCam(): Promise<void> {
    if (this.camToggleInProgress) return;
    this.camToggleInProgress = true;
    this.isCamOn = !this.isCamOn;
    const needsRecovery =
      !this.localVideoTrack ||
      !this.localVideoTrack.mediaStreamTrack ||
      this.localVideoTrack.mediaStreamTrack.readyState === 'ended';
    if (this.isCamOn && needsRecovery) {
      await this.recoverLocalVideoTrack('toggleCam');
    }
    if (this.room && this.localVideoTrack) {
      try {
        if (this.isCamOn) {
          // Включаем: убеждаемся, что трек опубликован
          await this.publishVideoTrackIfRoomActive(true);
        } else {
          // Выключаем: отписываем трек, но не стопаем — чтобы можно было быстро включить
          await this.unpublishVideoTrackKeepAlive();
          // Локально выключаем, чтобы не было утечки кадра
          const mediaTrack = this.localVideoTrack.mediaStreamTrack;
          if (mediaTrack) {
            mediaTrack.enabled = false;
          }
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Failed to toggle camera', e);
        // Fallback: используем только setCameraEnabled
        try {
          await this.room.localParticipant.setCameraEnabled(this.isCamOn);
        } catch (e2) {
          logger.warn('[RandomChatSession] Failed to setCameraEnabled', e2);
        }
      }
    } else if (this.localVideoTrack) {
      // Если нет комнаты, просто mute/unmute трек
      try {
        const hasSid = !!this.localVideoTrack?.sid;
        if (hasSid) {
          if (this.isCamOn) {
            this.localVideoTrack?.unmute();
          } else {
            this.localVideoTrack?.mute();
          }
        } else if (this.localVideoTrack?.mediaStreamTrack) {
          this.localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
        }
      } catch {}
    }
    
    // Если камера включается в комнате и трек был пересоздан, убеждаемся что он опубликован
    if (this.isCamOn && this.room && this.localVideoTrack) {
      await this.publishVideoTrackIfRoomActive();
    }
    
    // КРИТИЧНО: При включении камеры убеждаемся что трек есть в localStream
    const mediaStreamTrack = this.localVideoTrack?.mediaStreamTrack;
    if (this.isCamOn && this.localStream && mediaStreamTrack) {
      const videoTracks = this.localStream.getVideoTracks();
      const hasVideoTrack = videoTracks.some(t => t.id === mediaStreamTrack.id);
      if (!hasVideoTrack) {
        // Добавляем видео трек обратно в localStream если его нет
        this.localStream.addTrack(mediaStreamTrack as any);
      }
    }
    
    // КРИТИЧНО: Эмитим localStream для обновления UI
    // КРИТИЧНО: НЕ эмитим remoteStream, так как локальное состояние камеры не влияет на удаленное видео
    if (this.localStream) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
    }
    
    // КРИТИЧНО: Обновляем только локальное состояние камеры
    // Удаленное видео не должно быть затронуто
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    setTimeout(() => {
      this.camToggleInProgress = false;
    }, 200);
  }

  toggleRemoteAudio(): void {
    this.remoteAudioMuted = !this.remoteAudioMuted;
    if (this.remoteAudioTrack) {
      try {
        this.remoteAudioTrack.setMuted(this.remoteAudioMuted);
      } catch (e) {
        logger.warn('[RandomChatSession] Failed to toggle remote audio', e);
      }
    }
    this.emit('remoteState', { muted: this.remoteAudioMuted });
  }

  async flipCam(): Promise<void> {
    if (this.flipCamInProgress) {
      return;
    }
    
    this.flipCamInProgress = true;
    
    try {
      const wasCamOff = !this.isCamOn;
      
      if (wasCamOff) {
        this.isCamOn = true;
      }
      
      this.camSide = this.camSide === 'front' ? 'back' : 'front';
      await this.restartLocalCamera();
      
      if (wasCamOff) {
        this.config.callbacks.onCamStateChange?.(true);
        this.config.onCamStateChange?.(true);
      }
    } finally {
      this.flipCamInProgress = false;
    }
  }

  async restartLocalCamera(): Promise<void> {
    if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) {
      if (!this.localVideoTrack || !this.localAudioTrack) {
        await this.ensureLocalTracks(true);
      } else {
        await this.recreateLocalVideoTrack('toggleCam');
      }
      return;
    }
    
    const oldVideoTrack = this.localVideoTrack;
    await this.recreateLocalVideoTrack('toggleCam');
    
    if (this.room && this.localVideoTrack) {
      const localVideoTrack = this.localVideoTrack;
      try {
        if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) {
          return;
        }
        
        const publications = this.room.localParticipant.videoTrackPublications;
        const oldPubs: any[] = [];
        
        if (publications && typeof publications.values === 'function') {
          for (const pub of publications.values()) {
            if (pub.track && pub.track !== localVideoTrack) {
              oldPubs.push(pub.track);
            }
          }
        } else if (Array.isArray(publications)) {
          for (const pub of publications) {
            if (pub.track && pub.track !== localVideoTrack) {
              oldPubs.push(pub.track);
            }
          }
        }
        
        if (this.isVideoTrackPublished(localVideoTrack)) {
          if (oldPubs.length > 0) {
            await Promise.all(
              oldPubs.map(track => 
                this.room!.localParticipant.unpublishTrack(track, false).catch(() => {})
              )
            );
          }
          return;
        }
        
        if (localVideoTrack.mediaStreamTrack) {
          localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
          if (this.isCamOn) {
            try {
              localVideoTrack.unmute();
            } catch {}
          } else {
            try {
              localVideoTrack.mute();
            } catch {}
          }
        }
        
        await this.room.localParticipant.publishTrack(localVideoTrack).catch((e) => {
          const errorMsg = e?.message || String(e || '');
          if (errorMsg.includes('already') || 
              errorMsg.includes('duplicate') ||
              errorMsg.includes('closed') || 
              errorMsg.includes('disconnected')) {
            return;
          }
          throw e;
        });
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
        if (oldPubs.length > 0) {
          await Promise.all(
            oldPubs.map(track => 
              this.room!.localParticipant.unpublishTrack(track, false).catch(() => {})
            )
          );
        }
        
        logger.info('[RandomChatSession] Camera restarted and republished');
      } catch (e) {
        logger.warn('[RandomChatSession] Failed to republish camera after restart', e);
      }
    }
  }

  handleRandomDisconnected(_: 'server' | 'local'): void {
    // КРИТИЧНО: Защита от множественных вызовов
    if (this.isDisconnecting || this.disconnectHandled) {
      logger.debug('[RandomChatSession] handleRandomDisconnected already in progress, skipping');
      return;
    }
    this.disconnectHandled = true;
    
    // Асинхронно отключаем комнату и затем запускаем поиск
    void (async () => {
      try {
        await this.disconnectRoom('server');
        this.resetRemoteState();
        
        // КРИТИЧНО: Добавляем задержку перед autoNext, чтобы комната успела полностью отключиться
        // и избежать конфликтов с новыми подключениями
        if (this.started) {
          setTimeout(() => {
            if (this.started && !this.isDisconnecting) {
              this.autoNext('disconnected');
            }
          }, 150);
        } else {
          this.stopLocalTracks();
        }
      } finally {
        // Сбрасываем флаги через небольшую задержку
        setTimeout(() => {
          this.disconnectHandled = false;
        }, 1000);
      }
    })();
  }

  cleanup(): void {
    this.stopRandomChat();
    this.socketOffs.forEach((off) => off());
    this.socketOffs = [];
  }

  getPeerConnection(): null {
    return null;
  }

  setInPiP(_inPiP: boolean): void {}

  // Методы для совместимости с фасадом
  async startLocalStream(_side: CamSide = 'front'): Promise<MediaStream | null> {
    await this.ensureLocalTracks();
    return this.localStream;
  }

  async stopLocalStream(_preserveStreamForConnection: boolean = false, _force: boolean = false): Promise<void> {
    this.stopLocalTracks();
  }

  stopRemoteStream(): void {
    this.resetRemoteState();
  }

  checkRemoteVideoTrack(): void {
    // Проверка удаленного видео трека уже выполняется в handleTrackSubscribed
  }

  leaveRoom(_roomId?: string): void {
    void this.disconnectRoom('user');
  }

  async resumeFromPiP(): Promise<void> {
    // Для RandomChatSession это не применимо
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getPartnerId(): string | null {
    return this.currentRemoteParticipant?.identity || null;
  }

  getRoomId(): string | null {
    return this.room?.name || null;
  }

  getCallId(): string | null {
    // Для RandomChatSession нет callId
    return null;
  }

  /* ===================== Internal helpers ===================== */

  private setupSocketHandlers(): void {
    const matchHandler = (data: MatchPayload) => {
      this.handleMatchFound(data).catch((e) => {
        logger.error('[RandomChatSession] Failed to handle match_found', e);
      });
    };
    const peerStoppedHandler = () => this.handleRandomDisconnected('server');
    const peerLeftHandler = () => this.handlePeerLeft();
    const disconnectedHandler = () => this.handleRandomDisconnected('server');

    socket.on('match_found', matchHandler);
    socket.on('peer:stopped', peerStoppedHandler);
    socket.on('peer:left', peerLeftHandler);
    socket.on('disconnected', disconnectedHandler);
    socket.on('hangup', disconnectedHandler);

    this.socketOffs = [
      () => socket.off('match_found', matchHandler),
      () => socket.off('peer:stopped', peerStoppedHandler),
      () => socket.off('peer:left', peerLeftHandler),
      () => socket.off('disconnected', disconnectedHandler),
      () => socket.off('hangup', disconnectedHandler),
    ];
  }

  private pendingConnectRequestId: number | null = null;
  private lastMatchFoundRoomName: string | null = null;
  private lastMatchFoundTime = 0;
  private readonly MATCH_FOUND_DEBOUNCE_MS = 500; // Защита от дубликатов match_found

  private async handleMatchFound(data: MatchPayload): Promise<void> {
    const partnerId = data.id;
    const roomId = data.roomId ?? null;
    const userId = data.userId ?? null;

    // КРИТИЧНО: Защита от множественных вызовов handleMatchFound для одной и той же комнаты
    const now = Date.now();
    if (data.livekitRoomName === this.lastMatchFoundRoomName && 
        now - this.lastMatchFoundTime < this.MATCH_FOUND_DEBOUNCE_MS) {
      logger.debug('[RandomChatSession] Duplicate match_found ignored (debounce)', { 
        partnerId, 
        roomName: data.livekitRoomName,
        timeSinceLast: now - this.lastMatchFoundTime
      });
      return;
    }

    // КРИТИЧНО: Если уже идет подключение к этой же комнате, игнорируем дубликат
    if (this.pendingConnectRequestId !== null && 
        data.livekitRoomName === this.lastMatchFoundRoomName) {
      logger.debug('[RandomChatSession] Connection already in progress for this room, ignoring duplicate', { 
        partnerId, 
        roomName: data.livekitRoomName,
        pendingRequestId: this.pendingConnectRequestId
      });
      return;
    }

    // КРИТИЧНО: Дедуп - если комната уже подключена к той же комнате, не переподключаемся
    if (this.room && 
        this.room.state === 'connected' && 
        this.room.name === data.livekitRoomName) {
      logger.debug('[RandomChatSession] Room already connected to this room, ignoring match_found', { 
        partnerId, 
        roomName: data.livekitRoomName 
      });
      return;
    }

    // КРИТИЧНО: Если идет отключение, не обрабатываем новый match_found
    if (this.isDisconnecting) {
      logger.debug('[RandomChatSession] Disconnecting in progress, ignoring match_found', { 
        partnerId, 
        roomName: data.livekitRoomName 
      });
      return;
    }

    this.lastMatchFoundRoomName = data.livekitRoomName || null;
    this.lastMatchFoundTime = now;

    this.resetRemoteState();
    this.emit('matchFound', { partnerId, roomId, userId });
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    if (roomId) {
      this.config.callbacks.onRoomIdChange?.(roomId);
      this.config.onRoomIdChange?.(roomId);
    }

    if (!LIVEKIT_URL) {
      logger.error('[RandomChatSession] LiveKit URL is not configured', {
        envVar: 'EXPO_PUBLIC_LIVEKIT_URL',
        value: process.env.EXPO_PUBLIC_LIVEKIT_URL,
        roomId: data.livekitRoomName,
      });
      return;
    }
    if (!data.livekitToken || !data.livekitRoomName) {
      logger.error('[RandomChatSession] Missing LiveKit credentials in match_found payload');
      return;
    }

    const connectRequestId = ++this.connectRequestId;
    this.pendingConnectRequestId = connectRequestId;
    
    try {
      const connected = await this.connectToLiveKit(LIVEKIT_URL, data.livekitToken, connectRequestId, data.livekitRoomName);
      if (!connected) {
        logger.debug('[RandomChatSession] Match handling aborted (stale request)', {
          connectRequestId,
          partnerId,
        });
        return;
      }
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      this.config.setIsInactiveState?.(false);
    } finally {
      // Сбрасываем pending request только если это был наш запрос
      if (this.pendingConnectRequestId === connectRequestId) {
        this.pendingConnectRequestId = null;
      }
    }
  }

  private handlePeerLeft(): void {
    // peer:left приходит при "next" партнёра; backend сам возвращает нас в очередь.
    // Здесь только чистим LiveKit и UI, без повторного socket.emit('start'), чтобы избежать дублей.
    // КРИТИЧНО: Защита от множественных вызовов
    if (this.isDisconnecting || this.disconnectHandled) {
      logger.debug('[RandomChatSession] handlePeerLeft: already disconnecting, skipping');
      return;
    }
    this.disconnectHandled = true;
    
    void (async () => {
      try {
        await this.disconnectRoom('server');
        this.resetRemoteState();
        
        // КРИТИЧНО: Добавляем задержку перед обновлением UI, чтобы комната успела отключиться
        setTimeout(() => {
          if (this.started && !this.isDisconnecting) {
            this.emit('searching');
            this.config.callbacks.onLoadingChange?.(true);
            this.config.onLoadingChange?.(true);
          }
        }, 300);
      } catch (e) {
        logger.error('[RandomChatSession] Error in handlePeerLeft', e);
      } finally {
        // Сбрасываем флаг через небольшую задержку
        setTimeout(() => {
          this.disconnectHandled = false;
        }, 1000);
      }
    })();
  }

  private async ensureLocalTracks(force = false): Promise<void> {
    // КРИТИЧНО: Проверяем что треки не только существуют, но и активны
    const videoActive = this.localVideoTrack && this.localVideoTrack.mediaStreamTrack?.readyState !== 'ended';
    const audioActive = this.localAudioTrack && this.localAudioTrack.mediaStreamTrack?.readyState !== 'ended';
    
    if (videoActive && audioActive && !force) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
      return;
    }

    const targetCamState = this.isCamOn;
    const targetMicState = this.isMicOn;

    if (force) {
      this.stopLocalTracks(false);
    }

    const tracks = await createLocalTracks({
      audio: true,
      video: {
        facingMode: this.camSide === 'front' ? 'user' : 'environment',
        resolution: { width: 1280, height: 720 },
        frameRate: 30,
      },
    }).catch((e) => {
      logger.error('[RandomChatSession] Failed to create local tracks', e);
      throw e;
    });

    tracks.forEach((track) => {
      if (track.kind === Track.Kind.Video) {
        this.localVideoTrack = track as LocalVideoTrack;
        this.attachLocalVideoEndedListener(this.localVideoTrack);
      } else if (track.kind === Track.Kind.Audio) {
        this.localAudioTrack = track as LocalAudioTrack;
      }
    });

    const stream = new MediaStream();
    tracks.forEach((track) => {
      const mediaTrack = track.mediaStreamTrack;
      if (mediaTrack) {
        // LiveKit's MediaStreamTrack is compatible with @livekit/react-native-webrtc's MediaStreamTrack at runtime
        stream.addTrack(mediaTrack as any);
      }
    });
    this.localStream = stream;
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
    this.emit('localStream', stream);
    // Возвращаем состояние камеры/мика к целевому после пересоздания треков
    this.isCamOn = targetCamState;
    this.isMicOn = targetMicState;
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);

    // Применяем состояния к трекам после восстановления
    try {
      if (!this.isCamOn && this.localVideoTrack?.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = false;
        try {
          this.localVideoTrack.mute();
        } catch {}
      } else if (this.isCamOn && this.localVideoTrack?.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = true;
        try {
          this.localVideoTrack.unmute();
        } catch {}
      }
      if (!this.isMicOn && this.localAudioTrack) {
        try {
          this.localAudioTrack.mute();
        } catch {}
      } else if (this.isMicOn && this.localAudioTrack) {
        try {
          this.localAudioTrack.unmute();
        } catch {}
      }
    } catch {}
    
    // КРИТИЧНО: Запускаем мониторинг уровня микрофона для эквалайзера
    // КРИТИЧНО: Только если чат запущен, иначе мониторинг будет остановлен при cleanup
    if (this.started) {
      this.lastAudioEnergy = 0;
      this.lastAudioDuration = 0;
      this.startMicLevelMonitoring(stream);
    }
  }

  private stopLocalTracks(resetStates = true): void {
    // Останавливаем мониторинг уровня микрофона
    this.stopMicLevelMonitoring();
    
    if (this.localAudioTrack) {
      try {
        this.localAudioTrack.stop();
      } catch {}
      this.localAudioTrack = null;
    }
    if (this.localVideoTrack) {
      try {
        this.localVideoTrack.stop();
      } catch {}
      this.localVideoTrack = null;
      this.detachLocalVideoEndedListener();
    }
    this.localStream = null;
    this.lastAudioEnergy = 0;
    this.lastAudioDuration = 0;
    this.config.callbacks.onLocalStreamChange?.(null);
    this.config.onLocalStreamChange?.(null);
    this.emit('localStream', null);

    if (resetStates) {
      this.isCamOn = false;
      this.isMicOn = false;
      this.config.callbacks.onCamStateChange?.(false);
      this.config.onCamStateChange?.(false);
      this.config.callbacks.onMicStateChange?.(false);
      this.config.onMicStateChange?.(false);
    }
  }
  
  private startMicLevelMonitoring(stream: MediaStream): void {
    if (this.isMicMonitoringActive) {
      logger.debug('[RandomChatSession] Mic monitoring already active, stopping first');
      this.stopMicLevelMonitoring();
    }
    
    if (!this.started) {
      logger.debug('[RandomChatSession] Chat not started, skipping mic monitoring');
      return;
    }
    
    this.stopMicLevelMonitoring();
    this.isMicMonitoringActive = true;
    
    const logLevel = this.micMonitorLogCount < 2 ? 'info' : 'debug';
    this.micMonitorLogCount += 1;
    logger[logLevel]('[RandomChatSession] Starting mic level monitoring, stream:', {
      id: stream?.id,
      active: stream?.active,
      audioTracks: stream?.getAudioTracks?.()?.length || 0,
    });

    this.lastAudioEnergy = 0;
    this.lastAudioDuration = 0;

    const barsCount = this.micBarsCount;

    // React Native: читаем PCM из микрофона и считаем FFT вручную
    if (Platform.OS !== 'web') {
      try {
        if (this.startMicLevelMonitoringNativeFFT(barsCount)) {
          return;
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Native FFT monitoring failed, trying fallbacks', e);
      }
    }

    // Web: используем Web Audio API если доступно
    let AudioContextClass: any = null;
    if (typeof window !== 'undefined') {
      AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    }
    if (!AudioContextClass && typeof global !== 'undefined') {
      AudioContextClass = (global as any).AudioContext || (global as any).webkitAudioContext;
    }
    if (AudioContextClass) {
      try {
        this.startMicLevelMonitoringWebFFT(stream, AudioContextClass, barsCount);
        return;
      } catch (e) {
        logger.error('[RandomChatSession] Web Audio FFT failed', e);
      }
    }

    // Последний вариант: берем уровень из статистики LiveKit и генерируем полосы на его основе
    logger.warn('[RandomChatSession] No native FFT available, using stats-based mic monitoring');
    this.startMicLevelMonitoringStatsFallback(barsCount);
  }
  
  private stopMicLevelMonitoring(): void {
    if (!this.isMicMonitoringActive) {
      return;
    }
    
    this.isMicMonitoringActive = false;
    
    if (this.micLevelInterval) {
      clearInterval(this.micLevelInterval);
      this.micLevelInterval = null;
    }

    this.cleanupAudioRecorder();
    this.cleanupAudioContext();
    this.audioRecordBuffer = [];
    this.lastFrequencyLevels = [];
    this.lastMicLevel = 0;
    this.eqPhase = 0;

    const emptyLevels = new Array(this.micBarsCount).fill(0);
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
    this.config.callbacks.onMicFrequencyLevelsChange?.(emptyLevels);
    this.config.onMicFrequencyLevelsChange?.(emptyLevels);
  }
  
  private cleanupAudioContext(): void {
    if (this.micLevelSource) {
      try {
        this.micLevelSource.disconnect();
      } catch {}
      this.micLevelSource = null;
    }
    
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {}
      this.analyser = null;
    }
    
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }
  }

  private cleanupAudioRecorder(): void {
    if (this.audioRecordSubscription) {
      try {
        this.audioRecordSubscription.remove();
      } catch (e) {
        logger.debug('[RandomChatSession] Error removing audio subscription:', e);
      }
      this.audioRecordSubscription = null;
    }
    try {
      AudioRecord.stop();
    } catch (e) {
      logger.debug('[RandomChatSession] Error stopping AudioRecord:', e);
    }
    try {
      if (typeof (AudioRecord as any).removeAllListeners === 'function') {
        (AudioRecord as any).removeAllListeners('data');
      }
    } catch (e) {
      logger.debug('[RandomChatSession] Error removing AudioRecord listeners:', e);
    }
  }

  private startMicLevelMonitoringNativeFFT(barsCount: number): boolean {
    if (!this.isMicMonitoringActive) {
      return false;
    }
    
    const fftSize = 512;
    const sampleRate = 16000;

    this.cleanupAudioRecorder();
    this.audioRecordBuffer = [];
    this.ensureEqSeeds(barsCount);

    try {
      AudioRecord.init({
        sampleRate,
        channels: 1,
        bitsPerSample: 16,
        bufferSize: fftSize * 2,
        wavFile: 'mic-level.wav',
      } as any);

      const subscription = AudioRecord.on(
        'data',
        this.handlePcmChunk(sampleRate, fftSize, barsCount),
      );
      this.audioRecordSubscription = (subscription as unknown as { remove: () => void }) ?? null;

      AudioRecord.start();
      const startLogLevel = this.micMonitorLogCount <= 2 ? 'info' : 'debug';
      logger[startLogLevel]('[RandomChatSession] Native PCM recorder started for FFT');
      return true;
    } catch (e) {
      logger.warn('[RandomChatSession] Failed to start native FFT monitoring:', e);
      this.isMicMonitoringActive = false;
      return false;
    }
  }

  private handlePcmChunk(sampleRate: number, fftSize: number, barsCount: number) {
    return (data: string) => {
      if (!data) return;
      try {
        const chunk = Buffer.from(data, 'base64');
        const samples = new Int16Array(
          chunk.buffer,
          chunk.byteOffset,
          Math.floor(chunk.length / Int16Array.BYTES_PER_ELEMENT),
        );

        for (let i = 0; i < samples.length; i++) {
          // Нормализуем в диапазон [-1, 1]
          this.audioRecordBuffer.push(samples[i] / 32768);
        }

        // Ограничиваем размер буфера, чтобы не расти бесконечно
        const maxBuffer = fftSize * 6;
        if (this.audioRecordBuffer.length > maxBuffer) {
          this.audioRecordBuffer.splice(0, this.audioRecordBuffer.length - maxBuffer);
        }

        while (this.audioRecordBuffer.length >= fftSize) {
          const frame = this.audioRecordBuffer.splice(0, fftSize);
          const { audioLevel, frequencyLevels } = this.calculateFrequencyLevels(
            frame,
            sampleRate,
            barsCount,
          );
          this.emitMicLevels(audioLevel, frequencyLevels);
        }
      } catch (e) {
        logger.debug('[RandomChatSession] Failed to process mic chunk', e);
      }
    };
  }

  private startMicLevelMonitoringWebFFT(
    stream: MediaStream,
    AudioContextClass: any,
    barsCount: number,
  ): void {
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      logger.warn('[RandomChatSession] No audio tracks in stream for mic level monitoring');
      return;
    }

    const audioContext = new AudioContextClass();
    this.audioContext = audioContext;

    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    this.analyser = analyser;

    if (!audioContext.createMediaStreamSource) {
      throw new Error('Web Audio createMediaStreamSource not available');
    }

    const source = audioContext.createMediaStreamSource(stream as unknown as any);
    this.micLevelSource = source;
    source.connect(analyser);

    this.ensureEqSeeds(barsCount);

    this.micLevelInterval = setInterval(() => {
      const activeAnalyser = this.analyser;
      if (!activeAnalyser || !this.isMicOn) {
        const emptyLevels = new Array(barsCount).fill(0);
        this.emitMicLevels(0, emptyLevels);
        return;
      }

      const bufferLength = activeAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      activeAnalyser.getByteFrequencyData(dataArray);

      const magnitudes = new Float32Array(bufferLength);
      let maxMag = 0;
      for (let i = 0; i < bufferLength; i++) {
        magnitudes[i] = dataArray[i];
        if (dataArray[i] > maxMag) {
          maxMag = dataArray[i];
        }
      }

      const frequencyLevels = this.mapMagnitudesToBars(
        magnitudes,
        audioContext.sampleRate || 48000,
        barsCount,
        maxMag || 1,
      );
      const audioLevel = this.smoothMicLevel(
        this.computeAverageLevelFromMagnitudes(magnitudes),
      );

      this.emitMicLevels(audioLevel, frequencyLevels);
    }, 50);

    logger.info('[RandomChatSession] Web Audio FFT monitoring started');
  }

  private startMicLevelMonitoringStatsFallback(barsCount: number): void {
    this.ensureEqSeeds(barsCount);
    this.micLevelInterval = setInterval(async () => {
      if (!this.isMicOn || !this.room || this.room.state !== 'connected') {
        const emptyLevels = new Array(barsCount).fill(0);
        this.emitMicLevels(0, emptyLevels);
        return;
      }

      let audioLevel = 0;

      try {
        const stats = await (this.room.localParticipant as any)?.getTrackStats?.();
        if (stats) {
          for (const stat of stats) {
            if (stat.kind === 'audio' && this.localAudioTrack) {
              const energy = (stat as any).audioEnergy ?? (stat as any).totalAudioEnergy ?? 0;
              const duration = (stat as any).audioDuration ?? (stat as any).totalSamplesDuration ?? 0;
              if (energy > 0 && duration > 0) {
                const dEnergy = energy - this.lastAudioEnergy;
                const dDuration = duration - this.lastAudioDuration;
                this.lastAudioEnergy = energy;
                this.lastAudioDuration = duration;
                if (dEnergy > 0 && dDuration > 0) {
                  const power = dEnergy / dDuration;
                  audioLevel = Math.min(1, Math.sqrt(power * 5));
                  break;
                }
              }

              const level = (stat as any).audioLevel || (stat as any).volume || 0;
              if (level > 0) {
                if (level <= 1) {
                  audioLevel = level;
                } else if (level <= 127) {
                  audioLevel = Math.min(1, level / 127);
                } else {
                  audioLevel = Math.min(1, level / 255);
                }
                break;
              }
            }
          }
        }
      } catch (e) {
        logger.debug('[RandomChatSession] Could not get track stats', e);
      }

      const freqLevels = this.generateFrequencyFromLevel(audioLevel, barsCount);
      this.emitMicLevels(audioLevel, freqLevels);
    }, 120);
  }

  private emitMicLevels(audioLevel: number, frequencyLevels: number[]): void {
    this.config.callbacks.onMicLevelChange?.(audioLevel);
    this.config.onMicLevelChange?.(audioLevel);
    this.config.callbacks.onMicFrequencyLevelsChange?.(frequencyLevels);
    this.config.onMicFrequencyLevelsChange?.(frequencyLevels);
  }

  private generateFrequencyFromLevel(audioLevel: number, barsCount: number): number[] {
    this.ensureEqSeeds(barsCount);
    const base = Math.min(1, audioLevel * 1.2);
    const levels: number[] = [];
    for (let i = 0; i < barsCount; i++) {
      const seed = this.eqBarSeeds[i];
      const wave = 0.15 * Math.sin(this.eqPhase + i * 0.6);
      const jitter = 0.05 * Math.sin(this.eqPhase * 0.5 + i * 1.3);
      const level = Math.min(
        1,
        Math.max(0, base * (0.55 + seed * 0.6) + wave * base + jitter),
      );
      levels.push(level);
    }
    this.eqPhase += 0.25;
    return this.smoothFrequencyLevels(levels, barsCount);
  }

  private ensureEqSeeds(barsCount: number): void {
    if (this.eqBarSeeds.length === barsCount) return;
    this.eqBarSeeds = Array.from({ length: barsCount }, (_v, i) => {
      // Стабильные псевдослучайные коэффициенты для каждой полосы
      const seed = Math.sin(i * 1.37) * 0.5 + 0.5;
      return 0.6 + seed * 0.4;
    });
  }

  private smoothFrequencyLevels(levels: number[], barsCount: number): number[] {
    if (this.lastFrequencyLevels.length !== barsCount) {
      this.lastFrequencyLevels = new Array(barsCount).fill(0);
    }
    const smoothing = 0.35;
    const nextLevels = levels.map((level, index) => {
      const prev = this.lastFrequencyLevels[index] ?? 0;
      return Math.min(1, Math.max(0, prev + (level - prev) * smoothing));
    });
    this.lastFrequencyLevels = nextLevels;
    return nextLevels;
  }

  private smoothMicLevel(level: number): number {
    const alpha = level > this.lastMicLevel ? 0.35 : 0.25;
    this.lastMicLevel = this.lastMicLevel + (level - this.lastMicLevel) * alpha;
    return this.lastMicLevel;
  }

  private calculateFrequencyLevels(
    frame: number[],
    sampleRate: number,
    barsCount: number,
  ): { audioLevel: number; frequencyLevels: number[] } {
    const windowed = this.applyHannWindow(frame);
    const real = new Float32Array(windowed);
    const imag = new Float32Array(real.length);

    this.fftRadix2(real, imag);

    const bins = real.length / 2;
    const magnitudes = new Float32Array(bins);
    let maxMag = 0;
    for (let i = 0; i < bins; i++) {
      const mag = Math.hypot(real[i], imag[i]);
      magnitudes[i] = mag;
      if (mag > maxMag) {
        maxMag = mag;
      }
    }

    // RMS уровня для общего показателя громкости
    let sumSquares = 0;
    for (let i = 0; i < windowed.length; i++) {
      sumSquares += windowed[i] * windowed[i];
    }
    const rms = Math.sqrt(sumSquares / windowed.length);
    const audioLevel = this.smoothMicLevel(Math.min(1, Math.pow(rms, 0.85) * 1.6));

    const frequencyLevels = this.mapMagnitudesToBars(
      magnitudes,
      sampleRate,
      barsCount,
      maxMag || 1,
    );

    return { audioLevel, frequencyLevels };
  }

  private applyHannWindow(samples: number[]): Float32Array {
    const result = new Float32Array(samples.length);
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
      result[i] = samples[i] * hann;
    }
    return result;
  }

  private fftRadix2(real: Float32Array, imag: Float32Array): void {
    const n = real.length;
    if ((n & (n - 1)) !== 0) {
      throw new Error('FFT size must be power of two');
    }

    // битовое разворачивание
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenReal = Math.cos(ang);
      const wlenImag = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wReal = 1;
        let wImag = 0;
        for (let j = 0; j < len / 2; j++) {
          const uReal = real[i + j];
          const uImag = imag[i + j];
          const vReal = real[i + j + len / 2] * wReal - imag[i + j + len / 2] * wImag;
          const vImag = real[i + j + len / 2] * wImag + imag[i + j + len / 2] * wReal;

          real[i + j] = uReal + vReal;
          imag[i + j] = uImag + vImag;
          real[i + j + len / 2] = uReal - vReal;
          imag[i + j + len / 2] = uImag - vImag;

          const nextWReal = wReal * wlenReal - wImag * wlenImag;
          const nextWImag = wReal * wlenImag + wImag * wlenReal;
          wReal = nextWReal;
          wImag = nextWImag;
        }
      }
    }
  }

  private mapMagnitudesToBars(
    magnitudes: Float32Array,
    sampleRate: number,
    barsCount: number,
    maxMagnitude: number,
  ): number[] {
    this.ensureEqSeeds(barsCount);
    const nyquist = sampleRate / 2;
    const levels: number[] = [];
    const safeMax = maxMagnitude || 1e-6;

    for (let i = 0; i < barsCount; i++) {
      const startFreq = Math.pow(i / barsCount, 1.2) * nyquist;
      const endFreq = Math.pow((i + 1) / barsCount, 1.2) * nyquist;
      const startIndex = Math.max(
        1,
        Math.floor((startFreq / nyquist) * magnitudes.length),
      );
      const endIndex = Math.min(
        magnitudes.length,
        Math.max(startIndex + 1, Math.ceil((endFreq / nyquist) * magnitudes.length)),
      );

      let sum = 0;
      for (let j = startIndex; j < endIndex; j++) {
        sum += magnitudes[j];
      }
      const avg = sum / (endIndex - startIndex || 1);

      let level = Math.pow(avg / safeMax, 0.65);
      const seed = this.eqBarSeeds[i];
      const wave = 0.12 * Math.sin(this.eqPhase + i * 0.85);
      level = Math.min(
        1,
        Math.max(0, level * (0.85 + seed * 0.45) + wave * level + seed * 0.04),
      );

      levels.push(level);
    }

    this.eqPhase += 0.45;
    return this.smoothFrequencyLevels(levels, barsCount);
  }

  private computeAverageLevelFromMagnitudes(magnitudes: Float32Array): number {
    if (!magnitudes.length) return 0;
    let sum = 0;
    for (let i = 0; i < magnitudes.length; i++) {
      sum += magnitudes[i];
    }
    const avg = sum / magnitudes.length;
    return Math.min(1, Math.pow(avg / 255, 0.7) * 1.4);
  }

  private resetRemoteState(): void {
    this.remoteStream = null;
    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.currentRemoteParticipant = null;
    this.remoteCamEnabled = false;
    this.emit('remoteStream', null);
    this.config.callbacks.onRemoteStreamChange?.(null);
    this.config.onRemoteStreamChange?.(null);
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.remoteAudioMuted = false;
    this.emit('remoteState', { muted: false });
    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }
  
  private attachLocalVideoEndedListener(track: LocalVideoTrack | null): void {
    this.detachLocalVideoEndedListener();
    const mediaTrack = track?.mediaStreamTrack;
    if (!mediaTrack || typeof mediaTrack.addEventListener !== 'function') return;
    
    const handler = () => {
      logger.warn('[RandomChatSession] Local video track ended, recovering...');
      void this.recoverLocalVideoTrack('ended');
    };
    
    mediaTrack.addEventListener('ended', handler);
    this.detachLocalVideoEnded = () => {
      try {
        mediaTrack.removeEventListener('ended', handler);
      } catch {}
    };
  }

  private detachLocalVideoEndedListener(): void {
    if (this.detachLocalVideoEnded) {
      try {
        this.detachLocalVideoEnded();
      } catch {}
      this.detachLocalVideoEnded = null;
    }
  }

  private async recoverLocalVideoTrack(reason: 'ended' | 'toggleCam'): Promise<void> {
    if (this.recoveringVideo) return;
    this.recoveringVideo = true;
    try {
      await this.recreateLocalVideoTrack(reason);
      await this.publishVideoTrackIfRoomActive();
    } catch (e) {
      logger.warn('[RandomChatSession] Failed to recover local video track', e);
    } finally {
      this.recoveringVideo = false;
    }
  }

  private async recreateLocalVideoTrack(reason: 'ended' | 'toggleCam'): Promise<void> {
    const prevTrackId = this.localVideoTrack?.mediaStreamTrack?.id;
    
    // Останавливаем старый трек, но не трогаем аудио
    if (this.localVideoTrack) {
      try {
        this.localVideoTrack.stop();
      } catch {}
    }
    this.detachLocalVideoEndedListener();
    
    const tracks = await createLocalTracks({
      audio: false,
      video: {
        facingMode: this.camSide === 'front' ? 'user' : 'environment',
        resolution: { width: 1280, height: 720 },
        frameRate: 30,
      },
    }).catch((e) => {
      logger.error('[RandomChatSession] Failed to recreate local video track', e);
      throw e;
    });

    const newVideoTrack = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
    if (!newVideoTrack) {
      throw new Error('Failed to recreate local video track');
    }
    this.localVideoTrack = newVideoTrack;
    
    if (this.isCamOn && newVideoTrack.mediaStreamTrack) {
      newVideoTrack.mediaStreamTrack.enabled = true;
      try {
        newVideoTrack.unmute();
      } catch {}
    } else if (!this.isCamOn && newVideoTrack.mediaStreamTrack) {
      newVideoTrack.mediaStreamTrack.enabled = false;
      try {
        newVideoTrack.mute();
      } catch {}
    }
    this.attachLocalVideoEndedListener(newVideoTrack);

    if (!this.localStream) {
      this.localStream = new MediaStream();
    }

    // Удаляем старые видео треки из localStream
    try {
      this.localStream.getVideoTracks().forEach((t) => {
        try {
          this.localStream?.removeTrack(t as any);
        } catch {}
      });
    } catch {}

    const mediaTrack = newVideoTrack.mediaStreamTrack;
    if (mediaTrack) {
      this.localStream.addTrack(mediaTrack as any);
    }

    // Убеждаемся, что аудио трек остается в localStream
    if (this.localAudioTrack?.mediaStreamTrack) {
      const hasAudio = this.localStream.getAudioTracks().some(
        (t) => t.id === this.localAudioTrack?.mediaStreamTrack?.id
      );
      if (!hasAudio) {
        this.localStream.addTrack(this.localAudioTrack.mediaStreamTrack as any);
      }
    }

    // Обновляем состояние UI
    this.config.callbacks.onLocalStreamChange?.(this.localStream);
    this.config.onLocalStreamChange?.(this.localStream);
    this.emit('localStream', this.localStream);
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    
    logger.info('[RandomChatSession] Local video track recreated', {
      reason,
      prevTrackId,
      newTrackId: mediaTrack?.id,
    });
  }

  private async publishVideoTrackIfRoomActive(force = false): Promise<void> {
    if (!this.room || !this.localVideoTrack) return;
    if (!this.isCamOn && !force) return; // не публикуем если камера выключена
    
    // КРИТИЧНО: Проверяем состояние комнаты и участника в начале метода
    // Участник должен иметь sid (session ID), что означает что он полностью добавлен в комнату
    if (this.room.state !== 'connected' || 
        !this.room.localParticipant || 
        !this.room.localParticipant.sid) {
      logger.debug('[RandomChatSession] Room not connected or participant not ready, skipping video track publish', {
        roomState: this.room.state,
        hasLocalParticipant: !!this.room.localParticipant,
        participantSid: this.room.localParticipant?.sid
      });
      return;
    }
    
    try {
      const publications = this.room.localParticipant.videoTrackPublications;
      // Удаляем только битые или чужие публикации, чтобы не рвать рабочий трек
      if (publications && typeof publications.values === 'function') {
        for (const pub of publications.values()) {
          const track = pub.track;
          const isSameTrack = track && track === this.localVideoTrack;
          const trackEnded = track?.mediaStreamTrack?.readyState === 'ended';
              if (!isSameTrack || trackEnded) {
                try {
                  if (track) {
                    await this.room.localParticipant.unpublishTrack(track, false);
                  }
                } catch {}
              }
            }
          } else if (Array.isArray(publications)) {
            for (const pub of publications) {
              const track = pub.track;
              const isSameTrack = track && track === this.localVideoTrack;
              const trackEnded = track?.mediaStreamTrack?.readyState === 'ended';
              if (!isSameTrack || trackEnded) {
                try {
                  if (track) {
                    await this.room.localParticipant.unpublishTrack(track, false);
                  }
                } catch {}
              }
            }
      }

      // Включаем mediaTrack если нужна камера
      if (this.localVideoTrack.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
      }
      // Синхронизируем mute с флагом камеры
      if (this.isCamOn && this.localVideoTrack.isMuted) {
        this.localVideoTrack.unmute();
      } else if (!this.isCamOn && !this.localVideoTrack.isMuted) {
        this.localVideoTrack.mute();
      }

      // КРИТИЧНО: Проверяем состояние комнаты и участника перед публикацией
      // Участник должен иметь sid (session ID), что означает что он полностью добавлен в комнату
      if (!this.room || 
          this.room.state !== 'connected' || 
          !this.room.localParticipant || 
          !this.room.localParticipant.sid) {
        logger.warn('[RandomChatSession] Room not connected or participant not ready, skipping video track publish', {
          roomState: this.room?.state,
          hasLocalParticipant: !!this.room?.localParticipant,
          participantSid: this.room?.localParticipant?.sid
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем, не опубликован ли трек уже
      if (this.isVideoTrackPublished(this.localVideoTrack)) {
        logger.debug('[RandomChatSession] Video track already published, skipping', {
          trackId: this.localVideoTrack.sid || this.localVideoTrack.mediaStreamTrack?.id,
        });
        // Обновляем состояние камеры без повторной публикации
        try {
          await this.room.localParticipant.setCameraEnabled(this.isCamOn);
        } catch {}
        return;
      }
      
      if (this.isCamOn || force) {
        // КРИТИЧНО: Проверяем состояние комнаты и участника перед публикацией
        // Участник должен иметь sid (session ID), что означает что он полностью добавлен в комнату
        if (!this.room || 
            this.room.state !== 'connected' || 
            !this.room.localParticipant || 
            !this.room.localParticipant.sid) {
          logger.debug('[RandomChatSession] Room disconnected or participant not ready during publish, skipping', {
            roomState: this.room?.state,
            hasLocalParticipant: !!this.room?.localParticipant,
            participantSid: this.room?.localParticipant?.sid
          });
          return;
        }
        
        await this.room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
          const errorMsg = e?.message || String(e || '');
          const errorName = e?.name || '';
          // КРИТИЧНО: Игнорируем ошибки связанные с отключением комнаты, fingerprint mismatch и отсутствующими участниками
          if (errorMsg.includes('already') || 
              errorMsg.includes('duplicate') ||
              errorMsg.includes('closed') ||
              errorMsg.includes('disconnected') ||
              errorMsg.includes('fingerprint') ||
              errorMsg.includes('identity') ||
              errorMsg.includes('ERROR_CONTENT') ||
              errorMsg.includes('not present') ||
              (errorMsg.includes('participant') && errorMsg.includes('not present')) ||
              errorName === 'PublishTrackError') {
            logger.debug('[RandomChatSession] Ignoring publish error (duplicate/closed/fingerprint/not present)', { 
              error: errorMsg,
              errorName 
            });
            return;
          }
          // Для других ошибок логируем, но не бросаем исключение
          logger.warn('[RandomChatSession] Failed to publish video track (non-critical)', {
            error: errorMsg,
            errorName,
            roomState: this.room?.state
          });
        });
        
        // КРИТИЧНО: Проверяем состояние комнаты после публикации
        if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) {
          logger.debug('[RandomChatSession] Room disconnected after publish, skipping setCameraEnabled');
          return;
        }
        
        try {
          await this.room.localParticipant.setCameraEnabled(this.isCamOn);
        } catch {}
        logger.info('[RandomChatSession] Video track published', {
          trackId: this.localVideoTrack.sid || this.localVideoTrack.mediaStreamTrack?.id,
          isMuted: this.localVideoTrack.isMuted,
        });
      }
    } catch (e) {
      logger.warn('[RandomChatSession] Failed to publish video track after recovery', e);
    }
  }

  /**
   * Проверяет, опубликован ли видео трек в комнате
   */
  private isVideoTrackPublished(track: LocalVideoTrack | null): boolean {
    if (!this.room || !track || !this.room.localParticipant) return false;
    
    const publications = this.room.localParticipant.videoTrackPublications;
    if (!publications) return false;
    
    try {
      if (typeof publications.values === 'function') {
        // Это Map - проверяем через values()
        for (const pub of publications.values()) {
          if (pub.track === track || pub.trackSid === track.sid) {
            return true;
          }
        }
      } else if (Array.isArray(publications)) {
        // Это массив - используем find
        return publications.some(
          pub => pub.track === track || pub.trackSid === track.sid
        );
      }
    } catch (e) {
      logger.debug('[RandomChatSession] Error checking video track publication', e);
    }
    
    return false;
  }

  /**
   * Проверяет, опубликован ли аудио трек в комнате
   */
  private isAudioTrackPublished(track: LocalAudioTrack | null): boolean {
    if (!this.room || !track || !this.room.localParticipant) return false;
    
    const publications = this.room.localParticipant.audioTrackPublications;
    if (!publications) return false;
    
    try {
      if (typeof publications.values === 'function') {
        // Это Map - проверяем через values()
        for (const pub of publications.values()) {
          if (pub.track === track || pub.trackSid === track.sid) {
            return true;
          }
        }
      } else if (Array.isArray(publications)) {
        // Это массив - используем find
        return publications.some(
          pub => pub.track === track || pub.trackSid === track.sid
        );
      }
    } catch (e) {
      logger.debug('[RandomChatSession] Error checking audio track publication', e);
    }
    
    return false;
  }

  private async unpublishVideoTrackKeepAlive(): Promise<void> {
    if (this.isCamOn) return; // не трогаем если камера включена
    if (!this.room) return;
    try {
      const publications = this.room.localParticipant.videoTrackPublications;
      if (publications && typeof publications.values === 'function') {
        for (const pub of publications.values()) {
          if (pub.track) {
            await this.room.localParticipant.unpublishTrack(pub.track, false);
          }
        }
      } else if (Array.isArray(publications)) {
        for (const pub of publications) {
          if (pub.track) {
            await this.room.localParticipant.unpublishTrack(pub.track, false);
          }
        }
      }
      logger.info('[RandomChatSession] Video track unpublished (cam off, keep alive)');
    } catch (e) {
      logger.warn('[RandomChatSession] Failed to unpublish video track', e);
    }

    // Удаляем видео трек из localStream, чтобы он не перепубликовался автоматически
    if (this.localVideoTrack?.mediaStreamTrack) {
      try {
        this.localVideoTrack.mediaStreamTrack.enabled = false;
      } catch {}
    }
    if (this.localStream) {
      try {
        this.localStream.getVideoTracks().forEach((t) => {
          try {
            this.localStream?.removeTrack(t as any);
          } catch {}
        });
      } catch {}
    }
    // Не стопаем трек здесь, чтобы не ломать быстрый ре-паблиш
  }

  private async connectToLiveKit(url: string, token: string, connectRequestId: number, targetRoomName?: string): Promise<boolean> {
    // КРИТИЧНО: Проверяем, что это актуальный запрос на подключение
    // Если connectRequestId изменился, значит был новый вызов next() и этот запрос устарел
    if (this.connectRequestId !== connectRequestId) {
      logger.debug('[RandomChatSession] Connect request is stale, aborting', {
        connectRequestId,
        currentRequestId: this.connectRequestId,
        targetRoomName
      });
      return false;
    }

    // КРИТИЧНО: Проверяем, можно ли переиспользовать существующую комнату
    // Если комната уже подключена к той же комнате LiveKit, не переподключаемся
    if (this.room && 
        this.room.state === 'connected' && 
        this.currentRoomName && 
        targetRoomName && 
        this.currentRoomName === targetRoomName) {
      logger.debug('[RandomChatSession] Room already connected to target room, reusing', {
        roomName: targetRoomName,
        roomState: this.room.state,
      });
      // Убеждаемся что треки опубликованы
      if (this.localVideoTrack && this.isCamOn) {
        await this.publishVideoTrackIfRoomActive();
      }
      return true;
    }
    
    // КРИТИЧНО: Если идет отключение, не создаем новое подключение
    if (this.isDisconnecting) {
      logger.debug('[RandomChatSession] Disconnecting in progress, aborting connect', {
        connectRequestId,
        targetRoomName
      });
      return false;
    }
    
    // КРИТИЧНО: Отключаем предыдущую комнату перед подключением к новой
    // Оптимизировано: отключаем только если комната подключена к другой комнате
    if (this.room && 
        this.room.state !== 'disconnected' && 
        (!this.currentRoomName || !targetRoomName || this.currentRoomName !== targetRoomName)) {
      // КРИТИЧНО: Не ждем полного отключения - просто отключаем асинхронно
      // Это ускоряет подключение к новому собеседнику
      void this.disconnectRoom('user');
    }
    
    // КРИТИЧНО: Если комната все еще существует, принудительно очищаем состояние
    // Не ждем полного отключения - это замедляет подключение
    if (this.room && this.room.state === 'disconnected') {
      this.room = null;
      this.currentRoomName = null;
      this.isDisconnecting = false;
      this.disconnectPromise = null;
    }
    
    // КРИТИЧНО: Убеждаемся что локальные треки существуют и активны
    // Если треки были остановлены (чего не должно быть при next()), пересоздаем их
    // КРИТИЧНО: Сохраняем текущий localStream ПЕРЕД пересозданием треков, чтобы не было черного экрана
    const prevLocalStream = this.localStream;
    
    if (!this.localVideoTrack || !this.localAudioTrack) {
      logger.info('[RandomChatSession] Local tracks missing, recreating...');
      await this.ensureLocalTracks();
    } else {
      // КРИТИЧНО: Проверяем что треки не остановлены
      // Если треки остановлены, пересоздаем их
      const videoEnded = this.localVideoTrack.mediaStreamTrack?.readyState === 'ended';
      const audioEnded = this.localAudioTrack.mediaStreamTrack?.readyState === 'ended';
      
      if (videoEnded || audioEnded) {
        logger.warn('[RandomChatSession] Local tracks ended, recreating...', { videoEnded, audioEnded });
        // КРИТИЧНО: Сохраняем предыдущий стрим перед пересозданием, чтобы не было черного экрана
        // Компонент будет использовать предыдущий стрим пока новый не готов
        const prevStream = this.localStream;
        await this.ensureLocalTracks();
        // КРИТИЧНО: Если новый стрим не готов, эмитим предыдущий чтобы не было черного экрана
        // Проверяем что новый стрим валидный (имеет треки)
        const newStreamValid = this.localStream && 
          this.localStream.getTracks && 
          this.localStream.getTracks().length > 0;
        if (prevStream && (!newStreamValid)) {
          this.emit('localStream', prevStream);
          this.config.callbacks.onLocalStreamChange?.(prevStream);
          this.config.onLocalStreamChange?.(prevStream);
        }
      } else {
        // Треки активны, убеждаемся что они включены
        if (this.localVideoTrack.isMuted !== !this.isCamOn) {
          if (this.isCamOn) {
            this.localVideoTrack.unmute();
          } else {
            this.localVideoTrack.mute();
          }
        }
        if (this.localAudioTrack.isMuted !== !this.isMicOn) {
          if (this.isMicOn) {
            this.localAudioTrack.unmute();
          } else {
            this.localAudioTrack.mute();
          }
        }
        // КРИТИЧНО: Если треки активны, эмитим localStream СРАЗУ чтобы компонент обновился
        // Это гарантирует что UI использует актуальный стрим БЕЗ задержки
        // КРИТИЧНО: Эмитим ДО публикации треков для мгновенного отображения камеры
        if (this.localStream) {
          this.emit('localStream', this.localStream);
          this.config.callbacks.onLocalStreamChange?.(this.localStream);
          this.config.onLocalStreamChange?.(this.localStream);
        }
      }
    }
    
    // КРИТИЧНО: Эмитим localStream СРАЗУ после подключения, ДО публикации треков
    // Это убирает задержку и зависание камеры при подключении
    if (this.localStream) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
    }
    
    // КРИТИЧНО: Проверяем еще раз перед созданием новой комнаты
    // Это защита от race conditions
    // Но если комната уже подключена к нужной комнате, не создаем новую
    if (this.room !== null) {
      if (this.room.state === 'connected' && 
          this.currentRoomName && 
          targetRoomName && 
          this.currentRoomName === targetRoomName) {
        logger.debug('[RandomChatSession] Room already connected to target, skipping creation');
        return true;
      }
      
      // КРИТИЧНО: Вместо простого abort, принудительно очищаем зависшую комнату
      // Это позволяет восстановиться из race condition при быстрых нажатиях "next"
      const existingRoomState = this.room?.state || 'unknown';
      logger.warn('[RandomChatSession] Room still exists before creating new one, force clearing', {
        roomState: existingRoomState,
        currentRoomName: this.currentRoomName,
        targetRoomName: targetRoomName,
        isDisconnecting: this.isDisconnecting,
        connectRequestId
      });
      
      // КРИТИЧНО: Принудительно очищаем комнату если она в неправильном состоянии
      // Это защита от зависших состояний при множественных нажатиях "next"
      try {
        const stuckRoom: Room | null = this.room;
        if (stuckRoom) {
          const stuckRoomState: string = stuckRoom.state as string;
          if (stuckRoomState !== 'disconnected') {
            // КРИТИЧНО: Отключаем зависшую комнату без ожидания
            await stuckRoom.disconnect().catch((e: any) => {
              logger.debug('[RandomChatSession] Error disconnecting stuck room', {
                error: e?.message || String(e),
              });
            });
          }
        }
        // КРИТИЧНО: Очищаем все ссылки на старую комнату
        this.room = null;
        this.currentRoomName = null;
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        logger.warn('[RandomChatSession] Force cleared stuck room, will retry connection');
        // КРИТИЧНО: После очистки продолжаем создание новой комнаты вместо возврата false
        // Это позволяет восстановиться из зависшего состояния
      } catch (e: any) {
        logger.warn('[RandomChatSession] Error force clearing room', {
          error: e?.message || String(e),
          errorName: e?.name
        });
        // Даже при ошибке очистки продолжаем попытку подключения
        this.room = null;
        this.currentRoomName = null;
        this.isDisconnecting = false;
        this.disconnectPromise = null;
      }
    }
    
    const room = new Room({
      // Отключаем dynacast/adaptiveStream, чтобы LiveKit не мьютил треки и не слал quality updates для "unknown track"
      adaptiveStream: false,
      dynacast: false,
      publishDefaults: {
        videoEncoding: { maxBitrate: 1200_000, maxFramerate: 30 },
        videoSimulcastLayers: [],
      },
    });
    this.room = room;
    this.registerRoomEvents(room);

    try {
      // КРИТИЧНО: Новая комната всегда в состоянии 'disconnected' до connect()
      // Проверяем состояние только после попытки подключения
      logger.info('[RandomChatSession] Attempting to connect to LiveKit', {
        url,
        urlHost: url ? new URL(url).hostname : 'unknown',
        tokenLength: token?.length || 0,
        tokenPrefix: token ? token.substring(0, 20) + '...' : 'no-token',
        targetRoomName,
        roomState: room.state,
      });
      
      await room.connect(url, token, { autoSubscribe: true });
      
      // КРИТИЧНО: Проверяем состояние после подключения
      if (room.state !== 'connected') {
        logger.warn('[RandomChatSession] Room not connected after connect call', { 
          state: room.state,
          url,
          targetRoomName,
          hasToken: !!token,
          tokenLength: token?.length || 0,
        });
        if (this.room === room) {
          this.room = null;
          this.currentRoomName = null;
        }
        return false;
      }
      
      logger.info('[RandomChatSession] Successfully connected to LiveKit', {
        roomName: room.name,
        state: room.state,
        targetRoomName,
      });
      
      // Сохраняем имя подключенной комнаты для проверки переиспользования
      this.currentRoomName = room.name || targetRoomName || null;
      logger.debug('[RandomChatSession] Room connected, saved room name', {
        roomName: this.currentRoomName,
        roomState: room.state,
      });
    } catch (e: any) {
      const errorMessage = e?.message || String(e);
      const isInvalidApiKey = errorMessage.includes('invalid API key') || 
                               errorMessage.includes('401') ||
                               errorMessage.includes('Unauthorized');
      
      logger.error('[RandomChatSession] Error connecting to LiveKit', {
        error: errorMessage,
        errorCode: e?.code,
        errorName: e?.name,
        url,
        urlHost: url ? new URL(url).hostname : 'unknown',
        targetRoomName,
        hasToken: !!token,
        tokenLength: token?.length || 0,
        tokenPrefix: token ? token.substring(0, 20) + '...' : 'no-token',
        roomState: room?.state,
        isInvalidApiKey,
        stack: e?.stack,
      });
      
      // Если ошибка связана с API ключом, логируем дополнительную информацию
      if (isInvalidApiKey) {
        logger.error('[RandomChatSession] ⚠️ LiveKit API key validation failed!', {
          url,
          possibleCauses: [
            'API key/secret mismatch between backend and LiveKit server',
            'LiveKit URL points to wrong server',
            'Token expired or malformed',
            'Backend environment variables not set correctly'
          ],
          suggestion: 'Check LIVEKIT_API_KEY and LIVEKIT_API_SECRET in backend .env file match LiveKit server credentials'
        });
      }
      
      if (this.room === room) {
        this.room = null;
        this.currentRoomName = null;
      }
      if (this.connectRequestId !== connectRequestId || this.room !== room) {
        // Подключение отменено (например, пользователь нажал «Далее»)
        return false;
      }
      throw e;
    }

    if (this.connectRequestId !== connectRequestId || this.room !== room) {
      await this.safeDisconnect(room);
      return false;
    }

    // КРИТИЧНО: Эмитим localStream СРАЗУ после подключения, ДО публикации треков
    // Это убирает задержку и зависание камеры при подключении
    if (this.localStream) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
    }

    // КРИТИЧНО: Ждем полного подключения участника перед публикацией треков
    // Это предотвращает ошибку "Tried to add a track for a participant, that's not present"
    // Участник должен иметь sid (session ID), что означает что он полностью добавлен в комнату
    // ОПТИМИЗАЦИЯ: Уменьшено время ожидания для быстрого подключения
    let participantReady = false;
    let waitAttempts = 0;
    const maxWaitAttempts = 10; // 10 * 50ms = 500ms максимум (было 2.5 секунды)
    
    while (!participantReady && waitAttempts < maxWaitAttempts) {
      if (room.state === 'connected' && 
          room.localParticipant && 
          room.localParticipant.sid) {
        participantReady = true;
        break;
      }
      // Ждем 50ms перед следующей проверкой
      await new Promise(resolve => setTimeout(resolve, 50));
      waitAttempts++;
      
      // Проверяем что запрос еще актуален
      if (this.connectRequestId !== connectRequestId || this.room !== room) {
        logger.debug('[RandomChatSession] Connect request cancelled while waiting for participant');
        return false;
      }
    }
    
    // КРИТИЧНО: Проверяем состояние комнаты перед публикацией треков
    // Это предотвращает попытки создать offer на закрытом peer connection
    if (room.state !== 'connected' || !room.localParticipant || !room.localParticipant.sid) {
      logger.warn('[RandomChatSession] Room not connected or participant not ready, skipping track publish', {
        state: room.state,
        hasLocalParticipant: !!room.localParticipant,
        participantSid: room.localParticipant?.sid,
        waitAttempts
      });
      return true; // Подключение успешно, просто треки не опубликованы
    }
    
    // КРИТИЧНО: Добавляем небольшую задержку перед публикацией треков
    // Это дает время LiveKit обработать все события отключения предыдущих участников
    // и предотвращает ошибку "Tried to add a track for a participant, that's not present"
    // ОПТИМИЗАЦИЯ: Уменьшена задержка для быстрого подключения (было 100ms)
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // КРИТИЧНО: Проверяем еще раз после задержки, что комната все еще подключена
    // и запрос еще актуален (не было отмены через next())
    if (this.connectRequestId !== connectRequestId || this.room !== room) {
      logger.debug('[RandomChatSession] Connect request cancelled during delay before track publish');
      return false;
    }
    
    if (room.state !== 'connected' || !room.localParticipant || !room.localParticipant.sid) {
      logger.warn('[RandomChatSession] Room disconnected during delay, skipping track publish', {
        state: room.state,
        hasLocalParticipant: !!room.localParticipant,
        participantSid: room.localParticipant?.sid
      });
      return true; // Подключение было успешным, просто треки не опубликованы
    }
    
    // КРИТИЧНО: Публикуем треки напрямую - LiveKit сам обработает дубликаты
    // Не проверяем наличие публикаций, так как это может вызвать ошибки с Map API
    if (this.localVideoTrack && this.localVideoTrack.mediaStreamTrack?.readyState !== 'ended') {
      try {
        // КРИТИЧНО: Дополнительная проверка состояния перед публикацией
        // Проверяем не только наличие localParticipant, но и его sid (присутствие в комнате)
        if (room.state === 'connected' && room.localParticipant && room.localParticipant.sid) {
          // Если трек еще не опубликован (sid нет), не дергаем mute/unmute LiveKit — только включаем/выключаем mediaTrack
          if (!this.localVideoTrack.sid && this.localVideoTrack.mediaStreamTrack) {
            this.localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
          } else {
            // КРИТИЧНО: Убеждаемся что трек включен перед публикацией
            if (this.isCamOn && this.localVideoTrack.isMuted) {
              this.localVideoTrack.unmute();
            } else if (!this.isCamOn && !this.localVideoTrack.isMuted) {
              this.localVideoTrack.mute();
            }
          }
          // КРИТИЧНО: Публикуем трек сразу без проверки isVideoTrackPublished для ускорения
          // Проверка isVideoTrackPublished может вызывать задержку из-за Map API
          // LiveKit сам обработает дубликаты, поэтому проверка не нужна
          if (this.isCamOn) {
            // КРИТИЧНО: Проверяем состояние комнаты и участника непосредственно перед публикацией
            // Это предотвращает ошибку "Tried to add a track for a participant, that's not present"
            // Участник должен быть полностью добавлен в комнату (иметь sid)
            if (room.state === 'connected' && 
                room.localParticipant && 
                room.localParticipant.sid &&
                this.room === room) {
            await room.localParticipant.publishTrack(this.localVideoTrack).catch((e: any) => {
              // КРИТИЧНО: Улучшенная обработка ошибок публикации для предотвращения крашей
              const errorMsg = e?.message || String(e || '');
              const errorName = e?.name || '';
              
              // Игнорируем ошибки дубликатов, закрытых соединений, таймаутов, fingerprint mismatch и отсутствующих участников
              if (errorMsg.includes('already') || 
                  errorMsg.includes('duplicate') || 
                  errorMsg.includes('closed') ||
                  errorMsg.includes('disconnected') ||
                  errorMsg.includes('timeout') ||
                  errorMsg.includes('engine not connected') ||
                  errorMsg.includes('not present') ||
                  errorMsg.includes('fingerprint') ||
                  errorMsg.includes('identity') ||
                  errorMsg.includes('ERROR_CONTENT') ||
                  (errorMsg.includes('participant') && errorMsg.includes('not present')) ||
                  errorName === 'PublishTrackError') {
                logger.debug('[RandomChatSession] Ignoring publish error (duplicate/closed/timeout/fingerprint/not present)', { 
                  error: errorMsg,
                  errorName 
                });
                return;
              }
              
              // КРИТИЧНО: Для других ошибок логируем, но не бросаем исключение
              logger.warn('[RandomChatSession] Failed to publish video track (non-critical)', {
                error: errorMsg,
                errorName,
                roomState: room.state
              });
            });
            
            // КРИТИЧНО: Проверяем что трек действительно опубликован перед логированием
            // Но не ждем - публикуем асинхронно для ускорения
            if (this.isVideoTrackPublished(this.localVideoTrack)) {
              logger.info('[RandomChatSession] Video track published', {
                trackId: this.localVideoTrack.sid || this.localVideoTrack.mediaStreamTrack?.id,
                isMuted: this.localVideoTrack.isMuted,
              });
            }
            }
          } else {
            // Камера выключена — не публикуем трек, чтобы у новой пары не было ложного видео
            if (this.localVideoTrack.mediaStreamTrack) {
              this.localVideoTrack.mediaStreamTrack.enabled = false;
            }
            try {
              this.localVideoTrack.mute();
            } catch {}
            // важный момент: не дергаем unpublish здесь, connectToLiveKit уже сделал disconnectRoom перед этим
          }
        }
      } catch (e: any) {
        // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей
        const errorMsg = e?.message || String(e || '');
        const errorName = e?.name || '';
        logger.warn('[RandomChatSession] Failed to publish video track', {
          error: errorMsg,
          errorName,
          roomState: room?.state
          // Не логируем полный объект ошибки - это может вызвать проблемы на Android
        });
        // Не блокируем успех подключения - трек может быть опубликован позже
        // Не бросаем исключение - это может вызвать краш на Android
      }
    }
    
    if (this.localAudioTrack && this.localAudioTrack.mediaStreamTrack?.readyState !== 'ended') {
      try {
        // КРИТИЧНО: Дополнительная проверка состояния перед публикацией
        // Проверяем не только наличие localParticipant, но и его sid (присутствие в комнате)
        // КРИТИЧНО: Проверяем состояние комнаты и участника непосредственно перед публикацией
        // Это предотвращает ошибку "Tried to add a track for a participant, that's not present"
        // Участник должен быть полностью добавлен в комнату (иметь sid)
        if (room.state === 'connected' && 
            room.localParticipant && 
            room.localParticipant.sid &&
            this.room === room) {
          // КРИТИЧНО: Публикуем трек сразу без проверки isAudioTrackPublished для ускорения
          // Проверка isAudioTrackPublished может вызывать задержку из-за Map API
          // LiveKit сам обработает дубликаты, поэтому проверка не нужна
          // Публикуем трек сразу с улучшенной обработкой ошибок
          await room.localParticipant.publishTrack(this.localAudioTrack).catch((e: any) => {
            // КРИТИЧНО: Улучшенная обработка ошибок публикации для предотвращения крашей
            const errorMsg = e?.message || String(e || '');
            const errorName = e?.name || '';
            
            // Игнорируем ошибки дубликатов, закрытых соединений, таймаутов, fingerprint mismatch и отсутствующих участников
            if (errorMsg.includes('already') || 
                errorMsg.includes('duplicate') || 
                errorMsg.includes('closed') ||
                errorMsg.includes('disconnected') ||
                errorMsg.includes('timeout') ||
                errorMsg.includes('engine not connected') ||
                errorMsg.includes('not present') ||
                errorMsg.includes('fingerprint') ||
                errorMsg.includes('identity') ||
                errorMsg.includes('ERROR_CONTENT') ||
                (errorMsg.includes('participant') && errorMsg.includes('not present')) ||
                errorName === 'PublishTrackError') {
              logger.debug('[RandomChatSession] Ignoring publish error (duplicate/closed/timeout/fingerprint/not present)', { 
                error: errorMsg,
                errorName 
              });
              return;
            }
            
            // КРИТИЧНО: Для других ошибок логируем, но не бросаем исключение
            // Это предотвращает краши приложения на Android
            logger.warn('[RandomChatSession] Failed to publish audio track (non-critical)', {
              error: errorMsg,
              errorName,
              roomState: room.state
            });
          });
          
          // КРИТИЧНО: Применяем mute/unmute ПОСЛЕ публикации трека
          // LiveKit не позволяет изменять статус mute до публикации
          // КРИТИЧНО: Обернуто в try-catch для предотвращения крашей
          try {
            if (!this.isMicOn && !this.localAudioTrack.isMuted) {
              this.localAudioTrack.mute();
            } else if (this.isMicOn && this.localAudioTrack.isMuted) {
              this.localAudioTrack.unmute();
            }
          } catch (muteError) {
          logger.debug('[RandomChatSession] Error toggling audio mute state', muteError);
        }
        
          // КРИТИЧНО: Проверяем что трек действительно опубликован перед логированием
          if (this.isAudioTrackPublished(this.localAudioTrack)) {
            logger.info('[RandomChatSession] Audio track published', {
              trackId: this.localAudioTrack.sid || this.localAudioTrack.mediaStreamTrack?.id,
              isMuted: this.localAudioTrack.isMuted,
            });
          }
        }
      } catch (e: any) {
        // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей
        const errorMsg = e?.message || String(e || '');
        logger.warn('[RandomChatSession] Failed to publish audio track (caught)', {
          error: errorMsg,
          errorName: e?.name,
          roomState: room?.state
        });
        // Не блокируем успех подключения - трек может быть опубликован позже
        // Не бросаем исключение - это может вызвать краш на Android
      }
    }

    // Обновляем состояние камеры и микрофона
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    
    // КРИТИЧНО: Скрываем лоадер после успешного подключения и публикации треков
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    this.config.setIsInactiveState?.(false);
    
    return true;
  }

  private async disconnectRoom(reason: 'user' | 'server' = 'user'): Promise<void> {
    // КРИТИЧНО: Защита от множественных вызовов disconnectRoom
    // Если уже идет отключение, возвращаем существующий промис
    if (this.isDisconnecting && this.disconnectPromise) {
      logger.debug('[RandomChatSession] disconnectRoom already in progress, waiting...');
      return this.disconnectPromise;
    }
    
    const room = this.room;
    if (!room) {
      logger.debug('[RandomChatSession] disconnectRoom: no room to disconnect');
      // КРИТИЧНО: Сбрасываем флаги, если комнаты нет
      this.isDisconnecting = false;
      this.disconnectPromise = null;
      return;
    }
    
    // КРИТИЧНО: Проверяем состояние комнаты - не пытаемся отключиться если комната еще не подключена
    // или уже отключена. Это предотвращает ошибку "cannot send signal request before connected"
    const roomState = room.state;
    if (roomState === 'disconnected') {
      logger.debug('[RandomChatSession] disconnectRoom: room already disconnected', { 
        state: roomState 
      });
      this.room = null;
      this.currentRoomName = null; // Очищаем имя комнаты
      this.isDisconnecting = false;
      this.disconnectPromise = null;
      return;
    }
    // КРИТИЧНО: Если комната еще connecting, ждем подключения или отключения
    if (roomState === 'connecting') {
      logger.debug('[RandomChatSession] disconnectRoom: room still connecting, waiting for connection or timeout', { 
        state: roomState 
      });
      // Ждем максимум 3 секунды, затем принудительно отключаем
      let waitCount = 0;
      const maxWait = 30; // 30 * 100ms = 3 секунды
      while (room.state === 'connecting' && waitCount < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      // Если все еще connecting, принудительно отключаем
      if (room.state === 'connecting') {
        logger.warn('[RandomChatSession] Room stuck in connecting state, forcing disconnect');
        try {
          await room.disconnect();
        } catch (e) {
          logger.debug('[RandomChatSession] Error disconnecting connecting room', e);
        }
      }
      // Продолжаем нормальный процесс отключения
    }
    
    this.isDisconnecting = true;
    this.disconnectReason = reason;
    
    // КРИТИЧНО: Создаем промис, который разрешится только когда комната полностью отключится
    // Это гарантирует, что все ресурсы (включая ping/pong handlers) будут очищены перед новым подключением
    this.disconnectPromise = new Promise<void>((resolve) => {
      // КРИТИЧНО: Сохраняем ссылку на room, чтобы не потерять её при установке this.room = null
      const roomToDisconnect = room;
      let disconnectedHandler: (() => void) | null = null;
      let timeoutId: NodeJS.Timeout | null = null;
      
      // Устанавливаем обработчик события Disconnected
      disconnectedHandler = () => {
        logger.debug('[RandomChatSession] Room fully disconnected, cleanup complete', { 
          reason: this.disconnectReason 
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        this.disconnectReason = 'unknown';
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        resolve();
      };
      
      // Подписываемся на событие Disconnected
      roomToDisconnect.once(RoomEvent.Disconnected, disconnectedHandler);
      
      // Таймаут на случай, если событие Disconnected не придет (защита от зависания)
      timeoutId = setTimeout(() => {
        logger.warn('[RandomChatSession] Disconnect timeout, forcing cleanup', { 
          roomState: roomToDisconnect.state 
        });
        if (disconnectedHandler) {
          roomToDisconnect.off(RoomEvent.Disconnected, disconnectedHandler);
        }
        this.disconnectReason = 'unknown';
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        resolve();
      }, 5000); // 5 секунд максимум на отключение
      
      // КРИТИЧНО: Отписываем треки ПЕРЕД disconnect, чтобы LiveKit не останавливал их
      // Это предотвращает остановку треков (ended) при disconnect, что вызывает черный экран
      // Отписываем БЕЗ остановки треков (stop: false), чтобы они остались активными
      void (async () => {
        try {
          const localParticipant = roomToDisconnect.localParticipant;
          if (localParticipant) {
            // Отписываем все опубликованные треки через публикации
            const videoPubs = localParticipant.videoTrackPublications;
            const audioPubs = localParticipant.audioTrackPublications;
            
            // Отписываем видео треки
            if (videoPubs) {
              const pubs = typeof videoPubs.values === 'function' 
                ? Array.from(videoPubs.values())
                : Array.isArray(videoPubs) ? videoPubs : [];
              
              for (const pub of pubs) {
                if (pub.track && (pub.track === this.localVideoTrack || pub.trackSid === this.localVideoTrack?.sid)) {
                  try {
                    await localParticipant.unpublishTrack(pub.track, false);
                    logger.debug('[RandomChatSession] Video track unpublished before disconnect');
                  } catch (e) {
                    logger.debug('[RandomChatSession] Error unpublishing video track', e);
                  }
                }
              }
            }
            
            // Отписываем аудио треки
            if (audioPubs) {
              const pubs = typeof audioPubs.values === 'function'
                ? Array.from(audioPubs.values())
                : Array.isArray(audioPubs) ? audioPubs : [];
              
              for (const pub of pubs) {
                if (pub.track && (pub.track === this.localAudioTrack || pub.trackSid === this.localAudioTrack?.sid)) {
                  try {
                    await localParticipant.unpublishTrack(pub.track, false);
                    logger.debug('[RandomChatSession] Audio track unpublished before disconnect');
                  } catch (e) {
                    logger.debug('[RandomChatSession] Error unpublishing audio track', e);
                  }
                }
              }
            }
          }
        } catch (e) {
          logger.debug('[RandomChatSession] Error unpublishing tracks before disconnect', e);
        }
      })();
      
      // Увеличиваем connectRequestId, чтобы остановить отложенные подключения
      this.connectRequestId++;
      // КРИТИЧНО: НЕ устанавливаем this.room = null сразу - это делается только после полного отключения
      // в обработчике Disconnected, чтобы избежать утечек соединений
      
      // КРИТИЧНО: НЕ вызываем room.removeAllListeners() перед disconnect()
      // Это удаляет внутренние обработчики LiveKit (ping/pong, корректное завершение),
      // что приводит к "ping timeout" и "connection state mismatch" ошибкам.
      // room.disconnect() сам корректно завершит соединение и очистит ресурсы.
      
      // Вызываем disconnect и ждем события Disconnected
      (async () => {
        try {
          // КРИТИЧНО: Проверяем состояние еще раз перед disconnect, чтобы избежать ошибки
          if (roomToDisconnect.state !== 'disconnected' && roomToDisconnect.state !== 'connecting') {
            await roomToDisconnect.disconnect();
            logger.debug('[RandomChatSession] Room disconnect() called, waiting for Disconnected event');
          } else {
            // Если комната уже отключена, сразу вызываем обработчик
            logger.debug('[RandomChatSession] Room already disconnected, triggering cleanup');
            if (disconnectedHandler) {
              roomToDisconnect.off(RoomEvent.Disconnected, disconnectedHandler);
              disconnectedHandler();
            }
          }
        } catch (e: any) {
          // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей на Android
          const errorMessage = e?.message || String(e || '');
          const errorName = e?.name || '';
          
          // Игнорируем ошибки отключения если комната уже отключена или еще не подключена
          if (!errorMessage.includes('before connected') && 
              !errorMessage.includes('already disconnected') &&
              !errorMessage.includes('ping timeout') &&
              !errorMessage.includes('connection state mismatch')) {
            logger.warn('[RandomChatSession] Error disconnecting room', {
              error: errorMessage,
              errorName,
              roomState: roomToDisconnect?.state
              // Не логируем полный объект ошибки - это может вызвать проблемы на Android
            });
          }
          // Даже при ошибке ждем события Disconnected или таймаута
          // КРИТИЧНО: При ошибке принудительно вызываем cleanup через таймаут
          if (disconnectedHandler) {
            setTimeout(() => {
              try {
                if (roomToDisconnect.state === 'disconnected' || 
                    roomToDisconnect.state === 'reconnecting') {
                  roomToDisconnect.off(RoomEvent.Disconnected, disconnectedHandler);
                  disconnectedHandler();
                }
              } catch (cleanupError) {
                logger.debug('[RandomChatSession] Error in forced cleanup', cleanupError);
              }
            }, 100);
          }
        }
      })();
    });
    
    // Устанавливаем this.room = null только после полного отключения
    // Это делается в обработчике Disconnected через промис
    this.disconnectPromise.then(() => {
      // КРИТИЧНО: Очищаем ссылку на комнату только после полного отключения
      // Это гарантирует, что все ресурсы LiveKit (включая ping/pong) очищены
      try {
        if (this.room === room) {
          this.room = null;
          this.currentRoomName = null; // Очищаем имя комнаты при отключении
          logger.debug('[RandomChatSession] Room reference cleared after full disconnect');
        }
      } catch (e) {
        logger.debug('[RandomChatSession] Error clearing room reference', e);
      }
    }).catch((e: any) => {
      // КРИТИЧНО: В случае ошибки все равно очищаем, но с защитой от крашей
      try {
        const errorMsg = e?.message || String(e || '');
        logger.debug('[RandomChatSession] Disconnect promise rejected, forcing cleanup', {
          error: errorMsg,
          errorName: e?.name
        });
        if (this.room === room) {
          this.room = null;
          this.currentRoomName = null;
        }
        // Сбрасываем флаги принудительно
        this.isDisconnecting = false;
        this.disconnectPromise = null;
      } catch (cleanupError) {
        logger.debug('[RandomChatSession] Error in catch cleanup', cleanupError);
      }
    });
    
    return this.disconnectPromise;
  }

  private async safeDisconnect(room: Room): Promise<void> {
    if (!room) return;
    if (room.state === 'disconnected') {
      return;
    }
    try {
      await room.disconnect();
    } catch (e) {
      logger.warn('[RandomChatSession] Error disconnecting stale room', e);
    }
  }

  private registerRoomEvents(room: Room): void {
    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        // КРИТИЧНО: Игнорируем подписки на локальные треки
        // LiveKit может отправлять события подписки на локальные треки, но они не должны обрабатываться
        // Это предотвращает предупреждение "could not find local track subscription for subscribed event"
        if (participant.isLocal) {
          logger.debug('[RandomChatSession] Ignoring TrackSubscribed for local participant', {
            kind: publication.kind,
            trackSid: publication.trackSid,
          });
          return;
        }
        this.handleTrackSubscribed(track, publication, participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
        // КРИТИЧНО: Проверяем тип участника перед обработкой
        // Локальные треки не должны влиять на remoteStream
        if (participant.isLocal) {
          logger.debug('[RandomChatSession] Ignoring TrackUnsubscribed for local participant', {
            kind: publication.kind,
            trackSid: publication.trackSid,
          });
          return;
        }
        // КРИТИЧНО: Приводим к RemoteParticipant для типизации
        this.handleTrackUnsubscribed(publication, participant as RemoteParticipant);
      })
      .on(RoomEvent.TrackMuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          logger.info('[RandomChatSession] Remote video track muted', {
            trackId: pub.trackSid,
            participantId: participant.identity,
          });
          this.remoteCamEnabled = false;
          // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
          this.remoteViewKey = Date.now();
          this.emit('remoteViewKeyChanged', this.remoteViewKey);
          // КРИТИЧНО: Обновляем remoteStream для отображения заглушки
          if (this.remoteStream) {
            this.emit('remoteStream', this.remoteStream);
            this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
            this.config.onRemoteStreamChange?.(this.remoteStream);
          }
          this.config.callbacks.onRemoteCamStateChange?.(false);
          this.config.onRemoteCamStateChange?.(false);
        }
      })
      .on(RoomEvent.TrackUnmuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          logger.info('[RandomChatSession] Remote video track unmuted', {
            trackId: pub.trackSid,
            participantId: participant.identity,
          });
          this.remoteCamEnabled = true;
          // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
          this.remoteViewKey = Date.now();
          this.emit('remoteViewKeyChanged', this.remoteViewKey);
          // КРИТИЧНО: Обновляем remoteStream для отображения видео
          if (this.remoteStream) {
            this.emit('remoteStream', this.remoteStream);
            this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
            this.config.onRemoteStreamChange?.(this.remoteStream);
          }
          this.config.callbacks.onRemoteCamStateChange?.(true);
          this.config.onRemoteCamStateChange?.(true);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant === this.currentRemoteParticipant) {
          // КРИТИЧНО: Если партнер отключился, мы должны отключиться от комнаты
          // Даже если уже идет процесс отключения, убеждаемся что комната отключена
          if (!this.isDisconnecting && !this.disconnectHandled) {
            this.handleRandomDisconnected('server');
          } else if (this.room && this.room.state !== 'disconnected') {
            // КРИТИЧНО: Если партнер отключился, но мы еще в комнате, принудительно отключаемся
            // Это защита от ситуации, когда один пользователь остался в комнате после next()
            logger.warn('[RandomChatSession] Partner disconnected but room still active, forcing disconnect', {
              roomState: this.room.state,
              isDisconnecting: this.isDisconnecting,
              disconnectHandled: this.disconnectHandled
            });
            void this.disconnectRoom('server');
            this.resetRemoteState();
          }
        }
      })
      .once(RoomEvent.Disconnected, () => {
        // КРИТИЧНО: Убираем циклический вызов handleRandomDisconnected
        // Если комната отключилась по причине 'server', это уже обработано в ParticipantDisconnected
        // или в других обработчиках. Здесь только сбрасываем флаги.
        // КРИТИЧНО: Если идет процесс disconnectRoom через промис, не сбрасываем флаги здесь -
        // это сделает промис в disconnectRoom
        logger.debug('[RandomChatSession] Room disconnected event received', { 
          reason: this.disconnectReason, 
          started: this.started,
          isDisconnecting: this.isDisconnecting,
          hasDisconnectPromise: !!this.disconnectPromise
        });
        // Флаги будут сброшены в disconnectRoom через промис, если он активен
        // Если disconnectRoom не был вызван (например, неожиданное отключение), сбрасываем флаги
        if (!this.disconnectPromise) {
          this.disconnectReason = 'unknown';
          this.isDisconnecting = false;
        }
      });
  }

  private handleTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    // КРИТИЧНО: Обрабатываем только треки удаленного участника
    // Локальные треки (participant.isLocal === true) не должны влиять на remoteStream
    if (participant.isLocal) {
      logger.debug('[RandomChatSession] Ignoring subscription of local track', {
        kind: publication.kind,
        trackId: track.sid,
      });
      return;
    }
    
    logger.info('[RandomChatSession] Remote track subscribed', {
      kind: publication.kind,
      trackId: track.sid,
      participantId: participant.identity,
      isMuted: track.isMuted,
      trackReady: track.mediaStreamTrack?.readyState,
    });
    
    this.currentRemoteParticipant = participant;
    
    const isVideoTrack = publication.kind === Track.Kind.Video;
    const oldVideoTrackSid = this.remoteVideoTrack?.sid;
    const mediaTrack = track.mediaStreamTrack;
    const wasVideoTrackChanged = isVideoTrack && oldVideoTrackSid && oldVideoTrackSid !== track.sid;
    
    // Не пересоздаем stream, чтобы не было мерцаний — создаем один раз и переиспользуем
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
      logger.debug('[RandomChatSession] Created new remote MediaStream');
    }
    
    const activeRemoteStream = this.remoteStream;
    const trackAlreadyInStream = mediaTrack && activeRemoteStream.getTracks().includes(mediaTrack as any);
    
    // Если видео трек изменился, удаляем старый из потока перед добавлением нового
    if (
      isVideoTrack &&
      wasVideoTrackChanged &&
      this.remoteVideoTrack?.mediaStreamTrack &&
      activeRemoteStream.getTracks().includes(this.remoteVideoTrack.mediaStreamTrack as any)
    ) {
      try {
        activeRemoteStream.removeTrack(this.remoteVideoTrack.mediaStreamTrack as any);
        logger.debug('[RandomChatSession] Removed previous remote video track from stream', {
          oldTrackId: oldVideoTrackSid,
        });
      } catch {}
    }
    
    if (mediaTrack && !trackAlreadyInStream) {
      // LiveKit's MediaStreamTrack is compatible with @livekit/react-native-webrtc's MediaStreamTrack at runtime
      activeRemoteStream.addTrack(mediaTrack as any);
      logger.debug('[RandomChatSession] Added track to remote stream', {
        kind: publication.kind,
        streamId: activeRemoteStream.id,
        tracksCount: activeRemoteStream.getTracks().length,
        hasToURL: typeof activeRemoteStream.toURL === 'function',
        trackId: track.sid,
      });
    }
    
    if (publication.kind === Track.Kind.Audio) {
      this.remoteAudioTrack = track;
    } else if (publication.kind === Track.Kind.Video) {
      const wasMutedStateChanged = this.remoteVideoTrack && (this.remoteVideoTrack.isMuted !== track.isMuted);
      this.remoteVideoTrack = track;
      this.remoteCamEnabled = !track.isMuted;
      
      // КРИТИЧНО: Если состояние muted изменилось, обновляем remoteViewKey
      if (wasMutedStateChanged) {
        logger.debug('[RandomChatSession] Video track muted state changed', {
          wasMuted: this.remoteVideoTrack?.isMuted,
          isMuted: track.isMuted,
        });
        this.remoteViewKey = Date.now();
      }
      
      this.config.callbacks.onRemoteCamStateChange?.(!track.isMuted);
      this.config.onRemoteCamStateChange?.(!track.isMuted);
    }
    
    // КРИТИЧНО: Всегда эмитим remoteStream даже если трек уже был добавлен
    // Это гарантирует обновление UI при изменении треков
    // КРИТИЧНО: Обновляем remoteViewKey при каждом изменении треков для принудительного обновления RTCView
    // Для видео трека обновляем ключ более агрессивно, особенно если трек изменился
    if (isVideoTrack) {
      // Для видео трека всегда обновляем ключ, чтобы гарантировать обновление RTCView
      // Это особенно важно при первом получении видео трека
      this.remoteViewKey = Date.now();
      logger.debug('[RandomChatSession] Updated remoteViewKey for video track', {
        remoteViewKey: this.remoteViewKey,
        trackId: track.sid,
        wasVideoTrackChanged,
        streamId: this.remoteStream.id,
        trackReady: track.mediaStreamTrack?.readyState,
        trackMuted: track.isMuted,
      });
    } else if (publication.kind === Track.Kind.Audio && !this.remoteVideoTrack) {
      // Для аудио трека обновляем ключ только если видео трека еще нет
      this.remoteViewKey = Date.now();
    }
    
    // КРИТИЧНО: Эмитим события в правильном порядке - сначала remoteViewKeyChanged, потом remoteStream
    // Это гарантирует, что компонент обновится с правильным ключом
    // КРИТИЧНО: Эмитим события синхронно для немедленного обновления RTCView
    // Задержка была удалена, так как она вызывала зависание видео
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
    this.emit('remoteStream', this.remoteStream);
    this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
    this.config.onRemoteStreamChange?.(this.remoteStream);
    
    logger.info('[RandomChatSession] Remote stream updated after track subscription', {
      streamId: this.remoteStream.id,
      tracksCount: this.remoteStream.getTracks().length,
      hasVideoTrack: !!this.remoteVideoTrack,
      hasAudioTrack: !!this.remoteAudioTrack,
      remoteCamEnabled: this.remoteCamEnabled,
      remoteViewKey: this.remoteViewKey,
    });
  }

  private handleTrackUnsubscribed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    // КРИТИЧНО: Обрабатываем только треки удаленного участника
    // Локальные треки (participant.isLocal === true) не должны влиять на remoteStream
    if (participant.isLocal) {
      logger.debug('[RandomChatSession] Ignoring unsubscription of local track', {
        kind: publication.kind,
        trackSid: publication.trackSid,
      });
      return;
    }
    
    if (participant !== this.currentRemoteParticipant) {
      return;
    }

    logger.info('[RandomChatSession] Remote track unsubscribed', {
      kind: publication.kind,
      trackSid: publication.trackSid,
      participantId: participant.identity,
    });

    if (publication.kind === Track.Kind.Audio && this.remoteAudioTrack) {
      const mediaTrack = this.remoteAudioTrack.mediaStreamTrack;
      if (mediaTrack && this.remoteStream) {
        this.remoteStream.removeTrack(mediaTrack as any);
      }
      this.remoteAudioTrack = null;
    }
    if (publication.kind === Track.Kind.Video && this.remoteVideoTrack) {
      const unsubscribedTrackSid = publication.trackSid;
      const currentTrackSid = this.remoteVideoTrack.sid;
      
      if (unsubscribedTrackSid === currentTrackSid) {
        const mediaTrack = this.remoteVideoTrack.mediaStreamTrack;
        if (mediaTrack && this.remoteStream) {
          this.remoteStream.removeTrack(mediaTrack as any);
        }
        
        this.remoteVideoTrack = null;
        
        setTimeout(() => {
          if (!this.remoteVideoTrack) {
            this.remoteCamEnabled = false;
            this.remoteViewKey = Date.now();
            this.emit('remoteViewKeyChanged', this.remoteViewKey);
            this.config.callbacks.onRemoteCamStateChange?.(false);
            this.config.onRemoteCamStateChange?.(false);
          } else {
            logger.debug('[RandomChatSession] New video track already subscribed, skipping remoteCamEnabled=false', {
              newTrackSid: this.remoteVideoTrack.sid,
              unsubscribedTrackSid,
            });
          }
        }, 300);
        
        const tracksCount = this.remoteStream?.getTracks().length ?? 0;
        if (this.remoteStream && tracksCount === 0) {
          this.remoteStream = null;
          this.emit('remoteStream', null);
          this.config.callbacks.onRemoteStreamChange?.(null);
          this.config.onRemoteStreamChange?.(null);
        } else if (this.remoteStream) {
          this.emit('remoteStream', this.remoteStream);
          this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
          this.config.onRemoteStreamChange?.(this.remoteStream);
        }
        
        this.remoteViewKey = Date.now();
        this.emit('remoteViewKeyChanged', this.remoteViewKey);
        return;
      } else {
        logger.debug('[RandomChatSession] Ignoring unsubscription of old video track, new track already active', {
          unsubscribedTrackSid,
          currentTrackSid,
        });
        return;
      }
    }

    const tracksCount = this.remoteStream?.getTracks().length ?? 0;
    if (this.remoteStream && tracksCount === 0) {
      this.remoteStream = null;
      this.emit('remoteStream', null);
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
    } else if (this.remoteStream) {
      this.emit('remoteStream', this.remoteStream);
      this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
      this.config.onRemoteStreamChange?.(this.remoteStream);
    }

    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }
}
