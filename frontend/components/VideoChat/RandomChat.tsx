/**
 * RandomChat - Компонент для рандомного видеочата
 * Использует компоненты: RTCView (для отображения видео), VoiceEqualizer, AwayPlaceholder
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
import VoiceEqualizer from '../VoiceEqualizer';
import AwayPlaceholder from '../AwayPlaceholder';
import { t, loadLang, defaultLang } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import InCallManager from 'react-native-incall-manager';
import { logger } from '../../utils/logger';
import { fetchFriends, requestFriend, respondFriend, onFriendRequest, onFriendAdded, onFriendAccepted, onFriendDeclined, updateProfile, onCallIncoming, onCallCanceled, acceptCall, declineCall } from '../../sockets/socket';
import socket from '../../sockets/socket';
import { syncMyStreamProfile } from '../../chat/cometchat';
import { loadProfileFromStorage } from '../../utils/profileStorage';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';
import * as Device from 'expo-device';

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
  marginVertical: 7,
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
  const [lang, setLang] = useState<Lang>(defaultLang);
  
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
  const remoteStreamReceivedAtRef = useRef<number | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteCamEnabled, setRemoteCamEnabled] = useState(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
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
  const [micLevel, setMicLevel] = useState(0);
  const [micFrequencyLevels, setMicFrequencyLevels] = useState<number[]>(() => new Array(21).fill(0));
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(0));
  const shownSimulatorCameraHintRef = useRef(false);
  
  // Синхронизируем состояние неактивности с глобальным ref для App.tsx
  useEffect(() => {
    (global as any).__isInactiveStateRef = { current: isInactiveState };
    return () => {
      (global as any).__isInactiveStateRef = { current: false };
    };
  }, [isInactiveState]);

  // iOS Simulator: camera capture for WebRTC may be unavailable unless Simulator camera input is configured.
  // Show a one-time hint to avoid confusion when local video is black/missing.
  useEffect(() => {
    if (shownSimulatorCameraHintRef.current) return;
    if (Platform.OS !== 'ios') return;
    if (Device.isDevice) return;
    shownSimulatorCameraHintRef.current = true;
    Alert.alert(
      'iOS Simulator camera',
      'В вашем iOS Simulator камера недоступна для WebRTC/LiveKit (в некоторых версиях Simulator нет пункта I/O → Camera). Для проверки видео используйте физический iPhone. В симуляторе можно тестировать UI/аудио/сигналинг.'
    );
  }, []);
  
  // Входящий звонок (когда пользователь в неактивном состоянии)
  const [incomingCall, setIncomingCall] = useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const myUserId = route?.params?.myUserId;
  
  // Анимации для входящего звонка (как в App.tsx)
  const incomingCallBounce = useRef(new Animated.Value(0)).current;
  const incomingWaveA = useRef(new Animated.Value(0)).current;
  const incomingWaveB = useRef(new Animated.Value(0)).current;
  const renderLogCountRef = useRef(0);
  const logRemoteRenderState = useCallback((reason: string, extra?: Record<string, unknown>) => {
    const count = renderLogCountRef.current;
    renderLogCountRef.current = count + 1;
    // Логируем только первые несколько раз, далее — каждые 40-й в debug, иначе пропускаем
    if (count < 3) {
      logger.info('[RandomChat] Remote render state', { reason, ...extra });
    } else if (count % 40 === 0) {
      logger.debug('[RandomChat] Remote render state', { reason, ...extra });
    }
  }, []);
  
  // Toast уведомления
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  
  // Session
  const sessionRef = useRef<RandomChatSession | null>(null);

  // Сброс удаленного состояния при смене партнера
  useEffect(() => {
    if (!partnerId) {
      remoteStreamRef.current = null;
      setRemoteStream(null);
      remoteStreamReceivedAtRef.current = null;
      setRemoteCamEnabled(false);
      setRemoteViewKey((k) => k + 1);
    }
  }, [partnerId]);
  
  
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
        showToast('Добавили в друзья');
      }
    });
    
    const offAccepted = onFriendAccepted?.(async ({ userId }) => {
      setAddPending(false);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        showToast('Добавили в друзья');
      }
      // Обновляем профиль на сервере и синхронизируем с CometChat
      try {
        const cached = await loadProfileFromStorage();
        const nick = cached?.nick || '';
        const avatarUrl = cached?.avatar || '';
        if (nick || avatarUrl) {
          await updateProfile({ nick, avatar: avatarUrl });
          await syncMyStreamProfile(nick, avatarUrl);
        }
      } catch (e) {
        logger.warn('[RandomChat] Failed to update profile:', e);
      }
    });
    
    const offDecl = onFriendDeclined?.(({ userId }: { userId: string }) => {
      setAddPending(false);
      setAddBlocked(true);
      if (String(userId) === String(partnerUserId)) {
        showToast('Вам отказано');
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
        showToast('Заявка отправлена');
        // Обновляем профиль на сервере и синхронизируем с CometChat
        try {
          const cached = await loadProfileFromStorage();
          const nick = cached?.nick || '';
          const avatarUrl = cached?.avatar || '';
          if (nick || avatarUrl) {
            await updateProfile({ nick, avatar: avatarUrl });
            await syncMyStreamProfile(nick, avatarUrl);
          }
        } catch (e) {
          logger.warn('[RandomChat] Failed to update profile:', e);
        }
      } else if (res?.status === 'already') {
        setAddPending(false);
        setAddBlocked(true);
        fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
        showToast('Вы уже друзья');
      } else if (res?.ok === false) {
        setAddPending(false);
        showToast(res?.error || 'Не удалось отправить заявку');
      }
    } catch (e) {
      logger.error('[RandomChat] Error requesting friend:', e);
      setAddPending(false);
      showToast('Ошибка отправки заявки');
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
        if (nick || avatarUrl) {
          await updateProfile({ nick, avatar: avatarUrl });
          await syncMyStreamProfile(nick, avatarUrl);
        }
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
      myUserId: route?.params?.myUserId,
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
          setRemoteCamEnabled(enabled);
          logger.debug('[RandomChat] Remote camera state changed', { enabled });
        },
        onLoadingChange: (loading) => {
          setLoading(loading);
        },
        onMicLevelChange: (level) => {
          setMicLevel(boostMicLevel(level));
        },
        onMicFrequencyLevelsChange: (levels) => {
          // levels already normalized 0..1 from session FFT; keep length stable for bars=21
          if (Array.isArray(levels) && levels.length) {
            // IMPORTANT: clone to force state update (session may reuse same array instance)
            setMicFrequencyLevels(levels.slice());
          }
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
      const prevStreamValid = prevStream && isValidStream(prevStream);
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
        if (isNextingRef.current && prevStreamValid) {
          // Идет next() и есть валидный предыдущий стрим - сохраняем его
          localStreamRef.current = prevStream;
          // НЕ обновляем state на null, чтобы не было черного экрана
          logger.debug('[RandomChat] Keeping previous localStream during next() to prevent flicker', {
            prevStreamId: prevStream.id,
            isNexting: isNextingRef.current,
          });
        } else {
          // Не идет next() или нет предыдущего стрима - обновляем на null
          localStreamRef.current = null;
          setLocalStream(null);
        }
      } else if (!stream || !isValidStream(stream)) {
        // Новый стрим невалидный - сохраняем предыдущий в ref если он валидный
        if (prevStreamValid) {
          localStreamRef.current = prevStream;
          // НЕ обновляем state, чтобы не было черного экрана
          logger.debug('[RandomChat] Keeping previous localStream to prevent flicker', {
            prevStreamId: prevStream.id,
            newStreamValid: false,
            hasPrevStream: !!prevStream,
          });
        } else {
          // Предыдущий стрим тоже невалидный - обновляем state
          localStreamRef.current = stream;
          setLocalStream(stream);
        }
      }
    });
    
    session.on('remoteStream', (stream) => {
      const prevStream = remoteStreamRef.current;
      const prevVideoTrack = prevStream?.getVideoTracks?.()?.[0];
      const prevVideoId = prevVideoTrack?.id;
      const prevVideoReady = !!prevVideoTrack && prevVideoTrack.readyState === 'live';
      const newVideoTrack = stream?.getVideoTracks?.()?.[0];
      const newVideoId = newVideoTrack?.id;
      const newVideoReady = !!newVideoTrack && newVideoTrack.readyState === 'live';
      const trackIsLiveAndEnabled = !!(
        newVideoTrack &&
        newVideoTrack.readyState === 'live' &&
        newVideoTrack.enabled !== false &&
        newVideoTrack.muted !== true
      );
      const sameStreamInstance =
        !!stream && !!prevStream && prevStream === stream && prevStream.id === stream.id;

      if (sameStreamInstance) {
        const trackChanged = prevVideoId !== newVideoId;
        const trackBecameLive = !prevVideoReady && newVideoReady;

        if (trackChanged || trackBecameLive) {
          logger.info('[RandomChat] Remote stream tracks updated without new MediaStream instance', {
            streamId: stream.id,
            prevVideoId,
            newVideoId,
            prevVideoReady,
            newVideoReady,
          });
        }

        // Форсим обновление RTCView даже если трек и id не изменились.
        setRemoteViewKey((k: number) => k + 1);

        // Не пытаемся "чинить" состояние трека на клиенте — UI реагирует на фактическое состояние трека.

        remoteStreamRef.current = stream;
        return;
      }

      const isNewPartner = !prevStream || (prevStream && prevStream.id !== stream?.id);
      
      remoteStreamRef.current = stream || null;

      if (stream) {
        // КРИТИЧНО: Сохраняем время получения remoteStream ВСЕГДА (не только для нового партнера)
        // Это предотвращает мерцание заглушки "Отошел" при получении треков
        remoteStreamReceivedAtRef.current = Date.now();
        
        // КРИТИЧНО: При получении нового партнера сбрасываем состояние камеры
        // Оно обновится через onRemoteCamStateChange когда треки будут получены
        if (isNewPartner) {
          setRemoteCamEnabled(false);
        }
        
        logger.info('[RandomChat] Remote stream received', {
          streamId: stream.id,
          prevStreamId: prevStream?.id,
          hasVideoTrack: !!(stream.getVideoTracks?.()?.[0]),
          hasAudioTrack: !!(stream.getAudioTracks?.()?.[0]),
          isNewPartner,
        });
        const videoTrack = stream.getVideoTracks?.()?.[0];
        
        // Логируем для отладки
        logger.info('[RandomChat] Remote stream track state on receive', {
          isNewPartner,
          hasVideoTrack: !!videoTrack,
          videoTrackReadyState: videoTrack?.readyState,
          videoTrackMuted: videoTrack?.muted,
          videoTrackEnabled: videoTrack?.enabled,
          canRender: !!(
            videoTrack &&
            videoTrack.readyState === 'live' &&
            videoTrack.enabled === true &&
            videoTrack.muted !== true
          ),
        });
        
        // Не пытаемся "чинить" состояние трека на клиенте — UI реагирует на фактическое состояние трека.
        
        // КРИТИЧНО: Обновляем remoteViewKey для принудительного обновления RTCView
        // Это гарантирует, что видео отображается сразу при получении stream
        setRemoteStream(stream);
        setRemoteViewKey((k: number) => k + 1);
        setRemoteMuted(false);
        setIsInactiveState(false);
        setLoading(false); // КРИТИЧНО: Сбрасываем loading когда соединение установлено
        loadingRef.current = false;
        logger.info('[RandomChat] Remote stream установлен', {
          streamId: stream.id,
          hasVideoTrack: !!videoTrack,
          videoTrackEnabled: videoTrack?.enabled,
          videoTrackMuted: videoTrack?.muted,
          videoTrackReadyState: videoTrack?.readyState,
          canRender: !!(
            videoTrack &&
            videoTrack.readyState === 'live' &&
            videoTrack.enabled === true &&
            videoTrack.muted !== true
          ),
        });
      } else {
        setRemoteStream(null);
        setRemoteMuted(false);
        setRemoteCamEnabled(false);
        remoteStreamReceivedAtRef.current = null;
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
      
      // Проверяем активное соединение перед очисткой
      const hasRemoteStream = !!remoteStream;
      const pc = session.getPeerConnection?.();
      
      // RandomChatSession использует LiveKit и не имеет PeerConnection
      // Поэтому пропускаем проверку для RandomChatSession
      if (hasRemoteStream && pc) {
        const pcAny = pc as any;
        if (pcAny.signalingState !== 'closed' && pcAny.connectionState !== 'closed') {
          const isPcActive = pcAny.iceConnectionState === 'checking' || 
                            pcAny.iceConnectionState === 'connected' || 
                            pcAny.iceConnectionState === 'completed' ||
                            pcAny.connectionState === 'connecting' ||
                            pcAny.connectionState === 'connected';
          
          if (isPcActive) {
            return;
          }
        }
      }
      
      remoteStreamRef.current = null;
      setRemoteStream(null);
      remoteStreamReceivedAtRef.current = null;
      setRemoteMuted(false);
      setRemoteCamEnabled(false);
      setRemoteViewKey((k: number) => k + 1);
    });
    
    session.on('searching', () => {
      setLoading(true);
      setIsInactiveState(false);
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
  }, [route?.params?.myUserId]);
  
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
    const session = sessionRef.current;
    if (!session) return;
    
    // КРИТИЧНО: ЗАЩИТА ОТ ДВОЙНЫХ НАЖАТИЙ - блокируем кнопку если уже идет процесс
    // Это критично для работы с большим количеством пользователей
    if (isStoppingRef.current || loadingRef.current) {
      return;
    }
    
    if (startedRef.current) {
      // STOP
      isStoppingRef.current = true;
      startedRef.current = false;
      setStarted(false);
      setLoading(false);
      loadingRef.current = false;
      setMicLevel(0);
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
        Alert.alert('Разрешения', 'Нет доступа к камере/микрофону');
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
        Alert.alert('Ошибка', 'Не удалось запустить камеру/микрофон');
      } finally {
        loadingRef.current = false;
      }
    }
  }, [requestPermissions]);
  
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
          Alert.alert('Ошибка', 'Не удалось перейти к следующему собеседнику');
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
  }, []);
  
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
    
    try {
      await sessionRef.current.flipCam();
    } catch (e) {
      logger.warn('[RandomChat] Error flipping camera', e);
    }
  }, [canRunAction]);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0;
  
  // КРИТИЧНО: Обновляем localRenderKey только при реальном изменении localStream (streamId) или camOn
  // Это предотвращает мерцание при next() - когда localStream остается тем же объектом
  // КРИТИЧНО: На iOS дополнительно проверяем изменение streamURL для принудительного обновления
  const prevStreamURLRef = useRef<string | null>(null);
  
  useEffect(() => {
    if (started && !isInactiveState && localStream) {
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
  
  // Утилиты для спикера
  const speakerTimersRef = useRef<any[]>([]);
  const speakerLastKickAtRef = useRef<number>(0);
  const clearSpeakerTimers = () => {
    speakerTimersRef.current.forEach((t) => clearTimeout(t));
    speakerTimersRef.current = [];
  };
  
  const forceSpeakerOnHard = useCallback(() => {
    // iOS Simulator: не трогаем аудио-сессию (часто ломается и спамит AQMEIO_HAL таймаутами)
    if (Platform.OS === 'ios' && !(Device as any)?.isDevice) return;

    const now = Date.now();
    // Не спамим дерганием аудио-роутинга — это может ронять WebRTC/LiveKit
    if (now - speakerLastKickAtRef.current < 2500) return;
    speakerLastKickAtRef.current = now;

    try { InCallManager.start({ media: 'video', ringback: '' }); } catch {}

    const kick = () => {
      try { (InCallManager as any).setForceSpeakerphoneOn?.('on'); } catch {}
      try { InCallManager.setForceSpeakerphoneOn?.(true as any); } catch {}
      try { InCallManager.setSpeakerphoneOn(true); } catch {}
      try { (mediaDevices as any)?.setSpeakerphoneOn?.(true); } catch {}
      try { (InCallManager as any).setBluetoothScoOn?.(false); } catch {}
    };

    kick();
    // Один мягкий ретрай (без 4 таймеров подряд)
    speakerTimersRef.current.push(setTimeout(kick, 250));
  }, []);
  
  const stopSpeaker = useCallback(() => {
    clearSpeakerTimers();
    try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
    try { InCallManager.setSpeakerphoneOn(false); } catch {}
    try { InCallManager.stop(); } catch {}
  }, []);
  
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
    } catch (e) {
      logger.error('[RandomChat] Error resetting state in forceStopRandomChat:', e);
    }
  }, [stopSpeaker]);
  
  // Обработка AppState - для рандомного чата останавливаем при уходе в фон
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      try {
        if (nextAppState === 'background') {
          // КРИТИЧНО: При переходе в фон останавливаем чат, чтобы предотвратить проблемы с WebRTC/LiveKit.
          // Но НЕ останавливаем на 'inactive' — iOS часто уходит в inactive на доли секунды (Control Center, переходы),
          // из-за чего ранее рвалось соединение и казалось, что "рандом чат не работает".
          if (startedRef.current || loadingRef.current) {
            logger.info('[RandomChat] AppState changed to background, stopping chat');
            forceStopRandomChat();
          }
        } else if (nextAppState === 'inactive') {
          // iOS: просто отмечаем состояние, но не рвем соединение
          setIsInactiveState(true);
        } else if (nextAppState === 'active') {
          setIsInactiveState(false);
          // При возврате в активное состояние включаем динамик если есть удаленный стрим
          if (remoteStream) {
            try {
              forceSpeakerOnHard();
            } catch (e) {
              logger.warn('[RandomChat] Error enabling speaker on app active:', e);
            }
          }
        }
      } catch (e) {
        logger.error('[RandomChat] Error handling AppState change:', e);
      }
    });
    
    return () => {
      sub.remove();
    };
  }, [remoteStream, forceSpeakerOnHard, forceStopRandomChat]);
  
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
      forceSpeakerOnHard();
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
  }, [remoteStream, localStream, started, forceSpeakerOnHard]);
  
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
    // Слушаем входящие звонки только когда в неактивном состоянии
    const offIncoming = onCallIncoming?.((d) => {
      if (!started || isInactiveState) {
        logger.info('[RandomChat] Incoming call received', { callId: d.callId, from: d.from });
        setIncomingCall(d);
      }
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
        edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
      >
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
            
            // Получаем актуальное состояние видео трека
            const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
            // КРИТИЧНО: Проверяем muted состояние трека напрямую из MediaStreamTrack
            // LiveKit обновляет это состояние при TrackMuted/TrackUnmuted событиях
            // КРИТИЧНО: Локальное состояние камеры (camOn) НЕ должно влиять на эти значения
            const videoTrackEnabled = vt?.enabled ?? false;
            // КРИТИЧНО: muted может быть true когда удаленный пользователь выключил свою камеру
            // Это состояние определяется ТОЛЬКО состоянием удаленного трека, не локальной камеры
            const videoTrackMuted = vt?.muted ?? false;
            const videoTrackReadyState = vt?.readyState ?? 'new';
            const isFriendCall = false; // Для рандомного чата всегда false
            const hasVideoTrack = !!vt;
            const isTrackLive = videoTrackReadyState === 'live';
            
            // КРИТИЧНО: Логируем состояние для отладки
            // КРИТИЧНО: Локальное состояние камеры (camOn) НЕ влияет на отображение удаленного видео
            logger.debug('[RandomChat] Remote video track state', {
              hasVideoTrack,
              videoTrackEnabled,
              videoTrackMuted,
              videoTrackReadyState,
              isTrackLive,
              localCamOn: camOn, // Только для отладки, НЕ используется в логике
            });
            
            
            // Если нет соединения (нет потока), показываем лоадер при поиске или текст "Собеседник"
            if (!remoteStream) {
              if (started) {
                return <ActivityIndicator size="large" color="#fff" />;
              }
              return <AwayPlaceholder />;
            }
            
            // КРИТИЧНО: Упрощенная и надежная логика отображения (LiveKit)
            // Показываем видео только если трек live, enabled и не muted.
            // КРИТИЧНО: Локальное состояние камеры (camOn) НЕ влияет на показ удаленного видео
            if (!vt) {
              // Нет видео трека - проверяем состояние камеры партнера
              // КРИТИЧНО: Если камера партнера выключена (remoteCamEnabled === false), сразу показываем заглушку
              // Лоадер показываем только если камера включена, но трек еще не получен (установка соединения)
              const streamReceivedAt = remoteStreamReceivedAtRef.current;
              const isRecentlyReceived = streamReceivedAt && (Date.now() - streamReceivedAt) < 5000;
              
              // КРИТИЧНО: Если камера партнера выключена, сразу показываем заглушку
              // Не ждем 2 секунды, так как видео трека точно не будет
              if (remoteCamEnabled === false) {
                logRemoteRenderState('no-video-track-camera-off', {
                  remoteStreamId: remoteStream?.id,
                  hasRemoteStream: !!remoteStream,
                  remoteCamEnabled: false,
                  timeSinceReceived: streamReceivedAt ? Date.now() - streamReceivedAt : null,
                });
                return <AwayPlaceholder />;
              }
              
              // Камера включена, но видео трека еще нет - это может быть при установке соединения
              // Показываем лоадер только если стрим получен недавно (< 5000ms)
              if (isRecentlyReceived && remoteStream) {
                // Стрим только что получен и камера включена - показываем загрузку
                // Это предотвращает мерцание "Отошел" при установке соединения
                logRemoteRenderState('no-video-track-warming-up', {
                  remoteStreamId: remoteStream?.id,
                  hasRemoteStream: !!remoteStream,
                  remoteCamEnabled: true,
                  timeSinceReceived: Date.now() - (streamReceivedAt || 0),
                });
                return <ActivityIndicator size="large" color="#fff" />;
              }
              
              // Нет видео трека и прошло достаточно времени - показываем заглушку "Отошел"
              // Это означает что трек не был получен в течение 5 секунд
              logRemoteRenderState('no-video-track-timeout', {
                remoteStreamId: remoteStream?.id,
                hasRemoteStream: !!remoteStream,
                remoteCamEnabled,
                timeSinceReceived: streamReceivedAt ? Date.now() - streamReceivedAt : null,
              });
              return <AwayPlaceholder />;
            }

            if (!isTrackLive) {
              // Трек не live - проверяем, не выключена ли камера
              // КРИТИЧНО: Если трек muted или disabled, камера выключена - показываем заглушку
              const isCameraOff = videoTrackMuted === true || videoTrackEnabled === false;
              
              if (isCameraOff) {
                // Камера партнера выключена - сразу показываем заглушку
                logRemoteRenderState('video-track-not-live-camera-off', {
                  remoteStreamId: remoteStream?.id,
                  trackId: vt.id,
                  readyState: vt.readyState,
                  videoTrackEnabled,
                  videoTrackMuted,
                });
                return <AwayPlaceholder />;
              }
              
              // Трек не live, но камера включена - показываем индикатор загрузки
              logRemoteRenderState('video-track-not-live', {
                remoteStreamId: remoteStream?.id,
                trackId: vt.id,
                readyState: vt.readyState,
              });
              return <ActivityIndicator size="large" color="#fff" />;
            }

            // КРИТИЧНО: Показываем видео только если трек live, enabled и не muted
            // Когда удаленный пользователь выключает камеру через unpublishTrack(), трек становится unavailable
            // и мы показываем заглушку "Отошел"
            // КРИТИЧНО: Локальное состояние камеры (camOn) НЕ влияет на это решение
            // Выключение локальной камеры НЕ должно влиять на отображение удаленного видео
            // КРИТИЧНО: Используем более терпимую проверку enabled - если enabled не false, считаем что трек активен
            // Это важно при установке соединения, когда enabled может быть еще не установлен
            const canShowVideo = isTrackLive && videoTrackEnabled !== false && videoTrackMuted !== true;
            
            if (canShowVideo && remoteStream) {
              // КРИТИЧНО: На iOS иногда toURL() может вернуть пустое значение для remote MediaStream,
              // хотя трек уже подписан. В этом случае используем stream.id как fallback, иначе UI застревает на лоадере.
              const streamURL = remoteStream.toURL?.() || remoteStream.id;
              const rtcViewKey = `remote-${remoteStream.id}-${remoteViewKey}`;
              logRemoteRenderState('render-video', {
                platform: Platform.OS,
                streamId: remoteStream.id,
                hasStreamURL: !!streamURL,
                videoTrackReady: isTrackLive,
                videoTrackEnabled,
                videoTrackMuted,
                rtcViewKey,
              });
              
              // КРИТИЧНО: На Android используем prop `stream` для лучшей производительности
              // На iOS используем только streamURL (stream prop не поддерживается)
              if (Platform.OS === 'android') {
                // Android: всегда используем stream prop
                // Используем явное приведение типа для обхода проверки TypeScript
                const rtcViewProps: any = { 
                  stream: remoteStream, 
                  streamURL, 
                  renderToHardwareTextureAndroid: true, 
                  zOrderMediaOverlay: true 
                };
                
                return (
                  <RTCView
                    key={rtcViewKey}
                    {...(rtcViewProps as any)}
                    style={styles.rtc}
                    objectFit="cover"
                    mirror={false}
                    zOrder={1}
                  />
                );
              } else {
                // iOS: используем только streamURL (обязательно должен быть)
                // КРИТИЧНО: На iOS важно использовать уникальный key для принудительного обновления
                if (streamURL) {
                  return (
                    <RTCView
                      key={rtcViewKey}
                      streamURL={streamURL}
                      style={styles.rtc}
                      objectFit="cover"
                      mirror={false}
                      zOrder={1}
                    />
                  );
                } else {
                  // На iOS streamURL обязателен, но если его нет — не показываем вечный лоадер.
                  // Показываем лоадер только первые несколько секунд после получения remoteStream.
                  const streamReceivedAt = remoteStreamReceivedAtRef.current;
                  const isRecentlyReceived = streamReceivedAt && (Date.now() - streamReceivedAt) < 5000;
                  logger.warn('[RandomChat] iOS: streamURL unavailable, showing loading indicator', {
                    streamId: remoteStream.id,
                    isRecentlyReceived,
                  });
                  return isRecentlyReceived ? (
                    <ActivityIndicator size="large" color="#fff" />
                  ) : (
                    <AwayPlaceholder />
                  );
                }
              }
            } else {
              // КРИТИЧНО: Показываем заглушку "Отошел" когда удаленное видео недоступно
              // (трек disabled, muted или не live)
              // КРИТИЧНО: Это происходит ТОЛЬКО когда удаленный пользователь выключил свою камеру
              // Локальное состояние камеры (camOn) НЕ влияет на это решение
              // КРИТИЧНО: Если трек muted или disabled, сразу показываем заглушку (камера выключена)
              // Лоадер показываем только если трек еще не готов (не live) и стрим только что получен
              const streamReceivedAt = remoteStreamReceivedAtRef.current;
              const isRecentlyReceived = streamReceivedAt && (Date.now() - streamReceivedAt) < 5000;
              
              // КРИТИЧНО: Если трек muted или disabled, это означает что камера выключена
              // В этом случае сразу показываем заглушку, не ждем
              const isCameraOff = videoTrackMuted === true || videoTrackEnabled === false;
              
              if (isCameraOff) {
                // Камера партнера выключена - сразу показываем заглушку
                logRemoteRenderState('video-camera-off', {
                  streamId: remoteStream?.id,
                  hasStream: !!remoteStream,
                  isTrackLive,
                  videoTrackEnabled,
                  videoTrackMuted,
                });
                return <AwayPlaceholder />;
              }
              
              // Трек не muted и enabled, но не готов к показу
              // Если трек только что получен и еще не live, показываем лоадер
              // КРИТИЧНО: Увеличиваем таймаут до 5 секунд для установки соединения
              // streamReceivedAt уже объявлен выше
              if (isRecentlyReceived && !isTrackLive) {
                // Трек только что получен и еще не готов - показываем загрузку
                // Это предотвращает мерцание "Отошел" при установке соединения
                logRemoteRenderState('video-track-warming-up', {
                  streamId: remoteStream?.id,
                  hasStream: !!remoteStream,
                  isTrackLive,
                  videoTrackEnabled,
                  videoTrackMuted,
                  timeSinceReceived: Date.now() - (streamReceivedAt || 0),
                });
                return <ActivityIndicator size="large" color="#fff" />;
              }
              
              // Трек не готов и прошло достаточно времени - показываем заглушку
              logRemoteRenderState('video-not-renderable', {
                streamId: remoteStream?.id,
                hasStream: !!remoteStream,
                isTrackLive,
                videoTrackEnabled,
                videoTrackMuted,
                isRecentlyReceived,
              });
              return <AwayPlaceholder />;
            }
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
        
        {/* Эквалайзер */}
        <View style={styles.eqWrapper}>
          <VoiceEqualizer
            level={(() => {
              // Эквалайзер активен только при активном звонке и включенном микрофоне
              const eqActive = (!!partnerId || !!roomId) && micOn && !isInactiveState;
              return eqActive ? micLevel : 0;
            })()}
            frequencyLevels={(() => {
              const eqActive = (!!partnerId || !!roomId) && micOn && !isInactiveState;
              return eqActive ? micFrequencyLevels : new Array(21).fill(0);
            })()}
            mode="waveform"
            width={220}
            height={30}
            bars={21}
            gap={8}
            minLine={4}
            threshold={0.006}
            sensitivity={2.4}
            colors={isDark ? ["#F4FFFF", "#2EE6FF", "#F4FFFF"] : ["#FFE6E6", "rgb(58, 11, 160)", "#FFE6E6"]}
          />
        </View>
        
        {/* Карточка "Вы" */}
        <View style={styles.card}>
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
              // КРИТИЧНО: Используем localStream из state, но если он невалидный, пробуем ref
              // Это предотвращает черный экран во время пересоздания треков при next()
              const displayStream = (localStream && isValidStream(localStream)) 
                ? localStream 
                : (localStreamRef.current && isValidStream(localStreamRef.current))
                  ? localStreamRef.current
                  : null;
              
              if (displayStream) {
                // Безопасно получаем streamURL с проверкой на null/undefined
                const localStreamURL = displayStream.toURL?.();
                // КРИТИЧНО: Используем комбинацию streamId, camOn и localRenderKey для принудительного обновления
                // Это гарантирует, что видео обновится при включении камеры
                // КРИТИЧНО для iOS: Добавляем timestamp в key для гарантированного обновления RTCView
                const localRtcViewKey = Platform.OS === 'ios' 
                  ? `local-${displayStream.id}-${camOn}-${localRenderKey}-${localStreamTimestampRef.current}`
                  : `local-${displayStream.id}-${camOn}-${localRenderKey}`;
                
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
                  ? { 
                      stream: displayStream, 
                      streamURL: localStreamURL, 
                      renderToHardwareTextureAndroid: true, 
                      zOrderMediaOverlay: true 
                    } as any
                  : { streamURL: localStreamURL! }; // iOS: используем streamURL
                
                if (localStreamURL || Platform.OS === 'android') {
                  return (
                    <RTCView
                      key={localRtcViewKey}
                      {...localRtcViewProps}
                      style={styles.rtc}
                      objectFit="cover"
                      mirror
                      zOrder={0}
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
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={styles.iconBtn}
                >
                  <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
                </TouchableOpacity>
              </Animated.View>
              
              {/* Кнопки микрофона и камеры (снизу) */}
              <Animated.View style={[styles.bottomOverlay, { opacity: buttonsOpacity }]}>
                <TouchableOpacity
                  onPress={toggleMic}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  activeOpacity={0.7}
                  style={styles.iconBtn}
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
        
        {/* Кнопки снизу: Начать/Стоп и Далее */}
        <View style={styles.bottomRow}>
          <TouchableOpacity
            style={[
              styles.bigBtn,
              started ? styles.btnDanger : styles.btnTitan,
              isInactiveState && styles.disabled
            ]}
            disabled={isInactiveState}
            onPress={isInactiveState ? undefined : onStartStop}
          >
            <Text style={styles.bigBtnText}>
              {started ? L('stop') : L('start')}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.bigBtn,
              styles.btnTitan,
              (!started || isNexting || isInactiveState || loading) && styles.disabled
            ]}
            disabled={!started || isNexting || isInactiveState || loading}
            onPress={onNext}
          >
            <Text style={styles.bigBtnText}>
              {L('next')}
            </Text>
          </TouchableOpacity>
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
              {incomingFriendNick 
                ? `Пользователь ${incomingFriendNick} хочет добавить вас в друзья.`
                : `Пользователь (${incomingFriendFrom || ''}) хочет добавить вас в друзья.`}
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
          <View style={[StyleSheet.absoluteFill, { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.5)' }]} />
          <View style={styles.incomingOverlayContent}>
            <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View style={buildIncomingWaveStyle(incomingWaveA, 'left')} />
              <Animated.View style={buildIncomingWaveStyle(incomingWaveB, 'right')} />
              <Animated.View style={incomingCallIconStyle}>
                <MaterialIcons name="call" size={48} color="#4FC3F7" />
              </Animated.View>
            </View>
            <Text style={styles.incomingOverlayTitle}>Входящий вызов</Text>
            <Text style={styles.incomingOverlayName}>{incomingCall.fromNick || 'Друг'}</Text>
            <View style={styles.incomingOverlayButtons}>
              <TouchableOpacity
                onPress={handleAcceptIncomingCall}
                style={[styles.btnGlassBase, styles.btnGlassSuccess]}
              >
                <Text style={styles.modalBtnText}>Принять</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleDeclineIncomingCall}
                style={[styles.btnGlassBase, styles.btnGlassDanger]}
              >
                <Text style={styles.modalBtnText}>Отклонить</Text>
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
    alignItems: "center",
    justifyContent: Platform.OS === "ios" ? "flex-start" : "center",
    ...(Platform.OS === "android" ? { 
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
      paddingTop: 10,
    } : { paddingTop: 0 }),
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
    // КРИТИЧНО: Отключаем оптимизации, которые могут блокировать обновление видео
    ...(Platform.OS === 'android' ? {
      // На Android не используем shouldRasterizeIOS, так как это iOS-специфичное свойство
    } : {
      // На iOS можно добавить дополнительные оптимизации если нужно
    }),
  },
  placeholder: {
    color: 'rgba(237,234,234,0.6)',
    fontSize: 22,
  },
  bottomRow: {
    width: Platform.OS === "android" ? '94%' : '93%',
    flexDirection: 'row',
    gap: Platform.OS === "android" ? 14 : 16,
    marginTop: Platform.OS === "android" ? 6 : 10,
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
  },
  iconBtnDisabled: {
    opacity: 0.4,
  },
  topLeft: {
    position: 'absolute',
    top: 10,
    left: 10,
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
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
