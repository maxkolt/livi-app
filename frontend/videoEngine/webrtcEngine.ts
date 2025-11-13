// frontend/videoEngine/webrtcEngine.ts
import { 
  RTCPeerConnection, 
  MediaStream, 
  mediaDevices 
} from 'react-native-webrtc';
import { RemoteRender, VideoEngine } from './types';
import { logger } from '../utils/logger';
import { getIceConfiguration } from '../utils/iceConfig';

export function createWebRTCEngine(): VideoEngine {
  let peerConnection: RTCPeerConnection | null = null;
  let localStream: MediaStream | null = null;
  let remoteStream: MediaStream | null = null;
  let isStarted = false;

  return {
    async start(roomId: string, myUserId: string) {
      logger.debug('Starting WebRTC connection', { roomId, myUserId });
      
      try {
        // Получаем локальный поток с оптимизированными настройками
        localStream = await mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 60 },
            facingMode: 'user'
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
          }
        });

        // Создаем PeerConnection с оптимизированной конфигурацией
        const config = await getIceConfiguration();
        peerConnection = new RTCPeerConnection(config);

        // Добавляем локальные треки
        localStream.getTracks().forEach(track => {
          peerConnection!.addTrack(track, localStream!);
        });

        // Обработчик удаленных треков
        (peerConnection as any).ontrack = (event: any) => {
          logger.debug('Remote track received', { 
            trackKind: event.track.kind,
            trackId: event.track.id 
          });
          remoteStream = event.streams[0];
        };

        // Обработчик изменения состояния соединения
        (peerConnection as any).onconnectionstatechange = () => {
          const state = peerConnection?.connectionState;
          logger.debug('Connection state changed', { state });
          
          // Логируем важные изменения состояния
          if (state === 'connected') {
            logger.info('WebRTC connection established');
          } else if (state === 'failed' || state === 'disconnected') {
            logger.warn('WebRTC connection lost', { state });
          }
        };

        // Обработчик ICE соединения
        (peerConnection as any).oniceconnectionstatechange = () => {
          const state = peerConnection?.iceConnectionState;
          logger.debug('ICE connection state changed', { state });
        };

        // Обработчик ICE кандидатов
        (peerConnection as any).onicecandidate = (event: any) => {
          if (event.candidate) {
            logger.debug('ICE candidate generated', { 
              candidate: event.candidate.candidate,
              sdpMLineIndex: event.candidate.sdpMLineIndex 
            });
          } else {
            logger.debug('ICE gathering complete');
          }
        };

        isStarted = true;
        logger.info('WebRTC engine started successfully');
      } catch (error) {
        logger.error('WebRTC engine start failed:', error);
        throw error;
      }
    },

    async stop() {
      logger.debug('Stopping WebRTC connection');
      
      try {
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
        
        if (localStream) {
          localStream.getTracks().forEach(track => track.stop());
          localStream = null;
        }
        
        remoteStream = null;
        isStarted = false;
        
        logger.debug('WebRTC engine stopped successfully');
      } catch (error) {
        logger.error('WebRTC engine stop failed:', error);
      }
    },

    async enableCamera(on: boolean) {
      logger.debug('Toggle camera', { enabled: on });
      
      if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.enabled = on;
        }
      }
    },

    async enableMic(on: boolean) {
      console.log('[WebRTC Engine] Toggle mic:', on);
      
      if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = on;
        }
      }
    },

    getRemote(): RemoteRender | null {
      if (remoteStream) {
        return {
          kind: 'webrtc',
          streamURL: remoteStream.toURL()
        };
      }
      return null;
    },

    getLocal(): RemoteRender | null {
      if (localStream) {
        return {
          kind: 'webrtc',
          streamURL: localStream.toURL()
        };
      }
      return null;
    },

    getLocalStream() {
      return localStream;
    },

    getType() {
      return 'webrtc';
    }
  };
}
