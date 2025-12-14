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

type CallAcceptedPayload = {
  callId?: string;
  from?: string;
  fromUserId?: string;
  roomId?: string;
  livekitToken?: string | null;
  livekitRoomName?: string | null;
};

type CallIncomingPayload = {
  callId: string;
  from: string;
  fromNick?: string;
};

export class VideoCallSession extends SimpleEventEmitter {
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
  private socketOffs: Array<() => void> = [];
  private connectRequestId = 0;
  private disconnectReason: 'user' | 'server' | 'unknown' = 'unknown';
  private isDisconnecting = false;
  private callId: string | null = null;
  private roomId: string | null = null;
  private partnerId: string | null = null;
  private partnerUserId: string | null = null;
  private inPiP = false;

  constructor(config: WebRTCSessionConfig) {
    super();
    this.config = config;
    this.setupSocketHandlers();
  }

  /* ===================== Public API ===================== */

  async callFriend(friendUserId: string): Promise<void> {
    this.partnerUserId = friendUserId;
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

  endCall(): void {
    void this.disconnectRoom('user');
    this.resetRemoteState();
    this.stopLocalTracks();
    
    if (this.callId || this.roomId) {
      try {
        socket.emit('call:end', { callId: this.callId || this.roomId, roomId: this.roomId });
      } catch (e) {
        logger.warn('[VideoCallSession] Error ending call', e);
      }
    }
    
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
    this.emit('callEnded');
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
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
  }

  toggleCam(): void {
    this.isCamOn = !this.isCamOn;
    if (this.room) {
      this.room.localParticipant.setCameraEnabled(this.isCamOn).catch((e) => {
        logger.warn('[VideoCallSession] Failed to toggle camera', e);
      });
    } else if (this.localVideoTrack) {
      try {
        this.isCamOn ? this.localVideoTrack.unmute() : this.localVideoTrack.mute();
      } catch {}
    }
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
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
    this.camSide = this.camSide === 'front' ? 'back' : 'front';
    await this.restartLocalCamera();
  }

  async restartLocalCamera(): Promise<void> {
    await this.ensureLocalTracks(true);
    if (this.room && this.localVideoTrack) {
      try {
        await this.room.localParticipant.publishTrack(this.localVideoTrack);
      } catch (e) {
        logger.warn('[VideoCallSession] Failed to republish camera after restart', e);
      }
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
          await this.connectToLiveKit(LIVEKIT_URL, data.token, ++this.connectRequestId);
        }
      } catch (e) {
        logger.error('[VideoCallSession] Error restoring call state', e);
      }
    }
  }

  cleanup(): void {
    this.endCall();
    this.socketOffs.forEach((off) => off());
    this.socketOffs = [];
  }

  getPeerConnection(): null {
    return null;
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

  exitPiP?(): void {
    this.setInPiP(false);
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
    const callAcceptedHandler = (data: CallAcceptedPayload) => {
      this.handleCallAccepted(data).catch((e) => {
        logger.error('[VideoCallSession] Failed to handle call:accepted', e);
      });
    };
    
    const callIncomingHandler = (data: CallIncomingPayload) => {
      this.handleCallIncoming(data);
    };
    
    const callEndedHandler = () => {
      this.handleCallEnded();
    };
    
    const disconnectedHandler = () => {
      this.handleDisconnected();
    };

    socket.on('call:accepted', callAcceptedHandler);
    socket.on('call:incoming', callIncomingHandler);
    socket.on('call:ended', callEndedHandler);
    socket.on('disconnected', disconnectedHandler);
    socket.on('call:cancel', callEndedHandler);

    this.socketOffs = [
      () => socket.off('call:accepted', callAcceptedHandler),
      () => socket.off('call:incoming', callIncomingHandler),
      () => socket.off('call:ended', callEndedHandler),
      () => socket.off('disconnected', disconnectedHandler),
      () => socket.off('call:cancel', callEndedHandler),
    ];
  }

  private async handleCallAccepted(data: CallAcceptedPayload): Promise<void> {
    const roomId = data.roomId ?? null;
    const callId = data.callId ?? null;
    const partnerId = data.from ?? null;
    const partnerUserId = data.fromUserId ?? null;

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

    if (!LIVEKIT_URL) {
      logger.error('[VideoCallSession] LiveKit URL is not configured');
      return;
    }
    
    // Если токен пришел в событии (новый формат)
    if (data.livekitToken && data.livekitRoomName) {
      const connectRequestId = ++this.connectRequestId;
      const connected = await this.connectToLiveKit(LIVEKIT_URL, data.livekitToken, connectRequestId);
      if (!connected) {
        logger.debug('[VideoCallSession] Call accepted handling aborted (stale request)');
        return;
      }
      this.config.callbacks.onLoadingChange?.(false);
      this.config.onLoadingChange?.(false);
      this.config.setIsInactiveState?.(false);
      this.config.setFriendCallAccepted?.(true);
      this.emit('callAnswered');
      return;
    }
    
    // Fallback: запрашиваем токен через API
    if (roomId) {
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
          const connectRequestId = ++this.connectRequestId;
          const connected = await this.connectToLiveKit(LIVEKIT_URL, tokenData.token, connectRequestId);
          if (!connected) {
            logger.debug('[VideoCallSession] Call accepted handling aborted (stale request)');
            return;
          }
          this.config.callbacks.onLoadingChange?.(false);
          this.config.onLoadingChange?.(false);
          this.config.setIsInactiveState?.(false);
          this.config.setFriendCallAccepted?.(true);
          this.emit('callAnswered');
        }
      } catch (e) {
        logger.error('[VideoCallSession] Error fetching LiveKit token', e);
      }
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
    void this.disconnectRoom('server');
    this.resetRemoteState();
    this.emit('callEnded');
  }

  private handleDisconnected(): void {
    void this.disconnectRoom('server');
    this.resetRemoteState();
  }

  private async ensureLocalTracks(force = false): Promise<void> {
    if (this.localVideoTrack && this.localAudioTrack && !force) {
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
      logger.error('[VideoCallSession] Failed to create local tracks', e);
      throw e;
    });

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
    this.config.callbacks.onLocalStreamChange?.(stream);
    this.config.onLocalStreamChange?.(stream);
    this.emit('localStream', stream);
    this.config.callbacks.onCamStateChange?.(this.isCamOn);
    this.config.onCamStateChange?.(this.isCamOn);
    this.config.callbacks.onMicStateChange?.(this.isMicOn);
    this.config.onMicStateChange?.(this.isMicOn);
  }

  private stopLocalTracks(): void {
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
    }
    this.localStream = null;
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

  private async connectToLiveKit(url: string, token: string, connectRequestId: number): Promise<boolean> {
    // КРИТИЧНО: Отключаем предыдущую комнату перед подключением к новой
    await this.disconnectRoom('user');
    
    // КРИТИЧНО: Небольшая задержка после отключения, чтобы избежать конфликтов
    await new Promise(resolve => setTimeout(resolve, 200));
    
    if (!this.localVideoTrack || !this.localAudioTrack) {
      await this.ensureLocalTracks();
    }
    
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
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
        return false;
      }
      throw e;
    }

    if (this.connectRequestId !== connectRequestId || this.room !== room) {
      await this.safeDisconnect(room);
      return false;
    }

    if (this.localVideoTrack) {
      await room.localParticipant.publishTrack(this.localVideoTrack).catch((e) => {
        logger.warn('[VideoCallSession] Failed to publish video track', e);
      });
    }
    if (this.localAudioTrack) {
      await room.localParticipant.publishTrack(this.localAudioTrack).catch((e) => {
        logger.warn('[VideoCallSession] Failed to publish audio track', e);
      });
    }

    this.config.callbacks.onMicStateChange?.(true);
    this.config.onMicStateChange?.(true);
    this.config.callbacks.onCamStateChange?.(true);
    this.config.onCamStateChange?.(true);
    return true;
  }

  private async disconnectRoom(reason: 'user' | 'server' = 'user'): Promise<void> {
    // КРИТИЧНО: Защита от множественных вызовов disconnectRoom
    if (this.isDisconnecting) {
      logger.debug('[VideoCallSession] disconnectRoom already in progress, skipping');
      return;
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
      return;
    }
    
    this.isDisconnecting = true;
    this.disconnectReason = reason;
    
    // Увеличиваем connectRequestId, чтобы остановить отложенные подключения
    this.connectRequestId++;
    this.room = null;
    
    // КРИТИЧНО: НЕ вызываем room.removeAllListeners() перед disconnect()
    // Это удаляет внутренние обработчики LiveKit (ping/pong, корректное завершение),
    // что приводит к "ping timeout" и "connection state mismatch" ошибкам.
    // room.disconnect() сам корректно завершит соединение и очистит ресурсы.
    
    try {
      await room.disconnect();
    } catch (e) {
      logger.warn('[VideoCallSession] Error disconnecting room', e);
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
      logger.warn('[VideoCallSession] Error disconnecting stale room', e);
    }
  }

  private registerRoomEvents(room: Room): void {
    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this.handleTrackSubscribed(track, publication, participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (_track, publication, participant) => {
        this.handleTrackUnsubscribed(publication, participant);
      })
      .on(RoomEvent.TrackMuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          this.remoteCamEnabled = false;
          this.config.callbacks.onRemoteCamStateChange?.(false);
          this.config.onRemoteCamStateChange?.(false);
        }
      })
      .on(RoomEvent.TrackUnmuted, (pub, participant) => {
        if (!participant.isLocal && pub.kind === Track.Kind.Video) {
          this.remoteCamEnabled = true;
          this.config.callbacks.onRemoteCamStateChange?.(true);
          this.config.onRemoteCamStateChange?.(true);
        }
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant === this.currentRemoteParticipant) {
          if (!this.isDisconnecting) {
            this.handleDisconnected();
          }
        }
      })
      .once(RoomEvent.Disconnected, () => {
        logger.debug('[VideoCallSession] Room disconnected', { 
          reason: this.disconnectReason,
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
    logger.info('[VideoCallSession] Track subscribed', {
      kind: publication.kind,
      trackId: track.sid,
      participantId: participant.identity,
      isMuted: track.isMuted,
      trackReady: track.mediaStreamTrack?.readyState,
    });
    
    this.currentRemoteParticipant = participant;
    if (!this.remoteStream) {
      this.remoteStream = new MediaStream();
      logger.debug('[VideoCallSession] Created new remote MediaStream');
    }
    
    const mediaTrack = track.mediaStreamTrack;
    const trackAlreadyInStream = mediaTrack && this.remoteStream.getTracks().includes(mediaTrack as any);
    
    if (mediaTrack && !trackAlreadyInStream) {
      this.remoteStream.addTrack(mediaTrack as any);
      logger.debug('[VideoCallSession] Added track to remote stream', {
        kind: publication.kind,
        streamId: this.remoteStream.id,
        tracksCount: this.remoteStream.getTracks().length,
      });
    }
    
    if (publication.kind === Track.Kind.Audio) {
      this.remoteAudioTrack = track;
    } else if (publication.kind === Track.Kind.Video) {
      this.remoteVideoTrack = track;
      this.remoteCamEnabled = !track.isMuted;
      this.config.callbacks.onRemoteCamStateChange?.(!track.isMuted);
      this.config.onRemoteCamStateChange?.(!track.isMuted);
    }
    
    // КРИТИЧНО: Всегда эмитим remoteStream даже если трек уже был добавлен
    // Это гарантирует обновление UI при изменении треков
    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
    this.emit('remoteStream', this.remoteStream);
    this.config.callbacks.onRemoteStreamChange?.(this.remoteStream);
    this.config.onRemoteStreamChange?.(this.remoteStream);
    
    logger.info('[VideoCallSession] Remote stream updated after track subscription', {
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
      const mediaTrack = this.remoteVideoTrack.mediaStreamTrack;
      if (mediaTrack && this.remoteStream) {
        this.remoteStream.removeTrack(mediaTrack as any);
      }
      this.remoteVideoTrack = null;
      this.remoteCamEnabled = false;
      this.config.callbacks.onRemoteCamStateChange?.(false);
      this.config.onRemoteCamStateChange?.(false);
    }

    const tracksCount = this.remoteStream?.getTracks().length ?? 0;
    if (this.remoteStream && tracksCount === 0) {
      this.remoteStream = null;
      this.emit('remoteStream', null);
      this.config.callbacks.onRemoteStreamChange?.(null);
      this.config.onRemoteStreamChange?.(null);
    }

    this.remoteViewKey = Date.now();
    this.emit('remoteViewKeyChanged', this.remoteViewKey);
  }
}
