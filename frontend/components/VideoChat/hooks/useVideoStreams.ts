import { useState, useCallback, useEffect, useRef } from 'react';
import { MediaStream } from 'react-native-webrtc';
import { logger } from '../../../utils/logger';
import { isValidStream } from '../../../utils/streamUtils';

interface UseVideoStreamsProps {
  session: any; // VideoCallSession
  onLocalStreamChange?: (stream: MediaStream | null) => void;
  onRemoteStreamChange?: (stream: MediaStream | null) => void;
  onCamStateChange?: (enabled: boolean) => void;
  onMicStateChange?: (enabled: boolean) => void;
  onRemoteCamStateChange?: (enabled: boolean) => void;
  friendCallAccepted: boolean;
  isInactiveState: boolean;
  acceptCallTimeRef: React.MutableRefObject<number>;
}

/**
 * Хук для управления WebRTC UI стримами
 * Обрабатывает управление локальным/удаленным стримом, обновление renderKey, включение/выключение треков
 */
export const useVideoStreams = ({
  session,
  onLocalStreamChange,
  onRemoteStreamChange,
  onCamStateChange,
  onMicStateChange,
  onRemoteCamStateChange,
  friendCallAccepted,
  isInactiveState,
  acceptCallTimeRef,
}: UseVideoStreamsProps) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // Подписки на события session
  useEffect(() => {
    if (!session) return;

    const handleLocalStream = (stream: MediaStream | null) => {
      const prevStream = localStream;
      logger.info('[useVideoStreams] localStream event received', {
        hasStream: !!stream,
        streamId: stream?.id,
        prevStreamId: prevStream?.id,
        isNew: prevStream !== stream
      });
      
      setLocalStream(stream);

      // КРИТИЧНО: ВСЕГДА обновляем localRenderKey при получении нового стрима
      if (stream) {
        requestAnimationFrame(() => {
          setLocalRenderKey((k: number) => k + 1);
          logger.info('[useVideoStreams] Local stream changed, updating render key', {
            prevStreamId: prevStream?.id,
            newStreamId: stream.id
          });
        });
      }

      // КРИТИЧНО: При создании локального стрима включаем камеру автоматически
      if (stream && isValidStream(stream)) {
        const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          if (!videoTrack.enabled) {
            videoTrack.enabled = true;
          }
          setCamOn(true);
        }

        const audioTrack = (stream as any)?.getAudioTracks?.()?.[0];
        if (audioTrack && audioTrack.readyState === 'live') {
          if (!audioTrack.enabled) {
            audioTrack.enabled = true;
          }
          setMicOn(true);
        }
      }

      onLocalStreamChange?.(stream);
    };

    const handleRemoteStream = (stream: MediaStream | null) => {
      const prevStream = remoteStream;
      if (stream) {
        logger.info('[useVideoStreams] Remote stream received', {
          streamId: stream.id,
          hasVideoTracks: !!(stream as any)?.getVideoTracks?.()?.[0],
          hasAudioTracks: !!(stream as any)?.getAudioTracks?.()?.[0],
          videoTrackEnabled: (stream as any)?.getVideoTracks?.()?.[0]?.enabled,
          videoTrackReadyState: (stream as any)?.getVideoTracks?.()?.[0]?.readyState,
          prevStreamId: prevStream?.id
        });

        setRemoteStream(stream);

        // КРИТИЧНО: ВСЕГДА обновляем remoteViewKey при получении нового стрима
        requestAnimationFrame(() => {
          const currentSession = sessionRef.current;
          if (currentSession) {
            const remoteViewKeyFromSession = (currentSession as any).getRemoteViewKey?.();
            if (remoteViewKeyFromSession !== undefined) {
              setRemoteViewKey(remoteViewKeyFromSession);
              logger.info('[useVideoStreams] Remote view key updated from session', {
                remoteViewKey: remoteViewKeyFromSession,
                streamId: stream.id
              });
            } else {
              setRemoteViewKey((k: number) => k + 1);
              logger.info('[useVideoStreams] Remote view key updated manually', {
                streamId: stream.id
              });
            }
          } else {
            setRemoteViewKey((k: number) => k + 1);
            logger.info('[useVideoStreams] Remote view key updated manually (no session)', {
              streamId: stream.id
            });
          }
        });
      } else {
        logger.info('[useVideoStreams] Remote stream removed');
        setRemoteStream(null);
      }

      onRemoteStreamChange?.(stream);
    };

    const handleRemoteViewKeyChanged = (key: number) => {
      setRemoteViewKey(key);
    };

    session.on('localStream', handleLocalStream);
    session.on('remoteStream', handleRemoteStream);
    session.on('remoteViewKeyChanged', handleRemoteViewKeyChanged);

    return () => {
      session.off('localStream', handleLocalStream);
      session.off('remoteStream', handleRemoteStream);
      session.off('remoteViewKeyChanged', handleRemoteViewKeyChanged);
    };
  }, [session, localStream, remoteStream, onLocalStreamChange, onRemoteStreamChange]);

  // Обработка изменения состояния камеры
  useEffect(() => {
    if (!session) return;

    const handleCamStateChange = (enabled: boolean) => {
      // КРИТИЧНО: При принятии звонка не позволяем отключать камеру только в первые секунды
      const hasActiveCall = friendCallAccepted || !!session.getRoomId?.() || !!session.getCallId?.() || !!session.getPartnerId?.();

      // КРИТИЧНО: Если acceptCallTimeRef не установлен, но есть активный звонок,
      // устанавливаем его сейчас для защиты от отключения камеры
      if (!acceptCallTimeRef.current && hasActiveCall && !isInactiveState) {
        acceptCallTimeRef.current = Date.now();
        logger.info('[useVideoStreams] Устанавливаем acceptCallTimeRef при изменении состояния камеры в активном звонке', {
          enabled,
          friendCallAccepted,
        });
      }

      const timeSinceAccept = Date.now() - (acceptCallTimeRef.current || 0);
      const isJustAccepted = timeSinceAccept < 30000; // 30 секунд защита

      // КРИТИЧНО: Защита от отключения камеры работает в первые 30 секунд после принятия звонка
      if (!enabled && hasActiveCall && !isInactiveState && isJustAccepted) {
        const currentStream = localStream;
        if (currentStream) {
          const videoTrack = (currentStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack && videoTrack.readyState === 'live') {
            videoTrack.enabled = true;
            logger.info('[useVideoStreams] Принудительно включаем камеру при попытке отключения сразу после принятия звонка', {
              timeSinceAccept,
            });
            setCamOn(true);
            return;
          }
        }

        logger.info('[useVideoStreams] Игнорируем отключение камеры сразу после принятия звонка', {
          timeSinceAccept,
        });
        return;
      }

      // КРИТИЧНО: Если камера включается и звонок только что принят, гарантируем включение
      if (enabled && isJustAccepted && hasActiveCall && !isInactiveState) {
        logger.info('[useVideoStreams] Гарантируем включение камеры после принятия звонка');
        setCamOn(true);
        return;
      }

      // КРИТИЧНО: После 30 секунд после принятия звонка позволяем пользователю свободно управлять камерой
      if (!enabled) {
        const pipManager = (session as any)?.pipManager;
        if (pipManager && typeof pipManager.markCameraManuallyDisabled === 'function') {
          pipManager.markCameraManuallyDisabled();
          logger.info('[useVideoStreams] Камера выключена пользователем вручную');
        }
      }

      setCamOn(enabled);
      onCamStateChange?.(enabled);
    };

    const handleMicStateChange = (enabled: boolean) => {
      setMicOn(enabled);
      onMicStateChange?.(enabled);
    };

    const handleRemoteCamStateChange = (enabled: boolean) => {
      logger.info('[useVideoStreams] Remote camera state changed', {
        enabled,
        previousValue: remoteCamOn,
        hasRemoteStream: !!remoteStream,
        remoteViewKey
      });
      setRemoteCamOn(enabled);
      onRemoteCamStateChange?.(enabled);
    };

    const handleRemoteState = ({ muted }: { muted?: boolean }) => {
      if (muted !== undefined) {
        setRemoteMuted(muted);
      }
    };

    // Подписываемся на события через callbacks в config
    // Эти события уже обрабатываются в session через config callbacks
    // Но мы также можем подписаться напрямую если нужно

    return () => {
      // Cleanup если нужно
    };
  }, [session, localStream, friendCallAccepted, isInactiveState, acceptCallTimeRef, remoteCamOn, remoteStream, remoteViewKey, onCamStateChange, onMicStateChange, onRemoteCamStateChange]);

  return {
    localStream,
    remoteStream,
    camOn,
    micOn,
    remoteCamOn,
    remoteMuted,
    remoteViewKey,
    localRenderKey,
    setLocalStream,
    setRemoteStream,
    setCamOn,
    setMicOn,
    setRemoteCamOn,
    setRemoteMuted,
    setRemoteViewKey,
    setLocalRenderKey,
  };
};
