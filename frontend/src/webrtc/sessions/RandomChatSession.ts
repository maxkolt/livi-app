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
  private micLevelInterval: NodeJS.Timeout | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micLevelSource: MediaStreamAudioSourceNode | null = null;
  private camToggleInProgress = false;
  private recoveringVideo = false;
  private detachLocalVideoEnded: (() => void) | null = null;
  private micToggleInProgress = false;
  private lastAudioEnergy = 0;
  private lastAudioDuration = 0;

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

  async next(): Promise<void> {
    // КРИТИЧНО: Защита от множественных вызовов next
    if (this.isDisconnecting) {
      logger.debug('[RandomChatSession] next: already disconnecting, skipping');
      return;
    }
    
    // КРИТИЧНО: Локальные треки НЕ останавливаем при next() - они должны продолжать работать
    // Останавливаем только удаленное соединение и сбрасываем состояние удаленного стрима
    
    try {
      socket.emit('next');
    } catch (e) {
      logger.warn('[RandomChatSession] Error emitting next', e);
    }
    
    // Отключаем только комнату, локальные треки остаются активными
    await this.disconnectRoom('user');
    this.resetRemoteState();
    
    // КРИТИЧНО: Добавляем задержку перед обновлением UI, чтобы комната успела отключиться
    // Backend сам возвращает обоих в очередь и запускает tryMatch, поэтому тут НЕ шлем start,
    // иначе получаем дубликаты match_found и разрывы LiveKit комнаты.
    if (this.started) {
      setTimeout(() => {
        if (this.started && !this.isDisconnecting) {
          this.emit('searching');
          this.config.callbacks.onLoadingChange?.(true);
          this.config.onLoadingChange?.(true);
        }
      }, 120);
    }
  }

  autoNext(_reason?: string): void {
    // КРИТИЧНО: Не запускаем поиск если идет отключение или уже есть комната
    if (this.isDisconnecting || this.room) {
      logger.debug('[RandomChatSession] autoNext: skipping (disconnecting or room exists)', {
        isDisconnecting: this.isDisconnecting,
        hasRoom: !!this.room
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
        const hasSid = !!this.localVideoTrack.sid;
        if (hasSid) {
          if (this.isCamOn) {
            this.localVideoTrack.unmute();
          } else {
            this.localVideoTrack.mute();
          }
        } else if (this.localVideoTrack.mediaStreamTrack) {
          this.localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
        }
      } catch {}
    }
    
    // Если камера включается в комнате и трек был пересоздан, убеждаемся что он опубликован
    if (this.isCamOn && this.room && this.localVideoTrack) {
      await this.publishVideoTrackIfRoomActive();
    }
    
    // КРИТИЧНО: При включении камеры убеждаемся что трек есть в localStream
    if (this.isCamOn && this.localStream && this.localVideoTrack?.mediaStreamTrack) {
      const videoTracks = this.localStream.getVideoTracks();
      const hasVideoTrack = videoTracks.some(t => t.id === this.localVideoTrack.mediaStreamTrack?.id);
      if (!hasVideoTrack) {
        // Добавляем видео трек обратно в localStream если его нет
        this.localStream.addTrack(this.localVideoTrack.mediaStreamTrack as any);
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
    this.camSide = this.camSide === 'front' ? 'back' : 'front';
    await this.restartLocalCamera();
  }

  async restartLocalCamera(): Promise<void> {
    await this.ensureLocalTracks(true);
    if (this.room && this.localVideoTrack) {
      try {
        // Отписываем старый трек если он опубликован
        const publications = this.room.localParticipant.videoTrackPublications;
        let existingPub = null;
        
        if (publications && typeof publications.values === 'function') {
          // Это Map - проверяем через values()
          for (const pub of publications.values()) {
            if (pub.track === this.localVideoTrack || pub.trackSid === this.localVideoTrack.sid) {
              existingPub = pub;
              break;
            }
          }
        } else if (Array.isArray(publications)) {
          // Это массив - используем find
          existingPub = publications.find(
            pub => pub.track === this.localVideoTrack || pub.trackSid === this.localVideoTrack.sid
          );
        }
        
        if (existingPub) {
          await this.room.localParticipant.unpublishTrack(this.localVideoTrack);
        }
        // Публикуем новый трек
        await this.room.localParticipant.publishTrack(this.localVideoTrack);
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

  private async handleMatchFound(data: MatchPayload): Promise<void> {
    const partnerId = data.id;
    const roomId = data.roomId ?? null;
    const userId = data.userId ?? null;

    this.resetRemoteState();
    this.emit('matchFound', { partnerId, roomId, userId });
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    if (roomId) {
      this.config.callbacks.onRoomIdChange?.(roomId);
      this.config.onRoomIdChange?.(roomId);
    }

    if (!LIVEKIT_URL) {
      logger.error('[RandomChatSession] LiveKit URL is not configured');
      return;
    }
    if (!data.livekitToken || !data.livekitRoomName) {
      logger.error('[RandomChatSession] Missing LiveKit credentials in match_found payload');
      return;
    }

    // Дедуп: backend может отправить match_found несколько раз (особенно вокруг next/start),
    // а повторный connect приводит к мгновенному disconnect/stream end.
    if (this.room && this.room.state !== 'disconnected' && this.room.name === data.livekitRoomName) {
      logger.debug('[RandomChatSession] Duplicate match_found ignored', { partnerId, roomName: data.livekitRoomName });
      return;
    }

    const connectRequestId = ++this.connectRequestId;
    const connected = await this.connectToLiveKit(LIVEKIT_URL, data.livekitToken, connectRequestId);
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
  }

  private handlePeerLeft(): void {
    // peer:left приходит при "next" партнёра; backend сам возвращает нас в очередь.
    // Здесь только чистим LiveKit и UI, без повторного socket.emit('start'), чтобы избежать дублей.
    // КРИТИЧНО: Защита от множественных вызовов
    if (this.isDisconnecting || this.disconnectHandled) {
      logger.debug('[RandomChatSession] handlePeerLeft: already disconnecting, skipping');
      return;
    }
    
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

    if (force) {
      this.stopLocalTracks();
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
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
    
    // КРИТИЧНО: Запускаем мониторинг уровня микрофона для эквалайзера
    this.lastAudioEnergy = 0;
    this.lastAudioDuration = 0;
    this.startMicLevelMonitoring(stream);
  }

  private stopLocalTracks(): void {
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
    this.isCamOn = false;
    this.isMicOn = false;
    this.config.callbacks.onCamStateChange?.(false);
    this.config.onCamStateChange?.(false);
    this.config.callbacks.onMicStateChange?.(false);
    this.config.onMicStateChange?.(false);
  }
  
  private startMicLevelMonitoring(stream: MediaStream): void {
    // Останавливаем предыдущий мониторинг если он был
    this.stopMicLevelMonitoring();
    
    // Проверяем доступность Web Audio API
    // В React Native может быть недоступен, используем альтернативный подход
    let AudioContextClass: any = null;
    
    if (typeof window !== 'undefined') {
      AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    }
    
    // Также проверяем глобальный объект (для React Native)
    if (!AudioContextClass && typeof global !== 'undefined') {
      AudioContextClass = (global as any).AudioContext || (global as any).webkitAudioContext;
    }
    
    if (!AudioContextClass) {
      logger.warn('[RandomChatSession] Web Audio API not available, using LiveKit getTrackStats fallback');
      // В React Native Web Audio API обычно недоступен
      // Используем getTrackStats из LiveKit Room для получения реального уровня аудио
      this.micLevelInterval = setInterval(async () => {
        // КРИТИЧНО: Проверяем что микрофон включен и соединение установлено
        if (!this.isMicOn || !this.room || this.room.state !== 'connected') {
          this.config.callbacks.onMicLevelChange?.(0);
          this.config.onMicLevelChange?.(0);
          return;
        }
        
        let audioLevel = 0;
        
        // Пытаемся получить статистику из LiveKit Room
        try {
          const stats = await this.room.localParticipant.getTrackStats();
          
          // Ищем статистику для аудио трека
          for (const stat of stats) {
            if (stat.kind === 'audio' && this.localAudioTrack) {
              // Берем показания энергии/длительности, чтобы оценить громкость (на RN часто нет audioLevel)
              const energy = (stat as any).audioEnergy ?? (stat as any).totalAudioEnergy ?? 0;
              const duration = (stat as any).audioDuration ?? (stat as any).totalSamplesDuration ?? 0;
              if (energy > 0 && duration > 0) {
                const dEnergy = energy - this.lastAudioEnergy;
                const dDuration = duration - this.lastAudioDuration;
                this.lastAudioEnergy = energy;
                this.lastAudioDuration = duration;
                if (dEnergy > 0 && dDuration > 0) {
                  const power = dEnergy / dDuration;
                  // Эмпирическое усиление + sqrt для плавности
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
        } catch (e) {
          // Игнорируем ошибки получения статистики
          logger.debug('[RandomChatSession] Could not get track stats', e);
        }

        // Fallback: если LiveKit stats не дали уровень, пробуем getStats у mediaStreamTrack (react-native-webrtc)
        if (audioLevel === 0 && this.localAudioTrack?.mediaStreamTrack) {
          try {
            const statsReport = await (this.localAudioTrack.mediaStreamTrack as any)?.getStats?.();
            if (statsReport) {
              const values = Array.from(statsReport.values ? statsReport.values() : statsReport);
              for (const v of values) {
                const energy = (v as any).audioLevel ?? (v as any).totalAudioEnergy ?? 0;
                const duration = (v as any).totalSamplesDuration ?? (v as any).audioDuration ?? 0;
                if (energy > 0 && duration > 0) {
                  const power = energy / duration;
                  audioLevel = Math.min(1, Math.sqrt(power * 5));
                  break;
                }
              }
            }
          } catch (e) {
            logger.debug('[RandomChatSession] Could not get mediaStreamTrack stats', e);
          }
        }
        
        // КРИТИЧНО: НЕ используем визуальный эффект - возвращаем только реальные данные
        // Если нет реальных данных - уровень остается 0 (эквалайзер не двигается)
        this.config.callbacks.onMicLevelChange?.(audioLevel);
        this.config.onMicLevelChange?.(audioLevel);
      }, 100); // Обновляем каждые 100ms
      return;
    }
    
    try {
      // Создаем AudioContext
      this.audioContext = new AudioContextClass();
      
      // Создаем AnalyserNode для анализа аудио
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256; // Размер FFT для частотного анализа
      this.analyser.smoothingTimeConstant = 0.8; // Сглаживание
      
      // Подключаем аудио поток к анализатору
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        this.micLevelSource = this.audioContext.createMediaStreamSource(stream);
        this.micLevelSource.connect(this.analyser);
        
        // Запускаем периодический опрос уровня
        this.micLevelInterval = setInterval(() => {
          // КРИТИЧНО: Проверяем что микрофон включен и соединение установлено
          if (!this.analyser || !this.isMicOn || !this.room || this.room.state !== 'connected') {
            this.config.callbacks.onMicLevelChange?.(0);
            this.config.onMicLevelChange?.(0);
            return;
          }
          
          // Получаем данные частотного анализа
          const bufferLength = this.analyser.frequencyBinCount;
          const dataArray = new Uint8Array(bufferLength);
          this.analyser.getByteFrequencyData(dataArray);
          
          // Вычисляем средний уровень по всем частотам
          // Используем взвешенное среднее для лучшей чувствительности
          let sum = 0;
          let weightedSum = 0;
          let weightSum = 0;
          
          for (let i = 0; i < bufferLength; i++) {
            const value = dataArray[i];
            sum += value;
            // Взвешиваем более высокие частоты (индекс выше = частота выше)
            const weight = 1 + (i / bufferLength) * 0.5; // Вес от 1.0 до 1.5
            weightedSum += value * weight;
            weightSum += weight;
          }
          
          // Используем взвешенное среднее для более точного отображения
          const average = weightedSum / weightSum;
          
          // Нормализуем значение (0-255 -> 0-1) с усилением
          // Используем квадратный корень для более плавной кривой
          const normalizedLevel = Math.min(1, Math.sqrt(average / 255) * 1.2);
          
          // Обновляем уровень микрофона
          this.config.callbacks.onMicLevelChange?.(normalizedLevel);
          this.config.onMicLevelChange?.(normalizedLevel);
        }, 50); // Обновляем каждые 50ms для плавной анимации
        
        logger.info('[RandomChatSession] Mic level monitoring started');
      } else {
        logger.warn('[RandomChatSession] No audio tracks in stream for mic level monitoring');
        this.cleanupAudioContext();
      }
    } catch (e) {
      logger.error('[RandomChatSession] Failed to start mic level monitoring', e);
      this.cleanupAudioContext();
    }
  }
  
  private stopMicLevelMonitoring(): void {
    if (this.micLevelInterval) {
      clearInterval(this.micLevelInterval);
      this.micLevelInterval = null;
    }
    
    this.cleanupAudioContext();
    
    // Сбрасываем уровень на 0
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
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
    // Если камера выключена, сразу ставим enabled = false, чтобы не светить видео
    if (!this.isCamOn && newVideoTrack.mediaStreamTrack) {
      newVideoTrack.mediaStreamTrack.enabled = false;
      try {
        newVideoTrack.mute();
      } catch {}
    }
    this.localVideoTrack = newVideoTrack;
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
                await this.room.localParticipant.unpublishTrack(track, { stopTrack: false });
              } else if (pub.trackSid) {
                await this.room.localParticipant.unpublishTrack(pub.trackSid, { stopTrack: false } as any);
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
                await this.room.localParticipant.unpublishTrack(track, { stopTrack: false });
              } else if (pub.trackSid) {
                await this.room.localParticipant.unpublishTrack(pub.trackSid, { stopTrack: false } as any);
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

      if (this.isCamOn || force) {
        await this.room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
          if (!e?.message?.includes('already') && !e?.message?.includes('duplicate')) {
            throw e;
          }
        });
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

  private async unpublishVideoTrackKeepAlive(): Promise<void> {
    if (!this.room) return;
    try {
      const publications = this.room.localParticipant.videoTrackPublications;
      if (publications && typeof publications.values === 'function') {
        for (const pub of publications.values()) {
          if (pub.track) {
            await this.room.localParticipant.unpublishTrack(pub.track, { stopTrack: false });
          } else if (pub.trackSid) {
            await this.room.localParticipant.unpublishTrack(pub.trackSid, { stopTrack: false } as any);
          }
        }
      } else if (Array.isArray(publications)) {
        for (const pub of publications) {
          if (pub.track) {
            await this.room.localParticipant.unpublishTrack(pub.track, { stopTrack: false });
          } else if (pub.trackSid) {
            await this.room.localParticipant.unpublishTrack(pub.trackSid, { stopTrack: false } as any);
          }
        }
      }
      logger.info('[RandomChatSession] Video track unpublished (cam off, keep alive)');
    } catch (e) {
      logger.warn('[RandomChatSession] Failed to unpublish video track', e);
    }
  }

  private async connectToLiveKit(url: string, token: string, connectRequestId: number): Promise<boolean> {
    // КРИТИЧНО: Отключаем предыдущую комнату перед подключением к новой
    await this.disconnectRoom('user');
    
    // КРИТИЧНО: Небольшая задержка после отключения, чтобы избежать конфликтов (минимум для скорости)
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // КРИТИЧНО: Убеждаемся что локальные треки существуют и активны
    // Если треки были остановлены (чего не должно быть при next()), пересоздаем их
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
        await this.ensureLocalTracks();
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
      await room.connect(url, token, { autoSubscribe: true });
    } catch (e) {
      if (this.room === room) {
        this.room = null;
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

    // КРИТИЧНО: Публикуем локальные треки после подключения к комнате
    // Убеждаемся что треки активны перед публикацией
    // КРИТИЧНО: Небольшая задержка перед публикацией (сокращена для ускорения коннекта)
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // КРИТИЧНО: Публикуем треки напрямую - LiveKit сам обработает дубликаты
    // Не проверяем наличие публикаций, так как это может вызвать ошибки с Map API
    if (this.localVideoTrack && this.localVideoTrack.mediaStreamTrack?.readyState !== 'ended') {
      try {
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
        if (this.isCamOn) {
          await room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
            // Игнорируем ошибки дубликатов - LiveKit может вернуть ошибку если трек уже опубликован
            if (!e?.message?.includes('already') && !e?.message?.includes('duplicate')) {
              throw e;
            }
          });
          logger.info('[RandomChatSession] Video track published', {
            trackId: this.localVideoTrack.sid || this.localVideoTrack.mediaStreamTrack?.id,
            isMuted: this.localVideoTrack.isMuted,
          });
        } else {
          // Камера выключена — не публикуем трек, чтобы у новой пары не было ложного видео
          if (this.localVideoTrack.mediaStreamTrack) {
            this.localVideoTrack.mediaStreamTrack.enabled = false;
          }
          try {
            this.localVideoTrack.mute();
          } catch {}
          await this.unpublishVideoTrackKeepAlive();
        }
      } catch (e) {
        logger.warn('[RandomChatSession] Failed to publish video track', e);
        // Не блокируем успех подключения - трек может быть опубликован позже
      }
    }
    
    if (this.localAudioTrack && this.localAudioTrack.mediaStreamTrack?.readyState !== 'ended') {
      try {
        // КРИТИЧНО: Убеждаемся что трек включен перед публикацией
        if (this.isMicOn && this.localAudioTrack.isMuted) {
          this.localAudioTrack.unmute();
        } else if (!this.isMicOn && !this.localAudioTrack.isMuted) {
          this.localAudioTrack.mute();
        }
        await room.localParticipant.publishTrack(this.localAudioTrack).catch((e) => {
          // Игнорируем ошибки дубликатов - LiveKit может вернуть ошибку если трек уже опубликован
          if (!e?.message?.includes('already') && !e?.message?.includes('duplicate')) {
            throw e;
          }
        });
        logger.info('[RandomChatSession] Audio track published', {
          trackId: this.localAudioTrack.sid || this.localAudioTrack.mediaStreamTrack?.id,
          isMuted: this.localAudioTrack.isMuted,
        });
      } catch (e) {
        logger.warn('[RandomChatSession] Failed to publish audio track', e);
        // Не блокируем успех подключения - трек может быть опубликован позже
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
    if (this.isDisconnecting) {
      logger.debug('[RandomChatSession] disconnectRoom already in progress, skipping');
      return;
    }
    
    const room = this.room;
    if (!room) {
      logger.debug('[RandomChatSession] disconnectRoom: no room to disconnect');
      return;
    }
    
    // Проверяем, не отключена ли комната уже
    if (room.state === 'disconnected') {
      logger.debug('[RandomChatSession] disconnectRoom: room already disconnected');
      this.room = null;
      return;
    }
    
    this.isDisconnecting = true;
    this.disconnectReason = reason;
    
    // КРИТИЧНО: НЕ отписываем треки перед disconnect - LiveKit сам корректно обработает отключение
    // Отписка треков может привести к их остановке или зависанию
    // LiveKit сам управляет треками при disconnect()
    
    // Увеличиваем connectRequestId, чтобы остановить отложенные подключения
    this.connectRequestId++;
    this.room = null;
    
    // КРИТИЧНО: НЕ вызываем room.removeAllListeners() перед disconnect()
    // Это удаляет внутренние обработчики LiveKit (ping/pong, корректное завершение),
    // что приводит к "ping timeout" и "connection state mismatch" ошибкам.
    // room.disconnect() сам корректно завершит соединение и очистит ресурсы.
    // КРИТИЧНО: Локальные треки НЕ останавливаем - они должны продолжать работать для следующего соединения
    
    try {
      await room.disconnect();
    } catch (e) {
      logger.warn('[RandomChatSession] Error disconnecting room', e);
    }
    this.disconnectReason = 'unknown';
    this.isDisconnecting = false;
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
          // КРИТИЧНО: Проверяем, не отключаемся ли мы уже
          if (!this.isDisconnecting && !this.disconnectHandled) {
            this.handleRandomDisconnected('server');
          }
        }
      })
      .once(RoomEvent.Disconnected, () => {
        // КРИТИЧНО: Убираем циклический вызов handleRandomDisconnected
        // Если комната отключилась по причине 'server', это уже обработано в ParticipantDisconnected
        // или в других обработчиках. Здесь только сбрасываем флаги.
        logger.debug('[RandomChatSession] Room disconnected', { 
          reason: this.disconnectReason, 
          started: this.started,
          isDisconnecting: this.isDisconnecting 
        });
        this.disconnectReason = 'unknown';
        this.isDisconnecting = false;
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
    
    // КРИТИЧНО: Для видео трека проверяем, изменился ли трек
    const isVideoTrack = publication.kind === Track.Kind.Video;
    const oldVideoTrackSid = this.remoteVideoTrack?.sid;
    const wasVideoTrackChanged = isVideoTrack && oldVideoTrackSid && oldVideoTrackSid !== track.sid;
    
    // КРИТИЧНО: Для видео трека создаем новый MediaStream если трек изменился
    // Это гарантирует, что RTCView обновится при изменении трека
    const shouldCreateNewStream = isVideoTrack && wasVideoTrackChanged;
    
    if (shouldCreateNewStream) {
      // Создаем новый MediaStream для нового видео трека
      const oldStream = this.remoteStream;
      this.remoteStream = new MediaStream();
      logger.debug('[RandomChatSession] Created new remote MediaStream for changed video track', {
        oldStreamId: oldStream?.id,
        newStreamId: this.remoteStream.id,
        oldTrackId: oldVideoTrackSid,
        newTrackId: track.sid,
      });
      
      // Переносим аудио трек в новый stream если он был
      if (oldStream && this.remoteAudioTrack) {
        const audioTracks = oldStream.getAudioTracks();
        audioTracks.forEach((audioTrack) => {
          try {
            this.remoteStream.addTrack(audioTrack as any);
            logger.debug('[RandomChatSession] Transferred audio track to new stream');
          } catch {}
        });
      }
    } else if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
      logger.debug('[RandomChatSession] Created new remote MediaStream');
    }
    
    const mediaTrack = track.mediaStreamTrack;
    const trackAlreadyInStream = mediaTrack && this.remoteStream.getTracks().includes(mediaTrack as any);
    
    if (mediaTrack && !trackAlreadyInStream) {
      // LiveKit's MediaStreamTrack is compatible with @livekit/react-native-webrtc's MediaStreamTrack at runtime
      this.remoteStream.addTrack(mediaTrack as any);
      logger.debug('[RandomChatSession] Added track to remote stream', {
        kind: publication.kind,
        streamId: this.remoteStream.id,
        tracksCount: this.remoteStream.getTracks().length,
        hasToURL: typeof this.remoteStream.toURL === 'function',
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
      const mediaTrack = this.remoteVideoTrack.mediaStreamTrack;
      if (mediaTrack && this.remoteStream) {
        this.remoteStream.removeTrack(mediaTrack as any);
      }
      this.remoteVideoTrack = null;
      this.remoteCamEnabled = false;
      // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
      this.remoteViewKey = Date.now();
      this.emit('remoteViewKeyChanged', this.remoteViewKey);
      this.config.callbacks.onRemoteCamStateChange?.(false);
      this.config.onRemoteCamStateChange?.(false);
    }

    const tracksCount = this.remoteStream?.getTracks().length ?? 0;
    if (this.remoteStream && tracksCount === 0) {
      this.remoteStream = null;
      this.emit('remoteStream', null);
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
    } else if (this.remoteStream) {
      // КРИТИЧНО: Эмитим обновленный remoteStream если остались другие треки
      this.emit('remoteStream', this.remoteStream);
      this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
      this.config.onRemoteStreamChange?.(this.remoteStream);
    }

    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }
}
