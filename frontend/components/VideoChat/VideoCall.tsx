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
  NativeModules,
  AppState,
} from 'react-native';
import { CommonActions, useNavigation, useFocusEffect, usePreventRemove, useIsFocused } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaStream } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { VideoCallSession } from '../../src/webrtc/sessions/VideoCallSession';
import type { CamSide, WebRTCSessionConfig } from '../../src/webrtc/types';
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
import { reportEndCallToCallKeep, bringMainActivityToFront, requestExitSystemPiPSoft } from '../../utils/callKeep';
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
      systemPiPReturnToken?: number;
      isIncoming?: boolean;
      partnerNick?: string;
      /** call:ended в системном PiP у собеседника — тот же «неактивный» экран, что у завершившего из PiP. */
      endedFromRemoteSystemPiP?: boolean;
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

/** Снимает блокировку кнопок видеозвонка на Home (__videoCallActiveRef / partner) и дергает сброс busy у друзей. */
function clearVideoCallHomeScreenLocks(reason: string) {
  try {
    const g = global as any;
    if (!g.__videoCallPartnerUserIdRef) g.__videoCallPartnerUserIdRef = { current: null };
    else g.__videoCallPartnerUserIdRef.current = null;
    if (!g.__videoCallActiveRef) g.__videoCallActiveRef = { current: false };
    else g.__videoCallActiveRef.current = false;
    g.__onVideoCallEndedRef?.current?.();
  } catch (e) {
    logger.warn('[VideoCall] clearVideoCallHomeScreenLocks failed', { reason, e });
  }
}

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
  const isMountedRef = useRef(true);
  
  // КРИТИЧНО: Синхронизируем ref с state для использования в callbacks
  // Это fallback на случай, если ref не был обновлен синхронно
  useEffect(() => {
    remoteStreamRef.current = remoteStream;
  }, [remoteStream]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  /** Зеркало `micOn` после рендера; в колбэках сессии лог может быть до следующего рендера — см. micMatchesUiYet. */
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;
  const logMicTraceRef = useRef<(where: string, details?: Record<string, unknown>) => void>(() => {});
  logMicTraceRef.current = () => {};

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
  const [localCamSide, setLocalCamSide] = useState<CamSide>('front');
  const [remoteCamSide, setRemoteCamSide] = useState<CamSide>('front');
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
  const screenInstanceIdRef = useRef(`video-call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  
  // Используем хуки
  const pip = usePiP();
  const pipRef = useRef(pip);
  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);
  const getTrackEnabled = useCallback((stream: MediaStream | null | undefined, kind: 'audio' | 'video') => {
    try {
      const track =
        kind === 'audio'
          ? (stream as any)?.getAudioTracks?.()?.[0]
          : (stream as any)?.getVideoTracks?.()?.[0];
      return typeof track?.enabled === 'boolean' ? track.enabled : undefined;
    } catch {
      return undefined;
    }
  }, []);
  const getDesiredLocalMediaStateForPiPReturn = useCallback((stream?: MediaStream | null) => {
    const effectiveStream =
      stream ||
      sessionRef.current?.getLocalStream?.() ||
      pip.localStream ||
      localStreamRef.current ||
      null;
    const trackMicOn = getTrackEnabled(effectiveStream, 'audio');
    const trackCamOn = getTrackEnabled(effectiveStream, 'video');
    return {
      micOn: typeof trackMicOn === 'boolean' ? trackMicOn : !pip.isMuted,
      camOn:
        typeof trackCamOn === 'boolean'
          ? trackCamOn
          : (typeof pip.localCamOn === 'boolean' ? pip.localCamOn : camOn),
    };
  }, [camOn, getTrackEnabled, pip.isMuted, pip.localCamOn, pip.localStream]);
  const getDesiredRemoteMutedForPiPReturn = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    const fromSession =
      session && typeof session.getRemoteAudioMuted === 'function'
        ? session.getRemoteAudioMuted()
        : undefined;
    return typeof fromSession === 'boolean' ? fromSession : !!pip.isRemoteMuted;
  }, [pip.isRemoteMuted]);

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
  const sessionForHandlerEffect = sessionRef.current;
  const currentSystemPiPReturnToken = Number(
    route?.params?.systemPiPReturnToken || (global as any).__systemPiPReturnTokenRef?.current || 0
  );
  const currentSystemPiPReturnState =
    currentSystemPiPReturnToken &&
    Number((global as any).__systemPiPReturnStateRef?.current?.token || 0) === currentSystemPiPReturnToken
      ? (global as any).__systemPiPReturnStateRef?.current
      : null;
  const { syncRouteNow } = useAudioRouting(hasActiveCallForAudio && !isInactiveState, currentRemoteStream);
  
  // Refs
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const isInactiveStateRef = useRef(false);
  const isEndingCallRef = useRef(false); // КРИТИЧНО: Флаг для предотвращения повторных вызовов handleCallEnded
  const [isEndingCall, setIsEndingCall] = useState(false); // Синхронно с ref: скрываем бейдж/активный звонок при завершении, чтобы не мигало
  const callEndedTransitionDoneRef = useRef(false); // Один переход в UI «завершён» — защита от многократных setState при disconnect + call:ended
  const remoteEndedShellAppliedRef = useRef(false);
  const deferredTeardownScheduledRef = useRef<{ key: string; source: string } | null>(null);
  const skipAbortAfterPiPReturnUntilRef = useRef(0);
  const lastHandledSystemPiPReturnTokenRef = useRef(0);
  const lastSessionReuseReturnTokenRef = useRef(0);
  const lastAttachedSessionKeyRef = useRef('');
  const extendPiPReturnAbortGuard = useCallback((_reason: string, durationMs = 12000) => {
    const until = Date.now() + durationMs;
    skipAbortAfterPiPReturnUntilRef.current = Math.max(skipAbortAfterPiPReturnUntilRef.current, until);
    try {
      const g = global as any;
      g.__returningFromSystemPiPUntilRef = g.__returningFromSystemPiPUntilRef || { current: 0 };
      g.__returningFromSystemPiPUntilRef.current = Math.max(Number(g.__returningFromSystemPiPUntilRef.current || 0), until);
      g.__suppressAbortDuringSystemPiPReturnUntilRef =
        g.__suppressAbortDuringSystemPiPReturnUntilRef || { current: 0 };
      g.__suppressAbortDuringSystemPiPReturnUntilRef.current = Math.max(
        Number(g.__suppressAbortDuringSystemPiPReturnUntilRef.current || 0),
        until
      );
    } catch (_) {}
  }, []);
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

  // Навигация из App после call:ended в system PiP (собеседник): сессия уже завершена — тот же неактивный UI, что у завершившего из PiP.
  useEffect(() => {
    if (!route?.params?.endedFromRemoteSystemPiP) {
      remoteEndedShellAppliedRef.current = false;
      return;
    }
    if (remoteEndedShellAppliedRef.current) return;
    remoteEndedShellAppliedRef.current = true;
    setFriendCallAccepted(true);
    setStarted(true);
    setLoading(false);
    setWasFriendCallEnded(true);
    setIsInactiveState(true);
    isInactiveStateRef.current = true;
    callEndedTransitionDoneRef.current = true;
    try {
      NativeModules.LiviAppModule?.setEndingCallInProgress?.(false);
    } catch (_) {}
  }, [route?.params?.endedFromRemoteSystemPiP]);

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

  // __currentCallPiPParamsRef — callId/roomId/navParams для системного PiP и для returnToCall. Читается в PiPContext
  // при AboutToEnterSystemPiP и в App при SystemPiPExpanded fallback. Не обнуляем при !canEnableSystemPiP, только
  // при реальном завершении сессии (cleanup эффекта), иначе при возврате из PiP returnToCall получит null.
  useEffect(() => {
    const g = (global as any);
    g.__currentCallPiPParamsRef = g.__currentCallPiPParamsRef || { current: null };
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
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      return;
    }
    if (canEnableSystemPiP) {
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(true); } catch (_) {}
      }
    } else {
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
      localCamOn: getTrackEnabled(localStream, 'video') ?? camOn,
      muteLocal: !(getTrackEnabled(localStream, 'audio') ?? micOn),
      muteRemote: getDesiredRemoteMutedForPiPReturn(),
      remoteCamOn,
      navParams: { ...route?.params, peerUserId: partnerUserId, partnerId } as any,
    };
    return () => {
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
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
    };
  }, [roomId, callId, isInactiveState, partnerUserId, partnerId, localStream, remoteStream, camOn, micOn, remoteMuted, remoteCamOn, route?.params, isFocused, appState, getTrackEnabled, getDesiredRemoteMutedForPiPReturn]);

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
      const lastReturnToken = Number((lastRouteParamsRef.current as any)?.systemPiPReturnToken || 0);
      const currentReturnToken = Number((currentParams as any)?.systemPiPReturnToken || 0);
      lastRouteParamsRef.current = currentParams;
      // Сбрасываем флаг обработки возврата из PiP если параметры изменились
      if (currentReturnToken && currentReturnToken !== lastReturnToken) {
        fromPiPProcessedRef.current = false;
      } else if (!(currentParams?.resume && currentParams?.fromPiP)) {
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
    const now = Date.now();
    const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
    const disableUntil = Number(g.__disableSystemPiPUntilRef?.current || 0);
    const returnState = g.__systemPiPReturnStateRef?.current;
    const routeReturnToken = Number(route?.params?.systemPiPReturnToken || 0);
    const settledUntil =
      routeReturnToken && Number(returnState?.token || 0) === routeReturnToken
        ? Number(returnState?.settledUntil || 0)
        : 0;
    const restoredFromSystemPiP =
      !!route?.params?.fromPiP ||
      !!route?.params?.resume ||
      (!!routeReturnToken && Number(returnState?.restoredAt || 0) > 0);
    if (restoredFromSystemPiP || now < returningUntil || now < disableUntil || now < settledUntil) {
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      logger.info('[VideoCall] Dropping pending system PiP entry during return guard', {
        returningUntil,
        disableUntil,
        settledUntil,
        restoredFromSystemPiP,
      });
      return;
    }
    const pendingAgeMs =
      typeof pending?.requestedAt === 'number' ? now - pending.requestedAt : Number.POSITIVE_INFINITY;
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
    if (fromPiP || resume) {
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      return;
    }
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
    const fromPiP = !!route?.params?.fromPiP;
    const resume = !!route?.params?.resume;
    const now = Date.now();
    const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
    const disableUntil = Number(g.__disableSystemPiPUntilRef?.current || 0);
    const suppressAbortUntil = Number(g.__suppressAbortDuringSystemPiPReturnUntilRef?.current || 0);
    const returnState = g.__systemPiPReturnStateRef?.current;
    const routeReturnToken = Number(route?.params?.systemPiPReturnToken || 0);
    const settledUntil =
      routeReturnToken && Number(returnState?.token || 0) === routeReturnToken
        ? Number(returnState?.settledUntil || 0)
        : 0;
    const restoredFromSystemPiP =
      fromPiP ||
      resume ||
      (!!routeReturnToken && Number(returnState?.restoredAt || 0) > 0);
    if (restoredFromSystemPiP || now < returningUntil || now < disableUntil || now < suppressAbortUntil || now < settledUntil) {
      g.__enterSystemPiPAfterVideoCallRef.current = null;
      return;
    }
    const pendingAgeMs =
      typeof pending?.requestedAt === 'number' ? now - pending.requestedAt : Number.POSITIVE_INFINITY;
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
    g.__suppressInAppPiPUntilRef = g.__suppressInAppPiPUntilRef || { current: 0 };
    g.__suppressInAppPiPUntilRef.current = Date.now() + 5000;
    g.__systemPiPEntryInProgressUntilRef = g.__systemPiPEntryInProgressUntilRef || { current: 0 };
    g.__systemPiPEntryInProgressUntilRef.current = Date.now() + 5000;
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
          upd({
            pendingSystemPiP: true,
            systemPiPCaptureActive: true,
            systemPiPCaptureRequestId: Date.now(),
            allowVideoRender: true,
            ...(size ? { decorSizeForPiP: size } : {}),
          });
          return;
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
    const g = global as any;
    const cleanupOwner = g.__endCallCleanupOwnerRef?.current;
    if (g.__webrtcSessionRef && cleanupOwner === screenInstanceIdRef.current) {
      g.__webrtcSessionRef.current = null;
    }
    if (g.__endCallCleanupRef && cleanupOwner === screenInstanceIdRef.current) {
      g.__endCallCleanupRef.current = null;
    }
    if (g.__endCallCleanupOwnerRef && cleanupOwner === screenInstanceIdRef.current) {
      g.__endCallCleanupOwnerRef.current = null;
    }
    // НЕ очищаем __pendingCallAcceptedRef здесь: при ремаунте (двойная навигация) новая сессия должна прочитать payload и подключиться. Очищает только VideoCallSession после использования.
    currentCallIdRef.current = null;
  }, []);

  const getGlobalCleanupKey = useCallback((cid?: string | null, rid?: string | null) => {
    const c = String(cid ?? '').trim();
    const r = String(rid ?? '').trim();
    return c && r ? `${c}|${r}` : c || r || '';
  }, []);

  const wasGlobalCleanupDone = useCallback((cid?: string | null, rid?: string | null) => {
    const key = getGlobalCleanupKey(cid, rid);
    if (!key) return false;
    const marker = (global as any).__videoCallCleanupDoneRef?.current;
    return marker?.key === key;
  }, [getGlobalCleanupKey]);

  const markGlobalCleanupDone = useCallback((reason: string, cid?: string | null, rid?: string | null) => {
    const key = getGlobalCleanupKey(cid, rid);
    if (!key) return;
    const g = global as any;
    g.__videoCallCleanupDoneRef = g.__videoCallCleanupDoneRef || { current: null };
    g.__videoCallCleanupDoneRef.current = { key, at: Date.now(), reason };
  }, [getGlobalCleanupKey]);

  const wasGlobalTeardownScheduled = useCallback((cid?: string | null, rid?: string | null) => {
    const key = getGlobalCleanupKey(cid, rid);
    if (!key) return false;
    const marker = (global as any).__videoCallTeardownScheduledRef?.current;
    return marker?.key === key;
  }, [getGlobalCleanupKey]);

  const markGlobalTeardownScheduled = useCallback((reason: string, cid?: string | null, rid?: string | null) => {
    const key = getGlobalCleanupKey(cid, rid);
    if (!key) return;
    const g = global as any;
    g.__videoCallTeardownScheduledRef = g.__videoCallTeardownScheduledRef || { current: null };
    g.__videoCallTeardownScheduledRef.current = { key, at: Date.now(), reason };
  }, [getGlobalCleanupKey]);

  const isCleanupOwner = useCallback(() => {
    return (global as any).__endCallCleanupOwnerRef?.current === screenInstanceIdRef.current;
  }, []);

  const getSystemPiPReturnToken = useCallback(() => {
    const g = global as any;
    return Number(route?.params?.systemPiPReturnToken || g.__systemPiPReturnTokenRef?.current || 0);
  }, [route?.params?.systemPiPReturnToken]);

  const claimSystemPiPReturnOwner = useCallback((token = getSystemPiPReturnToken()) => {
    if (!token) return true;
    const g = global as any;
    g.__systemPiPReturnStateRef = g.__systemPiPReturnStateRef || { current: null };
    const cleanupOwner = g.__endCallCleanupOwnerRef?.current ?? null;
    const current = g.__systemPiPReturnStateRef.current;
    const now = Date.now();

    if (!current || Number(current.token || 0) !== token) {
      if (!isFocused) return false;
      g.__systemPiPReturnStateRef.current = {
        token,
        owner: screenInstanceIdRef.current,
        restoredAt: 0,
        settledUntil: 0,
      };
      return true;
    }

    if (current.owner && current.owner !== screenInstanceIdRef.current) {
      const settledUntil = Number(current.settledUntil || 0);
      if (current.restoredAt && now < settledUntil) {
        return false;
      }
      const ownerStale = !cleanupOwner || cleanupOwner !== current.owner;
      if (!isFocused || !ownerStale) {
        return false;
      }
      current.owner = screenInstanceIdRef.current;
    }

    if (!current.owner) {
      if (!isFocused) return false;
      current.owner = screenInstanceIdRef.current;
    }

    return current.owner === screenInstanceIdRef.current;
  }, [getSystemPiPReturnToken, isFocused]);

  const getSystemPiPReturnState = useCallback((token = getSystemPiPReturnToken()) => {
    if (!token) return null;
    const g = global as any;
    const current = g.__systemPiPReturnStateRef?.current;
    if (!current || Number(current.token || 0) !== token) {
      return null;
    }
    return current;
  }, [getSystemPiPReturnToken]);

  const markSystemPiPReturnRestored = useCallback((token = getSystemPiPReturnToken(), settleMs = 1800) => {
    if (!token) return;
    const g = global as any;
    g.__systemPiPReturnStateRef = g.__systemPiPReturnStateRef || { current: null };
    const now = Date.now();
    const until = now + settleMs;
    const current = g.__systemPiPReturnStateRef.current;
    if (!current || Number(current.token || 0) !== token) {
      g.__systemPiPReturnStateRef.current = {
        token,
        owner: screenInstanceIdRef.current,
        restoredAt: now,
        settledUntil: until,
      };
    } else {
      if (!current.owner) {
        current.owner = screenInstanceIdRef.current;
      }
      if (current.owner !== screenInstanceIdRef.current) {
        return;
      }
      current.restoredAt = now;
      current.settledUntil = Math.max(Number(current.settledUntil || 0), until);
    }
    g.__suppressAbortDuringSystemPiPReturnUntilRef =
      g.__suppressAbortDuringSystemPiPReturnUntilRef || { current: 0 };
    g.__suppressAbortDuringSystemPiPReturnUntilRef.current = Math.max(
      Number(g.__suppressAbortDuringSystemPiPReturnUntilRef.current || 0),
      until
    );
  }, [getSystemPiPReturnToken]);

  const scheduleDeferredTeardown = useCallback((params: {
    source: string;
    callId?: string | null;
    roomId?: string | null;
    sessionSnapshot?: any;
    localStreamSnapshot?: MediaStream | null;
    shouldReportEndCall?: boolean;
    shouldEndSession?: boolean;
  }) => {
    const {
      source,
      callId: rawCallId,
      roomId: rawRoomId,
      sessionSnapshot,
      localStreamSnapshot,
      shouldReportEndCall = true,
      shouldEndSession = false,
    } = params;
    const finalCallId = rawCallId ?? null;
    const finalRoomId = rawRoomId ?? null;
    const key = getGlobalCleanupKey(finalCallId, finalRoomId) || source;
    if (wasGlobalTeardownScheduled(finalCallId, finalRoomId)) {
      logger.info('[VideoCall] [end] deferred teardown already scheduled globally - skipping duplicate', {
        source,
        key,
      });
      return false;
    }
    const alreadyScheduled = deferredTeardownScheduledRef.current;
    if (alreadyScheduled) {
      logger.info('[VideoCall] [end] deferred teardown already scheduled - skipping duplicate', {
        source,
        scheduledBy: alreadyScheduled.source,
        key,
      });
      return false;
    }
    deferredTeardownScheduledRef.current = { key, source };
    markGlobalTeardownScheduled(source, finalCallId, finalRoomId);
    setTimeout(() => {
      logger.info('[VideoCall] [end] deferred teardown tick', {
        source,
        key,
      });
      if (callEndedTransitionDoneRef.current && wasGlobalCleanupDone(finalCallId, finalRoomId)) {
        logger.info('[VideoCall] [end] deferred teardown skipped - already finalized', {
          source,
          callId: finalCallId,
          roomId: finalRoomId,
        });
        return;
      }
      callEndedTransitionDoneRef.current = true;
      markGlobalCleanupDone(source, finalCallId, finalRoomId);

      if (shouldReportEndCall) {
        const doReportEndCall = () => {
          reportEndCallToCallKeep(finalCallId);
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
      }

      if (pipRef.current.visible || isPipOverlayVisibleSync()) {
        pipRef.current.hidePiP();
        const syncPiPState = (global as any).__pipSyncSessionStateRef?.current;
        if (typeof syncPiPState === 'function') {
          syncPiPState(false, `VideoCall.${source}`);
        }
      }
      const inSystemNow = (global as any).__pipInSystemModeRef?.current === true;
      if (inSystemNow && Platform.OS === 'android') {
        try { requestExitSystemPiPSoft(); } catch (_) {}
      }

      let stoppedStream: MediaStream | null = null;
      try {
        const sessionLocalStream = sessionSnapshot?.getLocalStream?.();
        stopStreamTracks(sessionLocalStream, `${source}/sessionLocalStream`);
        stoppedStream = sessionLocalStream || null;
      } catch (e) {
        logger.warn('[VideoCall] Error stopping session local stream during deferred teardown', {
          source,
          error: e,
        });
      }
      if (localStreamSnapshot && localStreamSnapshot !== stoppedStream) {
        stopStreamTracks(localStreamSnapshot, `${source}/localStreamState`);
      }

      const sessionAlreadyEnded =
        typeof sessionSnapshot?.isEnded === 'function' && sessionSnapshot.isEnded();
      if (shouldEndSession && !sessionAlreadyEnded && typeof sessionSnapshot?.endCall === 'function') {
        sessionSnapshot.endCall(finalCallId ?? undefined, finalRoomId ?? undefined);
      } else if (shouldEndSession && sessionAlreadyEnded) {
        logger.info('[VideoCall] deferred teardown: session already ended, skipping session.endCall', {
          source,
        });
      }

      if (typeof sessionSnapshot?.cleanup === 'function') {
        sessionSnapshot.cleanup();
      }
      clearSessionRefs();
      clearVideoCallHomeScreenLocks(`${source}-deferred`);
      remoteStreamRef.current = null;
      remoteStreamReceivedAtRef.current = null;
      currentCallIdRef.current = null;
      clearCallRelatedNotificationsAndSyncBadge().catch(() => {});

      setTimeout(() => {
        isEndingCallRef.current = false;
        setIsEndingCall(false);
        logger.debug('[VideoCall] isEndingCallRef reset after deferred teardown', { source });
      }, 1000);
    }, 0);
    return true;
  }, [clearSessionRefs, getGlobalCleanupKey, isPipOverlayVisibleSync, markGlobalCleanupDone, markGlobalTeardownScheduled, wasGlobalCleanupDone, wasGlobalTeardownScheduled]);

  const getSystemPiPReturnGuard = useCallback(() => {
    const g = global as any;
    const now = Date.now();
    const returningUntil = Number(g.__returningFromSystemPiPUntilRef?.current || 0);
    const disableUntil = Number(g.__disableSystemPiPUntilRef?.current || 0);
    const suppressAbortUntil = Number(g.__suppressAbortDuringSystemPiPReturnUntilRef?.current || 0);
    const currentReturnToken = getSystemPiPReturnToken();
    const returnState = currentReturnToken ? g.__systemPiPReturnStateRef?.current : null;
    const activeReturnState =
      returnState && Number(returnState.token || 0) === currentReturnToken ? returnState : null;
    const returnRestoreInFlight = !!activeReturnState && (
      !activeReturnState.owner ||
      !activeReturnState.restoredAt ||
      now < Number(activeReturnState.settledUntil || 0)
    );
    return {
      now,
      returningUntil,
      disableUntil,
      suppressAbortUntil,
      currentReturnToken,
      returnRestoreInFlight,
      returnRestoreOwner: activeReturnState?.owner ?? null,
      returnSettledUntil: Number(activeReturnState?.settledUntil || 0),
      active: now < returningUntil || now < disableUntil || now < suppressAbortUntil || returnRestoreInFlight,
    };
  }, [getSystemPiPReturnToken]);

  const cleanupFunction = useCallback(() => {
    logger.info('[VideoCall] 🔥 cleanupFunction вызвана из глобальной ссылки (PiP/фон)');
    if (!isCleanupOwner()) {
      logger.info('[VideoCall] cleanupFunction skipped - cleanup owner changed', {
        instanceId: screenInstanceIdRef.current,
        cleanupOwner: (global as any).__endCallCleanupOwnerRef?.current ?? null,
      });
      return;
    }

    const { active, returningUntil, disableUntil } = getSystemPiPReturnGuard();
    if (active) {
      logger.info('[VideoCall] cleanupFunction skipped - recent system PiP return guard active', {
        returningUntil,
        disableUntil,
      });
      return;
    }

    const currentSession = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    const cleanupCallId = currentSession?.getCallId?.() ?? callId ?? currentCallIdRef.current ?? null;
    const cleanupRoomId = currentSession?.getRoomId?.() ?? roomId ?? null;

    clearVideoCallHomeScreenLocks('cleanupFunction');

    if (isInactiveStateRef.current || isEndingCallRef.current || callEndedTransitionDoneRef.current) {
      logger.info('[VideoCall] cleanupFunction вызвана, но уже в неактивном состоянии или звонок завершается - игнорируем повторный вызов', {
        isInactiveStateRef: isInactiveStateRef.current,
        isEndingCallRef: isEndingCallRef.current,
        callEndedTransitionDoneRef: callEndedTransitionDoneRef.current,
      });
      return;
    }
    if (wasGlobalCleanupDone(cleanupCallId, cleanupRoomId)) {
      logger.info('[VideoCall] cleanupFunction skipped - global cleanup already completed', {
        cleanupCallId,
        cleanupRoomId,
      });
      return;
    }
    if (wasGlobalTeardownScheduled(cleanupCallId, cleanupRoomId)) {
      logger.info('[VideoCall] cleanupFunction skipped - deferred teardown already scheduled globally', {
        cleanupCallId,
        cleanupRoomId,
      });
      return;
    }

    isEndingCallRef.current = true;
    isInactiveStateRef.current = true;
    markGlobalCleanupDone('cleanupFunction', cleanupCallId, cleanupRoomId);

    if (currentSession) {
      try {
        const localStream = currentSession.getLocalStream?.();
        stopStreamTracks(localStream, 'cleanupFunction/sessionLocalStream');

        const sessionAlreadyEnded =
          typeof currentSession.isEnded === 'function' && currentSession.isEnded();
        const callIdForEnd = currentSession.getCallId?.() ?? undefined;
        const roomIdForEnd = currentSession.getRoomId?.() ?? undefined;
        const lastHandledCallEnded = (global as any).__lastHandledCallEndedRef;
        const recentSocketEndedKey = String(lastHandledCallEnded?.key || '');
        const recentSocketEndedAt = Number(lastHandledCallEnded?.at || 0);
        const currentCallEndKey =
          callIdForEnd && roomIdForEnd ? `${callIdForEnd}|${roomIdForEnd}` : callIdForEnd || roomIdForEnd || '';
        const recentSocketEndedForThisCall =
          !!currentCallEndKey &&
          recentSocketEndedKey === currentCallEndKey &&
          Date.now() - recentSocketEndedAt < 5000;

        if (recentSocketEndedForThisCall) {
          logger.info('[VideoCall] cleanupFunction: recent socket call:ended detected, skipping session.endCall', {
            currentCallEndKey,
            elapsedMs: Date.now() - recentSocketEndedAt,
          });
        } else if (!sessionAlreadyEnded && typeof currentSession.endCall === 'function') {
          logger.info('[VideoCall] Вызываем session.endCall() из cleanupFunction');
          currentSession.endCall(callIdForEnd, roomIdForEnd);
        } else if (sessionAlreadyEnded) {
          logger.info('[VideoCall] cleanupFunction: session уже завершена, пропускаем session.endCall');
        } else {
          logger.warn('[VideoCall] session.endCall недоступен в cleanupFunction');
        }

        if (typeof currentSession.cleanup === 'function') {
          logger.info('[VideoCall] Вызываем session.cleanup() из cleanupFunction');
          currentSession.cleanup();
          clearSessionRefs();
        } else {
          logger.warn('[VideoCall] session.cleanup недоступен в cleanupFunction');
          clearSessionRefs();
        }

        try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
        try { InCallManager.setSpeakerphoneOn(false); } catch {}
        try { InCallManager.stop(); } catch {}
      } catch (e) {
        logger.error('[VideoCall] Error in cleanupFunction:', e);
      }
    } else {
      logger.warn('[VideoCall] Session не найдена в cleanupFunction');
    }
  }, [
    callId,
    roomId,
    clearSessionRefs,
    clearVideoCallHomeScreenLocks,
    getSystemPiPReturnGuard,
    isCleanupOwner,
    markGlobalCleanupDone,
    wasGlobalCleanupDone,
    wasGlobalTeardownScheduled,
  ]);

  // Guard: эффект восстановления из PiP должен срабатывать один раз на возврат,
  // иначе он может откатывать camOn после ручного нажатия кнопки камеры.
  const resumeFromPiPEffectRanRef = useRef(0);

  // Упрощено: простое восстановление стримов из PiP
  useEffect(() => {
    const resume = !!route?.params?.resume;
    const fromPiP = !!route?.params?.fromPiP;
    const returnToken = getSystemPiPReturnToken();
    const resumeRunKey = returnToken || -1;
    const session = sessionRef.current;
    const returnState = returnToken ? getSystemPiPReturnState(returnToken) : null;
    
    if (!resume || !fromPiP) {
      resumeFromPiPEffectRanRef.current = 0;
      return;
    }

    if (returnToken && !claimSystemPiPReturnOwner(returnToken)) {
      return;
    }

    if (returnToken && returnState?.restoredAt) {
      resumeFromPiPEffectRanRef.current = resumeRunKey;
      return;
    }

    extendPiPReturnAbortGuard('resume-effect');

    if (resume && fromPiP && session && resumeFromPiPEffectRanRef.current !== resumeRunKey) {
      resumeFromPiPEffectRanRef.current = resumeRunKey;
      const { camOn: desiredCamOn, micOn: desiredMicOn } = getDesiredLocalMediaStateForPiPReturn(pip.localStream);
      if (pip.localStream) {
        setLocalStream(pip.localStream);
        setLocalRenderKey((k: number) => k + 1);
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
      setRemoteMuted(getDesiredRemoteMutedForPiPReturn());
      logMicTraceRef.current('PiP resume effect → setMicOn from local media snapshot', {
        pipIsMuted: pip.isMuted,
        nextMicOn: desiredMicOn,
      });
      setMicOn(!!desiredMicOn);
    }
    // sessionTick нужен: при возврате из PiP сессия подставляется в другом эффекте (sessionRef = global);
    // без sessionTick эффект восстановления запускается до этого и видит session = null, поэтому setMicOn не вызывается.
  }, [route?.params?.resume, route?.params?.fromPiP, pip.localStream, pip.remoteStream, pip.localCamOn, pip.isMuted, pip.isRemoteMuted, sessionTick, getDesiredLocalMediaStateForPiPReturn, getDesiredRemoteMutedForPiPReturn, extendPiPReturnAbortGuard, getSystemPiPReturnToken, getSystemPiPReturnState, claimSystemPiPReturnOwner]);

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
    if (route?.params?.endedFromRemoteSystemPiP) {
      logger.info('[VideoCall] endedFromRemoteSystemPiP — только оболочка завершённого звонка, без новой сессии');
      return;
    }
    // КРИТИЧНО: После завершения звонка не создаём новую сессию — пользователь ещё на экране VideoCall до перехода на Home.
    if (isInactiveState && wasFriendCallEnded) {
      logger.info('[VideoCall] Звонок уже завершён, пропускаем создание сессии');
      return;
    }
    callEndedTransitionDoneRef.current = false; // новый звонок — разрешаем один переход в «завершён»
    deferredTeardownScheduledRef.current = null;
    try {
      const marker = (global as any).__videoCallCleanupDoneRef?.current;
      const teardownMarker = (global as any).__videoCallTeardownScheduledRef?.current;
      const routeCallId = route?.params?.callId ?? null;
      const routeRoomId = route?.params?.roomId ?? null;
      const currentKey = getGlobalCleanupKey(routeCallId, routeRoomId);
      if (marker?.key && marker.key !== currentKey) {
        (global as any).__videoCallCleanupDoneRef.current = null;
      }
      if (teardownMarker?.key && teardownMarker.key !== currentKey) {
        (global as any).__videoCallTeardownScheduledRef.current = null;
      }
    } catch (_) {}
    // КРИТИЧНО: При возврате из PiP используем существующую сессию из глобальной ссылки
    // Это гарантирует, что видеопоток восстановится у обоих участников
    const fromPiP = !!route?.params?.fromPiP;
    const resume = !!route?.params?.resume;
    const returnToken = getSystemPiPReturnToken();
    
    if (fromPiP && resume) {
      if (returnToken && !claimSystemPiPReturnOwner(returnToken)) {
        return;
      }
      if (returnToken && lastSessionReuseReturnTokenRef.current === returnToken) {
        return;
      }
      extendPiPReturnAbortGuard('session-restore-effect');
      const globalSession = (global as any).__webrtcSessionRef?.current;
      if (globalSession && !sessionRef.current) {
        lastSessionReuseReturnTokenRef.current = returnToken;
        sessionRef.current = globalSession;
        setSessionTick((t) => t + 1);
      }
    }
    
    // Не пересоздаем сессию если она уже существует
    // КРИТИЧНО: НЕ возвращаемся здесь - нужно установить обработчики событий
    // Обработчики будут установлены ниже в этом же useEffect
    // Не пересоздаем сессию если она уже существует
    const existingSession = sessionRef.current;
    if (existingSession) {
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
              remoteStreamReceivedAtRef.current = Date.now();
              setLoading(false);
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
          if (!id) setRemoteCamSide('front');
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
            partnerInPiP: partnerInPiPRef.current,
          });
          remoteCamStateKnownRef.current = true;
          setRemoteCamOn(enabled);
          // ВАЖНО: Не дергаем remoteViewKey из UI.
          // Этим управляет сессия через событие remoteViewKeyChanged, иначе на Android легко получить мерцания из-за частых remount RTCView.
        },
        onRemoteCamSideChange: (side) => {
          if (isInactiveStateRef.current || isEndingCallRef.current) return;
          setRemoteCamSide(side);
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
        setLocalCamSide(session.getCamSide?.() ?? 'front');
        setRemoteCamSide(session.getRemoteCamSide?.() ?? 'front');
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
      setLocalCamSide(session.getCamSide?.() ?? 'front');
      setRemoteCamSide(session.getRemoteCamSide?.() ?? 'front');
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

        // Только ctor VideoCallSession поднимает LiveKit из __pendingCallAcceptedRef (queueMicrotask).
        // Старый ранний return по pendingCallId дублировал это и откладывал connect лишним macrotask;
        // явный connectAsInitiatorAfterAccepted нужен, если pending не обработан ctor (например, несовпадение callId).
        if (session.didSchedulePendingCallAcceptedConnect()) {
          logger.info('[VideoCall] Session ctor scheduled pending call:accepted, skipping connectAsInitiatorAfterAccepted', {
            existingCallId,
            friendId,
          });
          return;
        }

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
      session.acceptCall(incomingCallId, fromUserId).catch((e) => {
        logger.error('[VideoCall] Error accepting incoming call:', e);
        setStarted(false);
        setLoading(false);
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
    
    // КРИТИЧНО: Устанавливаем глобальную ссылку на функцию очистки сразу после создания сессии
    // Это нужно чтобы можно было вызвать очистку даже когда VideoCall экран размонтирован (в PiP/фоне)
    (global as any).__endCallCleanupRef.current = cleanupFunction;
    (global as any).__endCallCleanupOwnerRef = (global as any).__endCallCleanupOwnerRef || { current: null };
    (global as any).__endCallCleanupOwnerRef.current = screenInstanceIdRef.current;
    logger.info('[VideoCall] ✅ Глобальная ссылка на функцию очистки установлена при создании сессии', {
      hasCleanupFn: typeof cleanupFunction === 'function',
      hasSession: !!session,
      owner: screenInstanceIdRef.current,
    });
    
    // КРИТИЧНО: Обработчики событий устанавливаются в отдельном useEffect ниже
    // Это гарантирует, что обработчики устанавливаются даже если сессия уже существует
    // КРИТИЧНО: Убрали зависимости roomId, callId, partnerId чтобы не пересоздавать сессию
    // Сессия создается один раз при монтировании компонента
  }, [route?.params?.directCall, route?.params?.resume, route?.params?.endedFromRemoteSystemPiP, pip.visible, pip.isRemoteMuted, clearSessionRefs, isInactiveState, wasFriendCallEnded, isCleanupOwner, getDesiredLocalMediaStateForPiPReturn, getDesiredRemoteMutedForPiPReturn, extendPiPReturnAbortGuard, cleanupFunction, getSystemPiPReturnToken, claimSystemPiPReturnOwner]);
  
  // КРИТИЧНО: Отдельный useEffect для установки обработчиков событий
  // Это гарантирует, что обработчики устанавливаются даже если сессия уже существует
  useEffect(() => {
    const session = sessionForHandlerEffect;
    if (!session) {
      logger.debug('[VideoCall] No session for event handlers setup');
      return;
    }
    const returnToken = currentSystemPiPReturnToken;
    const returnState = currentSystemPiPReturnState;
    if (returnToken && returnState?.owner !== screenInstanceIdRef.current) {
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
      if (!isMountedRef.current) return;
      setRemoteViewKey(key);
    };
    
    const handleCallEnded = () => {
      logger.info('[VideoCall] [end] handleCallEnded вызван', {
        callEndedTransitionDoneRef: callEndedTransitionDoneRef.current,
        isEndingCallRef: isEndingCallRef.current,
        deferredTeardownScheduledBy: deferredTeardownScheduledRef.current?.source ?? null,
      });
      if (deferredTeardownScheduledRef.current) {
        logger.info('[VideoCall] [end] handleCallEnded skipped - deferred teardown already scheduled', {
          scheduledBy: deferredTeardownScheduledRef.current.source,
        });
        return;
      }
      if (callEndedTransitionDoneRef.current) {
        logger.info('[VideoCall] [end] переход уже применён - игнорируем');
        return;
      }
      // Уже на Home (onAbortCall или предыдущий handleCallEnded уже перешли) — не повторяем doReset/bringMainActivityToFront.
      const rootNav = (global as any).__navRef;
      if (rootNav?.isReady?.()) {
        const route = rootNav.getCurrentRoute();
        if (route?.name === 'Home') {
          logger.info('[VideoCall] [end] уже на Home — снимаем блокировки списка друзей');
          callEndedTransitionDoneRef.current = true;
          clearVideoCallHomeScreenLocks('handleCallEnded-already-home');
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
      try {
        const gEnd = global as any;
        gEnd.__endingCallInProgressRef = gEnd.__endingCallInProgressRef || { current: false };
        gEnd.__endingCallInProgressRef.current = true;
      } catch (_) {}
      // Нативно блокируем вход в системный PiP при завершении (иначе пользователь улетает на главный экран с PiP).
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(true); } catch (_) {}
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      logger.info('[VideoCall] [end] refs установлены, закрываем экран');
      logMicTraceRef.current('handleCallEnded — завершение звонка (далее deferred cleanup → session.cleanup / stopLocalTracks)', {
        uiMicOn: micOnRef.current,
        callId: callId ?? currentCallIdRef.current,
      });

      // Закрываем экран видеозвонка: goBack — пользователь остаётся на том же экране, что и до звонка (без мерцания). Если в стеке только VideoCall — reset на Home.
      const endSource = (global as any).__lastEndCallSourceRef?.current;
      const gEnd = global as any;
      const inSystemPiP =
        pipRef.current.inSystemPiPMode === true ||
        gEnd.__pipInSystemModeRef?.current === true;
      const noOpenFlag = gEnd.__callEndedFromPiPNoOpenRef?.current === true;
      const endedFromPiP = endSource === 'pip_close' || noOpenFlag;
      // Без goBack/reset экран остаётся на VideoCall — refs не дают ререндера; через ~1s deferred teardown
      // сбрасывает isEndingCallRef и бейдж/кнопки снова «живые». Синхронизируем React state с «завершённым» UI.
      const stayOnVideoCallAfterEnd = inSystemPiP || endedFromPiP;
      if (stayOnVideoCallAfterEnd) {
        setIsInactiveState(true);
        setWasFriendCallEnded(true);
        setIsEndingCall(true);
      }
      const closeVideoCallScreen = () => {
        try {
          const rootNav = (global as any).__navRef;
          if (!rootNav?.isReady?.()) return;
          const route = rootNav.getCurrentRoute();
          if (route?.name === 'Home') return;
          if (route?.name !== 'VideoCall') return;
          const returnTo = (route as any)?.params?.returnTo;
          const state = rootNav.getState();
          const routes = state?.routes ?? [];
          const canGoBack = typeof rootNav.canGoBack === 'function' ? rootNav.canGoBack() : routes.length > 1;
          logger.info('[VideoCall] [end] closeVideoCallScreen: dispatch goBack/reset', {
            routesLength: routes.length,
            canGoBack,
            hasReturnTo: !!returnTo?.name,
          });
          if (canGoBack) {
            rootNav.dispatch(CommonActions.goBack());
            try { emitCallEndedOnHome(); } catch (_) {}
          } else if (returnTo?.name) {
            rootNav.dispatch(CommonActions.reset({
              index: 0,
              routes: [{ name: returnTo.name as any, params: { ...(returnTo.params || {}), callEnded: true } }],
            }));
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
      const roomIdToCleanup = roomId ?? sessionRef.current?.getRoomId?.() ?? null;
      scheduleDeferredTeardown({
        source: 'handleCallEnded',
        callId: idToReport,
        roomId: roomIdToCleanup,
        sessionSnapshot: sessionRef.current,
        localStreamSnapshot: localStreamRef.current,
        shouldReportEndCall: true,
        shouldEndSession: false,
      });
    };
    
    const handleCallAnswered = () => {
      if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return;
      logger.info('[VideoCall] 🔴 callDeclined event - очистка состояния', {
        roomId,
        callId,
        partnerId,
        partnerUserId,
        timestamp: Date.now()
      });
      
      clearVideoCallHomeScreenLocks('handleCallDeclined');
      
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
      if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return;
      // КРИТИЧНО: Если звонок уже завершён — не обновляем state (никаких setState), чтобы не было ререндеров при закрытии экрана.
      if (isInactiveStateRef.current || isEndingCallRef.current) {
        partnerInPiPRef.current = inPiP;
        return;
      }
      
      // КРИТИЧНО: Всегда обновляем состояние partnerInPiP при получении события
      const previousState = partnerInPiPRef.current;
      partnerInPiPRef.current = inPiP;
      setPartnerInPiP(inPiP);
      
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
    const sessionAttachKey = [
      screenInstanceIdRef.current,
      returnToken || 'no-return',
      needsStreamBridge ? 'bridge' : 'direct',
      typeof (session as any).getCallId === 'function' ? (session as any).getCallId() || '' : '',
      typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() || '' : '',
    ].join('|');
    if (lastAttachedSessionKeyRef.current === sessionAttachKey) {
      return;
    }
    lastAttachedSessionKeyRef.current = sessionAttachKey;

    const handleLocalStreamEvent = (stream: MediaStream | null) => {
      if (!isMountedRef.current) return;
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
      if (!isMountedRef.current) return;
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
      if (lastAttachedSessionKeyRef.current === sessionAttachKey) {
        lastAttachedSessionKeyRef.current = '';
      }
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
      }
    };
    // IMPORTANT: handlers should be attached once per session, not on every UI state change.
  }, [sessionForHandlerEffect, currentSystemPiPReturnToken, currentSystemPiPReturnState?.owner]);
  
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
  const onAbortCall = useCallback(async (source: 'end_button' | 'unknown' = 'unknown') => {
    // Защита от двойного вызова (два источника события / двойной тап) — иначе два goBack и мерцание
    if (isEndingCallRef.current) {
      logger.info('[VideoCall] [end] onAbortCall повторно — пропускаем');
      return;
    }
    if (deferredTeardownScheduledRef.current) {
      logger.info('[VideoCall] [end] onAbortCall skipped - deferred teardown already scheduled', {
        scheduledBy: deferredTeardownScheduledRef.current.source,
      });
      return;
    }

    // КРИТИЧНО: Проверяем до выставления isEndingCallRef — иначе при раннем return залипают кнопки на Home.
    if (isInactiveStateRef.current) {
      logger.info('[VideoCall] onAbortCall вызван в неактивном состоянии - игнорируем', {
        isInactiveStateRef: isInactiveStateRef.current,
        isInactiveState
      });
      return;
    }

    const {
      now,
      returningUntil,
      disableUntil,
      suppressAbortUntil,
      returnRestoreInFlight,
      returnSettledUntil,
      active: systemPiPReturnGuardActive,
    } = getSystemPiPReturnGuard();
    const explicitEndButton = source === 'end_button';
    const isReturningFromSystemPiP = now < returningUntil;
    if (isReturningFromSystemPiP && !explicitEndButton) {
      logger.info('[VideoCall] [end] onAbortCall skipped - returning from system PiP', {
        returningFromSystemPiPUntil: returningUntil,
        callId: callId ?? currentCallIdRef.current ?? null,
        roomId,
      });
      return;
    }
    if (systemPiPReturnGuardActive && !explicitEndButton) {
      logger.info('[VideoCall] [end] onAbortCall skipped - system PiP return guard active', {
        disableUntil,
        suppressAbortUntil,
        returnRestoreInFlight,
        returnSettledUntil,
        callId: callId ?? currentCallIdRef.current ?? null,
        roomId,
      });
      return;
    }
    if (Date.now() < skipAbortAfterPiPReturnUntilRef.current && !explicitEndButton) {
      logger.info('[VideoCall] [end] onAbortCall skipped - recent PiP return screen restore', {
        skipAbortAfterPiPReturnUntil: skipAbortAfterPiPReturnUntilRef.current,
        callId: callId ?? currentCallIdRef.current ?? null,
        roomId,
      });
      return;
    }

    const session = sessionRef.current;

    if (!session) {
      logger.warn('[VideoCall] [end] onAbortCall: нет session (сбой до инициализации) — снимаем блокировки Home');
      isEndingCallRef.current = true;
      setIsEndingCall(true);
      isInactiveStateRef.current = true;
      const g = global as any;
      try {
        g.__endingCallInProgressRef = g.__endingCallInProgressRef || { current: false };
        g.__endingCallInProgressRef.current = true;
      } catch (_) {}
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(true); } catch (_) {}
        try { NativeModules.LiviAppModule?.setShouldEnterPiPOnLeaveHint?.(false); } catch (_) {}
      }
      markGlobalCleanupDone('onAbortCall-no-session', callId ?? currentCallIdRef.current ?? null, roomId ?? null);
      try {
        setWasFriendCallEnded(true);
      } catch (_) {}
      clearVideoCallHomeScreenLocks('onAbortCall-no-session');
      setMicOn(false);
      setCamOn(false);
      try {
        const rootNav = (global as any).__navRef;
        if (rootNav?.isReady?.()) {
          const currentRoute = rootNav.getCurrentRoute();
          const alreadyResetByVideoCall = !!(global as any).__homeResetByVideoCallRef?.current;
          if (currentRoute?.name === 'VideoCall' && !alreadyResetByVideoCall) {
            try { (global as any).__homeResetByVideoCallRef.current = true; } catch (_) {}
            const state = rootNav.getState();
            const routes = state?.routes ?? [];
            if (routes.length > 1) {
              rootNav.dispatch(CommonActions.goBack());
              try { emitCallEndedOnHome(); } catch (_) {}
            } else {
              rootNav.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any, params: { callEnded: true } }] }));
              try { emitCallEndedOnHome(); } catch (_) {}
            }
          }
        }
      } catch (e) {
        logger.warn('[VideoCall] onAbortCall no-session navigation failed', e);
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
        logger.debug('[VideoCall] isEndingCallRef reset (onAbortCall no-session)');
      }, 1000);
      return;
    }

    isEndingCallRef.current = true;
    setIsEndingCall(true);

    const g = global as any;
    const wasInPiP = g.__pipVisibleRef?.current === true || g.__pipInSystemModeRef?.current === true;

    logger.info('[VideoCall] [end] onAbortCall начат', { roomId, callId, partnerId, source });

    // КРИТИЧНО: Сразу выставляем refs завершения (до навигации и session.endCall), чтобы колбэки сессии
    // (onRemoteCamStateChange, onPartnerIdChange, onRoomIdChange, onCallIdChange, handlePartnerPiPStateChanged) не вызывали setState и не давали ререндеров.
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
          const returnTo = (currentRoute as any)?.params?.returnTo;
          if (currentRoute?.name === 'VideoCall') {
            const canGoBack = typeof rootNav.canGoBack === 'function' ? rootNav.canGoBack() : routes.length > 1;
            logger.info('[VideoCall] [end] onAbortCall: goBack (вернём на экран под VideoCall)', {
              routesLength: routes.length,
              canGoBack,
              hasReturnTo: !!returnTo?.name,
            });
            if (canGoBack) {
              rootNav.dispatch(CommonActions.goBack());
              try { emitCallEndedOnHome(); } catch (_) {}
            } else if (returnTo?.name) {
              rootNav.dispatch(CommonActions.reset({
                index: 0,
                routes: [{ name: returnTo.name as any, params: { ...(returnTo.params || {}), callEnded: true } }],
              }));
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

    scheduleDeferredTeardown({
      source: 'onAbortCall',
      callId: idToSend ?? idToReport ?? null,
      roomId: roomToSend ?? null,
      sessionSnapshot: sessionRefForCleanup,
      localStreamSnapshot: localStreamForCleanup,
      shouldReportEndCall: true,
      shouldEndSession: true,
    });

    setTimeout(() => {
      try {
        const gr = (global as any).__endingCallInProgressRef;
        if (gr && typeof gr.current !== 'undefined') gr.current = false;
      } catch (_) {}
      if (Platform.OS === 'android') {
        try { NativeModules.LiviAppModule?.setEndingCallInProgress?.(false); } catch (_) {}
      }

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
    }, 1000);
  }, [isInactiveState, roomId, callId, localStream, getSystemPiPReturnGuard]);
  
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
    const returnToken = getSystemPiPReturnToken();
    const returnState = getSystemPiPReturnState(returnToken);

    if (returnToken && returnState?.owner && returnState.owner !== screenInstanceIdRef.current) {
      return;
    }

    // Обновляем ссылку на сессию (на случай если она изменилась)
    if (session) {
      (global as any).__webrtcSessionRef.current = session;
      (global as any).__endCallCleanupRef.current = cleanupFunction;
      (global as any).__endCallCleanupOwnerRef = (global as any).__endCallCleanupOwnerRef || { current: null };
      (global as any).__endCallCleanupOwnerRef.current = screenInstanceIdRef.current;
    }

  }, [cleanupFunction, getSystemPiPReturnToken, getSystemPiPReturnState]);

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
      const returnTo = (route as any)?.params?.returnTo;
      const state = rootNav.getState();
      const routes = state?.routes ?? [];
      const canGoBack = typeof rootNav.canGoBack === 'function' ? rootNav.canGoBack() : routes.length > 1;
      if (canGoBack) {
        rootNav.dispatch(CommonActions.goBack());
        try { emitCallEndedOnHome(); } catch (_) {}
      } else if (returnTo?.name) {
        rootNav.dispatch(CommonActions.reset({
          index: 0,
          routes: [{ name: returnTo.name as any, params: { ...(returnTo.params || {}), callEnded: true } }],
        }));
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
      const rootNav = (global as any).__navRef;
      const currentRouteName = rootNav?.isReady?.() ? rootNav.getCurrentRoute()?.name : null;
      const replacedByAnotherVideoCall = currentRouteName === 'VideoCall';
      const pipVisible =
        (global as any).__pipVisibleRef?.current === true ||
        (global as any).__pipInSystemModeRef?.current === true;
      const { now, returningUntil, disableUntil, active: systemPiPReturnGuardActive } = getSystemPiPReturnGuard();
      const returningFromSystemPiP = now < returningUntil;
      // Если звонок уже корректно завершили через handleCallEnded/onAbortCall — не дёргаем cleanup повторно.
      // Иначе для "второго участника" (который не нажимал end) получается двойное завершение.
      const alreadyEndedOrEnding =
        isInactiveStateRef.current ||
        isEndingCallRef.current ||
        callEndedTransitionDoneRef.current;
      const cleanupAlreadyDone = wasGlobalCleanupDone(
        currentCallIdRef.current ?? route?.params?.callId ?? null,
        roomId ?? route?.params?.roomId ?? null
      );
      const teardownAlreadyScheduled = wasGlobalTeardownScheduled(
        currentCallIdRef.current ?? route?.params?.callId ?? null,
        roomId ?? route?.params?.roomId ?? null
      );
      if (
        !returningFromSystemPiP &&
        !systemPiPReturnGuardActive &&
        !replacedByAnotherVideoCall &&
        !cleanupAlreadyDone &&
        !teardownAlreadyScheduled &&
        isCleanupOwner() &&
        !pipVisible &&
        !alreadyEndedOrEnding
      ) {
        const cleanupFn = (global as any).__endCallCleanupRef?.current;
        if (typeof cleanupFn === 'function') {
          try {
            cleanupFn();
          } catch (e) {
            logger.warn('[VideoCall] Ошибка при cleanup при размонтировании', e);
          }
        }
      }
      if (!sessionRef.current && isCleanupOwner()) {
        (global as any).__webrtcSessionRef.current = null;
        (global as any).__endCallCleanupRef.current = null;
        if ((global as any).__endCallCleanupOwnerRef) {
          (global as any).__endCallCleanupOwnerRef.current = null;
        }
      }
    };
  }, [roomId, route?.params?.callId, route?.params?.roomId, wasGlobalCleanupDone, isCleanupOwner, getSystemPiPReturnGuard]);
  
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
  const endCallBlockedBySystemPiPReturn = getSystemPiPReturnGuard().returnRestoreInFlight;
  
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
            muteLocal: params?.muteLocal,
            muteRemote: params?.muteRemote,
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
              setTimeout(() => upd({ pendingSystemPiP: false, systemPiPCaptureActive: false, decorSizeForPiP: null }), 2000);
            }
          }
        };
        if (typeof upd === 'function') {
          const apply = (size: { width: number; height: number } | null) => {
            upd({ pendingSystemPiP: true, systemPiPCaptureActive: true, systemPiPCaptureRequestId: Date.now(), allowVideoRender: true, ...(size ? { decorSizeForPiP: size } : {}) });
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
      const returnToken = getSystemPiPReturnToken();
      const returnState = returnToken ? getSystemPiPReturnState(returnToken) : null;
      const alreadyHandledReturn =
        !!returnToken && (
          lastHandledSystemPiPReturnTokenRef.current === returnToken ||
          !!returnState?.restoredAt
        );
      const isReturningFromPiP =
        route?.params?.resume &&
        route?.params?.fromPiP &&
        !fromPiPProcessedRef.current &&
        !alreadyHandledReturn;
      
      if (isReturningFromPiP) {
        if (returnToken && !claimSystemPiPReturnOwner(returnToken)) {
          return;
        }
        if (returnToken) {
          lastHandledSystemPiPReturnTokenRef.current = returnToken;
        }
        fromPiPProcessedRef.current = true;
        focusEffectGuardRef.current = true;
        extendPiPReturnAbortGuard('focus-return');

        const syncPiPState = (global as any).__pipSyncSessionStateRef?.current;
        if (typeof syncPiPState === 'function') {
          syncPiPState(false, 'VideoCall.focusReturn');
        }
        if (pipRef.current.visible || isPipOverlayVisibleSync()) {
          pipRef.current.hidePiP();
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
          const effectiveLocalStream = sessionLocalStream || pipLocalStream || localStream || localStreamRef.current;
          const { camOn: desiredCamOn, micOn: desiredMicOn } = getDesiredLocalMediaStateForPiPReturn(effectiveLocalStream);
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
            setRemoteMuted(getDesiredRemoteMutedForPiPReturn());
            logMicTraceRef.current('focus return from PiP → setMicOn from local media snapshot', {
              pipIsMuted: pip.isMuted,
              nextMicOn: desiredMicOn,
            });
            setMicOn(!!desiredMicOn);
            
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
            setRemoteMuted(getDesiredRemoteMutedForPiPReturn());
            logMicTraceRef.current('focus return from PiP → setMicOn from local media snapshot', {
              pipIsMuted: pip.isMuted,
              nextMicOn: desiredMicOn,
            });
            setMicOn(!!desiredMicOn);
            
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
        if (returnToken) {
          markSystemPiPReturnRestored(returnToken);
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
          const syncPiPState = (global as any).__pipSyncSessionStateRef?.current;
          if (typeof syncPiPState === 'function') {
            syncPiPState(false, 'VideoCall.focusCleanupEndedCall');
          }
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
      remoteStream,
      getDesiredLocalMediaStateForPiPReturn,
      getDesiredRemoteMutedForPiPReturn,
      extendPiPReturnAbortGuard,
      getSystemPiPReturnToken,
      getSystemPiPReturnState,
      claimSystemPiPReturnOwner,
      markSystemPiPReturnRestored,
      syncRouteNow
    ])
  );
  
  
  // Как в WhatsApp/Telegram: в системном PiP рисуем только видео собеседника; фон прозрачный, чтобы в окне PiP не было чёрных областей.
  // При возврате из PiP (fromPiP) показываем полноэкранный вид; при повторном входе в PiP (pendingSystemPiP) — компакт, иначе захватится layout с бейджем/кнопкой.
  const systemPiPCompact =
    Platform.OS === 'android' &&
    !pip.systemPiPCaptureActive &&
    (pip.pendingSystemPiP || pip.inSystemPiPMode) &&
    (pip.pendingSystemPiP || !route?.params?.fromPiP);
  if (systemPiPCompact) {
    return (
      <SafeAreaView style={styles.systemPiPContainer} edges={[]}>
        <View style={styles.systemPiPVideoFill}>
          <RemoteVideo
            remoteStream={currentRemoteStream}
            remoteCamOn={remoteCamOn}
            remoteCamSide={remoteCamSide}
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
            partnerInPiP={false}
            forceTextureView={true}
            objectFit="contain"
          />
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
        >
          <RemoteVideo
            remoteStream={currentRemoteStream}
            remoteCamOn={remoteCamOn}
            remoteCamSide={remoteCamSide}
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
        >
          <LocalVideo
            localStream={localStream}
            camOn={camOn}
            isFrontCamera={localCamSide === 'front'}
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
              Promise.resolve(session.flipCam())
                .then(() => {
                  setLocalCamSide((prev) => (prev === 'front' ? 'back' : 'front'));
                })
                .catch((e: any) => {
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
                    onAbortCall('end_button');
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
  systemPiPContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  systemPiPVideoFill: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
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
