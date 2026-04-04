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
  InteractionManager,
  NativeModules,
  AppState,
} from 'react-native';
import { CommonActions, useNavigation, useFocusEffect, usePreventRemove, useIsFocused } from '@react-navigation/native';
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
import { usePiP, isPipOverlayVisibleSync } from '../../src/pip/PiPContext';
import socket, {
  fetchFriends,
  getCurrentUserId,
  setActiveVideoCall,
  onConnected,
  emitPresenceUpdateIfChanged,
} from '../../sockets/socket';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import { useAudioRouting } from './hooks/useAudioRouting';
import { usePiP as usePiPHook } from './hooks/usePiP';
import { useIncomingCall } from './hooks/useIncomingCall';
import AsyncStorage from '@react-native-async-storage/async-storage';
import InCallManager from 'react-native-incall-manager';
import { reportEndCallToCallKeep, bringMainActivityToFront } from '../../utils/callKeep';
import { clearCallRelatedNotificationsAndSyncBadge, syncAppBadgeFromMissedCount } from '../../utils/pushNotifications';
import { emitMissedClear, emitCallEndedOnHome } from '../../utils/globalEvents';

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

    // Менее шумно: детали остановки стримов/треков — только в debug.
    logger.debug('[VideoCall] Stopping local stream tracks', {
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

          logger.debug('[VideoCall] Track stopped', {
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
  /** Синхронно с state для логов MIC_TRACE (без отставания на один кадр). */
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;
  const micTraceSeqRef = useRef(0);
  const logMicTraceRef = useRef<(where: string, details?: Record<string, unknown>) => void>(() => {});
  logMicTraceRef.current = (where: string, details?: Record<string, unknown>) => {
    const seq = ++micTraceSeqRef.current;
    logger.info(`[MIC_TRACE #${seq}] ${where}`, {
      ts: Date.now(),
      uiMicOn: micOnRef.current,
      ...details,
    });
  };

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
    // Noisy UI-state logs should be DEBUG-level (hidden by default LOG_LEVEL=info).
    logger.debug('[VideoCall] partnerInPiP state changed', { 
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

  // Ref текущего собеседника и активного звонка — чтобы App не показывал «входящий» от того же пользователя и список друзей держал кнопку задизейбленной.
  // КРИТИЧНО: Считаем звонок активным только по факту завершения (wasFriendCallEnded), не по isInactiveState — иначе при PiP/возврате/рассинхроне бейдж и кнопка сбрасываются.
  const hasActiveCallWithPartnerRef = !!(roomId || callId || partnerId) && !wasFriendCallEnded;
  useEffect(() => {
    const g = global as any;
    if (!g.__videoCallPartnerUserIdRef) g.__videoCallPartnerUserIdRef = { current: null };
    if (!g.__videoCallActiveRef) g.__videoCallActiveRef = { current: false };
    g.__videoCallPartnerUserIdRef.current = hasActiveCallWithPartnerRef ? partnerUserId : null;
    g.__videoCallActiveRef.current = hasActiveCallWithPartnerRef;
    // Не очищаем refs в cleanup при размонтировании (PiP) — только при завершении звонка (effect перезапишет при wasFriendCallEnded или handleCallEnded явно очистит).
  }, [hasActiveCallWithPartnerRef, partnerUserId]);
  const [friendCallAccepted, setFriendCallAccepted] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(1));
  const incomingCallBounce = useRef(new Animated.Value(0)).current;
  const incomingWaveA = useRef(new Animated.Value(0)).current;
  const incomingWaveB = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isInactiveStateRef.current || isEndingCallRef.current) return;
    if (!remoteStream) {
      // Не сбрасываем remoteCamStateKnownRef: состояние камеры уже известно из cam-toggle.
      // Пока стрима нет, не затираем remoteCamOn в true — иначе после cam-toggle(false) до прихода
      // remoteStream заглушка «Отошёл» исчезает (тот же класс багов, что был с микрофоном).
      if (!remoteCamStateKnownRef.current) {
        setRemoteCamOn(true);
      }
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
      
      // Синхронизируем remoteCamOn с реальным состоянием трека (включён/выключен)
      if (hasRenderableVideo) {
        logger.info('[VideoCall] Устанавливаем remoteCamOn=true - есть готовый видеотрек', {
          streamId: remoteStream.id,
          videoTrackId: videoTrack?.id,
          videoTrackReady,
          videoTrackEnabled
        });
        setRemoteCamOn(true);
      } else if (hasVideoTrack && !videoTrackEnabled) {
        // Трек есть, но отключён (партнёр выключил камеру)
        setRemoteCamOn(false);
      } else {
        // Нет видеотрека или ещё не готов — по умолчанию считаем камеру включённой до явного cam-toggle
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

  // Хук для входящих звонков (игнорируем входящий от текущего собеседника при активном звонке)
  const incomingCallHook = useIncomingCall({
    myUserId,
    routeParams: route?.params,
    friendCallAccepted,
    currentCallIdRef,
    session: sessionRef.current,
    partnerUserId,
    hasActiveCallWithPartner: hasActiveCallWithPartnerRef,
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
      const camOnAccept = sessionRef.current?.getIsCamOn?.() ?? true;
      setCamOn(camOnAccept);
      logMicTraceRef.current('incoming useIncomingCall onAccept → setMicOn(true)', {
        callId,
        fromUserId,
        camOnAccept,
      });
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
  const enterPiPModeRef = useRef<((opts?: { deferVisible?: boolean }) => void) | null>(null);
  
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
    remoteCamOn,
    localStream,
    remoteStream,
    friends,
    routeParams: route?.params,
    session: sessionRef.current,
    acceptCallTimeRef,
    // Android Back обрабатываем внутри usePiP: уходим на предыдущий экран приложения
    // и показываем поверх него in-app PiP без сворачивания задачи.
    enableAndroidBackHandler: true,
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
      if (pipRef.current.visible || isPipOverlayVisibleSync()) return;
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
  const { syncRouteNow } = useAudioRouting(hasActiveCallForAudio && !isInactiveState, currentRemoteStream);
  
  // Refs
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const isInactiveStateRef = useRef(false);
  const isEndingCallRef = useRef(false); // КРИТИЧНО: Флаг для предотвращения повторных вызовов handleCallEnded
  const [isEndingCall, setIsEndingCall] = useState(false); // Синхронно с ref: скрываем бейдж/активный звонок при завершении, чтобы не мигало
  const callEndedTransitionDoneRef = useRef(false); // Один переход в UI «завершён» — защита от многократных setState при disconnect + call:ended
  // КРИТИЧНО: изменения sessionRef.current сами по себе НЕ триггерят ререндер.
  // В dev это может маскироваться (StrictMode), но в release приводит к тому, что эффекты
  // установки хендлеров/бриджа стримов не срабатывают. Поэтому используем tick.
  const [sessionTick, setSessionTick] = useState(0);
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
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState(AppState.currentState);
  
  // Обновляем friendsRef при изменении friends
  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => setAppState(next));
    return () => sub.remove();
  }, []);

  // Задержка перед включением системного PiP после принятия/подключения (избегаем ложного onUserLeaveHint при закрытии IncomingCallActivity).
  const systemPiPGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemPiPLeaveHintLogRef = useRef<string>('');
  const systemPiPGraceKeyRef = useRef<string>('');
  const systemPiPGraceCompletedRef = useRef(false);

  // __currentCallPiPParamsRef — callId/roomId/navParams для системного PiP и для returnToCall. Читается в PiPContext
  // при AboutToEnterSystemPiP и в App при SystemPiPExpanded fallback. Не обнуляем при !canEnableSystemPiP, только
  // при реальном завершении сессии (cleanup эффекта), иначе при возврате из PiP returnToCall получит null.
  useEffect(() => {
    const g = (global as any);
    g.__currentCallPiPParamsRef = g.__currentCallPiPParamsRef || { current: null };
    const systemPiPKey = `${roomId || ''}:${callId || ''}`;
    if (systemPiPGraceKeyRef.current !== systemPiPKey) {
      if (systemPiPGraceTimerRef.current) {
        clearTimeout(systemPiPGraceTimerRef.current);
        systemPiPGraceTimerRef.current = null;
      }
      systemPiPGraceKeyRef.current = systemPiPKey;
      systemPiPGraceCompletedRef.current = false;
    }
    // ВАЖНО: Включаем системный PiP только когда звонок уже "стабилен" (есть roomId),
    // экран VideoCall в фокусе и приложение активно. Иначе на части устройств возможен
    // ложный onUserLeaveHint во время переходов (accept/закрытие нативных экранов),
    // и пользователя "выбрасывает" на рабочий стол с системным PiP.
    const sessionForSystemPiP = sessionRef.current || g.__webrtcSessionRef?.current;
    const sessionAliveForSystemPiP =
      !sessionForSystemPiP ||
      typeof (sessionForSystemPiP as any).isEnded !== 'function' ||
      !(sessionForSystemPiP as any).isEnded();
    const globalVideoCallActiveForPiP = g.__videoCallActiveRef?.current !== false;
    const hasStableSystemPiPContext =
      Platform.OS === 'android' &&
      !!roomId &&
      !isInactiveState &&
      !!sessionForSystemPiP &&
      sessionAliveForSystemPiP &&
      globalVideoCallActiveForPiP;
    const canEnableSystemPiP =
      Platform.OS === 'android' &&
      appState === 'active' &&
      isFocused &&
      !!roomId &&
      !isInactiveState &&
      !!sessionForSystemPiP &&
      sessionAliveForSystemPiP &&
      globalVideoCallActiveForPiP;
    const systemPiPEntryUntil = g.__systemPiPEntryInProgressUntilRef?.current;
    const systemPiPEntryInProgress =
      typeof systemPiPEntryUntil === 'number' && systemPiPEntryUntil > Date.now();

    // Не очищаем ref при !canEnableSystemPiP — иначе при возврате из системного PiP returnToCall получит null.
    // Очищаем только в cleanup эффекта, когда сессия реально завершена (stillActive === false).
    if (!hasStableSystemPiPContext) {
      if (systemPiPGraceTimerRef.current) {
        clearTimeout(systemPiPGraceTimerRef.current);
        systemPiPGraceTimerRef.current = null;
      }
      const logKey = JSON.stringify({
        state: 'blocked',
        appState,
        isFocused,
        hasRoomId: !!roomId,
        isInactiveState,
        hasSession: !!sessionRef.current,
      });
      if (systemPiPLeaveHintLogRef.current !== logKey) {
        systemPiPLeaveHintLogRef.current = logKey;
        logger.info('[VideoCall] system PiP leaveHint blocked in VideoCall effect', {
          appState,
          isFocused,
          hasRoomId: !!roomId,
          isInactiveState,
          hasSession: !!sessionRef.current,
        });
      }
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      return;
    }
    // После первого успешного grace оставляем leaveHint включённым на весь текущий звонок.
    // Иначе при Home/background effect успевает выключить флаг раньше onUserLeaveHint,
    // и системный PiP открывается нестабильно.
    if (systemPiPGraceCompletedRef.current) {
      const readyLogKey = JSON.stringify({
        state: 'ready',
        appState,
        isFocused,
        hasRoomId: !!roomId,
        isInactiveState,
        hasSession: !!sessionRef.current,
      });
      if (systemPiPLeaveHintLogRef.current !== readyLogKey) {
        systemPiPLeaveHintLogRef.current = readyLogKey;
        logger.info('[VideoCall] system PiP leaveHint kept enabled for active call', {
          appState,
          isFocused,
          hasRoomId: !!roomId,
          isInactiveState,
          hasSession: !!sessionRef.current,
        });
      }
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true); } catch (_) {}
      }
    } else if (!canEnableSystemPiP) {
      if (systemPiPGraceTimerRef.current) {
        clearTimeout(systemPiPGraceTimerRef.current);
        systemPiPGraceTimerRef.current = null;
      }
      const state = systemPiPEntryInProgress ? 'preserved-during-entry' : 'waiting-for-grace';
      const logKey = JSON.stringify({
        state,
        appState,
        isFocused,
        hasRoomId: !!roomId,
        isInactiveState,
        hasSession: !!sessionRef.current,
      });
      if (systemPiPLeaveHintLogRef.current !== logKey) {
        systemPiPLeaveHintLogRef.current = logKey;
        logger.info(
          systemPiPEntryInProgress
            ? '[VideoCall] system PiP leaveHint preserved while native PiP entry is in progress'
            : '[VideoCall] system PiP leaveHint waiting for active/focused state before grace completes',
          {
            appState,
            isFocused,
            hasRoomId: !!roomId,
            isInactiveState,
            hasSession: !!sessionRef.current,
            systemPiPEntryInProgress,
          }
        );
      }
      // Не выключать leaveHint при уходе в background при активном звонке — иначе по нажатию Home
      // эффект перезапускается (appState='background'), canEnableSystemPiP=false, и мы гасим системный PiP.
      // Учитываем background+звонок даже без завершённого grace: иначе у одного пользователя (напр. звонящий,
      // только что открывший VideoCall) PiP не сработает, если он нажал Home до истечения grace.
      const hasSessionAny = !!sessionRef.current || !!g.__webrtcSessionRef?.current;
      const isBackgroundWithActiveCall =
        appState === 'background' &&
        Platform.OS === 'android' &&
        !!roomId &&
        !isInactiveState &&
        !!hasSessionAny;
      if (!systemPiPEntryInProgress && !isBackgroundWithActiveCall && Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      if (isBackgroundWithActiveCall && Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true); } catch (_) {}
      }
    } else {
    // После принятия вызова возможен ложный onUserLeaveHint при закрытии нативного экрана входящего/исходящего.
    // Включаем PiP по LeaveHint через 1 с после стабилизации (короткий grace — чтобы на обоих устройствах
    // leaveHint успевал включиться до нажатия Home и звонок не обрывался).
    const SYSTEM_PIP_GRACE_MS = 1000;
    if (Platform.OS === 'android' && !systemPiPGraceTimerRef.current) {
      if (systemPiPGraceTimerRef.current) {
        clearTimeout(systemPiPGraceTimerRef.current);
        systemPiPGraceTimerRef.current = null;
      }
      const scheduleLogKey = JSON.stringify({
        state: 'scheduled',
        roomId: !!roomId,
        appState,
        isFocused,
        isInactiveState,
      });
      if (systemPiPLeaveHintLogRef.current !== scheduleLogKey) {
        systemPiPLeaveHintLogRef.current = scheduleLogKey;
        logger.info('[VideoCall] system PiP leaveHint grace timer scheduled', {
          delayMs: SYSTEM_PIP_GRACE_MS,
          appState,
          isFocused,
          hasRoomId: !!roomId,
          isInactiveState,
          hasSession: !!sessionRef.current,
        });
      }
      systemPiPGraceTimerRef.current = setTimeout(() => {
        systemPiPGraceTimerRef.current = null;
        systemPiPGraceCompletedRef.current = true;
        logger.info('[VideoCall] system PiP leaveHint enabled after grace timer', {
          delayMs: SYSTEM_PIP_GRACE_MS,
          hasRoomId: !!roomId,
          appState,
          isFocused,
          isInactiveState,
          hasSession: !!sessionRef.current,
        });
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true); } catch (_) {}
      }, SYSTEM_PIP_GRACE_MS);
    }
    }
    const partner = partnerUserId
      ? friendsRef.current?.find((f: any) => String(f._id) === String(partnerUserId))
      : null;
    let avatarUrl: string | undefined;
    if (partner?.avatarThumbB64?.trim()) {
      const t = String(partner.avatarThumbB64).trim();
      avatarUrl = t.startsWith('data:') ? t : `data:image/jpeg;base64,${t}`;
    } else if (partner?.avatarB64?.trim()) {
      const t = String(partner.avatarB64).trim();
      avatarUrl = t.startsWith('data:') ? t : `data:image/jpeg;base64,${t}`;
    } else if (partner?.avatar?.trim()) {
      const base = process.env.EXPO_PUBLIC_SERVER_URL || 'https://api.liviapp.com';
      const a = String(partner.avatar).trim();
      avatarUrl = a.startsWith('http') ? a : `${base.replace(/\/+$/, '')}${a.startsWith('/') ? '' : '/'}${a}`;
    }
    g.__currentCallPiPParamsRef.current = {
      callId: callId || '',
      roomId: roomId || '',
      partnerName: (partner as any)?.nick || '',
      partnerAvatarUrl: avatarUrl,
      localStream: localStream || null,
      remoteStream: remoteStream || null,
      localCamOn: camOn,
      remoteCamOn,
      navParams: { ...route?.params, peerUserId: partnerUserId, partnerId } as any,
    };
    return () => {
      if (systemPiPGraceTimerRef.current) {
        clearTimeout(systemPiPGraceTimerRef.current);
        systemPiPGraceTimerRef.current = null;
      }
      // При уходе по «Назад» (in-app PiP) или по «Домой» (системный PiP) не сбрасываем params и hint.
      const leavingByBack = g.__leavingVideoCallByBackRef?.current === true;
      const leavingByHome = g.__leavingVideoCallByHomeRef?.current === true;
      if (leavingByBack) {
        g.__leavingVideoCallByBackRef.current = false;
        return;
      }
      if (leavingByHome) {
        g.__leavingVideoCallByHomeRef.current = false;
        return;
      }
      const session = sessionRef.current || g.__webrtcSessionRef?.current;
      const stillActive = session && (typeof session.isEnded !== 'function' || !session.isEnded());
      if (stillActive) return;
      g.__currentCallPiPParamsRef.current = null;
      systemPiPGraceCompletedRef.current = false;
      systemPiPGraceKeyRef.current = '';
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
    };
  }, [roomId, callId, isInactiveState, partnerUserId, partnerId, localStream, remoteStream, camOn, remoteCamOn, route?.params, isFocused, appState]);

  // КРИТИЧНО: Выставляем «активный видеозвонок» при показе экрана VideoCall (а не только после connectToLiveKit),
  // чтобы сокет не отключался при уходе в фон до создания комнаты (например, ответ на звонок с блокировки).
  useEffect(() => {
    const p = route?.params;
    const hasCallIntent = !!(p?.callId || p?.roomId || p?.peerUserId || p?.directCall);
    if (hasCallIntent) setActiveVideoCall(true);
  }, [route?.params]);

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

  // Возврат с Home/in-app PiP на экран звонка только ради корректного входа в системный PiP.
  // На некоторых устройствах Android захватывает неверный кадр поверх Home (с сильным зумом),
  // поэтому для системного PiP кратко возвращаем живую сессию на VideoCall и входим в PiP уже отсюда.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const g = global as any;
    g.__enterSystemPiPAfterVideoCallRef = g.__enterSystemPiPAfterVideoCallRef || { current: null };
    const pending = g.__enterSystemPiPAfterVideoCallRef.current;
    if (!pending) return;
    const pendingAgeMs =
      typeof pending?.requestedAt === 'number' ? Date.now() - pending.requestedAt : Number.POSITIVE_INFINITY;
    if (pending?.source !== 'back-root' || pendingAgeMs > 2500) {
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      logger.info('[VideoCall] Ignoring stale system PiP transition request', {
        source: pending?.source,
        pendingAgeMs,
      });
      return;
    }
    const fromPiP = !!route?.params?.fromPiP;
    const resume = !!route?.params?.resume;
    if (fromPiP || resume) return;
    const globalSession = g.__webrtcSessionRef?.current;
    if (!globalSession || sessionRef.current) return;
    sessionRef.current = globalSession;
    setSessionTick((t) => t + 1);
    const restoredRemote = pip.remoteStream || globalSession.getRemoteStream?.() || null;
    const restoredLocal = pip.localStream || globalSession.getLocalStream?.() || null;
    if (restoredRemote) {
      setRemoteStream(restoredRemote);
      remoteStreamRef.current = restoredRemote as any;
      remoteStreamReceivedAtRef.current = Date.now();
    }
    if (restoredLocal) {
      setLocalStream(restoredLocal);
      localStreamRef.current = restoredLocal as any;
      setLocalRenderKey((k: number) => k + 1);
    }
    logger.info('[VideoCall] Reused existing session for system PiP transition from Home', {
      callId: pending.callId,
      roomId: pending.roomId,
      hasRemote: !!restoredRemote,
      hasLocal: !!restoredLocal,
    });
  }, [route?.params?.fromPiP, route?.params?.resume, pip.localStream, pip.remoteStream]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const g = global as any;
    g.__enterSystemPiPAfterVideoCallRef = g.__enterSystemPiPAfterVideoCallRef || { current: null };
    const pending = g.__enterSystemPiPAfterVideoCallRef.current;
    if (!pending) return;
    const pendingAgeMs =
      typeof pending?.requestedAt === 'number' ? Date.now() - pending.requestedAt : Number.POSITIVE_INFINITY;
    if (pending?.source !== 'back-root' || pendingAgeMs > 2500) {
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      logger.info('[VideoCall] Dropping stale system PiP entry after VideoCall restore', {
        source: pending?.source,
        pendingAgeMs,
      });
      return;
    }
    if (!isFocused || appState !== 'active') return;
    const session = sessionRef.current || g.__webrtcSessionRef?.current;
    if (!session) return;
    const effectiveCallId =
      callId || route?.params?.callId || session.getCallId?.() || null;
    const effectiveRoomId =
      roomId || route?.params?.roomId || session.getRoomId?.() || null;
    if (!effectiveCallId || !effectiveRoomId) return;
    if (
      (pending.callId && pending.callId !== effectiveCallId) ||
      (pending.roomId && pending.roomId !== effectiveRoomId)
    ) {
      return;
    }
    g.__enterSystemPiPAfterVideoCallRef.current = null;
    try {
      if (pipRef.current.visible || isPipOverlayVisibleSync()) pipRef.current.hidePiP();
    } catch (_) {}
    try { NativeModules.LiviAppModule?.setPiPEndCallParams?.(effectiveCallId, effectiveRoomId); } catch (_) {}
    try {
      if (typeof session.enterPiP === 'function') session.enterPiP();
    } catch (_) {}
    const upd = g.__pipUpdateStateRef?.current;
    const apply = (size: { width: number; height: number } | null) => {
      try {
        if (typeof upd === 'function') {
          upd({ pendingSystemPiP: true, allowVideoRender: true, ...(size ? { decorSizeForPiP: size } : {}) });
        }
      } catch (_) {}
      setTimeout(() => {
        try { NativeModules.LiviAppModule?.requestEnterPictureInPicture?.(); } catch (_) {}
      }, 480);
    };
    const getDecor = NativeModules.LiviAppModule?.getDecorViewSize;
    if (typeof getDecor === 'function') {
      getDecor().then((size: { width: number; height: number }) => apply(size)).catch(() => apply(null));
    } else {
      apply(null);
    }
    logger.info('[VideoCall] Entering system PiP from restored VideoCall screen', {
      callId: effectiveCallId,
      roomId: effectiveRoomId,
    });
  }, [appState, isFocused, callId, roomId, route?.params?.callId, route?.params?.roomId]);
  
  // КРИТИЧНО: При входе в видеочат с конкретным другом — обнуляем пропущенные вызовы для него
  // Это нужно чтобы счетчик пропущенных звонков сбрасывался при открытии видеочата
  useEffect(() => {
    const uid = route?.params?.peerUserId || partnerUserId;
    if (!uid) return;
    const userId = String(uid);
    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.cancelMissedCallNotificationForUser?.(userId); } catch (_) {}
    }
    (async () => {
      try {
        const key = 'missed_calls_by_user_v1';
        const raw = await AsyncStorage.getItem(key);
        const data = raw ? JSON.parse(raw) : {};
        if (data && typeof data === 'object' && data[userId]) {
          delete data[userId];
          await AsyncStorage.setItem(key, JSON.stringify(data));
          syncAppBadgeFromMissedCount().catch(() => {});
          emitMissedClear(userId);
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
  
  // Отправка статуса "busy" только когда вызов принят и оба в видеосвязи (не при дозвоне).
  // Иначе у того, кому звонят, бейдж «Занято» появляется до нажатия «Принять».
  // Важно: callConnected = friendCallAccepted && remoteStream (не OR). Иначе при обрыве LiveKit
  // remoteStream обнуляется раньше, чем приходит call:ended — эффект снова шлёт busy:true, сервер
  // рассылает друзьям бейдж «занято» на секунды после завершения звонка.
  useEffect(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    const callConnected = !!friendCallAccepted && !!remoteStream;
    const sessionEnded = !!(session && typeof session.isEnded === 'function' && session.isEnded());
    const endingNow = !!isEndingCallRef.current || (global as any).__endingCallInProgressRef?.current === true;
    const transitionDone =
      !!callEndedTransitionDoneRef.current ||
      !!wasFriendCallEnded ||
      !!isInactiveStateRef.current;
    const hasActiveCall =
      (!!roomId || !!callId || !!partnerId) &&
      !!started &&
      !isInactiveState &&
      !transitionDone &&
      callConnected &&
      !sessionEnded &&
      !endingNow;
    logger.debug('[VideoCall] presence:update решение', {
      sendBusy: hasActiveCall,
      callConnected,
      friendCallAccepted,
      hasRemoteStream: !!remoteStream,
      hasRoomId: !!roomId,
      isInactiveState,
      sessionEnded,
      endingNow,
      started,
      wasFriendCallEnded,
      transitionDone,
    });
    if (hasActiveCall) {
      try {
        const rid = (roomId || callId || '').trim();
        emitPresenceUpdateIfChanged({ status: 'busy', ...(rid ? { roomId: rid } : {}) });
      } catch (e) {
        logger.warn('[VideoCall] Error sending presence:update busy:', e);
      }
    }
  }, [roomId, callId, partnerId, isInactiveState, friendCallAccepted, remoteStream, started, wasFriendCallEnded]);
  
  // При реконнекте сокета сервер может сбросить busy — переотправляем busy, если мы всё ещё в звонке
  useEffect(() => {
    const off = onConnected(() => {
      const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
      const callConnected = !!friendCallAccepted && !!remoteStream;
      const sessionEnded = !!(session && typeof session.isEnded === 'function' && session.isEnded());
      const endingNow = !!isEndingCallRef.current || (global as any).__endingCallInProgressRef?.current === true;
      const transitionDone =
        !!callEndedTransitionDoneRef.current ||
        !!wasFriendCallEnded ||
        !!isInactiveStateRef.current;
      const hasActiveCall =
        (!!roomId || !!callId || !!partnerId) &&
        !!started &&
        !isInactiveState &&
        !transitionDone &&
        callConnected &&
        !sessionEnded &&
        !endingNow;
      if (hasActiveCall) {
        try {
          const rid = (roomId || callId || '').trim();
          emitPresenceUpdateIfChanged({ status: 'busy', ...(rid ? { roomId: rid } : {}) }, { force: true });
        } catch (e) {
          logger.warn('[VideoCall] Error re-sending presence:update busy on connect', e);
        }
      }
    });
    return () => { try { off?.(); } catch {} };
  }, [roomId, callId, partnerId, isInactiveState, friendCallAccepted, remoteStream, started, wasFriendCallEnded]);
  
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
    // НЕ очищаем __pendingCallAcceptedRef здесь: при ремаунте (двойная навигация) новая сессия должна прочитать payload и подключиться. Очищает только VideoCallSession после использования.
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
      // Восстанавливаем состояние микрофона из PiP (isMuted = true → мик выключен → micOn = false)
      logMicTraceRef.current('PiP resume effect → setMicOn from pip.isMuted', {
        pipIsMuted: pip.isMuted,
        nextMicOn: !pip.isMuted,
      });
      setMicOn(!pip.isMuted);
      if (session.exitPiP) {
        session.exitPiP();
      }
    }
    // sessionTick нужен: при возврате из PiP сессия подставляется в другом эффекте (sessionRef = global);
    // без sessionTick эффект восстановления запускается до этого и видит session = null, поэтому setMicOn не вызывается.
  }, [route?.params?.resume, route?.params?.fromPiP, pip.localStream, pip.remoteStream, pip.localCamOn, pip.isMuted, sessionTick]);

  // При возврате из фона во время видеозвонка — переподключить камеру, если система её закрыла
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const session = sessionRef.current;
      const hasActiveCall = !!(roomId || callId || partnerId) && !wasFriendCallEnded && !isInactiveState;
      if (session && hasActiveCall && camOn && typeof (session as any).reconnectCameraOnResume === 'function') {
        (session as any).reconnectCameraOnResume().catch(() => {});
      }
    });
    return () => sub.remove();
  }, [roomId, callId, partnerId, wasFriendCallEnded, isInactiveState, camOn]);
  
  // Инициализация session и восстановление состояния звонка
  useEffect(() => {
    // КРИТИЧНО: После завершения звонка не создаём новую сессию — пользователь ещё на экране VideoCall до перехода на Home.
    if (isInactiveState && wasFriendCallEnded) {
      logger.info('[VideoCall] Звонок уже завершён, пропускаем создание сессии');
      return;
    }
    callEndedTransitionDoneRef.current = false; // новый звонок — разрешаем один переход в «завершён»
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
        setSessionTick((t) => t + 1);
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
        // Восстанавливаем состояние микрофона из PiP сразу при подстановке сессии (надёжно, до любого другого эффекта)
        logMicTraceRef.current('fromPiP global session restore → setMicOn from pip.isMuted', {
          pipIsMuted: pip.isMuted,
          nextMicOn: !pip.isMuted,
        });
        setMicOn(!pip.isMuted);
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

    const resolvedMyUserId = route?.params?.myUserId || getCurrentUserId();
    const config: WebRTCSessionConfig = {
      myUserId: resolvedMyUserId,
      initialCallId: route?.params?.callId ?? pendingCallId ?? null,
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
          if (isInactiveStateRef.current || isEndingCallRef.current) return;
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
          } else {
            setRemoteMuted(false);
            remoteStreamReceivedAtRef.current = null;
          }
        },
        onPartnerIdChange: (id) => {
          if (isEndingCallRef.current) return;
          setPartnerId(id);
        },
        onRoomIdChange: (id) => {
          if (isEndingCallRef.current) return;
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
          if (isEndingCallRef.current) return;
          setCallId(id);
        },
        onMicStateChange: (enabled) => {
          logMicTraceRef.current('onMicStateChange ← VideoCall initial session config', {
            enabled,
            triggersSetMicOn: true,
          });
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
          if (isInactiveStateRef.current || isEndingCallRef.current) return;
          // Партнёр выключил/включил камеру — обновляем только remoteCamOn, звонок не завершаем
          logger.info('[VideoCall] onRemoteCamStateChange вызван', {
            enabled,
            previousRemoteCamOn: remoteCamOn,
            partnerInPiP
          });
          remoteCamStateKnownRef.current = true;
          setRemoteCamOn(enabled);
          // ВАЖНО: Не дергаем remoteViewKey из UI.
          // Этим управляет сессия через событие remoteViewKeyChanged, иначе на Android легко получить мерцания из-за частых remount RTCView.
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
      getPartnerDisplayName: () => {
        const uid = partnerUserId;
        if (!uid) return 'кто-то';
        const partner = friendsRef.current?.find((f: any) => String(f._id) === String(uid));
        const nick = (partner as any)?.nick?.trim();
        return nick || 'кто-то';
      },
      onSwitchToConnectingSession: (connectingSession: unknown) => {
        const s = connectingSession as any;
        if (!s || sessionRef.current === s) return;
        logger.info('[VideoCall] Переключаемся на сессию, которая подключается к комнате', {
          hadSession: !!sessionRef.current,
          hasRoom: !!s?.room,
          currentRoomName: s?.currentRoomName,
        });
        sessionRef.current = s;
        (global as any).__webrtcSessionRef.current = s;
        setSessionTick((t) => t + 1);
        const remote = s.getRemoteStream?.();
        const local = s.getLocalStream?.();
        if (remote) {
          remoteStreamRef.current = remote;
          setRemoteStream(remote);
          remoteStreamReceivedAtRef.current = Date.now();
        }
        if (local) {
          localStreamRef.current = local;
          setLocalStream(local);
          setLocalRenderKey((k: number) => k + 1);
        }
      },
      // Вызывается в начале handleCallEnded в сессии (до disconnectRoom), чтобы колбэки при отключении не дергали setState — без ререндеров при закрытии экрана.
      onCallEnding: () => {
        isEndingCallRef.current = true;
        isInactiveStateRef.current = true;
      },
    };

    const routeCallId = route?.params?.callId != null ? String(route.params.callId) : '';
    const effectiveCallId = routeCallId || (pendingCallId ? String(pendingCallId) : '');
    const globalSessRaw = (global as any).__webrtcSessionRef?.current;
    const globalVideoSession =
      globalSessRaw instanceof VideoCallSession ? globalSessRaw : null;

    let reusedLiveSession = false;
    let session!: VideoCallSession;

    if (
      globalVideoSession &&
      typeof globalVideoSession.isEnded === 'function' &&
      !globalVideoSession.isEnded() &&
      effectiveCallId &&
      String(globalVideoSession.getCallId?.() || '') === effectiveCallId
    ) {
      const paramRoom = route?.params?.roomId ? String(route.params.roomId) : '';
      const sessRoom = String(globalVideoSession.getRoomId?.() || '');
      const roomOk = !paramRoom || !sessRoom || paramRoom === sessRoom;
      const roomState = (globalVideoSession as any).room?.state as string | undefined;
      const lkAlive = roomState === 'connected' || roomState === 'connecting';
      if (roomOk && lkAlive) {
        reusedLiveSession = true;
        session = globalVideoSession;
        session.rebindVideoCallMount(config);
        sessionRef.current = session;
        (global as any).__webrtcSessionRef.current = session;
        setSessionTick((t) => t + 1);
        logger.info('[VideoCall] ♻️ Переиспользуем глобальную VideoCallSession (PiP/Home → снова экран), без второго LiveKit connect', {
          callId: effectiveCallId,
          roomId: sessRoom || paramRoom,
          roomState,
        });
        try {
          const rId = session.getRoomId?.();
          if (rId) setRoomId(rId);
          setCallId(effectiveCallId);
          currentCallIdRef.current = effectiveCallId;
          const pid = session.getPartnerId?.();
          if (pid) setPartnerId(pid);
          const puid = session.getPartnerUserId?.();
          if (puid) setPartnerUserId(puid);
          const loc = session.getLocalStream?.();
          if (loc) {
            localStreamRef.current = loc;
            setLocalStream(loc);
            setLocalRenderKey((k: number) => k + 1);
          }
          const rem = session.getRemoteStream?.();
          if (rem) {
            remoteStreamRef.current = rem;
            setRemoteStream(rem);
            remoteStreamReceivedAtRef.current = Date.now();
          }
          setStarted(true);
          setLoading(false);
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
          setFriendCallAccepted(true);
        } catch (e) {
          logger.warn('[VideoCall] Ошибка синхронизации UI при переиспользовании сессии', e);
        }
        try {
          if ((global as any).__pendingCallAcceptedRef) (global as any).__pendingCallAcceptedRef.current = null;
        } catch {}
      }
    }

    if (!reusedLiveSession) {
      logger.info('[VideoCall] Creating new VideoCallSession', {
        isDirectCall,
        isDirectInitiator,
        resume,
        fromPiP,
      });
      session = new VideoCallSession(config);
      sessionRef.current = session;
      try {
        createdSessionsRef.current.add(session as any);
      } catch {}
      (global as any).__webrtcSessionRef.current = session;
      logger.info('[VideoCall] ✅ Глобальная ссылка на сессию установлена при создании', {
        hasSession: !!session,
        sessionType: session.constructor.name,
      });
    } else {
      try {
        createdSessionsRef.current.add(session as any);
      } catch {}
      logger.info('[VideoCall] ✅ Глобальная ссылка — переиспользованная сессия', {
        hasSession: !!session,
        sessionType: session.constructor.name,
      });
    }

    // Восстановление состояния звонка при возврате из PiP или при инициации
    if (!reusedLiveSession && resume && fromPiP) {
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
    } else if (!reusedLiveSession && isDirectCall && isDirectInitiator && route?.params?.peerUserId) {
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
        if (route.params.roomId) {
          setRoomId(route.params.roomId);
        }
        setPartnerUserId(friendId);
        currentCallIdRef.current = existingCallId;
        setCallId(existingCallId);
        setStarted(true);
        setLoading(true);
        
        if (pendingCallId && pendingCallId === String(existingCallId)) {
          logger.info('[VideoCall] Pending call:accepted already queued, skipping connectAsInitiatorAfterAccepted', {
            existingCallId,
            friendId,
          });
          return;
        }

        if (session.didSchedulePendingCallAcceptedConnect()) {
          logger.info('[VideoCall] Session ctor scheduled pending call:accepted, skipping connectAsInitiatorAfterAccepted', {
            existingCallId,
            friendId,
          });
          return;
        }

        // Откладываем подключение до после первого кадра — меньше ANR у инициатора
        InteractionManager.runAfterInteractions(() => {
          session.connectAsInitiatorAfterAccepted(existingCallId, friendId).catch((e) => {
            logger.error('[VideoCall] Error connecting as initiator after accepted:', e);
            setStarted(false);
            setLoading(false);
          });
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
    } else if (!reusedLiveSession && isDirectCall && route?.params?.isIncoming && route?.params?.callId && route?.params?.peerUserId) {
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
      // Откладываем старт камеры/подключения до после первого кадра — меньше ANR при принятии из чата
      InteractionManager.runAfterInteractions(() => {
        session.acceptCall(incomingCallId, fromUserId).catch((e) => {
          logger.error('[VideoCall] Error accepting incoming call:', e);
          setStarted(false);
          setLoading(false);
        });
      });
    } else if (!reusedLiveSession && (route?.params?.roomId || route?.params?.callId)) {
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
      
      // КРИТИЧНО: Всегда сбрасываем refs и уведомляем HomeScreen сразу, чтобы кнопки видеозвонка и бейдж «Занят»
      // обновились сразу после завершения из in-app PiP (даже при раннем return ниже).
      try {
        (global as any).__videoCallPartnerUserIdRef = (global as any).__videoCallPartnerUserIdRef || { current: null };
        (global as any).__videoCallPartnerUserIdRef.current = null;
        (global as any).__videoCallActiveRef = (global as any).__videoCallActiveRef || { current: false };
        (global as any).__videoCallActiveRef.current = false;
        (global as any).__onVideoCallEndedRef?.current?.();
      } catch (_) {}

      // КРИТИЧНО: Защита от повторных вызовов - если звонок уже завершён/в процессе завершения, не трогаем сессию.
      // Это важно для сценария: пришёл call:ended → handleCallEnded сделал cleanup → затем компонент размонтировался и unmount-cleanup попытался вызвать cleanupFunction ещё раз.
      if (isInactiveStateRef.current || isEndingCallRef.current || callEndedTransitionDoneRef.current) {
        logger.info('[VideoCall] cleanupFunction вызвана, но уже в неактивном состоянии или звонок завершается - игнорируем повторный вызов', {
          isInactiveStateRef: isInactiveStateRef.current,
          isEndingCallRef: isEndingCallRef.current,
          callEndedTransitionDoneRef: callEndedTransitionDoneRef.current,
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
          if (typeof currentSession.isEnded === 'function' && currentSession.isEnded()) {
            clearSessionRefs();
            return;
          }
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
          // Refs и __onVideoCallEndedRef уже вызваны в начале cleanupFunction.

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
  }, [route?.params?.directCall, route?.params?.resume, pip.visible, clearSessionRefs, isInactiveState, wasFriendCallEnded]);
  
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

    // КРИТИЧНО: При переиспользовании сессии (возврат из PiP) колбэки указывают на размонтированный экземпляр.
    // Обновляем onMicStateChange/onCamStateChange чтобы кнопки микрофона и камеры реагировали на тап.
    if (typeof (session as any).updateCallbacks === 'function') {
      (session as any).updateCallbacks({
        onMicStateChange: (enabled: boolean) => {
          logMicTraceRef.current('onMicStateChange ← session.updateCallbacks', {
            enabled,
            triggersSetMicOn: true,
          });
          setMicOn(enabled);
          if (pip.visible) pip.updatePiPState({ isMuted: !enabled });
        },
        onCamStateChange: (enabled: boolean) => {
          if (enabled) setLocalRenderKey((k: number) => k + 1);
          if (pip.visible) pip.updatePiPState({ localCamOn: enabled });
          setCamOn(enabled);
        },
      });
    }

    const handleRemoteViewKeyChange = (key: number) => {
      setRemoteViewKey(key);
    };
    
    const handleCallEnded = () => {
      logger.info('[VideoCall] [end] handleCallEnded вызван', {
        callEndedTransitionDoneRef: callEndedTransitionDoneRef.current,
        isEndingCallRef: isEndingCallRef.current,
      });
      if (callEndedTransitionDoneRef.current) {
        logger.info('[VideoCall] [end] переход уже применён - игнорируем');
        return;
      }
      // Уже на Home (onAbortCall или предыдущий handleCallEnded уже перешли) — не повторяем doReset/bringMainActivityToFront.
      const rootNav = (global as any).__navRef;
      if (rootNav?.isReady?.()) {
        const route = rootNav.getCurrentRoute();
        if (route?.name === 'Home') {
          logger.info('[VideoCall] [end] уже на Home - игнорируем');
          callEndedTransitionDoneRef.current = true;
          return;
        }
      }
      // Двойная обработка: локальный endCall уже эмитит callEnded; затем приходит call:ended по сокету и сессия снова эмитит.
      if (isEndingCallRef.current) {
        logger.info('[VideoCall] [end] handleCallEnded повторно (локально + socket) - пропускаем');
        return;
      }
      isEndingCallRef.current = true;
      isInactiveStateRef.current = true;
      logger.info('[VideoCall] [end] refs установлены, закрываем экран');
      logMicTraceRef.current('handleCallEnded — завершение звонка (далее deferred cleanup → session.cleanup / stopLocalTracks)', {
        uiMicOn: micOnRef.current,
        callId: callId ?? currentCallIdRef.current,
      });

      // Нативно блокируем вход в системный PiP при завершении (иначе пользователь улетает на главный экран с PiP).
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(true); } catch (_) {}
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }

      // Закрываем экран видеозвонка: goBack — пользователь остаётся на том же экране, что и до звонка (без мерцания). Если в стеке только VideoCall — reset на Home.
      const endSource = (global as any).__lastEndCallSourceRef?.current;
      const inSystemPiP = pipRef.current.inSystemPiPMode === true;
      const noOpenFlag = (global as any).__callEndedFromPiPNoOpenRef?.current === true;
      const endedFromPiP = endSource === 'pip_close' || noOpenFlag;
      const closeVideoCallScreen = () => {
        try {
          const rootNav = (global as any).__navRef;
          if (!rootNav?.isReady?.()) return;
          const route = rootNav.getCurrentRoute();
          if (route?.name === 'Home') return;
          if (route?.name !== 'VideoCall') return;
          const state = rootNav.getState();
          const routes = state?.routes ?? [];
          logger.info('[VideoCall] [end] closeVideoCallScreen: dispatch goBack/reset', { routesLength: routes.length });
          if (routes.length > 1) {
            rootNav.dispatch(CommonActions.goBack());
            try { emitCallEndedOnHome(); } catch (_) {}
          } else {
            rootNav.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callEnded: true } }] }));
          }
        } catch (e) {
          logger.warn('[VideoCall] closeVideoCallScreen at handleCallEnded failed', e);
        }
      };
      if (!inSystemPiP && !endedFromPiP) {
        try { (global as any).__homeResetByVideoCallRef.current = true; } catch (_) {}
        closeVideoCallScreen();
      }
      if (!inSystemPiP && !endedFromPiP && Platform.OS === 'android') {
        try { bringMainActivityToFront(); } catch (_) {}
      }

      // Только очистка в фоне — без setState, чтобы не было ререндеров и мерцания (экран уже закрывается).
      const idToReport = callId ?? currentCallIdRef.current ?? null;
      setTimeout(() => {
        logger.info('[VideoCall] [end] handleCallEnded deferred cleanup tick');
        if (callEndedTransitionDoneRef.current) return;
        callEndedTransitionDoneRef.current = true;

        const doReportEndCall = () => {
          reportEndCallToCallKeep(idToReport);
          if (Platform.OS === 'android') {
            setTimeout(() => {
              try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(false); } catch (_) {}
            }, 600);
          }
        };
        if (Platform.OS === 'android') {
          setTimeout(doReportEndCall, 120);
        } else {
          doReportEndCall();
        }

        const sessionSnapshot = sessionRef.current;
        if (typeof sessionSnapshot?.cleanup === 'function') {
          sessionSnapshot.cleanup();
        }
        clearSessionRefs();
        try {
          (global as any).__videoCallPartnerUserIdRef = { current: null };
          (global as any).__videoCallActiveRef = { current: false };
          (global as any).__onVideoCallEndedRef?.current?.();
        } catch (_) {}
        const localStreamSnapshot = localStreamRef.current;
        stopStreamTracks(localStreamSnapshot, 'callEnded/localStreamState');
        const sessionLocalStream = sessionSnapshot?.getLocalStream?.();
        if (sessionLocalStream && sessionLocalStream !== localStreamSnapshot) {
          stopStreamTracks(sessionLocalStream, 'callEnded/sessionLocalStream');
        }
        if (pipRef.current.visible || isPipOverlayVisibleSync()) {
          pipRef.current.hidePiP();
          sessionRef.current?.exitPiP?.();
        }
        const inSystemNow = (global as any).__pipInSystemModeRef?.current === true;
        if (inSystemNow && Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.requestExitSystemPiP?.(); } catch (_) {}
        }
        remoteStreamRef.current = null;
        remoteStreamReceivedAtRef.current = null;
        clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
        setTimeout(() => {
          isEndingCallRef.current = false;
          setIsEndingCall(false);
        }, 1000);
      }, 0);
    };
    
    const handleCallAnswered = () => {
      if (isEndingCallRef.current || isInactiveStateRef.current) {
        logger.info('[VideoCall] handleCallAnswered ignored (call ending or inactive)');
        return;
      }
      const srEarly = sessionRef.current;
      if (srEarly && typeof (srEarly as any).isEnded === 'function' && (srEarly as any).isEnded()) {
        logger.info('[VideoCall] handleCallAnswered ignored (session already ended)');
        return;
      }
      callEndedTransitionDoneRef.current = false;
      acceptCallTimeRef.current = Date.now();
      setFriendCallAccepted(true);
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      setStarted(true);
      setLoading(true);
      incomingCallHook.setIncomingOverlay(false);
      const camFromSession = sessionRef.current?.getIsCamOn?.() ?? true;
      setCamOn(camFromSession);
      const micFromSession = sessionRef.current?.getIsMicOn?.() ?? true;
      logMicTraceRef.current('handleCallAnswered (socket) → setMicOn/setCamOn from session', {
        roomId,
        callId,
        partnerId,
        micFromSession,
        camFromSession,
      });
      setMicOn(micFromSession);
      
      const currentLocalStream = sessionRef.current?.getLocalStream?.() || localStreamRef.current;
      if (currentLocalStream) {
        const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          videoTrack.enabled = camFromSession;
          try {
            sessionRef.current?.sendCameraState?.(undefined, camFromSession);
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
      
      // КРИТИЧНО: Сбрасываем глобальные refs, чтобы кнопки видеозвонка у инициатора снова стали активными
      try {
        (global as any).__videoCallPartnerUserIdRef = { current: null };
        (global as any).__videoCallActiveRef = { current: false };
        (global as any).__onVideoCallEndedRef?.current?.();
      } catch (_) {}
      
      // КРИТИЧНО: Очищаем состояние звонка при отклонении
      incomingCallHook.setIncomingFriendCall(null);
      incomingCallHook.setIncomingCall(null);
      incomingCallHook.setIncomingOverlay(false);
      
      // КРИТИЧНО: Очищаем состояние сессии для инициатора и уходим с экрана
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
        
        const localStreamSnapshot = localStreamRef.current;
        if (localStreamSnapshot) {
          stopStreamTracks(localStreamSnapshot, 'callDeclined/localStream');
        }
        setLocalStream(null);
        setCamOn(false);
        logMicTraceRef.current('handleCallDeclined directInitiator → setMicOn(false)', { callId });
        setMicOn(false);
        if (navigation?.canGoBack?.()) {
          navigation.goBack();
        } else {
          (navigation as any).navigate?.('Home');
        }
      }
    };
    
    const handleRemoteState = ({ muted }: { muted?: boolean }) => {
      if (isInactiveStateRef.current || isEndingCallRef.current) return;
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
      
      // КРИТИЧНО: Если звонок уже завершён — не обновляем state (никаких setState), чтобы не было ререндеров при закрытии экрана.
      if (isInactiveStateRef.current || isEndingCallRef.current) {
        partnerInPiPRef.current = inPiP;
        return;
      }
      
      // КРИТИЧНО: Всегда обновляем состояние partnerInPiP при получении события
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
      // Только если звонок ещё активен (проверка выше).
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
      }
    };

    // КРИТИЧНО: Если сессия была создана НЕ этим инстансом экрана (например, восстановлена из PiP),
    // то её config.callbacks указывает на старый размонтированный компонент.
    // В этом случае подписываемся на события stream и обновляем state текущего экрана.
    const needsStreamBridge = !createdSessionsRef.current.has(session as any);

    const handleLocalStreamEvent = (stream: MediaStream | null) => {
      if (isInactiveStateRef.current || isEndingCallRef.current) return;
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
      if (isInactiveStateRef.current || isEndingCallRef.current) return;
      remoteStreamRef.current = stream as any;
      setRemoteStream(stream as any);
      if (stream) {
        remoteStreamReceivedAtRef.current = Date.now();
        setIsInactiveState(false);
        setWasFriendCallEnded(false);
        setStarted(true);
        setLoading(false);
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
  }, [sessionTick, clearSessionRefs]);
  
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
    // Защита от двойного вызова (два источника события / двойной тап) — иначе два goBack и мерцание
    if (isEndingCallRef.current) {
      logger.info('[VideoCall] [end] onAbortCall повторно — пропускаем');
      return;
    }
    isEndingCallRef.current = true;
    setIsEndingCall(true);

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
    const g = global as any;
    const wasInPiP = g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true;

    logger.info('[VideoCall] [end] onAbortCall начат', { roomId, callId, partnerId });

    // КРИТИЧНО: Сразу выставляем refs завершения (до навигации и session.endCall), чтобы колбэки сессии
    // (onRemoteCamStateChange, onPartnerIdChange, onRoomIdChange, onCallIdChange, handlePartnerPiPStateChanged) не вызывали setState и не давали ререндеров.
    isEndingCallRef.current = true;
    isInactiveStateRef.current = true;

    setMicOn(false);
    setCamOn(false);
    try {
      if (pipRef.current.visible) {
        pipRef.current.updatePiPState({ isMuted: true, localCamOn: false });
      }
    } catch (_) {}

    // Очищаем сохранённый call:accepted, чтобы следующий звонок не подхватил старый payload.
    try {
      if ((global as any).__pendingCallAcceptedRef) (global as any).__pendingCallAcceptedRef.current = null;
    } catch (_) {}

    // КРИТИЧНО: Сразу выставляем глобальный флаг (синхронно), чтобы AboutToEnterSystemPiP / onUserLeaveHint
    // не переводили в PiP при переходе на Home — без нажатия пользователем кнопки PiP/Home.
    try {
      g.__endingCallInProgressRef = g.__endingCallInProgressRef || { current: false };
      g.__endingCallInProgressRef.current = true;
    } catch (_) {}

    if (Platform.OS === 'android') {
      try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(true); } catch (_) {}
      try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
    }

    // Закрываем экран видеозвонка сразу: goBack — возврат на тот экран/вкладку/модалку, что был до звонка (принявший — откуда принял, инициатор — откуда инициировал).
    if (!wasInPiP) {
      try {
        const rootNav = (global as any).__navRef;
        if (rootNav?.isReady?.()) {
          const state = rootNav.getState();
          const routes = state?.routes ?? [];
          const currentRoute = rootNav.getCurrentRoute();
          if (currentRoute?.name === 'VideoCall') {
            logger.info('[VideoCall] [end] onAbortCall: goBack (вернём на экран под VideoCall)', { routesLength: routes.length });
            if (routes.length > 1) {
              rootNav.dispatch(CommonActions.goBack());
              try { emitCallEndedOnHome(); } catch (_) {}
            } else {
              rootNav.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callEnded: true } }] }));
              try { emitCallEndedOnHome(); } catch (_) {}
            }
          }
        } else {
          (navigation as any)?.dispatch?.(CommonActions.goBack());
          try { emitCallEndedOnHome(); } catch (_) {}
        }
        if (Platform.OS === 'android') {
          try { bringMainActivityToFront(); } catch (_) {}
        }
      } catch (e) {
        logger.warn('[VideoCall] close screen at onAbortCall failed', e);
      }
    }

    // Вся очистка — в фоне в следующем тике, экран уже закрыт. Без setState, чтобы не было мерцания.
    logger.info('[VideoCall] [end] onAbortCall: scheduling deferred cleanup');
    const idToReport = callId ?? currentCallIdRef.current ?? (session as any)?.callId ?? null;
    const idToSend = callId ?? currentCallIdRef.current ?? (session as any)?.getCallId?.() ?? null;
    const roomToSend = roomId ?? (session as any)?.getRoomId?.() ?? null;
    const sessionRefForCleanup = session;
    const localStreamForCleanup = localStream;

    setTimeout(() => {
      logger.info('[VideoCall] [end] onAbortCall deferred cleanup tick');
      try {
        reportEndCallToCallKeep(idToReport);

        if (pipRef.current.visible || isPipOverlayVisibleSync()) {
          pipRef.current.hidePiP();
          sessionRefForCleanup.exitPiP?.();
        }

        let stoppedStream: MediaStream | null = null;
        try {
          const sessionLocalStream = sessionRefForCleanup.getLocalStream?.();
          stopStreamTracks(sessionLocalStream, 'onAbortCall/sessionLocalStream');
          stoppedStream = sessionLocalStream || null;
        } catch (e) {
          logger.warn('[VideoCall] Error stopping session local stream:', e);
        }
        if (localStreamForCleanup && localStreamForCleanup !== stoppedStream) {
          stopStreamTracks(localStreamForCleanup, 'onAbortCall/localStreamState');
        }

        sessionRefForCleanup.endCall(idToSend ?? undefined, roomToSend ?? undefined);

        remoteStreamRef.current = null;
        remoteStreamReceivedAtRef.current = null;
        currentCallIdRef.current = null;

        if (typeof sessionRefForCleanup.cleanup === 'function') {
          sessionRefForCleanup.cleanup();
        }
        clearSessionRefs();
        try {
          (global as any).__videoCallPartnerUserIdRef = { current: null };
          (global as any).__videoCallActiveRef = { current: false };
          (global as any).__onVideoCallEndedRef?.current?.();
        } catch (_) {}
        clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
      } catch (e) {
        logger.warn('[VideoCall] onAbortCall deferred cleanup failed', e);
      }

      setTimeout(() => {
        isEndingCallRef.current = false;
        setIsEndingCall(false);
        try {
          const gr = (global as any).__endingCallInProgressRef;
          if (gr && typeof gr.current !== 'undefined') gr.current = false;
        } catch (_) {}
        if (Platform.OS === 'android') {
          try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(false); } catch (_) {}
        }
        logger.debug('[VideoCall] isEndingCallRef reset in onAbortCall');
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
    }, 0);
  }, [isInactiveState, roomId, callId, localStream]);
  
  // КРИТИЧНО: Обновляем глобальные ссылки при изменении сессии или функции очистки
  // Это гарантирует, что ссылки всегда актуальны
  // Основные ссылки устанавливаются при создании сессии выше, здесь только обновляем
  // Важно: без cleanup в return — иначе при смене onAbortCall (после установки roomId/callId/localStream)
  // эффект перезапускается и cleanup завершал бы звонок. Завершение при размонтировании — в отдельном эффекте ниже.
  useEffect(() => {
    // Во время завершения звонка не обновляем глобальные ссылки — уменьшаем мерцание
    // (иначе эффект срабатывает 4+ раз из-за ререндеров и даёт лишнюю работу)
    if (isEndingCallRef.current) return;

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
  }, [onAbortCall]);

  // Если открыли приложение и попали на неактивный видеозвонок (например после закрытия PiP при завершении) — закрываем экран: goBack или reset на Home. Не редиректить, если звонок только что завершили из PiP.
  useFocusEffect(
    useCallback(() => {
      if (!isInactiveState || !wasFriendCallEnded) return;
      if (pipRef.current?.visible === true || isPipOverlayVisibleSync() || pipRef.current?.inSystemPiPMode === true) return;
      if ((global as any).__callEndedFromPiPNoOpenRef?.current === true) return;
      const rootNav = (global as any).__navRef;
      if (!rootNav?.isReady?.()) return;
      const route = rootNav.getCurrentRoute();
      if (route?.name !== 'VideoCall') return;
      const state = rootNav.getState();
      const routes = state?.routes ?? [];
      if (routes.length > 1) {
        rootNav.dispatch(CommonActions.goBack());
        try { emitCallEndedOnHome(); } catch (_) {}
      } else {
        rootNav.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callEnded: true } }] }));
      }
    }, [isInactiveState, wasFriendCallEnded])
  );

  // Пока экран VideoCall в фокусе — подавляем in-app PiP оверлей (чтобы он не мелькал поверх полноэкранного звонка).
  // ВАЖНО: используем focus/blur, а не mount/unmount — иначе на некоторых устройствах экран может остаться смонтированным
  // в стеке при переходе на Home, и тогда PiP оверлей никогда не появится.
  useFocusEffect(
    useCallback(() => {
      pipRef.current?.updatePiPState({ suppressOverlayForReturn: true });
      return () => {
        pipRef.current?.updatePiPState({ suppressOverlayForReturn: false });
      };
    }, [])
  );

  // КРИТИЧНО: Завершение звонка только при реальном размонтировании экрана (не при смене onAbortCall).
  // Эффект с [] — cleanup выполняется один раз при unmount.
  useEffect(() => {
    return () => {
      const pipVisible =
        (global as any).__pipVisibleRef?.current === true ||
        (global as any).__pipInSystemModeRef?.current === true;
      const returningFromSystemPiPUntil = (global as any).__returningFromSystemPiPUntilRef?.current;
      const returningFromSystemPiP =
        typeof returningFromSystemPiPUntil === 'number' &&
        Date.now() < returningFromSystemPiPUntil;
      // Если звонок уже корректно завершили через handleCallEnded/onAbortCall — не дёргаем cleanup повторно.
      // Иначе для "второго участника" (который не нажимал end) получается двойное завершение.
      const alreadyEndedOrEnding =
        isInactiveStateRef.current ||
        isEndingCallRef.current ||
        callEndedTransitionDoneRef.current;
      if (returningFromSystemPiP) {
        logger.info('[VideoCall] cleanup при размонтировании пропущен (возврат из system PiP)', {
          returningFromSystemPiPUntil,
        });
      } else if (!pipVisible && !alreadyEndedOrEnding) {
        const cleanupFn = (global as any).__endCallCleanupRef?.current;
        if (typeof cleanupFn === 'function') {
          try {
            cleanupFn();
            logger.info('[VideoCall] Вызвана cleanup при размонтировании (не в PiP)');
          } catch (e) {
            logger.warn('[VideoCall] Ошибка при cleanup при размонтировании', e);
          }
        }
      } else if (!pipVisible && alreadyEndedOrEnding) {
        logger.info('[VideoCall] cleanup при размонтировании пропущен (уже завершено/завершается)', {
          isInactiveStateRef: isInactiveStateRef.current,
          isEndingCallRef: isEndingCallRef.current,
          callEndedTransitionDoneRef: callEndedTransitionDoneRef.current,
        });
      }
      if (!sessionRef.current) {
        (global as any).__webrtcSessionRef.current = null;
        (global as any).__endCallCleanupRef.current = null;
        logger.info('[VideoCall] Глобальные ссылки очищены (сессия удалена)');
      }
    };
  }, []);
  
  const toggleMic = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    logMicTraceRef.current('toggleMic control invoked (экран или PiP)', {
      hasSession: !!session,
      friendCallAccepted,
      roomId,
      callId,
      partnerId,
      loading,
      hasRemoteStream: !!remoteStreamRef.current,
      uiMicOnBefore: micOnRef.current,
    });
    if (session && typeof session.toggleMic === 'function') {
      session.toggleMic();
      // КРИТИЧНО: Состояние PiP обновится через onMicStateChange callback
      // Это гарантирует синхронизацию состояния
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleMic');
    }
  }, [clearSessionRefs, friendCallAccepted, roomId, callId, partnerId, loading]);
  
  const toggleCam = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.toggleCam === 'function') {
      setCamOn((prev) => {
        const next = !prev;
        if (next) setLocalRenderKey((k: number) => k + 1);
        if (pip.visible) pip.updatePiPState({ localCamOn: next });
        return next;
      });
      session.toggleCam().catch((e: any) => {
        logger.warn('[VideoCall] toggleCam error:', e);
      });
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleCam');
    }
  }, [pip]);
  
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
  // Это нужно чтобы можно было управлять микрофоном, динамиком и камерой из PiP
  useEffect(() => {
    (global as any).__toggleMicRef = (global as any).__toggleMicRef || { current: null };
    (global as any).__toggleRemoteAudioRef = (global as any).__toggleRemoteAudioRef || { current: null };
    (global as any).__toggleCamRef = (global as any).__toggleCamRef || { current: null };
    (global as any).__toggleMicRef.current = toggleMic;
    (global as any).__toggleRemoteAudioRef.current = toggleRemoteAudio;
    (global as any).__toggleCamRef.current = toggleCam;

    return () => {
      (global as any).__toggleMicRef.current = null;
      (global as any).__toggleRemoteAudioRef.current = null;
      (global as any).__toggleCamRef.current = null;
    };
  }, [toggleMic, toggleRemoteAudio, toggleCam]);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId || !!callId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const shouldShowRemoteVideo = remoteCamOn && !isInactiveState;
  // const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0; // эквалайзер отключен
  const showControls = hasActiveCall && !isInactiveState;
  
  // Проверка, является ли партнер другом (по списку friends или по типу звонка)
  const isDirectCall = !!route?.params?.directCall;
  const isPartnerFriend = useMemo(() => {
    if (!partnerUserId) return false;
    if (isDirectCall) return true; // Прямой звонок = партнёр всегда друг (вызов из списка друзей / входящий от друга)
    return friends.some(f => String(f._id) === String(partnerUserId));
  }, [partnerUserId, friends, isDirectCall]);
  
  // Показывать ли бейдж "Друг"
  // КРИТИЧНО: Показываем бейдж если партнер - друг и звонок активен. Убираем только по факту завершения звонка (wasFriendCallEnded),
  // не при isInactiveState/PiP/рассинхроне — иначе при возврате из PiP (started: false) бейдж пропадал.
  const showFriendBadge = useMemo(() => {
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const callEnded = !!wasFriendCallEnded;
    const hasActiveCall = !!partnerId || !!roomId || !!callId;
    // При завершении звонка не показываем бейдж и не логируем, чтобы не было мерцания и лишних ререндеров
    if (isEndingCallRef.current || isEndingCall) return false;

    // Показываем бейдж если: есть partnerUserId, звонок идёт (started или hasActiveCall), звонок не завершён, партнёр друг.
    // Не используем isInactiveState — при PiP/возврате он может быть true, бейдж должен оставаться до конца звонка.
    const shouldShow = hasPartnerUserId && (hasStarted || hasActiveCall) && !callEnded && isPartnerFriend;

    if (shouldShow) {
      logger.info('[VideoCall] Показываем бейдж друга', {
        partnerUserId,
        started,
        callEnded,
        hasActiveCall,
        isPartnerFriend,
        partnerId,
        roomId,
        callId
      });
    }

    return shouldShow;
  }, [partnerUserId, friends, started, wasFriendCallEnded, partnerId, roomId, callId, isPartnerFriend, isEndingCall]);
  
  // КРИТИЧНО: На iOS отключаем usePreventRemove - он мешает нормальному свайпу
  // PanResponder полностью обрабатывает свайп: показывает PiP и делает навигацию
  // На Android hardware Back обрабатывается в usePiP и возвращает на предыдущий экран
  // приложения с in-app PiP, поэтому system PiP fallback через usePreventRemove не нужен.
  const shouldPreventRemove = (() => {
    // На iOS не блокируем навигацию - PanResponder обработает жест
    if (Platform.OS === 'ios') return false;
    return false;
  })();

  // Legacy fallback для системного PiP по remove-навигации. На Android сейчас отключён:
  // hardware Back обрабатывается в usePiP и возвращает на предыдущий экран с in-app PiP.
  const backPiPInProgressRef = useRef(false);
  usePreventRemove(
    shouldPreventRemove,
    (e) => {
      if (Platform.OS !== 'android') return;
      const g = (global as any);
      // Завершение звонка по кнопке «Завершить»: не переходить в PiP (ни по Back, ни при программном reset на Home).
      if (g.__endingCallInProgressRef?.current === true) return;
      // Сразу после возврата из системного PiP (SystemPiPExpanded) не уходим снова в PiP по Back —
      // иначе на части устройств во время перехода срабатывает Back/beforeRemove и приложение уходит в фон.
      const disableUntil = g.__disableSystemPiPUntilRef?.current;
      if (typeof disableUntil === 'number' && Date.now() < disableUntil) return;

      const gGuard = g.__backPiPInProgressRef;
      if (gGuard?.current || backPiPInProgressRef.current) return;
      backPiPInProgressRef.current = true;
      if (!gGuard) g.__backPiPInProgressRef = { current: true };
      else gGuard.current = true;
      const t = setTimeout(() => {
        backPiPInProgressRef.current = false;
        if ((global as any).__backPiPInProgressRef) (global as any).__backPiPInProgressRef.current = false;
      }, 2500);

      const params = g.__currentCallPiPParamsRef?.current;
      const showPiP = g.__pipShowPiPRef?.current;
      const upd = g.__pipUpdateStateRef?.current;
      const session = sessionRef.current || g.__webrtcSessionRef?.current;
      const callId = params?.callId ?? (typeof session?.getCallId === 'function' ? session.getCallId() : null);
      const roomId = params?.roomId ?? (typeof session?.getRoomId === 'function' ? session.getRoomId() : null);

      try {
        if (callId && roomId && NativeModules.LiviAppModule?.setPiPEndCallParams) {
          NativeModules.LiviAppModule.setPiPEndCallParams(callId, roomId);
        }
        if (session && typeof session.enterPiP === 'function') session.enterPiP();
        if (NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint) {
          NativeModules.LiviAppModule.setShouldEnterPiPOnLeaveHint(true);
        }
        // Показываем PiP с remote, затем оверлей 9:16 с видео собеседника — в кадр системного PiP попадёт он
        if (typeof showPiP === 'function' && callId && roomId) {
          showPiP({
            callId,
            roomId,
            partnerName: params?.partnerName,
            partnerAvatarUrl: params?.partnerAvatarUrl,
            localStream: params?.localStream ?? (typeof session?.getLocalStream === 'function' ? session.getLocalStream() : null),
            remoteStream: params?.remoteStream ?? (typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null),
            localCamOn: params?.localCamOn,
            remoteCamOn: params?.remoteCamOn,
            navParams: params?.navParams,
            deferVisible: false,
          });
        }
        const doEnterPiP = () => {
          try {
            if (NativeModules.LiviAppModule?.moveTaskToBackAndEnterPiP) {
              NativeModules.LiviAppModule.moveTaskToBackAndEnterPiP(true);
            } else if (NativeModules.LiviAppModule?.moveTaskToBack) {
              NativeModules.LiviAppModule.moveTaskToBack(true);
            }
          } finally {
            if (typeof upd === 'function') {
              setTimeout(() => upd({ pendingSystemPiP: false, decorSizeForPiP: null }), 2000);
            }
          }
        };
        if (typeof upd === 'function') {
          const apply = (size: { width: number; height: number } | null) => {
            upd({ pendingSystemPiP: true, allowVideoRender: true, ...(size ? { decorSizeForPiP: size } : {}) });
            setTimeout(doEnterPiP, 480);
          };
          NativeModules.LiviAppModule?.getDecorViewSize?.()?.then(apply)?.catch(() => apply(null));
          if (!NativeModules.LiviAppModule?.getDecorViewSize) apply(null);
        } else {
          setTimeout(doEnterPiP, 480);
        }
      } catch (_) {
        backPiPInProgressRef.current = false;
        clearTimeout(t);
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
        if (pipRef.current.visible || isPipOverlayVisibleSync()) {
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
            
            // Для удалённого видео НЕ делаем принудительную перерисовку через remoteViewKey —
            // это источник мерцаний (RTCView remount). Сессия сама эмитит remoteViewKeyChanged при необходимости.
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
                // Fallback: если сессия не отдает ключ, не форсим его здесь — лучше избежать RTCView remount bursts.
              }
              setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
            }
          });
        }
        
        // Восстанавливаем корректный аудио-роут при возврате из PiP (наушники/BT должны "побеждать").
        try { syncRouteNow?.(); } catch {}
        
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
            localCamOn: camOn,
            remoteCamOn,
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
  
  
  // Как в WhatsApp/Telegram: в системном PiP рисуем только видео собеседника; фон прозрачный, чтобы в окне PiP не было чёрных областей.
  // При возврате из PiP (fromPiP) показываем полноэкранный вид; при повторном входе в PiP (pendingSystemPiP) — компакт, иначе захватится layout с бейджем/кнопкой.
  const systemPiPCompact =
    Platform.OS === 'android' &&
    (pip.pendingSystemPiP || pip.inSystemPiPMode) &&
    (pip.pendingSystemPiP || !route?.params?.fromPiP);
  if (systemPiPCompact) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: 'transparent' }]} edges={[]}>
        <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', alignItems: 'center', backgroundColor: 'transparent' }]}>
          <View style={[styles.card, { flex: 1, width: '100%', minHeight: 0, backgroundColor: 'transparent' }]}>
            <RemoteVideo
              remoteStream={currentRemoteStream}
              remoteCamOn={remoteCamOn}
              remoteMuted={remoteMuted}
              isInactiveState={isInactiveState}
              wasFriendCallEnded={wasFriendCallEnded}
              started={started}
              loading={loading}
              remoteViewKey={remoteViewKey}
              showFriendBadge={false}
              lang={lang}
              session={sessionRef.current}
              remoteStreamReceivedAt={remoteStreamReceivedAtRef.current}
              partnerInPiP={partnerInPiP}
              forceTextureView={true}
              objectFit="contain"
            />
          </View>
        </View>
      </SafeAreaView>
    );
  }

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
            onFlipCamera={() => {
              const session = sessionRef.current ?? (global as any).__webrtcSessionRef?.current;
              if (!session?.flipCam) return;
              Promise.resolve(session.flipCam()).catch((e: any) => {
                logger.warn('[VideoCall] flipCam error:', e);
              });
            }}
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
            onPress={
              isInactiveState
                ? undefined
                : () => {
                    try {
                      const g = (global as any);
                      g.__lastEndCallSourceRef = g.__lastEndCallSourceRef || { current: null };
                      g.__lastEndCallSourceRef.current = 'end_button';
                    } catch (_) {}
                    onAbortCall();
                  }
            }
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
    position: 'relative',
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
    // Как в RandomChat: отступы от краёв экрана до кнопки — iOS 3% слева/справа + 16px, Android 2px
    width: Platform.OS === 'android' ? '100%' : '94%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 14 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
    paddingHorizontal: Platform.OS === "android" ? 2 : 16,
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
