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
import { fetchFriends, requestFriend, respondFriend, onFriendRequest, onFriendAdded, onFriendAccepted, onFriendDeclined, updateProfile } from '../../sockets/socket';
import socket from '../../sockets/socket';
import { syncMyStreamProfile } from '../../chat/cometchat';
import { loadProfileFromStorage } from '../../utils/profileStorage';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';

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
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [friends, setFriends] = useState<any[]>([]);
  const [addPending, setAddPending] = useState(false);
  const [addBlocked, setAddBlocked] = useState(false);
  const [friendModalVisible, setFriendModalVisible] = useState(false);
  const [incomingFriendFrom, setIncomingFriendFrom] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(0));
  const logRemoteRenderState = useCallback((reason: string, extra?: Record<string, unknown>) => {
    logger.info('[RandomChat] Remote render state', { reason, ...extra });
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
            setMicOn(audioTrack?.enabled ?? true);
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
        },
        onRoomIdChange: (id) => {
          setRoomId(id);
        },
        onMicStateChange: (enabled) => {
          setMicOn(enabled);
        },
        onCamStateChange: (enabled) => {
          setCamOn(enabled);
        },
        onRemoteCamStateChange: (enabled) => {
          // RandomChat (LiveKit): состояние камеры определяется по media tracks, не по отдельному флагу.
          // Оставляем callback, чтобы не ломать интерфейс WebRTCSessionConfig.
          void enabled;
        },
        onLoadingChange: (loading) => {
          setLoading(loading);
        },
        onMicLevelChange: (level) => {
          setMicLevel(boostMicLevel(level));
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
      setLocalStream(stream);
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
      setRemoteMuted(false);
      setRemoteViewKey((k: number) => k + 1);
    });
    
    session.on('searching', () => {
      setLoading(true);
      setIsInactiveState(false);
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
      
      try {
        stopSpeaker(); // Останавливаем спикер
        session.stopRandomChat();
        setLocalRenderKey(k => k + 1);
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
  
  const onNext = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      console.warn('[onNext] Session not initialized yet');
      return;
    }

    // КРИТИЧНО: ЗАЩИТА ОТ ДВОЙНЫХ НАЖАТИЙ - блокируем кнопку если уже идет процесс
    // ОПТИМИЗИРОВАНО: Уменьшено время блокировки с 1.5 секунд до 800ms для быстрого переключения
    if (isNexting) return;

    setIsNexting(true);

    try {
      // Используем session для перехода к следующему (ручной вызов)
      await session.next();
    } catch (e) {
      logger.error('[RandomChat] Error next:', e);
      Alert.alert('Ошибка', 'Не удалось перейти к следующему собеседнику');
    } finally {
      // ОПТИМИЗИРОВАНО: Уменьшено с 1500ms до 800ms для быстрого переключения между собеседниками
      setTimeout(() => {
        setIsNexting(false);
      }, 800);
    }
  }, [isNexting, started]);
  
  // Функция для переключения динамика собеседника
  const toggleRemoteAudio = useCallback(() => {
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
  }, []);
  
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
      }, 300);
    }
  }, []);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0;
  
  // КРИТИЧНО: Обновляем localRenderKey при изменении camOn или localStream для принудительного обновления RTCView
  useEffect(() => {
    if (started && !isInactiveState && localStream) {
      setLocalRenderKey(k => k + 1);
      logger.debug('[RandomChat] Updated localRenderKey due to camOn or localStream change', {
        camOn,
        hasLocalStream: !!localStream,
        videoTracksCount: localStream.getVideoTracks().length,
        streamId: localStream.id,
      });
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
  let _speakerTimers: any[] = [];
  const clearSpeakerTimers = () => {
    _speakerTimers.forEach(t => clearTimeout(t));
    _speakerTimers = [];
  };
  
  const forceSpeakerOnHard = useCallback(() => {
    try { InCallManager.start({ media: 'video', ringback: '' }); } catch {}

    const kick = () => {
      try { (InCallManager as any).setForceSpeakerphoneOn?.('on'); } catch {}
      try { InCallManager.setForceSpeakerphoneOn?.(true as any); } catch {}
      try { InCallManager.setSpeakerphoneOn(true); } catch {}
      try { (mediaDevices as any)?.setSpeakerphoneOn?.(true); } catch {}
      try { (InCallManager as any).setBluetoothScoOn?.(false); } catch {}
    };

    kick();
    _speakerTimers.push(setTimeout(kick, 120));
    _speakerTimers.push(setTimeout(kick, 350));
    _speakerTimers.push(setTimeout(kick, 800));
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
    }
  }, [partnerId, roomId, started]);
  
  const forceStopRandomChat = useCallback(() => {
    const session = sessionRef.current;
    try {
      session?.cleanup?.();
    } catch (e) {
      logger.error('[RandomChat] Error cleaning session on leave:', e);
    }
    sessionRef.current = null;
    
    startedRef.current = false;
    loadingRef.current = false;
    setStarted(false);
    setLoading(false);
    setIsInactiveState(true);
    setPartnerId(null);
    setPartnerUserId(null);
    setRoomId(null);
    setRemoteStream(null);
    setRemoteMuted(false);
    setCamOn(false);
    setMicOn(false);
    stopSpeaker();
  }, [stopSpeaker]);
  
  // Обработка AppState - для рандомного чата останавливаем при уходе в фон
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (startedRef.current || loadingRef.current) {
          forceStopRandomChat();
        }
      } else if (nextAppState === 'active') {
        if (remoteStream) {
          forceSpeakerOnHard();
        }
      }
    });
    
    return () => sub.remove();
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
              // Нет видео трека - показываем заглушку "Отошел" только если это действительно отсутствие удаленного видео
              // (не из-за выключения локальной камеры)
              logRemoteRenderState('no-video-track', {
                remoteStreamId: remoteStream?.id,
                hasRemoteStream: !!remoteStream,
              });
              return <AwayPlaceholder />;
            }

            if (!isTrackLive) {
              // Трек не live - показываем индикатор загрузки
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
            const canShowVideo = isTrackLive && videoTrackEnabled === true && videoTrackMuted !== true;
            
            if (canShowVideo && remoteStream) {
              const streamURL = remoteStream.toURL?.();
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
                  // На iOS streamURL обязателен, если его нет - показываем индикатор загрузки
                  logger.warn('[RandomChat] iOS: streamURL unavailable, showing loading indicator', {
                    streamId: remoteStream.id,
                  });
                  return <ActivityIndicator size="large" color="#fff" />;
                }
              }
            } else {
              // КРИТИЧНО: Показываем заглушку "Отошел" когда удаленное видео недоступно
              // (трек disabled, muted или не live)
              // КРИТИЧНО: Это происходит ТОЛЬКО когда удаленный пользователь выключил свою камеру
              // Локальное состояние камеры (camOn) НЕ влияет на это решение
              logRemoteRenderState('video-not-renderable', {
                streamId: remoteStream?.id,
                hasStream: !!remoteStream,
                isTrackLive,
                videoTrackEnabled,
                videoTrackMuted,
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
          {started && !isInactiveState && !!partnerUserId && !isPartnerFriend && (
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
              // КРИТИЧНО: Эквалайзер должен реагировать только на реальный звук
              // Показываем уровень только если:
              // 1. Соединение установлено (есть partnerId или roomId)
              // 2. Микрофон включен
              // 3. Не в неактивном состоянии
              // 4. Есть реальный уровень звука (micLevel > 0)
              const hasActiveCall = !!partnerId || !!roomId;
              const micReallyOn = micOn && !isInactiveState;
              const hasRealAudio = micLevel > 0;
              
              // Возвращаем уровень только если все условия выполнены
              return (hasActiveCall && micReallyOn && hasRealAudio) ? micLevel : 0;
            })()}
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
              if (localStream && isValidStream(localStream)) {
                // Безопасно получаем streamURL с проверкой на null/undefined
                const localStreamURL = localStream.toURL?.();
                // КРИТИЧНО: Используем комбинацию streamId, camOn и localRenderKey для принудительного обновления
                // Это гарантирует, что видео обновится при включении камеры
                const localRtcViewKey = `local-${localStream.id}-${camOn}-${localRenderKey}`;
                
                logger.debug('[RandomChat] Rendering local video', {
                  camOn,
                  hasLocalStream: !!localStream,
                  hasStreamURL: !!localStreamURL,
                  localRenderKey,
                  streamId: localStream.id,
                });
                
                // КРИТИЧНО: На Android используем prop `stream` для лучшей производительности
                // На iOS используем streamURL
                const localRtcViewProps = Platform.OS === 'android' 
                  ? { 
                      stream: localStream, 
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
                  logger.warn('[RandomChat] Local streamURL unavailable, showing black view');
                  return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
                }
              } else {
                logger.warn('[RandomChat] Local stream invalid or missing, showing black view', {
                  hasLocalStream: !!localStream,
                  isValid: localStream ? isValidStream(localStream) : false,
                });
                return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
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
                  onPress={() => sessionRef.current?.flipCam()}
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
                  disabled={!localStream}
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
              (!started || isNexting || isInactiveState) && styles.disabled
            ]}
            disabled={!started || isNexting || isInactiveState}
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
        onRequestClose={() => setFriendModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{L('friend_request')}</Text>
            <Text style={styles.modalText}>
              {L('friend_request_text')} {incomingFriendFrom || ''}
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
});

export default RandomChat;
