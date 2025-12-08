/**
 * VideoCall - Компонент для видеозвонка другу
 * Использует общие компоненты: VideoView, MediaControls, VoiceEqualizerWrapper
 * Имеет кнопку: Завершить
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Platform,
  Animated,
  BackHandler,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MediaStream } from 'react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { VideoCallSession } from '../../src/webrtc/sessions/VideoCallSession';
import type { WebRTCSessionConfig } from '../../src/webrtc/types';
import { MediaControls } from './shared/MediaControls';
import { LocalVideo } from './shared/LocalVideo';
import { RemoteVideo } from './shared/RemoteVideo';
import { IncomingCallModal } from './shared/IncomingCallModal';
import VoiceEqualizer from '../VoiceEqualizer';
import { t, loadLang, defaultLang } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import { usePiP } from '../../src/pip/PiPContext';
import { fetchFriends } from '../../sockets/socket';
import socket from '../../sockets/socket';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import { useAudioRouting } from './hooks/useAudioRouting';
import { usePiP as usePiPHook } from './hooks/usePiP';
import { useIncomingCall } from './hooks/useIncomingCall';

type Props = { 
  route?: { 
    params?: { 
      myUserId?: string;
      peerUserId?: string;
      directCall?: boolean;
      directInitiator?: boolean;
      callId?: string;
      roomId?: string;
      returnTo?: { name: string; params?: any };
      resume?: boolean;
      fromPiP?: boolean;
    } 
  } 
};

const CARD_BASE = {
  backgroundColor: 'rgba(13,14,16,0.85)',
  borderRadius: 10,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  overflow: 'hidden' as const,
  marginVertical: 7,
};


const VideoCall: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const { theme, isDark } = useAppTheme();
  
  const [lang, setLang] = useState<Lang>(defaultLang);
  const [friends, setFriends] = useState<any[]>([]);
  const myUserId = route?.params?.myUserId;
  
  // Состояния
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(route?.params?.peerUserId || null);
  const [roomId, setRoomId] = useState<string | null>(route?.params?.roomId || null);
  const [callId, setCallId] = useState<string | null>(route?.params?.callId || null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  // КРИТИЧНО: Синхронизируем ref с state для использования в callbacks
  // Это fallback на случай, если ref не был обновлен синхронно
  useEffect(() => {
    remoteStreamRef.current = remoteStream;
  }, [remoteStream]);
  
  // КРИТИЧНО: Проверяем session на наличие стрима, если state еще не обновился
  // Это решает проблему race condition, когда стрим есть в session, но state еще null
  useEffect(() => {
    if (!remoteStream && sessionRef.current && (partnerId || roomId || callId)) {
      const sessionStream = sessionRef.current.getRemoteStream?.() as MediaStream | null | undefined;
      const currentRefStream = remoteStreamRef.current;
      if (sessionStream) {
        const sessionStreamId = (sessionStream as any)?.id;
        const refStreamId = currentRefStream ? (currentRefStream as any)?.id : undefined;
        if (!currentRefStream || sessionStreamId !== refStreamId) {
          logger.warn('[VideoCall] ⚠️ Stream exists in session but not in state, updating from session', {
            sessionStreamId,
            refStreamId,
            hasStateStream: !!remoteStream
          });
          // Обновляем ref и state синхронно
          remoteStreamRef.current = sessionStream;
          setRemoteStream(sessionStream);
        }
      }
    }
  }, [remoteStream, partnerId, roomId, callId]);
  
  // КРИТИЧНО: Отслеживаем изменения remoteStream для отладки
  useEffect(() => {
    logger.info('[VideoCall] remoteStream state changed', {
      streamId: remoteStream?.id,
      hasStream: !!remoteStream,
      hasVideo: !!(remoteStream as any)?.getVideoTracks?.()?.[0],
      hasAudio: !!(remoteStream as any)?.getAudioTracks?.()?.[0],
      stackTrace: new Error().stack?.split('\n').slice(1, 8).join('\n')
    });
  }, [remoteStream]);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [wasFriendCallEnded, setWasFriendCallEnded] = useState(false);
  const [friendCallAccepted, setFriendCallAccepted] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(1));
  
  const currentCallIdRef = useRef<string | null>(route?.params?.callId || null);
  const acceptCallTimeRef = useRef<number>(0);
  const sessionRef = useRef<VideoCallSession | null>(null);
  
  // Используем хуки
  const pip = usePiP();
  const pipRef = useRef(pip);
  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);
  
  // Хук для входящих звонков
  const incomingCallHook = useIncomingCall({
    myUserId,
    routeParams: route?.params,
    friendCallAccepted,
    currentCallIdRef,
    session: sessionRef.current,
    onAccept: async (callId: string, fromUserId: string) => {
      if (fromUserId) {
        setPartnerUserId(fromUserId);
      }
      if (callId) {
        currentCallIdRef.current = callId;
      }
      acceptCallTimeRef.current = Date.now();
      setFriendCallAccepted(true);
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      setStarted(true);
      setCamOn(true);
      setMicOn(true);
    },
    onDecline: () => {},
  });
  
  // Хук для PiP
  const { enterPiPMode, panResponder } = usePiPHook({
    roomId,
    callId,
    partnerId,
    partnerUserId,
    isInactiveState,
    wasFriendCallEnded,
    micOn,
    remoteMuted,
    localStream,
    remoteStream,
    friends,
    routeParams: route?.params,
    session: sessionRef.current,
    acceptCallTimeRef,
  });
  
  // Хук для аудио-рутирования
  const hasActiveCallForAudio = !!partnerId || !!roomId || !!callId;
  // КРИТИЧНО: Вычисляем currentRemoteStream каждый раз при рендере, чтобы он всегда был актуальным
  // Это решает проблему, когда remoteStream в состоянии еще null, но в ref уже есть
  // Вычисляем напрямую каждый раз при рендере, так как это дешевая операция
  const currentRemoteStream: MediaStream | null = remoteStreamRef.current || remoteStream || (sessionRef.current?.getRemoteStream?.() ?? null);
  const { forceSpeakerOnHard } = useAudioRouting(hasActiveCallForAudio && !isInactiveState, currentRemoteStream);
  
  // Refs
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const isInactiveStateRef = useRef(false);
  useEffect(() => { isInactiveStateRef.current = isInactiveState; }, [isInactiveState]);
  
  // Дополнительные refs для видеозвонка
  const pipReturnUpdateRef = useRef(false);
  const lastRouteParamsRef = useRef<any>(null);
  const callOriginRef = useRef<{ name: string; params?: any } | null>(null);
  const friendsRef = useRef(friends);
  
  // Обновляем friendsRef при изменении friends
  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);
  
  // Отслеживание изменений параметров роута
  useEffect(() => {
    const currentParams = route?.params;
    if (lastRouteParamsRef.current !== currentParams) {
      lastRouteParamsRef.current = currentParams;
      // Сбрасываем флаг обработки возврата из PiP если параметры изменились
      if (!(currentParams?.resume && currentParams?.fromPiP)) {
        fromPiPProcessedRef.current = false;
      }
    }
  }, [route?.params]);
  
  // Загрузка языка и друзей
  useEffect(() => {
    (async () => {
      setLang(await loadLang());
      
      // Загружаем список друзей
      try {
        const r = await fetchFriends();
        const friendsList = r?.list || [];
        setFriends(friendsList);
      } catch (e) {
        logger.warn('[VideoCall] Failed to load friends:', e);
      }
    })();
  }, []);
  
  // Отправка статуса "busy" при активном общении в видеозвонке
  useEffect(() => {
    const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState;
    
    if (hasActiveCall) {
      // Отправляем статус "busy" когда есть активное общение
      try {
        socket.emit('presence:update', { status: 'busy', roomId: roomId || callId || undefined });
      } catch (e) {
        logger.warn('[VideoCall] Error sending presence:update busy:', e);
      }
    }
  }, [roomId, callId, partnerId, isInactiveState]);
  
  // Используем функции из хука входящих звонков
  const { getDeclinedBlock, clearDeclinedBlock, setDeclinedBlock } = incomingCallHook;
  
  // Функция отправки состояния камеры
  const sendCameraState = useCallback(() => {
    const session = sessionRef.current;
    if (session && roomId) {
      const videoTrack = localStream?.getVideoTracks()?.[0];
      const enabled = videoTrack?.enabled ?? true;
      session.sendCameraState?.(undefined, enabled);
    }
  }, [localStream, roomId]);
  
  const L = useCallback((key: string) => t(key, lang), [lang]);
  
  // Восстановление стримов при возврате из PiP (если session уже существует)
  useEffect(() => {
    const resume = !!route?.params?.resume;
    const fromPiP = !!route?.params?.fromPiP;
    const session = sessionRef.current;
    
    // Если возвращаемся из PiP и session уже существует, восстанавливаем стримы
    if (resume && fromPiP && session) {
      const pipLocalStream = pip.localStream;
      const pipRemoteStream = pip.remoteStream;
      
      logger.info('[VideoCall] Восстанавливаем стримы из PiP для существующей session', {
        hasPipLocalStream: !!pipLocalStream,
        hasPipRemoteStream: !!pipRemoteStream,
        hasSession: !!session,
        fromPiPProcessed: fromPiPProcessedRef.current
      });
      
      // Восстанавливаем стримы только если они есть в PiP
      if (pipLocalStream) {
        setLocalStream(pipLocalStream);
        setLocalRenderKey((k: number) => k + 1);
        
        // Проверяем и обновляем состояние камеры
        const videoTrack = (pipLocalStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack) {
          // Убеждаемся, что камера включена если она была включена
          if (videoTrack.enabled && !camOn) {
            setCamOn(true);
            logger.info('[VideoCall] Состояние camOn обновлено после восстановления стрима из PiP');
          } else if (!videoTrack.enabled && videoTrack.readyState === 'live') {
            // Если трек live, но выключен - включаем его
            videoTrack.enabled = true;
            setCamOn(true);
            logger.info('[VideoCall] Камера включена после восстановления стрима из PiP');
          }
        }
      }
      
      if (pipRemoteStream) {
        setRemoteStream(pipRemoteStream);
      }
      
      // Вызываем resumeFromPiP для восстановления стримов в session
      if (session.resumeFromPiP) {
        session.resumeFromPiP().catch((e) => {
          logger.warn('[VideoCall] Error resuming from PiP:', e);
        });
      }
      
      // Вызываем exitPiP для восстановления камеры
      // Это важно - exitPiP восстанавливает камеру из pipPrevCamOnRef
      if (session.exitPiP) {
        session.exitPiP();
      }
      
      // Дополнительная проверка: убеждаемся, что камера включена после восстановления
      // Используем несколько попыток, так как стрим может обновиться с задержкой
      const enableCameraAfterRestore = (attempts = 0) => {
        const currentLocalStream = session.getLocalStream?.() || pipLocalStream;
        if (currentLocalStream) {
          const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            // Если трек live, но выключен - включаем его
            if (videoTrack.readyState === 'live' && !videoTrack.enabled) {
              videoTrack.enabled = true;
              setCamOn(true);
              logger.info('[VideoCall] Камера принудительно включена после восстановления из PiP', { attempt: attempts + 1 });
            } else if (videoTrack.enabled && !camOn) {
              // Если трек включен, но camOn не обновлен - обновляем
              setCamOn(true);
              logger.info('[VideoCall] Состояние camOn обновлено после восстановления из PiP', { attempt: attempts + 1 });
            }
          } else if (attempts < 3) {
            // Если трека еще нет, повторяем через 200ms
            setTimeout(() => enableCameraAfterRestore(attempts + 1), 200);
          }
        } else if (attempts < 3) {
          // Если стрима еще нет, повторяем через 200ms
          setTimeout(() => enableCameraAfterRestore(attempts + 1), 200);
        }
      };
      
      // Первая попытка сразу, затем с задержками
      enableCameraAfterRestore();
      setTimeout(() => enableCameraAfterRestore(1), 200);
      setTimeout(() => enableCameraAfterRestore(2), 500);
    }
  }, [route?.params?.resume, route?.params?.fromPiP, pip.localStream, pip.remoteStream]);
  
  // Инициализация session и восстановление состояния звонка
  useEffect(() => {
    // Не пересоздаем сессию если она уже существует
    if (sessionRef.current) {
      logger.info('[VideoCall] Session already exists, skipping creation');
      return;
    }
    
    const isDirectCall = !!route?.params?.directCall;
    const isDirectInitiator = !!route?.params?.directInitiator;
    const resume = !!route?.params?.resume;
    const fromPiP = !!route?.params?.fromPiP;
    
    logger.info('[VideoCall] Creating new VideoCallSession', {
      isDirectCall,
      isDirectInitiator,
      resume,
      fromPiP
    });
    
    const config: WebRTCSessionConfig = {
      myUserId: route?.params?.myUserId,
      callbacks: {
        onLocalStreamChange: (stream) => {
          const prevStream = localStream;
          setLocalStream(stream);
          
          // КРИТИЧНО: Принудительно обновляем localRenderKey при изменении стрима
          if (prevStream !== stream || (prevStream && stream && prevStream.id !== stream.id)) {
            setLocalRenderKey((k: number) => k + 1);
            logger.info('[VideoCall] Local stream changed, updating render key', {
              prevStreamId: prevStream?.id,
              newStreamId: stream?.id
            });
          }
          
          if (stream) {
            const videoTrack = stream.getVideoTracks()?.[0];
            const audioTrack = stream.getAudioTracks()?.[0];
            
            // КРИТИЧНО: При создании стрима камера должна быть включена по умолчанию
            // ВСЕГДА включаем треки при создании стрима, особенно при принятии звонка
            if (videoTrack) {
              // Включаем трек если он выключен
              if (!videoTrack.enabled) {
                videoTrack.enabled = true;
              }
              // КРИТИЧНО: При принятии звонка камера должна быть включена
              // Устанавливаем camOn в true независимо от начального состояния трека
              setCamOn(true);
            } else {
              setCamOn(true); // Если трека нет, считаем что камера включена
            }
            
            if (audioTrack) {
              // Включаем трек если он выключен
              if (!audioTrack.enabled) {
                audioTrack.enabled = true;
              }
              setMicOn(true);
            } else {
              setMicOn(true); // Если трека нет, считаем что микрофон включен
            }
          }
        },
        onRemoteStreamChange: (stream) => {
          // КРИТИЧНО: Используем ref для получения актуального значения, а не замыкание
          // Это решает проблему race condition с асинхронными React state updates
          const prevStream = remoteStreamRef.current;
          logger.info('[VideoCall] onRemoteStreamChange called', {
            prevStreamId: prevStream?.id,
            newStreamId: stream?.id,
            prevStreamExists: !!prevStream,
            newStreamExists: !!stream,
            stackTrace: new Error().stack
          });
          // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState, чтобы избежать race condition
          remoteStreamRef.current = stream;
          setRemoteStream(stream);
          
          // КРИТИЧНО: Принудительно обновляем remoteViewKey при изменении стрима
          if (prevStream !== stream || (prevStream && stream && prevStream.id !== stream.id)) {
            setRemoteViewKey((k: number) => k + 1);
            logger.info('[VideoCall] Remote stream changed, updating view key', {
              prevStreamId: prevStream?.id,
              newStreamId: stream?.id
            });
          }
        },
        onPartnerIdChange: (id) => {
          setPartnerId(id);
        },
        onRoomIdChange: (id) => {
          setRoomId(id);
        },
        onCallIdChange: (id) => {
          setCallId(id);
        },
        onMicStateChange: (enabled) => {
          setMicOn(enabled);
        },
        onCamStateChange: (enabled) => {
          // КРИТИЧНО: При принятии звонка не позволяем отключать камеру только в первые секунды
          const hasActiveCall = friendCallAccepted || !!roomId || !!callId || !!partnerId;
          
          // КРИТИЧНО: Если acceptCallTimeRef не установлен, но есть активный звонок,
          // устанавливаем его сейчас для защиты от отключения камеры
          // Это важно, если onCamStateChange вызывается до установки acceptCallTimeRef
          if (!acceptCallTimeRef.current && hasActiveCall && !isInactiveState) {
            acceptCallTimeRef.current = Date.now();
            logger.info('[VideoCall] Устанавливаем acceptCallTimeRef при изменении состояния камеры в активном звонке', {
              enabled,
              friendCallAccepted,
              roomId,
              callId,
              partnerId
            });
          }
          
          const timeSinceAccept = Date.now() - (acceptCallTimeRef.current || 0);
          // КРИТИЧНО: Увеличиваем время защиты до 30 секунд для предотвращения отключения камеры при входе в PiP
          const isJustAccepted = timeSinceAccept < 30000; // 30 секунд защита
          
          // КРИТИЧНО: Защита от отключения камеры работает в первые 30 секунд после принятия звонка
          // Это предотвращает отключение камеры при автоматическом входе в PiP
          // После этого пользователь может свободно включать/выключать камеру
          if (!enabled && hasActiveCall && !isInactiveState && isJustAccepted) {
            // Проверяем фактическое состояние трека
            const currentStream = localStream;
            if (currentStream) {
              const videoTrack = (currentStream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack && videoTrack.readyState === 'live') {
                // Трек live - принудительно включаем камеру только если звонок только что принят
                videoTrack.enabled = true;
                logger.info('[VideoCall] Принудительно включаем камеру при попытке отключения сразу после принятия звонка', {
                  timeSinceAccept,
                  friendCallAccepted,
                  roomId,
                  callId,
                  partnerId
                });
                setCamOn(true);
                return; // Не обновляем состояние на false
              }
            }
            
            // Если звонок только что принят, игнорируем отключение
            logger.info('[VideoCall] Игнорируем отключение камеры сразу после принятия звонка', {
              timeSinceAccept,
              friendCallAccepted,
              roomId,
              callId,
              partnerId
            });
            return; // Не обновляем состояние
          }
          
          // КРИТИЧНО: Если камера включается и звонок только что принят, гарантируем включение
          if (enabled && isJustAccepted && hasActiveCall && !isInactiveState) {
            logger.info('[VideoCall] Гарантируем включение камеры после принятия звонка');
            setCamOn(true);
            return;
          }
          
          // КРИТИЧНО: После 30 секунд после принятия звонка позволяем пользователю свободно управлять камерой
          // Если пользователь выключает камеру вручную (не из PiP или background), отмечаем это
          if (!enabled) {
            const session = sessionRef.current;
            const pipManager = (session as any)?.pipManager;
            if (pipManager && typeof pipManager.markCameraManuallyDisabled === 'function') {
              // КРИТИЧНО: Отмечаем, что пользователь сам выключил камеру
              // Это предотвратит автоматическое восстановление камеры при выходе из PiP
              pipManager.markCameraManuallyDisabled();
              logger.info('[VideoCall] Камера выключена пользователем вручную');
            }
          }
          
          setCamOn(enabled);
        },
        onRemoteCamStateChange: (enabled) => {
          // КРИТИЧНО: Получаем актуальный remoteStream из ref или session, а не из состояния компонента
          // Это решает проблему race condition между setRemoteStream и onRemoteCamStateChange
          // Сначала проверяем ref (он обновляется синхронно), затем session (fallback)
          const streamFromRef = remoteStreamRef.current;
          const streamFromSession = sessionRef.current?.getRemoteStream?.();
          const currentRemoteStream = streamFromRef || streamFromSession;
          
          logger.info('[VideoCall] ✅ Remote camera state changed', {
            enabled,
            previousValue: remoteCamOn,
            hasRemoteStream: !!remoteStream,
            hasRemoteStreamFromRef: !!streamFromRef,
            hasRemoteStreamFromSession: !!streamFromSession,
            hasCurrentRemoteStream: !!currentRemoteStream,
            remoteViewKey,
            streamId: remoteStream?.id,
            streamIdFromRef: streamFromRef?.id,
            streamIdFromSession: streamFromSession?.id,
            streamIdCurrent: currentRemoteStream?.id
          });
          
          // КРИТИЧНО: Если стрим есть в session, но не в ref, обновляем ref синхронно
          if (streamFromSession && !streamFromRef) {
            logger.warn('[VideoCall] ⚠️ Stream exists in session but not in ref, updating ref synchronously');
            remoteStreamRef.current = streamFromSession;
          }
          
          // КРИТИЧНО: Для дружеских звонков всегда устанавливаем remoteCamOn=true при получении стрима
          // Это гарантирует, что видео будет показано
          if (enabled && !remoteCamOn && remoteStream) {
            logger.info('[VideoCall] ⚠️ Устанавливаем remoteCamOn=true при получении стрима для дружеского звонка');
          }
          
          setRemoteCamOn(enabled);
        },
        onMicLevelChange: (level) => {
          setMicLevel(level);
        },
        onPcConnectedChange: (connected) => {
          // Обработка изменения состояния подключения
        },
      },
      getIsDirectCall: () => isDirectCall,
      getIsDirectInitiator: () => isDirectInitiator,
      getInDirectCall: () => false,
      setInDirectCall: () => {},
      getFriendCallAccepted: () => friendCallAccepted,
      setFriendCallAccepted: (value) => setFriendCallAccepted(value),
      getIsInactiveState: () => isInactiveState,
      setIsInactiveState: (value) => setIsInactiveState(value),
      getStarted: () => started,
      setStarted: (value) => setStarted(value),
      getWasFriendCallEnded: () => wasFriendCallEnded,
      setWasFriendCallEnded: (value) => setWasFriendCallEnded(value),
      getDeclinedBlock: () => getDeclinedBlock(),
      clearDeclinedBlock: () => clearDeclinedBlock(),
      getIncomingFriendCall: () => incomingCallHook.incomingFriendCall,
      getHasIncomingCall: () => !!incomingCallHook.incomingFriendCall || !!incomingCallHook.incomingCall,
      sendCameraState: (toPartnerId?: string, enabled?: boolean) => {
        const session = sessionRef.current;
        if (session) {
          // sendCameraState вызывается через session
        }
      },
      getPipLocalStream: () => pip.localStream,
      getPipRemoteStream: () => pip.remoteStream,
    };
    
    const session = new VideoCallSession(config);
    sessionRef.current = session;
    
    // Восстановление состояния звонка при возврате из PiP или при инициации
    if (resume && fromPiP) {
      // Восстанавливаем состояние из PiP
      const pipLocalStream = pip.localStream;
      const pipRemoteStream = pip.remoteStream;
      
      if (pipLocalStream) {
        setLocalStream(pipLocalStream);
      }
      if (pipRemoteStream) {
        setRemoteStream(pipRemoteStream);
      }
      
      session.resumeFromPiP?.();
    } else if (isDirectCall && isDirectInitiator && route?.params?.peerUserId) {
      // Инициация звонка другу
      const friendId = route.params.peerUserId;
      setPartnerUserId(friendId);
      setStarted(true);
      setLoading(true);
      
      // Запускаем звонок
      session.callFriend(friendId).catch((e) => {
        logger.error('[VideoCall] Error calling friend:', e);
        setStarted(false);
        setLoading(false);
      });
    } else if (route?.params?.roomId || route?.params?.callId) {
      // Восстановление активного звонка
      if (route.params.roomId) {
        setRoomId(route.params.roomId);
      }
      if (route.params.callId) {
        setCallId(route.params.callId);
        currentCallIdRef.current = route.params.callId;
      }
      if (route.params.peerUserId) {
        setPartnerUserId(route.params.peerUserId);
      }
      
      // Восстанавливаем состояние звонка через session
      session.restoreCallState?.({
        roomId: route.params.roomId || null,
        partnerId: null,
        callId: route.params.callId || null,
        partnerUserId: route.params.peerUserId || null,
        returnToActiveCall: true,
        isFromBackground: false,
      });
    }
    
    // Подписки на события
    session.on('localStream', (stream) => {
      const prevStream = localStream;
      logger.info('[VideoCall] localStream event received', {
        hasStream: !!stream,
        streamId: stream?.id,
        prevStreamId: prevStream?.id,
        isNew: prevStream !== stream
      });
      setLocalStream(stream);
      
      // КРИТИЧНО: ВСЕГДА обновляем localRenderKey при получении нового стрима
      // Это гарантирует обновление видео в UI
      if (stream) {
        // Используем requestAnimationFrame для гарантированного обновления после setState
        requestAnimationFrame(() => {
          setLocalRenderKey((k: number) => k + 1);
          logger.info('[VideoCall] Local stream changed, updating render key', {
            prevStreamId: prevStream?.id,
            newStreamId: stream.id
          });
          logger.info('[VideoCall] Local stream changed, updating render key', {
            prevStreamId: prevStream?.id,
            newStreamId: stream.id
          });
        });
      }
      
      // КРИТИЧНО: При создании локального стрима включаем камеру автоматически
      // Это особенно важно при принятии звонка
      if (stream && isValidStream(stream)) {
        const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          // Включаем трек если он выключен
          if (!videoTrack.enabled) {
            videoTrack.enabled = true;
          }
          // Обновляем состояние камеры
          setCamOn(true);
          // Отправляем состояние камеры партнеру
          setTimeout(() => {
            sendCameraState();
          }, 100);
        }
      }
    });
    
    session.on('remoteStream', (stream) => {
      // КРИТИЧНО: Используем ref для получения актуального значения, а не замыкание
      const prevStream = remoteStreamRef.current;
      
      // КРИТИЧНО: Получаем актуальное состояние звонка из замыкания
      const currentWasFriendCallEnded = wasFriendCallEnded;
      const currentStarted = started;
      const currentPartnerId = partnerId;
      const currentRoomId = roomId;
      const currentCallId = callId;
      
      logger.info('[VideoCall] session.on(remoteStream) event received', {
        prevStreamId: prevStream?.id,
        newStreamId: stream?.id,
        prevStreamExists: !!prevStream,
        newStreamExists: !!stream,
        wasFriendCallEnded: currentWasFriendCallEnded,
        started: currentStarted,
        hasActiveCall: !!(currentPartnerId || currentRoomId || currentCallId)
      });
      // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState, чтобы избежать race condition
      remoteStreamRef.current = stream;
      
      if (stream) {
        const videoTrack = (stream as any)?.getVideoTracks?.()?.[0];
        const audioTracks = (stream as any)?.getAudioTracks?.() || [];
        const audioTrack = audioTracks[0];
        
        logger.info('[VideoCall] Remote stream received', {
          streamId: stream.id,
          hasVideoTracks: !!videoTrack,
          hasAudioTracks: audioTracks.length > 0,
          videoTrackEnabled: videoTrack?.enabled,
          videoTrackReadyState: videoTrack?.readyState,
          audioTrackEnabled: audioTrack?.enabled,
          audioTrackReadyState: audioTrack?.readyState,
          prevStreamId: prevStream?.id,
          isNewStream: prevStream?.id !== stream.id,
          currentStarted: started,
          remoteMuted
        });
        
        // КРИТИЧНО: Устанавливаем стрим сразу
        logger.info('[VideoCall] Setting remoteStream state', { streamId: stream.id });
        // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState, чтобы избежать race condition
        remoteStreamRef.current = stream;
        setRemoteStream(stream);
        
        // КРИТИЧНО: Включаем аудио трек если он есть и не muted
        // Проверяем все аудио треки и включаем их
        if (audioTracks.length > 0) {
          audioTracks.forEach((track: any, index: number) => {
            if (track && !remoteMuted && !track.enabled) {
              track.enabled = true;
              logger.info('[VideoCall] Аудио трек включен при получении remoteStream', {
                trackId: track.id,
                trackIndex: index,
                streamId: stream.id,
                remoteMuted,
                wasEnabled: false
              });
            } else if (track && remoteMuted && track.enabled) {
              // Если muted, выключаем трек
              track.enabled = false;
              logger.info('[VideoCall] Аудио трек выключен (muted) при получении remoteStream', {
                trackId: track.id,
                trackIndex: index,
                streamId: stream.id
              });
            }
          });
        }
        
        // КРИТИЧНО: Если started еще false, устанавливаем его при получении remoteStream
        // Это гарантирует, что видео будет показано даже если callAnswered еще не сработал
        if (!started) {
          logger.info('[VideoCall] Устанавливаем started=true при получении remoteStream');
          setStarted(true);
          setLoading(false);
          setIsInactiveState(false);
        }
        
        // КРИТИЧНО: ВСЕГДА обновляем remoteViewKey при получении нового стрима
        // Это гарантирует обновление видео в UI
        // Обновляем несколько раз для надежности
        const updateViewKey = () => {
          const currentSession = sessionRef.current;
          if (currentSession) {
            const remoteViewKeyFromSession = (currentSession as any).getRemoteViewKey?.();
            if (remoteViewKeyFromSession !== undefined) {
              setRemoteViewKey(remoteViewKeyFromSession);
              logger.info('[VideoCall] Remote view key updated from session', {
                remoteViewKey: remoteViewKeyFromSession,
                streamId: stream.id
              });
            } else {
              // Если session не предоставляет ключ, обновляем вручную
              setRemoteViewKey((k: number) => {
                const newKey = k + 1;
                logger.info('[VideoCall] Remote view key updated manually', {
                  newKey,
                  oldKey: k,
                  streamId: stream.id
                });
                return newKey;
              });
            }
          } else {
            // Если session еще нет, обновляем вручную
            setRemoteViewKey((k: number) => {
              const newKey = k + 1;
              logger.info('[VideoCall] Remote view key updated manually (no session)', {
                newKey,
                oldKey: k,
                streamId: stream.id
              });
              return newKey;
            });
          }
        };
        
        // Обновляем сразу и с задержками для гарантии
        updateViewKey();
        requestAnimationFrame(updateViewKey);
        setTimeout(updateViewKey, 50);
        setTimeout(updateViewKey, 200);
      } else {
        // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState
        remoteStreamRef.current = null;
        setRemoteStream(null);
        
        // КРИТИЧНО: Не показываем предупреждение, если звонок завершается
        // Это нормальное поведение при endCall() - remoteStream должен стать null
        // Проверяем несколько условий:
        // 1. Если звонок уже завершен (wasFriendCallEnded)
        // 2. Если нет активного звонка (нет partnerId/roomId/callId)
        // 3. Если started = false (звонок не был начат)
        // 4. Если prevStream был null (это не удаление, а просто отсутствие стрима)
        const hasActiveCall = !!partnerId || !!roomId || !!callId;
        const isCallEnding = wasFriendCallEnded || !started || !hasActiveCall;
        const wasStreamNull = !prevStream;
        
        // КРИТИЧНО: Показываем предупреждение ТОЛЬКО если:
        // 1. Звонок действительно активен (hasActiveCall = true)
        // 2. Звонок не завершается (isCallEnding = false)
        // 3. Был реальный стрим, который удалился (wasStreamNull = false)
        if (!isCallEnding && hasActiveCall && !wasStreamNull) {
          // Только если звонок действительно активен и не завершается - показываем предупреждение
          logger.warn('[VideoCall] ⚠️ Remote stream removed event received during active call', {
            prevStreamId: prevStream?.id,
            hasActiveCall,
            started,
            wasFriendCallEnded,
            isCallEnding,
            wasStreamNull
          });
        } else {
          // Это нормальное поведение - звонок завершается, уже завершен, или стрима не было
          logger.info('[VideoCall] Remote stream removed event received (normal - call ending/ended or no stream)', {
            prevStreamId: prevStream?.id,
            hasActiveCall,
            started,
            wasFriendCallEnded,
            isCallEnding,
            wasStreamNull
          });
        }
      }
    });
    
    session.on('remoteViewKeyChanged', (key) => {
      setRemoteViewKey(key);
    });
    
    session.on('callEnded', () => {
      // Закрываем PiP если открыт
      if (pipRef.current.visible) {
        pipRef.current.hidePiP();
        sessionRef.current?.exitPiP?.();
      }
      
      // КРИТИЧНО: Останавливаем локальный стрим (камера и микрофон)
      // Останавливаем все треки локального стрима
      if (localStream) {
        try {
          const tracks = localStream.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              if (t && t.readyState !== 'ended') {
                t.enabled = false;
                t.stop();
                try { (t as any).release?.(); } catch {}
              }
            } catch (e) {
              logger.warn('[VideoCall] Error stopping local track in callEnded:', e);
            }
          });
        } catch (e) {
          logger.warn('[VideoCall] Error stopping local stream in callEnded:', e);
        }
      }
      
      incomingCallHook.setIncomingOverlay(false);
      incomingCallHook.setIncomingFriendCall(null);
      incomingCallHook.setIncomingCall(null);
      
      setIsInactiveState(true);
      setWasFriendCallEnded(true);
      setFriendCallAccepted(false);
      setPartnerUserId(null);
      setRemoteViewKey(0);
      setLocalRenderKey((k: number) => k + 1);
      setLoading(false);
      setStarted(false);
      setCamOn(false);
      setMicOn(false);
      setLocalStream(null); // КРИТИЧНО: Очищаем локальный стрим
      // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState
      remoteStreamRef.current = null;
      setRemoteStream(null); // КРИТИЧНО: Очищаем удаленный стрим
    });
    
    session.on('callAnswered', () => {
      // КРИТИЧНО: Сохраняем время принятия звонка для задержки автоматического PiP
      acceptCallTimeRef.current = Date.now();
      
      logger.info('[VideoCall] callAnswered event received - устанавливаем состояния для показа видео');
      
      setFriendCallAccepted(true);
      setIsInactiveState(false); // КРИТИЧНО: Убираем неактивное состояние для показа видео
      setWasFriendCallEnded(false);
      setStarted(true); // КРИТИЧНО: Устанавливаем started для показа видео
      setLoading(false); // КРИТИЧНО: Убираем loading для показа видео
      incomingCallHook.setIncomingOverlay(false);
      
      // КРИТИЧНО: Включаем камеру при принятии звонка
      // У принимающего звонок камера должна быть включена изначально
      setCamOn(true);
      setMicOn(true);
      
      // КРИТИЧНО: Принудительно включаем камеру в стриме
      // Используем несколько попыток, так как localStream может обновиться с задержкой
      const enableCameraWithRetries = (attempts = 0) => {
        const currentSession = sessionRef.current;
        const currentLocalStream = currentSession?.getLocalStream?.() || localStream;
        
        if (currentLocalStream) {
          const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            if (!videoTrack.enabled) {
              videoTrack.enabled = true;
              setCamOn(true);
              logger.info('[VideoCall] Камера принудительно включена в callAnswered', { attempt: attempts + 1 });
            }
            // Отправляем состояние камеры партнеру
            try {
              currentSession?.sendCameraState?.(undefined, true);
            } catch (e) {
              logger.warn('[VideoCall] Error sending camera state in callAnswered:', e);
            }
          } else if (attempts < 5) {
            // Если трека еще нет, повторяем через 200ms
            setTimeout(() => enableCameraWithRetries(attempts + 1), 200);
          }
        } else if (attempts < 5) {
          // Если стрима еще нет, повторяем через 200ms
          setTimeout(() => enableCameraWithRetries(attempts + 1), 200);
        }
      };
      
      // Первая попытка сразу, затем с задержками
      enableCameraWithRetries();
      setTimeout(() => enableCameraWithRetries(1), 200);
      setTimeout(() => enableCameraWithRetries(2), 500);
    });
    
    session.on('callDeclined', () => {
      incomingCallHook.setIncomingFriendCall(null);
      incomingCallHook.setIncomingCall(null);
      incomingCallHook.setIncomingOverlay(false);
    });
    
    session.on('remoteState', ({ muted }) => {
      logger.info('[VideoCall] remoteState event received', {
        muted,
        currentRemoteMuted: remoteMuted,
        hasRemoteStream: !!remoteStream
      });
      
      if (muted !== undefined) {
        // КРИТИЧНО: Не устанавливаем muted=true если это первый раз и есть remoteStream
        // Это может быть ошибка - звук должен быть включен по умолчанию
        if (muted && !remoteMuted && currentRemoteStream) {
          logger.warn('[VideoCall] ⚠️ remoteState пытается установить muted=true при наличии remoteStream - возможно ошибка');
          // Не устанавливаем muted=true если это первый раз и есть стрим
          // Звук должен быть включен по умолчанию
        } else {
          setRemoteMuted(muted);
        }
      }
    });
    
    return () => {
      // КРИТИЧНО: Cleanup только при размонтировании компонента или изменении ключевых параметров
      // НЕ очищаем сессию при изменении roomId/callId/partnerId во время активного звонка
      const shouldCleanup = !route?.params?.directCall && !route?.params?.resume;
      
      if (shouldCleanup) {
        try {
          socket.off('cam-toggle');
        } catch {}
        
        const session = sessionRef.current;
        if (session) {
          // Для видеозвонков не уничтожаем session если есть активный звонок и PiP
          const hasActiveCall = !!roomId || !!callId || !!partnerId;
          const keepAliveForPiP = hasActiveCall || pip.visible;
          
          if (!keepAliveForPiP) {
            logger.info('[VideoCall] Cleaning up session on unmount');
            session.removeAllListeners();
            session.destroy();
            sessionRef.current = null;
          } else {
            logger.info('[VideoCall] Keeping session alive for active call or PiP');
          }
        }
      }
    };
    // КРИТИЧНО: Убрали зависимости roomId, callId, partnerId чтобы не пересоздавать сессию
    // Сессия создается один раз при монтировании компонента
  }, [route?.params?.directCall, route?.params?.resume, pip.visible]);
  
  
  // Keep-awake для активного видеозвонка
  useEffect(() => {
    const hasActiveVideoCall = !!currentRemoteStream && (
      currentRemoteStream.getVideoTracks?.()?.length > 0 || 
      currentRemoteStream.getAudioTracks?.()?.length > 0
    ) || (started && !!localStream);
    
    if (hasActiveVideoCall) {
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('[VideoCall] Failed to activate keep-awake:', e);
        });
      }
      
      // Форсим спикер (через useAudioRouting)
      // forceSpeakerOnHard уже вызывается в useAudioRouting при изменении remoteStream
    }
    
    return () => {
      if (hasActiveVideoCall) {
        if (deactivateKeepAwakeAsync) {
          deactivateKeepAwakeAsync().catch((e) => {
            logger.warn('[VideoCall] Failed to deactivate keep-awake:', e);
          });
        }
      }
    };
  }, [remoteStream, localStream, started]);
  
  
  
  // Обработчики
  const onAbortCall = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    
    if (isInactiveState) return;
    
    try {
      logger.info('[VideoCall] 🛑 Завершение звонка - останавливаем камеру и микрофон');
      
      // Закрываем PiP если открыт
      if (pipRef.current.visible) {
        pipRef.current.hidePiP();
        session.exitPiP?.();
      }
      
      // КРИТИЧНО: Сначала принудительно останавливаем локальный стрим через session
      // Это гарантирует, что камера остановится даже если localStream в состоянии устарел
      try {
        const sessionLocalStream = session.getLocalStream?.();
        if (sessionLocalStream) {
          logger.info('[VideoCall] Останавливаем локальный стрим из session', {
            streamId: sessionLocalStream.id,
            tracksCount: sessionLocalStream.getTracks?.()?.length || 0
          });
          
          const tracks = sessionLocalStream.getTracks?.() || [];
          tracks.forEach((t: any, index: number) => {
            try {
              if (t && t.readyState !== 'ended' && t.readyState !== null) {
                logger.info('[VideoCall] Останавливаем трек из session', {
                  trackId: t.id,
                  trackIndex: index,
                  kind: t.kind,
                  readyState: t.readyState,
                  enabled: t.enabled
                });
                t.enabled = false;
                t.stop();
                try { (t as any).release?.(); } catch {}
              }
            } catch (e) {
              logger.warn('[VideoCall] Error stopping session track:', e);
            }
          });
        }
      } catch (e) {
        logger.warn('[VideoCall] Error stopping session local stream:', e);
      }
      
      // КРИТИЧНО: Также останавливаем локальный стрим из состояния компонента
      // (на случай если он отличается от session)
      if (localStream) {
        try {
          const tracks = localStream.getTracks?.() || [];
          tracks.forEach((t: any, index: number) => {
            try {
              if (t && t.readyState !== 'ended' && t.readyState !== null) {
                logger.info('[VideoCall] Останавливаем трек из localStream state', {
                  trackId: t.id,
                  trackIndex: index,
                  kind: t.kind,
                  readyState: t.readyState,
                  enabled: t.enabled
                });
                t.enabled = false;
                t.stop();
                try { (t as any).release?.(); } catch {}
              }
            } catch (e) {
              logger.warn('[VideoCall] Error stopping local track in onAbortCall:', e);
            }
          });
        } catch (e) {
          logger.warn('[VideoCall] Error stopping local stream in onAbortCall:', e);
        }
      }
      
      // КРИТИЧНО: Вызываем endCall в session (это также остановит стрим)
      session.endCall();
      
      // КРИТИЧНО: Очищаем локальный стрим в состоянии компонента СРАЗУ
      setLocalStream(null);
      // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState
      remoteStreamRef.current = null;
      setRemoteStream(null);
      setCamOn(false);
      setMicOn(false);
      setIsInactiveState(true);
      
      // КРИТИЧНО: Дополнительная проверка через небольшую задержку
      // Убеждаемся, что камера действительно остановлена
      setTimeout(() => {
        const sessionAfterEnd = sessionRef.current;
        if (sessionAfterEnd) {
          const remainingStream = sessionAfterEnd.getLocalStream?.();
          if (remainingStream) {
            logger.warn('[VideoCall] ⚠️ Локальный стрим все еще существует после endCall, принудительная остановка');
            try {
              const tracks = remainingStream.getTracks?.() || [];
              tracks.forEach((t: any) => {
                try {
                  if (t && t.readyState !== 'ended' && t.readyState !== null) {
                    t.enabled = false;
                    t.stop();
                    try { (t as any).release?.(); } catch {}
                  }
                } catch (e) {
                  logger.warn('[VideoCall] Error force-stopping remaining track:', e);
                }
              });
            } catch (e) {
              logger.warn('[VideoCall] Error force-stopping remaining stream:', e);
            }
          }
        }
      }, 100);
      
      // КРИТИЧНО: НЕ делаем навигацию - остаемся на экране с задизейбленной кнопкой
      // Экран останется с isInactiveState=true, что покажет задизейбленную кнопку
    } catch (e) {
      logger.error('[VideoCall] Error ending call:', e);
    }
  }, [isInactiveState, roomId, callId, localStream]);
  
  const toggleMic = useCallback(() => {
    sessionRef.current?.toggleMic();
  }, []);
  
  const toggleCam = useCallback(() => {
    sessionRef.current?.toggleCam();
  }, []);
  
  const toggleRemoteAudio = useCallback(() => {
    sessionRef.current?.toggleRemoteAudio();
    setRemoteMuted(prev => !prev);
  }, []);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId || !!callId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const shouldShowRemoteVideo = remoteCamOn && !isInactiveState;
  const micLevelForEqualizer = hasActiveCall && micOn ? micLevel : 0;
  const showControls = hasActiveCall && !isInactiveState;
  
  // Проверка, является ли партнер другом
  const isPartnerFriend = useMemo(() => {
    if (!partnerUserId) return false;
    return friends.some(f => String(f._id) === String(partnerUserId));
  }, [partnerUserId, friends]);
  
  // Показывать ли бейдж "Друг"
  // КРИТИЧНО: Показываем бейдж если партнер - друг и звонок активен
  // Не требуем remoteStream сразу, так как он может еще не быть установлен
  const showFriendBadge = useMemo(() => {
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const isInactive = !!isInactiveState;
    const callEnded = !!wasFriendCallEnded;
    const hasActiveCall = !!partnerId || !!roomId || !!callId;
    
    // Показываем бейдж если:
    // - Есть partnerUserId
    // - Звонок начат (started) ИЛИ есть активный звонок (для принимающего звонок)
    // - Есть активный звонок (partnerId, roomId или callId)
    // - Звонок не завершен
    const shouldShow = hasPartnerUserId && (hasStarted || hasActiveCall) && !isInactive && !callEnded && hasActiveCall && isPartnerFriend;
    
    if (shouldShow) {
      logger.info('[VideoCall] Показываем бейдж друга', {
        partnerUserId,
        started,
        isInactive,
        callEnded,
        hasActiveCall,
        isPartnerFriend,
        partnerId,
        roomId,
        callId
      });
    }
    
    return shouldShow;
  }, [partnerUserId, friends, started, isInactiveState, wasFriendCallEnded, partnerId, roomId, callId, isPartnerFriend]);
  
  // Обработка ухода со страницы - показываем PiP для видеозвонков
  useFocusEffect(
    useCallback(() => {
      // Guard от повторных вызовов
      if (focusEffectGuardRef.current) return;
      
      // Вернулись из PiP
      const isReturningFromPiP = route?.params?.resume && route?.params?.fromPiP && !fromPiPProcessedRef.current;
      
      if (isReturningFromPiP) {
        fromPiPProcessedRef.current = true;
        focusEffectGuardRef.current = true;
        
        // Прячем PiP
        if (pipRef.current.visible) {
          pipRef.current.hidePiP();
          
          const session = sessionRef.current;
          if (session) {
            // Восстанавливаем стримы из PiP перед выходом
            const pipLocalStream = pip.localStream;
            const pipRemoteStream = pip.remoteStream;
            
            if (pipLocalStream) {
              setLocalStream(pipLocalStream);
              // Обновляем localRenderKey чтобы видео обновилось в UI
              setLocalRenderKey((k: number) => k + 1);
              
              // Проверяем и обновляем состояние камеры
              const videoTrack = (pipLocalStream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack) {
                // При возврате из PiP камера должна быть включена если она была включена
                // Включаем камеру если трек live, но выключен
                if (videoTrack.readyState === 'live' && !videoTrack.enabled) {
                  videoTrack.enabled = true;
                  setCamOn(true);
                  logger.info('[VideoCall] Камера включена при возврате из PiP');
                } else if (videoTrack.enabled && !camOn) {
                  // Камера включена в треке, но camOn не обновлен - обновляем
                  setCamOn(true);
                  logger.info('[VideoCall] Состояние camOn обновлено после восстановления стрима');
                } else if (!videoTrack.enabled && camOn) {
                  // Камера выключена в треке, но camOn включен - включаем камеру
                  videoTrack.enabled = true;
                  setCamOn(true);
                  logger.info('[VideoCall] Камера включена - синхронизировано с состоянием');
                }
              }
              
              logger.info('[VideoCall] Локальный стрим восстановлен из PiP при возврате', {
                hasVideoTrack: !!videoTrack,
                videoTrackEnabled: videoTrack?.enabled,
                videoTrackReadyState: videoTrack?.readyState,
                camOn
              });
            }
            
            if (pipRemoteStream) {
              setRemoteStream(pipRemoteStream);
              logger.info('[VideoCall] Удаленный стрим восстановлен из PiP при возврате');
            }
            
            session.exitPiP();
            
            // Дополнительная проверка через небольшую задержку
            setTimeout(() => {
              const currentLocalStream = session.getLocalStream?.() || pipLocalStream;
              if (currentLocalStream) {
                const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
                if (videoTrack && videoTrack.readyState === 'live' && !videoTrack.enabled) {
                  videoTrack.enabled = true;
                  setCamOn(true);
                  logger.info('[VideoCall] Камера включена после задержки при возврате из PiP');
                }
              }
            }, 500);
            
            // Обновляем remoteViewKey через session с защитой от повторного обновления
            requestAnimationFrame(() => {
              if (!pipReturnUpdateRef.current) {
                pipReturnUpdateRef.current = true;
                const remoteViewKeyFromSession = (session as any).getRemoteViewKey?.();
                if (remoteViewKeyFromSession !== undefined) {
                  setRemoteViewKey(remoteViewKeyFromSession);
                }
                setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
              }
            });
          }
        }
        
        setTimeout(() => {
          focusEffectGuardRef.current = false;
        }, 300);
      }
      
      return () => {
        // Проверяем, не идет ли процесс начала звонка
        const isJustStarted = started && !partnerId && !roomId;
        if (isJustStarted || isInactiveState) {
          return;
        }
        
        focusEffectGuardRef.current = true;
        
        // Для видеозвонков другу показываем PiP при уходе со страницы
        // КРИТИЧНО: Не показываем PiP если звонок завершен
        // КРИТИЧНО: Не показываем PiP сразу после принятия звонка - даем время камере включиться
        const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState && !wasFriendCallEnded;
        const currentPip = pipRef.current;
        
        // Закрываем PiP если звонок завершен
        if ((isInactiveState || wasFriendCallEnded) && currentPip.visible) {
          currentPip.hidePiP();
          sessionRef.current?.exitPiP?.();
        }
        
        // КРИТИЧНО: Полностью запрещаем автоматический PiP при принятии звонка
        // PiP должен показываться ТОЛЬКО при явном уходе со страницы пользователем (через BackHandler)
        // НЕ показываем PiP автоматически в useFocusEffect cleanup - это вызывает проблемы с камерой
        // Если звонок только что принят, НИКОГДА не показываем PiP автоматически
        const timeSinceAccept = Date.now() - (acceptCallTimeRef.current || 0);
        const shouldDelayPiP = timeSinceAccept < 30000; // 30 секунд - полностью запрещаем автоматический PiP при принятии звонка
        
        // ЗАКОММЕНТИРОВАНО: НЕ показываем PiP автоматически в cleanup useFocusEffect
        // Это вызывает проблемы: камера выключается, видео не отображается
        // PiP должен показываться только через BackHandler (явное действие пользователя)
        /* ЗАКОММЕНТИРОВАНО
        if (false && hasActiveCall && !currentPip.visible && !isInactiveState && !wasFriendCallEnded && !shouldDelayPiP) {
          // Ищем партнера в списке друзей
          const partner = partnerUserId 
            ? friendsRef.current.find(f => String(f._id) === String(partnerUserId))
            : null;
          
          // Строим полный URL аватара
          let avatarUrl: string | undefined = undefined;
          if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
            const SERVER_CONFIG = require('../../src/config/server').SERVER_CONFIG;
            const serverUrl = SERVER_CONFIG.BASE_URL;
            avatarUrl = partner.avatar.startsWith('http') 
              ? partner.avatar 
              : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
          }
          
          // Показываем PiP
          currentPip.showPiP({
            callId: callId || '',
            roomId: roomId || '',
            partnerName: partner?.nick || 'Друг',
            partnerAvatarUrl: avatarUrl,
            muteLocal: !micOn,
            muteRemote: remoteMuted,
            localStream: localStream || null,
            remoteStream: remoteStream || null,
            navParams: {
              ...route?.params,
              peerUserId: partnerUserId,
              partnerId: partnerId,
            } as any,
          });
          
          // Вызываем enterPiP в session
          // КРИТИЧНО: Не отключаем камеру при входе в PiP сразу после принятия звонка
          // Увеличиваем задержку до 30 секунд для предотвращения отключения камеры
          const timeSinceAcceptForPiP = Date.now() - (acceptCallTimeRef.current || 0);
          const shouldDisableCamera = timeSinceAcceptForPiP >= 30000; // 30 секунд задержка
          
          const session = sessionRef.current;
          if (session) {
            const enterPiP = (session as any).enterPiP;
            if (typeof enterPiP === 'function') {
              enterPiP();
            }
          }
          
          // Отправляем bg:entered событие
          try {
            socket.emit('bg:entered', {
              callId: callId || roomId,
              partnerId: partnerUserId
            });
          } catch (e) {
            logger.warn('[VideoCall] Error emitting bg:entered:', e);
          }
        }
        */
        
        setTimeout(() => {
          focusEffectGuardRef.current = false;
        }, 300);
      };
    }, [
      route?.params?.resume,
      route?.params?.fromPiP,
      started,
      partnerId,
      roomId,
      callId,
      isInactiveState,
      wasFriendCallEnded,
      friends,
      partnerUserId,
      micOn,
      remoteMuted,
      localStream,
      remoteStream
    ])
  );
  
  // Обновление NavigationBar для Android
  useEffect(() => {
    const applyNavBarForVideo = async () => {
      if (Platform.OS !== 'android') return;
      try {
        const NavigationBar = await import('expo-navigation-bar');
        const applyOnce = async () => {
          const bg = isDark ? '#151F33' : (theme.colors.background as string);
          await NavigationBar.setBackgroundColorAsync(bg);
          try { await NavigationBar.setBehaviorAsync('inset-swipe'); } catch {}
          try { await NavigationBar.setPositionAsync('relative'); } catch {}
          await NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark');
          try { await NavigationBar.setVisibilityAsync('visible'); } catch {}
        };
        await applyOnce();
        setTimeout(applyOnce, 50);
        setTimeout(applyOnce, 250);
      } catch {}
    };
    applyNavBarForVideo();
  }, [theme.colors.background, isDark]);
  
  return (
    <SafeAreaView 
      style={[styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }]}
      // {...panResponder.panHandlers} // ЗАКОММЕНТИРОВАНО: PiP отключен
    >
        {/* Карточка "Собеседник" */}
        <View style={styles.card}>
          <RemoteVideo
            remoteStream={currentRemoteStream}
            remoteCamOn={remoteCamOn}
            remoteMuted={remoteMuted}
            isInactiveState={isInactiveState}
            wasFriendCallEnded={wasFriendCallEnded}
            started={started}
            loading={loading}
            remoteViewKey={remoteViewKey}
            showFriendBadge={showFriendBadge}
            lang={lang}
            session={sessionRef.current}
          />
          
          {/* Кнопка управления удаленным звуком */}
          {showControls && (
            <Animated.View style={[styles.topLeftAudio, { opacity: buttonsOpacity }]}>
              <TouchableOpacity
                onPress={toggleRemoteAudio}
                disabled={!currentRemoteStream}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                activeOpacity={0.7}
                style={[styles.iconBtn, !currentRemoteStream && styles.iconBtnDisabled]}
              >
                <View style={{ position: 'relative', justifyContent: 'center', alignItems: 'center' }}>
                  <MaterialIcons
                    name={remoteMuted ? "volume-off" : "volume-up"}
                    size={26}
                    color={remoteMuted ? "#999" : (currentRemoteStream ? "#fff" : "#777")}
                  />
                  {remoteMuted && (
                    <View
                      style={{
                        position: 'absolute',
                        width: 28,
                        height: 2,
                        backgroundColor: '#999',
                        transform: [{ rotate: '45deg' }],
                      }}
                    />
                  )}
                </View>
              </TouchableOpacity>
            </Animated.View>
          )}
        </View>
        
        {/* Эквалайзер */}
        <View style={styles.eqWrapper}>
          <VoiceEqualizer
            level={(() => {
              const hasActiveCall = !!partnerId || !!roomId || !!callId;
              const micReallyOn = micOn;
              return hasActiveCall && micReallyOn ? micLevel : 0;
            })()}
            width={220}
            height={30}
            bars={21}
            gap={8}
            minLine={4}
            colors={isDark ? ["#F4FFFF", "#2EE6FF", "#F4FFFF"] : ["#FFE6E6", "rgb(58, 11, 160)", "#FFE6E6"]}
          />
        </View>
        
        {/* Карточка "Вы" */}
        <View style={styles.card}>
          <LocalVideo
            localStream={localStream}
            camOn={camOn}
            isInactiveState={isInactiveState}
            wasFriendCallEnded={wasFriendCallEnded}
            started={started}
            localRenderKey={localRenderKey}
            lang={lang}
          />
          
          {/* Кнопки управления медиа */}
          <MediaControls
            micOn={micOn}
            camOn={camOn}
            onToggleMic={toggleMic}
            onToggleCam={toggleCam}
            onFlipCamera={() => sessionRef.current?.flipCam()}
            localStream={localStream}
            visible={showControls}
            opacity={buttonsOpacity}
          />
        </View>
        
        {/* Кнопка снизу: Завершить */}
        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={[
              styles.bigBtn,
              styles.btnDanger,
              {
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                opacity: isInactiveState ? 0.5 : 1.0
              }
            ]}
            onPress={isInactiveState ? undefined : onAbortCall}
            disabled={isInactiveState}
          >
            <Text style={styles.bigBtnText}>Завершить</Text>
            <MaterialIcons name="call-end" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      
      {/* Модалка входящего звонка */}
      <IncomingCallModal
        visible={incomingCallHook.incomingOverlay}
        incomingFriendCall={incomingCallHook.incomingFriendCall}
        incomingCall={incomingCallHook.incomingCall}
        lang={lang}
        isDark={isDark}
        onAccept={() => {
          setTimeout(() => {
            incomingCallHook.handleAccept();
          }, 0);
        }}
        onDecline={() => {
          setTimeout(() => {
            incomingCallHook.handleDecline();
          }, 0);
        }}
        onRequestClose={() => {
          setTimeout(() => {
            incomingCallHook.handleDecline();
          }, 0);
        }}
      />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "android" ? { paddingTop: 0 } : { paddingTop: 20 }),
  },
  card: {
    ...CARD_BASE,
    width: Platform.OS === "android" ? '94%' : '94%',
    ...((Platform.OS === "ios" ? { height: Dimensions.get('window').height * 0.4 } : { height: Dimensions.get('window').height * 0.43 })
    ),
  },
  eqWrapper: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  rtc: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'black',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    width: Platform.OS === "android" ? '94%' : '93%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 14 : 16,
    marginTop: Platform.OS === "android" ? 6 : 5,
    marginBottom: Platform.OS === "android" ? 18 : 32,
  },
  bigBtn: {
    flex: 1,
    height: Platform.OS === "android" ? 50 : 60,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bigBtnText: {
    color: '#333333',
    fontSize: 16,
    fontWeight: '600',
  },
  btnDanger: {
    backgroundColor: '#ff4d4d',
  },
  disabled: {
    opacity: 1,
  },
  topLeftAudio: {
    position: 'absolute',
    top: 8,
    left: 8,
  },
  iconBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '86%',
    backgroundColor: '#1f2937',
    padding: 16,
    borderRadius: 12,
  },
  incomingTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 10,
  },
  incomingName: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
    marginBottom: 14,
  },
  incomingButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    justifyContent: 'center',
  },
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassSuccess: {
    backgroundColor: 'rgba(76, 175, 80, 0.16)',
    borderColor: 'rgba(76, 175, 80, 0.65)',
  },
  btnGlassDanger: {
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)',
  },
  modalBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  friendBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,255,0,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0,255,0,0.3)',
  },
  friendBadgeText: {
    color: '#0f0',
    fontSize: 12,
    fontWeight: '600',
  },
});

export default VideoCall;

