/**
 * RandomChat - Компонент для рандомного видеочата
 * Использует компоненты: RTCView (для отображения видео), AwayPlaceholder
 * Имеет кнопки: Начать/Стоп и Далее
 * Управление медиа реализовано напрямую через TouchableOpacity
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Platform,
  Animated,
  Alert,
  PermissionsAndroid,
  AppState,
  BackHandler,
  Easing,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { CommonActions } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaStream, mediaDevices, RTCView } from '@livekit/react-native-webrtc';
import { RandomChatSession } from '../../src/webrtc/sessions/RandomChatSession';
import type { CamSide, WebRTCSessionConfig } from '../../src/webrtc/types';
import AwayPlaceholder from '../AwayPlaceholder';
import { t, defaultLang } from '../../utils/i18n';
import { useLang } from '../../store/lang';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import socket, {
  getCurrentUserId,
  emitPresenceUpdateIfChanged,
  onConnected,
} from '../../sockets/socket';
import { MaterialIcons } from '@expo/vector-icons';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import * as Device from 'expo-device';
import { useAudioRouting } from './hooks/useAudioRouting';
import { useModeration } from './hooks/useModeration';
import { shouldDeferRandomChatStopOnAppBackground } from '../../utils/activeCallSession';
import { ANDROID_SCREEN_PADDING, NETWORK_OVERLAY_DELAY_MS } from './randomChat/constants';
import { styles } from './randomChat/styles';
import { useRandomChatToast } from './randomChat/useRandomChatToast';
import { RandomChatToast } from './randomChat/RandomChatToast';
import { useRandomChatFriends } from './randomChat/useRandomChatFriends';
import { FriendRequestModal } from './randomChat/FriendRequestModal';

type Props = { 
  route?: { 
    params?: { 
      myUserId?: string; 
      returnTo?: { name: string; params?: any };
    } 
  } 
};

/** Fallback moderation copy comes from i18n (`moderationWarningFallback`). */

const RandomChat: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  const lang = useLang((s) => s.lang);
  const androidContentInsets = useMemo(() => {
    if (Platform.OS !== 'android') return null;
    // Android: делаем одинаковый базовый отступ со всех сторон + safe-area (челка/навигация)
    return {
      paddingTop: insets.top + ANDROID_SCREEN_PADDING,
      paddingBottom: insets.bottom + ANDROID_SCREEN_PADDING,
      paddingLeft: insets.left + ANDROID_SCREEN_PADDING,
      paddingRight: insets.right + ANDROID_SCREEN_PADDING,
    } as const;
  }, [insets.bottom, insets.left, insets.right, insets.top]);
  
  // Состояния
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const loadingRef = useRef(false);
  const isStoppingRef = useRef(false);
  const leavingRef = useRef(false);
  const [isNexting, setIsNexting] = useState(false);
  const isNextingRef = useRef(false); // КРИТИЧНО: Ref для синхронной проверки состояния
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(null);
  const partnerUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    partnerUserIdRef.current = partnerUserId;
  }, [partnerUserId]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteCamEnabled, setRemoteCamEnabled] = useState(false);
  const [remoteCamSide, setRemoteCamSide] = useState<CamSide>('front');
  // Once we have rendered remote video at least once, we should never show a spinner again for camera on/off.
  const hasEverRemoteVideoRef = useRef(false);
  // Full-screen network overlay (black screen with icon) for network-origin video failures.
  const [networkOverlayVisible, setNetworkOverlayVisible] = useState(false);
  const networkOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // On Android we must not show "Отошел" because of transient track/stream churn.
  // Show it ONLY after we got an explicit remote cam state change event.
  const remoteCamStateKnownRef = useRef(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
  const [localCamSide, setLocalCamSide] = useState<CamSide>('front');
  // Keep last good remote stream to keep RTCView mounted (do not break the video pipeline).
  const lastGoodRemoteStreamRef = useRef<MediaStream | null>(null);
  const lastGoodRemoteStreamAtRef = useRef<number>(0);
  const localStreamIdRef = useRef<string | null>(null);
  const prevCamOnRef = useRef<boolean | null>(null);
  // КРИТИЧНО для iOS: Timestamp для принудительного обновления RTCView
  const localStreamTimestampRef = useRef<number>(0);
  // КРИТИЧНО для iOS: Флаг что был вызван next(), нужно обновить key при следующем localStream
  const needsIOSUpdateAfterNextRef = useRef<boolean>(false);
  // КРИТИЧНО: Защита от слишком частых обновлений localRenderKey (предотвращает мерцание)
  // На iOS обновления могут быть чаще из-за особенностей RTCView, но все равно ограничиваем
  const lastLocalRenderKeyUpdateRef = useRef<number>(0);
  const MIN_LOCAL_RENDER_KEY_UPDATE_INTERVAL_MS = Platform.OS === 'ios' ? 150 : 100; // Минимальный интервал между обновлениями key (iOS требует больше времени)
  // Эквалайзер отключен
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(0));
  const shownSimulatorCameraHintRef = useRef(false);
  
  // Синхронизируем состояние неактивности с глобальным ref для App.tsx
  useEffect(() => {
    // КРИТИЧНО: Для стратегии A считаем RandomChat "неактивным", когда:
    // - поиск/сессия не запущены (started=false), ИЛИ
    // - сессия завершена и экран в неактивном состоянии (isInactiveState=true)
    // Тогда входящий должен идти через ГЛОБАЛЬНУЮ full-screen модалку (App.tsx) с рингтоном/вибрацией.
    (global as any).__isInactiveStateRef = { current: (!started || isInactiveState) };
    return () => {
      (global as any).__isInactiveStateRef = { current: false };
    };
  }, [isInactiveState, started]);

  // iOS Simulator: camera capture for WebRTC may be unavailable unless Simulator camera input is configured.
  // Show a one-time hint to avoid confusion when local video is black/missing.
  useEffect(() => {
    if (shownSimulatorCameraHintRef.current) return;
    if (Platform.OS !== 'ios') return;
    if (Device.isDevice) return;
    shownSimulatorCameraHintRef.current = true;
    Alert.alert(
      t('iosSimulatorCameraTitle', lang),
      t('iosSimulatorCameraMsg', lang)
    );
  }, []);
  
  const moderationEnabled = String(process.env.EXPO_PUBLIC_RANDOM_CHAT_MODERATION || '0') === '1';
  const remoteModerationTargetRef = useRef<View | null>(null);
  const [banByModerationUntil, setBanByModerationUntil] = useState(0);
  const myUserId = useMemo(() => {
    const routeUserId = String(route?.params?.myUserId ?? '').trim();
    if (routeUserId) return routeUserId;
    const socketUserId = String(getCurrentUserId?.() ?? '').trim();
    return socketUserId || undefined;
  }, [route?.params?.myUserId]);

  // Session (sessionKey пересоздаёт сессию после forceStopRandomChat, чтобы кнопка «Начать» работала)
  const sessionRef = useRef<RandomChatSession | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  // Сброс удаленного состояния при смене партнера
  useEffect(() => {
    if (!partnerId) {
      remoteStreamRef.current = null;
      setRemoteStream(null);
      remoteCamStateKnownRef.current = false;
      setRemoteCamEnabled(false);
      // During "Next"/search transitions keep the lastGoodRemoteStream mounted (covered by loader overlay)
      // to avoid Android RTCView black flickers caused by unmount/remount.
      const isTransition = loadingRef.current || isNextingRef.current;
      if (!isTransition) {
        lastGoodRemoteStreamRef.current = null;
        lastGoodRemoteStreamAtRef.current = 0;
        setRemoteViewKey((k) => k + 1);
      }
    }
  }, [partnerId]);

  // Заглушка «Отошёл» у партнёра в рандоме ведётся по socket `cam-toggle` из RandomChatSession.toggleCam (мгновенно, до LiveKit).

  const L = useCallback((key: string) => t(key, lang), [lang]);
  const { toastVisible, toastText, toastModerationStyle, toastOpacity, showToast } = useRandomChatToast();
  const {
    friends,
    addPending,
    addBlocked,
    setAddPending,
    setAddBlocked,
    friendModalVisible,
    setFriendModalVisible,
    setIncomingFriendNick,
    friendRequestDisplayName,
    onAddFriend,
    acceptFriend,
    declineFriend,
    isPartnerFriend,
  } = useRandomChatFriends({
    partnerUserId,
    partnerUserIdRef,
    lang,
    showToast,
    L,
  });

  const isModerationBanned = banByModerationUntil > Date.now();

  const showWarning = useCallback((message: string) => {
    showToast(message, 4000, true);
  }, [showToast]);

  /**
   * untilMs — момент разблокировки (Unix ms).
   * fromServer: true — не продлеваем бан при повторных moderation:banned (берём более раннее until).
   */
  const applyModerationBanUntil = useCallback(
    (untilMs: number, message: string, fromServer: boolean) => {
      setBanByModerationUntil((prev) => {
        if (fromServer && prev > Date.now() && untilMs > prev) return prev;
        return untilMs;
      });
      showToast(message, 4000, true);
      if (startedRef.current) {
        try {
          sessionRef.current?.stopRandomChat();
        } catch (e) {
          logger.warn('[RandomChat] Failed to stop session after moderation ban', e);
        }
        startedRef.current = false;
        loadingRef.current = false;
        isNextingRef.current = false;
        setStarted(false);
        setLoading(false);
        setIsNexting(false);
        setIsInactiveState(true);
      }
    },
    [showToast]
  );

  const banUser = useCallback(
    (seconds: number, message: string) => {
      applyModerationBanUntil(Date.now() + seconds * 1000, message, false);
    },
    [applyModerationBanUntil]
  );

  // Снятие UI-бана ровно к моменту until (синхронно с сервером при переданном bannedUntil)
  useEffect(() => {
    if (!banByModerationUntil || banByModerationUntil <= Date.now()) return;
    const delay = Math.max(0, banByModerationUntil - Date.now()) + 300;
    const t = setTimeout(() => {
      setBanByModerationUntil((p) => (p <= Date.now() ? 0 : p));
    }, delay);
    return () => clearTimeout(t);
  }, [banByModerationUntil]);
  
  // Инициализация session
  useEffect(() => {
    const config: WebRTCSessionConfig = {
      myUserId,
      isSimulator: Platform.OS === 'ios' && !(Device as any)?.isDevice,
      callbacks: {
        onLocalStreamChange: (stream) => {
          setLocalStream(stream);
          if (stream) {
            const videoTrack = stream.getVideoTracks()?.[0];
            const audioTrack = stream.getAudioTracks()?.[0];
            // КРИТИЧНО: Обновляем camOn на основе состояния видео трека
            // Если трек есть и enabled, камера включена
            const videoEnabled = videoTrack?.enabled ?? false;
            const hasVideoTrack = !!videoTrack;
            // КРИТИЧНО: Если есть видео трек, обновляем camOn
            // Это гарантирует что UI обновится при включении камеры
            if (hasVideoTrack) {
              setCamOn(videoEnabled);
            }
            // КРИТИЧНО: Не привязываем micOn к audioTrack.enabled — LiveKit mute/unmute
            // не всегда синхронизирует это поле, и оно может "перезатирать" UI после toggleMic.
            // micOn управляется через onMicStateChange из сессии.
            if (!audioTrack) {
              setMicOn(false);
            }
            logger.debug('[RandomChat] Local stream changed', {
              hasStream: !!stream,
              hasVideoTrack,
              videoEnabled,
              videoTracksCount: stream.getVideoTracks().length,
              streamId: stream.id,
            });
          } else {
            // КРИТИЧНО: Если stream null, камера выключена
            setCamOn(false);
          }
        },
        onRemoteStreamChange: (stream) => {
          setRemoteStream(stream);
        },
        onPartnerIdChange: (id) => {
          setPartnerId(id);
          // КРИТИЧНО: Сбрасываем partnerUserId при сбросе partnerId, чтобы скрыть кнопку "Добавить в друзья"
          if (!id) {
            setPartnerUserId(null);
            setRemoteCamSide('front');
          }
        },
        onRoomIdChange: (id) => {
          setRoomId(id);
        },
        onMicStateChange: (enabled) => {
          setMicOn(enabled);
        },
        onCamStateChange: (enabled) => {
          setCamOn(enabled);
          // КРИТИЧНО: Обновляем localRenderKey при изменении состояния камеры
          // Это гарантирует немедленное обновление видео при включении/выключении камеры
          if (Platform.OS === 'ios') {
            const now = Date.now();
            if (now - lastLocalRenderKeyUpdateRef.current >= MIN_LOCAL_RENDER_KEY_UPDATE_INTERVAL_MS) {
              setLocalRenderKey(k => k + 1);
              localStreamTimestampRef.current = now;
              lastLocalRenderKeyUpdateRef.current = now;
              logger.debug('[RandomChat] Updated localRenderKey on cam state change', { enabled });
            }
          } else {
            // На Android тоже обновляем key для надежности
            const now = Date.now();
            if (now - lastLocalRenderKeyUpdateRef.current >= MIN_LOCAL_RENDER_KEY_UPDATE_INTERVAL_MS) {
              setLocalRenderKey(k => k + 1);
              lastLocalRenderKeyUpdateRef.current = now;
              logger.debug('[RandomChat] Updated localRenderKey on cam state change', { enabled });
            }
          }
        },
        onRemoteCamStateChange: (enabled) => {
          // КРИТИЧНО: Сохраняем состояние камеры партнера для правильного отображения заглушки
          remoteCamStateKnownRef.current = true;
          setRemoteCamEnabled(enabled);
          // ВАЖНО: Не дергаем remoteViewKey из UI.
          // Сессия сама эмитит remoteViewKeyChanged при необходимости — иначе на Android легко получить мерцания из-за remount RTCView.
          logger.debug('[RandomChat] Remote camera state changed', { enabled });
        },
        onRemoteCamSideChange: (side) => {
          setRemoteCamSide(side);
        },
        onLoadingChange: (loading) => {
          setLoading(loading);
        },
      },
      getStarted: () => startedRef.current,
      setStarted: (value) => {
        startedRef.current = value;
        setStarted(value);
      },
      getIsInactiveState: () => isInactiveState,
      setIsInactiveState: (value) => setIsInactiveState(value),
    };
    
    const session = new RandomChatSession(config);
    sessionRef.current = session;
    setLocalCamSide(session.getCamSide?.() ?? 'front');
    setRemoteCamSide(session.getRemoteCamSide?.() ?? 'front');
    
    // Подписки на события
    session.on('localStream', (stream) => {
      // КРИТИЧНО: Сохраняем предыдущий стрим в ref для предотвращения мерцания
      // Если новый стрим null/невалидный, но предыдущий валидный - используем предыдущий
      const prevStream = localStreamRef.current || localStream;
      const isTransition = isNextingRef.current || loadingRef.current;
      const prevStreamExists = !!prevStream;
      const prevStreamValid = prevStreamExists && isValidStream(prevStream);
      const prevStreamId = prevStream?.id;
      const newStreamId = stream?.id;
      const isNewStreamInstance = prevStreamId !== newStreamId;
      
      // КРИТИЧНО для iOS: Проверяем изменение streamURL для принудительного обновления
      const prevStreamURL = prevStream?.toURL?.() || null;
      const newStreamURL = stream?.toURL?.() || null;
      const streamURLChanged = prevStreamURL !== newStreamURL && prevStreamURL !== null && newStreamURL !== null;
      
      // КРИТИЧНО: При next() не сбрасываем localStream сразу - это вызывает черный экран
      // Сохраняем предыдущий стрим до получения нового валидного стрима
      if (stream && isValidStream(stream)) {
        // Новый стрим валидный - обновляем ref и state
        localStreamRef.current = stream;
        setLocalStream(stream);
        
        // КРИТИЧНО для iOS: Обновляем key при любых изменениях streamId, streamURL или после next()
        if (Platform.OS === 'ios') {
          const now = Date.now();
          // Обновляем если: новый streamId, изменился streamURL, был вызван next(), или прошло достаточно времени
          const shouldUpdate = isNewStreamInstance || streamURLChanged || needsIOSUpdateAfterNextRef.current;
          const canUpdate = now - lastLocalRenderKeyUpdateRef.current >= MIN_LOCAL_RENDER_KEY_UPDATE_INTERVAL_MS;
          
          if (shouldUpdate && (canUpdate || needsIOSUpdateAfterNextRef.current)) {
            setLocalRenderKey(k => k + 1);
            localStreamTimestampRef.current = now;
            lastLocalRenderKeyUpdateRef.current = now;
            needsIOSUpdateAfterNextRef.current = false;
            logger.debug('[RandomChat] iOS: Updated localRenderKey', {
              reason: needsIOSUpdateAfterNextRef.current ? 'next()' : (isNewStreamInstance ? 'newStreamId' : 'streamURLChanged'),
              streamId: stream.id,
              streamURL: newStreamURL?.substring(0, 30) + '...',
            });
          }
        }
      } else if (stream === null) {
        // КРИТИЧНО: При явном null проверяем, не идет ли процесс next()
        // Если идет next(), сохраняем предыдущий стрим чтобы не было черного экрана
        if (isTransition && prevStreamExists) {
          // Идет next()/поиск и есть предыдущий стрим — держим его, даже если он уже "ended".
          // Так RTCView не размонтируется и визуальное мерцание "Вы" сильно уменьшается.
          localStreamRef.current = prevStream!;
          // НЕ обновляем state на null, чтобы не было черного экрана
          logger.debug('[RandomChat] Keeping previous localStream during next() to prevent flicker', {
            prevStreamId,
            prevStreamValid,
            isNexting: isNextingRef.current,
            loading: loadingRef.current,
          });
        } else {
          // Не идет next() или нет предыдущего стрима - обновляем на null
          localStreamRef.current = null;
          setLocalStream(null);
        }
      } else if (!stream || !isValidStream(stream)) {
        // Новый стрим невалидный - сохраняем предыдущий в ref если он валидный
        if (isTransition && prevStreamExists) {
          localStreamRef.current = prevStream!;
          // НЕ обновляем state, чтобы не было черного экрана
          logger.debug('[RandomChat] Keeping previous localStream to prevent flicker', {
            prevStreamId,
            newStreamValid: false,
            hasPrevStream: !!prevStream,
            isNexting: isNextingRef.current,
            loading: loadingRef.current,
          });
        } else if (prevStreamValid) {
          localStreamRef.current = prevStream!;
          logger.debug('[RandomChat] Keeping previous localStream (valid) to prevent flicker', {
            prevStreamId,
            newStreamValid: false,
            hasPrevStream: !!prevStream,
            isNexting: isNextingRef.current,
            loading: loadingRef.current,
          });
        } else {
          // Предыдущий стрим тоже невалидный - обновляем state
          localStreamRef.current = stream;
          setLocalStream(stream);
        }
      }
    });
    
    session.on('remoteStream', (stream) => {
      remoteStreamRef.current = stream || null;

      if (stream) {
        setRemoteStream(stream);
        setRemoteMuted(false);
        setIsInactiveState(false);
        setLoading(false);
        loadingRef.current = false;
        // Keep last good for overlay/RTCView stability
        lastGoodRemoteStreamRef.current = stream;
        lastGoodRemoteStreamAtRef.current = Date.now();
        hasEverRemoteVideoRef.current = true;
      } else {
        // During "Next"/search transitions we intentionally keep the lastGoodRemoteStream mounted
        // (covered by the loader overlay) to avoid RTCView remount black flickers on Android.
        setRemoteStream(null);
        setRemoteMuted(false);
        remoteCamStateKnownRef.current = false;
        setRemoteCamEnabled(false);
      }
    });
    
    session.on('remoteViewKeyChanged', (key) => {
      setRemoteViewKey(key);
    });
    
    // Подписка на событие remoteState для обновления remoteMuted
    session.on('remoteState', ({ muted }) => {
      if (muted !== undefined) {
        setRemoteMuted(muted);
      }
    });
    
    session.on('remoteStreamRemoved', () => {
      remoteStreamRef.current = null;
      setRemoteStream(null);
      setRemoteMuted(false);
      remoteCamStateKnownRef.current = false;
      setRemoteCamEnabled(false);
    });
    
    session.on('searching', () => {
      setLoading(true);
      loadingRef.current = true;
      setIsInactiveState(false);
      setNetworkOverlayVisible(false);
      hasEverRemoteVideoRef.current = false;
      // КРИТИЧНО: при уходе партнёра (peer:left) не показывать его камеру — очищаем lastGood stream
      lastGoodRemoteStreamRef.current = null;
      lastGoodRemoteStreamAtRef.current = 0;
      setRemoteViewKey((k) => k + 1);
      // КРИТИЧНО: во время поиска партнёра UI не должен показывать кнопку "Добавить в друзья"
      // и не должен держать stale partnerUserId от предыдущего собеседника.
      setPartnerUserId(null);
      setAddPending(false);
      setAddBlocked(false);
    });
    
    session.on('disconnected', () => {
      if (leavingRef.current || !startedRef.current) {
        return;
      }
      setNetworkOverlayVisible(false);
      
      // UI-очистка
      setPartnerUserId(null);
      
      // Для рандомного чата автопоиск запускается внутри session
      // Здесь только UI-обновление
    });
    
    session.on('matchFound', ({ partnerId: matchPartnerId, roomId: matchRoomId, userId }) => {
      // Обработка match_found
      if (matchPartnerId) {
        setPartnerId(matchPartnerId);
      }
      if (matchRoomId) {
        setRoomId(matchRoomId);
      }
      if (userId) {
        setPartnerUserId(userId);
      }
      
      // КРИТИЧНО: Сбрасываем loading когда партнер найден (соединение устанавливается)
      setLoading(false);
      loadingRef.current = false;
      setIsInactiveState(false);
      
      // УПРОЩЕНО: Для iOS обновляем key при matchFound (подключение к новой комнате)
      // Флаг needsIOSUpdateAfterNextRef уже установлен при next(), обновление произойдет при следующем localStream
    });
    
    return () => {
      const activeSession = sessionRef.current;
      if (activeSession) {
        activeSession.cleanup();
        sessionRef.current = null;
      }
    };
  }, [myUserId, sessionKey]);

  // Network overlay heuristic:
  // If we had remote video before, remote cam is ON, but video is not renderable for a long time,
  // treat it as a network-origin failure and show a full-screen overlay.
  const remoteStreamForUi = remoteStream || remoteStreamRef.current || lastGoodRemoteStreamRef.current;
  const remoteTrackForUi = (remoteStreamForUi as any)?.getVideoTracks?.()?.[0];
  const remoteVideoRenderableForUi =
    !!remoteTrackForUi &&
    remoteTrackForUi.readyState === 'live' &&
    remoteTrackForUi.enabled !== false &&
    remoteTrackForUi.muted !== true;

  useEffect(() => {
    // mark ever-rendered
    if (remoteVideoRenderableForUi) {
      hasEverRemoteVideoRef.current = true;
    }

    const hasEverNow = hasEverRemoteVideoRef.current || remoteVideoRenderableForUi;
    const remoteCamKnown = remoteCamStateKnownRef.current;

    const shouldShowNetwork =
      started &&
      !loading &&
      hasEverNow &&
      remoteCamKnown &&
      remoteCamEnabled === true &&
      !remoteVideoRenderableForUi;

    if (!shouldShowNetwork) {
      if (networkOverlayTimerRef.current) {
        clearTimeout(networkOverlayTimerRef.current);
        networkOverlayTimerRef.current = null;
      }
      if (networkOverlayVisible) setNetworkOverlayVisible(false);
      return;
    }

    if (!networkOverlayTimerRef.current) {
      networkOverlayTimerRef.current = setTimeout(() => {
        setNetworkOverlayVisible(true);
        networkOverlayTimerRef.current = null;
      }, NETWORK_OVERLAY_DELAY_MS);
    }

    return () => {
      if (networkOverlayTimerRef.current) {
        clearTimeout(networkOverlayTimerRef.current);
        networkOverlayTimerRef.current = null;
      }
    };
  }, [
    started,
    loading,
    remoteCamEnabled,
    remoteStream,
    remoteViewKey,
    remoteVideoRenderableForUi,
    networkOverlayVisible,
  ]);
  
  // Обработка разрешений
  const requestPermissions = useCallback(async () => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        ]);
        return (
          granted['android.permission.CAMERA'] === PermissionsAndroid.RESULTS.GRANTED &&
          granted['android.permission.RECORD_AUDIO'] === PermissionsAndroid.RESULTS.GRANTED
        );
      } catch (err) {
        return false;
      }
    }
    return true; // iOS разрешения запрашиваются автоматически
  }, []);
  
  // Обработчики
  const onStartStop = useCallback(async () => {
    if (!canRunAction()) return;
    if (!startedRef.current && isModerationBanned) {
      showToast(t('moderationBannedSelf', lang), 4000, true);
      return;
    }
    const session = sessionRef.current;
    if (!session) return;
    
    // КРИТИЧНО: ЗАЩИТА ОТ ДВОЙНЫХ НАЖАТИЙ - блокируем кнопку если уже идет процесс
    // Это критично для работы с большим количеством пользователей
    // ВАЖНО: Stop должен работать даже во время поиска (loading=true),
    // иначе UI может "залипнуть" в поиске и пользователь не сможет остановить рандом-чат.
    if (isStoppingRef.current) return;
    
    if (startedRef.current) {
      // STOP
      isStoppingRef.current = true;
      startedRef.current = false;
      setStarted(false);
      setLoading(false);
      loadingRef.current = false;
      // Эквалайзер отключен
      setRemoteMuted(false);
      // КРИТИЧНО: Сбрасываем флаг isNexting при остановке
      isNextingRef.current = false;
      setIsNexting(false);
      
      try {
        stopSpeaker(); // Останавливаем спикер
        session.stopRandomChat();
        // КРИТИЧНО: Очищаем ref при остановке для предотвращения использования старого стрима
        localStreamRef.current = null;
        setLocalRenderKey(k => k + 1);
        localStreamTimestampRef.current = 0;
        needsIOSUpdateAfterNextRef.current = false;
        setPartnerUserId(null);
      } catch (e) {
        logger.error('[RandomChat] Error stopping:', e);
      } finally {
        // ОПТИМИЗИРОВАНО: Уменьшено с 500ms до 300ms для быстрого повторного запуска
        setTimeout(() => {
          isStoppingRef.current = false;
        }, 300);
      }
    } else {
      // START
      if (loadingRef.current) return;
      
      const ok = await requestPermissions();
      if (!ok) {
        Alert.alert(t('permissionsTitle', lang), t('noCameraMicAccess', lang));
        return;
      }
      
      try {
        loadingRef.current = true;
        setLoading(true);
        await session.startRandomChat();
        startedRef.current = true;
        setStarted(true);
      } catch (e) {
        logger.error('[RandomChat] Error starting:', e);
        startedRef.current = false;
        setStarted(false);
        setLoading(false);
        setCamOn(false);
        Alert.alert(t('errorTitle', lang), t('startCameraMicFailed', lang));
      } finally {
        loadingRef.current = false;
      }
    }
  }, [requestPermissions, isModerationBanned, showToast, lang]);
  
  // Дополнительная защита от спама кнопок: минимальный интервал между действиями
  const lastActionRef = useRef<number>(0);
  const actionCooldownMs = 250;
  const canRunAction = useCallback(() => {
    const now = Date.now();
    if (now - lastActionRef.current < actionCooldownMs) {
      return false;
    }
    lastActionRef.current = now;
    return true;
  }, []);
  
  const onNext = useCallback(async () => {
    // УПРОЩЕНО: Объединенные проверки для максимальной производительности
    // КРИТИЧНО: Защита от нажатий во время подключения/отключения
    
    // 1. Cooldown и базовые проверки
    if (!canRunAction() || isNextingRef.current || isNexting || !started || loading || isStoppingRef.current || isInactiveState) {
      return;
    }
    
    // 2. Проверка сессии
    const session = sessionRef.current;
    // КРИТИЧНО: Не блокируем кнопку "Далее" по внутренним флагам сессии.
    // Эти флаги могут залипнуть при сетевых/LiveKit проблемах и полностью "убивать" next().
    // Дебаунс и защита от спама уже есть в UI (isNextingRef + canRunAction) и в самой сессии (NEXT_DEBOUNCE_MS).
    if (!session) {
      return;
    }
    
    // 3. КРИТИЧНО: Проверка состояния подключения комнаты
    // Защита от нажатий во время подключения к LiveKit
    const room = (session as any).room;
    if (room && (room.state === 'connecting' || room.state === 'reconnecting')) {
      logger.debug('[RandomChat] onNext: room is connecting/reconnecting, ignoring');
      return;
    }

      const prevPartnerUserId = partnerUserId;
      const prevAddPending = addPending;
      const prevAddBlocked = addBlocked;
      const prevRemoteCamKnown = remoteCamStateKnownRef.current;
      const prevRemoteCamEnabled = remoteCamEnabled;
      const prevHasEverRemoteVideo = hasEverRemoteVideoRef.current;
      const restoreUiAfterRejectedNext = () => {
        loadingRef.current = false;
        setLoading(false);
        remoteCamStateKnownRef.current = prevRemoteCamKnown;
        setRemoteCamEnabled(prevRemoteCamEnabled);
        hasEverRemoteVideoRef.current = prevHasEverRemoteVideo;
        setPartnerUserId(prevPartnerUserId);
        setAddPending(prevAddPending);
        setAddBlocked(prevAddBlocked);
      };

      // Устанавливаем флаги ДО начала операции
      isNextingRef.current = true;
      setIsNexting(true);
      // Prevent "Отошел" flicker between unsubscribes and the 'searching' event.
      loadingRef.current = true;
      setLoading(true);
      remoteCamStateKnownRef.current = false;
      setRemoteCamEnabled(false);
      hasEverRemoteVideoRef.current = false;
      // КРИТИЧНО: Сразу очищаем UI партнёра, чтобы не оставалась кнопка "Добавить в друзья" во время поиска
      setPartnerUserId(null);
      setAddPending(false);
      setAddBlocked(false);
      
      // Для iOS: устанавливаем флаг для обновления key при следующем localStream
      if (Platform.OS === 'ios') {
        needsIOSUpdateAfterNextRef.current = true;
      }

      let nextStarted = false;
      try {
        // Вызываем next() в сессии
        nextStarted = await session.next();
        if (!nextStarted) {
          logger.info('[RandomChat] Next request rejected before transition start', {
            started,
            loading: loadingRef.current,
            isNexting: isNextingRef.current,
            roomState: room?.state ?? 'none',
          });
          restoreUiAfterRejectedNext();
          return;
        }
        logger.info('[RandomChat] Next transition started', {
          roomState: room?.state ?? 'none',
        });
        
        // КРИТИЧНО для iOS: Устанавливаем флаг для обновления key при следующем localStream
        // НЕ обновляем key здесь, чтобы избежать конфликтов с обработчиком localStream
        if (Platform.OS === 'ios') {
          needsIOSUpdateAfterNextRef.current = true;
        }
    } catch (e: any) {
      if (!nextStarted) {
        restoreUiAfterRejectedNext();
      }
      // КРИТИЧНО: Улучшенная обработка ошибок для предотвращения крашей на Android
      const errorMsg = e?.message || String(e || '');
      logger.error('[RandomChat] Error next:', {
        error: errorMsg,
        errorName: e?.name,
        // Не логируем полный объект ошибки - это может вызвать проблемы на Android
      });
      
      // КРИТИЧНО: Показываем Alert только если это не критическая ошибка
      // Критические ошибки (например, краши) не должны показывать Alert
      try {
        if (!errorMsg.includes('crash') && !errorMsg.includes('fatal')) {
          Alert.alert(t('errorTitle', lang), t('nextFailed', lang));
        }
      } catch (alertError) {
        // Игнорируем ошибки показа Alert - это не критично
        logger.debug('[RandomChat] Error showing alert', alertError);
      }
    } finally {
      // КРИТИЧНО: Увеличено время блокировки до 1500ms для гарантии полного отключения комнаты
      // Это предотвращает спам нажатий и гарантирует корректное отключение перед новым подключением
      // Время синхронизировано с NEXT_DEBOUNCE_MS в RandomChatSession
      setTimeout(() => {
        isNextingRef.current = false;
        setIsNexting(false);
      }, nextStarted ? 1500 : 0);
    }
  }, [isNexting, started, loading, isInactiveState, canRunAction]);
  
  // Функция для переключения динамика собеседника
  const toggleRemoteAudio = useCallback(() => {
    if (!canRunAction()) return;
    // Защита от двойных нажатий
    if (toggleRemoteAudioRef.current) return;
    toggleRemoteAudioRef.current = true;
    
    const session = sessionRef.current;
    if (!session) {
      console.warn('[toggleRemoteAudio] Session not initialized yet');
      toggleRemoteAudioRef.current = false;
      return;
    }
    
    try {
      session.toggleRemoteAudio();
    } catch (e) {
      logger.error('[RandomChat] Error toggling remote audio:', e);
    } finally {
      setTimeout(() => {
        toggleRemoteAudioRef.current = false;
      }, 300);
    }
  }, [canRunAction]);
  
  // КРИТИЧНО: ЗАЩИТА ОТ ДВОЙНЫХ НАЖАТИЙ для всех кнопок управления
  const toggleMicRef = useRef(false);
  const toggleCamRef = useRef(false);
  const toggleRemoteAudioRef = useRef(false);
  
  const toggleMic = useCallback(() => {
    if (isModerationBanned) return;
    // Защита от двойных нажатий
    if (toggleMicRef.current) return;
    toggleMicRef.current = true;
    
    try {
      sessionRef.current?.toggleMic();
    } finally {
      setTimeout(() => {
        toggleMicRef.current = false;
      }, 300);
    }
  }, [isModerationBanned]);
  
  const toggleCam = useCallback(() => {
    // Защита от двойных нажатий
    if (toggleCamRef.current) return;
    toggleCamRef.current = true;
    
    try {
      // КРИТИЧНО: toggleCam теперь асинхронный, но не ждем его завершения
      // чтобы не блокировать UI
      sessionRef.current?.toggleCam().catch((e) => {
        logger.warn('[RandomChat] Error toggling camera', e);
      });
    } finally {
      setTimeout(() => {
        toggleCamRef.current = false;
      }, 400); // чуть больше, чтобы игнорировать даблтап/спам
    }
  }, [canRunAction]);
  
  const handleFlipCamera = useCallback(async () => {
    if (!sessionRef.current || !canRunAction()) return;
    if (!camOn) return; // Кнопка должна быть disabled, но на всякий случай проверяем
    
    try {
      await sessionRef.current.flipCam();
      const side = sessionRef.current.getCamSide?.();
      if (side === 'front' || side === 'back') {
        setLocalCamSide(side);
      }
      // КРИТИЧНО: Force local RTCView refresh after flip (sometimes streamId stays the same)
      // Переворот камеры - критическое обновление, поэтому обновляем сразу, даже если интервал не прошел
      const now = Date.now();
      setLocalRenderKey((k) => k + 1);
      lastLocalRenderKeyUpdateRef.current = now;
      if (Platform.OS === 'ios') {
        localStreamTimestampRef.current = now;
      }
      logger.debug('[RandomChat] Camera flipped, localRenderKey updated', {
        newKey: localRenderKey + 1,
        timestamp: now,
      });
    } catch (e) {
      logger.warn('[RandomChat] Error flipping camera', e);
    }
  }, [canRunAction, camOn, localRenderKey]);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  
  // КРИТИЧНО: Обновляем localRenderKey только при реальном изменении localStream (streamId) или camOn
  // Это предотвращает мерцание при next() - когда localStream остается тем же объектом
  // КРИТИЧНО: На iOS дополнительно проверяем изменение streamURL для принудительного обновления
  const prevStreamURLRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (started && !isInactiveState && localStream) {
      // Android: во время Next/поиска не ремоунтим RTCView через localRenderKey —
      // иначе получаем визуальные "вспышки" в блоке "Вы".
      if (Platform.OS === 'android' && (isNextingRef.current || loadingRef.current)) {
        // Но refs всё равно обновляем, чтобы после перехода логика была корректной.
        localStreamIdRef.current = localStream.id;
        prevCamOnRef.current = camOn;
        prevStreamURLRef.current = localStream.toURL?.() || null;
        return;
      }
      const currentStreamId = localStream.id;
      const prevStreamId = localStreamIdRef.current;
      const prevCamOn = prevCamOnRef.current;
      const currentStreamURL = localStream.toURL?.() || null;
      const prevStreamURL = prevStreamURLRef.current;
      
      // Обновляем localRenderKey только если:
      // 1. streamId изменился (новый стрим)
      // 2. camOn изменился (включение/выключение камеры)
      // 3. КРИТИЧНО для iOS: streamURL изменился (важно при пересоздании треков)
      // 4. КРИТИЧНО для iOS: это новый объект стрима (даже если streamId тот же)
      const streamIdChanged = prevStreamId !== currentStreamId;
      const camOnChanged = prevCamOn !== camOn;
      const streamURLChanged = prevStreamURL !== currentStreamURL;
      // КРИТИЧНО: На iOS обновляем key при изменении streamURL или новом объекте стрима
      // Это предотвращает зависание видео при пересоздании треков
      // На iOS RTCView требует обновления key для корректного обновления streamURL
      const isIOSUpdate = Platform.OS === 'ios' && 
        (streamURLChanged || (prevStreamURL === null && currentStreamURL !== null));
      const shouldUpdate = streamIdChanged || camOnChanged || (prevStreamId === null && currentStreamId) || isIOSUpdate;
      
      if (shouldUpdate) {
        // УПРОЩЕНО: Обновляем key только если прошло достаточно времени или это критичное обновление
        const now = Date.now();
        const isCriticalUpdate = streamIdChanged || camOnChanged;
        if (now - lastLocalRenderKeyUpdateRef.current >= MIN_LOCAL_RENDER_KEY_UPDATE_INTERVAL_MS || isCriticalUpdate) {
          setLocalRenderKey(k => k + 1);
          localStreamIdRef.current = currentStreamId;
          prevCamOnRef.current = camOn;
          prevStreamURLRef.current = currentStreamURL;
          lastLocalRenderKeyUpdateRef.current = now;
          if (Platform.OS === 'ios') {
            localStreamTimestampRef.current = now;
          }
        }
      }
    } else if (!localStream) {
      // Сбрасываем ref когда стрим удаляется
      localStreamIdRef.current = null;
      prevCamOnRef.current = null;
      prevStreamURLRef.current = null;
      localStreamTimestampRef.current = 0;
      needsIOSUpdateAfterNextRef.current = false;
    }
  }, [camOn, localStream, started, isInactiveState]);
  
  // Показывать ли бейдж "Друг"
  const showFriendBadge = useMemo(() => {
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const isInactive = !!isInactiveState;
    const hasActiveConnection = !!remoteStream;
    
    if (!hasPartnerUserId || !hasStarted || isInactive || !hasActiveConnection) {
      return false;
    }
    
    return isPartnerFriend;
  }, [partnerUserId, friends, started, isInactiveState, remoteStream, isPartnerFriend]);
  
  // Анимация появления кнопок в блоках (предотвращает визуальное мелькание на Android)
  useEffect(() => {
    if (started && !isInactiveState) {
      // Небольшая задержка перед анимацией, чтобы иконки успели загрузиться
      const timer = setTimeout(() => {
        Animated.timing(buttonsOpacity, {
          toValue: 1,
          duration: 200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }).start();
      }, Platform.OS === 'android' ? 100 : 50); // Больше задержка на Android для загрузки иконок
      
      return () => clearTimeout(timer);
    } else {
      // Скрываем кнопки сразу при скрытии
      Animated.timing(buttonsOpacity, {
        toValue: 0,
        duration: 150,
        useNativeDriver: true,
      }).start();
    }
  }, [started, isInactiveState, buttonsOpacity]);
  
  // Swipe жесты для возврата назад
  
  // Аудио-роутинг: минимальный и предсказуемый (без агрессивных "пинков")
  const hasActiveCallForAudio = started && !isInactiveState;
  const { stopSpeaker } = useAudioRouting(hasActiveCallForAudio, remoteStream);
  
  // Отправка статуса "busy" при активном общении или поиске в рандомном чате
  const emitRandomPresenceBusy = useCallback((opts?: { force?: boolean }) => {
    const rid = roomId ? String(roomId).trim() : '';
    emitPresenceUpdateIfChanged(
      { status: 'busy', ...(rid ? { roomId: rid } : {}) },
      opts?.force ? { force: true } : undefined,
    );
  }, [roomId]);

  const computeRandomPresenceShouldBeBusy = useCallback(() => {
    const hasActiveCall = !!partnerId || !!roomId;
    const inSearchFlow =
      (startedRef.current || started || loadingRef.current || loading) &&
      !partnerId &&
      !roomId;
    return hasActiveCall || inSearchFlow;
  }, [partnerId, roomId, started, loading]);

  useEffect(() => {
    const g = global as any;
    if (!g.__randomChatPresenceBusyRef) g.__randomChatPresenceBusyRef = { current: false };
    if (!g.__randomChatHadPresenceBusyRef) g.__randomChatHadPresenceBusyRef = { current: false };

    const shouldBeBusy = computeRandomPresenceShouldBeBusy();
    g.__randomChatPresenceBusyRef.current = shouldBeBusy;

    if (shouldBeBusy) {
      try {
        emitRandomPresenceBusy();
        g.__randomChatHadPresenceBusyRef.current = true;
      } catch (e) {
        logger.warn('[RandomChat] Error sending presence:update busy:', e);
      }
    } else if (g.__randomChatHadPresenceBusyRef.current) {
      try {
        emitPresenceUpdateIfChanged({ status: 'online' }, { force: true });
        g.__randomChatHadPresenceBusyRef.current = false;
      } catch (e) {
        logger.warn('[RandomChat] Error sending presence:update online:', e);
      }
    }
  }, [partnerId, roomId, started, loading, computeRandomPresenceShouldBeBusy, emitRandomPresenceBusy]);

  useEffect(() => {
    const off = onConnected(() => {
      const g = global as any;
      if (!computeRandomPresenceShouldBeBusy()) return;
      try {
        emitRandomPresenceBusy({ force: true });
        g.__randomChatHadPresenceBusyRef = g.__randomChatHadPresenceBusyRef || { current: false };
        g.__randomChatHadPresenceBusyRef.current = true;
        g.__randomChatPresenceBusyRef = g.__randomChatPresenceBusyRef || { current: false };
        g.__randomChatPresenceBusyRef.current = true;
      } catch (e) {
        logger.warn('[RandomChat] Error re-sending presence busy on reconnect:', e);
      }
    });
    return () => {
      try {
        off?.();
      } catch {}
    };
  }, [computeRandomPresenceShouldBeBusy, emitRandomPresenceBusy]);

  // Периодически переотправляем busy (reconnect/гонки idle presence на HomeScreen).
  useEffect(() => {
    const tick = () => {
      if (!computeRandomPresenceShouldBeBusy()) return;
      try {
        emitRandomPresenceBusy({ force: true });
        const g = global as any;
        g.__randomChatHadPresenceBusyRef = g.__randomChatHadPresenceBusyRef || { current: false };
        g.__randomChatHadPresenceBusyRef.current = true;
        g.__randomChatPresenceBusyRef = g.__randomChatPresenceBusyRef || { current: false };
        g.__randomChatPresenceBusyRef.current = true;
      } catch {}
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [
    partnerId,
    roomId,
    started,
    loading,
    computeRandomPresenceShouldBeBusy,
    emitRandomPresenceBusy,
  ]);

  useEffect(() => {
    const g = global as any;
    return () => {
      g.__randomChatPresenceBusyRef = g.__randomChatPresenceBusyRef || { current: false };
      g.__randomChatPresenceBusyRef.current = false;
    };
  }, []);
  
  const forceStopRandomChat = useCallback(() => {
    try {
      const session = sessionRef.current;
      if (session) {
        try {
          // КРИТИЧНО: Останавливаем сессию с защитой от ошибок
          // Это предотвращает крэши при cleanup, особенно на Android
          session.cleanup?.();
        } catch (e) {
          logger.error('[RandomChat] Error cleaning session on leave:', e);
        }
        sessionRef.current = null;
      }
    } catch (e) {
      logger.error('[RandomChat] Error in forceStopRandomChat:', e);
    }
    
    // КРИТИЧНО: Сбрасываем все состояния даже если cleanup упал
    // Это гарантирует, что UI будет в корректном состоянии
    try {
      startedRef.current = false;
      loadingRef.current = false;
      isStoppingRef.current = false;
      // КРИТИЧНО: Сбрасываем флаг isNexting при принудительной остановке
      isNextingRef.current = false;
      setStarted(false);
      setLoading(false);
      setIsNexting(false);
      setIsInactiveState(true);
      setPartnerId(null);
      setPartnerUserId(null);
      setRoomId(null);
      setRemoteStream(null);
      setRemoteMuted(false);
      setRemoteCamEnabled(false);
      setCamOn(false);
      setMicOn(false);
      localStreamRef.current = null;
      localStreamTimestampRef.current = 0;
      needsIOSUpdateAfterNextRef.current = false;
      stopSpeaker();
      // Пересоздаём сессию при следующем рендере, чтобы по «Начать» снова запускался поиск
      setSessionKey((k) => k + 1);
    } catch (e) {
      logger.error('[RandomChat] Error resetting state in forceStopRandomChat:', e);
    }
  }, [stopSpeaker]);

  const onRemoteWarning = useCallback(() => {
    try {
      socket.emit('moderation:warningPartner');
    } catch (e) {
      logger.warn('[RandomChat] Failed to warn partner for moderation', e);
    }
  }, []);

  const onRemoteViolation = useCallback(
    (reportedUserId: string) => {
      try {
        socket.timeout(12_000).emit(
          'moderation:reportPartner',
          { partnerUserId: reportedUserId },
          (err: Error | null, res?: { ok?: boolean; reason?: string }) => {
            if (err) {
              logger.warn('[RandomChat] moderation:reportPartner ack failed', { message: err?.message });
              showToast(t('moderationReportAckFailed', lang), 4000, true);
              sessionRef.current?.next();
              return;
            }
            if (res?.ok) {
              showToast(t('moderationPartnerBanned', lang), 4000, true);
              sessionRef.current?.next();
            } else {
              logger.warn('[RandomChat] moderation:reportPartner rejected', { res });
              sessionRef.current?.next();
            }
          }
        );
      } catch (e) {
        logger.warn('[RandomChat] Failed to report partner for moderation', e);
        sessionRef.current?.next();
      }
    },
    [showToast]
  );

  useModeration({
    enabled: moderationEnabled,
    chatType: 'random',
    targetRef: remoteModerationTargetRef,
    stabilityKey: `${partnerUserId || 'none'}:${remoteViewKey}:${remoteStream?.id || 'none'}:${remoteCamEnabled ? 1 : 0}:${loading ? 1 : 0}:${isNexting ? 1 : 0}`,
    moderationTarget: 'remote',
    partnerUserId,
    shouldCheck: started && !loading && !isInactiveState && !isNexting && !!remoteStream && !isModerationBanned,
    cooldownMs: 900,
    badFramesThreshold: 2,
    stabilityDelayMs: 1800,
    onWarning: showWarning,
    onBan: banUser,
    onRemoteWarning,
    onRemoteViolation,
    lang,
  });

  // Слушаем предупреждение от модерации (мы — нарушитель, первое нарушение)
  useEffect(() => {
    const handler = (payload?: { message?: string }) => {
      const text =
        payload && typeof payload.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : t('moderationWarningFallback', lang);
      showToast(text, 4000, true);
    };
    socket.on('moderation:warning', handler);
    return () => {
      socket.off('moderation:warning', handler);
    };
  }, [showToast, lang]);

  // Слушаем бан от модерации (сервер шлёт bannedUntil — один час с момента бана, без продления при повторном start)
  useEffect(() => {
    const handler = (payload?: { bannedUntil?: number }) => {
      const until =
        typeof payload?.bannedUntil === 'number' && payload.bannedUntil > Date.now()
          ? payload.bannedUntil
          : Date.now() + 3600_000;
      applyModerationBanUntil(until, t('moderationBannedSelf', lang), true);
    };
    socket.on('moderation:banned', handler);
    return () => {
      socket.off('moderation:banned', handler);
    };
  }, [applyModerationBanUntil, lang]);

  // Обработка AppState - при уходе приложения в фон рандомный чат должен
  // немедленно завершаться, чтобы при возврате экран был в неактивном состоянии.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      try {
        if (nextAppState === 'background') {
          if (shouldDeferRandomChatStopOnAppBackground()) {
            logger.debug('[RandomChat] App background: skip stop — direct call / incoming transition active');
          } else if (startedRef.current || loadingRef.current) {
            logger.info('[RandomChat] App moved to background, stopping chat immediately');
            forceStopRandomChat();
          }
        } else if (nextAppState === 'inactive') {
          // Пока приложение теряет фокус, сразу переводим экран в неактивное состояние.
          setIsInactiveState(true);
        } else if (nextAppState === 'active') {
          // После возврата из фона кнопка «Начать» должна быть кликабельна и запускать поиск.
          setIsInactiveState(false);
          // Аудио-роутинг поднимется через useAudioRouting (без ручных "пинков")
        }
      } catch (e) {
        logger.error('[RandomChat] Error handling AppState change:', e);
      }
    });
    
    return () => {
      sub.remove();
    };
  }, [forceStopRandomChat]);
  
  // Keep-awake для активного видеозвонка
  useEffect(() => {
    const hasActiveVideoCall = !!remoteStream && (
      remoteStream.getVideoTracks?.()?.length > 0 || 
      remoteStream.getAudioTracks?.()?.length > 0
    ) || (started && !!localStream);
    
    if (hasActiveVideoCall) {
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('[RandomChat] Failed to activate keep-awake:', e);
        });
      }
    }
    
    return () => {
      if (hasActiveVideoCall) {
        if (deactivateKeepAwakeAsync) {
          deactivateKeepAwakeAsync().catch((e) => {
            logger.warn('[RandomChat] Failed to deactivate keep-awake:', e);
          });
        }
      }
    };
  }, [remoteStream, localStream, started]);
  
  // Обработка BackHandler — стоп поиска или goBack на Home (не отдавать системе: иначе свернёт/закроет приложение).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (started && !isInactiveState) {
        onStartStop();
        return true;
      }
      try {
        if (navigation?.canGoBack?.()) {
          navigation.goBack();
          return true;
        }
      } catch {}
      return false;
    });

    return () => backHandler.remove();
  }, [started, isInactiveState, onStartStop, navigation]);

  // Cleanup при уходе со страницы
  useFocusEffect(
    useCallback(() => {
      leavingRef.current = false;
      
      return () => {
        const stillFocused = navigation?.isFocused?.();
        if (stillFocused) {
          return;
        }
        
        leavingRef.current = true;
        
        if (startedRef.current || loadingRef.current) {
          forceStopRandomChat();
        }
      };
    }, [navigation, forceStopRandomChat])
  );
  
  
  return (
    <>
      {Platform.OS === 'android' && (
        <StatusBar
          translucent
          backgroundColor="transparent"
          barStyle="light-content"
        />
      )}
      <SafeAreaView 
        style={[styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }]}
        // Android: safe-area отступы считаем сами через insets, чтобы ничего не перезатиралось стилями
        edges={Platform.OS === 'android' ? [] : undefined}
      >
        <View style={[styles.content, androidContentInsets]}>
        <View style={styles.topSection}>
        {/* Карточка "Собеседник" — ref для модерации (проверяем партнёра, не себя) */}
        <View style={styles.card} ref={remoteModerationTargetRef} collapsable={false}>
          {(() => {
            // КРИТИЧНО: Если поиск остановлен (started=false), всегда показываем текст "Собеседник"
            if (!started) {
              return <Text style={styles.placeholder}>{L("peer")}</Text>;
            }
            
            // В неактивном состоянии показываем текст "Собеседник", НЕ заглушку "Отошел"
            if (isInactiveState) {
              return <Text style={styles.placeholder}>{L("peer")}</Text>;
            }

            // === УПРОЩЕННАЯ ЛОГИКА (требования продукта) ===
            // 1) Loader: во время поиска/next. ВАЖНО: если соединение уже установлено (есть remoteStream),
            // не показываем лоадер "поверх" собеседника — даже если видео ещё не пришло/не renderable.
            // 2) Camera off: показываем "Отошел" ОВЕРЛЕЕМ, не ломая видеопоток/RTCView
            // 3) Camera on: "Отошел" исчезает только когда видео реально снова renderable (без лоадера)
            const streamToRender = remoteStream || remoteStreamRef.current || lastGoodRemoteStreamRef.current;
            const videoTrack = (streamToRender as any)?.getVideoTracks?.()?.[0];
            const canRenderVideo =
              !!videoTrack &&
              videoTrack.readyState === 'live' &&
              videoTrack.enabled !== false &&
              videoTrack.muted !== true;

            const hadVideoBefore = hasEverRemoteVideoRef.current || canRenderVideo;
            // While "Next" is in progress, we must show loader and never flash "Отошел".
            const nextInProgress = isNextingRef.current || isNexting;
            const remoteCamKnown = remoteCamStateKnownRef.current;
            const remoteCamExplicitlyOff = remoteCamKnown && remoteCamEnabled === false;
            const showLoader =
              loading ||
              nextInProgress ||
              // До первого видео показываем лоадер только пока нет remoteStream (т.е. нет установленного соединения).
              (started && !hadVideoBefore && !remoteStream && !remoteCamExplicitlyOff);

            // Keep last good stream to keep RTCView mounted (avoid pipeline churn).
            if (canRenderVideo && streamToRender) {
              hasEverRemoteVideoRef.current = true;
              lastGoodRemoteStreamRef.current = streamToRender;
              lastGoodRemoteStreamAtRef.current = Date.now();
            }

            // Away overlay:
            // - Show ONLY when we explicitly know remote camera is OFF.
            // - When remote camera is turned ON, hide immediately (even if video takes time to resume).
            const showAwayOverlay =
              !showLoader &&
              remoteCamKnown &&
              remoteCamEnabled === false &&
              !networkOverlayVisible;

            const streamURL = streamToRender?.toURL?.() || streamToRender?.id;
            const rtcViewKey = `remote-${streamToRender?.id || 'none'}-${remoteViewKey}`;
            const rtcViewProps: any = Platform.OS === 'android'
              ? {
                  stream: streamToRender,
                  streamURL,
                  renderToHardwareTextureAndroid: true,
                }
              : { streamURL };

            return (
              <View style={styles.remoteStage}>
                {streamToRender ? (
                  <RTCView
                    key={rtcViewKey}
                    {...(rtcViewProps as any)}
                    style={styles.rtc}
                    objectFit="cover"
                    mirror={remoteCamSide === 'front'}
                  />
                ) : (
                  <View style={styles.remoteBlack} />
                )}

                {showLoader && (
                  <View style={styles.overlayCenter}>
                    <ActivityIndicator size="large" color="#fff" />
                  </View>
                )}

                {showAwayOverlay && (
                  <View style={styles.overlayFill}>
                    <AwayPlaceholder />
                  </View>
                )}

                {networkOverlayVisible && (
                  <View style={styles.networkOverlay} pointerEvents="auto">
                    <MaterialIcons name="wifi-off" size={64} color="#fff" />
                  </View>
                )}
              </View>
            );
          })()}
          
          {/* Кнопка выключения динамика */}
          {started && !isInactiveState && (
            <Animated.View
              style={[
                {
                  position: "absolute",
                  top: 8,
                  left: 8,
                  opacity: buttonsOpacity,
                },
              ]}
            >
              <View style={{ opacity: remoteStream ? (remoteMuted ? 0.6 : 1) : 0.5 }}>
                <TouchableOpacity
                  onPress={toggleRemoteAudio}
                  disabled={!remoteStream}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={styles.iconBtn}
                >
                  <View style={{ position: 'relative', justifyContent: 'center', alignItems: 'center' }}>
                    <MaterialIcons
                      name={remoteMuted ? "volume-off" : "volume-up"}
                      size={26}
                      color={remoteMuted ? "#999" : (remoteStream ? "#fff" : "#777")}
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
              </View>
            </Animated.View>
          )}
          
          {/* Кнопка "Добавить в друзья" */}
          {started && !isInactiveState && !!partnerId && !!remoteStream && !!partnerUserId && !isPartnerFriend && (
            <Animated.View style={[styles.topRight, { opacity: buttonsOpacity }]}>
              <View style={{ opacity: addPending || addBlocked ? 0.5 : 1 }}>
                <TouchableOpacity
                  onPress={onAddFriend}
                  disabled={addPending || addBlocked}
                  style={styles.iconBtn}
                >
                  <MaterialIcons
                    name={addBlocked ? "person-add-disabled" : "person-add"}
                    size={26}
                    color="#fff"
                  />
                </TouchableOpacity>
              </View>
            </Animated.View>
          )}
          
          {/* Бейдж "Друг" */}
          {!isInactiveState && showFriendBadge && !!remoteStream && (
            <View style={[styles.friendBadge, { position: "absolute", top: 8, right: 8 }]}>
              <MaterialIcons name="check-circle" size={16} color="#0f0" />
              <Text style={styles.friendBadgeText}>{L('friend')}</Text>
            </View>
          )}
        </View>
        
        {/* Эквалайзер отключен */}
        
        {/* Карточка "Вы" */}
        <View style={styles.card} collapsable={false}>
          {(() => {
            // КРИТИЧНО: Если поиск не начат, всегда показываем "Вы"
            if (!started) {
              return <Text style={styles.placeholder}>{L("you")}</Text>;
            }
            
            // КРИТИЧНО: После завершения звонка показываем только текст "Вы"
            if (isInactiveState) {
              return <Text style={styles.placeholder}>{L("you")}</Text>;
            }
            
            // КРИТИЧНО: Показываем видео только если камера включена
            // При выключении камеры используем unpublishTrack(), который полностью останавливает камеру
            // Это убирает индикатор камеры на iPhone
            if (shouldShowLocalVideo) {
              const isTransition = loadingRef.current || isNextingRef.current;
              // КРИТИЧНО: Используем localStream из state, но если он невалидный, пробуем ref
              // Это предотвращает черный экран во время пересоздания треков при next()
              const displayStream =
                (localStream && isValidStream(localStream))
                  ? localStream
                  : (localStreamRef.current && isValidStream(localStreamRef.current))
                    ? localStreamRef.current
                    : (Platform.OS === 'android' && isTransition && localStreamRef.current)
                      ? localStreamRef.current
                      : null;
              
              if (displayStream) {
                // Безопасно получаем streamURL с проверкой на null/undefined
                const localStreamURL = displayStream.toURL?.();
                // КРИТИЧНО: Используем комбинацию streamId, camOn и localRenderKey для принудительного обновления
                // Это гарантирует, что видео обновится при включении камеры
                // КРИТИЧНО для iOS: Добавляем timestamp в key для гарантированного обновления RTCView
                const localRtcViewKey =
                  Platform.OS === 'ios'
                    ? `local-${displayStream.id}-${camOn}-${localRenderKey}-${localStreamTimestampRef.current}`
                    : `local-${camOn}-${localRenderKey}`;
                
                logger.debug('[RandomChat] Rendering local video', {
                  camOn,
                  hasLocalStream: !!localStream,
                  hasLocalStreamRef: !!localStreamRef.current,
                  usingRef: displayStream === localStreamRef.current && displayStream !== localStream,
                  hasStreamURL: !!localStreamURL,
                  localRenderKey,
                  streamId: displayStream.id,
                });
                
                // КРИТИЧНО: На Android используем prop `stream` для лучшей производительности
                // На iOS используем streamURL
                const localRtcViewProps = Platform.OS === 'android' 
                  ? (() => {
                      return { 
                        stream: displayStream, 
                        streamURL: localStreamURL, 
                        renderToHardwareTextureAndroid: true,
                        useTextureView: true,
                      } as any;
                    })()
                  : { streamURL: localStreamURL! }; // iOS: используем streamURL
                
                if (localStreamURL || Platform.OS === 'android') {
                  return (
                    <RTCView
                      key={localRtcViewKey}
                      {...localRtcViewProps}
                      style={styles.rtc}
                      objectFit="cover"
                      mirror={localCamSide === 'front'}
                    />
                  );
                } else {
                  logger.debug('[RandomChat] Local streamURL unavailable, showing placeholder');
                  return <Text style={styles.placeholder}>{L("you")}</Text>;
                }
              } else {
                logger.debug('[RandomChat] Local stream not ready yet, showing placeholder', {
                  hasLocalStream: !!localStream,
                  hasLocalStreamRef: !!localStreamRef.current,
                  isValid: localStream ? isValidStream(localStream) : false,
                  isValidRef: localStreamRef.current ? isValidStream(localStreamRef.current) : false,
                  isTransition,
                });
                return <Text style={styles.placeholder}>{L("you")}</Text>;
              }
            } else {
              // КРИТИЧНО: При выключении камеры показываем заглушку "Вы"
              // Камера полностью остановлена через unpublishTrack()
              logger.debug('[RandomChat] Camera off, showing placeholder "Вы"', {
                camOn,
                isInactiveState,
                shouldShowLocalVideo,
              });
              return <Text style={styles.placeholder}>{L("you")}</Text>;
            }
          })()}
          
          {/* Кнопки управления медиа */}
          {started && !isInactiveState && (
            <>
              {/* Кнопка переворота камеры (слева вверху) */}
              <Animated.View style={[styles.topLeft, { opacity: buttonsOpacity }]}>
                <TouchableOpacity
                  onPress={handleFlipCamera}
                  disabled={!camOn}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={[styles.iconBtn, !camOn && { opacity: 0.5 }]}
                >
                  <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
                </TouchableOpacity>
              </Animated.View>
              
              {/* Кнопки микрофона и камеры (снизу) */}
              <Animated.View style={[styles.bottomOverlay, { opacity: buttonsOpacity }]}>
                <TouchableOpacity
                  onPress={toggleMic}
                  disabled={isModerationBanned}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={[styles.iconBtn, isModerationBanned && styles.iconBtnDisabled]}
                >
                  <MaterialIcons
                    name={micOn ? "mic" : "mic-off"}
                    size={26}
                    color={micOn ? "#fff" : "#888"}
                  />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={toggleCam}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={styles.iconBtn}
                >
                  <MaterialIcons
                    name={camOn ? "videocam" : "videocam-off"}
                    size={26}
                    color={camOn ? "#fff" : "#888"}
                  />
                </TouchableOpacity>
              </Animated.View>
            </>
          )}
        </View>

        </View>
        {/* Кнопки снизу: Начать/Стоп и Далее */}
        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={[
              styles.bigBtn,
              started ? styles.btnDanger : styles.btnTitan,
              (isInactiveState || isModerationBanned) && styles.disabled
            ]}
            disabled={isInactiveState || isModerationBanned}
            onPress={isInactiveState || isModerationBanned ? undefined : onStartStop}
          >
            <Text style={styles.bigBtnText}>
              {started ? L('stop') : L('start')}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.bigBtn,
              styles.btnTitan,
              (!started || isNexting || isInactiveState || loading || isModerationBanned) && styles.disabled
            ]}
            disabled={!started || isNexting || isInactiveState || loading || isModerationBanned}
            onPress={onNext}
          >
            <Text style={styles.bigBtnText}>
              {L('next')}
            </Text>
          </TouchableOpacity>
        </View>
        </View>
      
      {/* Модалка заявки в друзья */}
      <FriendRequestModal
        visible={friendModalVisible}
        isDark={isDark}
        lang={lang}
        friendRequestDisplayName={friendRequestDisplayName}
        L={L}
        onRequestClose={() => {
          setFriendModalVisible(false);
          setIncomingFriendNick(undefined);
        }}
        onDecline={declineFriend}
        onAccept={acceptFriend}
        styles={styles}
      />
      
      {/* Toast уведомления */}
      <RandomChatToast
        toastVisible={toastVisible}
        toastText={toastText}
        toastModerationStyle={toastModerationStyle}
        toastOpacity={toastOpacity}
        styles={styles}
      />
      </SafeAreaView>
    </>
  );
};

export default RandomChat;
