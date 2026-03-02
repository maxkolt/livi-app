import { MediaStream } from '@livekit/react-native-webrtc';
import { Buffer } from 'buffer';
import AudioRecord from 'react-native-audio-record';
import { InteractionManager, Platform, NativeModules } from 'react-native';
import * as Device from 'expo-device';
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
  VideoPresets,
} from 'livekit-client';
import { SimpleEventEmitter } from '../base/SimpleEventEmitter';
import type { WebRTCSessionConfig, CamSide } from '../types';
import socket, { setActiveVideoCall } from '../../../sockets/socket';
import { logger } from '../../../utils/logger';
import { getIceConfiguration } from '../../../utils/iceConfig';
import { getPreferredVideoCaptureOptions } from '../videoCaptureProfile';

const LIVEKIT_URL = ((process.env.EXPO_PUBLIC_LIVEKIT_URL as string | undefined) ?? '').trim();

// During camera flip / track replacement LiveKit can briefly unpublish/unsubscribe video.
// We should not treat that as "partner turned camera off" (otherwise UI flashes "Отошел").
// Slightly longer to cover renegotiation bursts during camera flip/restart on Android.
const REMOTE_CAM_OFF_GRACE_MS = 1400;

function parsePublicFlag(value: string | undefined, fallback: boolean): boolean {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Safe defaults for 1:1 mobile calls:
// - dynacast ON gives bandwidth/CPU savings with low behavior risk.
// - adaptiveStream OFF by default; can be enabled via env after soak testing.
const LIVEKIT_ADAPTIVE_STREAM_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_ADAPTIVE_STREAM, false);
const LIVEKIT_DYNACAST_ENABLED = parsePublicFlag(process.env.EXPO_PUBLIC_LIVEKIT_DYNACAST, true);

type CallAcceptedPayload = {
  callId?: string;
  from?: string;
  fromUserId?: string;
  roomId?: string;
  livekitToken?: string | null;
  livekitRoomName?: string | null;
  livekitUrl?: string | null;
};

type CallIncomingPayload = {
  callId: string;
  from: string;
  fromNick?: string;
};

export class VideoCallSession extends SimpleEventEmitter {
  private hasLoggedLiveKitApiKeyWarning = false;
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
  private camSide: CamSide = 'front';
  private isMicOn = true;
  private isCamOn = true;
  private remoteAudioMuted = false;
  private remoteCamEnabled = false;
  private remoteCamOffTimeout: ReturnType<typeof setTimeout> | null = null;
  /** SID последнего отписанного удалённого видео-трека (переворот камеры). Нужен, т.к. TrackSubscribed приходит после TrackUnsubscribed и remoteVideoTrack уже null. */
  private lastUnsubscribedRemoteVideoTrackSid: string | null = null;
  private socketOffs: Array<() => void> = [];
  private socketHandlers: {
    callAccepted?: (data: CallAcceptedPayload) => void;
    callIncoming?: (data: CallIncomingPayload) => void;
    callEnded?: () => void;
    callError?: (data: { callId?: string; reason?: string }) => void;
    callDeclined?: (data: { callId?: string; from?: string }) => void;
    disconnected?: () => void;
    pipState?: (data: { inPiP: boolean; roomId: string; from: string }) => void;
    camToggle?: (data: { enabled: boolean; from: string; roomId?: string }) => void;
  } = {};
  private connectRequestId = 0;
  private disconnectReason: 'user' | 'server' | 'unknown' = 'unknown';
  private isDisconnecting = false;
  private disconnectPromise: Promise<void> | null = null;
  private connectingPromise: Promise<boolean> | null = null; // Защита от множественных одновременных подключений
  private callId: string | null = null;
  private roomId: string | null = null;
  private partnerId: string | null = null;
  private partnerUserId: string | null = null;
  private inPiP = false;
  private partnerInPiP = false; // Состояние партнера в PiP
  private currentRoomName: string | null = null; // Имя текущей подключенной комнаты LiveKit
  private lastProcessedCallAccepted: { callId: string | null; roomName: string | null; timestamp: number } | null = null; // Защита от повторной обработки
  private endCallInProgress = false;
  private ended = false;
  /** Идемпотентность cleanup(): повторный вызов не выполняет отписки и endCall повторно */
  private cleaned = false;

  // LiveKit reconnect handling: during reconnect we must NOT treat transient disconnects as "call ended".
  private liveKitReconnecting = false;
  private lastLiveKitReconnectingAt = 0;
  private pendingRemoteDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraSwitchInProgress = false;

  /* ========= Mic level monitoring (VoiceEqualizer) ========= */
  private micBarsCount = 21;
  private isMicMonitoringActive = false;
  private micLevelInterval: ReturnType<typeof setInterval> | null = null;
  private audioRecordSubscription: { remove: () => void } | null = null;
  private audioRecordBuffer: number[] = [];
  private lastFrequencyLevels: number[] = [];
  private lastMicLevel = 0;
  private micMonitorLogCount = 0;
  private lastAudioEnergy = 0;
  private lastAudioDuration = 0;
  private eqBarSeeds: number[] = [];
  private eqPhase = 0;
  private localVideoHealthTimeout: ReturnType<typeof setTimeout> | null = null;
  private localVideoHealthAttempts = 0;

  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    
    logger.info('[VideoCallSession] 🆕 Constructor called', {
      myUserId: config.myUserId,
      hasCallbacks: !!config.callbacks,
    });
    
    // КРИТИЧНО: Принудительно очищаем предыдущую комнату при создании новой сессии.
    // disconnect() только при state === 'connected', иначе LiveKit бросает "cannot send signal request before connected".
    if (this.room) {
      try {
        this.room.removeAllListeners();
        if (this.room.state === 'connected') {
          this.room.disconnect();
        }
      } catch {}
      this.room = null;
    }
    this.isDisconnecting = false;
    this.disconnectPromise = null;
    this.connectingPromise = null;
    this.currentRoomName = null;
    
    this.setupSocketHandlers();
    
    // КРИТИЧНО: Проверяем, есть ли сохраненное событие call:accepted, которое пришло до создания сессии
    // Это решает проблему, когда call:accepted приходит до того, как VideoCallSession создан
    const pendingCallAccepted = (global as any).__pendingCallAcceptedRef?.current;
    if (pendingCallAccepted) {
      logger.info('[VideoCallSession] 🔄 Found pending call:accepted event, will process after first frame', {
        callId: pendingCallAccepted.callId,
        roomId: pendingCallAccepted.roomId,
        myUserId: config.myUserId,
      });
      // Очищаем сохраненное событие
      (global as any).__pendingCallAcceptedRef.current = null;
      // Откладываем подключение до после первого кадра — снижает ANR при переходе на VideoCall
      InteractionManager.runAfterInteractions(() => {
        this.handleCallAccepted(pendingCallAccepted).catch((e) => {
          logger.error('[VideoCallSession] ❌ Failed to handle pending call:accepted', {
            error: e,
            callId: pendingCallAccepted.callId,
          });
        });
      });
    }
  }

  /* ===================== Public API ===================== */

  async callFriend(friendUserId: string): Promise<void> {
    // КРИТИЧНО: Очищаем старую комнату перед новым звонком
    if (this.room) {
      logger.info('[VideoCallSession] Cleaning up old room before callFriend', { roomState: this.room.state });
      try {
        this.room.removeAllListeners();
        if (this.room.state === 'connected') {
          this.room.disconnect();
        }
      } catch {}
      this.room = null;
      this.isDisconnecting = false;
      this.disconnectPromise = null;
      this.connectingPromise = null;
      this.currentRoomName = null;
    }
    
    this.partnerUserId = friendUserId;
    // КРИТИЧНО: partnerId еще нет (будет установлен при получении call:accepted)
    // Но partnerUserId уже есть, и компонент должен его получить через setPartnerUserId в VideoCall.tsx
    // Здесь мы только устанавливаем внутреннее состояние, компонент сам устанавливает partnerUserId
    this.config.callbacks.onLoadingChange?.(true);
    this.config.onLoadingChange?.(true);
    await this.ensureLocalTracks();
    
    try {
      socket.emit('call:initiate', { to: friendUserId });
    } catch (e) {
      logger.error('[VideoCallSession] Error initiating call', e);
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
    }
  }

  async acceptCall(callId: string, fromUserId: string): Promise<void> {
    // КРИТИЧНО: Очищаем старую комнату перед принятием звонка. disconnect() только если комната уже connected,
    // иначе LiveKit бросает "cannot send signal request before connected, type: leave" и первая попытка подключения падает.
    if (this.room) {
      logger.info('[VideoCallSession] Cleaning up old room before acceptCall', { roomState: this.room.state });
      try {
        this.room.removeAllListeners();
        if (this.room.state === 'connected') {
          this.room.disconnect();
        }
      } catch {}
      this.room = null;
      this.isDisconnecting = false;
      this.disconnectPromise = null;
      this.connectingPromise = null;
      this.currentRoomName = null;
    }
    
    this.callId = callId;
    this.partnerUserId = fromUserId;
    this.config.callbacks.onLoadingChange?.(true);
    this.config.onLoadingChange?.(true);
    await this.ensureLocalTracks();
    
    try {
      socket.emit('call:accept', { callId });
    } catch (e) {
      logger.error('[VideoCallSession] Error accepting call', e);
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
    }
  }

  /**
   * Подключение инициатора к комнате после того как звонок уже был принят.
   * Используется когда инициатор переходит на VideoCall экран после того как call:accepted уже пришёл.
   */
  async connectAsInitiatorAfterAccepted(callId: string, peerUserId: string): Promise<void> {
    // КРИТИЧНО: Очищаем старую комнату
    if (this.room) {
      logger.info('[VideoCallSession] Cleaning up old room before connectAsInitiatorAfterAccepted', { roomState: this.room.state });
      try {
        this.room.removeAllListeners();
        if (this.room.state === 'connected') {
          this.room.disconnect();
        }
      } catch {}
      this.room = null;
      this.isDisconnecting = false;
      this.disconnectPromise = null;
      this.connectingPromise = null;
      this.currentRoomName = null;
    }
    
    this.callId = callId;
    this.partnerUserId = peerUserId;
    this.config.callbacks.onLoadingChange?.(true);
    this.config.onLoadingChange?.(true);
    await this.ensureLocalTracks();
    
    // Генерируем roomId по тому же алгоритму что и backend
    const sortedUserIds = [this.config.myUserId, peerUserId].sort();
    const roomId = `room_${sortedUserIds[0]}_${sortedUserIds[1]}`;
    
    logger.info('[VideoCallSession] connectAsInitiatorAfterAccepted: generating roomId', {
      myUserId: this.config.myUserId,
      peerUserId,
      roomId
    });
    
    this.roomId = roomId;
    this.config.callbacks.onRoomIdChange?.(roomId);
    this.config.onRoomIdChange?.(roomId);
    
    const envLivekitUrl = process.env.EXPO_PUBLIC_LIVEKIT_URL;
    
    logger.debug('[VideoCallSession] Requesting LiveKit token', { roomId, livekitUrl: envLivekitUrl || LIVEKIT_URL });
    
    try {
      // Запрашиваем токен через сокет (более надёжно чем HTTP)
      const tokenData = await new Promise<{ ok: boolean; token?: string; url?: string; error?: string }>((resolve) => {
        const timeout = setTimeout(() => {
          logger.warn('[VideoCallSession] Token request timeout', { roomId });
          resolve({ ok: false, error: 'timeout' });
        }, 10000);
        
        socket.emit('livekit:token', { roomName: roomId }, (response: { ok: boolean; token?: string; url?: string; error?: string }) => {
          clearTimeout(timeout);
          logger.debug('[VideoCallSession] Token response received', { 
            ok: response.ok, 
            hasToken: !!response.token, 
            error: response.error,
            roomId,
          });
          resolve(response);
        });
      });
      
      if (tokenData.ok && tokenData.token) {
        const resolvedLivekitUrl = ((tokenData.url as string | undefined) || envLivekitUrl || LIVEKIT_URL || '').trim();
        if (!resolvedLivekitUrl) {
          logger.error('[VideoCallSession] LiveKit URL is not configured (token received but no URL)', {
            envVar: 'EXPO_PUBLIC_LIVEKIT_URL',
            value: envLivekitUrl,
            tokenHasUrl: !!tokenData.url,
            roomId,
          });
          this.config.callbacks.onLoadingChange?.(false);
          this.config.onLoadingChange?.(false);
          return;
        }
        logger.debug('[VideoCallSession] Connecting to LiveKit', { 
          roomId, 
          url: resolvedLivekitUrl,
          tokenLength: tokenData.token.length,
        });
        const connectRequestId = ++this.connectRequestId;
        const connected = await this.connectToLiveKit(resolvedLivekitUrl, tokenData.token, connectRequestId, roomId);
        if (!connected) {
          logger.debug('[VideoCallSession] connectAsInitiatorAfterAccepted aborted (stale request)');
          return;
        }
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
        this.config.setIsInactiveState?.(false);
        this.config.setFriendCallAccepted?.(true);
        this.emit('callAnswered');
      } else {
        logger.error('[VideoCallSession] Failed to get LiveKit token via socket', {
          tokenData,
          roomId,
          livekitUrl: envLivekitUrl || LIVEKIT_URL,
        });
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
      }
    } catch (e) {
      logger.error('[VideoCallSession] Error in connectAsInitiatorAfterAccepted', {
        error: e,
        roomId,
        livekitUrl: envLivekitUrl || LIVEKIT_URL,
      });
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
    }
  }

  endCall(overrideCallId?: string | null, overrideRoomId?: string | null): void {
    // Idempotency: endCall can be invoked from multiple places (UI + cleanup + socket events).
    // Make it safe to call multiple times without triggering warnings or duplicate actions.
    if (this.ended || this.endCallInProgress) {
      return;
    }
    this.endCallInProgress = true;
    // КРИТИЧНО: Сразу помечаем звонок завершённым, чтобы асинхронный код (handleCallAccepted, connectToLiveKit)
    // видел ended и не выполнял пост-подключение / setLocalDescription после disconnect
    this.ended = true;
    // КРИТИЧНО: При завершении звонка выключаем системный PiP hint максимально рано,
    // чтобы на некоторых устройствах не происходил автовход в PiP (onUserLeaveHint) во время очистки.
    if (Platform.OS === 'android') {
      try { (NativeModules as any)?.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch {}
    }

    // Сбрасываем блокировку комнаты сразу, чтобы следующий звонок не видел старую сессию
    const roomLock = (global as any).__connectingToRoomRef as { roomName: string | null; session: VideoCallSession | null } | undefined;
    if (roomLock?.session === this) {
      roomLock.roomName = null;
      roomLock.session = null;
      logger.info('[VideoCallSession] 🔓 Сброшена блокировка __connectingToRoomRef в endCall');
    }

    // КРИТИЧНО: Используем переданные из UI callId/roomId как fallback (инициатор может не иметь их в сессии до завершения connectAsInitiatorAfterAccepted)
    const callIdToSend = overrideCallId ?? this.callId;
    const roomIdToSend = overrideRoomId ?? this.roomId;

    logger.info('[VideoCallSession] 🛑 endCall вызван', {
      callId: this.callId,
      roomId: this.roomId,
      overrideCallId,
      overrideRoomId,
      callIdToSend,
      roomIdToSend,
      partnerId: this.partnerId,
      partnerUserId: this.partnerUserId,
    });
    
    // Останавливаем локальные треки и сбрасываем состояние
    void this.disconnectRoom('user');
    this.resetRemoteState();
    this.stopLocalTracks();
    
    // КРИТИЧНО: Отправляем call:end на сервер ПЕРЕД очисткой callId и roomId
    // Сервер отправит call:ended всем участникам комнаты, что завершит звонок у обоих
    if (callIdToSend || roomIdToSend) {
      try {
        const payload = { 
          callId: callIdToSend || roomIdToSend, 
          roomId: roomIdToSend || callIdToSend 
        };
        socket.emit('call:end', payload);
        logger.info('[VideoCallSession] ✅ Отправлено call:end на сервер', {
          payload,
          willNotifyBothParticipants: true,
        });
      } catch (e) {
        logger.warn('[VideoCallSession] Ошибка отправки call:end', e);
      }
    }
    
    // Очищаем состояние после отправки на сервер
    this.callId = null;
    this.roomId = null;
    this.partnerId = null;
    this.partnerUserId = null;
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    this.config.setFriendCallAccepted?.(false);
    this.config.setIsInactiveState?.(true);
    this.config.setWasFriendCallEnded?.(true);
    this.emit('callEnded');
    logger.info('[VideoCallSession] ✅ Состояние сессии сброшено и callEnded событие отправлено');
    this.endCallInProgress = false;
  }

  toggleMic(): void {
    this.isMicOn = !this.isMicOn;
    if (this.room) {
      this.room.localParticipant.setMicrophoneEnabled(this.isMicOn).catch((e) => {
        logger.warn('[VideoCallSession] Failed to toggle microphone', e);
      });
    } else if (this.localAudioTrack) {
      try {
        this.isMicOn ? this.localAudioTrack.unmute() : this.localAudioTrack.mute();
      } catch {}
    }
    // КРИТИЧНО: Не трогаем mediaStreamTrack.enabled когда есть LiveKit room —
    // на iOS это может приводить к предупреждениям event-target-shim про повторные listeners.
    // Вне комнаты синхронизируем enabled как fallback.
    if (!this.room) {
      try {
        const mediaTrack = this.localAudioTrack?.mediaStreamTrack;
        if (mediaTrack) {
          mediaTrack.enabled = this.isMicOn;
        }
      } catch {}
    }
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
  }

  async toggleCam(): Promise<void> {
    this.isCamOn = !this.isCamOn;

    logger.info('[VideoCallSession] toggleCam called', {
      newCamState: this.isCamOn,
      hasLocalVideoTrack: !!this.localVideoTrack,
      trackReadyState: this.localVideoTrack?.mediaStreamTrack?.readyState,
      hasRoom: !!this.room,
      roomState: this.room?.state,
    });

    // Сразу сообщаем партнёру о новом состоянии камеры, чтобы заглушка «Отошел» показывалась без задержки
    // (не ждём завершения mute/unmute и обновления стрима)
    const currentRoomId = this.getRoomId();
    if (!this.ended && !this.endCallInProgress && currentRoomId) {
      try {
        socket.emit('cam-toggle', {
          enabled: !!this.isCamOn,
          from: socket.id,
          roomId: currentRoomId,
        });
        logger.info('[VideoCallSession] ✅ Отправлено cam-toggle партнеру (сразу при нажатии)', { roomId: currentRoomId, enabled: this.isCamOn });
      } catch (e) {
        logger.warn('[VideoCallSession] Ошибка отправки cam-toggle:', e);
      }
    }

    if (this.isCamOn) {
      // ВКЛЮЧАЕМ камеру
      // Проверяем нужно ли восстановить трек
      const needsRecovery =
        !this.localVideoTrack ||
        !this.localVideoTrack.mediaStreamTrack ||
        this.localVideoTrack.mediaStreamTrack.readyState === 'ended';

      if (needsRecovery) {
        logger.info('[VideoCallSession] Recovering video track for camera enable');
        // Пересоздаём ТОЛЬКО видео трек (аудио не трогаем для стабильности)
        await this.recreateLocalVideoTrack('toggleCam:recovery');
      }

      // После восстановления трека - включаем и публикуем
      if (this.localVideoTrack) {
        try {
          // Включаем mediaTrack
          if (this.localVideoTrack.mediaStreamTrack) {
            this.localVideoTrack.mediaStreamTrack.enabled = true;
          }
          
          // Unmute трек
          await this.localVideoTrack.unmute().catch((e) => {
            logger.debug('[VideoCallSession] unmute error (may be ok)', e);
          });

          // Публикуем трек в комнату если она подключена
          if (this.room && this.room.state === 'connected' && this.room.localParticipant) {
            // Проверяем, не опубликован ли трек уже
            if (!this.isVideoTrackPublished(this.localVideoTrack)) {
              // Safety: if we recreated the track, LiveKit may still have an older camera publication.
              // Unpublish other camera tracks first to avoid "publishing a second track with the same source: camera".
              await this.unpublishOtherLocalTracks('video', this.localVideoTrack);
              await this.room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
                const errorMsg = e?.message || String(e || '');
                if (!errorMsg.includes('already') && !errorMsg.includes('duplicate')) {
                  logger.warn('[VideoCallSession] Failed to publish video track on camera enable', e);
                }
              });
              logger.info('[VideoCallSession] Video track published after camera enable');
            }

            // КРИТИЧНО: после восстановления/перепубликации камеры некоторые девайсы "теряют" микрофон публикацию
            // (гонка внутри LiveKit/engine). Поэтому (best-effort) убеждаемся, что аудио трек тоже опубликован.
            if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
              await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
              await this.room.localParticipant.publishTrack(this.localAudioTrack).catch((e) => {
                const errorMsg = e?.message || String(e || '');
                if (!errorMsg.includes('already') && !errorMsg.includes('duplicate')) {
                  logger.warn('[VideoCallSession] Failed to publish audio track after camera recovery', e);
                }
              });
              logger.info('[VideoCallSession] Audio track published after camera recovery', {
                trackId: this.localAudioTrack?.sid || this.localAudioTrack?.mediaStreamTrack?.id,
              });
            }
          }
          
          logger.info('[VideoCallSession] Camera enabled successfully');
        } catch (e) {
          logger.warn('[VideoCallSession] Failed to enable camera', e);
          // Fallback: используем setCameraEnabled
          if (this.room && this.room.localParticipant) {
            try {
              await this.room.localParticipant.setCameraEnabled(true);
            } catch (e2) {
              logger.warn('[VideoCallSession] Fallback setCameraEnabled failed', e2);
            }
          }
        }
      }
    } else {
      // ВЫКЛЮЧАЕМ камеру
      if (this.localVideoTrack) {
        try {
          // Mute и отключаем mediaTrack
          await this.localVideoTrack.mute().catch(() => {});
          if (this.localVideoTrack.mediaStreamTrack) {
            this.localVideoTrack.mediaStreamTrack.enabled = false;
          }
          logger.info('[VideoCallSession] Camera disabled successfully');
        } catch (e) {
          logger.warn('[VideoCallSession] Failed to disable camera', e);
        }
      }
    }
    
    // Обновляем localStream
    const mediaStreamTrack = this.localVideoTrack?.mediaStreamTrack;
    if (this.localStream && mediaStreamTrack) {
      const videoTracks = this.localStream.getVideoTracks();
      const hasVideoTrack = videoTracks.some(t => t.id === mediaStreamTrack.id);
      if (this.isCamOn && !hasVideoTrack) {
        this.localStream.addTrack(mediaStreamTrack as any);
      }
    }
    
    // Эмитим обновления
    if (this.localStream) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
    }
    
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    // cam-toggle уже отправлен в начале toggleCam() для мгновенного отображения «Отошел» у партнёра
  }

  /**
   * Вызвать при onResume (возврат из фона) во время активного видеозвонка:
   * если система закрыла камеру (track ended), перезапрашиваем и подключаем её заново.
   */
  async reconnectCameraOnResume(): Promise<void> {
    if (this.ended || !this.room || this.room.state !== 'connected' || !this.isCamOn) return;
    const track = this.localVideoTrack;
    if (!track?.mediaStreamTrack || track.mediaStreamTrack.readyState !== 'ended') return;
    try {
      logger.info('[VideoCallSession] Reconnecting camera on app resume (track was ended)');
      await this.recreateLocalVideoTrack('reconnectCameraOnResume');
      if (this.localVideoTrack && this.room?.state === 'connected' && this.room.localParticipant) {
        if (!this.isVideoTrackPublished(this.localVideoTrack)) {
          await this.unpublishOtherLocalTracks('video', this.localVideoTrack);
          await this.room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
            const msg = e?.message || String(e || '');
            if (!msg.includes('already') && !msg.includes('duplicate')) logger.warn('[VideoCallSession] Publish video on resume failed', e);
          });
        }
        if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
          await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
          await this.room.localParticipant.publishTrack(this.localAudioTrack).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn('[VideoCallSession] reconnectCameraOnResume failed', e);
    }
  }

  /**
   * Unpublish other local tracks of same kind before publishing a new one.
   * Prevents LiveKit warnings about publishing a second track with the same source.
   */
  private async unpublishOtherLocalTracks(kind: 'video' | 'audio', keep: LocalTrack): Promise<void> {
    try {
      if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) return;
      const lp = this.room.localParticipant as any;
      const pubs =
        kind === 'video' ? lp.videoTrackPublications : lp.audioTrackPublications;
      if (!pubs || typeof pubs.values !== 'function') return;

      for (const pub of pubs.values()) {
        const track = pub?.track as LocalTrack | undefined;
        if (!track) continue;
        if (track === keep) continue;
        // Unpublish only same source (camera/microphone) when source info exists; otherwise be conservative.
        const source = pub?.source;
        if (kind === 'video' && source && source !== Track.Source.Camera) continue;
        if (kind === 'audio' && source && source !== Track.Source.Microphone) continue;
        try {
          await (this.room!.localParticipant as any).unpublishTrack(track, true);
        } catch {}
      }
    } catch {}
  }

  toggleRemoteAudio(): void {
    this.remoteAudioMuted = !this.remoteAudioMuted;
    if (this.remoteAudioTrack) {
      try {
        this.remoteAudioTrack.setMuted(this.remoteAudioMuted);
      } catch (e) {
        logger.warn('[VideoCallSession] Failed to toggle remote audio', e);
      }
    }
    this.emit('remoteState', { muted: this.remoteAudioMuted });
  }

  async flipCam(): Promise<void> {
    if (this.cameraSwitchInProgress) {
      logger.debug('[VideoCallSession] flipCam skipped: switch already in progress');
      return;
    }
    if (!this.isCamOn) {
      logger.debug('[VideoCallSession] flipCam skipped: camera is off');
      return;
    }
    this.cameraSwitchInProgress = true;
    const prevSide = this.camSide;
    const nextSide: CamSide = this.camSide === 'front' ? 'back' : 'front';
    this.camSide = nextSide;
    try {
      // В видеозвонках всегда пересоздаём видео-трек с нужной камерой (restartLocalCamera).
      // Так переворот работает стабильно на всех устройствах; applyConstraints на треке
      // от livekit-client часто не переключает камеру на нативной стороне.
      await this.restartLocalCamera();
      logger.info('[VideoCallSession] flipCam done via restartLocalCamera', {
        prevSide,
        nextSide,
        roomState: this.room?.state,
      });
    } catch (e) {
      this.camSide = prevSide;
      logger.warn('[VideoCallSession] flipCam failed, reverted camSide', {
        prevSide,
        nextSide,
        error: (e as any)?.message || String(e || ''),
      });
    } finally {
      this.cameraSwitchInProgress = false;
    }
  }

  async restartLocalCamera(): Promise<void> {
    // Та же логика, что и в Random Chat: replaceTrack в месте публикации уменьшает renegotiation
    // и предотвращает пропадание видео собеседника при перевороте камеры.
    if (this.room && this.room.state === 'connected' && this.room.localParticipant && this.localVideoTrack) {
      const oldVideoTrack = this.localVideoTrack;
      try {
        const newVideoTrack = await this.createFreshLocalVideoTrack('restartLocalCamera');
        this.swapLocalVideoTrack(newVideoTrack);
        await this.replacePublishedVideoTrack(newVideoTrack, oldVideoTrack);
        if (oldVideoTrack && oldVideoTrack !== newVideoTrack) {
          try {
            if (oldVideoTrack.mediaStreamTrack) {
              oldVideoTrack.mediaStreamTrack.enabled = false;
            }
            oldVideoTrack.mute().catch(() => {});
          } catch {}
          try {
            oldVideoTrack.stop();
          } catch {}
        }
        logger.info('[VideoCallSession] Camera restarted via replaceTrack path');
      } catch (e) {
        logger.warn('[VideoCallSession] replaceTrack path failed, falling back to recreateLocalVideoTrack', {
          error: (e as any)?.message || String(e || ''),
        });
        await this.restartLocalCameraRecreatePath();
      }
      return;
    }

    await this.restartLocalCameraRecreatePath();
  }

  /**
   * Original path: unpublish + stop + create + publish. Used when room is not connected or replace path fails.
   */
  private async restartLocalCameraRecreatePath(): Promise<void> {
    try {
      await this.recreateLocalVideoTrack('restartLocalCamera');
    } catch (e) {
      logger.warn('[VideoCallSession] Failed to recreate local video track for restartLocalCamera', {
        error: (e as any)?.message || String(e || ''),
      });
      throw e;
    }
    if (this.room && this.room.state === 'connected' && this.room.localParticipant && this.localVideoTrack) {
      try {
        if (!this.isVideoTrackPublished(this.localVideoTrack)) {
          await this.unpublishOtherLocalTracks('video', this.localVideoTrack);
          await this.room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
            const errorMsg = e?.message || String(e || '');
            if (
              errorMsg.includes('already') ||
              errorMsg.includes('duplicate') ||
              errorMsg.includes('closed') ||
              errorMsg.includes('disconnected')
            ) {
              logger.debug('[VideoCallSession] Ignoring publish error (already/closed)', { error: errorMsg });
              return;
            }
            throw e;
          });
        } else {
          logger.debug('[VideoCallSession] Video track already published, skipping republish', {
            trackId: this.localVideoTrack.sid || this.localVideoTrack.mediaStreamTrack?.id,
          });
        }
        if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
          await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
          await this.room.localParticipant.publishTrack(this.localAudioTrack).catch((e) => {
            const errorMsg = e?.message || String(e || '');
            if (
              errorMsg.includes('already') ||
              errorMsg.includes('duplicate') ||
              errorMsg.includes('closed') ||
              errorMsg.includes('disconnected')
            ) {
              logger.debug('[VideoCallSession] Ignoring audio publish error (already/closed)', { error: errorMsg });
              return;
            }
            throw e;
          });
        }
        logger.info('[VideoCallSession] Camera restarted and republished (recreate path)');
      } catch (e) {
        logger.warn('[VideoCallSession] Failed to republish camera after restart', e);
      }
    } else {
      logger.warn('[VideoCallSession] Room not connected, skipping camera republish', {
        hasRoom: !!this.room,
        roomState: this.room?.state,
        hasLocalParticipant: !!this.room?.localParticipant,
        hasVideoTrack: !!this.localVideoTrack
      });
    }
  }

  setInPiP(inPiP: boolean): void {
    this.inPiP = inPiP;
  }

  async resumeFromPiP(): Promise<void> {
    // Восстанавливаем локальные треки если они были остановлены
    if (!this.localVideoTrack || !this.localAudioTrack) {
      await this.ensureLocalTracks();
    }
    
    // Переподключаемся к комнате если она была отключена
    if (this.room && this.room.state === 'disconnected' && this.roomId) {
      // Комната должна быть восстановлена через call:accepted
      logger.info('[VideoCallSession] Room disconnected, waiting for reconnection');
    }
  }

  async restoreCallState(params: {
    roomId: string | null;
    partnerId: string | null;
    callId: string | null;
    partnerUserId: string | null;
    returnToActiveCall?: boolean;
  }): Promise<void> {
    this.roomId = params.roomId;
    this.partnerId = params.partnerId;
    this.callId = params.callId;
    this.partnerUserId = params.partnerUserId;
    
    if (params.roomId) {
      this.config.callbacks.onRoomIdChange?.(params.roomId);
      this.config.onRoomIdChange?.(params.roomId);
    }
    if (params.partnerId) {
      this.config.callbacks.onPartnerIdChange?.(params.partnerId);
      this.config.onPartnerIdChange?.(params.partnerId);
    }
    if (params.callId) {
      this.config.callbacks.onCallIdChange?.(params.callId);
    }
    
    // Если нужно восстановить активный звонок, запрашиваем токен
    if (params.returnToActiveCall && params.roomId) {
      try {
        const response = await fetch(`${process.env.EXPO_PUBLIC_SERVER_URL}/api/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: this.config.myUserId,
            roomName: params.roomId,
          }),
        });
        const data = await response.json();
        if (data.ok && data.token) {
          const resolvedUrl = ((data.url as string | undefined) || LIVEKIT_URL || '').trim();
          await this.connectToLiveKit(resolvedUrl, data.token, ++this.connectRequestId, params.roomId);
        }
      } catch (e) {
        logger.error('[VideoCallSession] Error restoring call state', e);
      }
    }
  }

  /**
   * Отписывает сессию от сокета и помечает её завершённой БЕЗ отправки call:end.
   * Используется когда эта сессия "пропустила" call:accepted (другая сессия подключается),
   * чтобы не накапливать зомби-сессии со 2–4 звонка и не слать лишний call:end.
   */
  private detachFromCall(): void {
    if (this.ended) return;
    this.ended = true;
    this.socketOffs.forEach((off) => off());
    this.socketOffs = [];
    logger.info('[VideoCallSession] 🔌 Сессия отключена от сокета (skip path), handlers сняты');
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.endCall();
    this.socketOffs.forEach((off) => off());
    this.socketOffs = [];
  }

  // Методы для совместимости
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
    this.endCall();
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  getPartnerId(): string | null {
    return this.currentRemoteParticipant?.identity || this.partnerId;
  }

  getRoomId(): string | null {
    return this.room?.name || this.roomId;
  }

  getCallId(): string | null {
    return this.callId;
  }

  /** Звонок уже завершён (endCall вызван или получен call:ended). Используется в App, чтобы не показывать PiP с пустыми данными. */
  isEnded(): boolean {
    return this.ended || this.endCallInProgress;
  }

  getPartnerUserId(): string | null {
    return this.partnerUserId;
  }

  enterPiP?(): void {
    logger.info('[VideoCallSession] enterPiP вызван');
    this.setInPiP(true);
    
    // Отправляем pip:state партнеру только если звонок ещё активен (гонка: call ended и PiP могут совпасть).
    const currentRoomId = this.getRoomId();
    if (this.ended || this.endCallInProgress || !currentRoomId) {
      logger.debug('[VideoCallSession] pip:state не отправляем — звонок завершён или нет roomId', {
        ended: this.ended,
        hasRoomId: !!currentRoomId,
      });
      return;
    }
    try {
      const payload = { inPiP: true, from: socket.id, roomId: currentRoomId };
      socket.emit('pip:state', payload);
      logger.info('[VideoCallSession] ✅ Отправлено pip:state=true партнеру', { roomId: currentRoomId });
    } catch (e) {
      logger.warn('[VideoCallSession] Ошибка отправки pip:state:', e);
    }
  }

  exitPiP?(): void {
    logger.info('[VideoCallSession] exitPiP вызван');
    this.setInPiP(false);
    
    const currentRoomId = this.getRoomId();
    if (this.ended || this.endCallInProgress || !currentRoomId) {
      logger.debug('[VideoCallSession] pip:state не отправляем при exitPiP — звонок завершён или нет roomId');
      return;
    }
    try {
      socket.emit('pip:state', { inPiP: false, from: socket.id, roomId: currentRoomId });
      logger.info('[VideoCallSession] ✅ Отправлено pip:state=false партнеру', { roomId: currentRoomId });
      // КРИТИЧНО: При возврате из PiP сообщаем партнеру ТЕКУЩЕЕ состояние нашей камеры
      try {
        socket.emit('cam-toggle', {
          enabled: !!this.isCamOn,
          from: socket.id,
          roomId: currentRoomId,
        });
        logger.info('[VideoCallSession] ✅ Отправлено cam-toggle(enabled) партнеру при возврате из PiP', {
          roomId: currentRoomId,
          enabled: !!this.isCamOn,
        });
      } catch (e) {
        logger.warn('[VideoCallSession] Ошибка отправки cam-toggle при возврате из PiP:', e);
      }
    } catch (e) {
      logger.warn('[VideoCallSession] Ошибка отправки pip:state:', e);
    }
  }

  getPartnerInPiP(): boolean {
    return this.partnerInPiP;
  }

  destroy(): void {
    this.cleanup();
  }

  // sendCameraState больше не нужен - LiveKit сам управляет состоянием через треки
  sendCameraState?(_toPartnerId?: string, _enabled?: boolean): void {
    // LiveKit автоматически синхронизирует состояние камеры через треки
  }

  /* ===================== Internal helpers ===================== */

  private setupSocketHandlers(): void {
    logger.info('[VideoCallSession] 🔌 Setting up socket handlers', {
      myUserId: this.config.myUserId,
    });
    
    // КРИТИЧНО: Удаляем старые обработчики перед добавлением новых
    // Это предотвращает дублирование обработчиков при повторном вызове
    if (this.socketOffs.length > 0) {
      logger.info('[VideoCallSession] Удаляем старые socket handlers перед добавлением новых', {
        handlersCount: this.socketOffs.length
      });
      this.socketOffs.forEach((off) => {
        try {
          off();
        } catch (e) {
          logger.warn('[VideoCallSession] Ошибка при удалении старого обработчика', e);
        }
      });
      this.socketOffs = [];
    }
    
    // Удаляем обработчики напрямую если они были сохранены
    if (this.socketHandlers.callAccepted) {
      socket.off('call:accepted', this.socketHandlers.callAccepted);
    }
    if (this.socketHandlers.callIncoming) {
      socket.off('call:incoming', this.socketHandlers.callIncoming);
    }
    if (this.socketHandlers.callEnded) {
      socket.off('call:ended', this.socketHandlers.callEnded);
      socket.off('call:cancel', this.socketHandlers.callEnded);
    }
    if (this.socketHandlers.callError) {
      socket.off('call:error', this.socketHandlers.callError);
    }
    if (this.socketHandlers.callDeclined) {
      socket.off('call:declined', this.socketHandlers.callDeclined);
    }
    if (this.socketHandlers.disconnected) {
      socket.off('disconnected', this.socketHandlers.disconnected);
    }
    if (this.socketHandlers.pipState) {
      socket.off('pip:state', this.socketHandlers.pipState);
    }
    if (this.socketHandlers.camToggle) {
      socket.off('cam-toggle', this.socketHandlers.camToggle);
    }
    
    const callAcceptedHandler = (data: CallAcceptedPayload) => {
      logger.info('[VideoCallSession] 📡 Socket event call:accepted received in handler', {
        callId: data.callId,
        roomId: data.roomId,
        from: data.from,
        fromUserId: data.fromUserId,
        myUserId: this.config.myUserId,
        hasLivekitToken: !!data.livekitToken,
        hasLivekitRoomName: !!data.livekitRoomName,
      });
      // КРИТИЧНО: Если сессия еще не полностью инициализирована, сохраняем событие
      // Это может произойти, если событие приходит сразу после создания сессии
      // Но обычно это не нужно, так как setupSocketHandlers вызывается в конструкторе
      this.handleCallAccepted(data).catch((e) => {
        logger.error('[VideoCallSession] ❌ Failed to handle call:accepted', {
          error: e,
          callId: data.callId,
          roomId: data.roomId,
          myUserId: this.config.myUserId,
        });
      });
    };
    
    const callIncomingHandler = (data: CallIncomingPayload) => {
      this.handleCallIncoming(data);
    };
    
    const callEndedHandler = (data?: { callId?: string; roomId?: string; reason?: string; scope?: string }) => {
      logger.info('[VideoCallSession] 📡 Socket event call:ended received', {
        callId: data?.callId,
        roomId: data?.roomId,
        reason: data?.reason,
        scope: data?.scope,
        currentCallId: this.callId,
        currentRoomId: this.roomId,
        willHandle: true
      });
      this.handleCallEnded();
    };

    // call:error = сервер не смог создать токены (например LiveKit недоступен); завершаем звонок как при call:ended
    const callErrorHandler = (data?: { callId?: string; reason?: string }) => {
      logger.warn('[VideoCallSession] 📡 Socket event call:error received', {
        callId: data?.callId,
        reason: data?.reason,
        currentCallId: this.callId,
      });
      this.handleCallEnded();
    };

    // call:declined = тот, кому звонили, отклонил; инициатор получает это и должен закрыть модалку «Ожидаем ответа»
    // Не вызываем handleCallEnded() — только emit('callDeclined'), чтобы у инициатора не было двойного мерцания (один раз закрытие из App, без лишнего callEnded)
    const callDeclinedHandler = (data?: { callId?: string; from?: string }) => {
      logger.info('[VideoCallSession] 📡 Socket event call:declined received (callee declined)', {
        callId: data?.callId,
        from: data?.from,
        currentCallId: this.callId,
      });
      this.emit('callDeclined');
    };
    
    const disconnectedHandler = () => {
      // Временный обрыв сокета НЕ должен рвать LiveKit и сбрасывать remoteStream.
      // Иначе UI показывает "ошибка/нет видео" и потом "соединяет" после reconnect.
      logger.warn('[VideoCallSession] Socket disconnected (ignored; LiveKit call continues)', {
        callId: this.callId,
        roomId: this.roomId,
        hasRoom: !!this.room,
        roomState: this.room?.state,
      });
    };

    const pipStateHandler = (data: { inPiP: boolean; roomId: string; from: string }) => {
      // Не обновлять PiP-состояние после завершения звонка — иначе у партнёра мерцание (pip:state может прийти после call:ended).
      if (this.ended || this.endCallInProgress) {
        logger.debug('[VideoCallSession] pip:state проигнорировано — звонок уже завершён');
        return;
      }
      const currentRoomId = this.getRoomId();
      logger.info('[VideoCallSession] 📡 Socket event pip:state received', {
        inPiP: data.inPiP,
        roomId: data.roomId,
        from: data.from,
        currentRoomId: currentRoomId,
        roomIdsMatch: data.roomId === currentRoomId,
      });
      
      // Проверяем что это событие для нашей комнаты
      // КРИТИЧНО: Сравниваем roomId как строки, учитывая возможные различия в формате
      const roomIdsMatch = data.roomId && currentRoomId && (
        data.roomId === currentRoomId || 
        data.roomId.trim() === currentRoomId.trim()
      );
      
      logger.info('[VideoCallSession] pip:state - проверка совпадения roomId', {
        receivedRoomId: data.roomId,
        currentRoomId: currentRoomId,
        roomIdsMatch,
        inPiP: data.inPiP,
        from: data.from
      });
      
      if (roomIdsMatch) {
        const previousState = this.partnerInPiP;
        this.partnerInPiP = data.inPiP;
        logger.info('[VideoCallSession] ✅ Обновлено состояние партнера в PiP', {
          previousState,
          newState: this.partnerInPiP,
          roomId: data.roomId,
        });
        
        // Уведомляем компонент об изменении состояния партнера
        this.emit('partnerPiPStateChanged', { inPiP: data.inPiP });
        logger.info('[VideoCallSession] ✅ Событие partnerPiPStateChanged отправлено компоненту', { inPiP: data.inPiP });
      } else {
        logger.warn('[VideoCallSession] ⚠️ pip:state событие проигнорировано - не совпадает roomId', {
          receivedRoomId: data.roomId,
          currentRoomId: currentRoomId,
          hasReceivedRoomId: !!data.roomId,
          hasCurrentRoomId: !!currentRoomId,
          roomIdsMatch,
          receivedType: typeof data.roomId,
          currentType: typeof currentRoomId,
        });
      }
    };

    const camToggleHandler = (data: { enabled: boolean; from: string; roomId?: string }) => {
      const currentRoomId = this.getRoomId();
      logger.info('[VideoCallSession] 📡 Socket event cam-toggle received', {
        enabled: data.enabled,
        from: data.from,
        roomId: data.roomId,
        currentRoomId: currentRoomId,
        roomIdsMatch: data.roomId === currentRoomId,
      });
      
      // Проверяем что это событие для нашей комнаты
      if (data.roomId && currentRoomId && data.roomId === currentRoomId) {
        logger.info('[VideoCallSession] ✅ Обновлено состояние камеры партнера через cam-toggle', {
          enabled: data.enabled,
          roomId: data.roomId,
        });
        
        // Обновляем состояние камеры партнера
        this.remoteCamEnabled = data.enabled;
        this.clearRemoteCamOffTimeout();
        
        // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления UI
        this.remoteViewKey = Date.now();
        this.emit('remoteViewKeyChanged', this.remoteViewKey);
        
        // Уведомляем компонент об изменении состояния камеры
        this.config.callbacks.onRemoteCamStateChange?.(data.enabled);
        this.config.onRemoteCamStateChange?.(data.enabled);
        
        logger.info('[VideoCallSession] ✅ Вызван onRemoteCamStateChange через cam-toggle', { enabled: data.enabled });
      } else {
        logger.debug('[VideoCallSession] cam-toggle событие проигнорировано - не совпадает roomId', {
          receivedRoomId: data.roomId,
          currentRoomId: currentRoomId,
        });
      }
    };

    // Сохраняем ссылки на обработчики для возможности их удаления
    this.socketHandlers.callAccepted = callAcceptedHandler;
    this.socketHandlers.callIncoming = callIncomingHandler;
    this.socketHandlers.callEnded = callEndedHandler;
    this.socketHandlers.callError = callErrorHandler;
    this.socketHandlers.callDeclined = callDeclinedHandler;
    this.socketHandlers.disconnected = disconnectedHandler;
    this.socketHandlers.pipState = pipStateHandler;
    this.socketHandlers.camToggle = camToggleHandler;
    
    socket.on('call:accepted', callAcceptedHandler);
    socket.on('call:incoming', callIncomingHandler);
    socket.on('call:ended', callEndedHandler);
    socket.on('call:error', callErrorHandler);
    socket.on('call:declined', callDeclinedHandler);
    socket.on('disconnected', disconnectedHandler);
    socket.on('call:cancel', callEndedHandler);
    socket.on('pip:state', pipStateHandler);
    socket.on('cam-toggle', camToggleHandler);
    
    logger.info('[VideoCallSession] ✅ Socket handlers registered', {
      myUserId: this.config.myUserId,
    });

    this.socketOffs = [
      () => socket.off('call:accepted', callAcceptedHandler),
      () => socket.off('call:incoming', callIncomingHandler),
      () => socket.off('call:ended', callEndedHandler),
      () => socket.off('call:error', callErrorHandler),
      () => socket.off('call:declined', callDeclinedHandler),
      () => socket.off('disconnected', disconnectedHandler),
      () => socket.off('call:cancel', callEndedHandler),
      () => socket.off('pip:state', pipStateHandler),
      () => socket.off('cam-toggle', camToggleHandler),
    ];
  }

  private async handleCallAccepted(data: CallAcceptedPayload): Promise<void> {
    const targetRoomName = data.livekitRoomName ?? data.roomId ?? null;
    const callId = data.callId ?? null;
    
    // КРИТИЧНО: Обрабатывать call:accepted должна только "активная" сессия (та, что в глобальном ref).
    // Иначе несколько экземпляров сессии (например, до очистки старых при ремаунте) все подключаются к комнате
    // и одна попытка падает с "could not establish pc connection".
    const globalSession = (global as any).__webrtcSessionRef?.current;
    if (globalSession != null && globalSession !== this) {
      logger.info('[VideoCallSession] ⏭️ Another session is active, skipping call:accepted', {
        callId,
        roomName: targetRoomName,
        myUserId: this.config.myUserId,
      });
      this.detachFromCall();
      return;
    }
    
    // КРИТИЧНО: Защита от повторной обработки одного и того же события
    // Проверяем, не обрабатывали ли мы уже это событие
    if (this.lastProcessedCallAccepted && 
        this.lastProcessedCallAccepted.callId === callId &&
        this.lastProcessedCallAccepted.roomName === targetRoomName &&
        (Date.now() - this.lastProcessedCallAccepted.timestamp) < 5000) {
      logger.info('[VideoCallSession] ⏭️ Already processed this call:accepted event, skipping', {
        callId,
        roomName: targetRoomName,
        lastProcessed: this.lastProcessedCallAccepted.timestamp,
        timeSince: Date.now() - this.lastProcessedCallAccepted.timestamp,
      });
      return;
    }
    
    // Сразу помечаем событие как обрабатываемое, чтобы параллельные вызовы (дубликаты/другие подписки) не стартовали второе подключение
    this.lastProcessedCallAccepted = { callId, roomName: targetRoomName, timestamp: Date.now() };
    
    logger.info('[VideoCallSession] 📥 Received call:accepted event', {
      callId: data.callId,
      roomId: data.roomId,
      from: data.from,
      fromUserId: data.fromUserId,
      hasLivekitToken: !!data.livekitToken,
      hasLivekitRoomName: !!data.livekitRoomName,
      myUserId: this.config.myUserId,
      tokenLength: data.livekitToken?.length || 0,
      roomName: data.livekitRoomName,
      currentRoomName: this.currentRoomName,
      roomState: this.room?.state,
    });

    const roomId = data.roomId ?? null;
    const partnerId = data.from ?? null;
    const partnerUserId = data.fromUserId ?? null;

    // КРИТИЧНО: Проверяем, не подключены ли уже к этой комнате
    // Это предотвращает повторное подключение и ошибку "could not establish pc connection"
    if (this.room && 
        this.room.state === 'connected' && 
        this.currentRoomName && 
        targetRoomName && 
        this.currentRoomName === targetRoomName) {
      logger.info('[VideoCallSession] ⏭️ Already connected to this room, skipping reconnection', {
        roomName: targetRoomName,
        currentRoomName: this.currentRoomName,
        roomState: this.room.state,
        callId: data.callId,
      });
      // Обновляем данные о партнере, если они изменились
      if (partnerUserId && partnerUserId !== this.partnerUserId) {
        this.partnerUserId = partnerUserId;
        this.config.callbacks.onPartnerIdChange?.(partnerId);
        this.config.onPartnerIdChange?.(partnerId);
      }
      if (partnerId && partnerId !== this.partnerId) {
        this.partnerId = partnerId;
        this.config.callbacks.onPartnerIdChange?.(partnerId);
        this.config.onPartnerIdChange?.(partnerId);
      }
      if (callId && callId !== this.callId) {
        this.callId = callId;
        this.config.callbacks.onCallIdChange?.(callId);
      }
      if (roomId && roomId !== this.roomId) {
        this.roomId = roomId;
        this.config.callbacks.onRoomIdChange?.(roomId);
        this.config.onRoomIdChange?.(roomId);
      }
      this.config.setIsInactiveState?.(false);
      this.config.setFriendCallAccepted?.(true);
      // Сохраняем информацию о том, что событие обработано
      this.lastProcessedCallAccepted = { callId, roomName: targetRoomName, timestamp: Date.now() };
      return;
    }
    
    // lastProcessedCallAccepted уже установлен в начале handleCallAccepted

    this.roomId = roomId;
    this.callId = callId;
    this.partnerId = partnerId;
    this.partnerUserId = partnerUserId;

    this.config.callbacks.onRoomIdChange?.(roomId);
    this.config.onRoomIdChange?.(roomId);
    this.config.callbacks.onPartnerIdChange?.(partnerId);
    this.config.onPartnerIdChange?.(partnerId);
    if (callId) {
      this.config.callbacks.onCallIdChange?.(callId);
    }
    
    // КРИТИЧНО: Уведомляем компонент об изменении partnerUserId для отображения бейджа друга
    // Для этого нужно передать partnerUserId через callback, но так как нет отдельного callback,
    // используем существующий механизм через обновление состояния в компоненте
    // Компонент должен получать partnerUserId из handleCallAccepted через onPartnerIdChange
    // Но partnerId и partnerUserId - разные вещи, поэтому нужно убедиться, что компонент получает partnerUserId

    const resolvedLivekitUrl = ((data.livekitUrl as string | undefined) || LIVEKIT_URL || '').trim();
    if (!resolvedLivekitUrl) {
      logger.error('[VideoCallSession] LiveKit URL is not configured', {
        envVar: 'EXPO_PUBLIC_LIVEKIT_URL',
        value: process.env.EXPO_PUBLIC_LIVEKIT_URL,
        payloadUrl: data.livekitUrl,
        roomId: data.livekitRoomName,
      });
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      return;
    }
    
    // Если токен пришел в событии (новый формат)
    if (data.livekitToken && data.livekitRoomName) {
      logger.info('[VideoCallSession] 🔑 Connecting to LiveKit with token from call:accepted', {
        roomName: data.livekitRoomName,
        tokenLength: data.livekitToken.length,
        myUserId: this.config.myUserId,
        partnerUserId: partnerUserId,
      });
      
      // КРИТИЧНО: Если уже идет подключение к той же комнате, ждем его завершения вместо создания нового запроса
      if (this.connectingPromise && targetRoomName && this.currentRoomName === targetRoomName) {
        logger.info('[VideoCallSession] ⏳ Connection to same room already in progress, waiting for completion', {
          targetRoomName,
          currentRoomName: this.currentRoomName,
        });
        try {
          const result = await this.connectingPromise;
          if (result && this.room && this.room.state === 'connected' && this.currentRoomName === targetRoomName) {
            if (this.ended) return;
            logger.info('[VideoCallSession] ✅ Reused existing connection to room', {
              roomName: this.currentRoomName,
            });
            this.config.setIsInactiveState?.(false);
            this.config.setFriendCallAccepted?.(true);
            this.emit('callAnswered');
            return;
          }
        } catch (e) {
          logger.warn('[VideoCallSession] Existing connection failed, will create new one', e);
        }
      }
      
      // Глобальная блокировка: на устройстве к одной комнате подключается только одна сессия.
      // При ремаунте VideoCall новый экземпляр перезаписывает __webrtcSessionRef, и без этой блокировки
      // несколько сессий успевают стартовать подключение → лоадер/залипание у второго участника.
      if (!(global as any).__connectingToRoomRef) {
        (global as any).__connectingToRoomRef = { roomName: null as string | null, session: null as VideoCallSession | null };
      }
      const roomLock = (global as any).__connectingToRoomRef as { roomName: string | null; session: VideoCallSession | null };
      if (roomLock.roomName === targetRoomName && roomLock.session != null && roomLock.session !== this) {
        logger.info('[VideoCallSession] ⏭️ Another session is already connecting to this room, skipping', {
          roomName: targetRoomName,
          myUserId: this.config.myUserId,
        });
        // КРИТИЧНО: UI привязан к __webrtcSessionRef; эта сессия не подключается — переключаем ref на ту, что подключается,
        // иначе у пользователя вечный спиннер и чёрный экран (особенно на 3–4 звонке при ремаунте).
        const globalRef = (global as any).__webrtcSessionRef;
        if (globalRef && typeof globalRef.current !== 'undefined') {
          globalRef.current = roomLock.session;
          logger.info('[VideoCallSession] ✅ Переключили __webrtcSessionRef на сессию, которая подключается к комнате', {
            roomName: targetRoomName,
          });
        }
        this.config.onSwitchToConnectingSession?.(roomLock.session);
        // КРИТИЧНО: отписываем эту сессию от сокета, чтобы не накапливать зомби к 3–4 звонку
        this.detachFromCall();
        return;
      }
      roomLock.roomName = targetRoomName;
      roomLock.session = this;
      
      // КРИТИЧНО: Используем retry механизм для надежного подключения при проблемах с сетью
      let connected = false;
      let lastError: Error | null = null;
      const maxRetries = 3;
      const retryDelay = 500; // 500ms между попытками
      
      try {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (this.ended) {
          logger.info('[VideoCallSession] ⏭️ Stopping retries: call ended (call:ended received)');
          break;
        }
        try {
          const connectRequestId = ++this.connectRequestId;
          logger.info('[VideoCallSession] Connection attempt', {
            attempt,
            maxRetries,
            roomName: data.livekitRoomName,
            connectRequestId,
          });
          
          connected = await this.connectToLiveKit(resolvedLivekitUrl, data.livekitToken, connectRequestId, data.livekitRoomName);
          
          if (connected) {
            logger.info('[VideoCallSession] ✅ Successfully connected to LiveKit after call:accepted', {
              roomName: data.livekitRoomName,
              myUserId: this.config.myUserId,
              attempt,
            });
            break;
          } else {
            // Если подключение не удалось, но это не из-за stale request, пробуем еще раз
            if (attempt < maxRetries && !this.ended) {
              logger.warn('[VideoCallSession] Connection attempt failed, retrying', {
                attempt,
                maxRetries,
                roomName: data.livekitRoomName,
                willRetry: true,
              });
              await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
            }
          }
        } catch (e) {
          lastError = e as Error;
          if (!this.ended) {
            logger.warn('[VideoCallSession] Connection attempt error', {
              attempt,
              maxRetries,
              error: e,
              willRetry: attempt < maxRetries,
            });
          }
          if (attempt < maxRetries && !this.ended) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          }
        }
      }
      
      if (!connected) {
        if (this.ended) {
          logger.info('[VideoCallSession] Call ended before connection completed, skipping');
          return;
        }
        logger.error('[VideoCallSession] ❌ Failed to connect to LiveKit after all retries', {
          roomName: data.livekitRoomName,
          myUserId: this.config.myUserId,
          maxRetries,
          lastError: lastError?.message,
        });
        // НЕ прерываем обработку - возможно подключение уже установлено через другой запрос
        // Проверяем, не подключены ли уже к этой комнате
        if (this.room &&
            this.room.state === 'connected' &&
            this.currentRoomName === targetRoomName) {
          if (this.ended) return;
          logger.info('[VideoCallSession] ✅ Room connected via another request, continuing', {
            roomName: this.currentRoomName,
          });
          this.config.setIsInactiveState?.(false);
          this.config.setFriendCallAccepted?.(true);
          this.emit('callAnswered');
          return;
        }
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
        return;
      }
      
      // КРИТИЧНО: Если звонок уже завершён (call:ended), не обновлять UI и не эмитить callAnswered
      if (this.ended) {
        logger.info('[VideoCallSession] ⏭️ Skipping post-connect (call already ended)');
        return;
      }
      // КРИТИЧНО: НЕ устанавливаем loading=false сразу - пусть он остается true пока не придет remoteStream
      // loading будет установлен в false в handleTrackSubscribed когда придет remoteStream
      // Это предотвращает черный экран при принятии звонка
      // this.config.callbacks.onLoadingChange?.(false);
      // this.config.onLoadingChange?.(false);
      this.config.setIsInactiveState?.(false);
      this.config.setFriendCallAccepted?.(true);
      this.emit('callAnswered');
      return;
      } finally {
        // НЕ сбрасываем setActiveVideoCall(false) здесь — звонок активен, сокет не должен отключаться в фоне.
        // setActiveVideoCall(false) вызывается только при disconnectRoom/endCall.
        if ((global as any).__connectingToRoomRef?.session === this) {
          (global as any).__connectingToRoomRef.roomName = null;
          (global as any).__connectingToRoomRef.session = null;
        }
      }
    }
    
    // Fallback: запрашиваем токен через API
    if (roomId) {
      // КРИТИЧНО: Если уже идет подключение к той же комнате, ждем его завершения
      if (this.connectingPromise && targetRoomName && this.currentRoomName === targetRoomName) {
        logger.info('[VideoCallSession] ⏳ Connection to same room already in progress (fallback), waiting for completion', {
          targetRoomName,
          currentRoomName: this.currentRoomName,
        });
        try {
          const result = await this.connectingPromise;
          if (result && this.room && this.room.state === 'connected' && this.currentRoomName === targetRoomName) {
            if (this.ended) return;
            logger.info('[VideoCallSession] ✅ Reused existing connection to room (fallback)', {
              roomName: this.currentRoomName,
            });
            this.config.setIsInactiveState?.(false);
            this.config.setFriendCallAccepted?.(true);
            this.emit('callAnswered');
            return;
          }
        } catch (e) {
          logger.warn('[VideoCallSession] Existing connection failed (fallback), will create new one', e);
        }
      }
      
      try {
        const response = await fetch(`${process.env.EXPO_PUBLIC_SERVER_URL}/api/livekit/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: this.config.myUserId,
            roomName: roomId,
          }),
        });
        const tokenData = await response.json();
        if (tokenData.ok && tokenData.token) {
          const resolvedUrl = ((tokenData.url as string | undefined) || LIVEKIT_URL || '').trim();
          // КРИТИЧНО: Используем retry механизм для надежного подключения
          let connected = false;
          const maxRetries = 3;
          const retryDelay = 500;
          
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (this.ended) {
              logger.info('[VideoCallSession] ⏭️ Stopping retries (fallback): call ended');
              break;
            }
            try {
              const connectRequestId = ++this.connectRequestId;
              logger.info('[VideoCallSession] Connection attempt (fallback)', {
                attempt,
                maxRetries,
                roomId,
                connectRequestId,
              });
              
              connected = await this.connectToLiveKit(resolvedUrl, tokenData.token, connectRequestId, roomId);
              
              if (connected) {
                logger.info('[VideoCallSession] ✅ Successfully connected to LiveKit (fallback)', {
                  roomId,
                  attempt,
                });
                break;
              } else {
                if (attempt < maxRetries && !this.ended) {
                  logger.warn('[VideoCallSession] Connection attempt failed (fallback), retrying', {
                    attempt,
                    maxRetries,
                    roomId,
                    willRetry: true,
                  });
                  await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                }
              }
            } catch (e) {
              if (!this.ended) {
                logger.warn('[VideoCallSession] Connection attempt error (fallback)', {
                  attempt,
                  maxRetries,
                  error: e,
                  willRetry: attempt < maxRetries,
                });
              }
              if (attempt < maxRetries && !this.ended) {
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
              }
            }
          }
          
          if (!connected) {
            if (this.ended) {
              logger.info('[VideoCallSession] Call ended before connection completed (fallback), skipping');
              return;
            }
            logger.error('[VideoCallSession] ❌ Failed to connect to LiveKit after all retries (fallback)', {
              roomId,
              maxRetries,
            });
            // Проверяем, не подключены ли уже к этой комнате
            if (this.room &&
                this.room.state === 'connected' &&
                this.currentRoomName === targetRoomName) {
              if (this.ended) return;
              logger.info('[VideoCallSession] ✅ Room connected via another request (fallback), continuing', {
                roomName: this.currentRoomName,
              });
              this.config.setIsInactiveState?.(false);
              this.config.setFriendCallAccepted?.(true);
              this.emit('callAnswered');
              return;
            }
            this.config.callbacks.onLoadingChange?.(false);
            this.config.onLoadingChange?.(false);
            return;
          }
          
          if (this.ended) {
            logger.info('[VideoCallSession] ⏭️ Skipping post-connect (fallback): call already ended');
            return;
          }
          // КРИТИЧНО: НЕ устанавливаем loading=false сразу - пусть он остается true пока не придет remoteStream
          // loading будет установлен в false в handleTrackSubscribed когда придет remoteStream
          // Это предотвращает черный экран при принятии звонка
          // this.config.callbacks.onLoadingChange?.(false);
          // this.config.onLoadingChange?.(false);
          this.config.setIsInactiveState?.(false);
          this.config.setFriendCallAccepted?.(true);
          this.emit('callAnswered');
        }
      } catch (e) {
        logger.error('[VideoCallSession] Error fetching LiveKit token', e);
        this.config.callbacks.onLoadingChange?.(false);
        this.config.onLoadingChange?.(false);
      }
    } else {
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
    }
  }

  private handleCallIncoming(data: CallIncomingPayload): void {
    this.callId = data.callId;
    this.partnerUserId = data.from;
    this.emit('incomingCall', {
      callId: data.callId,
      fromUser: data.from,
      fromNick: data.fromNick,
    });
  }

  private handleCallEnded(): void {
    // КРИТИЧНО: Сразу закрываем системный PiP при любом call:ended (до любых return). Иначе при раннем return PiP у собеседника не закрывается.
    if (Platform.OS === 'android') {
      try { (NativeModules as any)?.LiviAppModule?.requestExitSystemPiP?.(); } catch {}
    }
    // Закрываем in-app PiP у собеседника (когда звонок завершил тот, кто в системном PiP — сокет у него мог быть отключён, call:ended не пришёл; мы сюда попали по ParticipantDisconnected).
    try {
      const hidePiP = (global as any).__pipHidePiPRef?.current;
      if (typeof hidePiP === 'function') hidePiP();
    } catch {}
    // Idempotency: server may deliver call:ended multiple times (e.g., room + direct).
    // Also, call:ended can arrive after local cleanup already cleared ids.
    // In those cases, ignore to avoid duplicate cleanup and "null callId" log noise.
    if (this.ended || this.endCallInProgress) {
      logger.debug('[VideoCallSession] Ignoring duplicate call:ended', {
        ended: this.ended,
        endCallInProgress: this.endCallInProgress,
        callId: this.callId,
        roomId: this.roomId,
      });
      return;
    }

    // Зомби-сессия (уже очищена cleanupFunction): не эмитить callEnded — иначе второй handleCallEnded в UI и мерцание при переходе на Home.
    if (!this.callId && !this.roomId) {
      logger.debug('[VideoCallSession] Ignoring call:ended (no callId/roomId, zombie session)', {
        hasRoom: !!this.room,
        roomState: this.room?.state,
      });
      return;
    }

    // Safety: sometimes the UI/session may clear identifiers early (race with cleanup / reconnect),
    // but LiveKit room/tracks may still be active. In that case we MUST still teardown on call:ended.
    // Only ignore if we are clearly not in a call anymore.
    const hasAnyIdentifiers = !!this.callId || !!this.roomId;
    const hasLiveKitRoom = !!this.room && this.room.state !== 'disconnected';
    const hasAnyTracks = !!this.localStream || !!this.remoteStream || !!this.localAudioTrack || !!this.localVideoTrack;
    if (!hasAnyIdentifiers && !hasLiveKitRoom && !hasAnyTracks) {
      logger.debug('[VideoCallSession] Ignoring call:ended (no active call state)', {
        callId: this.callId,
        roomId: this.roomId,
        hasLiveKitRoom,
        hasAnyTracks,
      });
      return;
    }

    // КРИТИЧНО: Сразу помечаем завершение, чтобы повторный вызов (socket call:ended + ParticipantDisconnected
    // почти одновременно) не выполнял очистку и emit('callEnded') дважды.
    this.ended = true;
    if (Platform.OS === 'android') {
      try { (NativeModules as any)?.LiviAppModule?.setEndingCallInProgress?.(true); } catch {}
      try { (NativeModules as any)?.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch {}
    }

    // КРИТИЧНО: Сохраняем состояние ПЕРЕД очисткой для логирования
    const savedCallId = this.callId;
    const savedRoomId = this.roomId;
    const savedPartnerId = this.partnerId;
    const savedPartnerUserId = this.partnerUserId;
    
    logger.info('[VideoCallSession] 📡 handleCallEnded вызван - получено call:ended от сервера', {
      callId: savedCallId,
      roomId: savedRoomId,
      partnerId: savedPartnerId,
      partnerUserId: savedPartnerUserId,
    });
    
    // КРИТИЧНО: При получении call:ended от сервера (другой участник завершил звонок)
    // нужно завершить звонок локально, но НЕ отправлять call:end на сервер повторно
    // Это гарантирует, что оба участника завершат звонок одновременно
    void this.disconnectRoom('server');
    this.resetRemoteState();
    this.stopLocalTracks();
    
    // Очищаем состояние
    this.callId = null;
    this.roomId = null;
    this.partnerId = null;
    this.partnerUserId = null;
    this.config.callbacks.onPartnerIdChange?.(null);
    this.config.onPartnerIdChange?.(null);
    this.config.callbacks.onRoomIdChange?.(null);
    this.config.onRoomIdChange?.(null);
    this.config.callbacks.onCallIdChange?.(null);
    this.config.callbacks.onLoadingChange?.(false);
    this.config.onLoadingChange?.(false);
    this.config.setFriendCallAccepted?.(false);
    this.config.setIsInactiveState?.(true);
    this.config.setWasFriendCallEnded?.(true);
    
    // Отправляем событие callEnded для компонентов
    // КРИТИЧНО: Это событие должно быть отправлено даже если состояние уже очищено
    // Компоненты должны обработать завершение звонка независимо от состояния сессии
    this.emit('callEnded');
    logger.info('[VideoCallSession] ✅ Звонок завершен после получения call:ended от сервера', {
      previousCallId: savedCallId,
      previousRoomId: savedRoomId,
      previousPartnerId: savedPartnerId,
      previousPartnerUserId: savedPartnerUserId,
    });
  }

  private handleDisconnected(): void {
    void this.disconnectRoom('server');
    this.resetRemoteState();
  }

  private clearPendingRemoteDisconnectTimer(): void {
    if (this.pendingRemoteDisconnectTimer) {
      clearTimeout(this.pendingRemoteDisconnectTimer);
      this.pendingRemoteDisconnectTimer = null;
    }
  }

  private async ensureLocalTracks(force = false): Promise<void> {
    if (this.localVideoTrack && this.localAudioTrack && !force) {
      this.emit('localStream', this.localStream);
      this.config.callbacks.onLocalStreamChange?.(this.localStream);
      this.config.onLocalStreamChange?.(this.localStream);
      // Эквалайзер отключен: мониторинг микрофона не запускаем
      return;
    }

    // Сохраняем состояние камеры/микрофона перед очисткой треков
    const savedCamState = this.isCamOn;
    const savedMicState = this.isMicOn;

    if (force) {
      this.stopLocalTracksWithoutStateReset();
    }

    const facingMode = this.camSide === 'front' ? 'user' : 'environment';
    const preferred = getPreferredVideoCaptureOptions(facingMode);
    logger.info('[VideoCallSession] Video capture preset', preferred.meta);

    let tracks: LocalTrack[] = [];
    try {
      tracks = await createLocalTracks({ audio: true, video: preferred.primary });
    } catch (e1) {
      logger.warn('[VideoCallSession] Failed to create local tracks with preferred preset; retrying with fallback', {
        error: (e1 as any)?.message || String(e1),
        preferred: preferred.meta,
      });
      try {
        tracks = await createLocalTracks({ audio: true, video: preferred.fallback || preferred.primary });
      } catch (e2) {
        logger.error('[VideoCallSession] Failed to create local tracks (preferred + fallback)', {
          preferred: preferred.meta,
          error: (e2 as any)?.message || String(e2),
        });
        throw e2;
      }
    }

    tracks.forEach((track) => {
      if (track.kind === Track.Kind.Video) {
        this.localVideoTrack = track as LocalVideoTrack;
      } else if (track.kind === Track.Kind.Audio) {
        this.localAudioTrack = track as LocalAudioTrack;
      }
    });

    const stream = new MediaStream();
    tracks.forEach((track) => {
      const mediaTrack = track.mediaStreamTrack;
      if (mediaTrack) {
        stream.addTrack(mediaTrack as any);
      }
    });
    this.localStream = stream;
    
    // Восстанавливаем сохранённое состояние камеры/микрофона
    this.isCamOn = savedCamState;
    this.isMicOn = savedMicState;

    // КРИТИЧНО: Применяем сохранённые состояния к трекам сразу после создания.
    // Иначе можно получить ситуацию "UI показывает mic/cam off, но треки реально включены".
    try {
      if (this.localVideoTrack?.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = this.isCamOn;
        if (this.isCamOn) {
          await this.localVideoTrack.unmute().catch(() => {});
        } else {
          await this.localVideoTrack.mute().catch(() => {});
        }
      }
    } catch {}
    try {
      if (this.localAudioTrack) {
        if (this.isMicOn) this.localAudioTrack.unmute();
        else this.localAudioTrack.mute();
      }
    } catch {}
    
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
    this.emit('localStream', stream);
    // НЕ отправляем onCamStateChange здесь - это делается в toggleCam после завершения

    // КРИТИЧНО: Эквалайзер должен работать в видеозвонке так же, как в RandomChat.
    // Эквалайзер отключен: мониторинг микрофона не запускаем
  }

  private stopLocalVideoTrackWithoutStateReset(): void {
    if (!this.localVideoTrack) return;
    // КРИТИЧНО: Сначала отключаем захват кадров, затем stop() — снижает CameraDeviceClient errorCode 4/5 на Android
    try {
      if (this.localVideoTrack.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = false;
      }
      this.localVideoTrack.mute().catch(() => {});
    } catch {}
    try { this.localVideoTrack.stop(); } catch {}
    this.localVideoTrack = null;
  }

  /**
   * Creates a new local video track with current camSide without changing room state.
   * Used by restartLocalCamera (flip) to support replaceTrack flow (same as Random Chat).
   */
  private async createFreshLocalVideoTrack(context: string): Promise<LocalVideoTrack> {
    const facingMode = this.camSide === 'front' ? 'user' : 'environment';
    const preferred = getPreferredVideoCaptureOptions(facingMode);
    logger.info('[VideoCallSession] Creating fresh local video track', { context, preferred: preferred.meta, camSide: this.camSide });

    const tryCreate = async (opts: any) => createLocalTracks(opts);
    let tracks: LocalTrack[] = [];
    try {
      tracks = await tryCreate({ audio: false, video: preferred.primary });
    } catch (e1) {
      try {
        tracks = await tryCreate({ audio: false, video: preferred.fallback || preferred.primary });
      } catch (e2) {
        logger.warn('[VideoCallSession] Video-only createLocalTracks failed; falling back to audio+video create', {
          context,
          preferred: preferred.meta,
          e1: (e1 as any)?.message || String(e1),
          e2: (e2 as any)?.message || String(e2),
        });
        try {
          tracks = await tryCreate({ audio: true, video: preferred.primary });
        } catch (e3) {
          tracks = await tryCreate({ audio: true, video: preferred.fallback || preferred.primary });
        }
      }
    }

    const newVideo = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
    if (!newVideo) {
      throw new Error('createLocalTracks(...) did not return a video track');
    }

    const createdAudio = tracks.find((t) => t.kind === Track.Kind.Audio) as LocalAudioTrack | undefined;
    if (createdAudio) {
      try {
        createdAudio.stop();
      } catch {}
    }

    try {
      if (newVideo.mediaStreamTrack) {
        newVideo.mediaStreamTrack.enabled = this.isCamOn;
        if (this.isCamOn) await newVideo.unmute().catch(() => {});
        else await newVideo.mute().catch(() => {});
      }
    } catch {}

    return newVideo;
  }

  /**
   * Updates local state with new video track and emits new localStream (new stream id for UI refresh).
   * Does not stop the old track; caller must stop it after replacePublishedVideoTrack.
   */
  private swapLocalVideoTrack(newVideoTrack: LocalVideoTrack): void {
    const prevTrackId = this.localVideoTrack?.mediaStreamTrack?.id;
    this.localVideoTrack = newVideoTrack;

    const stream = new MediaStream();
    try {
      const mt = this.localVideoTrack.mediaStreamTrack;
      if (mt) stream.addTrack(mt as any);
    } catch {}
    try {
      const at = this.localAudioTrack?.mediaStreamTrack;
      if (at) stream.addTrack(at as any);
    } catch {}
    this.localStream = stream;
    this.emit('localStream', stream);
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);

    logger.info('[VideoCallSession] Local video track swapped', {
      prevTrackId,
      newTrackId: newVideoTrack?.mediaStreamTrack?.id,
    });
  }

  /**
   * Replaces the published video track in place when replaceTrack is available (same as Random Chat).
   * Reduces renegotiation and avoids remote video disappearing on the other side during flip.
   */
  private async replacePublishedVideoTrack(
    newVideoTrack: LocalVideoTrack,
    oldVideoTrack: LocalVideoTrack | null,
  ): Promise<void> {
    if (!this.room || this.room.state !== 'connected' || !this.room.localParticipant) return;
    const publication = this.getLocalVideoPublication();
    try {
      if (publication?.replaceTrack) {
        await (publication as any).replaceTrack(newVideoTrack, true);
        logger.info('[VideoCallSession] Replaced published video track (replaceTrack)', {
          oldTrackId: oldVideoTrack?.sid || oldVideoTrack?.mediaStreamTrack?.id,
          newTrackId: newVideoTrack?.sid || newVideoTrack?.mediaStreamTrack?.id,
        });
      } else {
        await this.unpublishOtherLocalTracks('video', newVideoTrack);
        await this.room.localParticipant.publishTrack(newVideoTrack).catch((e) => {
          const errorMsg = e?.message || String(e || '');
          if (
            errorMsg.includes('already') ||
            errorMsg.includes('duplicate') ||
            errorMsg.includes('closed') ||
            errorMsg.includes('disconnected')
          ) {
            logger.debug('[VideoCallSession] Ignoring publish error (already/closed)', { error: errorMsg });
            return;
          }
          throw e;
        });
        logger.info('[VideoCallSession] Replaced published video track (unpublish+publish fallback)', {
          oldTrackId: oldVideoTrack?.sid || oldVideoTrack?.mediaStreamTrack?.id,
          newTrackId: newVideoTrack?.sid || newVideoTrack?.mediaStreamTrack?.id,
        });
      }
      if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
        await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
        await this.room.localParticipant.publishTrack(this.localAudioTrack).catch(() => {});
      }
    } catch (e) {
      logger.warn('[VideoCallSession] Failed to replace/publish video track', e);
      throw e;
    }
  }

  private async recreateLocalVideoTrack(context: string): Promise<void> {
    // IMPORTANT: Do not touch localAudioTrack here. Recreating audio during camera recovery
    // is a common root cause of one-way / unstable audio on Android.
    const savedCamState = this.isCamOn;

    const facingMode = this.camSide === 'front' ? 'user' : 'environment';
    const preferred = getPreferredVideoCaptureOptions(facingMode);
    logger.info('[VideoCallSession] Recreating local video track', { context, preferred: preferred.meta, camSide: this.camSide });

    const oldVideoTrack = this.localVideoTrack;
    const oldVideoMedia = oldVideoTrack?.mediaStreamTrack;

    // Best-effort: unpublish the old camera track before stopping it.
    // This helps some Android devices release Camera2 resources faster and reduces "too many open camera devices".
    try {
      if (this.room && this.room.state === 'connected' && this.room.localParticipant && oldVideoTrack) {
        try {
          await this.room.localParticipant.unpublishTrack(oldVideoTrack, false);
        } catch {}
      }
    } catch {}

    this.stopLocalVideoTrackWithoutStateReset();

    // Android Camera2: allow device to fully release camera before reopening.
    if (Platform.OS === 'android') {
      await new Promise((r) => setTimeout(r, 220));
    }

    const tryCreate = async (opts: any) => createLocalTracks(opts);
    let tracks: LocalTrack[] = [];
    try {
      // Preferred path: create video only (no audio churn).
      tracks = await tryCreate({ audio: false, video: preferred.primary });
    } catch (e1) {
      try {
        tracks = await tryCreate({ audio: false, video: preferred.fallback || preferred.primary });
      } catch (e2) {
        // Some livekit-client builds are picky about `audio: false`. Fallback to creating audio+video,
        // then immediately stop the extra audio track to avoid grabbing the microphone twice.
        logger.warn('[VideoCallSession] Video-only createLocalTracks failed; falling back to audio+video create', {
          context,
          preferred: preferred.meta,
          e1: (e1 as any)?.message || String(e1),
          e2: (e2 as any)?.message || String(e2),
        });
        try {
          tracks = await tryCreate({ audio: true, video: preferred.primary });
        } catch (e3) {
          tracks = await tryCreate({ audio: true, video: preferred.fallback || preferred.primary });
        }
      }
    }

    const newVideo = tracks.find((t) => t.kind === Track.Kind.Video) as LocalVideoTrack | undefined;
    if (!newVideo) {
      throw new Error('createLocalTracks(...) did not return a video track');
    }
    this.localVideoTrack = newVideo;

    // If fallback created an audio track, stop it unless we don't have our own audio yet.
    try {
      const createdAudio = tracks.find((t) => t.kind === Track.Kind.Audio) as LocalAudioTrack | undefined;
      if (createdAudio) {
        if (!this.localAudioTrack) {
          this.localAudioTrack = createdAudio;
          try {
            this.isMicOn ? this.localAudioTrack.unmute() : this.localAudioTrack.mute();
          } catch {}
        } else {
          try { createdAudio.stop(); } catch {}
        }
      }
    } catch {}

    // Apply saved camera state immediately.
    try {
      if (this.localVideoTrack?.mediaStreamTrack) {
        this.localVideoTrack.mediaStreamTrack.enabled = savedCamState;
        if (savedCamState) await this.localVideoTrack.unmute().catch(() => {});
        else await this.localVideoTrack.mute().catch(() => {});
      }
    } catch {}

    // Создаём новый MediaStream с новым видео-треком и тем же аудио-треком.
    // Важно: новая ссылка и новый stream.id, чтобы UI (VideoCall) увидел изменение
    // (prevStream.id !== stream.id) и обновил localRenderKey — иначе превью не перерисуется при перевороте камеры.
    const stream = new MediaStream();
    try {
      const mt = this.localVideoTrack.mediaStreamTrack;
      if (mt) stream.addTrack(mt as any);
    } catch {}
    try {
      const at = this.localAudioTrack?.mediaStreamTrack;
      if (at) stream.addTrack(at as any);
    } catch {}
    this.localStream = stream;
    this.emit('localStream', stream);
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
  }

  private stopLocalTracksWithoutStateReset(): void {
    this.stopMicLevelMonitoring();
    if (this.localAudioTrack) {
      try {
        this.localAudioTrack.stop();
      } catch {}
      this.localAudioTrack = null;
    }
    if (this.localVideoTrack) {
      // КРИТИЧНО: Сначала отключаем захват кадров, затем stop() — снижает CameraDeviceClient errorCode 4/5 на Android
      try {
        if (this.localVideoTrack.mediaStreamTrack) {
          this.localVideoTrack.mediaStreamTrack.enabled = false;
        }
        this.localVideoTrack.mute().catch(() => {});
      } catch {}
      try {
        this.localVideoTrack.stop();
      } catch {}
      this.localVideoTrack = null;
    }
    this.localStream = null;
    // НЕ сбрасываем isCamOn/isMicOn и не вызываем callbacks
  }

  private stopLocalTracks(): void {
    this.stopMicLevelMonitoring();
    this.stopLocalTracksWithoutStateReset();
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

  /* ========= Mic monitoring implementation (copied from RandomChatSession) ========= */
  private startMicLevelMonitoring(stream: MediaStream): void {
    if (this.isMicMonitoringActive) {
      this.stopMicLevelMonitoring();
    }
    this.isMicMonitoringActive = true;

    const logLevel = this.micMonitorLogCount < 2 ? 'info' : 'debug';
    this.micMonitorLogCount += 1;
    logger[logLevel]('[VideoCallSession] Starting mic level monitoring', {
      id: stream?.id,
      active: (stream as any)?.active,
      audioTracks: stream?.getAudioTracks?.()?.length || 0,
      bars: this.micBarsCount,
    });

    this.lastAudioEnergy = 0;
    this.lastAudioDuration = 0;

    const barsCount = this.micBarsCount;

    // iOS Simulator: native PCM/FFT часто ломает аудио устройство симулятора.
    if (Platform.OS === 'ios' && !Device.isDevice) {
      this.startMicLevelMonitoringStatsFallback(barsCount);
      return;
    }

    // КРИТИЧНО: НЕ используем react-native-audio-record в видеозвонке.
    // Он делает отдельный захват микрофона (AudioRecord) и на части устройств приводит к "тишине"
    // в WebRTC/LiveKit (микрофон занят вторым рекордером).
    // Безопасный вариант — получать уровень из статистики LiveKit.
    this.startMicLevelMonitoringStatsFallback(barsCount);
  }

  private stopMicLevelMonitoring(): void {
    if (!this.isMicMonitoringActive) return;
    this.isMicMonitoringActive = false;

    if (this.micLevelInterval) {
      clearInterval(this.micLevelInterval);
      this.micLevelInterval = null;
    }

    this.cleanupAudioRecorder();
    this.audioRecordBuffer = [];
    this.lastFrequencyLevels = [];
    this.lastMicLevel = 0;

    const emptyLevels = new Array(this.micBarsCount).fill(0);
    this.config.callbacks.onMicLevelChange?.(0);
    this.config.onMicLevelChange?.(0);
    this.config.callbacks.onMicFrequencyLevelsChange?.(emptyLevels);
    this.config.onMicFrequencyLevelsChange?.(emptyLevels);

    // PiP overlay: сбрасываем эквалайзер, если PiP активен
    try {
      const pipVisible = (global as any).__pipVisibleRef?.current;
      const pipUpdate = (global as any).__pipUpdateStateRef?.current;
      if (pipVisible && typeof pipUpdate === 'function') {
        pipUpdate({ micLevel: 0, micFrequencyLevels: emptyLevels });
      }
    } catch {}
  }

  private cleanupAudioRecorder(): void {
    if (this.audioRecordSubscription) {
      try {
        this.audioRecordSubscription.remove();
      } catch (e) {
        logger.debug('[VideoCallSession] Error removing audio subscription:', e);
      }
      this.audioRecordSubscription = null;
    }
    try {
      AudioRecord.stop();
    } catch (e) {
      logger.debug('[VideoCallSession] Error stopping AudioRecord:', e);
    }
    try {
      if (typeof (AudioRecord as any).removeAllListeners === 'function') {
        (AudioRecord as any).removeAllListeners('data');
      }
    } catch (e) {
      logger.debug('[VideoCallSession] Error removing AudioRecord listeners:', e);
    }
  }

  private startMicLevelMonitoringNativeFFT(barsCount: number): boolean {
    if (!this.isMicMonitoringActive) return false;

    const fftSize = 512;
    const sampleRate = 16000;

    this.cleanupAudioRecorder();
    this.audioRecordBuffer = [];

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
      return true;
    } catch (e) {
      logger.warn('[VideoCallSession] Failed to start native FFT monitoring:', e);
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
          this.audioRecordBuffer.push(samples[i] / 32768);
        }

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
        logger.debug('[VideoCallSession] Failed to process mic chunk', e);
      }
    };
  }

  private startMicLevelMonitoringStatsFallback(barsCount: number): void {
    this.micLevelInterval = setInterval(async () => {
      if (!this.isMicOn || !this.room || this.room.state !== 'connected') {
        const emptyLevels = new Array(barsCount).fill(0);
        this.emitMicLevels(0, emptyLevels);
        return;
      }

      let audioLevel = 0;

      try {
        const rawStats = await (this.room.localParticipant as any)?.getTrackStats?.();
        const statsList: any[] = Array.isArray(rawStats)
          ? rawStats
          : rawStats && typeof rawStats === 'object'
            ? Object.values(rawStats as any)
            : [];

        if (statsList.length) {
          for (const stat of statsList) {
            const kind = (stat as any)?.kind ?? (stat as any)?.trackKind ?? (stat as any)?.mediaType;
            const isAudio = kind === 'audio' || kind === Track.Kind.Audio || (stat as any)?.type === 'audio';

            if (isAudio && this.localAudioTrack) {
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
                if (level <= 1) audioLevel = level;
                else if (level <= 127) audioLevel = Math.min(1, level / 127);
                else audioLevel = Math.min(1, level / 255);
                break;
              }
            }
          }
        }
        if (audioLevel <= 0) {
          const lpAny = this.room.localParticipant as any;
          const pLevel = lpAny?.audioLevel;
          if (typeof pLevel === 'number' && pLevel > 0) {
            audioLevel = Math.min(1, pLevel);
          }
        }
      } catch (e) {
        logger.debug('[VideoCallSession] Could not get track stats', e);
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

    // КРИТИЧНО: PiP overlay должен обновляться даже если экран VideoCall размонтирован.
    // Для этого используем глобальную ссылку на updatePiPState из PiPProvider.
    try {
      const pipVisible = (global as any).__pipVisibleRef?.current;
      const pipUpdate = (global as any).__pipUpdateStateRef?.current;
      if (pipVisible && typeof pipUpdate === 'function') {
        pipUpdate({ micLevel: audioLevel, micFrequencyLevels: frequencyLevels });
      }
    } catch {}
  }

  private generateFrequencyFromLevel(audioLevel: number, barsCount: number): number[] {
    this.ensureEqSeeds(barsCount);
    const base = Math.min(1, audioLevel * 1.25);
    const flux = Math.min(1, Math.abs(base - this.lastMicLevel) * 3.2);
    // "Яркость" (псевдо-центроид): быстрее меняется речь → выше "частоты"
    const targetCentroid = Math.max(0.12, Math.min(0.88, 0.28 + 0.42 * flux + 0.10 * Math.sin(this.eqPhase * 0.18)));
    // используем lastAudioEnergy/Duration как память — без новых полей
    this.lastAudioEnergy = this.lastAudioEnergy + (targetCentroid - this.lastAudioEnergy) * 0.18;
    const centroid = this.lastAudioEnergy;

    const levels: number[] = [];
    for (let i = 0; i < barsCount; i++) {
      const x = barsCount > 1 ? i / (barsCount - 1) : 0.5;
      const seed = this.eqBarSeeds[i] ?? 0.8;
      const dist = (x - centroid) / 0.22;
      const bell = Math.exp(-0.5 * dist * dist); // 0..1
      const shimmer = 0.10 * Math.sin(this.eqPhase + i * 0.85 + seed * 3.1);
      const texture = (0.55 + 0.45 * seed) * (0.35 + 0.65 * bell);
      const level = Math.min(1, Math.max(0, base * texture + base * flux * 0.25 * bell + shimmer * base));
      levels.push(level);
    }
    this.eqPhase += 0.22 + 0.26 * flux;
    return this.smoothFrequencyLevels(levels, barsCount);
  }

  private ensureEqSeeds(barsCount: number): void {
    if (this.eqBarSeeds.length === barsCount) return;
    this.eqBarSeeds = Array.from({ length: barsCount }, (_v, i) => {
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
      if (mag > maxMag) maxMag = mag;
    }

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
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
      let m = n >> 1;
      while (j >= m && m >= 2) {
        j -= m;
        m >>= 1;
      }
      j += m;
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
    const nyquist = sampleRate / 2;
    const levels: number[] = [];
    const safeMax = maxMagnitude || 1e-9;

    const minHz = 60;
    const maxHz = Math.max(minHz + 1, Math.min(nyquist, 8000));

    for (let i = 0; i < barsCount; i++) {
      const t0 = i / barsCount;
      const t1 = (i + 1) / barsCount;

      const startFreq = minHz * Math.pow(maxHz / minHz, t0);
      const endFreq = minHz * Math.pow(maxHz / minHz, t1);

      const startIndex = Math.max(1, Math.floor((startFreq / nyquist) * magnitudes.length));
      const endIndex = Math.min(
        magnitudes.length,
        Math.max(startIndex + 1, Math.ceil((endFreq / nyquist) * magnitudes.length)),
      );

      let sumSq = 0;
      for (let j = startIndex; j < endIndex; j++) {
        const m = magnitudes[j];
        sumSq += m * m;
      }
      const rms = Math.sqrt(sumSq / (endIndex - startIndex || 1));

      const norm = Math.log1p(rms) / Math.log1p(safeMax);
      const level = Math.min(1, Math.max(0, Math.pow(norm, 0.85)));
      levels.push(level);
    }

    return this.smoothFrequencyLevels(levels, barsCount);
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
      logger.debug('[VideoCallSession] Error checking video track publication', e);
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
      logger.debug('[VideoCallSession] Error checking audio track publication', e);
    }
    
    return false;
  }

  /**
   * Returns the current local video publication (first camera track) for replaceTrack flow.
   * Same logic as RandomChatSession.getLocalVideoPublication.
   */
  private getLocalVideoPublication(): { replaceTrack?: (track: LocalVideoTrack, stopProcessor?: boolean) => Promise<void>; track?: LocalVideoTrack } | null {
    if (!this.room || !this.room.localParticipant) return null;
    const publications = this.room.localParticipant.videoTrackPublications;
    if (!publications) return null;
    try {
      if (typeof (publications as any).values === 'function') {
        for (const pub of (publications as any).values()) {
          return pub || null;
        }
      } else if (Array.isArray(publications)) {
        return (publications as any)[0] || null;
      } else if (typeof publications === 'object') {
        const vals = Object.values(publications as any);
        return (vals?.[0] as any) || null;
      }
    } catch {}
    return null;
  }

  private resetRemoteState(): void {
    this.clearPendingRemoteDisconnectTimer();
    this.clearRemoteCamOffTimeout();
    this.remoteStream = null;
    this.remoteAudioTrack = null;
    this.remoteVideoTrack = null;
    this.lastUnsubscribedRemoteVideoTrackSid = null;
    this.currentRemoteParticipant = null;
    this.remoteCamEnabled = false;
    if (this.partnerInPiP) {
      this.partnerInPiP = false;
      this.emit('partnerPiPStateChanged', { inPiP: false });
    }
    this.emit('remoteStream', null);
    this.config.callbacks.onRemoteStreamChange?.(null);
    this.config.onRemoteStreamChange?.(null);
    try {
      const pipUpdate = (global as any).__pipUpdateStateRef?.current;
      if (typeof pipUpdate === 'function') pipUpdate({ remoteStream: null });
    } catch (_) {}
    this.config.callbacks.onRemoteCamStateChange?.(false);
    this.config.onRemoteCamStateChange?.(false);
    this.remoteAudioMuted = false;
    this.emit('remoteState', { muted: false });
    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }

  private async connectToLiveKit(url: string, token: string, connectRequestId: number, targetRoomName?: string): Promise<boolean> {
    // КРИТИЧНО: Если звонок уже завершён (call:ended), не подключаться — избегаем "подключения к пустой комнате"
    if (this.ended) {
      logger.info('[VideoCallSession] ⏭️ Skipping connectToLiveKit: call already ended');
      return false;
    }
    // КРИТИЧНО: Защита от множественных одновременных вызовов connectToLiveKit
    // Если уже идет подключение к той же комнате, ждем его завершения
    if (this.connectingPromise && targetRoomName) {
      logger.info('[VideoCallSession] Connection already in progress, waiting for existing connection', {
        targetRoomName,
        currentRoomName: this.currentRoomName,
      });
      try {
        const result = await this.connectingPromise;
        // Если существующее подключение успешно и к той же комнате, возвращаем успех
        if (result && this.currentRoomName === targetRoomName) {
          logger.info('[VideoCallSession] Existing connection completed successfully', {
            roomName: this.currentRoomName,
          });
          return true;
        }
      } catch (e) {
        logger.warn('[VideoCallSession] Existing connection failed, will retry', e);
      }
    }
    
    // КРИТИЧНО: Проверяем, можно ли переиспользовать существующую комнату
    // Если комната уже подключена к той же комнате LiveKit, не переподключаемся
    if (this.room && 
        this.room.state === 'connected' && 
        this.currentRoomName && 
        targetRoomName && 
        this.currentRoomName === targetRoomName) {
      logger.debug('[VideoCallSession] Room already connected to target room, reusing', {
        roomName: targetRoomName,
        roomState: this.room.state,
      });
      return true;
    }
    
    // КРИТИЧНО: Если комната в состоянии "connecting", ждем завершения подключения
    // Не прерываем процесс подключения
    if (this.room && this.room.state === 'connecting') {
      logger.info('[VideoCallSession] Room is connecting, waiting for connection to complete', {
        currentRoomName: this.currentRoomName,
        targetRoomName: targetRoomName,
      });
      
      // Если есть активный промис подключения, ждем его завершения
      if (this.connectingPromise) {
        try {
          const result = await this.connectingPromise;
          // После ожидания проверяем результат
          const currentRoom = this.room;
          if (currentRoom && currentRoom.state === 'connected' && 
              this.currentRoomName && 
              targetRoomName && 
              this.currentRoomName === targetRoomName) {
            logger.info('[VideoCallSession] Room connected successfully after waiting for connectingPromise', {
              roomName: this.currentRoomName,
            });
            return result;
          }
        } catch (e) {
          logger.warn('[VideoCallSession] Connecting promise failed, will retry', e);
        }
      }
      
      // Дополнительное ожидание на случай, если промис еще не создан
      let waitCount = 0;
      while (this.room && this.room.state === 'connecting' && waitCount < 100) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      
      // После ожидания проверяем результат
      const currentRoomAfterWait = this.room;
      if (currentRoomAfterWait && currentRoomAfterWait.state === 'connected' && 
          this.currentRoomName && 
          targetRoomName && 
          this.currentRoomName === targetRoomName) {
        logger.info('[VideoCallSession] Room connected successfully after waiting', {
          roomName: this.currentRoomName,
        });
        return true;
      }
      
      // Если подключение не завершилось успешно или к другой комнате, продолжаем
      const currentRoomStillConnecting = this.room;
      if (currentRoomStillConnecting && currentRoomStillConnecting.state === 'connecting') {
        logger.warn('[VideoCallSession] Room still connecting after timeout, will force clear');
      }
    }
    
    // КРИТИЧНО: Отключаем предыдущую комнату перед подключением к новой
    // disconnectRoom теперь ждет полного отключения (включая очистку ping/pong handlers)
    // Но только если комната подключена к другой комнате или не подключена
    // КРИТИЧНО: НЕ отключаем комнату если она в состоянии "connecting" - ждем завершения
    if (this.room && 
        this.room.state !== 'connecting' &&
        (this.room.state !== 'disconnected' || 
         !this.currentRoomName || 
         !targetRoomName || 
         this.currentRoomName !== targetRoomName)) {
      // КРИТИЧНО: Ждем полного отключения комнаты перед продолжением
      await this.disconnectRoom('user');
    }
    
    // КРИТИЧНО: Проверяем, что комната действительно отключена и очищена
    // disconnectRoom() устанавливает this.room = null в промис-колбэке, поэтому нужно подождать
    if (this.isDisconnecting || this.room !== null) {
      logger.debug('[VideoCallSession] Room still disconnecting or not cleared, waiting for disconnect promise...');
      
      // Если есть активный промис отключения, ждем его завершения
      if (this.disconnectPromise) {
        try {
          await this.disconnectPromise;
          logger.debug('[VideoCallSession] Disconnect promise resolved');
        } catch (e) {
          logger.warn('[VideoCallSession] Disconnect promise rejected', e);
        }
      }
      
      // Дополнительное ожидание на случай, если промис разрешился, но this.room еще не очищен
      let waitCount = 0;
      while ((this.isDisconnecting || this.room !== null) && waitCount < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        waitCount++;
      }
      
      if (this.isDisconnecting || this.room !== null) {
        logger.warn('[VideoCallSession] Room still not cleared after waiting, forcing cleanup', {
          isDisconnecting: this.isDisconnecting,
          hasRoom: this.room !== null,
          roomState: this.room?.state,
          hasDisconnectPromise: !!this.disconnectPromise
        });
        
        // Принудительная очистка застрявшей комнаты (disconnect только если комната уже connected)
        try {
          if (this.room) {
            this.room.removeAllListeners();
            if (this.room.state === 'connected') {
              try { this.room.disconnect(); } catch {}
            }
          }
        } catch {}
        this.room = null;
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        this.currentRoomName = null;
        
        logger.info('[VideoCallSession] Forced cleanup completed, continuing with connection');
      }
    }
    
    if (!this.localVideoTrack || !this.localAudioTrack) {
      await this.ensureLocalTracks();
    }
    
    // КРИТИЧНО: Проверяем еще раз перед созданием новой комнаты
    // Это защита от race conditions
    // Но если комната уже подключена к нужной комнате, не создаем новую
    const existingRoom: Room | null = this.room;
    if (existingRoom) {
      // @ts-ignore - TypeScript неправильно сужает тип после проверки состояния
      const existingRoomState: string = existingRoom.state as string;
      
      if (existingRoomState === 'connected' && 
          this.currentRoomName && 
          targetRoomName && 
          this.currentRoomName === targetRoomName) {
        logger.debug('[VideoCallSession] Room already connected to target, skipping creation');
        return true;
      }
      
      // КРИТИЧНО: Если комната в состоянии "connecting", ждем завершения подключения
      // Не прерываем процесс подключения принудительной очисткой
      if (existingRoomState === 'connecting') {
        logger.info('[VideoCallSession] Room is connecting, waiting for connection to complete', {
          currentRoomName: this.currentRoomName,
          targetRoomName: targetRoomName,
        });
        
        // Ждем завершения подключения (максимум 10 секунд)
        let waitCount = 0;
        while (waitCount < 100) {
          const currentRoomState: Room | null = this.room;
          if (!currentRoomState) {
            break;
          }
          // @ts-ignore - TypeScript неправильно сужает тип после проверки состояния
          if (currentRoomState.state !== 'connecting') {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
          waitCount++;
        }
        
        // После ожидания проверяем результат
        const roomAfterWait: Room | null = this.room;
        if (roomAfterWait) {
          // @ts-ignore - TypeScript неправильно сужает тип после проверки состояния
          const roomAfterWaitState: string = roomAfterWait.state as string;
          if (roomAfterWaitState === 'connected' && 
              this.currentRoomName && 
              targetRoomName && 
              this.currentRoomName === targetRoomName) {
            logger.info('[VideoCallSession] Room connected successfully after waiting', {
              roomName: this.currentRoomName,
            });
            return true;
          }
          
          // Если подключение не завершилось успешно, очищаем
          if (roomAfterWaitState === 'connecting') {
            logger.warn('[VideoCallSession] Room still connecting after timeout, force clearing');
          }
        }
      }
      
      logger.warn('[VideoCallSession] Room still exists before creating new one, force clearing', {
        roomState: existingRoomState,
        currentRoomName: this.currentRoomName,
        targetRoomName: targetRoomName,
        isDisconnecting: this.isDisconnecting
      });
      // КРИТИЧНО: Принудительно очищаем комнату если она в неправильном состоянии
      // Это защита от зависших состояний
      try {
        const stuckRoom: Room | null = this.room;
        if (stuckRoom) {
          // @ts-ignore - TypeScript неправильно сужает тип после проверки состояния
          const stuckRoomState: string = stuckRoom.state as string;
          if (stuckRoomState !== 'disconnected') {
            // @ts-ignore - TypeScript неправильно сужает тип после проверки состояния
            await stuckRoom.disconnect().catch(() => {});
          }
        }
        this.room = null;
        this.currentRoomName = null;
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        logger.warn('[VideoCallSession] Force cleared stuck room, will retry connection');
        // КРИТИЧНО: После очистки продолжаем создание новой комнаты вместо возврата false
        // Это позволяет восстановиться из зависшего состояния
      } catch (e) {
        logger.warn('[VideoCallSession] Error force clearing room', e);
        // Даже при ошибке очистки продолжаем попытку подключения
        this.room = null;
        this.currentRoomName = null;
        this.isDisconnecting = false;
        this.disconnectPromise = null;
      }
    }
    
    // КРИТИЧНО: Создаем промис подключения для защиты от множественных вызовов
    const connectionPromise = (async (): Promise<boolean> => {
      // ICE/TURN: используем креды с /api/turn-credentials для стабильности на мобильной сети/VPN
      let rtcConfig: RTCConfiguration | undefined = undefined;
      try {
        rtcConfig = await getIceConfiguration(false);
      } catch (e: any) {
        logger.warn('[VideoCallSession] Failed to load ICE config, using LiveKit defaults', {
          error: e?.message || String(e),
        });
      }

      // Publish defaults:
      // - Start reasonably high on capable devices (720p capture is handled separately),
      // - Allow network-based adaptation via simulcast layers.
      // We keep adaptiveStream/dynacast disabled because this project previously had
      // stability issues with "unknown track" quality updates.
      const facingMode = this.camSide === 'front' ? 'user' : 'environment';
      const capture = getPreferredVideoCaptureOptions(facingMode);
      const isHighCapture = capture?.meta?.preset === 'high';

      // IMPORTANT: livekit-client expects VideoPreset objects here (not width/height literals).
      // Keep it minimal (1 additional layer) to avoid overloading mobile devices.
      const simulcast = !!isHighCapture;
      const videoSimulcastLayers = simulcast ? [VideoPresets.h180] : undefined;

      logger.info('[VideoCallSession] LiveKit feature flags', {
        adaptiveStream: LIVEKIT_ADAPTIVE_STREAM_ENABLED,
        dynacast: LIVEKIT_DYNACAST_ENABLED,
      });

      const room = new Room({
        adaptiveStream: LIVEKIT_ADAPTIVE_STREAM_ENABLED,
        dynacast: LIVEKIT_DYNACAST_ENABLED,
        ...(rtcConfig ? { rtcConfig } : {}),
        publishDefaults: {
          // Allow higher ceiling on high-capture devices; WebRTC congestion control will still scale down.
          videoEncoding: { maxBitrate: isHighCapture ? 2_500_000 : 1_200_000, maxFramerate: 30 },
          simulcast,
          ...(videoSimulcastLayers ? { videoSimulcastLayers } : {}),
        },
      });
      this.room = room;
      const partnerDisplayName = this.config.getPartnerDisplayName?.() ?? null;
      setActiveVideoCall(true, partnerDisplayName || undefined);
      this.registerRoomEvents(room);

      try {
        // КРИТИЧНО: Новая комната всегда в состоянии 'disconnected' до connect()
        // Проверяем состояние только после попытки подключения
        logger.info('[VideoCallSession] Attempting to connect to LiveKit', {
          url,
          urlHost: url ? new URL(url).hostname : 'unknown',
          tokenLength: token?.length || 0,
          tokenPrefix: token ? token.substring(0, 20) + '...' : 'no-token',
          targetRoomName,
          roomState: room.state,
        });
        
        // Увеличиваем peerConnectionTimeout: при одновременном подключении обоих участников
        // переговоры (negotiation) могут не уложиться в 15s → "negotiation timed out" и повторная попытка.
        await room.connect(url, token, {
          autoSubscribe: true,
          peerConnectionTimeout: 30_000,
        });
      
        // КРИТИЧНО: Проверяем состояние после подключения
        if (room.state !== 'connected') {
          logger.warn('[VideoCallSession] Room not connected after connect call', { 
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
        
        // КРИТИЧНО: Логируем детальную информацию о подключении
        const localIdentity = room.localParticipant?.identity;
        const remoteParticipantsList = Array.from(room.remoteParticipants.values()).map(p => ({
          identity: p.identity,
          audioTracks: p.audioTrackPublications.size,
          videoTracks: p.videoTrackPublications.size,
        }));
        
        logger.info('[VideoCallSession] Successfully connected to LiveKit', {
          roomName: room.name,
          state: room.state,
          targetRoomName,
          localIdentity,
          participantsCount: room.remoteParticipants.size,
          remoteParticipants: remoteParticipantsList,
          myUserId: this.config.myUserId,
          partnerUserId: this.partnerUserId,
        });
      
      // Сохраняем имя подключенной комнаты для проверки переиспользования
      this.currentRoomName = room.name || targetRoomName || null;
      
      // КРИТИЧНО: Логируем детальную информацию о состоянии комнаты
      const roomLocalIdentity = room.localParticipant?.identity;
      const roomRemoteParticipantsList = Array.from(room.remoteParticipants.values()).map(p => ({
        identity: p.identity,
        audioTracks: p.audioTrackPublications.size,
        videoTracks: p.videoTrackPublications.size,
      }));
      
      logger.info('[VideoCallSession] Room connected successfully', {
        roomName: this.currentRoomName,
        roomState: room.state,
        participantsCount: room.remoteParticipants.size,
        localParticipant: !!room.localParticipant,
        localParticipantIdentity: roomLocalIdentity,
        remoteParticipants: roomRemoteParticipantsList,
        myUserId: this.config.myUserId,
        partnerUserId: this.partnerUserId,
        expectedPartnerIdentity: this.partnerUserId,
      });

      // Аудио-роутинг управляется на уровне UI (useAudioRouting) — без агрессивных "пинков" из сессии.
      
      // КРИТИЧНО: Функция для подписки на все треки участника
      const subscribeToParticipantTracks = (participant: RemoteParticipant, context: string) => {
        logger.info(`[VideoCallSession] ${context} - subscribing to participant tracks`, {
          participantId: participant.identity,
          audioTracks: participant.audioTrackPublications.size,
          videoTracks: participant.videoTrackPublications.size,
        });
        
        // Подписываемся на все аудио треки
        participant.audioTrackPublications.forEach((publication) => {
          // КРИТИЧНО: Всегда подписываемся явно, даже если уже подписаны
          // Это гарантирует, что событие TrackSubscribed будет отправлено
          // КРИТИЧНО: Если трек уже подписан, но не загружен - принудительно переподписываемся
          // Это может помочь получить событие TrackSubscribed
          const wasSubscribed = publication.isSubscribed;
          const hadTrack = !!publication.track;
          
          if (!publication.isSubscribed || !publication.track) {
            publication.setSubscribed(true);
            logger.info(`[VideoCallSession] ${context} - subscribed to audio track`, {
              trackSid: publication.trackSid,
              wasSubscribed,
              hasTrack: hadTrack,
              isSubscribedAfter: publication.isSubscribed,
            });
          } else {
            logger.info(`[VideoCallSession] ${context} - audio track already subscribed and loaded`, {
              trackSid: publication.trackSid,
            });
          }
          
          // КРИТИЧНО: Если трек уже загружен - обрабатываем сразу
          // Это важно при принятии звонка, когда инициатор уже подключен и опубликовал треки
          if (publication.track) {
            logger.info(`[VideoCallSession] ${context} - processing existing audio track immediately`, {
              trackSid: publication.trackSid,
              isSubscribed: publication.isSubscribed,
              trackReady: publication.track.mediaStreamTrack?.readyState,
            });
            this.handleTrackSubscribed(publication.track, publication, participant);
          } else {
            // КРИТИЧНО: Если трек не загружен, но подписка выполнена - ждем немного и проверяем снова
            // Это решает проблему, когда трек загружается асинхронно после setSubscribed
            setTimeout(() => {
              if (publication.track && this.room === room && room.state === 'connected') {
                logger.info(`[VideoCallSession] ${context} - audio track loaded after subscription`, {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.debug(`[VideoCallSession] ${context} - audio track still not loaded after subscription`, {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                  hasTrack: !!publication.track,
                });
              }
            }, 100);
            
            logger.debug(`[VideoCallSession] ${context} - audio track not loaded yet, waiting for TrackSubscribed event or delayed check`, {
              trackSid: publication.trackSid,
              isSubscribed: publication.isSubscribed,
            });
          }
        });
        
        // Подписываемся на все видео треки
        participant.videoTrackPublications.forEach((publication) => {
          // КРИТИЧНО: Всегда подписываемся явно, даже если уже подписаны
          // Это гарантирует, что событие TrackSubscribed будет отправлено
          // КРИТИЧНО: Если трек уже подписан, но не загружен - принудительно переподписываемся
          // Это может помочь получить событие TrackSubscribed
          const wasSubscribed = publication.isSubscribed;
          const hadTrack = !!publication.track;
          
          if (!publication.isSubscribed || !publication.track) {
            publication.setSubscribed(true);
            logger.info(`[VideoCallSession] ${context} - subscribed to video track`, {
              trackSid: publication.trackSid,
              wasSubscribed,
              hasTrack: hadTrack,
              isSubscribedAfter: publication.isSubscribed,
            });
          } else {
            logger.info(`[VideoCallSession] ${context} - video track already subscribed and loaded`, {
              trackSid: publication.trackSid,
            });
          }
          
          // КРИТИЧНО: Если трек уже загружен - обрабатываем сразу
          // Это важно при принятии звонка, когда инициатор уже подключен и опубликовал треки
          if (publication.track) {
            logger.info(`[VideoCallSession] ${context} - processing existing video track immediately`, {
              trackSid: publication.trackSid,
              isSubscribed: publication.isSubscribed,
              trackReady: publication.track.mediaStreamTrack?.readyState,
            });
            this.handleTrackSubscribed(publication.track, publication, participant);
          } else {
            // КРИТИЧНО: Если трек не загружен, но подписка выполнена - ждем немного и проверяем снова
            // Это решает проблему, когда трек загружается асинхронно после setSubscribed
            setTimeout(() => {
              if (publication.track && this.room === room && room.state === 'connected') {
                logger.info(`[VideoCallSession] ${context} - video track loaded after subscription`, {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.debug(`[VideoCallSession] ${context} - video track still not loaded after subscription`, {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                  hasTrack: !!publication.track,
                });
              }
            }, 100);
            
            logger.debug(`[VideoCallSession] ${context} - video track not loaded yet, waiting for TrackSubscribed event or delayed check`, {
              trackSid: publication.trackSid,
              isSubscribed: publication.isSubscribed,
            });
          }
        });
      };
      
      // КРИТИЧНО: Проверяем существующих участников и их треки сразу после подключения
      // Это важно, если участник уже подключен и опубликовал треки до нашего подключения
      // Для звонка 1 на 1 достаточно проверить один раз при подключении
      // КРИТИЧНО: Обрабатываем участников СРАЗУ после подключения, не ждем события ParticipantConnected
      // Это особенно важно при принятии звонка, когда инициатор уже подключен
      if (room.remoteParticipants.size > 0) {
        logger.info('[VideoCallSession] Processing existing remote participants immediately after connect', {
          participantsCount: room.remoteParticipants.size,
        });
        room.remoteParticipants.forEach((participant) => {
          subscribeToParticipantTracks(participant, 'Found existing remote participant after connect');
        });
      } else {
        logger.info('[VideoCallSession] No remote participants yet, will wait for ParticipantConnected event');
      }
      
      // КРИТИЧНО: Повторная проверка через 500ms на случай если треки еще не были загружены
      // Это решает проблему когда событие TrackSubscribed не приходит или приходит с задержкой
      setTimeout(() => {
        if (this.room === room && room.state === 'connected') {
          logger.info('[VideoCallSession] First delayed check for tracks (500ms)', {
            participantsCount: room.remoteParticipants.size,
          });
          room.remoteParticipants.forEach((participant) => {
            // КРИТИЧНО: Подписываемся на все треки явно, даже если они уже подписаны
            // Это гарантирует, что треки будут обработаны
            participant.audioTrackPublications.forEach((publication) => {
              // Подписываемся явно если еще не подписаны
              if (!publication.isSubscribed) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] First delayed subscription to audio track', {
                  trackSid: publication.trackSid,
                });
              }
              // Обрабатываем трек если он загружен (не проверяем !this.remoteAudioTrack, обрабатываем всегда)
              if (publication.track) {
                logger.info('[VideoCallSession] First delayed processing of audio track', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.warn('[VideoCallSession] First delayed check - audio track still not loaded', {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                });
              }
            });
            participant.videoTrackPublications.forEach((publication) => {
              // Подписываемся явно если еще не подписаны
              if (!publication.isSubscribed) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] First delayed subscription to video track', {
                  trackSid: publication.trackSid,
                });
              }
              // Обрабатываем трек если он загружен (не проверяем !this.remoteVideoTrack, обрабатываем всегда)
              if (publication.track) {
                logger.info('[VideoCallSession] First delayed processing of video track', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.warn('[VideoCallSession] First delayed check - video track still not loaded', {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                });
              }
            });
          });
        }
      }, 500);
      
      // КРИТИЧНО: Дополнительная проверка через 1000ms для гарантированной обработки треков
      // Это особенно важно при принятии звонка, когда инициатор уже подключен
      setTimeout(() => {
        if (this.room === room && room.state === 'connected') {
          logger.info('[VideoCallSession] Second delayed check for tracks (1000ms)', {
            participantsCount: room.remoteParticipants.size,
          });
          room.remoteParticipants.forEach((participant) => {
            // Проверяем и обрабатываем все треки еще раз
            participant.audioTrackPublications.forEach((publication) => {
              if (!publication.isSubscribed) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] Second delayed subscription to audio track', {
                  trackSid: publication.trackSid,
                });
              }
              if (publication.track) {
                logger.info('[VideoCallSession] Second delayed processing of audio track', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.warn('[VideoCallSession] Second delayed check - audio track still not loaded', {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                });
              }
            });
            participant.videoTrackPublications.forEach((publication) => {
              if (!publication.isSubscribed) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] Second delayed subscription to video track', {
                  trackSid: publication.trackSid,
                });
              }
              if (publication.track) {
                logger.info('[VideoCallSession] Second delayed processing of video track', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                logger.warn('[VideoCallSession] Second delayed check - video track still not loaded', {
                  trackSid: publication.trackSid,
                  isSubscribed: publication.isSubscribed,
                });
              }
            });
          });
        }
      }, 1000);

      // Даём движку LiveKit время поднять транспорт перед публикацией (снижает "publication timed out" и "connection state mismatch").
      if (!this.ended && this.room === room) {
        await new Promise<void>(r => setTimeout(r, 350));
      }

      // КРИТИЧНО: Проверяем состояние комнаты перед публикацией треков
      // LiveKit автоматически управляет WebRTC соединениями, но нужно убедиться что комната подключена
      if (room.state !== 'connected' || !room.localParticipant) {
        logger.warn('[VideoCallSession] Room not connected or no local participant, skipping track publish', {
          state: room.state,
          hasLocalParticipant: !!room.localParticipant
        });
        // КРИТИЧНО: Уведомляем компонент о том, что микрофон и камера включены
        this.config.callbacks.onMicStateChange?.(true);
        this.config.onMicStateChange?.(true);
        this.config.callbacks.onCamStateChange?.(true);
        this.config.onCamStateChange?.(true);
        return true; // Возвращаем true, так как подключение успешно, просто треки не опубликованы
      }

      if (this.localVideoTrack) {
        // КРИТИЧНО: Дополнительная проверка состояния перед публикацией
        if (room.state !== 'connected' || !room.localParticipant) {
          logger.debug('[VideoCallSession] Room disconnected before video track publish, skipping');
        } else {
          // КРИТИЧНО: Проверяем, не опубликован ли трек уже
          if (this.isVideoTrackPublished(this.localVideoTrack)) {
            logger.debug('[VideoCallSession] Video track already published in connectToLiveKit, skipping', {
              trackId: this.localVideoTrack?.sid || this.localVideoTrack?.mediaStreamTrack?.id,
            });
          } else if (this.localVideoTrack) {
            await room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
              // Игнорируем ошибки дубликатов и закрытых соединений
              const errorMsg = e?.message || String(e || '');
              if (errorMsg.includes('already') || 
                  errorMsg.includes('duplicate') ||
                  errorMsg.includes('closed') || 
                  errorMsg.includes('disconnected')) {
                logger.debug('[VideoCallSession] Ignoring publish error (already/closed)', { error: errorMsg });
                return;
              }
              logger.warn('[VideoCallSession] Failed to publish video track', e);
            });
            logger.info('[VideoCallSession] Video track published', {
              trackId: this.localVideoTrack?.sid || this.localVideoTrack?.mediaStreamTrack?.id,
            });
          }
        }
      }
      if (this.localAudioTrack) {
        // КРИТИЧНО: Дополнительная проверка состояния перед публикацией
        if (room.state !== 'connected' || !room.localParticipant) {
          logger.debug('[VideoCallSession] Room disconnected before audio track publish, skipping');
        } else {
          // КРИТИЧНО: Проверяем, не опубликован ли трек уже
          if (this.isAudioTrackPublished(this.localAudioTrack)) {
            logger.debug('[VideoCallSession] Audio track already published in connectToLiveKit, skipping', {
              trackId: this.localAudioTrack?.sid || this.localAudioTrack?.mediaStreamTrack?.id,
            });
          } else if (this.localAudioTrack) {
            await room.localParticipant.publishTrack(this.localAudioTrack).catch((e) => {
              // Игнорируем ошибки дубликатов и закрытых соединений
              const errorMsg = e?.message || String(e || '');
              if (errorMsg.includes('already') || 
                  errorMsg.includes('duplicate') ||
                  errorMsg.includes('closed') || 
                  errorMsg.includes('disconnected')) {
                logger.debug('[VideoCallSession] Ignoring publish error (already/closed)', { error: errorMsg });
                return;
              }
              logger.warn('[VideoCallSession] Failed to publish audio track', e);
            });
            logger.info('[VideoCallSession] Audio track published', {
              trackId: this.localAudioTrack?.sid || this.localAudioTrack?.mediaStreamTrack?.id,
            });
          }
        }
      }

      // КРИТИЧНО: Уведомляем компонент о том, что микрофон и камера включены
      this.config.callbacks.onMicStateChange?.(true);
      this.config.onMicStateChange?.(true);
      this.config.callbacks.onCamStateChange?.(true);
      this.config.onCamStateChange?.(true);

      // КРИТИЧНО: После подключения к комнате на iOS может "останавливаться" нативный аудио-рекордер.
      // Перезапускаем мониторинг микрофона, чтобы эквалайзер продолжал работать как в RandomChat.
    // Эквалайзер отключен: мониторинг микрофона не перезапускаем
      // 🩺 Android 8.1 / OPPO: watchdog — если видео "залипло" (есть трек, но не идут кадры), пересоздаем автоматически.
      this.scheduleLocalVideoHealthCheck('connectToLiveKit:post-publish');
      return true;
    } catch (e: any) {
      const errorMessage = e?.message || String(e);
      const isInvalidApiKey = errorMessage.includes('invalid API key') || 
                               errorMessage.includes('401') ||
                               errorMessage.includes('Unauthorized');
      const isClientDisconnect = errorMessage.includes('Client initiated disconnect') || errorMessage.includes('user initiated disconnect');
      if (this.ended || isClientDisconnect) {
        logger.info('[VideoCallSession] Connect aborted (call ended or user disconnect)', {
          ended: this.ended,
          error: errorMessage,
        });
      } else {
        const isTransientPcError = /could not establish pc connection|pc connection|negotiation (disconnected|timed out)|transport error/i.test(errorMessage);
        const logFn = isTransientPcError ? logger.warn : logger.error;
        // Не логировать полный стек, если к моменту catch звонок уже завершён (например, retry после end с другой стороны)
        if (this.ended) {
          logger.debug('[VideoCallSession] Connect failed after call ended', { error: errorMessage });
        } else {
          logFn('[VideoCallSession] Error connecting to LiveKit', {
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
        }
      }
      
      // Если ошибка связана с API ключом, логируем дополнительную информацию
      if (isInvalidApiKey) {
        // This warning is often transient during reconnects/room switches; avoid surfacing it as a hard "Console Error" on iOS.
        if (!this.hasLoggedLiveKitApiKeyWarning) {
          this.hasLoggedLiveKitApiKeyWarning = true;
          logger.warn('[VideoCallSession] ⚠️ LiveKit API key validation failed!', {
            url,
            possibleCauses: [
              'API key/secret mismatch between backend and LiveKit server',
              'LiveKit URL points to wrong server',
              'Token expired or malformed',
              'Backend environment variables not set correctly'
            ],
            suggestion: 'Check LIVEKIT_API_KEY and LIVEKIT_API_SECRET in backend .env file match LiveKit server credentials'
          });
        } else {
          logger.debug('[VideoCallSession] LiveKit API key validation failed (suppressed повтор)', { url });
        }
      }
      
      if (this.room === room) {
        this.room = null;
        this.currentRoomName = null;
        setActiveVideoCall(false);
      }
      
      // КРИТИЧНО: Не считаем запрос "stale" если он для той же комнаты
      // Это позволяет обрабатывать быстрые повторные запросы на подключение к одной комнате
      const isStaleRequest = this.connectRequestId !== connectRequestId || this.room !== room;
      const isSameRoom = targetRoomName && 
                         this.currentRoomName === targetRoomName && 
                         this.room && 
                         this.room.state === 'connected';
      
      if (isStaleRequest && !isSameRoom) {
        logger.debug('[VideoCallSession] Request is stale and not for same room', {
          connectRequestId,
          currentConnectRequestId: this.connectRequestId,
          targetRoomName,
          currentRoomName: this.currentRoomName,
          roomState: this.room?.state,
        });
        return false;
      }
      
      // Если запрос "stale", но для той же комнаты, и комната уже подключена - возвращаем успех
      if (isStaleRequest && isSameRoom) {
        logger.info('[VideoCallSession] Request is stale but room already connected, reusing connection', {
          connectRequestId,
          currentConnectRequestId: this.connectRequestId,
          targetRoomName,
          currentRoomName: this.currentRoomName,
        });
        return true;
      }
      
      throw e;
    }
    })();
    
    // Сохраняем промис подключения и ждем его завершения
    this.connectingPromise = connectionPromise;
    try {
      const result = await connectionPromise;
      // Очищаем промис после завершения
      if (this.connectingPromise === connectionPromise) {
        this.connectingPromise = null;
      }
      return result;
    } catch (e) {
      // Очищаем промис при ошибке
      if (this.connectingPromise === connectionPromise) {
        this.connectingPromise = null;
      }
      throw e;
    }
  }

  private async disconnectRoom(reason: 'user' | 'server' = 'user'): Promise<void> {
    this.clearLocalVideoWatchdog();
    setActiveVideoCall(false);
    // КРИТИЧНО: Защита от множественных вызовов disconnectRoom
    // Если уже идет отключение, возвращаем существующий промис
    if (this.isDisconnecting && this.disconnectPromise) {
      logger.debug('[VideoCallSession] disconnectRoom already in progress, waiting...');
      return this.disconnectPromise;
    }
    
    const room = this.room;
    if (!room) {
      logger.debug('[VideoCallSession] disconnectRoom: no room to disconnect');
      return;
    }
    
      // Проверяем, не отключена ли комната уже
      if (room.state === 'disconnected') {
        logger.debug('[VideoCallSession] disconnectRoom: room already disconnected');
        this.room = null;
        this.currentRoomName = null; // Очищаем имя комнаты
        return;
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
        logger.debug('[VideoCallSession] Room fully disconnected, cleanup complete', { 
          reason: this.disconnectReason 
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        // КРИТИЧНО: Очищаем ссылку на комнату СИНХРОННО в обработчике события
        // Это гарантирует, что this.room = null установится до разрешения промиса
        if (this.room === roomToDisconnect) {
          this.room = null;
          this.currentRoomName = null;
          logger.debug('[VideoCallSession] Room reference cleared synchronously in Disconnected handler');
        }
        // Best-effort: полностью добиваем внутренний engine/ws, чтобы LiveKit не успевал
        // выстрелить WARN "ping timeout triggered" уже ПОСЛЕ завершения звонка.
        this.forceDisposeRoom(roomToDisconnect, 'disconnected');
        this.disconnectReason = 'unknown';
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        resolve();
      };
      
      // Подписываемся на событие Disconnected
      roomToDisconnect.once(RoomEvent.Disconnected, disconnectedHandler);
      
      // Таймаут на случай, если событие Disconnected не придет (защита от зависания)
      timeoutId = setTimeout(() => {
        logger.warn('[VideoCallSession] Disconnect timeout, forcing cleanup', { 
          roomState: roomToDisconnect.state 
        });
        if (disconnectedHandler) {
          roomToDisconnect.off(RoomEvent.Disconnected, disconnectedHandler);
        }
        // disconnect() только если комната была connected, иначе "cannot send signal request before connected, type: leave"
        if (roomToDisconnect.state === 'connected') {
          try { roomToDisconnect.disconnect(); } catch {}
        }
        try { roomToDisconnect.removeAllListeners(); } catch {}
        // Дополнительно принудительно закрываем внутренний engine/ws.
        this.forceDisposeRoom(roomToDisconnect, 'timeout');
        // КРИТИЧНО: Очищаем ссылку на комнату СИНХРОННО при таймауте
        // Это гарантирует, что this.room = null установится даже если событие Disconnected не придет
        if (this.room === roomToDisconnect) {
          this.room = null;
          this.currentRoomName = null;
          logger.debug('[VideoCallSession] Room reference cleared synchronously in timeout handler');
        }
        this.disconnectReason = 'unknown';
        this.isDisconnecting = false;
        this.disconnectPromise = null;
        resolve();
      }, 5000); // 5 секунд максимум на отключение
      
      // Увеличиваем connectRequestId, чтобы остановить отложенные подключения
      this.connectRequestId++;
      // КРИТИЧНО: НЕ устанавливаем this.room = null сразу - это делается только после полного отключения
      // в обработчике Disconnected, чтобы избежать утечек соединений
      
      // КРИТИЧНО: НЕ вызываем room.removeAllListeners() перед disconnect()
      // Это удаляет внутренние обработчики LiveKit (ping/pong, корректное завершение),
      // что приводит к "ping timeout" и "connection state mismatch" ошибкам.
      // room.disconnect() отправляет "leave" на сервер — вызывать только если state === 'connected',
      // иначе LiveKit бросает "cannot send signal request before connected, type: leave".
      (async () => {
        if (roomToDisconnect.state !== 'connected') {
          logger.debug('[VideoCallSession] Room not connected yet, skipping disconnect()', { state: roomToDisconnect.state });
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          this.forceDisposeRoom(roomToDisconnect, 'disconnectRoom:not_connected');
          if (this.room === roomToDisconnect) {
            this.room = null;
            this.currentRoomName = null;
          }
          if (disconnectedHandler) {
            roomToDisconnect.off(RoomEvent.Disconnected, disconnectedHandler);
            disconnectedHandler();
          }
          return;
        }
        try {
          await roomToDisconnect.disconnect();
          logger.debug('[VideoCallSession] Room disconnect() called, waiting for Disconnected event');
          // Короткая задержка перед forceDisposeRoom: даём движку LiveKit обновить состояние (closed/transports),
          // чтобы снизить WARN "connection state mismatch" при быстром закрытии.
          await new Promise((r) => setTimeout(r, 50));
          this.forceDisposeRoom(roomToDisconnect, 'disconnectRoom:after_await');
        } catch (e: any) {
          const errorMessage = e?.message || String(e || '');
          if (!errorMessage.includes('before connected') && !errorMessage.includes('already disconnected')) {
            logger.warn('[VideoCallSession] Error disconnecting room', e);
          }
          this.forceDisposeRoom(roomToDisconnect, 'disconnectRoom:after_catch');
        }
      })();
    });
    
    // КРИТИЧНО: Очистка this.room теперь происходит СИНХРОННО в обработчике Disconnected
    // или в таймауте, поэтому этот .then() колбэк больше не нужен для очистки,
    // но оставляем его как дополнительную защиту на случай edge cases
    this.disconnectPromise.then(() => {
      // Дополнительная проверка на случай, если очистка не произошла в обработчике
      if (this.room === room) {
        logger.warn('[VideoCallSession] Room still exists after disconnect promise resolved, force clearing');
        this.room = null;
        this.currentRoomName = null;
      }
    }).catch(() => {
      // В случае ошибки все равно очищаем
      if (this.room === room) {
        this.room = null;
        this.currentRoomName = null;
      }
    });
    
    return this.disconnectPromise;
  }

  // livekit-client иногда оставляет активный ws/engine на мобилках даже после room.disconnect().
  // Это приводит к WARN "ping timeout triggered" и "connection state mismatch" после завершения звонка.
  // Закрываем в порядке: транспорт → сокет/ws → signalClient → engine, чтобы состояние было согласованным.
  private forceDisposeRoom(room: Room, context: 'disconnected' | 'timeout' | string): void {
    try {
      // Внешние listeners можно снять безопасно после начала/завершения disconnect.
      try { (room as any)?.removeAllListeners?.(); } catch {}

      const engine: any = (room as any)?.engine;
      const signalClient = engine?.signalClient;
      // Порядок: сначала транспорт и сокет, затем signalClient, затем engine — чтобы не было "connection state mismatch".
      try { signalClient?.transport?.close?.(); } catch {}
      try { signalClient?.ws?.close?.(); } catch {}
      try { signalClient?.socket?.close?.(); } catch {}
      try { signalClient?.close?.(); } catch {}
      try { engine?.client?.close?.(); } catch {}
      try { engine?.close?.(); } catch {}

      logger.debug('[VideoCallSession] forceDisposeRoom complete', {
        context,
        roomState: (room as any)?.state,
      });
    } catch (e) {
      // Никогда не даем этой логике ломать завершение звонка.
      logger.debug('[VideoCallSession] forceDisposeRoom failed (ignored)', {
        context,
        error: (e as any)?.message || String(e || ''),
      });
    }
  }

  private shouldRunLocalVideoWatchdog(): boolean {
    if (Platform.OS !== 'android') return false;
    const api = Number(Platform.Version);
    const isOldAndroid = Number.isFinite(api) && api <= 27; // Android 8.1 and below
    const brand = String((Device as any)?.brand || '').toLowerCase();
    const manufacturer = String((Device as any)?.manufacturer || '').toLowerCase();
    const isOppoLike = brand.includes('oppo') || manufacturer.includes('oppo');
    return isOldAndroid || isOppoLike;
  }

  private clearLocalVideoWatchdog(): void {
    if (this.localVideoHealthTimeout) {
      try { clearTimeout(this.localVideoHealthTimeout); } catch {}
      this.localVideoHealthTimeout = null;
    }
  }

  private scheduleLocalVideoHealthCheck(context: string): void {
    if (!this.shouldRunLocalVideoWatchdog()) return;
    if (!this.isCamOn) return;
    if (!this.room || this.room.state !== 'connected') return;
    if (!this.localVideoTrack || this.localVideoTrack.mediaStreamTrack?.readyState === 'ended') return;

    this.clearLocalVideoWatchdog();
    if (this.localVideoHealthAttempts > 3) this.localVideoHealthAttempts = 0;

    this.localVideoHealthTimeout = setTimeout(() => {
      void this.runLocalVideoHealthCheckOnce(context);
    }, 2800);
  }

  private pickLocalVideoStat(stats: any[]): any | null {
    if (!Array.isArray(stats) || stats.length === 0) return null;
    const sid = this.localVideoTrack?.sid;
    const isVideo = (s: any) => String(s?.kind || '').toLowerCase() === 'video';
    const matchesSid = (s: any) =>
      sid && (String((s as any)?.trackSid || '') === String(sid) || String((s as any)?.mediaTrackId || '') === String(sid));

    const bySid = sid ? stats.find((s) => isVideo(s) && matchesSid(s)) : null;
    if (bySid) return bySid;
    return stats.find((s) => isVideo(s)) || null;
  }

  private extractVideoProgress(stat: any): { frames: number; bytes: number; packets: number } {
    const frames = Number(
      (stat as any)?.framesSent ??
      (stat as any)?.framesEncoded ??
      (stat as any)?.frames ??
      0
    ) || 0;
    const bytes = Number(
      (stat as any)?.bytesSent ??
      (stat as any)?.bytes ??
      (stat as any)?.bytesSentTotal ??
      0
    ) || 0;
    const packets = Number(
      (stat as any)?.packetsSent ??
      (stat as any)?.packets ??
      0
    ) || 0;
    return { frames, bytes, packets };
  }

  private async runLocalVideoHealthCheckOnce(context: string): Promise<void> {
    try {
      if (!this.shouldRunLocalVideoWatchdog()) return;
      if (!this.isCamOn) return;
      if (!this.room || this.room.state !== 'connected') return;
      if (!this.localVideoTrack || this.localVideoTrack.mediaStreamTrack?.readyState === 'ended') return;
      if (this.localVideoHealthAttempts >= 2) return;

      const getStats = async () => {
        const stats = await (this.room?.localParticipant as any)?.getTrackStats?.();
        const st = this.pickLocalVideoStat(stats || []);
        return this.extractVideoProgress(st);
      };

      const a = await getStats().catch(() => ({ frames: 0, bytes: 0, packets: 0 }));
      await new Promise((r) => setTimeout(r, 1200));
      const b = await getStats().catch(() => ({ frames: 0, bytes: 0, packets: 0 }));

      const framesDelta = b.frames - a.frames;
      const bytesDelta = b.bytes - a.bytes;
      const packetsDelta = b.packets - a.packets;

      const stuck = framesDelta <= 0 && bytesDelta <= 5120 && packetsDelta <= 0;
      if (!stuck) return;

      this.localVideoHealthAttempts += 1;
      logger.warn('[VideoCallSession] 🔧 Local video seems stuck; restarting camera', {
        context,
        attempt: this.localVideoHealthAttempts,
        framesDelta,
        bytesDelta,
        packetsDelta,
        roomState: this.room.state,
        camSide: this.camSide,
      });

      // Best-effort: unpublish old track, recreate, and republish.
      try {
        if (this.room?.localParticipant && this.localVideoTrack) {
          await this.room.localParticipant.unpublishTrack(this.localVideoTrack, false).catch(() => {});
        }
      } catch {}

      await this.recreateLocalVideoTrack(`watchdog:${context}`);
      if (this.room && this.room.state === 'connected' && this.room.localParticipant) {
        if (this.localVideoTrack && this.isCamOn && !this.isVideoTrackPublished(this.localVideoTrack)) {
          await this.unpublishOtherLocalTracks('video', this.localVideoTrack);
          await this.room.localParticipant.publishTrack(this.localVideoTrack).catch(() => {});
        }
        // КРИТИЧНО: аудио перепубликовываем только если оно ещё не опубликовано.
        // Иначе повторный publish может сломать звук у собеседника (дубликат/замена трека).
        if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
          await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
          await this.room.localParticipant.publishTrack(this.localAudioTrack).catch(() => {});
        }
      }

      this.scheduleLocalVideoHealthCheck('post-recovery');
    } catch (e) {
      logger.debug('[VideoCallSession] Local video health check failed (ignored)', e);
    }
  }

  private async safeDisconnect(room: Room): Promise<void> {
    if (!room) return;
    if (room.state === 'disconnected') {
      return;
    }
    try {
      await room.disconnect();
    } catch (e) {
      logger.warn('[VideoCallSession] Error disconnecting stale room', e);
    }
  }

  private registerRoomEvents(room: Room): void {
    room
      .on(RoomEvent.Reconnecting, () => {
        this.liveKitReconnecting = true;
        this.lastLiveKitReconnectingAt = Date.now();
        // Do NOT reset streams/UI here. LiveKit will recover by itself.
        logger.warn('[VideoCallSession] LiveKit room reconnecting (transient)', {
          roomName: room.name,
          roomState: room.state,
          myUserId: this.config.myUserId,
          partnerUserId: this.partnerUserId,
        });
        this.clearPendingRemoteDisconnectTimer();
      })
      .on(RoomEvent.Reconnected, () => {
        this.liveKitReconnecting = false;
        logger.info('[VideoCallSession] LiveKit room reconnected', {
          roomName: room.name,
          roomState: room.state,
          myUserId: this.config.myUserId,
          partnerUserId: this.partnerUserId,
          participantsCount: room.remoteParticipants.size,
        });
        this.clearPendingRemoteDisconnectTimer();
        void this.recoverLocalTracksAfterReconnect(room, 'RoomEvent.Reconnected');
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        // КРИТИЧНО: При подключении участника подписываемся на все его существующие треки
        if (!participant.isLocal) {
          // If we were about to end the call due to a disconnect, cancel — remote is back.
          this.clearPendingRemoteDisconnectTimer();
          logger.info('[VideoCallSession] ✅ Remote participant connected event received', {
            participantId: participant.identity,
            audioTracks: participant.audioTrackPublications.size,
            videoTracks: participant.videoTrackPublications.size,
            roomName: room.name,
            roomState: room.state,
            totalRemoteParticipants: room.remoteParticipants.size,
            myUserId: this.config.myUserId,
            partnerUserId: this.partnerUserId,
            expectedPartnerIdentity: this.partnerUserId,
            identityMatches: participant.identity === this.partnerUserId,
          });
          
          // КРИТИЧНО: Функция для подписки на треки участника
          const subscribeToTracks = () => {
            // Подписываемся на все аудио треки
            participant.audioTrackPublications.forEach((publication) => {
              // КРИТИЧНО: Всегда подписываемся явно, даже если autoSubscribe включен
              // Это гарантирует, что трек будет получен
              if (!publication.isSubscribed || !publication.track) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] ParticipantConnected - subscribed to audio track', {
                  trackSid: publication.trackSid,
                  wasSubscribed: publication.isSubscribed,
                  hasTrack: !!publication.track,
                });
              }
              
              // Если трек уже загружен - обрабатываем сразу
              if (publication.track) {
                logger.info('[VideoCallSession] ParticipantConnected - processing audio track immediately', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                // КРИТИЧНО: Если трек не загружен, проверяем через 100ms
                setTimeout(() => {
                  if (publication.track && this.room === room && room.state === 'connected') {
                    logger.info('[VideoCallSession] ParticipantConnected - audio track loaded after subscription', {
                      trackSid: publication.trackSid,
                    });
                    this.handleTrackSubscribed(publication.track, publication, participant);
                  }
                }, 100);
              }
            });
            
            participant.videoTrackPublications.forEach((publication) => {
              // КРИТИЧНО: Всегда подписываемся явно, даже если autoSubscribe включен
              // Это гарантирует, что трек будет получен
              if (!publication.isSubscribed || !publication.track) {
                publication.setSubscribed(true);
                logger.info('[VideoCallSession] ParticipantConnected - subscribed to video track', {
                  trackSid: publication.trackSid,
                  wasSubscribed: publication.isSubscribed,
                  hasTrack: !!publication.track,
                });
              }
              
              // Если трек уже загружен - обрабатываем сразу
              if (publication.track) {
                logger.info('[VideoCallSession] ParticipantConnected - processing video track immediately', {
                  trackSid: publication.trackSid,
                });
                this.handleTrackSubscribed(publication.track, publication, participant);
              } else {
                // КРИТИЧНО: Если трек не загружен, проверяем через 100ms
                setTimeout(() => {
                  if (publication.track && this.room === room && room.state === 'connected') {
                    logger.info('[VideoCallSession] ParticipantConnected - video track loaded after subscription', {
                      trackSid: publication.trackSid,
                    });
                    this.handleTrackSubscribed(publication.track, publication, participant);
                  }
                }, 100);
              }
            });
          };
          
          // Подписываемся сразу
          subscribeToTracks();
          
          // КРИТИЧНО: Дополнительная проверка через 200ms на случай если треки загружаются с задержкой
          setTimeout(() => {
            if (this.room === room && room.state === 'connected' && !participant.isLocal) {
              subscribeToTracks();
            }
          }, 200);
        }
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        // КРИТИЧНО: При публикации трека удаленным участником подписываемся на него
        if (!participant.isLocal) {
          logger.info('[VideoCallSession] Remote track published', {
            kind: publication.kind,
            trackSid: publication.trackSid,
            participantId: participant.identity,
            isSubscribed: publication.isSubscribed,
            hasTrack: !!publication.track,
          });
          
          // КРИТИЧНО: Всегда подписываемся явно, даже если autoSubscribe включен
          if (!publication.isSubscribed) {
            publication.setSubscribed(true);
            logger.info('[VideoCallSession] Subscribing to newly published track', {
              kind: publication.kind,
              trackSid: publication.trackSid,
            });
          }
          
          // Если трек уже загружен - обрабатываем сразу
          if (publication.track) {
            logger.info('[VideoCallSession] Processing newly published track (already loaded)', {
              kind: publication.kind,
              trackSid: publication.trackSid,
            });
            this.handleTrackSubscribed(publication.track, publication, participant);
          } else {
            logger.debug('[VideoCallSession] Track published but not loaded yet, waiting for TrackSubscribed', {
              kind: publication.kind,
              trackSid: publication.trackSid,
            });
          }
        }
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        // КРИТИЧНО: Игнорируем подписки на локальные треки
        // LiveKit может отправлять события подписки на локальные треки, но они не должны обрабатываться
        // Это предотвращает предупреждение "could not find local track subscription for subscribed event"
        if (participant.isLocal) {
          logger.debug('[VideoCallSession] Ignoring TrackSubscribed for local participant', {
            kind: publication.kind,
            trackSid: publication.trackSid,
          });
          return;
        }
        logger.info('[VideoCallSession] ✅ TrackSubscribed event received', {
          kind: publication.kind,
          trackSid: track.sid,
          publicationTrackSid: publication.trackSid,
          participantId: participant.identity,
          isMuted: track.isMuted,
          trackReady: track.mediaStreamTrack?.readyState,
        });
        this.handleTrackSubscribed(track, publication, participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
        // КРИТИЧНО: Проверяем тип участника перед обработкой
        // Локальные треки не должны влиять на remoteStream
        if (participant.isLocal) {
          logger.debug('[VideoCallSession] Ignoring TrackUnsubscribed for local participant', {
            kind: publication.kind,
            trackSid: publication.trackSid,
          });
          return;
        }
        this.handleTrackUnsubscribed(publication, participant);
      })
      .on(RoomEvent.TrackMuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          // TrackMuted can happen transiently during track replacement; debounce before showing "away".
          this.scheduleRemoteCamOff('TrackMuted');
        }
      })
      .on(RoomEvent.TrackUnmuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          this.remoteCamEnabled = true;
          this.clearRemoteCamOffTimeout();
          this.config.callbacks.onRemoteCamStateChange?.(true);
          this.config.onRemoteCamStateChange?.(true);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant === this.currentRemoteParticipant) {
          if (!this.isDisconnecting) {
            // LiveKit can emit ParticipantDisconnected transiently during reconnect/negotiation.
            // We must NOT end the call immediately in that case, otherwise UI shows "error" and then "connects".
            const isRoomReconnecting = this.liveKitReconnecting || room.state === 'reconnecting';
            const recentlyReconnecting = Date.now() - this.lastLiveKitReconnectingAt < 10_000;
            if (isRoomReconnecting || recentlyReconnecting) {
              logger.warn('[VideoCallSession] Remote participant disconnected during reconnect (ignored)', {
                participantIdentity: participant.identity,
                roomState: room.state,
                liveKitReconnecting: this.liveKitReconnecting,
                recentlyReconnecting,
              });
              return;
            }

            // Сразу закрываем системный и in-app PiP при уходе партнёра (без задержки 1.5s — UX).
            if (Platform.OS === 'android') {
              try { (NativeModules as any)?.LiviAppModule?.requestExitSystemPiP?.(); } catch {}
            }
            try {
              const hidePiP = (global as any).__pipHidePiPRef?.current;
              if (typeof hidePiP === 'function') hidePiP();
            } catch {}

            // Подтверждаем disconnect через короткую задержку (избегаем ложного срабатывания при reconnect).
            this.clearPendingRemoteDisconnectTimer();
            this.pendingRemoteDisconnectTimer = setTimeout(() => {
              this.pendingRemoteDisconnectTimer = null;
              if (this.ended || this.isDisconnecting) return;
              const stillReconnecting = this.liveKitReconnecting || room.state === 'reconnecting';
              if (stillReconnecting) return;

              const expected = this.partnerUserId ? String(this.partnerUserId) : null;
              const hasExpected =
                !!expected &&
                Array.from(room.remoteParticipants.values()).some((p) => String(p.identity) === expected);
              const anyRemote = room.remoteParticipants.size > 0;
              if (hasExpected || anyRemote) return;

              logger.info('[VideoCallSession] Remote participant disconnected (confirmed) — treating as call ended', {
                participantIdentity: participant.identity,
                expectedPartnerIdentity: expected,
                roomState: room.state,
              });
              this.handleCallEnded();
            }, 500);
          }
        }
      })
      .once(RoomEvent.Disconnected, () => {
        // КРИТИЧНО: Если идет процесс disconnectRoom через промис, не сбрасываем флаги здесь -
        // это сделает промис в disconnectRoom
        logger.debug('[VideoCallSession] Room disconnected event received', { 
          reason: this.disconnectReason,
          isDisconnecting: this.isDisconnecting,
          hasDisconnectPromise: !!this.disconnectPromise
        });
        // Если отключение не мы инициировали (обрыв связи / сеть) — только закрываем системный PiP.
        // НЕ вызываем handleCallEnded(): иначе у пользователя сбросится busy и друзья увидят его как свободного,
        // хотя звонок ещё не завершён. Завершение — только по call:ended с сервера или по нажатию «Завершить».
        if (!this.disconnectPromise && !this.ended) {
          this.clearPendingRemoteDisconnectTimer();
          if (Platform.OS === 'android') {
            try { (NativeModules as any)?.LiviAppModule?.requestExitSystemPiP?.(); } catch {}
          }
        }
        // Флаги будут сброшены в disconnectRoom через промис, если он активен
        if (!this.disconnectPromise) {
          this.disconnectReason = 'unknown';
          this.isDisconnecting = false;
        }
      });
  }

  private async recoverLocalTracksAfterReconnect(room: Room, context: string): Promise<void> {
    try {
      // Give LiveKit engine a moment to settle after reconnect.
      await new Promise((r) => setTimeout(r, 250));
      if (this.ended || this.isDisconnecting) return;
      if (this.room !== room) return;
      if (!room.localParticipant || room.state !== 'connected') return;

      // Ensure local tracks exist (non-forced; avoids camera/audio churn).
      if (!this.localAudioTrack || !this.localVideoTrack) {
        await this.ensureLocalTracks(false);
      }

      // If camera track was ended by OS, recreate video only.
      const vState = this.localVideoTrack?.mediaStreamTrack?.readyState;
      if (this.isCamOn && vState === 'ended') {
        logger.warn('[VideoCallSession] Local video track ended after reconnect; recreating video track', { context });
        await this.recreateLocalVideoTrack('reconnect');
      }

      // Re-apply mic enabled state (some devices flip enabled=false transiently).
      try {
        const mt = this.localAudioTrack?.mediaStreamTrack as any;
        if (mt && typeof mt.enabled === 'boolean') mt.enabled = this.isMicOn;
      } catch {}
      try {
        if (this.localAudioTrack) {
          this.isMicOn ? this.localAudioTrack.unmute() : this.localAudioTrack.mute();
        }
      } catch {}

      // Re-publish tracks if needed (best-effort).
      if (this.localVideoTrack && this.isCamOn && !this.isVideoTrackPublished(this.localVideoTrack)) {
        await this.unpublishOtherLocalTracks('video', this.localVideoTrack);
        await room.localParticipant.publishTrack(this.localVideoTrack).catch(() => {});
      }
      if (this.localAudioTrack && this.isMicOn && !this.isAudioTrackPublished(this.localAudioTrack)) {
        await this.unpublishOtherLocalTracks('audio', this.localAudioTrack);
        await room.localParticipant.publishTrack(this.localAudioTrack).catch(() => {});
      }
    } catch (e) {
      logger.debug('[VideoCallSession] recoverLocalTracksAfterReconnect failed (ignored)', {
        context,
        error: (e as any)?.message || String(e || ''),
      });
    }
  }

  private handleTrackSubscribed(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    logger.info('[VideoCallSession] Track subscribed', {
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
    // Учёт lastUnsubscribedRemoteVideoTrackSid: при перевороте камеры сначала приходит TrackUnsubscribed (remoteVideoTrack обнуляется),
    // потом TrackSubscribed — без сохранённого SID wasVideoTrackChanged был бы false и у собеседника не создавался бы новый MediaStream.
    const previousVideoSid = oldVideoTrackSid ?? this.lastUnsubscribedRemoteVideoTrackSid;
    const wasVideoTrackChanged = isVideoTrack && !!previousVideoSid && previousVideoSid !== track.sid;
    
    // Не пересоздаем stream, чтобы не было мерцаний — создаем один раз и переиспользуем
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
      logger.info('[VideoCallSession] ✅ Created new remote MediaStream', {
        streamId: this.remoteStream.id,
        trackKind: publication.kind,
        trackSid: track.sid,
      });
    }
    
    const activeRemoteStream = this.remoteStream;
    const trackAlreadyInStream = mediaTrack && activeRemoteStream.getTracks().includes(mediaTrack as any);
    
    // КРИТИЧНО: Если видео трек изменился (переворот камеры у партнёра), создаём новый MediaStream.
    // Иначе у собеседника тот же stream.id и UI не вызывает setRemoteStream → превью не обновляется.
    if (isVideoTrack && wasVideoTrackChanged) {
      const newStream = new MediaStream();
      try {
        if (mediaTrack) newStream.addTrack(mediaTrack as any);
        const audioTrack = this.remoteAudioTrack?.mediaStreamTrack;
        if (audioTrack) newStream.addTrack(audioTrack as any);
        this.remoteStream = newStream;
        logger.info('[VideoCallSession] New remote MediaStream for replaced video track (camera flip)', {
          oldTrackId: previousVideoSid,
          newTrackId: track.sid,
          streamId: newStream.id,
        });
      } catch (e) {
        logger.warn('[VideoCallSession] Error creating new remote stream for video track replace', e);
      }
    } else {
      // Обычный путь: переиспользуем существующий stream
      if (
        isVideoTrack &&
        wasVideoTrackChanged &&
        this.remoteVideoTrack?.mediaStreamTrack &&
        activeRemoteStream.getTracks().includes(this.remoteVideoTrack.mediaStreamTrack as any)
      ) {
        try {
          activeRemoteStream.removeTrack(this.remoteVideoTrack.mediaStreamTrack as any);
          logger.info('[VideoCallSession] Removed previous remote video track from stream', {
            oldTrackId: oldVideoTrackSid,
            newTrackId: track.sid,
          });
        } catch (e) {
          logger.warn('[VideoCallSession] Error removing previous video track', e);
        }
      }
      if (mediaTrack && !trackAlreadyInStream) {
        activeRemoteStream.addTrack(mediaTrack as any);
        logger.debug('[VideoCallSession] Added track to remote stream', {
          kind: publication.kind,
          streamId: activeRemoteStream.id,
          tracksCount: activeRemoteStream.getTracks().length,
          trackId: track.sid,
        });
      }
    }
    
    let shouldRemountRemoteView = false;

    if (publication.kind === Track.Kind.Audio) {
      this.remoteAudioTrack = track;
      // КРИТИЧНО: гарантируем слышимость аудио (иногда track приходит disabled/muted после reconnect)
      try {
        // sync with local "mute remote" toggle
        (this.remoteAudioTrack as any).setMuted?.(this.remoteAudioMuted);
      } catch {}
      try {
        // RN: setVolume влияет на нативный трек через _setVolume
        (this.remoteAudioTrack as any).setVolume?.(this.remoteAudioMuted ? 0 : 1);
      } catch {}
      try {
        const mt = (this.remoteAudioTrack as any)?.mediaStreamTrack;
        if (mt && typeof mt.enabled === 'boolean') {
          mt.enabled = !this.remoteAudioMuted;
        }
      } catch {}
    } else if (publication.kind === Track.Kind.Video) {
      const prevVideoTrack = this.remoteVideoTrack;
      const wasMutedStateChanged = !!prevVideoTrack && (prevVideoTrack.isMuted !== track.isMuted);
      this.remoteVideoTrack = track;
      this.lastUnsubscribedRemoteVideoTrackSid = null;
      // A new video track arriving usually means "camera is on".
      // But during re-subscribe it can briefly be muted; avoid flashing "away" by debouncing OFF.
      if (!track.isMuted) {
        this.remoteCamEnabled = true;
        this.clearRemoteCamOffTimeout();
      } else {
        // Keep the previous value for a short grace period; if it stays muted, we'll mark OFF.
        this.scheduleRemoteCamOff('TrackSubscribedMuted');
      }
      
      const isFirstVideoTrack = !oldVideoTrackSid;
      if (isFirstVideoTrack || wasVideoTrackChanged || wasMutedStateChanged) {
        logger.debug('[VideoCallSession] Video track muted state changed', {
          wasMuted: prevVideoTrack?.isMuted,
          isMuted: track.isMuted,
        });
        shouldRemountRemoteView = true;
      }
      
      if (!track.isMuted) {
        this.config.callbacks.onRemoteCamStateChange?.(true);
        this.config.onRemoteCamStateChange?.(true);
      }
    }
    
    // Всегда эмитим remoteStream для обновления UI/аудио, но remount RTCView делаем только при необходимости.
    if (isVideoTrack && shouldRemountRemoteView) {
      this.remoteViewKey = Date.now();
      logger.debug('[VideoCallSession] Updated remoteViewKey for video track', {
        remoteViewKey: this.remoteViewKey,
        trackId: track.sid,
        wasVideoTrackChanged,
        streamId: this.remoteStream.id,
        trackReady: track.mediaStreamTrack?.readyState,
        trackMuted: track.isMuted,
      });
    }
    
    // КРИТИЧНО: Эмитим события в правильном порядке - сначала remoteViewKeyChanged, потом remoteStream
    // Это гарантирует, что компонент обновится с правильным ключом
    // КРИТИЧНО: Эмитим события синхронно для немедленного обновления RTCView
    // Задержка была удалена, так как она вызывала зависание видео
    // КРИТИЧНО: Всегда эмитим remoteStream, даже если трек еще не добавлен
    // Это гарантирует, что UI получит стрим и сможет отобразить его когда трек станет готовым
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
    this.emit('remoteStream', this.remoteStream);
    this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
    this.config.onRemoteStreamChange?.(this.remoteStream);
    // КРИТИЧНО: Обновляем PiP (в т.ч. системный) при смене удалённого стрима — иначе при включении камеры партнёром из app PiP видео не восстановится у пользователя в системном PiP
    try {
      const pipUpdate = (global as any).__pipUpdateStateRef?.current;
      if (typeof pipUpdate === 'function') pipUpdate({ remoteStream: this.remoteStream });
    } catch (_) {}

    // КРИТИЧНО: Устанавливаем loading=false только когда приходит remoteStream с треками
    // Это предотвращает черный экран при принятии звонка
    if (this.remoteStream && (this.remoteVideoTrack || this.remoteAudioTrack)) {
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
    }
    
    logger.info('[VideoCallSession] Remote stream updated after track subscription', {
      streamId: this.remoteStream.id,
      tracksCount: this.remoteStream.getTracks().length,
      hasVideoTrack: !!this.remoteVideoTrack,
      hasAudioTrack: !!this.remoteAudioTrack,
      remoteCamEnabled: this.remoteCamEnabled,
      remoteViewKey: this.remoteViewKey,
      wasVideoTrackChanged,
    });
  }

  private handleTrackUnsubscribed(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    if (participant !== this.currentRemoteParticipant) {
      return;
    }

    if (publication.kind === Track.Kind.Audio && this.remoteAudioTrack) {
      const mediaTrack = this.remoteAudioTrack.mediaStreamTrack;
      if (mediaTrack && this.remoteStream) {
        this.remoteStream.removeTrack(mediaTrack as any);
      }
      this.remoteAudioTrack = null;
    }
    if (publication.kind === Track.Kind.Video && this.remoteVideoTrack) {
      this.lastUnsubscribedRemoteVideoTrackSid = this.remoteVideoTrack.sid ?? null;
      const mediaTrack = this.remoteVideoTrack.mediaStreamTrack;
      if (mediaTrack && this.remoteStream) {
        this.remoteStream.removeTrack(mediaTrack as any);
      }
      this.remoteVideoTrack = null;
      // TrackUnsubscribed can happen during camera flip/replace; debounce "camera off".
      this.scheduleRemoteCamOff('TrackUnsubscribed');
    }

    const tracksCount = this.remoteStream?.getTracks().length ?? 0;
    if (this.remoteStream && tracksCount === 0) {
      // During LiveKit reconnect/renegotiation tracks can temporarily drop to 0.
      // Do NOT reset remoteStream to null in that case — it causes UI to show "error/no video" flicker.
      const isRoomReconnecting = this.liveKitReconnecting || this.room?.state === 'reconnecting';
      const recentlyReconnecting = Date.now() - this.lastLiveKitReconnectingAt < 10_000;
      if (!isRoomReconnecting && !recentlyReconnecting) {
        this.remoteStream = null;
        this.emit('remoteStream', null);
        this.config.callbacks.onRemoteStreamChange?.(null);
        this.config.onRemoteStreamChange?.(null);
        try {
          const pipUpdate = (global as any).__pipUpdateStateRef?.current;
          if (typeof pipUpdate === 'function') pipUpdate({ remoteStream: null });
        } catch (_) {}
      } else {
        logger.debug('[VideoCallSession] Suppressed remoteStream=null during reconnect', {
          isRoomReconnecting,
          recentlyReconnecting,
          roomState: this.room?.state,
          kind: publication.kind,
        });
      }
    }

    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }

  private clearRemoteCamOffTimeout(): void {
    if (this.remoteCamOffTimeout) {
      try { clearTimeout(this.remoteCamOffTimeout); } catch {}
      this.remoteCamOffTimeout = null;
    }
  }

  private scheduleRemoteCamOff(reason: string): void {
    // If we already consider camera off, don't spam timers/callbacks.
    if (!this.remoteCamEnabled && !this.remoteCamOffTimeout) {
      return;
    }
    this.clearRemoteCamOffTimeout();

    this.remoteCamOffTimeout = setTimeout(() => {
      this.remoteCamOffTimeout = null;
      // If a new video track appeared since scheduling, we should have cancelled; still guard.
      if (this.remoteVideoTrack && !this.remoteVideoTrack.isMuted) {
        return;
      }
      this.remoteCamEnabled = false;
      this.config.callbacks.onRemoteCamStateChange?.(false);
      this.config.onRemoteCamStateChange?.(false);
      logger.debug('[VideoCallSession] Remote camera set OFF after grace period', { reason, ms: REMOTE_CAM_OFF_GRACE_MS });
    }, REMOTE_CAM_OFF_GRACE_MS);
  }
}
