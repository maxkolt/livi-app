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
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Platform,
  Animated,
  Alert,
  PermissionsAndroid,
  AppState,
  BackHandler,
  Modal,
  Easing,
  ActivityIndicator,
  StatusBar,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { CommonActions } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MediaStream, mediaDevices, RTCView } from '@livekit/react-native-webrtc';
import { RandomChatSession } from '../../src/webrtc/sessions/RandomChatSession';
import type { WebRTCSessionConfig } from '../../src/webrtc/types';
// import VoiceEqualizer from '../VoiceEqualizer'; // эквалайзер отключен
import AwayPlaceholder from '../AwayPlaceholder';
import { t, defaultLang } from '../../utils/i18n';
import { useLang } from '../../store/lang';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import { fetchFriends, requestFriend, respondFriend, onFriendRequest, onFriendAdded, onFriendAccepted, onFriendDeclined, updateProfile, onCallIncoming, onCallCanceled, acceptCall, declineCall, getCurrentUserId } from '../../sockets/socket';
import socket from '../../sockets/socket';
import { syncMyStreamProfile } from '../../chat/cometchat';
import { loadProfileFromStorage } from '../../utils/profileStorage';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import * as Device from 'expo-device';
import { useAudioRouting } from './hooks/useAudioRouting';
import { useModeration } from './hooks/useModeration';

type Props = { 
  route?: { 
    params?: { 
      myUserId?: string; 
      returnTo?: { name: string; params?: any };
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

const RandomChat: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  const lang = useLang((s) => s.lang);
  const androidScreenPadding = 4;
  const androidContentInsets = useMemo(() => {
    if (Platform.OS !== 'android') return null;
    // Android: делаем одинаковый базовый отступ со всех сторон + safe-area (челка/навигация)
    return {
      paddingTop: insets.top + androidScreenPadding,
      paddingBottom: insets.bottom + androidScreenPadding,
      paddingLeft: insets.left + androidScreenPadding,
      paddingRight: insets.right + androidScreenPadding,
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
  const [roomId, setRoomId] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [addPending, setAddPending] = useState(false);
  const [addBlocked, setAddBlocked] = useState(false);
  const [friendModalVisible, setFriendModalVisible] = useState(false);
  const [incomingFriendFrom, setIncomingFriendFrom] = useState<string | null>(null);
  const [incomingFriendNick, setIncomingFriendNick] = useState<string | undefined>(undefined);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteCamEnabled, setRemoteCamEnabled] = useState(false);
  // Once we have rendered remote video at least once, we should never show a spinner again for camera on/off.
  const hasEverRemoteVideoRef = useRef(false);
  // Full-screen network overlay (black screen with icon) for network-origin video failures.
  const [networkOverlayVisible, setNetworkOverlayVisible] = useState(false);
  const networkOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const NETWORK_OVERLAY_DELAY_MS = 6000;
  // On Android we must not show "Отошел" because of transient track/stream churn.
  // Show it ONLY after we got an explicit remote cam state change event.
  const remoteCamStateKnownRef = useRef(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
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
  
  // Входящий звонок (когда пользователь в неактивном состоянии)
  const [incomingCall, setIncomingCall] = useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const moderationEnabled = String(process.env.EXPO_PUBLIC_RANDOM_CHAT_MODERATION || '0') === '1';
  const localModerationTargetRef = useRef<View | null>(null);
  const [muteByModerationUntil, setMuteByModerationUntil] = useState(0);
  const [banByModerationUntil, setBanByModerationUntil] = useState(0);
  const myUserId = useMemo(() => {
    const routeUserId = String(route?.params?.myUserId ?? '').trim();
    if (routeUserId) return routeUserId;
    const socketUserId = String(getCurrentUserId?.() ?? '').trim();
    return socketUserId || undefined;
  }, [route?.params?.myUserId]);
  
  // Анимации для входящего звонка (как в App.tsx)
  const incomingCallBounce = useRef(new Animated.Value(0)).current;
  const incomingWaveA = useRef(new Animated.Value(0)).current;
  const incomingWaveB = useRef(new Animated.Value(0)).current;
  // Toast уведомления
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  
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
  
  
  // Здесь грузим только друзей (язык берём выше из глобального стора)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetchFriends();
        const friendsList = r?.list || [];
        setFriends(friendsList);
      } catch (e) {
        logger.warn('[RandomChat] Failed to load friends:', e);
      }
    })();
  }, []);
  
  // cam-toggle для рандомного чата на LiveKit не используем (состояние камеры определяется по трекам)
  
  const L = useCallback((key: string) => t(key, lang), [lang]);
  
  // Функция показа toast уведомлений
  const showToast = useCallback((text: string, ms = 1700) => {
    if (!text || text.toLowerCase() === 'self') return; // скрываем отладочный тост
    setToastText(text);
    setToastVisible(true);
    Animated.timing(toastOpacity, { toValue: 1, duration: 160, useNativeDriver: true }).start(() => {
      const t = setTimeout(() => {
        Animated.timing(toastOpacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
          setToastVisible(false);
          setToastText('');
        });
        clearTimeout(t);
      }, ms);
    });
  }, [toastOpacity]);

  const isModerationMuted = muteByModerationUntil > Date.now();
  const isModerationBanned = banByModerationUntil > Date.now();

  const showWarning = useCallback((message: string) => {
    showToast(message, 2400);
  }, [showToast]);

  const muteUser = useCallback((seconds: number, message: string) => {
    const until = Date.now() + seconds * 1000;
    setMuteByModerationUntil(until);
    if (micOn) {
      try {
        sessionRef.current?.toggleMic();
      } catch (e) {
        logger.warn('[RandomChat] Failed to force mute by moderation', e);
      }
    }
    showToast(message, 2600);
    setTimeout(() => {
      setMuteByModerationUntil((prev) => (prev <= Date.now() ? 0 : prev));
    }, seconds * 1000 + 200);
  }, [micOn, showToast]);

  const banUser = useCallback((seconds: number, message: string) => {
    const until = Date.now() + seconds * 1000;
    setBanByModerationUntil(until);
    showToast(message, 2800);
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
    setTimeout(() => {
      setBanByModerationUntil((prev) => (prev <= Date.now() ? 0 : prev));
    }, seconds * 1000 + 200);
  }, [showToast]);
  
  // Обработка заявок в друзья
  useEffect(() => {
    const offReq = onFriendRequest?.(({ from, fromNick }) => {
      setIncomingFriendFrom(from);
      setIncomingFriendNick(fromNick);
      setFriendModalVisible(true);
    });
    
    const offAdded = onFriendAdded?.(({ userId }) => {
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        setAddPending(false);
        setAddBlocked(true);
        showToast(L('friend_added'));
      }
    });
    
    const offAccepted = onFriendAccepted?.(async ({ userId }) => {
      setAddPending(false);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        showToast(L('friend_added'));
      }
      // Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const cached = await loadProfileFromStorage();
        const nick = cached?.nick || '';
        const avatarUrl = cached?.avatar || '';
        const patch: { nick?: string; avatar?: string } = {};
        if (nick) patch.nick = nick;
        // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
        if (avatarUrl) patch.avatar = avatarUrl;
        if (Object.keys(patch).length) {
          await updateProfile(patch);
        }
        await syncMyStreamProfile(nick, avatarUrl || undefined);
      } catch (e) {
        logger.warn('[RandomChat] Failed to update profile:', e);
      }
    });
    
    const offDecl = onFriendDeclined?.(({ userId }: { userId: string }) => {
      setAddPending(false);
      setAddBlocked(true);
      if (String(userId) === String(partnerUserId)) {
        showToast(L('friend_declined'));
      }
    });
    
    return () => {
      offReq?.();
      offAdded?.();
      offAccepted?.();
      offDecl?.();
    };
  }, [partnerUserId, showToast]);
  
  // Обработка добавления в друзья
  const onAddFriend = useCallback(async () => {
    if (!partnerUserId || addPending || addBlocked) return;
    
    setAddPending(true);
    try {
      const res: any = await requestFriend(partnerUserId);
      if (res?.status === 'pending' || res?.ok) {
        showToast(L('friend_request_sent'));
        // Обновляем профиль на сервере и синхронизируем с CometChat
        try {
          const cached = await loadProfileFromStorage();
          const nick = cached?.nick || '';
          const avatarUrl = cached?.avatar || '';
          const patch: { nick?: string; avatar?: string } = {};
          if (nick) patch.nick = nick;
          // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
          if (avatarUrl) patch.avatar = avatarUrl;
          if (Object.keys(patch).length) {
            await updateProfile(patch);
          }
          await syncMyStreamProfile(nick, avatarUrl || undefined);
        } catch (e) {
          logger.warn('[RandomChat] Failed to update profile:', e);
        }
      } else if (res?.status === 'already') {
        setAddPending(false);
        setAddBlocked(true);
        fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
        showToast(L('already_friends'));
      } else if (res?.ok === false) {
        setAddPending(false);
        showToast(res?.error || L('friend_request_failed'));
      }
    } catch (e) {
      logger.error('[RandomChat] Error requesting friend:', e);
      setAddPending(false);
      showToast(L('friend_request_failed'));
    }
  }, [partnerUserId, addPending, addBlocked, showToast]);
  
  const acceptFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try {
      await respondFriend(incomingFriendFrom, true);
      setFriendModalVisible(false);
      setIncomingFriendFrom(null);
      setIncomingFriendNick(undefined);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      // Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const cached = await loadProfileFromStorage();
        const nick = cached?.nick || '';
        const avatarUrl = cached?.avatar || '';
        const patch: { nick?: string; avatar?: string } = {};
        if (nick) patch.nick = nick;
        // ⚠️ КРИТИЧНО: НЕ отправляем avatar='' — на сервере это считается удалением аватара.
        if (avatarUrl) patch.avatar = avatarUrl;
        if (Object.keys(patch).length) {
          await updateProfile(patch);
        }
        await syncMyStreamProfile(nick, avatarUrl || undefined);
      } catch (e) {
        logger.warn('[RandomChat] Failed to update profile:', e);
      }
    } catch (e) {
      logger.error('[RandomChat] Error accepting friend:', e);
    }
  }, [incomingFriendFrom]);
  
  const declineFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try {
      await respondFriend(incomingFriendFrom, false);
      setFriendModalVisible(false);
      setIncomingFriendFrom(null);
      setIncomingFriendNick(undefined);
    } catch (e) {
      logger.error('[RandomChat] Error declining friend:', e);
    }
  }, [incomingFriendFrom]);
  
  // Проверка, является ли партнер другом
  // КРИТИЧНО: Друзья могут попадаться в рандомном чате - это нормально
  // Эта проверка используется только для UI (показ бейджа "Друг" и скрытие кнопки "Добавить в друзья")
  // Она НЕ влияет на работу видеочата - соединение устанавливается независимо от статуса дружбы
  const isPartnerFriend = useMemo(() => {
    if (!partnerUserId) return false;
    return friends.some(f => String(f._id) === String(partnerUserId));
  }, [partnerUserId, friends]);
  
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
        onLoadingChange: (loading) => {
          setLoading(loading);
        },
        onMicLevelChange: (level) => {
          // Эквалайзер отключен
        },
        onMicFrequencyLevelsChange: (levels) => {
          // Эквалайзер отключен
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
      showToast('Вы заблокированы на 1 час за повторные нарушения.', 2400);
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
  }, [requestPermissions, isModerationBanned, showToast]);
  
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

      try {
        // Вызываем next() в сессии
        await session.next();
        
        // КРИТИЧНО для iOS: Устанавливаем флаг для обновления key при следующем localStream
        // НЕ обновляем key здесь, чтобы избежать конфликтов с обработчиком localStream
        if (Platform.OS === 'ios') {
          needsIOSUpdateAfterNextRef.current = true;
        }
    } catch (e: any) {
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
      }, 1500);
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
    if (isModerationMuted || isModerationBanned) return;
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
  }, [isModerationMuted, isModerationBanned]);
  
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
  // const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0; // эквалайзер отключен
  
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
  useEffect(() => {
    const hasActiveCall = !!partnerId || !!roomId;
    const isSearching = started && !partnerId && !roomId;
    
    if (hasActiveCall || isSearching) {
      // Отправляем статус "busy" когда есть активное общение или идет поиск
      try {
        socket.emit('presence:update', { status: 'busy', roomId: roomId || undefined });
      } catch (e) {
        logger.warn('[RandomChat] Error sending presence:update busy:', e);
      }
    } else {
      // Сбрасываем статус "busy" когда нет активного общения и не ищем
      try {
        socket.emit('presence:update', { status: 'online' });
      } catch (e) {
        logger.warn('[RandomChat] Error sending presence:update online:', e);
      }
    }
  }, [partnerId, roomId, started]);
  
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

  useModeration({
    enabled: moderationEnabled,
    chatType: 'random',
    targetRef: localModerationTargetRef,
    shouldCheck: started && !loading && !isInactiveState && camOn && !!localStream && !isModerationBanned,
    cooldownMs: 1300,
    badFramesThreshold: 3,
    onWarning: showWarning,
    onMute: muteUser,
    onBan: banUser,
  });
  
  // Обработка AppState - при уходе приложения в фон рандомный чат должен
  // немедленно завершаться, чтобы при возврате экран был в неактивном состоянии.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      try {
        if (nextAppState === 'background') {
          if (startedRef.current || loadingRef.current) {
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
  
  // Обработка BackHandler - для рандомного чата закрываем при нажатии назад
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (started && !isInactiveState) {
        // Если поиск активен, останавливаем его
        onStartStop();
        return true; // Предотвращаем закрытие
      }
      return false; // Разрешаем закрытие
    });
    
    return () => backHandler.remove();
  }, [started, isInactiveState, onStartStop]);
  
  // Обработка входящих звонков (когда пользователь в неактивном состоянии)
  useEffect(() => {
    // Стратегия A:
    // На неактивном RandomChat НЕ показываем локальную модалку,
    // а отдаём обработку глобальной модалке в App.tsx (full-screen + рингтон/вибрация).
    const offIncoming = onCallIncoming?.((d) => {
      if (!started || isInactiveState) return;
    });
    
    return () => {
      offIncoming?.();
    };
  }, [started, isInactiveState]);
  
  // Обработка отмены входящего звонка
  useEffect(() => {
    const offCancel = onCallCanceled?.((d) => {
      if (incomingCall && d?.callId === incomingCall.callId) {
        logger.info('[RandomChat] Incoming call canceled', { callId: d.callId });
        setIncomingCall(null);
      }
    });
    
    const handleTimeout = () => {
      if (incomingCall) {
        logger.info('[RandomChat] Incoming call timeout');
        setIncomingCall(null);
      }
    };
    
    const handleDeclined = (d?: any) => {
      if (incomingCall && d?.callId === incomingCall.callId) {
        setIncomingCall(null);
      }
    };
    
    socket.on('call:timeout', handleTimeout);
    socket.on('call:declined', handleDeclined);
    
    return () => {
      offCancel?.();
      socket.off('call:timeout', handleTimeout);
      socket.off('call:declined', handleDeclined);
    };
  }, [incomingCall]);
  
  // Принятие входящего звонка
  const handleAcceptIncomingCall = useCallback(async () => {
    if (!incomingCall) return;

    try {
      logger.info('[RandomChat] Accepting incoming call', { callId: incomingCall.callId });
      
      // КРИТИЧНО: Очищаем текущую сессию рандом-чата перед переходом на VideoCall
      // Это предотвращает конфликты LiveKit комнат
      const session = sessionRef.current;
      if (session) {
        logger.info('[RandomChat] Cleaning up RandomChatSession before accepting video call');
        try {
          session.cleanup?.();
        } catch (e) {
          logger.warn('[RandomChat] Error cleaning up session:', e);
        }
        sessionRef.current = null;
      }
      
      // КРИТИЧНО: НЕ вызываем acceptCall здесь!
      // Вместо этого передаем isIncoming: true в VideoCall, который сам вызовет acceptCall
      // после создания VideoCallSession и установки обработчиков сокетов.
      // Это гарантирует, что call:accepted событие будет получено.

      // Переходим на страницу видеозвонка
      (navigation as any).navigate('VideoCall', {
        myUserId,
        directCall: true,
        callId: incomingCall.callId,
        peerUserId: incomingCall.from, // user ID для показа бейджа друга
        partnerNick: incomingCall.fromNick,
        isIncoming: true,
      });
      
      setIncomingCall(null);
    } catch (e) {
      logger.error('[RandomChat] Error accepting call:', e);
      setIncomingCall(null);
    }
  }, [incomingCall, navigation, myUserId]);
  
  // Отклонение входящего звонка
  const handleDeclineIncomingCall = useCallback(async () => {
    if (!incomingCall) return;

    try {
      logger.info('[RandomChat] Declining incoming call', { callId: incomingCall.callId });
      await declineCall?.(incomingCall.callId);
      setIncomingCall(null);
    } catch (e) {
      logger.error('[RandomChat] Error declining call:', e);
      setIncomingCall(null);
    }
  }, [incomingCall]);

  // Анимации для входящего звонка
  const stopIncomingAnim = useCallback(() => {
    incomingCallBounce.stopAnimation();
    incomingWaveA.stopAnimation();
    incomingWaveB.stopAnimation();
  }, [incomingCallBounce, incomingWaveA, incomingWaveB]);

  const startIncomingAnim = useCallback(() => {
    stopIncomingAnim();
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
  }, [incomingCallBounce, incomingWaveA, incomingWaveB, stopIncomingAnim]);

  // Запуск/остановка анимаций при изменении incomingCall
  useEffect(() => {
    if (incomingCall && (!started || isInactiveState)) {
      startIncomingAnim();
    } else {
      stopIncomingAnim();
    }
    return () => stopIncomingAnim();
  }, [incomingCall, started, isInactiveState, startIncomingAnim, stopIncomingAnim]);

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
          barStyle={isDark ? 'light-content' : 'dark-content'}
        />
      )}
      <SafeAreaView 
        style={[styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }]}
        // Android: safe-area отступы считаем сами через insets, чтобы ничего не перезатиралось стилями
        edges={Platform.OS === 'android' ? [] : undefined}
      >
        <View style={[styles.content, androidContentInsets]}>
        <View style={styles.topSection}>
        {/* Карточка "Собеседник" */}
        <View style={styles.card}>
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
                    mirror={false}
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
        
        {/* Карточка "Вы" — collapsable={false} нужен для captureRef/captureScreen на Android */}
        <View style={styles.card} ref={localModerationTargetRef} collapsable={false}>
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
                      mirror
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
                  disabled={isModerationMuted || isModerationBanned}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={[styles.iconBtn, (isModerationMuted || isModerationBanned) && styles.iconBtnDisabled]}
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
      <Modal
        visible={friendModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setFriendModalVisible(false);
          setIncomingFriendNick(undefined);
        }}
      >
        <View style={styles.modalOverlay}>
          <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{L('friend_request')}</Text>
            <Text style={styles.modalText}>
              {t('friend_request_text', lang).replace(
                '{user}',
                incomingFriendNick || incomingFriendFrom || t('thisUser', lang)
              )}
            </Text>
            <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.btnGlassBase, styles.btnGlassDanger]}
                onPress={declineFriend}
              >
                <Text style={styles.modalBtnText}>{L('decline')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnGlassBase, styles.btnGlassTitan]}
                onPress={acceptFriend}
              >
                <Text style={styles.modalBtnText}>{L('accept')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      
      {/* Toast уведомления */}
      {toastVisible && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastText}</Text>
        </Animated.View>
      )}
      
      {/* Модальное окно входящего звонка поверх всего экрана */}
      {incomingCall && (!started || isInactiveState) && (
        <View style={styles.incomingOverlayFullScreen}>
          <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.5)' }]} />
          <View style={styles.incomingOverlayContent}>
            <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View style={buildIncomingWaveStyle(incomingWaveA, 'left')} />
              <Animated.View style={buildIncomingWaveStyle(incomingWaveB, 'right')} />
              <Animated.View style={incomingCallIconStyle}>
                <MaterialIcons name="call" size={48} color="#4FC3F7" />
              </Animated.View>
            </View>
            <Text style={styles.incomingOverlayTitle}>{t('incomingCallTitle', lang)}</Text>
            <Text style={styles.incomingOverlayName}>{incomingCall.fromNick || t('friend', lang)}</Text>
            <View style={styles.incomingOverlayButtons}>
              <TouchableOpacity
                onPress={handleAcceptIncomingCall}
                style={[styles.btnGlassBase, styles.btnGlassSuccess]}
              >
                <Text style={styles.modalBtnText}>{t('accept', lang)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDeclineIncomingCall}
                style={[styles.btnGlassBase, styles.btnGlassDanger]}
              >
                <Text style={styles.modalBtnText}>{t('decline', lang)}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      </SafeAreaView>
    </>
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
    // Важно: нижний ряд кнопок должен быть всегда внизу внутри safe-area
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
    // КРИТИЧНО: Отключаем оптимизации, которые могут блокировать обновление видео
    ...(Platform.OS === 'android' ? {
      // На Android не используем shouldRasterizeIOS, так как это iOS-специфичное свойство
    } : {
      // На iOS можно добавить дополнительные оптимизации если нужно
    }),
  },
  remoteStage: {
    flex: 1,
    width: '100%',
  },
  remoteBlack: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  overlayFill: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    // Important: the placeholder must include its own background, otherwise
    // the underlying video/black layer can change a frame earlier and looks like a "two-step" disappear.
    backgroundColor: '#000',
  },
  overlayCenter: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    // Loader must disappear as a single unit (background + spinner)
    backgroundColor: '#000',
  },
  networkOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    // Ширина как у карточек (блок «Вы»): на iOS 94%, на Android 100%
    width: Platform.OS === 'android' ? '100%' : '94%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 11 : 16,
    marginTop: Platform.OS === "android" ? 5 : 10,
    marginBottom: Platform.OS === "android" ? 4 : 32,
    // Смещаем кнопки к центру: «Начать» от левого края, «Далее» от правого
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
  btnTitan: {
    backgroundColor: '#8a8f99',
  },
  btnDanger: {
    backgroundColor: '#ff4d4d',
  },
  disabled: {
    opacity: 1,
  },
  topRight: {
    position: 'absolute',
    top: 10,
    right: 10,
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
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  modalText: {
    color: '#e5e7eb',
    fontSize: 14,
  },
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassDanger: {
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)',
  },
  btnGlassTitan: {
    backgroundColor: 'rgba(138,143,153,0.16)',
    borderColor: 'rgba(138,143,153,0.65)',
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
  toast: {
    position: 'absolute',
    bottom: 86,
    left: '7%',
    right: '7%',
    backgroundColor: 'rgba(13,14,16,0.92)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#B7C0CF',
    fontSize: 14,
    fontWeight: '600',
  },
  iconBtn: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 22,
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
    // Android: чтобы кнопки были выше видеовью (TextureView/обычные View)
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  topLeft: {
    position: 'absolute',
    top: 10,
    left: 10,
    zIndex: 40,
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 40,
    ...(Platform.OS === 'android' ? { elevation: 40 } : {}),
  },
  // Стили для входящего звонка (как в VideoCall/App.tsx)
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
  incomingOverlayFullScreen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
    elevation: 9999, // для Android
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
    marginBottom: 14,
  },
  incomingOverlayButtons: {
    flexDirection: 'row',
    gap: 14,
    width: '100%',
    paddingHorizontal: 28,
    marginTop: 16,
  },
  btnGlassSuccess: {
    backgroundColor: 'rgba(76, 175, 80, 0.16)',
    borderColor: 'rgba(76, 175, 80, 0.65)',
  },
});

export default RandomChat;
