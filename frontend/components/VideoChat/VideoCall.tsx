/**
 * VideoCall - Компонент для видеозвонка другу
 * Использует компоненты: RemoteVideo, LocalVideo, MediaControls, VoiceEqualizer
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
  Easing,
} from 'react-native';
import { useNavigation, useFocusEffect, usePreventRemove } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaStream } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { VideoCallSession } from '../../src/webrtc/sessions/VideoCallSession';
import type { WebRTCSessionConfig } from '../../src/webrtc/types';
import { BlurView } from 'expo-blur';
import { MediaControls } from './shared/MediaControls';
import { LocalVideo } from './shared/LocalVideo';
import { RemoteVideo } from './shared/RemoteVideo';
// import VoiceEqualizer from '../VoiceEqualizer'; // эквалайзер отключен
import { t, loadLang, defaultLang } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import { usePiP } from '../../src/pip/PiPContext';
import socket, { fetchFriends, getCurrentUserId } from '../../sockets/socket';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import { useAudioRouting } from './hooks/useAudioRouting';
import { usePiP as usePiPHook } from './hooks/usePiP';
import { useIncomingCall } from './hooks/useIncomingCall';
import AsyncStorage from '@react-native-async-storage/async-storage';
import InCallManager from 'react-native-incall-manager';

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
      isIncoming?: boolean;
      partnerNick?: string;
    } 
  } 
};

const CARD_BASE = {
  backgroundColor: 'rgba(13,14,16,0.85)',
  borderRadius: 10,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  overflow: 'hidden' as const,
  marginVertical: 2,
  position: 'relative' as const,
};


const boostMicLevel = (level: number) => {
  if (!level || level <= 0) return 0;
  const shaped = Math.pow(level, 0.55) * 2.4;
  return Math.min(1, shaped);
};

const stopStreamTracks = (stream: MediaStream | null | undefined, context: string) => {
  if (!stream) {
    return;
  }

  try {
    const baseTracks = stream.getTracks?.() || [];
    const videoTracks = (stream as any)?.getVideoTracks?.() || [];
    const audioTracks = (stream as any)?.getAudioTracks?.() || [];

    const allTracks: any[] = [...baseTracks];
    const appendUnique = (tracks: any[]) => {
      tracks.forEach((track: any) => {
        if (track && !allTracks.includes(track)) {
          allTracks.push(track);
        }
      });
    };

    appendUnique(videoTracks);
    appendUnique(audioTracks);

    const uniqueTracks = Array.from(new Set(allTracks));

    logger.info('[VideoCall] 🛑 Останавливаем локальный стрим', {
      context,
      totalTracks: uniqueTracks.length,
      videoTracks: uniqueTracks.filter((t: any) => (t.kind || (t as any).type) === 'video').length,
      audioTracks: uniqueTracks.filter((t: any) => (t.kind || (t as any).type) === 'audio').length,
    });

    uniqueTracks.forEach((track: any, index: number) => {
      try {
        if (track && track.readyState !== 'ended' && track.readyState !== null) {
          const trackKind = track.kind || (track as any).type;
          track.enabled = false;
          track.stop();

          logger.info('[VideoCall] ✅ Трек остановлен', {
            context,
            trackKind,
            trackId: track.id,
            index,
          });

          setTimeout(() => {
            try {
              if (track && track.readyState !== 'ended' && track.readyState !== null) {
                track.enabled = false;
                track.stop();
              }
            } catch (err) {
              logger.warn('[VideoCall] Error in delayed track stop', { context, err });
            }
          }, 100);
        }
      } catch (err) {
        logger.warn('[VideoCall] Error stopping track', { context, err });
      }
    });
  } catch (err) {
    logger.warn('[VideoCall] Error stopping stream', { context, err });
  }
};

const VideoCall: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  
  const [lang, setLang] = useState<Lang>(defaultLang);
  const androidScreenPadding = 4;
  const androidContentInsets = useMemo(() => {
    if (Platform.OS !== 'android') return null;
    // Android: одинаковый базовый отступ со всех сторон + safe-area (челка/навигация)
    return {
      paddingTop: insets.top + androidScreenPadding,
      paddingBottom: insets.bottom + androidScreenPadding,
      paddingLeft: insets.left + androidScreenPadding,
      paddingRight: insets.right + androidScreenPadding,
    } as const;
  }, [insets.bottom, insets.left, insets.right, insets.top]);
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
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamReceivedAtRef = useRef<number | null>(null);
  
  // КРИТИЧНО: Синхронизируем ref с state для использования в callbacks
  // Это fallback на случай, если ref не был обновлен синхронно
  useEffect(() => {
    remoteStreamRef.current = remoteStream;
  }, [remoteStream]);
  
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const remoteCamStateKnownRef = useRef(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const remoteMutedRef = useRef(remoteMuted);
  
  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);
  
  useEffect(() => {
    remoteMutedRef.current = remoteMuted;
  }, [remoteMuted]);
  
  // Упрощено: убраны лишние проверки race condition

  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
  // Эквалайзер отключен
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [wasFriendCallEnded, setWasFriendCallEnded] = useState(false);
  const [partnerInPiP, setPartnerInPiP] = useState(false);
  const partnerInPiPRef = useRef(false);
  useEffect(() => { partnerInPiPRef.current = partnerInPiP; }, [partnerInPiP]);
  
  // КРИТИЧНО: Логируем изменения partnerInPiP для отладки
  useEffect(() => {
    logger.info('[VideoCall] partnerInPiP state changed', { 
      partnerInPiP,
      roomId,
      callId,
      partnerId
    });
  }, [partnerInPiP, roomId, callId, partnerId]);
  
  // Синхронизируем состояние неактивности с глобальным ref для App.tsx
  useEffect(() => {
    (global as any).__isInactiveStateRef = { current: isInactiveState };
    return () => {
      (global as any).__isInactiveStateRef = { current: false };
    };
  }, [isInactiveState]);
  const [friendCallAccepted, setFriendCallAccepted] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(1));
  const incomingCallBounce = useRef(new Animated.Value(0)).current;
  const incomingWaveA = useRef(new Animated.Value(0)).current;
  const incomingWaveB = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!remoteStream) {
      remoteCamStateKnownRef.current = false;
      setRemoteCamOn(true);
      return;
    }

    // КРИТИЧНО: Если стрим есть, но состояние камеры еще не известно - проверяем видеотрек
    // Если есть готовый видеотрек, считаем что камера включена по умолчанию
    if (!remoteCamStateKnownRef.current) {
      const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
      const hasVideoTrack = !!videoTrack;
      const videoTrackReady = !!videoTrack && videoTrack.readyState === 'live';
      const videoTrackEnabled = !!videoTrack && (videoTrack.enabled ?? true);
      const hasRenderableVideo = hasVideoTrack && videoTrackReady && videoTrackEnabled;
      
      // Если есть готовый видеотрек, устанавливаем remoteCamOn в true
      if (hasRenderableVideo) {
        logger.info('[VideoCall] Устанавливаем remoteCamOn=true - есть готовый видеотрек', {
          streamId: remoteStream.id,
          videoTrackId: videoTrack?.id,
          videoTrackReady,
          videoTrackEnabled
        });
        setRemoteCamOn(true);
      } else {
        // Если видеотрека нет или он не готов, оставляем remoteCamOn в true по умолчанию
        // (пока не получим явное состояние от сервера)
        setRemoteCamOn(true);
      }
    }
  }, [remoteStream, remoteViewKey]);
  
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
  
  const incomingFriendCall = incomingCallHook.incomingFriendCall;
  const showIncomingFriendOverlay = useMemo(() => {
    if (!incomingCallHook.incomingOverlay || !incomingFriendCall) {
      return false;
    }
    if (friendCallAccepted) {
      return false;
    }
    const samePartner =
      !!partnerUserId &&
      !!incomingFriendCall.from &&
      String(partnerUserId) === String(incomingFriendCall.from);
    const hasActiveRemoteStream = !isInactiveState && samePartner && !!remoteStream;
    return !hasActiveRemoteStream;
  }, [
    incomingCallHook.incomingOverlay,
    incomingFriendCall,
    friendCallAccepted,
    partnerUserId,
    remoteStream,
    isInactiveState,
  ]);

  const incomingCallerLabel = useMemo(() => {
    if (!incomingFriendCall) return '';
    return incomingFriendCall.nick || `id: ${String(incomingFriendCall.from || '').slice(0, 5)}`;
  }, [incomingFriendCall]);

  const stopIncomingOverlayAnim = useCallback(() => {
    incomingCallBounce.stopAnimation();
    incomingWaveA.stopAnimation();
    incomingWaveB.stopAnimation();
  }, [incomingCallBounce, incomingWaveA, incomingWaveB]);

  const startIncomingOverlayAnim = useCallback(() => {
    stopIncomingOverlayAnim();
    Animated.loop(
      Animated.sequence([
        Animated.timing(incomingCallBounce, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(incomingCallBounce, { toValue: -1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(incomingCallBounce, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.delay(300),
      ])
    ).start();

    const loopWave = (val: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 1400, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    };

    loopWave(incomingWaveA, 0);
    loopWave(incomingWaveB, 400);
  }, [incomingCallBounce, incomingWaveA, incomingWaveB, stopIncomingOverlayAnim]);

  useEffect(() => {
    if (showIncomingFriendOverlay) {
      startIncomingOverlayAnim();
    } else {
      stopIncomingOverlayAnim();
    }

    return () => {
      stopIncomingOverlayAnim();
    };
  }, [showIncomingFriendOverlay, startIncomingOverlayAnim, stopIncomingOverlayAnim]);

  const handleIncomingAccept = useCallback(() => {
    incomingCallHook.handleAccept();
  }, [incomingCallHook]);

  const handleIncomingDecline = useCallback(() => {
    incomingCallHook.handleDecline();
  }, [incomingCallHook]);

  const incomingCallIconStyle = useMemo(() => ({
    transform: [
      { translateY: incomingCallBounce.interpolate({ inputRange: [-1, 0, 1], outputRange: [-6, 0, -6] }) },
      { rotate: incomingCallBounce.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] }) },
    ],
  }), [incomingCallBounce]);

  const buildIncomingWaveStyle = useCallback(
    (value: Animated.Value, direction: 'left' | 'right') => ({
      position: 'absolute' as const,
      width: 120,
      height: 120,
      borderRadius: 60,
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.35)',
      opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
      transform: [
        { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.35] }) },
        { translateX: direction === 'left' ? -24 : 24 },
      ],
    }),
    []
  );

  // Хук для PiP
  // Сохраняем ссылку на enterPiPMode для использования в beforeRemove
  const enterPiPModeRef = useRef<(() => void) | null>(null);
  
  const { enterPiPMode, panResponder } = usePiPHook({
    roomId,
    callId,
    partnerId,
    partnerUserId,
    isInactiveState,
    wasFriendCallEnded,
    camOn,
    micOn,
    remoteMuted,
    localStream,
    remoteStream,
    friends,
    routeParams: route?.params,
    session: sessionRef.current,
    acceptCallTimeRef,
    // Android: хотим сначала уйти назад, а PiP показать уже на предыдущем экране
    // (BackHandler внутри usePiP иначе показывает PiP "на этом экране" перед pop).
    enableAndroidBackHandler: false,
  });
  
  // Сохраняем ссылку на enterPiPMode для использования в beforeRemove
  useEffect(() => {
    enterPiPModeRef.current = enterPiPMode;
  }, [enterPiPMode]);

  // iOS: показываем PiP только когда пользователь действительно уходит со страницы (back/swipe-back),
  // а не на обычные тапы по кнопкам (например, toggle remote audio).
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const unsub = (navigation as any)?.addListener?.('beforeRemove', () => {
      const hasActiveCall = (!!partnerId || !!roomId || !!callId) && !isInactiveState && !wasFriendCallEnded;
      if (!hasActiveCall) return;
      if (pipRef.current.visible) return;
      enterPiPModeRef.current?.();
    });
    return () => { try { unsub?.(); } catch {} };
  }, [navigation, partnerId, roomId, callId, isInactiveState, wasFriendCallEnded]);
  
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
  const isEndingCallRef = useRef(false); // КРИТИЧНО: Флаг для предотвращения повторных вызовов handleCallEnded
  // КРИТИЧНО: Сессия может переживать размонтирование экрана (PiP).
  // Когда возвращаемся из PiP и используем существующую сессию из global ref,
  // её callbacks привязаны к старому инстансу компонента. Поэтому нам нужно
  // "мостить" события localStream/remoteStream в текущий экран.
  const createdSessionsRef = useRef<WeakSet<object>>(new WeakSet());
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
  
  // КРИТИЧНО: При входе в видеочат с конкретным другом — обнуляем пропущенные вызовы для него
  // Это нужно чтобы счетчик пропущенных звонков сбрасывался при открытии видеочата
  useEffect(() => {
    const uid = route?.params?.peerUserId || partnerUserId;
    if (!uid) return;
    
    (async () => {
      try {
        const key = 'missed_calls_by_user_v1';
        const raw = await AsyncStorage.getItem(key);
        const data = raw ? JSON.parse(raw) : {};
        const userId = String(uid);
        if (data && typeof data === 'object' && data[userId]) {
          data[userId] = 0;
          await AsyncStorage.setItem(key, JSON.stringify(data));
          logger.info('[VideoCall] ✅ Сброшен счетчик пропущенных звонков для пользователя', { userId });
        }
      } catch (e) {
        logger.warn('[VideoCall] Ошибка при сбросе счетчика пропущенных звонков:', e);
      }
    })();
  }, [route?.params?.peerUserId, partnerUserId]);
  
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
    } else {
      // Сбрасываем статус "busy" когда нет активного общения
      try {
        socket.emit('presence:update', { status: 'online' });
      } catch (e) {
        logger.warn('[VideoCall] Error sending presence:update online:', e);
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
  
  const clearSessionRefs = useCallback(() => {
    sessionRef.current = null;
    (global as any).__webrtcSessionRef.current = null;
    if ((global as any).__endCallCleanupRef) {
      (global as any).__endCallCleanupRef.current = null;
    }
    if ((global as any).__pendingCallAcceptedRef) {
      (global as any).__pendingCallAcceptedRef.current = null;
    }
    currentCallIdRef.current = null;
  }, []);

  // Guard: эффект восстановления из PiP должен срабатывать один раз на возврат,
  // иначе он может откатывать camOn после ручного нажатия кнопки камеры.
  const resumeFromPiPEffectRanRef = useRef(false);

  // Упрощено: простое восстановление стримов из PiP
  useEffect(() => {
    const resume = !!route?.params?.resume;
    const fromPiP = !!route?.params?.fromPiP;
    const session = sessionRef.current;
    
    if (!resume || !fromPiP) {
      resumeFromPiPEffectRanRef.current = false;
      return;
    }

    if (resume && fromPiP && session && !resumeFromPiPEffectRanRef.current) {
      resumeFromPiPEffectRanRef.current = true;
      if (pip.localStream) {
        setLocalStream(pip.localStream);
        setLocalRenderKey((k: number) => k + 1);
        // ВАЖНО: НЕ включаем камеру автоматически. Восстанавливаем ровно то состояние,
        // которое было на момент входа в PiP (сохраняется в PiPContext).
        const desiredCamOn =
          typeof pip.localCamOn === 'boolean'
            ? pip.localCamOn
            : ((pip.localStream as any)?.getVideoTracks?.()?.[0]?.enabled ?? false);

        try {
          const videoTrack = (pip.localStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            videoTrack.enabled = !!desiredCamOn;
          }
        } catch {}
        setCamOn(!!desiredCamOn);
      }
      if (pip.remoteStream) {
        setRemoteStream(pip.remoteStream);
      }
      if (session.exitPiP) {
        session.exitPiP();
      }
    }
  }, [route?.params?.resume, route?.params?.fromPiP, pip.localStream, pip.remoteStream, pip.localCamOn]);
  
  // Инициализация session и восстановление состояния звонка
  useEffect(() => {
    // КРИТИЧНО: При возврате из PiP используем существующую сессию из глобальной ссылки
    // Это гарантирует, что видеопоток восстановится у обоих участников
    const fromPiP = !!route?.params?.fromPiP;
    const resume = !!route?.params?.resume;
    
    if (fromPiP && resume) {
      const globalSession = (global as any).__webrtcSessionRef?.current;
      if (globalSession && !sessionRef.current) {
        logger.info('[VideoCall] Возврат из PiP - используем существующую сессию из глобальной ссылки', {
          hasGlobalSession: !!globalSession,
          sessionType: globalSession.constructor.name,
        });
        sessionRef.current = globalSession;
        // Восстанавливаем remoteStream из сессии
        const sessionRemoteStream = globalSession.getRemoteStream?.();
        if (sessionRemoteStream) {
          setRemoteStream(sessionRemoteStream);
          remoteStreamRef.current = sessionRemoteStream as any;
          remoteStreamReceivedAtRef.current = Date.now();
          logger.info('[VideoCall] ✅ Восстановлен remoteStream из существующей сессии при возврате из PiP', {
            streamId: sessionRemoteStream.id,
          });
        }
        // КРИТИЧНО: НЕ возвращаемся здесь - нужно установить обработчики событий
        // Обработчики будут установлены ниже в этом же useEffect
      }
    }
    
    // Не пересоздаем сессию если она уже существует
    // КРИТИЧНО: НЕ возвращаемся здесь - нужно установить обработчики событий
    // Обработчики будут установлены ниже в этом же useEffect
    // Не пересоздаем сессию если она уже существует
    const existingSession = sessionRef.current;
    if (existingSession) {
      logger.info('[VideoCall] Session already exists, skipping creation');
      // КРИТИЧНО: Обработчики событий будут установлены в отдельном useEffect ниже
      // который зависит от sessionRef.current
      return;
    }
    
    const pendingCallAccepted = (global as any).__pendingCallAcceptedRef?.current;
    const pendingCallId = pendingCallAccepted ? String(pendingCallAccepted?.callId || '') : null;
    const isDirectCall = !!route?.params?.directCall;
    const isDirectInitiator = !!route?.params?.directInitiator;
    
    logger.info('[VideoCall] Creating new VideoCallSession', {
      isDirectCall,
      isDirectInitiator,
      resume,
      fromPiP
    });
    
    const resolvedMyUserId = route?.params?.myUserId || getCurrentUserId();
    const config: WebRTCSessionConfig = {
      myUserId: resolvedMyUserId,
      callbacks: {
        onLocalStreamChange: (stream) => {
          const prevStream = localStreamRef.current;
          localStreamRef.current = stream;
          setLocalStream(stream);
          if (stream) {
            // КРИТИЧНО: Всегда обновляем localRenderKey при изменении стрима для Android
            if (!prevStream || prevStream.id !== stream.id) {
              setLocalRenderKey((k: number) => k + 1);
              logger.info('[VideoCall] Local stream changed - updating render key', {
                prevStreamId: prevStream?.id,
                newStreamId: stream.id,
                hasVideoTrack: !!stream.getVideoTracks()?.[0]
              });
            }
            // ВАЖНО: Не управляем camOn/micOn из onLocalStreamChange.
            // Эти состояния должны меняться только:
            // - через явные callbacks session.onCamStateChange/onMicStateChange
            // - через действия пользователя (кнопки)
            // Иначе при восстановлении/пересоздании MediaStream можно случайно "включить" камеру в UI.
          }
        },
        onRemoteStreamChange: (stream) => {
          const prevStream = remoteStreamRef.current;
          const prevVideoTrack = prevStream?.getVideoTracks?.()?.[0];
          const prevVideoId = prevVideoTrack?.id;
          const prevVideoReady = !!prevVideoTrack && prevVideoTrack.readyState === 'live';
          const newVideoTrack = stream?.getVideoTracks?.()?.[0];
          const newVideoId = newVideoTrack?.id;
          const newVideoReady = !!newVideoTrack && newVideoTrack.readyState === 'live';
          const sameStreamInstance =
            !!stream && !!prevStream && prevStream === stream && prevStream.id === stream.id;

          if (sameStreamInstance) {
            if (!stream) {
              setRemoteMuted(false);
              return;
            }

            const trackChanged = prevVideoId !== newVideoId;
            const trackBecameLive = !prevVideoReady && newVideoReady;

            if (trackChanged || trackBecameLive) {
              logger.info('[VideoCall] Remote stream tracks updated without new MediaStream instance', {
                streamId: stream.id,
                prevVideoId,
                newVideoId,
                prevVideoReady,
                newVideoReady
              });
              setRemoteViewKey((k: number) => k + 1);
            }
            remoteStreamRef.current = stream;
            return;
          }

          remoteStreamRef.current = stream;
          setRemoteStream(stream);
          if (stream) {
            // КРИТИЧНО: Сохраняем время получения remoteStream ВСЕГДА (не только для нового партнера)
            // Это предотвращает мерцание заглушки "Отошел" при получении треков
            remoteStreamReceivedAtRef.current = Date.now();
            
            logger.info('[VideoCall] Remote stream event', {
              streamId: stream.id,
              prevStreamId: prevStream?.id,
              hasVideoTrack: !!(stream.getVideoTracks?.()?.[0]),
              hasAudioTrack: !!(stream.getAudioTracks?.()?.[0])
            });
            setIsInactiveState(false);
            setWasFriendCallEnded(false);
            setStarted(true);
            setLoading(false);
            setRemoteViewKey((k: number) => k + 1);
          } else {
            setRemoteMuted(false);
            remoteStreamReceivedAtRef.current = null;
          }
        },
        onPartnerIdChange: (id) => {
          setPartnerId(id);
        },
        onRoomIdChange: (id) => {
          setRoomId(id);
          // Обновляем partnerUserId из сессии при получении roomId (call:accepted)
          const session = sessionRef.current;
          if (session && id && typeof (session as any).getPartnerUserId === 'function') {
            const partnerUserId = (session as any).getPartnerUserId();
            if (partnerUserId) {
              setPartnerUserId(partnerUserId);
            }
          }
        },
        onCallIdChange: (id) => {
          setCallId(id);
        },
        onMicStateChange: (enabled) => {
          setMicOn(enabled);
          
          // КРИТИЧНО: Обновляем состояние PiP при изменении состояния микрофона (как в эталонном файле)
          if (pip.visible) {
            pip.updatePiPState({ isMuted: !enabled });
          }
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
          
          // УБРАНО: Логика игнорирования отключения камеры сразу после принятия звонка
          // Теперь фильтрация происходит на сервере (в течение 30 секунд после принятия звонка)
          
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
          logger.info('[VideoCall] onRemoteCamStateChange вызван', { 
            enabled,
            previousRemoteCamOn: remoteCamOn,
            partnerInPiP
          });
          remoteCamStateKnownRef.current = true;
          setRemoteCamOn(enabled);
          // КРИТИЧНО: При возврате из PiP обновляем remoteViewKey для принудительной перерисовки
          if (enabled && !partnerInPiP) {
            setRemoteViewKey(Date.now());
            logger.info('[VideoCall] ✅ Обновлен remoteViewKey после onRemoteCamStateChange(true)');
          }
        },
        // Эквалайзер отключен
        onMicLevelChange: () => {},
        onMicFrequencyLevelsChange: () => {},
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
    // Помечаем, что эта сессия создана этим инстансом VideoCall (callbacks актуальны).
    // Для "чужих" (восстановленных из global ref) будем подписываться на события stream.
    try { createdSessionsRef.current.add(session as any); } catch {}
    
    // КРИТИЧНО: Устанавливаем глобальную ссылку на сессию сразу при создании
    // Это нужно чтобы можно было остановить камеру даже когда VideoCall экран размонтирован (в PiP/фоне)
    (global as any).__webrtcSessionRef.current = session;
    logger.info('[VideoCall] ✅ Глобальная ссылка на сессию установлена при создании', {
      hasSession: !!session,
      sessionType: session.constructor.name
    });
    
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
      // КРИТИЧНО: Проверяем что сессия существует и не в процессе создания
      if (!session) {
        logger.warn('[VideoCall] Session не существует для callFriend, пропускаем');
        return;
      }
      
      const friendId = route.params.peerUserId;
      const existingCallId = route.params.callId;
      
      // КРИТИЧНО: Если callId уже есть (звонок уже был инициирован с HomeScreen и принят),
      // то не вызываем callFriend снова, а сразу подключаемся к комнате
      if (existingCallId) {
        logger.info('[VideoCall] Инициатор: звонок уже принят, подключаемся к комнате', {
          friendId,
          existingCallId
        });
        
        setPartnerUserId(friendId);
        currentCallIdRef.current = existingCallId;
        setStarted(true);
        setLoading(true);
        
        if (pendingCallId && pendingCallId === String(existingCallId)) {
          logger.info('[VideoCall] Pending call:accepted already queued, skipping connectAsInitiatorAfterAccepted', {
            existingCallId,
            friendId,
          });
          return;
        }

        // Запрашиваем токен и подключаемся напрямую
        session.connectAsInitiatorAfterAccepted(existingCallId, friendId).catch((e) => {
          logger.error('[VideoCall] Error connecting as initiator after accepted:', e);
          setStarted(false);
          setLoading(false);
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем что звонок еще не начат (защита от повторных вызовов)
      if (started && (roomId || callId || partnerId)) {
        logger.info('[VideoCall] Звонок уже начат, пропускаем callFriend', {
          friendId,
          started,
          roomId,
          callId,
          partnerId
        });
        return;
      }
      
      setPartnerUserId(friendId);
      setStarted(true);
      setLoading(true);
      
      // Запускаем звонок
      session.callFriend(friendId).catch((e) => {
        logger.error('[VideoCall] Error calling friend:', e);
        setStarted(false);
        setLoading(false);
      });
    } else if (isDirectCall && route?.params?.isIncoming && route?.params?.callId && route?.params?.peerUserId) {
      // ПРИНЯТИЕ входящего звонка
      // КРИТИЧНО: acceptCall вызывается ЗДЕСЬ, после создания сессии и установки socket handlers
      // Это гарантирует, что call:accepted событие будет получено
      const incomingCallId = route.params.callId;
      const fromUserId = route.params.peerUserId;
      
      logger.info('[VideoCall] Accepting incoming call after session creation', {
        callId: incomingCallId,
        fromUserId
      });
      
      setPartnerUserId(fromUserId);
      currentCallIdRef.current = incomingCallId;
      setStarted(true);
      setLoading(true);
      
      session.acceptCall(incomingCallId, fromUserId).catch((e) => {
        logger.error('[VideoCall] Error accepting incoming call:', e);
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
      });
    }
    
    // КРИТИЧНО: Создаем функцию очистки, которая вызывает session.endCall() и полную очистку
    // Это нужно для глобальной ссылки __endCallCleanupRef
    // Функция должна работать даже когда VideoCall экран размонтирован (в PiP/фоне)
    const cleanupFunction = () => {
      logger.info('[VideoCall] 🔥 cleanupFunction вызвана из глобальной ссылки (PiP/фон)');
      
      // КРИТИЧНО: Защита от повторных вызовов - если уже в неактивном состоянии или звонок завершается, игнорируем
      if (isInactiveStateRef.current || isEndingCallRef.current) {
        logger.info('[VideoCall] cleanupFunction вызвана, но уже в неактивном состоянии или звонок завершается - игнорируем повторный вызов', {
          isInactiveStateRef: isInactiveStateRef.current,
          isEndingCallRef: isEndingCallRef.current
        });
        return;
      }
      
      // КРИТИЧНО: Устанавливаем флаги СИНХРОННО перед вызовом session.endCall()
      // Это предотвратит повторные вызовы handleCallEnded (особенно важно на iOS)
      isEndingCallRef.current = true;
      isInactiveStateRef.current = true;
      
      const currentSession = sessionRef.current || (global as any).__webrtcSessionRef?.current;
      
      if (currentSession) {
        try {
          // КРИТИЧНО: Сначала останавливаем локальные стримы напрямую
          // Это гарантирует, что камера остановится даже если компонент размонтирован
          const localStream = currentSession.getLocalStream?.();
          stopStreamTracks(localStream, 'cleanupFunction/sessionLocalStream');
          
          // КРИТИЧНО: Вызываем session.endCall() для полной очистки
          if (typeof currentSession.cleanup === 'function') {
            logger.info('[VideoCall] Вызываем session.cleanup() из cleanupFunction');
            currentSession.cleanup();
            clearSessionRefs();
          } else if (typeof currentSession.endCall === 'function') {
            logger.info('[VideoCall] Вызываем session.endCall() из cleanupFunction');
            currentSession.endCall();
            clearSessionRefs();
          } else {
            logger.warn('[VideoCall] session.endCall недоступен в cleanupFunction');
          }

          // КРИТИЧНО: Если звонок завершают из PiP (экран звонка уже размонтирован),
          // то useAudioRouting больше не будет вызван для остановки аудио-сессии.
          // Останавливаем InCallManager вручную.
          try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
          try { InCallManager.setSpeakerphoneOn(false); } catch {}
          try { InCallManager.stop(); } catch {}
        } catch (e) {
          logger.error('[VideoCall] Error in cleanupFunction:', e);
        }
      } else {
        logger.warn('[VideoCall] Session не найдена в cleanupFunction');
      }
    };
    
    // КРИТИЧНО: Устанавливаем глобальную ссылку на функцию очистки сразу после создания сессии
    // Это нужно чтобы можно было вызвать очистку даже когда VideoCall экран размонтирован (в PiP/фоне)
    (global as any).__endCallCleanupRef.current = cleanupFunction;
    logger.info('[VideoCall] ✅ Глобальная ссылка на функцию очистки установлена при создании сессии', {
      hasCleanupFn: typeof cleanupFunction === 'function',
      hasSession: !!session
    });
    
    // КРИТИЧНО: Обработчики событий устанавливаются в отдельном useEffect ниже
    // Это гарантирует, что обработчики устанавливаются даже если сессия уже существует
    // КРИТИЧНО: Убрали зависимости roomId, callId, partnerId чтобы не пересоздавать сессию
    // Сессия создается один раз при монтировании компонента
  }, [route?.params?.directCall, route?.params?.resume, pip.visible, clearSessionRefs]);
  
  // КРИТИЧНО: Отдельный useEffect для установки обработчиков событий
  // Это гарантирует, что обработчики устанавливаются даже если сессия уже существует
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) {
      logger.debug('[VideoCall] No session for event handlers setup');
      return;
    }
    
    logger.info('[VideoCall] Setting up event handlers for existing session', {
      hasSession: !!session,
      sessionType: session.constructor.name
    });
    
    const handleRemoteViewKeyChange = (key: number) => {
      setRemoteViewKey(key);
    };
    
    const handleCallEnded = () => {
      // КРИТИЧНО: Защита от повторных вызовов - если уже в неактивном состоянии или звонок завершается, игнорируем
      if (isInactiveStateRef.current || isEndingCallRef.current) {
        logger.info('[VideoCall] handleCallEnded вызван, но уже в неактивном состоянии или звонок завершается - игнорируем повторный вызов', {
          isInactiveStateRef: isInactiveStateRef.current,
          isEndingCallRef: isEndingCallRef.current
        });
        return;
      }
      
      // КРИТИЧНО: Устанавливаем флаг СРАЗУ, чтобы предотвратить повторные вызовы
      isEndingCallRef.current = true;
      
      logger.info('[VideoCall] 🔴 callEnded event - переход в неактивное состояние', {
        roomId,
        callId,
        partnerId,
        partnerUserId,
        timestamp: Date.now()
      });
      
      // КРИТИЧНО: Устанавливаем ref СИНХРОННО перед setState, чтобы предотвратить повторные вызовы
      isInactiveStateRef.current = true;
      
      // Закрываем PiP если открыт
      if (pipRef.current.visible) {
        logger.info('[VideoCall] Закрываем PiP при завершении звонка');
        pipRef.current.hidePiP();
        sessionRef.current?.exitPiP?.();
      }
      
      // КРИТИЧНО: Останавливаем локальный стрим (камера и микрофон)
      // На Android нужно более агрессивно останавливать треки
      const localStreamSnapshot = localStreamRef.current;
      stopStreamTracks(localStreamSnapshot, 'callEnded/localStreamState');

      const sessionLocalStream = sessionRef.current?.getLocalStream?.();
      if (sessionLocalStream && sessionLocalStream !== localStreamSnapshot) {
        stopStreamTracks(sessionLocalStream, 'callEnded/sessionLocalStream');
      }
      
      setIsInactiveState(true);
      setWasFriendCallEnded(true);
      setPartnerInPiP(false);
      setFriendCallAccepted(false);
      setPartnerUserId(null);
      setRemoteViewKey(0);
      setLocalRenderKey((k: number) => k + 1);
      setLoading(false);
      setStarted(false);
      setCamOn(false);
      setMicOn(false);
      setLocalStream(null);
      remoteStreamRef.current = null;
      remoteStreamReceivedAtRef.current = null;
      setRemoteStream(null);
      
      if (typeof session.cleanup === 'function') {
        session.cleanup();
      }
      clearSessionRefs();

      // КРИТИЧНО: Сбрасываем флаг через небольшую задержку, чтобы дать состоянию обновиться
      setTimeout(() => {
        isEndingCallRef.current = false;
        logger.info('[VideoCall] isEndingCallRef сброшен в handleCallEnded');
      }, 1000);
    };
    
    const handleCallAnswered = () => {
      acceptCallTimeRef.current = Date.now();
      setFriendCallAccepted(true);
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      setStarted(true);
      setLoading(true);
      incomingCallHook.setIncomingOverlay(false);
      setCamOn(true);
      setMicOn(true);
      
      const currentLocalStream = sessionRef.current?.getLocalStream?.() || localStreamRef.current;
      if (currentLocalStream) {
        const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          videoTrack.enabled = true;
          try {
            sessionRef.current?.sendCameraState?.(undefined, true);
          } catch (e) {
            logger.warn('[VideoCall] Error sending camera state:', e);
          }
        }
      }
    };
    
    const handleCallDeclined = () => {
      logger.info('[VideoCall] 🔴 callDeclined event - очистка состояния', {
        roomId,
        callId,
        partnerId,
        partnerUserId,
        timestamp: Date.now()
      });
      
      // КРИТИЧНО: Очищаем состояние звонка при отклонении
      // Это предотвращает конфликты при следующем звонке
      incomingCallHook.setIncomingFriendCall(null);
      incomingCallHook.setIncomingCall(null);
      incomingCallHook.setIncomingOverlay(false);
      
      // КРИТИЧНО: Очищаем состояние сессии для инициатора
      // Если мы инициатор и звонок был отклонен, нужно очистить состояние
      if (route?.params?.directInitiator) {
        setStarted(false);
        setLoading(false);
        setFriendCallAccepted(false);
        setIsInactiveState(false);
        setWasFriendCallEnded(false);
        setPartnerUserId(null);
        setCallId(null);
        setRoomId(null);
        setPartnerId(null);
        currentCallIdRef.current = null;
        
        // Останавливаем локальные треки если они были созданы
        const localStreamSnapshot = localStreamRef.current;
        if (localStreamSnapshot) {
          stopStreamTracks(localStreamSnapshot, 'callDeclined/localStream');
        }
        setLocalStream(null);
        setCamOn(false);
        setMicOn(false);
      }
    };
    
    const handleRemoteState = ({ muted }: { muted?: boolean }) => {
      const remoteStreamSnapshot = remoteStreamRef.current;
      logger.info('[VideoCall] remoteState event received', {
        muted,
        currentRemoteMuted: remoteMutedRef.current,
        hasRemoteStream: !!remoteStreamSnapshot
      });
      
      if (muted !== undefined) {
        if (muted && !remoteMutedRef.current && remoteStreamSnapshot) {
          logger.warn('[VideoCall] ⚠️ remoteState пытается установить muted=true при наличии remoteStream - возможно ошибка');
        } else {
          setRemoteMuted(muted);
        }
      }
    };
    
    const handlePartnerPiPStateChanged = ({ inPiP }: { inPiP: boolean }) => {
      logger.info('[VideoCall] partnerPiPStateChanged event received', { 
        inPiP,
        previousState: partnerInPiP,
        willUpdate: partnerInPiP !== inPiP,
        roomId,
        callId,
        partnerId
      });
      
      // КРИТИЧНО: Всегда обновляем состояние partnerInPiP при получении события
      // Это гарантирует, что заглушка "Отошел" показывается/скрывается правильно
      const previousState = partnerInPiPRef.current;
      partnerInPiPRef.current = inPiP;
      setPartnerInPiP(inPiP);
      logger.info('[VideoCall] ✅ Состояние partnerInPiP обновлено', { 
        newState: inPiP,
        previousState,
        roomId,
        callId,
        partnerId,
        willShowAwayPlaceholder: inPiP === true
      });
      
      // КРИТИЧНО: Когда партнер возвращается из PiP (inPiP: false), включаем видеотрек обратно
      if (previousState === true && inPiP === false) {
        logger.info('[VideoCall] 🔄 Партнер вернулся из PiP - включаем видеотрек обратно', {
          hasRemoteStream: !!remoteStream,
          currentRemoteCamOn: remoteCamOn,
          sessionRemoteStream: !!session?.getRemoteStream?.()
        });
        
        const sessionRemoteStream = session?.getRemoteStream?.();
        if (sessionRemoteStream && (!remoteStream || remoteStream.id !== sessionRemoteStream.id)) {
          setRemoteStream(sessionRemoteStream);
          remoteStreamRef.current = sessionRemoteStream as any;
          remoteStreamReceivedAtRef.current = Date.now();
          logger.info('[VideoCall] ✅ Восстановлен remoteStream из сессии после возврата партнера из PiP', {
            streamId: sessionRemoteStream.id,
            hasVideoTrack: !!(sessionRemoteStream as any)?.getVideoTracks?.()?.[0],
          });
        }
        
        setRemoteCamOn(true);
        setRemoteViewKey(Date.now());
        logger.info('[VideoCall] ✅ Обновлен remoteViewKey после возврата партнера из PiP');
      }
    };

    // КРИТИЧНО: Если сессия была создана НЕ этим инстансом экрана (например, восстановлена из PiP),
    // то её config.callbacks указывает на старый размонтированный компонент.
    // В этом случае подписываемся на события stream и обновляем state текущего экрана.
    const needsStreamBridge = !createdSessionsRef.current.has(session as any);

    const handleLocalStreamEvent = (stream: MediaStream | null) => {
      const prev = localStreamRef.current;
      localStreamRef.current = stream as any;
      setLocalStream(stream as any);

      if (stream && (!prev || prev.id !== stream.id)) {
        setLocalRenderKey((k: number) => k + 1);
        logger.info('[VideoCall] (bridge) Local stream event - updating render key', {
          prevStreamId: prev?.id,
          newStreamId: stream.id,
          hasVideoTrack: !!(stream as any)?.getVideoTracks?.()?.[0],
        });
      }
    };

    const handleRemoteStreamEvent = (stream: MediaStream | null) => {
      remoteStreamRef.current = stream as any;
      setRemoteStream(stream as any);
      if (stream) {
        remoteStreamReceivedAtRef.current = Date.now();
        setIsInactiveState(false);
        setWasFriendCallEnded(false);
        setStarted(true);
        setLoading(false);
        setRemoteViewKey((k: number) => k + 1);
      } else {
        remoteStreamReceivedAtRef.current = null;
      }
    };
    
    // Устанавливаем обработчики событий
    session.on('remoteViewKeyChanged', handleRemoteViewKeyChange);
    session.on('callEnded', handleCallEnded);
    session.on('callAnswered', handleCallAnswered);
    session.on('callDeclined', handleCallDeclined);
    session.on('remoteState', handleRemoteState);
    session.on('partnerPiPStateChanged', handlePartnerPiPStateChanged);
    if (needsStreamBridge) {
      session.on('localStream', handleLocalStreamEvent as any);
      session.on('remoteStream', handleRemoteStreamEvent as any);
      logger.info('[VideoCall] ✅ Stream bridge enabled for reused session');
    }
    
    logger.info('[VideoCall] ✅ Event handlers установлены для сессии', {
      hasSession: !!session,
      handlersCount: needsStreamBridge ? 8 : 6,
      needsStreamBridge,
    });
    
    return () => {
      // КРИТИЧНО: Удаляем обработчики при изменении сессии или размонтировании
      if (session) {
        session.off('remoteViewKeyChanged', handleRemoteViewKeyChange);
        session.off('callEnded', handleCallEnded);
        session.off('callAnswered', handleCallAnswered);
        session.off('callDeclined', handleCallDeclined);
        session.off('remoteState', handleRemoteState);
        session.off('partnerPiPStateChanged', handlePartnerPiPStateChanged);
        if (needsStreamBridge) {
          session.off('localStream', handleLocalStreamEvent as any);
          session.off('remoteStream', handleRemoteStreamEvent as any);
        }
        logger.info('[VideoCall] Event handlers removed');
      }
    };
    // IMPORTANT: handlers should be attached once per session, not on every UI state change.
  }, [sessionRef.current, clearSessionRefs]);
  
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
    
    // КРИТИЧНО: Используем ref вместо state для синхронной проверки (важно для iOS)
    if (isInactiveStateRef.current) {
      logger.info('[VideoCall] onAbortCall вызван в неактивном состоянии - игнорируем', {
        isInactiveStateRef: isInactiveStateRef.current,
        isInactiveState
      });
      return;
    }
    
    try {
      logger.info('[VideoCall] 🛑 Завершение звонка - останавливаем камеру и микрофон', {
        roomId,
        callId,
        partnerId,
        timestamp: Date.now()
      });
      
      // Закрываем PiP если открыт
      if (pipRef.current.visible) {
        pipRef.current.hidePiP();
        session.exitPiP?.();
      }
      
      // КРИТИЧНО: Сначала принудительно останавливаем локальный стрим через session
      // Это гарантирует, что камера остановится даже если localStream в состоянии устарел
      try {
        const sessionLocalStream = session.getLocalStream?.();
        stopStreamTracks(sessionLocalStream, 'onAbortCall/sessionLocalStream');
      } catch (e) {
        logger.warn('[VideoCall] Error stopping session local stream:', e);
      }
      
      // КРИТИЧНО: Также останавливаем локальный стрим из состояния компонента
      // (на случай если он отличается от session)
      if (localStream) {
        stopStreamTracks(localStream, 'onAbortCall/localStreamState');
      }
      
      // КРИТИЧНО: СНАЧАЛА устанавливаем флаги СИНХРОННО, чтобы предотвратить повторные вызовы handleCallEnded
      // Это особенно важно на iOS, где события могут обрабатываться быстрее
      isEndingCallRef.current = true;
      isInactiveStateRef.current = true;
      setIsInactiveState(true);
      setWasFriendCallEnded(true);
      setPartnerInPiP(false);
      
      // КРИТИЧНО: Вызываем endCall в session (это также остановит стрим)
      session.endCall();
      
      // КРИТИЧНО: Очищаем локальный стрим в состоянии компонента СРАЗУ
      setLocalStream(null);
      // КРИТИЧНО: Обновляем ref СИНХРОННО перед setState
      remoteStreamRef.current = null;
      remoteStreamReceivedAtRef.current = null;
      setRemoteStream(null);
      setCamOn(false);
      setMicOn(false);
      
      if (typeof session.cleanup === 'function') {
        session.cleanup();
      }
      clearSessionRefs();

      // КРИТИЧНО: Сбрасываем флаг через небольшую задержку, чтобы дать состоянию обновиться
      setTimeout(() => {
        isEndingCallRef.current = false;
        logger.info('[VideoCall] isEndingCallRef сброшен в onAbortCall');
      }, 1000);
      
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
      logger.info('[VideoCall] ✅ Звонок завершен - экран остается открытым, кнопка "Завершить" неактивна', {
        isInactiveState: true,
        canAcceptIncoming: true
      });
    } catch (e) {
      logger.error('[VideoCall] Error ending call:', e);
    }
  }, [isInactiveState, roomId, callId, localStream]);
  
  // КРИТИЧНО: Обновляем глобальные ссылки при изменении сессии или функции очистки
  // Это гарантирует, что ссылки всегда актуальны
  // Основные ссылки устанавливаются при создании сессии выше, здесь только обновляем
  useEffect(() => {
    const session = sessionRef.current;
    
    // Обновляем ссылку на сессию (на случай если она изменилась)
    if (session) {
      (global as any).__webrtcSessionRef.current = session;
    }
    
    // Обновляем ссылку на функцию очистки
    // Основная функция очистки устанавливается при создании сессии выше
    // Здесь обновляем только если onAbortCall изменился (как дополнительная опция)
    // Но приоритет у cleanupFunction, установленной при создании сессии
    if (typeof onAbortCall === 'function' && !(global as any).__endCallCleanupRef?.current) {
      // Если cleanupFunction еще не установлена, используем onAbortCall
      (global as any).__endCallCleanupRef.current = onAbortCall;
      logger.info('[VideoCall] Установлена cleanup функция из onAbortCall (fallback)');
    }
    
    logger.info('[VideoCall] Глобальные ссылки обновлены в useEffect', {
      hasSession: !!session,
      hasCleanupFn: typeof onAbortCall === 'function',
      __webrtcSessionRef: !!(global as any).__webrtcSessionRef?.current,
      __endCallCleanupRef: !!(global as any).__endCallCleanupRef?.current
    });
    
    // Очищаем ссылки при размонтировании или если сессия удалена
    return () => {
      // Очищаем только если сессия действительно удалена
      if (!sessionRef.current) {
        (global as any).__webrtcSessionRef.current = null;
        (global as any).__endCallCleanupRef.current = null;
        logger.info('[VideoCall] Глобальные ссылки очищены (сессия удалена)');
      }
    };
  }, [onAbortCall]);
  
  const toggleMic = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.toggleMic === 'function') {
      session.toggleMic();
      // КРИТИЧНО: Состояние PiP обновится через onMicStateChange callback
      // Это гарантирует синхронизацию состояния
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleMic');
    }
  }, [clearSessionRefs]);
  
  const toggleCam = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.toggleCam === 'function') {
      // Обновляем UI немедленно
      setCamOn((prev) => {
        const next = !prev;
        // КРИТИЧНО: при OFF -> ON форсим перерендер локального RTCView,
        // т.к. на Android он может "залипать" на заглушке/черном экране после PiP.
        if (next) {
          setLocalRenderKey((k: number) => k + 1);
        }
        return next;
      });
      session.toggleCam().catch((e: any) => {
        logger.warn('[VideoCall] toggleCam error:', e);
      });
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleCam');
    }
  }, []);
  
  const toggleRemoteAudio = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.toggleRemoteAudio === 'function') {
      session.toggleRemoteAudio();
      const nextMuted = !remoteMuted;
      setRemoteMuted(nextMuted);
      
      // КРИТИЧНО: Обновляем состояние PiP после переключения удаленного звука (как в эталонном файле)
      if (pip.visible) {
        pip.updatePiPState({ isRemoteMuted: nextMuted });
      }
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleRemoteAudio');
    }
  }, [remoteMuted, pip]);
  
  // КРИТИЧНО: Устанавливаем глобальные ссылки на функции управления для PiP
  // Это нужно чтобы можно было управлять микрофоном и динамиком из PiP
  useEffect(() => {
    (global as any).__toggleMicRef.current = toggleMic;
    (global as any).__toggleRemoteAudioRef.current = toggleRemoteAudio;
    
    return () => {
      (global as any).__toggleMicRef.current = null;
      (global as any).__toggleRemoteAudioRef.current = null;
    };
  }, [toggleMic, toggleRemoteAudio]);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId || !!callId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const shouldShowRemoteVideo = remoteCamOn && !isInactiveState;
  // const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0; // эквалайзер отключен
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
    const shouldShow = hasPartnerUserId && (hasStarted || hasActiveCall) && !isInactive && !callEnded && isPartnerFriend;
    
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
  
  // КРИТИЧНО: На iOS отключаем usePreventRemove - он мешает нормальному свайпу
  // PanResponder полностью обрабатывает свайп: показывает PiP и делает навигацию
  // На Android используем usePreventRemove как fallback для BackHandler
  const shouldPreventRemove = (() => {
    // На iOS не блокируем навигацию - PanResponder обработает жест
    if (Platform.OS === 'ios') return false;

    // На Android блокируем навигацию только если есть активный звонок и PiP еще не показан.
    // ВАЖНО: используем pipRef.current.visible (в логах pip.visible может оставаться false
    // сразу после showPiP, из-за чего поп может "залипать" на секунды).
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    const actualRoomId = roomId || session?.getRoomId?.() || null;
    const actualCallId = callId || session?.getCallId?.() || null;
    const actualPartnerId = partnerId || session?.getPartnerId?.() || null;
    const hasActiveCall = (!!actualRoomId || !!actualCallId || !!actualPartnerId) && !isInactiveState && !wasFriendCallEnded;
    const pipVisibleNow = !!pipRef.current?.visible;

    return hasActiveCall && !pipVisibleNow;
  })();
  
  usePreventRemove(
    shouldPreventRemove,
    (e) => {
      // Android: перехватываем уход со страницы (и hardware back, и swipe-back).
      // Требование: сначала делаем "назад", и уже на предыдущем экране показываем PiP.
      if (Platform.OS === 'android' && enterPiPModeRef.current) {
        requestAnimationFrame(() => {
          const action = (e as any)?.data?.action;
          if (action) {
            (navigation as any).dispatch(action);
          }
          // Если action нет, всё равно пытаемся уйти назад
          if (!action) {
            if (navigation.canGoBack && navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Home' as never);
            }
          }

          // После запуска навигации показываем PiP (не до!), чтобы визуально он появился уже "на предыдущей".
          // Используем rAF (вместо setTimeout), чтобы не ловить задержки на загруженном JS.
          requestAnimationFrame(() => {
            enterPiPModeRef.current?.();
          });
        });
      }
    }
  );

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
        
        logger.info('[VideoCall] Возврат из PiP - обрабатываем');
        
        // Прячем PiP только при возврате из PiP
        if (pipRef.current.visible) {
          logger.info('[VideoCall] Hiding PiP after return from PiP');
          pipRef.current.hidePiP();
          
          // Получаем roomId из route.params или session
          const routeRoomId = route?.params?.roomId;
          const session = sessionRef.current;
          const currentRoomId = roomId || routeRoomId || session?.getRoomId?.() || null;
          
          // КРИТИЧНО: Вызываем exitPiP для отправки pip:state=false партнеру
          if (session && session.exitPiP && typeof session.exitPiP === 'function') {
            session.exitPiP();
            logger.info('[VideoCall] ✅ Вызван session.exitPiP() - отправлено pip:state=false партнеру');
          } else {
            // Fallback: отправляем pip:state напрямую если метод недоступен
            const hasActiveCall = !!currentRoomId || !!callId || !!partnerId;
            if (hasActiveCall && currentRoomId) {
              try {
                const payload: any = { 
                  inPiP: false, 
                  from: socket.id,
                  roomId: currentRoomId
                };
                if (partnerId) payload.to = partnerId;
                socket.emit('pip:state', payload);
                logger.info('[VideoCall] ✅ Sent pip:state=false to partner (returned from PiP, fallback):', { payload });
                
                // Отправляем повторно через 300мс (гарантия при гонке состояний)
                setTimeout(() => {
                  try {
                    socket.emit('pip:state', payload);
                    logger.info('[VideoCall] ✅ Re-sent pip:state=false (300ms retry)');
                  } catch (e) {
                    logger.warn('[VideoCall] ❌ Error re-sending pip:state:', e);
                  }
                }, 300);
              } catch (e) {
                logger.warn('[VideoCall] ❌ Error sending pip:state:', e);
              }
            }
          }
        }
        
        // Если у нас есть удалённый поток из PiP-контекста — подставим его в state
        if (!remoteStreamRef.current && pip.remoteStream) {
          setRemoteStream(pip.remoteStream);
          remoteStreamRef.current = pip.remoteStream as any;
          logger.info('[VideoCall] Restored remoteStream from PiP context');
        }
        
        const session = sessionRef.current;
        if (session) {
          // Восстанавливаем стримы из PiP перед выходом
          const pipLocalStream = pip.localStream;
          const pipRemoteStream = pip.remoteStream;
          
          // КРИТИЧНО: Восстанавливаем локальный стрим из сессии (если есть), иначе из PiP контекста.
          // ВАЖНО: НЕ форсим включение камеры. Состояние камеры после возврата должно
          // быть ровно таким, каким было до ухода в PiP (pip.localCamOn).
          const sessionLocalStream = session.getLocalStream?.();
          const desiredCamOn = typeof pip.localCamOn === 'boolean' ? pip.localCamOn : camOn;
          if (sessionLocalStream) {
            setLocalStream(sessionLocalStream);
            localStreamRef.current = sessionLocalStream as any;
            // Обновляем localRenderKey чтобы видео обновилось в UI
            setLocalRenderKey((k: number) => k + 1);
            
            // Применяем сохранённое состояние камеры (best-effort)
            try {
              const videoTrack = (sessionLocalStream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack) {
                videoTrack.enabled = !!desiredCamOn;
              }
            } catch {}
            setCamOn(!!desiredCamOn);
            
            logger.info('[VideoCall] ✅ Локальный стрим восстановлен из сессии при возврате из PiP', {
              streamId: sessionLocalStream.id,
              desiredCamOn,
            });
          } else if (pipLocalStream) {
            setLocalStream(pipLocalStream);
            localStreamRef.current = pipLocalStream as any;
            // Обновляем localRenderKey чтобы видео обновилось в UI
            setLocalRenderKey((k: number) => k + 1);
            
            // Применяем сохранённое состояние камеры (best-effort)
            try {
              const videoTrack = (pipLocalStream as any)?.getVideoTracks?.()?.[0];
              if (videoTrack) {
                videoTrack.enabled = !!desiredCamOn;
              }
            } catch {}
            setCamOn(!!desiredCamOn);
            
            logger.info('[VideoCall] Локальный стрим восстановлен из PiP контекста при возврате', {
              desiredCamOn,
            });
          } else {
            logger.warn('[VideoCall] ⚠️ Локальный стрим не найден ни в сессии, ни в PiP контексте при возврате из PiP');
          }
          
          // КРИТИЧНО: При возврате из PiP восстанавливаем remoteStream из сессии (если есть)
          // Это гарантирует, что видеопоток восстановится у обоих участников
          const sessionRemoteStream = session.getRemoteStream?.();
          if (sessionRemoteStream) {
            setRemoteStream(sessionRemoteStream);
            remoteStreamRef.current = sessionRemoteStream as any;
            remoteStreamReceivedAtRef.current = Date.now();
            logger.info('[VideoCall] ✅ Удаленный стрим восстановлен из сессии при возврате из PiP', {
              streamId: sessionRemoteStream.id,
              hasVideoTrack: !!(sessionRemoteStream as any)?.getVideoTracks?.()?.[0],
              hasAudioTrack: !!(sessionRemoteStream as any)?.getAudioTracks?.()?.[0],
            });
          } else if (pipRemoteStream) {
            setRemoteStream(pipRemoteStream);
            remoteStreamRef.current = pipRemoteStream as any;
            remoteStreamReceivedAtRef.current = Date.now();
            logger.info('[VideoCall] Удаленный стрим восстановлен из PiP контекста при возврате', {
              streamId: pipRemoteStream.id,
            });
          }
          
          // ВАЖНО: НЕ включаем локальные/удалённые видеотреки насильно.
          // Локальный трек приводим к сохранённому состоянию (desiredCamOn),
          // а удалённый трек/remoteCamOn должен управляться состоянием партнёра (cam-toggle/LiveKit).
          try {
            const currentLocalStream = sessionLocalStream || pipLocalStream || localStream || localStreamRef.current;
            const lt = currentLocalStream?.getVideoTracks?.()?.[0];
            if (lt) {
              lt.enabled = !!desiredCamOn;
              logger.info('[VideoCall] ✅ Локальный видеотрек обработан после возврата из PiP', {
                trackId: lt.id,
                trackEnabled: lt.enabled,
                trackReady: lt.readyState,
                trackMuted: lt.muted,
                streamId: currentLocalStream?.id,
              });
            } else {
              logger.warn('[VideoCall] ⚠️ Локальный видеотрек не найден при возврате из PiP', {
                hasSessionLocalStream: !!sessionLocalStream,
                hasPipLocalStream: !!pipLocalStream,
                hasLocalStream: !!localStream,
                hasLocalStreamRef: !!localStreamRef.current,
              });
            }
            
            // Для удалённого видео делаем только форс-перерисовку (без изменения enabled/remoteCamOn).
            setRemoteViewKey(Date.now());
          } catch (e) {
            logger.warn('[VideoCall] Error enabling video tracks:', e);
          }
          
          session.exitPiP?.();
          
          // Обновляем remoteViewKey через session с защитой от повторного обновления
          requestAnimationFrame(() => {
            if (!pipReturnUpdateRef.current) {
              pipReturnUpdateRef.current = true;
              const remoteViewKeyFromSession = (session as any).getRemoteViewKey?.();
              if (remoteViewKeyFromSession !== undefined) {
                setRemoteViewKey(remoteViewKeyFromSession);
              } else {
                // Fallback: обновляем remoteViewKey если его нет в session
                setRemoteViewKey(Date.now());
              }
              setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
            }
          });
        }
        
        // Форсим спикер при возврате из PiP
        try {
          forceSpeakerOnHard();
          logger.info('[VideoCall] Force enabled speaker');
        } catch (e) {
          logger.warn('[VideoCall] Error enabling speaker:', e);
        }
        
        // Сбрасываем guard через небольшую задержку
        setTimeout(() => {
          focusEffectGuardRef.current = false;
        }, 300);
      } else {
        // Обычный фокус: не меняем состояние камеры автоматически.
        // Если камера должна быть включена (camOn=true), можно best-effort синхронизировать enabled,
        // но не включать, если пользователь выключил.
        try {
          const stream = localStream || localStreamRef.current;
          const t = stream?.getVideoTracks?.()?.[0];
          if (t) {
            t.enabled = !!camOn;
          }
        } catch (e) {
          logger.warn('[VideoCall] Error syncing local video track on focus:', e);
        }
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
          
          // КРИТИЧНО: Используем avatarThumbB64 (data URI) для аватара в PiP
          // Это соответствует тому, как аватары используются в других частях приложения
          let avatarUrl: string | undefined = undefined;
          if (partner?.avatarThumbB64 && typeof partner.avatarThumbB64 === 'string' && partner.avatarThumbB64.trim() !== '') {
            // Преобразуем base64 в data URI если нужно (для Android Glide требуется data: префикс)
            const thumbB64 = partner.avatarThumbB64.trim();
            avatarUrl = thumbB64.startsWith('data:') ? thumbB64 : `data:image/jpeg;base64,${thumbB64}`;
          } else if (partner?.avatarB64 && typeof partner.avatarB64 === 'string' && partner.avatarB64.trim() !== '') {
            // Fallback: используем полный аватар если миниатюры нет
            // Преобразуем base64 в data URI если нужно (для Android Glide требуется data: префикс)
            const avatarB64 = partner.avatarB64.trim();
            avatarUrl = avatarB64.startsWith('data:') ? avatarB64 : `data:image/jpeg;base64,${avatarB64}`;
          } else if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
            // Fallback: используем URL аватара если нет base64
            // КРИТИЧНО: В production используйте домен с HTTPS, не IP адреса!
            const DEFAULT_URL = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
            const IOS_URL = process.env.EXPO_PUBLIC_SERVER_URL_IOS || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
            const ANDROID_URL = process.env.EXPO_PUBLIC_SERVER_URL_ANDROID || process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
            const serverUrl = (Platform.OS === 'android' ? ANDROID_URL : IOS_URL).replace(/\/+$/, '');
            avatarUrl = partner.avatar.startsWith('http') 
              ? partner.avatar 
              : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
          }
          
          logger.info('[VideoCall] Аватар для PiP', {
            hasPartner: !!partner,
            hasAvatarThumbB64: !!(partner?.avatarThumbB64),
            hasAvatarB64: !!(partner?.avatarB64),
            hasAvatar: !!(partner?.avatar),
            hasAvatarUrl: !!avatarUrl,
            partnerId: partner?._id
          });
          
          // Показываем PiP
          currentPip.showPiP({
            callId: callId || '',
            roomId: roomId || '',
            partnerName: partner?.nick || '',
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
  
  
  return (
    <SafeAreaView 
      style={[styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }]}
      // Android: safe-area отступы считаем сами через insets, чтобы низ/верх точно не прилипали к системе
      edges={Platform.OS === 'android' ? [] : undefined}
    >
      <View style={[styles.content, androidContentInsets]}>
        <View style={styles.topSection}>
        {/* Карточка "Собеседник" */}
        <View
          style={styles.card}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            logger.info('[VideoCall] Remote card layout', { width, height });
          }}
        >
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
            remoteStreamReceivedAt={remoteStreamReceivedAtRef.current}
            partnerInPiP={partnerInPiP}
          />
          
          {showIncomingFriendOverlay && (
            <View style={styles.incomingOverlayContainer}>
              <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.5)' },
                ]}
              />
              <View style={styles.incomingOverlayContent}>
                <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                  <Animated.View style={buildIncomingWaveStyle(incomingWaveA, 'left')} />
                  <Animated.View style={buildIncomingWaveStyle(incomingWaveB, 'right')} />
                  <Animated.View style={incomingCallIconStyle}>
                    <MaterialIcons name="call" size={48} color="#4FC3F7" />
                  </Animated.View>
                </View>
                <Text style={styles.incomingOverlayTitle}>{t('incomingCallTitle', lang)}</Text>
                <Text style={styles.incomingOverlayName}>{incomingCallerLabel}</Text>
                <View style={styles.incomingOverlayButtons}>
                  <TouchableOpacity
                    onPress={handleIncomingAccept}
                    style={[styles.btnGlassBase, styles.btnGlassSuccess]}
                  >
                    <Text style={styles.modalBtnText}>{t('accept', lang)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleIncomingDecline}
                    style={[styles.btnGlassBase, styles.btnGlassDanger]}
                  >
                    <Text style={styles.modalBtnText}>{t('decline', lang)}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}
          
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
        
        {/* Эквалайзер отключен */}
        
        {/* Карточка "Вы" */}
        <View
          style={styles.card}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            logger.info('[VideoCall] Local card layout', { width, height });
          }}
        >
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
            <Text style={styles.bigBtnText}>{t('endCall', lang)}</Text>
            <MaterialIcons name="call-end" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    // padding не задаём тут: на Android safe-area + базовый отступ считаем во внутреннем контейнере (styles.content)
  },
  content: {
    flex: 1,
    width: '100%',
    alignItems: "center",
    justifyContent: 'space-between',
  },
  topSection: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
  },
  card: {
    ...CARD_BASE,
    width: Platform.OS === 'android' ? '100%' : '94%',
    ...(Platform.OS === 'android'
      ? {
          flex: 1,
          flexBasis: 0,
          minHeight: 170,
        }
      : { height: Dimensions.get('window').height * 0.4 }),
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
    width: '100%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 14 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
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
  incomingOverlayContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 10,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  incomingOverlayContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  incomingOverlayTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 10,
  },
  incomingOverlayName: {
    color: '#e5e7eb',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
  incomingOverlayButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    marginTop: 16,
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
