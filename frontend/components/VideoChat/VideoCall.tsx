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
  Pressable,
  Platform,
  Animated,
  BackHandler,
  Easing,
  NativeModules,
  AppState,
} from 'react-native';
import { CommonActions, useNavigation, useFocusEffect, useIsFocused } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaStream } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { VideoCallSession } from '../../src/webrtc/sessions/VideoCallSession';
import type { CamSide, WebRTCSessionConfig } from '../../src/webrtc/types';
import { BlurView } from 'expo-blur';
import { MediaControls } from './shared/MediaControls';
import { LocalVideo } from './shared/LocalVideo';
import { RemoteVideo } from './shared/RemoteVideo';
import { HiddenRemoteAudioSink } from './shared/HiddenRemoteAudioSink';
import { partnerRemoteRtcLikelyVisible, streamHasLiveRemoteAudio } from './shared/callTimerUtils';
// import VoiceEqualizer from '../VoiceEqualizer'; // эквалайзер отключен
import { t, loadLang, defaultLang } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { uiAccent } from '../../theme/uiAccent';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import { usePiP, isPipOverlayVisibleSync } from '../../src/pip/PiPContext';
import { setPipAudioOnlyPlaceholderSticky, shouldUsePipPlaceholderOnly, isInAudioOnlyCallUi, pipInAppBarEnteredFromAudioOnly, refreshSystemPiPLeaveContextSnapshot } from '../../src/pip/pipPlaceholderOnly';
import socket, {
  fetchFriends,
  getCurrentUserId,
  setActiveVideoCall,
  onConnected,
  emitPresenceUpdateIfChanged,
} from '../../sockets/socket';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import {
  reenableAndroidSystemPiPLeaveHintAfterReturn,
  isAndroidLeaveHintHomeTransitionHold,
  setAndroidSystemPiPLeaveHintEnabled,
  shouldBlockAndroidLeaveHintDisarm,
  refreshAndroidActiveCallNotification,
  syncAndroidSystemPiPLeaveHintForActiveVideoCall,
  syncAndroidSystemPiPNativeFlags,
} from '../../utils/activeCallNotification';
import { isOngoingCallSession } from '../../utils/activeCallSession';
import { iconNameForRoute, type InCallAudioRoute } from './hooks/audioRouteTypes';
import { useAudioRouting } from './hooks/useAudioRouting';
import { usePiP as usePiPHook } from './hooks/usePiP';
import { useIncomingCall } from './hooks/useIncomingCall';
import AsyncStorage from '@react-native-async-storage/async-storage';
import InCallManager from 'react-native-incall-manager';
import {
  reportEndCallToCallKeep,
  bringMainActivityToFront,
  requestExitSystemPiPSoft,
  pauseBackgroundMediaAfterCall,
  resolveDirectCallAudioFirst,
} from '../../utils/callKeep';
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
      /** Аудиозвонок: камера выключена до upgrade. */
      startWithCamOff?: boolean;
      callMedia?: 'audio' | 'video';
      /** Одноразово: развернуть PiP в полноэкранный видео UI (не держать в params после применения). */
      preferVideoCallUi?: boolean;
      audioOnlyPiPReturn?: boolean;
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

const formatCallDuration = (totalSeconds: number): string => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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

function getGlobalCallTimerRefs() {
  const g = global as any;
  g.__acceptCallTimeRef = g.__acceptCallTimeRef || { current: 0 };
  g.__callConnectedAtRef = g.__callConnectedAtRef || { current: null as number | null };
  return {
    accept: g.__acceptCallTimeRef as { current: number },
    connected: g.__callConnectedAtRef as { current: number | null },
  };
}

function syncCallTimerFromGlobal(
  acceptCallTimeRef: React.MutableRefObject<number>,
  callConnectedAtRef: React.MutableRefObject<number | null>,
) {
  const { accept, connected } = getGlobalCallTimerRefs();
  if (accept.current > 0) acceptCallTimeRef.current = accept.current;
  if (connected.current != null) callConnectedAtRef.current = connected.current;
}

function persistCallTimerToGlobal(
  acceptCallTimeRef: React.MutableRefObject<number>,
  callConnectedAtRef: React.MutableRefObject<number | null>,
) {
  const { accept, connected } = getGlobalCallTimerRefs();
  if (acceptCallTimeRef.current > 0) accept.current = acceptCallTimeRef.current;
  if (callConnectedAtRef.current != null) connected.current = callConnectedAtRef.current;
}

const VideoCall: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  const accent = useMemo(() => uiAccent(isDark), [isDark]);
  
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
  
  const initialCamOff = resolveDirectCallAudioFirst(route?.params ?? {}, null);
  const preferVideoUiOnMount =
    route?.params?.preferVideoCallUi === true ||
    (!!(global as any).__expandToVideoCallUiFromPiPRef?.current &&
      (route?.params?.fromPiP === true || route?.params?.resume === true) &&
      route?.params?.audioOnlyPiPReturn !== true &&
      (global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current !== true);
  const preferAudioFromPiPOnMount =
    !preferVideoUiOnMount &&
    (route?.params?.audioOnlyPiPReturn === true ||
      (global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current === true ||
      (global as any).__inAudioOnlyUiRef?.current === true ||
      (global as any).__pipAudioOnlyPlaceholderRef?.current === true);
  const initialLiveSession = (() => {
    try {
      const sess = (global as any).__webrtcSessionRef?.current;
      const cid = route?.params?.callId;
      if (!sess || typeof sess.isEnded !== 'function' || sess.isEnded() || !cid) return null;
      if (String(sess.getCallId?.() || '') !== String(cid)) return null;
      return sess;
    } catch {
      return null;
    }
  })();
  const initialLiveCallAccepted = !!(
    initialLiveSession &&
    (initialLiveSession.getRoomId?.() || preferAudioFromPiPOnMount)
  );

  // Состояния
  const [started, setStarted] = useState(() => initialLiveCallAccepted);
  const [loading, setLoading] = useState(() => !initialLiveCallAccepted);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(route?.params?.peerUserId || null);
  const [roomId, setRoomId] = useState<string | null>(route?.params?.roomId || null);
  const [callId, setCallId] = useState<string | null>(route?.params?.callId || null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(() => {
    if (!initialLiveSession) return null;
    try {
      return initialLiveSession.getRemoteStream?.() ?? null;
    } catch {
      return null;
    }
  });
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

  const [camOn, setCamOn] = useState(
    preferVideoUiOnMount ? true : preferAudioFromPiPOnMount ? false : !initialCamOff,
  );
  const [inAudioOnlyUi, setInAudioOnlyUi] = useState(
    preferVideoUiOnMount ? false : preferAudioFromPiPOnMount || initialCamOff,
  );
  const inAudioOnlyUiRef = useRef(inAudioOnlyUi);
  inAudioOnlyUiRef.current = inAudioOnlyUi;
  const userRouteRef = useRef<InCallAudioRoute>('EARPIECE');
  const speakerOnRef = useRef(false);
  /** После перехода на видео UI не возвращать на экран аудиозвонка при выключении камеры (только mute видео). */
  const stayOnVideoCallUiRef = useRef(
    preferVideoUiOnMount || route?.params?.callMedia === 'video',
  );
  useEffect(() => {
    const g = global as any;
    g.__inAudioOnlyUiRef = inAudioOnlyUiRef;
    g.__stayOnVideoCallUiRef = stayOnVideoCallUiRef;
    return () => {
      if (g.__inAudioOnlyUiRef === inAudioOnlyUiRef) {
        const session = g.__webrtcSessionRef?.current;
        const onVideoUi = stayOnVideoCallUiRef.current === true;
        if (onVideoUi) {
          setPipAudioOnlyPlaceholderSticky(false);
        }
        const videoCallActive =
          session?.getIsCamOn?.() ||
          session?.getRemoteCamEnabled?.() ||
          inAudioOnlyUiRef.current === false;
        setPipAudioOnlyPlaceholderSticky(inAudioOnlyUiRef.current === true && !videoCallActive);
        const keepAudioOnlySticky = g.__pipAudioOnlyPlaceholderRef?.current === true;
        if (!inAudioOnlyUiRef.current && !keepAudioOnlySticky) {
          g.__inAudioOnlyUiRef = { current: false };
        }
      }
      if (g.__stayOnVideoCallUiRef === stayOnVideoCallUiRef) {
        const session = g.__webrtcSessionRef?.current;
        const callLive =
          session && typeof session.isEnded === 'function' ? !session.isEnded() : false;
        const preserveVideoUi = callLive && stayOnVideoCallUiRef.current === true;
        g.__stayOnVideoCallUiRef = { current: preserveVideoUi };
      }
    };
  }, []);
  useEffect(() => {
    setPipAudioOnlyPlaceholderSticky(inAudioOnlyUi);
  }, [inAudioOnlyUi]);

  /** Собеседник на video UI или in-app PiP (direct call) — пульс кнопки «видео» на audio UI. */
  const [peerInvitedVideo, setPeerInvitedVideo] = useState(false);

  const syncPeerVideoInviteHint = useCallback(() => {
    if (!inAudioOnlyUiRef.current) {
      setPeerInvitedVideo(false);
      return;
    }
    if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) {
      setPeerInvitedVideo(false);
      return;
    }
    const session = (sessionRef.current || (global as any).__webrtcSessionRef?.current) as
      | VideoCallSession
      | null;
    if (!session || session.isEnded?.()) {
      setPeerInvitedVideo(false);
      return;
    }
    if (session.isPartnerPeerOnDirectCallAudioUi?.() === true) {
      setPeerInvitedVideo(false);
      return;
    }
    const partnerDeclaredVideoUi = session.getPartnerPeerDirectCallVideoUi?.() === true;
    const partnerDeclaredAudioUi = session.isPartnerPeerOnDirectCallAudioUi?.() === true;
    const partnerInPiPForHint =
      !partnerDeclaredAudioUi &&
      (partnerInPiPRef.current || session.getPartnerInPiP?.() === true);
    const partnerOnVideoUiFlag = partnerDeclaredVideoUi || partnerInPiPForHint;
    const partnerCamOnWhileWeAreOnAudio =
      !partnerDeclaredAudioUi && session.getRemoteCamEnabled?.() === true;
    const partnerVideoUi = partnerOnVideoUiFlag || partnerCamOnWhileWeAreOnAudio;
    setPeerInvitedVideo(!!partnerVideoUi);
  }, []);

  useEffect(() => {
    const pending = (global as any).__pendingCallAcceptedRef?.current;
    const pendingCallId = pending ? String(pending?.callId ?? '') : null;
    const audioFirst = resolveDirectCallAudioFirst(route?.params ?? {}, pendingCallId);
    if (route?.params?.callMedia === 'video') {
      stayOnVideoCallUiRef.current = true;
      setInAudioOnlyUi(false);
      setPipAudioOnlyPlaceholderSticky(false);
      return;
    }
    if (route?.params?.preferVideoCallUi === true) {
      stayOnVideoCallUiRef.current = true;
      setInAudioOnlyUi(false);
      setPipAudioOnlyPlaceholderSticky(false);
      return;
    }
    if (audioFirst && !camOn && !stayOnVideoCallUiRef.current) setInAudioOnlyUi(true);
  }, [
    route?.params?.directCall,
    route?.params?.directInitiator,
    route?.params?.callMedia,
    route?.params?.startWithCamOff,
    route?.params?.callId,
    route?.params?.preferVideoCallUi,
    camOn,
  ]);
  const [micOn, setMicOn] = useState(true);
  /** Зеркало `micOn` после рендера; в колбэках сессии лог может быть до следующего рендера — см. micMatchesUiYet. */
  const micOnRef = useRef(micOn);
  micOnRef.current = micOn;
  const logMicTraceRef = useRef<(where: string, details?: Record<string, unknown>) => void>(() => {});
  logMicTraceRef.current = () => {};

  const [remoteCamOn, setRemoteCamOn] = useState(!initialCamOff);
  const remoteCamStateKnownRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    refreshAndroidActiveCallNotification();
  }, [inAudioOnlyUi, camOn, remoteCamOn, remoteStream?.id]);

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
  const [friendCallAccepted, setFriendCallAccepted] = useState(() => initialLiveCallAccepted);
  const callConnectedAtRef = useRef<number | null>(null);
  const [callElapsedSec, setCallElapsedSec] = useState(0);
  const [buttonsOpacity] = useState(new Animated.Value(1));
  const incomingCallBounce = useRef(new Animated.Value(0)).current;
  const incomingWaveA = useRef(new Animated.Value(0)).current;
  const incomingWaveB = useRef(new Animated.Value(0)).current;
  const peerVideoPulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isInactiveStateRef.current || isEndingCallRef.current) return;
    if (inAudioOnlyUiRef.current) return;
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

  useEffect(() => {
    syncCallTimerFromGlobal(acceptCallTimeRef, callConnectedAtRef);
    const { connected } = getGlobalCallTimerRefs();
    if (connected.current != null) {
      setCallElapsedSec(Math.floor((Date.now() - connected.current) / 1000));
    }
  }, []);

  const notifyPeerDirectCallVideoUi = useCallback((inVideoCallUi: boolean) => {
    if (!route?.params?.directCall) return;
    const session = (sessionRef.current || (global as any).__webrtcSessionRef?.current) as
      | VideoCallSession
      | null;
    try {
      session?.notifyPeerDirectCallVideoUi?.(inVideoCallUi);
    } catch {}
  }, [route?.params?.directCall]);

  const handlePeerDirectCallVideoUiChange = useCallback((inVideoCallUi?: boolean) => {
    if (inAudioOnlyUiRef.current && inVideoCallUi === false) {
      setPeerInvitedVideo(false);
    }
    syncPeerVideoInviteHint();
  }, [syncPeerVideoInviteHint]);
  
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
    if (isInAudioOnlyCallUi() || pipInAppBarEnteredFromAudioOnly()) {
      const effectiveStream =
        stream ||
        sessionRef.current?.getLocalStream?.() ||
        pip.localStream ||
        localStreamRef.current ||
        null;
      const trackMicOn = getTrackEnabled(effectiveStream, 'audio');
      return {
        micOn: typeof trackMicOn === 'boolean' ? trackMicOn : !pip.isMuted,
        camOn: false,
      };
    }
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
      const audioFirst = resolveDirectCallAudioFirst(route?.params ?? {}, callId ?? null);
      const camFromSession = sessionRef.current?.getIsCamOn?.();
      const nextCamOn = audioFirst
        ? false
        : typeof camFromSession === 'boolean'
          ? camFromSession
          : !audioFirst;
      setCamOn(nextCamOn);
      logMicTraceRef.current('incoming useIncomingCall onAccept → setMicOn(true)', {
        callId,
        fromUserId,
        camOnAccept: nextCamOn,
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
    // Android Back: goBack + in-app PiP; системный PiP — только кнопка «Домой».
    enableAndroidBackHandler: true,
    getAudioOutputRoute: () => userRouteRef.current,
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
  const currentSystemPiPReturnToken = Number(
    route?.params?.systemPiPReturnToken || (global as any).__systemPiPReturnTokenRef?.current || 0
  );
  const currentSystemPiPReturnState =
    currentSystemPiPReturnToken &&
    Number((global as any).__systemPiPReturnStateRef?.current?.token || 0) === currentSystemPiPReturnToken
      ? (global as any).__systemPiPReturnStateRef?.current
      : null;
  const directCallRoute = !!route?.params?.directCall;
  const audioFirstDirectCall =
    directCallRoute &&
    route?.params?.callMedia !== 'video' &&
    route?.params?.preferVideoCallUi !== true;
  const { syncRouteNow, cycleUserRoute, selectedRoute } = useAudioRouting(
    hasActiveCallForAudio && !isInactiveState,
    currentRemoteStream,
    inAudioOnlyUi,
    audioFirstDirectCall && inAudioOnlyUi
      ? { defaultToEarpiece: true, userRouteRef, speakerOnRef }
      : undefined,
  );
  const syncRouteNowRef = useRef(syncRouteNow);
  syncRouteNowRef.current = syncRouteNow;
  const scheduleDirectCallAudioRepinRef = useRef<() => void>(() => {});
  const directCallAudioRepinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDirectCallAudioRepin = useCallback(() => {
    if (!directCallRoute) return;
    if (directCallAudioRepinTimerRef.current) {
      clearTimeout(directCallAudioRepinTimerRef.current);
    }
    directCallAudioRepinTimerRef.current = setTimeout(() => {
      directCallAudioRepinTimerRef.current = null;
      try { syncRouteNowRef.current?.(); } catch {}
    }, 280);
  }, [directCallRoute]);
  scheduleDirectCallAudioRepinRef.current = scheduleDirectCallAudioRepin;
  const pinInitialAudioCallEarpieceRef = useRef(() => {});
  pinInitialAudioCallEarpieceRef.current = () => {
    if (!directCallRoute || route?.params?.callMedia === 'video') return;
    const audioFirst = resolveDirectCallAudioFirst(route?.params ?? {}, callId ?? null);
    if (!inAudioOnlyUiRef.current && !audioFirst) return;
    void (async () => {
      try {
        const res = await InCallManager.getIsWiredHeadsetPluggedIn();
        const plugged = !!((res as { isWiredHeadsetPluggedIn?: boolean })?.isWiredHeadsetPluggedIn ?? res);
        if (plugged) return;
      } catch {}
      userRouteRef.current = 'EARPIECE';
      speakerOnRef.current = false;
      try {
        syncRouteNowRef.current?.();
      } catch {}
    })();
  };
  const cycleAudioRoute = useCallback(() => {
    try {
      cycleUserRoute();
    } catch {}
  }, [cycleUserRoute]);
  const audioRouteIcon = iconNameForRoute(selectedRoute);

  
  // Refs
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const isInactiveStateRef = useRef(false);
  const isEndingCallRef = useRef(false); // КРИТИЧНО: Флаг для предотвращения повторных вызовов handleCallEnded
  const wasFriendCallEndedRef = useRef(false);
  const [isEndingCall, setIsEndingCall] = useState(false); // Синхронно с ref: скрываем бейдж/активный звонок при завершении, чтобы не мигало
  const callEndedTransitionDoneRef = useRef(false); // Один переход в UI «завершён» — защита от многократных setState при disconnect + call:ended
  const remoteEndedShellAppliedRef = useRef(false);
  const deferredTeardownScheduledRef = useRef<{ key: string; source: string } | null>(null);
  const sessionInitRouteKeyRef = useRef<string | null>(null);
  const skipAbortAfterPiPReturnUntilRef = useRef(0);
  const lastHandledSystemPiPReturnTokenRef = useRef(0);
  const lastSessionReuseReturnTokenRef = useRef(0);
  const lastAttachedSessionKeyRef = useRef('');
  const [sessionHandlerAttachKey, setSessionHandlerAttachKey] = useState('');
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
  useEffect(() => { wasFriendCallEndedRef.current = wasFriendCallEnded; }, [wasFriendCallEnded]);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const returnToken = currentSystemPiPReturnToken;
    const returnState = currentSystemPiPReturnState;
    if (returnToken && returnState?.owner !== screenInstanceIdRef.current) {
      return;
    }
    const needsStreamBridge = !createdSessionsRef.current.has(session as any);
    const key = [
      screenInstanceIdRef.current,
      returnToken || 'no-return',
      needsStreamBridge ? 'bridge' : 'direct',
      typeof (session as any).getCallId === 'function' ? (session as any).getCallId() || '' : '',
      typeof (session as any).getRoomId === 'function' ? (session as any).getRoomId() || '' : '',
    ].join('|');
    setSessionHandlerAttachKey((prev) => (prev === key ? prev : key));
  }, [sessionTick, currentSystemPiPReturnToken, currentSystemPiPReturnState?.owner]);

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
    partnerInPiPRef.current = false;
    setPartnerInPiP(false);
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
    const sub = AppState.addEventListener('change', (next) => {
      setAppState(next);
    });
    return () => sub.remove();
  }, [callId, roomId]);

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
    const effectiveSystemPiPCallId =
      callId || route?.params?.callId || sessionForSystemPiP?.getCallId?.() || null;
    const effectiveSystemPiPRoomId =
      roomId || route?.params?.roomId || sessionForSystemPiP?.getRoomId?.() || null;
    const sessionAliveForSystemPiP =
      !sessionForSystemPiP ||
      typeof (sessionForSystemPiP as any).isEnded !== 'function' ||
      !(sessionForSystemPiP as any).isEnded();
    const globalVideoCallActiveForPiP = g.__videoCallActiveRef?.current !== false;
    const hasStableSystemPiPContext =
      Platform.OS === 'android' &&
      !!effectiveSystemPiPRoomId &&
      !isInactiveState &&
      !!sessionForSystemPiP &&
      sessionAliveForSystemPiP;
    const canEnableSystemPiP =
      Platform.OS === 'android' &&
      isFocused &&
      !!effectiveSystemPiPRoomId &&
      !isInactiveState &&
      !!sessionForSystemPiP &&
      sessionAliveForSystemPiP &&
      globalVideoCallActiveForPiP;

    const syncPiPParamsRef = () => {
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
        callId: effectiveSystemPiPCallId || '',
        roomId: effectiveSystemPiPRoomId || '',
        partnerName: (partner as any)?.nick || '',
        partnerAvatarUrl: avatarUrl,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        localCamOn: getTrackEnabled(localStream, 'video') ?? camOn,
        muteLocal: !(getTrackEnabled(localStream, 'audio') ?? micOn),
        muteRemote: getDesiredRemoteMutedForPiPReturn(),
        remoteCamOn,
        preferVideoCallUi: !inAudioOnlyUiRef.current,
        inAudioOnlyUi: inAudioOnlyUiRef.current,
        audioOutputRoute: userRouteRef.current,
        navParams: { ...route?.params, peerUserId: partnerUserId, partnerId } as any,
      };
      refreshSystemPiPLeaveContextSnapshot();
    };

    // Не очищаем ref при !canEnableSystemPiP — иначе при возврате из системного PiP returnToCall получит null.
    // Очищаем только в cleanup эффекта, когда сессия реально завершена (stillActive === false).
    if (!hasStableSystemPiPContext) {
      if (Platform.OS === 'android' && !shouldBlockAndroidLeaveHintDisarm()) {
        setAndroidSystemPiPLeaveHintEnabled(false);
      }
      return;
    }
    syncPiPParamsRef();
    const holdLeaveHintForHome =
      isAndroidLeaveHintHomeTransitionHold() || appState === 'background';
    const shouldArmLeaveHintNative =
      hasStableSystemPiPContext &&
      globalVideoCallActiveForPiP &&
      !isInactiveState;
    const shouldSyncActiveCallNativeState =
      shouldArmLeaveHintNative && (canEnableSystemPiP || holdLeaveHintForHome || isOngoingCallSession());
    if (Platform.OS === 'android') {
      if (shouldArmLeaveHintNative || shouldBlockAndroidLeaveHintDisarm() || isOngoingCallSession()) {
        setAndroidSystemPiPLeaveHintEnabled(true);
      } else if (!holdLeaveHintForHome) {
        setAndroidSystemPiPLeaveHintEnabled(false);
      }
    }
    if (Platform.OS === 'android' && shouldSyncActiveCallNativeState) {
      refreshAndroidActiveCallNotification();
    } else if (Platform.OS === 'android' && hasStableSystemPiPContext && sessionAliveForSystemPiP) {
      syncAndroidSystemPiPNativeFlags();
    }
    const paramsForPip = g.__currentCallPiPParamsRef?.current;
    const pipUpd = g.__pipUpdateStateRef?.current;
    if (
      typeof pipUpd === 'function' &&
      paramsForPip?.remoteStream &&
      g.__pipVisibleRef?.current !== true
    ) {
      pipUpd({
        remoteStream: paramsForPip.remoteStream,
        localStream: paramsForPip.localStream ?? null,
        remoteCamOn: paramsForPip.remoteCamOn,
      });
    }
    return () => {
      // При уходе по «Назад» (in-app PiP) или по «Домой» (системный PiP) не сбрасываем params и hint.
      const leavingByBack = g.__leavingVideoCallByBackRef?.current === true;
      const leavingByHome = g.__leavingVideoCallByHomeRef?.current === true;
      if (leavingByBack) {
        // Флаг сбрасывает usePiP после showPiP (revealInAppPiPAfterBack). Если обнулить здесь,
        // PiPOverlay на кадре goBack() не покажет in-app PiP на VideoCall (suppress route).
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
        setAndroidSystemPiPLeaveHintEnabled(false);
      }
    };
  }, [roomId, callId, isInactiveState, partnerUserId, partnerId, localStream, remoteStream, camOn, micOn, remoteMuted, remoteCamOn, inAudioOnlyUi, route?.params, isFocused, appState, getTrackEnabled, getDesiredRemoteMutedForPiPReturn]);

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
    try {
      if (g.__incomingAcceptSentRef) g.__incomingAcceptSentRef.current = null;
    } catch {}
    // НЕ очищаем __pendingCallAcceptedRef здесь: при ремаунте (двойная навигация) новая сессия должна прочитать payload и подключиться. Очищает только VideoCallSession после использования.
    currentCallIdRef.current = null;
    setPipAudioOnlyPlaceholderSticky(false);
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
      partnerInPiPRef.current = false;
      const inSystemNow = (global as any).__pipInSystemModeRef?.current === true;
      if (inSystemNow && Platform.OS === 'android') {
        try { requestExitSystemPiPSoft(); } catch (_) {}
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

      if (typeof sessionSnapshot?.cleanup === 'function') {
        sessionSnapshot.cleanup();
      }

      try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
      try { InCallManager.setSpeakerphoneOn(false); } catch {}
      try { InCallManager.stop(); } catch {}
      pauseBackgroundMediaAfterCall();
      try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
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
        pauseBackgroundMediaAfterCall();
        try { (InCallManager as any).abandonAudioFocus?.(); } catch {}
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

    if (route?.params?.audioOnlyPiPReturn === true) {
      if (returnToken) {
        resumeFromPiPEffectRanRef.current = resumeRunKey;
      }
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
  }, [route?.params?.resume, route?.params?.fromPiP, route?.params?.audioOnlyPiPReturn, pip.localStream, pip.remoteStream, pip.localCamOn, pip.isMuted, pip.isRemoteMuted, sessionTick, getDesiredLocalMediaStateForPiPReturn, getDesiredRemoteMutedForPiPReturn, extendPiPReturnAbortGuard, getSystemPiPReturnToken, getSystemPiPReturnState, claimSystemPiPReturnOwner]);

  // Восстановление камеры после фона — только в App.tsx (__webrtcSessionRef + pause/restore).

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
    if (
      isInactiveStateRef.current ||
      isEndingCallRef.current ||
      wasFriendCallEndedRef.current ||
      deferredTeardownScheduledRef.current
    ) {
      logger.info('[VideoCall] Звонок завершается — пропускаем инициализацию/rebind сессии');
      return;
    }
    const routeCallIdForInit = route?.params?.callId ?? null;
    const routeRoomIdForInit = route?.params?.roomId ?? null;
    const initRouteKey = `${String(routeCallIdForInit || '')}|${String(routeRoomIdForInit || '')}`;
    if (sessionInitRouteKeyRef.current !== initRouteKey) {
      sessionInitRouteKeyRef.current = initRouteKey;
      callEndedTransitionDoneRef.current = false;
      deferredTeardownScheduledRef.current = null;
    }
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
    
    // Не пересоздаем сессию если она уже существует — ниже переиспользуем/rebind с актуальными callbacks.
    const existingSessionBeforeConfig = sessionRef.current;
    const pendingCallAccepted = (global as any).__pendingCallAcceptedRef?.current;
    const pendingCallId = pendingCallAccepted ? String(pendingCallAccepted?.callId || '') : null;
    const isDirectCall = !!route?.params?.directCall;
    const isDirectInitiator = !!route?.params?.directInitiator;

    const resolvedMyUserId = route?.params?.myUserId || getCurrentUserId();
    const startWithCamOff = resolveDirectCallAudioFirst(
      {
        directCall: isDirectCall,
        directInitiator: isDirectInitiator,
        callMedia: route?.params?.callMedia,
        startWithCamOff: route?.params?.startWithCamOff,
        callId: route?.params?.callId ?? pendingCallId,
      },
      pendingCallId,
    );
    const config: WebRTCSessionConfig = {
      myUserId: resolvedMyUserId,
      initialCallId: route?.params?.callId ?? pendingCallId ?? null,
      startWithCamOff,
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
              remoteStreamRef.current = stream;
              setRemoteStream(stream);
              return;
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
            if (route?.params?.directCall && stream.getAudioTracks?.()?.[0]) {
              scheduleDirectCallAudioRepinRef.current();
            }
            if (!acceptCallTimeRef.current) {
              acceptCallTimeRef.current = Date.now();
            }
            if (callConnectedAtRef.current == null && stream.getAudioTracks?.()?.length) {
              callConnectedAtRef.current = acceptCallTimeRef.current;
            }
            persistCallTimerToGlobal(acceptCallTimeRef, callConnectedAtRef);
            setFriendCallAccepted(true);
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
            const suspendedForBackground =
              session &&
              typeof (session as any).isCameraSuspendedForAppBackground === 'function' &&
              (session as any).isCameraSuspendedForAppBackground();
            const pipManager = (session as any)?.pipManager;
            if (
              !suspendedForBackground &&
              pipManager &&
              typeof pipManager.markCameraManuallyDisabled === 'function'
            ) {
              // КРИТИЧНО: Отмечаем, что пользователь сам выключил камеру
              // Это предотвратит автоматическое восстановление камеры при выходе из PiP
              pipManager.markCameraManuallyDisabled();
              logger.info('[VideoCall] Камера выключена пользователем вручную');
            }
          }
          
          if (inAudioOnlyUiRef.current && enabled) {
            return;
          }
          setCamOn(enabled);
        },
        onRemoteCamStateChange: (enabled) => {
          if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
          if (sessionRef.current?.isEnded?.()) return;
          logger.debug('[VideoCall] onRemoteCamStateChange', {
            enabled,
            partnerInPiP: partnerInPiPRef.current,
          });
          remoteCamStateKnownRef.current = true;
          if (inAudioOnlyUiRef.current) {
            syncPeerVideoInviteHint();
            return;
          }
          setRemoteCamOn(enabled);
          // ВАЖНО: Не дергаем remoteViewKey из UI.
          // Этим управляет сессия через событие remoteViewKeyChanged, иначе на Android легко получить мерцания из-за частых remount RTCView.
        },
        onRemoteCamSideChange: (side) => {
          if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
          if (sessionRef.current?.isEnded?.()) return;
          setRemoteCamSide(side);
        },
        onPeerDirectCallVideoUiChange: handlePeerDirectCallVideoUiChange,
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
        if (!uid) return t('someone', lang);
        const partner = friendsRef.current?.find((f: any) => String(f._id) === String(uid));
        const nick = (partner as any)?.nick?.trim();
        return nick || t('someone', lang);
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
        wasFriendCallEndedRef.current = true;
        partnerInPiPRef.current = false;
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
      if (roomOk) {
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
          syncCallTimerFromGlobal(acceptCallTimeRef, callConnectedAtRef);
          const { connected: globalConnected } = getGlobalCallTimerRefs();
          if (globalConnected.current != null) {
            setCallElapsedSec(Math.floor((Date.now() - globalConnected.current) / 1000));
          }
          setStarted(true);
          setLoading(false);
          if (
            !isInactiveStateRef.current &&
            !isEndingCallRef.current &&
            !wasFriendCallEndedRef.current &&
            !deferredTeardownScheduledRef.current
          ) {
            setIsInactiveState(false);
            setWasFriendCallEnded(false);
            setFriendCallAccepted(true);
          }
        } catch (e) {
          logger.warn('[VideoCall] Ошибка синхронизации UI при переиспользовании сессии', e);
        }
        try {
          if ((global as any).__pendingCallAcceptedRef) (global as any).__pendingCallAcceptedRef.current = null;
        } catch {}
      }
    }

    if (!reusedLiveSession) {
      const canRebindExisting =
        existingSessionBeforeConfig instanceof VideoCallSession &&
        typeof (existingSessionBeforeConfig as VideoCallSession).isEnded === 'function' &&
        !(existingSessionBeforeConfig as VideoCallSession).isEnded() &&
        (!effectiveCallId ||
          String((existingSessionBeforeConfig as VideoCallSession).getCallId?.() || '') === effectiveCallId);

      if (canRebindExisting) {
        session = existingSessionBeforeConfig as VideoCallSession;
        session.rebindVideoCallMount(config);
        sessionRef.current = session;
        (global as any).__webrtcSessionRef.current = session;
        setLocalCamSide(session.getCamSide?.() ?? 'front');
        setRemoteCamSide(session.getRemoteCamSide?.() ?? 'front');
        setSessionTick((t) => t + 1);
        try {
          createdSessionsRef.current.add(session as any);
        } catch {}
        logger.info('[VideoCall] ♻️ Rebound existing VideoCallSession to current screen (callbacks refresh)', {
          callId: effectiveCallId || session.getCallId?.(),
        });
      } else {
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
      }
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

      if (session.didSchedulePendingCallAcceptedConnect()) {
        logger.info('[VideoCall] Callee: call:accepted already pending in session ctor, skipping acceptCall', {
          callId: incomingCallId,
        });
        return;
      }

      const g = global as any;
      g.__incomingAcceptSentRef = g.__incomingAcceptSentRef || { current: null as string | null };
      if (g.__incomingAcceptSentRef.current === incomingCallId) {
        logger.info('[VideoCall] Callee: acceptCall already in flight for callId, skipping duplicate', {
          callId: incomingCallId,
        });
        return;
      }
      g.__incomingAcceptSentRef.current = incomingCallId;

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
  
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || typeof (session as any).updateCallbacks !== 'function') return;
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
        if (inAudioOnlyUiRef.current && enabled) {
          return;
        }
        setCamOn(enabled);
      },
      onRemoteCamStateChange: (enabled: boolean) => {
        if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
        if (sessionRef.current?.isEnded?.()) return;
        remoteCamStateKnownRef.current = true;
        if (inAudioOnlyUiRef.current) {
          syncPeerVideoInviteHint();
          return;
        }
        setRemoteCamOn(enabled);
      },
      onPeerDirectCallVideoUiChange: handlePeerDirectCallVideoUiChange,
    });
  }, [sessionTick, pip.visible, handlePeerDirectCallVideoUiChange, syncPeerVideoInviteHint]);

  // КРИТИЧНО: Отдельный useEffect для установки обработчиков событий
  useEffect(() => {
    if (!sessionHandlerAttachKey) {
      return;
    }
    const session = sessionRef.current;
    if (!session) {
      logger.debug('[VideoCall] No session for event handlers setup');
      return;
    }
    const returnToken = currentSystemPiPReturnToken;
    const returnState = currentSystemPiPReturnState;
    if (returnToken && returnState?.owner !== screenInstanceIdRef.current) {
      return;
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
      partnerInPiPRef.current = false;
      setPartnerInPiP(false);
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
      const audioFirst = resolveDirectCallAudioFirst(route?.params ?? {}, callId ?? null);
      const camFromSession = sessionRef.current?.getIsCamOn?.();
      const resolvedCamOn = audioFirst
        ? false
        : typeof camFromSession === 'boolean'
          ? camFromSession
          : true;
      setCamOn(resolvedCamOn);
      const micFromSession = sessionRef.current?.getIsMicOn?.() ?? true;
      logMicTraceRef.current('handleCallAnswered (socket) → setMicOn/setCamOn from session', {
        roomId,
        callId,
        partnerId,
        micFromSession,
        camFromSession,
        resolvedCamOn,
        audioFirst,
      });
      setMicOn(micFromSession);
      if (audioFirst) {
        inAudioOnlyUiRef.current = true;
        setInAudioOnlyUi(true);
        try {
          pinInitialAudioCallEarpieceRef.current();
          setTimeout(() => pinInitialAudioCallEarpieceRef.current(), 450);
          scheduleDirectCallAudioRepinRef.current?.();
        } catch {}
      }
      
      const currentLocalStream = sessionRef.current?.getLocalStream?.() || localStreamRef.current;
      if (currentLocalStream) {
        const videoTrack = (currentLocalStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState === 'live') {
          videoTrack.enabled = resolvedCamOn;
          try {
            sessionRef.current?.sendCameraState?.(undefined, resolvedCamOn);
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
      if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
      if (sessionRef.current?.isEnded?.()) return;
      const remoteStreamSnapshot = remoteStreamRef.current;
      logger.debug('[VideoCall] remoteState event received', {
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
    
    const handlePartnerDirectCallVideoUiChanged = (payload?: { inVideoCallUi?: boolean }) => {
      if (!isMountedRef.current) return;
      if (isInactiveStateRef.current || isEndingCallRef.current) return;
      if (inAudioOnlyUiRef.current && payload?.inVideoCallUi === false) {
        setPeerInvitedVideo(false);
      }
      syncPeerVideoInviteHint();
    };

    const handlePartnerPiPStateChanged = ({ inPiP }: { inPiP: boolean }) => {
      if (!isMountedRef.current) return;
      // КРИТИЧНО: Если звонок уже завершён — не обновляем state (никаких setState), чтобы не было ререндеров при закрытии экрана.
      if (isInactiveStateRef.current || isEndingCallRef.current) {
        partnerInPiPRef.current = false;
        return;
      }
      
      // КРИТИЧНО: Всегда обновляем состояние partnerInPiP при получении события
      const previousState = partnerInPiPRef.current;
      partnerInPiPRef.current = inPiP;
      setPartnerInPiP(inPiP);
      syncPeerVideoInviteHint();
      
      // КРИТИЧНО: Когда партнер возвращается из PiP (inPiP: false), включаем видеотрек обратно
      // Только если звонок ещё активен (проверка выше).
      if (previousState === true && inPiP === false) {
        logger.info('[VideoCall] 🔄 Партнер вернулся из PiP — синхронизируем камеру и PiP', {
          hasRemoteStream: !!remoteStream,
          currentRemoteCamOn: remoteCamOn,
          sessionRemoteStream: !!session?.getRemoteStream?.(),
          sessionRemoteCamOn: session?.getRemoteCamEnabled?.(),
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

        const camEnabled = !!session?.getRemoteCamEnabled?.();
        if (!inAudioOnlyUiRef.current) {
          setRemoteCamOn(camEnabled);
          try {
            pip.updatePiPState({ remoteCamOn: camEnabled });
          } catch (_) {}
        }
      }
    };

    const needsStreamBridge = !createdSessionsRef.current.has(session as any);
    const sessionAttachKey = sessionHandlerAttachKey;
    lastAttachedSessionKeyRef.current = sessionAttachKey;
    logger.debug('[VideoCall] Attaching session event handlers', {
      sessionAttachKey,
      needsStreamBridge,
    });

    const handleLocalStreamEvent = (stream: MediaStream | null) => {
      if (!isMountedRef.current) return;
      if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
      if (sessionRef.current?.isEnded?.()) return;
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
      if (isInactiveStateRef.current || isEndingCallRef.current || wasFriendCallEndedRef.current) return;
      if (sessionRef.current?.isEnded?.()) return;
      remoteStreamRef.current = stream as any;
      setRemoteStream(stream as any);
      if (stream) {
        remoteStreamReceivedAtRef.current = Date.now();
        if (!acceptCallTimeRef.current) {
          acceptCallTimeRef.current = Date.now();
        }
        if (callConnectedAtRef.current == null && stream.getAudioTracks?.()?.length) {
          callConnectedAtRef.current = acceptCallTimeRef.current;
        }
        setFriendCallAccepted(true);
        setIsInactiveState(false);
        setWasFriendCallEnded(false);
        setStarted(true);
        setLoading(false);
        if (route?.params?.directCall && stream.getAudioTracks?.()?.length) {
          scheduleDirectCallAudioRepinRef.current?.();
        }
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
    session.on('partnerDirectCallVideoUiChanged', handlePartnerDirectCallVideoUiChanged);
    session.on('partnerPiPStateChanged', handlePartnerPiPStateChanged);
    if (needsStreamBridge) {
      session.on('localStream', handleLocalStreamEvent as any);
      session.on('remoteStream', handleRemoteStreamEvent as any);
      logger.debug('[VideoCall] Stream bridge enabled for reused session');
    }
    
    logger.debug('[VideoCall] Event handlers attached for session', {
      hasSession: !!session,
      handlersCount: needsStreamBridge ? 8 : 6,
      needsStreamBridge,
    });
    
    return () => {
      if (lastAttachedSessionKeyRef.current !== sessionAttachKey) {
        return;
      }
      lastAttachedSessionKeyRef.current = '';
      if (session) {
        session.off('remoteViewKeyChanged', handleRemoteViewKeyChange);
        session.off('callEnded', handleCallEnded);
        session.off('callAnswered', handleCallAnswered);
        session.off('callDeclined', handleCallDeclined);
        session.off('remoteState', handleRemoteState);
        session.off('partnerDirectCallVideoUiChanged', handlePartnerDirectCallVideoUiChanged);
        session.off('partnerPiPStateChanged', handlePartnerPiPStateChanged);
        if (needsStreamBridge) {
          session.off('localStream', handleLocalStreamEvent as any);
          session.off('remoteStream', handleRemoteStreamEvent as any);
        }
      }
    };
    // IMPORTANT: handlers attach once per sessionHandlerAttachKey (not on every sessionTick).
  }, [sessionHandlerAttachKey, currentSystemPiPReturnToken, currentSystemPiPReturnState?.owner, syncPeerVideoInviteHint]);
  
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
      
      // Аудио-маршрут: useAudioRouting (earpiece по умолчанию для direct call)
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
      partnerInPiPRef.current = false;
      setPartnerInPiP(false);
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
    const effectivePartnerSocketId =
      (typeof (session as any)?.getPartnerId === 'function' ? (session as any).getPartnerId() : null) ?? partnerId;
    const effectivePartnerUserId =
      (typeof (session as any)?.getPartnerUserId === 'function' ? (session as any).getPartnerUserId() : null) ?? partnerUserId;

    logger.info('[VideoCall] [end] onAbortCall начат', {
      roomId,
      callId,
      partnerSocketId: effectivePartnerSocketId,
      partnerUserId: effectivePartnerUserId,
      source,
    });

    // КРИТИЧНО: Сразу выставляем refs завершения (до навигации и session.endCall), чтобы колбэки сессии
    // (onRemoteCamStateChange, onPartnerIdChange, onRoomIdChange, onCallIdChange, handlePartnerPiPStateChanged) не вызывали setState и не давали ререндеров.
    isInactiveStateRef.current = true;
    wasFriendCallEndedRef.current = true;
    partnerInPiPRef.current = false;
    setPartnerInPiP(false);
    setIsInactiveState(true);
    setWasFriendCallEnded(true);
    setFriendCallAccepted(false);

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

    const idToReport = callId ?? currentCallIdRef.current ?? (session as any)?.callId ?? null;
    const idToSend = callId ?? currentCallIdRef.current ?? (session as any)?.getCallId?.() ?? null;
    const roomToSend = roomId ?? (session as any)?.getRoomId?.() ?? null;
    const sessionRefForCleanup = session;
    const localStreamForCleanup = localStream;

    logger.info('[VideoCall] [end] onAbortCall: scheduling deferred cleanup');
    const teardownScheduled = scheduleDeferredTeardown({
      source: 'onAbortCall',
      callId: idToSend ?? idToReport ?? null,
      roomId: roomToSend ?? null,
      sessionSnapshot: sessionRefForCleanup,
      localStreamSnapshot: localStreamForCleanup,
      shouldReportEndCall: true,
      shouldEndSession: false,
    });

    const sessionAlreadyEnded =
      typeof session.isEnded === 'function' && session.isEnded();
    if (typeof session.endCall === 'function' && !sessionAlreadyEnded) {
      try {
        session.endCall(idToSend ?? undefined, roomToSend ?? undefined);
      } catch (e) {
        logger.warn('[VideoCall] [end] onAbortCall: session.endCall failed', e);
      }
    } else if (!teardownScheduled) {
      scheduleDeferredTeardown({
        source: 'onAbortCall-fallback',
        callId: idToSend ?? idToReport ?? null,
        roomId: roomToSend ?? null,
        sessionSnapshot: sessionRefForCleanup,
        localStreamSnapshot: localStreamForCleanup,
        shouldReportEndCall: true,
        shouldEndSession: false,
      });
    }

    // Закрываем экран видеозвонка после call:end — собеседник получает завершение до размонтирования UI.
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
  }, [isInactiveState, roomId, callId, partnerId, partnerUserId, localStream, getSystemPiPReturnGuard]);
  
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

  const syncDirectCallVideoUiSession = useCallback((session: VideoCallSession | null) => {
    if (!session) return;
    if (isInAudioOnlyCallUi()) return;
    if (inAudioOnlyUiRef.current) return;
    if (!stayOnVideoCallUiRef.current) return;
    try {
      const g = global as any;
      if (g.__preferAudioOnlyUiOnNextVideoCallRef?.current === true) return;
      const preparedAt = Number(g.__directCallAudioOnlyPreparedAtRef?.current || 0);
      if (preparedAt && Date.now() - preparedAt < 12000) return;
    } catch {}
    try {
      session.enableRemoteVideoConsumption({ leaveAudioOnlyConsumer: true });
    } catch {}
    try {
      remoteCamStateKnownRef.current = true;
      setRemoteCamOn(!!session.getRemoteCamEnabled?.());
    } catch {}
    const rs = session.getRemoteStream?.() as MediaStream | null | undefined;
    if (rs) {
      remoteStreamRef.current = rs as any;
      setRemoteStream(rs as any);
      remoteStreamReceivedAtRef.current = Date.now();
    }
    try {
      session.notifyPeerDirectCallVideoUi?.(true);
    } catch {}
  }, []);

  const toggleCam = useCallback(() => {
    const session = sessionRef.current || (global as any).__webrtcSessionRef?.current;
    if (session && typeof session.toggleCam === 'function') {
      if (!inAudioOnlyUiRef.current) {
        stayOnVideoCallUiRef.current = true;
      }
      const leavingAudioOnlyUi = inAudioOnlyUiRef.current || isInAudioOnlyCallUi();
      if (leavingAudioOnlyUi) {
        stayOnVideoCallUiRef.current = true;
        setPipAudioOnlyPlaceholderSticky(false);
        inAudioOnlyUiRef.current = false;
        try {
          (global as any).__inAudioOnlyUiRef.current = false;
          (global as any).__preferAudioOnlyUiOnNextVideoCallRef =
            (global as any).__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
          (global as any).__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        } catch {}
        setPeerInvitedVideo(false);
        setInAudioOnlyUi(false);
        try {
          session.enableRemoteVideoConsumption?.({ leaveAudioOnlyConsumer: true });
        } catch {}
        syncDirectCallVideoUiSession(session as VideoCallSession);
      }
      setCamOn((prev) => {
        const next = !prev;
        if (next) {
          setLocalRenderKey((k: number) => k + 1);
        }
        if (pip.visible) pip.updatePiPState({ localCamOn: next });
        return next;
      });
      session.toggleCam().catch((e: any) => {
        logger.warn('[VideoCall] toggleCam error:', e);
      });
    } else {
      logger.warn('[VideoCall] Session не найдена для toggleCam');
    }
  }, [pip, syncDirectCallVideoUiSession]);

  const applyAudioOnlyUiState = useCallback((session: VideoCallSession | null) => {
    stayOnVideoCallUiRef.current = false;
    userRouteRef.current = 'EARPIECE';
    speakerOnRef.current = false;
    inAudioOnlyUiRef.current = true;
    try {
      (global as any).__inAudioOnlyUiRef.current = true;
    } catch {}
    setPipAudioOnlyPlaceholderSticky(true);
    setInAudioOnlyUi(true);
    setCamOn(false);
    syncPeerVideoInviteHint();
    const peerVideo = session?.getRemoteCamEnabled?.() ?? false;
    const rs = session?.getRemoteStream?.() as MediaStream | null | undefined;
    if (rs && streamHasLiveRemoteAudio(rs)) {
      remoteStreamRef.current = rs as any;
      setRemoteStream(rs as any);
      remoteStreamReceivedAtRef.current = Date.now();
    }
    if (!acceptCallTimeRef.current && rs) {
      syncCallTimerFromGlobal(acceptCallTimeRef, callConnectedAtRef);
      if (!acceptCallTimeRef.current) {
        acceptCallTimeRef.current = Date.now();
        getGlobalCallTimerRefs().accept.current = acceptCallTimeRef.current;
      }
    }
    syncCallTimerFromGlobal(acceptCallTimeRef, callConnectedAtRef);
    const { connected: globalConnected } = getGlobalCallTimerRefs();
    if (globalConnected.current != null) {
      callConnectedAtRef.current = globalConnected.current;
      setCallElapsedSec(Math.floor((Date.now() - globalConnected.current) / 1000));
    } else if (
      callConnectedAtRef.current == null &&
      rs &&
      streamHasLiveRemoteAudio(rs)
    ) {
      const seed = acceptCallTimeRef.current > 0 ? acceptCallTimeRef.current : Date.now();
      callConnectedAtRef.current = seed;
      globalConnected.current = seed;
      setCallElapsedSec(Math.floor((Date.now() - seed) / 1000));
    }
    setFriendCallAccepted(true);
    setStarted(true);
    setLoading(false);
    setIsInactiveState(false);
    try {
      pip.updatePiPState({ localCamOn: false, remoteCamOn: peerVideo });
    } catch {}
    try {
      syncRouteNowRef.current?.();
      scheduleDirectCallAudioRepinRef.current?.();
      pinInitialAudioCallEarpieceRef.current();
      setTimeout(() => pinInitialAudioCallEarpieceRef.current(), 450);
    } catch {}
  }, [pip, syncPeerVideoInviteHint]);

  const applyVideoCallUiFromPiPExpand = useCallback((session: VideoCallSession | null) => {
    if ((global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current === true) {
      return;
    }
    if (isInAudioOnlyCallUi()) {
      return;
    }
    if (session?.getDirectCallAudioOnlyConsumerDefer?.()) {
      return;
    }
    stayOnVideoCallUiRef.current = true;
    setPipAudioOnlyPlaceholderSticky(false);
    inAudioOnlyUiRef.current = false;
    setInAudioOnlyUi(false);
    try {
      (global as any).__inAudioOnlyUiRef.current = false;
    } catch {}
    setPeerInvitedVideo(false);
    syncDirectCallVideoUiSession(session);
    setFriendCallAccepted(true);
    setStarted(true);
    setLoading(false);
    setIsInactiveState(false);
    try {
      syncRouteNowRef.current?.();
    } catch {}
    try {
      scheduleDirectCallAudioRepinRef.current?.();
    } catch {}
  }, [syncDirectCallVideoUiSession]);

  const returnToAudioCallUi = useCallback(
    async (opts?: { fromPiP?: boolean; skipNavigation?: boolean }) => {
      if (!route?.params?.directCall) return;
      const session =
        (sessionRef.current || (global as any).__webrtcSessionRef?.current) as VideoCallSession | null;
      if (!session || session.isEnded?.()) return;
      if (inAudioOnlyUiRef.current) {
        if (opts?.skipNavigation) {
          try {
            (global as any).__pipHidePiPRef?.current?.();
          } catch {}
          applyAudioOnlyUiState(session);
        }
        return;
      }

      const g = global as any;
      stayOnVideoCallUiRef.current = false;
      try {
        g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
        g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
        g.__expandToVideoCallUiFromPiPRef.current = false;
        if (g.__inAudioOnlyUiRef) g.__inAudioOnlyUiRef.current = true;
        g.__directCallAudioOnlyMountKeyRef =
          g.__directCallAudioOnlyMountKeyRef || { current: null as string | null };
        const mountKey = String(
          session?.getCallId?.() ?? route?.params?.callId ?? currentCallIdRef.current ?? '',
        );
        if (mountKey) g.__directCallAudioOnlyMountKeyRef.current = mountKey;
      } catch {}
      inAudioOnlyUiRef.current = true;
      setPipAudioOnlyPlaceholderSticky(true);
      try {
        navigation.setParams({ preferVideoCallUi: undefined } as any);
      } catch {}
      try {
        (global as any).__pipHidePiPRef?.current?.();
      } catch {}
      applyAudioOnlyUiState(session);

      const preparedRecently =
        Date.now() - Number(g.__directCallAudioOnlyPreparedAtRef?.current || 0) < 6000;
      if (!preparedRecently) {
        try {
          await session.enterDirectCallAudioOnlyMode();
        } catch (e) {
          logger.warn('[VideoCall] returnToAudioCallUi enterDirectCallAudioOnlyMode failed', e);
        }
      }
    },
    [route?.params?.directCall, applyAudioOnlyUiState, navigation],
  );

  useEffect(() => {
    const g = global as any;
    g.__returnToAudioCallRef = g.__returnToAudioCallRef || { current: null };
    g.__returnToAudioCallRef.current = returnToAudioCallUi;
    g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
    const session = (sessionRef.current || g.__webrtcSessionRef?.current) as VideoCallSession | null;
    if (
      g.__expandToVideoCallUiFromPiPRef?.current === true &&
      route?.params?.directCall &&
      !g.__preferAudioOnlyUiOnNextVideoCallRef?.current
    ) {
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef.current = false;
      g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
      applyVideoCallUiFromPiPExpand(session);
    } else if (
      route?.params?.directCall &&
      (g.__preferAudioOnlyUiOnNextVideoCallRef?.current || route?.params?.audioOnlyPiPReturn === true)
    ) {
      if (
        route?.params?.preferVideoCallUi === true &&
        route?.params?.audioOnlyPiPReturn !== true
      ) {
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        applyVideoCallUiFromPiPExpand(session);
      } else {
        g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
        g.__directCallAudioOnlyMountKeyRef =
          g.__directCallAudioOnlyMountKeyRef || { current: null as string | null };
        const mountKey = String(route?.params?.callId ?? currentCallIdRef.current ?? '');
        const alreadyHandled =
          mountKey && g.__directCallAudioOnlyMountKeyRef.current === mountKey;
        stayOnVideoCallUiRef.current = false;
        inAudioOnlyUiRef.current = true;
        try {
          if (g.__inAudioOnlyUiRef) g.__inAudioOnlyUiRef.current = true;
        } catch {}
        setPipAudioOnlyPlaceholderSticky(true);
        applyAudioOnlyUiState(session);
        const preparedRecently =
          Date.now() - Number(g.__directCallAudioOnlyPreparedAtRef?.current || 0) < 6000;
        if (!alreadyHandled && !preparedRecently && mountKey) {
          g.__directCallAudioOnlyMountKeyRef.current = mountKey;
          void (async () => {
            try {
              await session?.enterDirectCallAudioOnlyMode?.();
            } catch (e) {
              logger.warn('[VideoCall] preferAudioOnlyUi mount enterDirectCallAudioOnlyMode failed', e);
            }
          })();
        }
      }
    }
    return () => {
      if (g.__returnToAudioCallRef?.current === returnToAudioCallUi) {
        g.__returnToAudioCallRef.current = null;
      }
    };
  }, [returnToAudioCallUi, route?.params?.directCall, applyAudioOnlyUiState, applyVideoCallUiFromPiPExpand]);

  useEffect(() => {
    if (!route?.params?.directCall || !route?.params?.preferVideoCallUi) return;
    const g = global as any;
    const session = (sessionRef.current || g.__webrtcSessionRef?.current) as VideoCallSession | null;
    g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
    g.__preferAudioOnlyUiOnNextVideoCallRef.current = false;
    try {
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef.current = false;
    } catch {}
    applyVideoCallUiFromPiPExpand(session);
    try {
      navigation.setParams({ preferVideoCallUi: undefined } as any);
    } catch {}
  }, [
    route?.params?.directCall,
    route?.params?.preferVideoCallUi,
    applyVideoCallUiFromPiPExpand,
    navigation,
  ]);
  
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
    const g = global as any;
    g.__syncDirectCallAudioOnlyUiRef = g.__syncDirectCallAudioOnlyUiRef || { current: null };
    g.__syncDirectCallAudioOnlyUiRef.current = (session: VideoCallSession | null) => {
      const live =
        session ||
        ((sessionRef.current || g.__webrtcSessionRef?.current) as VideoCallSession | null);
      applyAudioOnlyUiState(live);
    };
    return () => {
      if (g.__syncDirectCallAudioOnlyUiRef?.current) {
        g.__syncDirectCallAudioOnlyUiRef.current = null;
      }
    };
  }, [applyAudioOnlyUiState]);

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
  const showAudioPresentation =
    isDirectCall &&
    !isInactiveState &&
    !wasFriendCallEnded &&
    inAudioOnlyUi;

  const pulsePeerVideoButton =
    showAudioPresentation && peerInvitedVideo;

  useEffect(() => {
    if (!isDirectCall || inAudioOnlyUiRef.current) return;
    if ((global as any).__inAudioOnlyUiRef?.current === true) return;
    if (isInAudioOnlyCallUi()) return;
    if (!stayOnVideoCallUiRef.current) return;
    if ((global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current === true) return;
    if (!friendCallAccepted) return;
    notifyPeerDirectCallVideoUi(true);
  }, [isDirectCall, inAudioOnlyUi, friendCallAccepted, sessionTick, notifyPeerDirectCallVideoUi]);

  useEffect(() => {
    syncPeerVideoInviteHint();
  }, [inAudioOnlyUi, isInactiveState, wasFriendCallEnded, sessionTick, partnerInPiP, remoteCamOn, syncPeerVideoInviteHint]);

  useEffect(() => {
    if (!pulsePeerVideoButton) {
      peerVideoPulse.stopAnimation();
      peerVideoPulse.setValue(0);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(peerVideoPulse, {
          toValue: 1,
          duration: 720,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(peerVideoPulse, {
          toValue: 0,
          duration: 720,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => {
      anim.stop();
      peerVideoPulse.setValue(0);
    };
  }, [pulsePeerVideoButton, peerVideoPulse]);

  const peerVideoPulseHaloStyle = useMemo(
    () => ({
      position: 'absolute' as const,
      width: 64,
      height: 64,
      borderRadius: 32,
      borderWidth: 2,
      borderColor: accent.solid,
      opacity: peerVideoPulse.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.75] }),
      transform: [
        { scale: peerVideoPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.14] }) },
      ],
    }),
    [accent.solid, peerVideoPulse],
  );

  const partnerDisplayName = useMemo(() => {
    if (route?.params?.partnerNick) return String(route.params.partnerNick);
    if (partnerUserId) {
      const f = friends.find((fr) => String(fr._id ?? fr.id) === String(partnerUserId));
      const name = (f?.name || f?.nick || '').trim();
      if (name) return name;
    }
    return '—';
  }, [route?.params?.partnerNick, partnerUserId, friends]);

  const remoteAudioLiveForTimer = streamHasLiveRemoteAudio(currentRemoteStream);

  const callConnectedForTimer =
    !!friendCallAccepted &&
    !wasFriendCallEnded &&
    !isEndingCall &&
    hasActiveCall &&
    remoteAudioLiveForTimer;

  useEffect(() => {
    if (wasFriendCallEnded || isEndingCall) {
      callConnectedAtRef.current = null;
      setCallElapsedSec(0);
      return;
    }
    if (!friendCallAccepted || !hasActiveCall) {
      return;
    }
    if (callConnectedAtRef.current == null && remoteAudioLiveForTimer) {
      syncCallTimerFromGlobal(acceptCallTimeRef, callConnectedAtRef);
      if (callConnectedAtRef.current == null) {
        const seed = acceptCallTimeRef.current > 0 ? acceptCallTimeRef.current : Date.now();
        callConnectedAtRef.current = seed;
        getGlobalCallTimerRefs().connected.current = seed;
      }
    }
    if (callConnectedAtRef.current == null) {
      return;
    }
    const tick = () => {
      const startedAt = callConnectedAtRef.current;
      if (startedAt == null) return;
      setCallElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [friendCallAccepted, hasActiveCall, wasFriendCallEnded, isEndingCall, remoteAudioLiveForTimer]);

  const renderCallHiddenAudioSink = useCallback(
    (opts?: { forceSystemPiP?: boolean }) => {
      if (!isDirectCall || wasFriendCallEnded || isEndingCall) return null;
      const stream = currentRemoteStream;
      if (!streamHasLiveRemoteAudio(stream)) return null;
      const systemPiP = opts?.forceSystemPiP === true;
      if (
        partnerRemoteRtcLikelyVisible({
          showAudioPresentation: systemPiP ? false : showAudioPresentation,
          remoteCamOn,
          stream,
        })
      ) {
        return null;
      }
      return <HiddenRemoteAudioSink stream={stream!} remoteMuted={remoteMuted} />;
    },
    [
      isDirectCall,
      wasFriendCallEnded,
      isEndingCall,
      currentRemoteStream,
      showAudioPresentation,
      remoteCamOn,
      remoteMuted,
    ],
  );

  const showCallDuration =
    !wasFriendCallEnded &&
    !isEndingCall &&
    (callConnectedForTimer || (friendCallAccepted && hasActiveCall && callElapsedSec > 0));

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

        const audioOnlyPiPReturn =
          route?.params?.preferVideoCallUi !== true &&
          (route?.params?.audioOnlyPiPReturn === true ||
          (global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current === true ||
          inAudioOnlyUiRef.current ||
          (global as any).__inAudioOnlyUiRef?.current === true ||
          pipInAppBarEnteredFromAudioOnly() ||
          isInAudioOnlyCallUi());

        if (audioOnlyPiPReturn) {
          try {
            navigation.setParams({ audioOnlyPiPReturn: undefined } as any);
          } catch {}
          const sessionForAudio =
            (sessionRef.current || (global as any).__webrtcSessionRef?.current) as
              | VideoCallSession
              | null;
          if (sessionForAudio) {
            stayOnVideoCallUiRef.current = false;
            applyAudioOnlyUiState(sessionForAudio);
          }
          try {
            syncRouteNow?.();
          } catch {}
          if (returnToken) {
            markSystemPiPReturnRestored(returnToken);
          }
          reenableAndroidSystemPiPLeaveHintAfterReturn();
          setTimeout(() => {
            focusEffectGuardRef.current = false;
          }, 50);
          return;
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
            if (!acceptCallTimeRef.current) {
              acceptCallTimeRef.current = Date.now();
            }
            if (callConnectedAtRef.current == null) {
              callConnectedAtRef.current = acceptCallTimeRef.current;
            }
            setFriendCallAccepted(true);
            setStarted(true);
            setLoading(false);
            setWasFriendCallEnded(false);
            setIsInactiveState(false);
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

          if (
            (global as any).__expandToVideoCallUiFromPiPRef?.current &&
            !(global as any).__preferAudioOnlyUiOnNextVideoCallRef?.current &&
            !inAudioOnlyUiRef.current &&
            (global as any).__inAudioOnlyUiRef?.current !== true
          ) {
            applyVideoCallUiFromPiPExpand(session as VideoCallSession);
            try {
              (global as any).__expandToVideoCallUiFromPiPRef.current = false;
            } catch (_) {}
          } else if ((global as any).__expandToVideoCallUiFromPiPRef?.current) {
            try {
              (global as any).__expandToVideoCallUiFromPiPRef.current = false;
            } catch (_) {}
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
        reenableAndroidSystemPiPLeaveHintAfterReturn();

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
        syncAndroidSystemPiPLeaveHintForActiveVideoCall();
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
      route?.params?.preferVideoCallUi,
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
      syncRouteNow,
      applyVideoCallUiFromPiPExpand,
    ])
  );
  
  
  // Как в WhatsApp/Telegram: в системном PiP рисуем только видео собеседника; фон прозрачный, чтобы в окне PiP не было чёрных областей.
  // При возврате из PiP (fromPiP) показываем полноэкранный вид; при повторном входе в PiP (pendingSystemPiP) — компакт, иначе захватится layout с бейджем/кнопкой.
  const homeSystemPiPPending =
    pip.pendingSystemPiP ||
    pip.systemPiPCaptureActive ||
    (global as any).__pendingSystemPiPSyncRef?.current === true;
  const systemPiPCompact =
    Platform.OS === 'android' &&
    !pip.visible &&
    !pip.systemPiPCaptureActive &&
    !route?.params?.fromPiP &&
    (homeSystemPiPPending || pip.inSystemPiPMode);
  if (systemPiPCompact) {
    return (
      <SafeAreaView style={styles.systemPiPContainer} edges={[]}>
        {renderCallHiddenAudioSink({ forceSystemPiP: true })}
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

  if (showAudioPresentation) {
    return (
      <SafeAreaView style={[styles.container, styles.audioCallContainer]} edges={Platform.OS === 'android' ? [] : undefined}>
        {renderCallHiddenAudioSink()}
        <View style={[styles.audioCallContent, androidContentInsets]}>
          <View style={styles.audioCallHeader}>
            <Text
              style={styles.audioCallName}
              numberOfLines={2}
              {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
            >
              {partnerDisplayName}
            </Text>
            <Text
              style={styles.audioCallSubtitle}
              {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
            >
              {t('audioCallStatus', lang)}
            </Text>
            {showCallDuration ? (
              <Text style={styles.audioCallTimer}>{formatCallDuration(callElapsedSec)}</Text>
            ) : null}
          </View>
          <View style={styles.audioCallHeaderSpacer} />
          <View style={styles.audioCallControls}>
            <TouchableOpacity
              style={styles.audioRoundBtn}
              onPress={cycleAudioRoute}
              activeOpacity={0.85}
            >
              <MaterialIcons
                name={audioRouteIcon}
                size={28}
                color="#FFFFFF"
              />
            </TouchableOpacity>
            <AudioCallEndButton onPress={() => onAbortCall('end_button')} />
            <View style={styles.audioVideoBtnWrap}>
              {pulsePeerVideoButton ? (
                <Animated.View style={peerVideoPulseHaloStyle} pointerEvents="none" />
              ) : null}
              <TouchableOpacity
                style={[
                  styles.audioRoundBtn,
                  pulsePeerVideoButton && {
                    borderWidth: 2,
                    borderColor: accent.solid,
                    backgroundColor: accent.solid15,
                  },
                ]}
                onPress={() => toggleCam()}
                activeOpacity={0.85}
              >
                <MaterialIcons
                  name="videocam"
                  size={28}
                  color={pulsePeerVideoButton ? accent.softText : '#FFFFFF'}
                />
              </TouchableOpacity>
            </View>
          </View>
          {pulsePeerVideoButton ? (
            <Text
              style={[styles.audioCallPeerVideoHint, { color: accent.softText }]}
              {...(Platform.OS === 'android' ? { includeFontPadding: false } : {})}
            >
              {t('peerEnabledVideo', lang)}
            </Text>
          ) : null}
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
      {renderCallHiddenAudioSink()}
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
            showReturnToAudio={isDirectCall && !inAudioOnlyUi && !isInactiveState}
            onReturnToAudio={() => {
              void returnToAudioCallUi();
            }}
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
  audioCallContainer: {
    backgroundColor: '#1B1C22',
  },
  audioCallContent: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 48,
  },
  audioCallHeader: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 56,
  },
  audioCallHeaderSpacer: {
    flex: 1,
    width: '100%',
  },
  audioCallName: {
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 38,
    color: '#FFFFFF',
    textAlign: 'center',
  },
  audioCallSubtitle: {
    marginTop: -4,
    fontSize: 14,
    lineHeight: 18,
    color: '#B0B0B0',
    textAlign: 'center',
  },
  audioCallTimer: {
    marginTop: 6,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: '#FFFFFF',
    textAlign: 'center',
  },
  audioCallControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    marginBottom: 16,
  },
  audioVideoBtnWrap: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  audioRoundBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** Как `btn_decline_round` / OutgoingCallActivity `btn_cancel` (colors.xml). */
  audioRoundBtnDanger: {
    backgroundColor: '#CC5C2F2F',
    borderWidth: 1,
    borderColor: '#E57373',
  },
  audioCallPeerVideoHint: {
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  audioRoundBtnDangerPressed: {
    backgroundColor: '#F06E3636',
    borderColor: '#FF9F9F',
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

/** Как `installPressFeedback` + `btn_decline_round` на Incoming/OutgoingCallActivity. */
const AUDIO_CALL_DECLINE_ICON = '#E57373';
const AUDIO_CALL_DECLINE_ICON_PRESSED = '#FF9F9F';

function AudioCallEndButton({ onPress }: { onPress: () => void }) {
  const scale = useRef(new Animated.Value(1)).current;
  const alpha = useRef(new Animated.Value(1)).current;
  const [surfacePressed, setSurfacePressed] = useState(false);

  const runPressAnim = useCallback(
    (pressed: boolean) => {
      setSurfacePressed(pressed);
      Animated.parallel([
        Animated.timing(scale, {
          toValue: pressed ? 0.86 : 1,
          duration: pressed ? 90 : 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(alpha, {
          toValue: pressed ? 0.78 : 1,
          duration: pressed ? 90 : 140,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
    },
    [alpha, scale],
  );

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => runPressAnim(true)}
      onPressOut={() => runPressAnim(false)}
    >
      <Animated.View
        style={[
          styles.audioRoundBtn,
          styles.audioRoundBtnDanger,
          surfacePressed && styles.audioRoundBtnDangerPressed,
          { transform: [{ scale }], opacity: alpha },
        ]}
      >
        <MaterialIcons
          name="call-end"
          size={28}
          color={surfacePressed ? AUDIO_CALL_DECLINE_ICON_PRESSED : AUDIO_CALL_DECLINE_ICON}
        />
      </Animated.View>
    </Pressable>
  );
}

export default VideoCall;
