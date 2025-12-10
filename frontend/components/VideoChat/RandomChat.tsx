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
import { MediaStream, mediaDevices, RTCView } from 'react-native-webrtc';
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
import { fetchFriends, requestFriend, respondFriend, onFriendRequest, onFriendAdded, onFriendAccepted, onFriendDeclined } from '../../sockets/socket';
import socket from '../../sockets/socket';
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
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [remoteMuted, setRemoteMuted] = useState(false);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  const [localRenderKey, setLocalRenderKey] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [isInactiveState, setIsInactiveState] = useState(false);
  const [buttonsOpacity] = useState(new Animated.Value(0));
  
  // Toast уведомления
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  
  // Session
  const sessionRef = useRef<RandomChatSession | null>(null);
  
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
    
    const offAccepted = onFriendAccepted?.(({ userId }) => {
      setAddPending(false);
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) {
        showToast('Добавили в друзья');
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
      if (res?.status === 'pending') {
        showToast('Заявка отправлена');
      } else if (res?.status === 'already') {
        setAddPending(false);
        setAddBlocked(true);
        try {
          const r: any = await fetchFriends();
          setFriends(r?.list || []);
        } catch {}
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
            setCamOn(videoTrack?.enabled ?? true);
            setMicOn(audioTrack?.enabled ?? true);
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
          setRemoteCamOn(enabled);
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
      if (stream) {
        setRemoteStream(stream);
        // Сбрасываем состояние muted при получении нового стрима
        setRemoteMuted(false);
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
      
      if (hasRemoteStream && pc && pc.signalingState !== 'closed' && (pc as any).connectionState !== 'closed') {
        const isPcActive = pc.iceConnectionState === 'checking' || 
                          pc.iceConnectionState === 'connected' || 
                          pc.iceConnectionState === 'completed' ||
                          (pc as any).connectionState === 'connecting' ||
                          (pc as any).connectionState === 'connected';
        
        if (isPcActive) {
          return;
        }
      }
      
      setRemoteStream(null);
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
      session.next();
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
      sessionRef.current?.toggleCam();
    } finally {
      setTimeout(() => {
        toggleCamRef.current = false;
      }, 300);
    }
  }, []);
  
  // Вычисляемые значения
  const hasActiveCall = !!partnerId || !!roomId;
  const shouldShowLocalVideo = camOn && !isInactiveState;
  const shouldShowRemoteVideo = remoteCamOn && !isInactiveState;
  const micLevelForEqualizer = micOn && !isInactiveState ? micLevel : 0;
  
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
    setRemoteCamOn(true);
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
        edges={Platform.OS === 'android' ? [] : undefined}
      >
        {/* Карточка "Собеседник" */}
        <View style={styles.card}>
          {(() => {
            // КРИТИЧНО: Если поиск остановлен (started=false), всегда показываем "Собеседник"
            if (!started) {
              return <Text style={styles.placeholder}>{L("peer")}</Text>;
            }
            
            // В неактивном состоянии ВСЕГДА показываем только текст "Собеседник"
            if (isInactiveState) {
              return <Text style={styles.placeholder}>{L("peer")}</Text>;
            }
            
            // Получаем актуальное состояние видео трека
            const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
            const videoTrackEnabled = vt?.enabled ?? false;
            const videoTrackReadyState = vt?.readyState ?? 'new';
            const isFriendCall = false; // Для рандомного чата всегда false
            const hasVideoTrack = !!vt;
            const isTrackLive = videoTrackReadyState === 'live';
            
            // Если нет соединения (нет потока), показываем лоадер при поиске или текст "Собеседник"
            if (!remoteStream) {
              if (loading && started) {
                return <ActivityIndicator size="large" color="#fff" />;
              } else {
                return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
            }
            
            // Для рандомного чата требуем оба условия: remoteCamOn === true И videoTrackEnabled === true
            const hasLiveVideoTrack = vt && isTrackLive;
            const canShowVideo = hasLiveVideoTrack && (remoteCamOn === true && videoTrackEnabled === true);
            
            if (canShowVideo) {
              const streamURL = remoteStream.toURL?.();
              return (
                <RTCView
                  key={`remote-${remoteStream.id}-${remoteViewKey}`}
                  streamURL={streamURL}
                  style={styles.rtc}
                  objectFit="cover"
                  mirror={false}
                />
              );
            }
            
            // Заглушка "Отошел" показывается ТОЛЬКО когда:
            // 1. Трек инициализирован (readyState === 'live' или 'ended')
            // 2. И камера выключена (remoteCamOn === false или videoTrackEnabled === false)
            const isTrackInitialized = videoTrackReadyState === 'live' || videoTrackReadyState === 'ended';
            const isCameraOff = remoteCamOn === false || videoTrackEnabled === false;
            
            if (isTrackInitialized && isCameraOff) {
              return <AwayPlaceholder />;
            }
            
            // Если трек еще не инициализирован, показываем лоадер
            if (!isTrackInitialized) {
              return <ActivityIndicator size="large" color="#fff" />;
            }
            
            // Fallback - показываем заглушку
            return <AwayPlaceholder />;
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
              const hasActiveCall = !!partnerId || !!roomId;
              const micReallyOn = micOn;
              return micReallyOn && !isInactiveState ? micLevel : 0;
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
            
            // ВАЖНО: Показываем видео только если камера включена (camOn === true)
            if (shouldShowLocalVideo) {
              if (localStream && isValidStream(localStream)) {
                // Безопасно получаем streamURL с проверкой на null/undefined
                const localStreamURL = localStream.toURL?.();
                if (!localStreamURL) {
                  return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
                }
                
                return (
                  <RTCView
                    key={`local-video-${localRenderKey}`}
                    streamURL={localStreamURL}
                    style={styles.rtc}
                    objectFit="cover"
                    mirror
                    zOrder={0}
                  />
                );
              } else {
                return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
              }
            } else {
              // КРИТИЧНО: В блоке "Вы" при выключении камеры всегда показываем надпись "Вы"
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
      paddingTop: 20,
      paddingBottom: 0,
      paddingLeft: 0,
      paddingRight: 0,
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
