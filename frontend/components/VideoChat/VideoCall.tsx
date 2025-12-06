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
  AppState,
  BackHandler,
  Modal,
  Easing,
  ActivityIndicator,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { CommonActions } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MediaStream, RTCView } from 'react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { VideoCallSession } from '../../src/webrtc/sessions/VideoCallSession';
import type { WebRTCSessionConfig } from '../../src/webrtc/types';
import { VideoView } from './shared/VideoView';
import { MediaControls } from './shared/MediaControls';
import VoiceEqualizer from '../VoiceEqualizer';
import AwayPlaceholder from '../AwayPlaceholder';
import { t, loadLang, defaultLang } from '../../utils/i18n';
import type { Lang } from '../../utils/i18n';
import { useAppTheme } from '../../theme/ThemeProvider';
import { isValidStream } from '../../utils/streamUtils';
import { logger } from '../../utils/logger';
import InCallManager from 'react-native-incall-manager';
import { usePiP } from '../../src/pip/PiPContext';
import { fetchFriends, acceptCall, declineCall, onCallIncoming, onCallCanceled } from '../../sockets/socket';
import socket from '../../sockets/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mediaDevices } from 'react-native-webrtc';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../../utils/keepAwake';

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

// Утилиты для спикера
let _speakerTimers: any[] = [];
const clearSpeakerTimers = () => {
  _speakerTimers.forEach(t => clearTimeout(t));
  _speakerTimers = [];
};

const configureIOSAudioSession = () => {
  if (Platform.OS !== 'ios') return;
  try {
    const webrtcMod = require('react-native-webrtc');
    const RTCAudioSession = webrtcMod?.RTCAudioSession;
    if (!RTCAudioSession || typeof RTCAudioSession.sharedInstance !== 'function') return;
    const s = RTCAudioSession.sharedInstance();
    s.setCategory('PlayAndRecord', {
      defaultToSpeaker: true,
      allowBluetooth: true,
      allowBluetoothA2DP: true,
      mixWithOthers: false,
    });
    s.setMode('VideoChat');
    s.setActive(true);
    const poke = () => { try { s.overrideOutputAudioPort('speaker'); } catch {} };
    poke();
    _speakerTimers.push(setTimeout(poke, 80));
    _speakerTimers.push(setTimeout(poke, 200));
  } catch {}
};

const forceSpeakerOnHard = () => {
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

  configureIOSAudioSession();
};

const stopSpeaker = () => {
  clearSpeakerTimers();
  try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
  try { InCallManager.setSpeakerphoneOn(false); } catch {}
  try { InCallManager.stop(); } catch {}
};

const VideoCall: React.FC<Props> = ({ route }) => {
  const navigation = useNavigation();
  const { theme, isDark } = useAppTheme();
  const pip = usePiP();
  const pipRef = useRef(pip);
  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);
  
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
  
  // Входящий звонок
  const [incomingFriendCall, setIncomingFriendCall] = useState<{ from: string; nick?: string } | null>(null);
  const [incomingCall, setIncomingCall] = useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const [incomingOverlay, setIncomingOverlay] = useState<boolean>(false);
  const currentCallIdRef = useRef<string | null>(route?.params?.callId || null);
  
  // Анимация входящего звонка
  const callShake = useRef(new Animated.Value(0)).current;
  const waveA = useRef(new Animated.Value(0)).current;
  const waveB = useRef(new Animated.Value(0)).current;
  
  const callIconStyle = {
    transform: [
      {
        translateX: callShake.interpolate({ inputRange: [0, 1, 2, 3, 4], outputRange: [0, -6, 6, -3, 0] })
      }
    ]
  };
  
  const waveS = (val: Animated.Value, dir: 'left' | 'right') => ({
    position: 'absolute' as const,
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    opacity: val.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
    transform: [
      { scale: val.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.35] }) },
      { translateX: dir === 'left' ? -30 : 30 },
    ],
  });
  
  const startIncomingAnim = useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(callShake, { toValue: 1, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 2, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 3, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 4, duration: 80, useNativeDriver: true }),
        Animated.timing(callShake, { toValue: 0, duration: 80, useNativeDriver: true }),
        Animated.delay(300),
      ])
    ).start();
    
    const loop = (v: Animated.Value, delay: number) => {
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 1400, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      ).start();
    };
    loop(waveA, 0);
    loop(waveB, 400);
  }, [callShake, waveA, waveB]);
  
  const stopIncomingAnim = useCallback(() => {
    callShake.stopAnimation();
    waveA.stopAnimation();
    waveB.stopAnimation();
  }, [callShake, waveA, waveB]);
  
  // Refs
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const hadIncomingCallRef = useRef(false);
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
  
  // Session
  const sessionRef = useRef<VideoCallSession | null>(null);
  
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
  
  // Обработка входящих звонков через socket
  useEffect(() => {
    const offIncoming = onCallIncoming?.((d) => {
      // Фиксируем экран на момент входящего звонка, чтобы вернуть пользователя туда после завершения
      try {
        const nav = (global as any).__navRef;
        const state = nav?.getRootState?.();
        const idx = state?.index ?? 0;
        const routes = state?.routes || [];
        const cur = routes[idx];
        if (cur?.name) {
          callOriginRef.current = { name: cur.name, params: cur.params };
        }
      } catch {}
      
      setIncomingCall(d);
      setIncomingOverlay(true);
      setIncomingFriendCall({ from: d.from, nick: d.fromNick });
      hadIncomingCallRef.current = true;
      setFriendCallAccepted(false);
      startIncomingAnim();
    });
    
    return () => {
      offIncoming?.();
    };
  }, [startIncomingAnim]);
  
  // Функция увеличения счетчика пропущенных звонков
  const incMissed = useCallback(async (userId?: string | null) => {
    try {
      const key = 'missed_calls_by_user_v1';
      const raw = await AsyncStorage.getItem(key);
      const map = raw ? JSON.parse(raw) : {};
      const uid = String(userId || incomingFriendCall?.from || '');
      if (uid) {
        map[uid] = (map[uid] || 0) + 1;
        await AsyncStorage.setItem(key, JSON.stringify(map));
      }
    } catch {}
  }, [incomingFriendCall]);
  
  // Обработка отмены звонка
  useEffect(() => {
    const offCancel = onCallCanceled?.(async (d) => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!route?.params?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }
      
      // Отмена инициатором — закрыть оверлей и отметить пропущенный
      const from = d?.from ? String(d.from) : undefined;
      if (from && from !== String(myUserId || '')) {
        await incMissed(from);
      }
      
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingAnim();
    });
    
    return () => {
      offCancel?.();
    };
  }, [route?.params?.directCall, friendCallAccepted, myUserId, incMissed, stopIncomingAnim]);
  
  // Обработка таймаута звонка (call:timeout)
  useEffect(() => {
    const handleTimeout = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!route?.params?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }
      
      // Очищаем WebRTC состояние
      const session = sessionRef.current;
      if (session) {
        session.cleanupAfterFriendCallFailure?.('timeout');
      }
      
      const uid = incomingFriendCall?.from ? String(incomingFriendCall.from) : undefined;
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingAnim();
      if (uid) {
        incMissed(uid);
      }
      setFriendCallAccepted(false);
    };
    
    socket.on('call:timeout', handleTimeout);
    
    return () => {
      socket.off('call:timeout', handleTimeout);
    };
  }, [route?.params?.directCall, friendCallAccepted, incomingFriendCall, incMissed, stopIncomingAnim]);
  
  // Обработка "занят" (call:busy)
  useEffect(() => {
    const handleBusy = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!route?.params?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }
      
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingAnim();
      setFriendCallAccepted(false);
      
      // Очищаем WebRTC состояние при call:busy
      const session = sessionRef.current;
      if (session) {
        session.cleanupAfterFriendCallFailure?.('busy');
      }
      
      setPartnerUserId(null);
    };
    
    socket.on('call:busy', handleBusy);
    
    return () => {
      socket.off('call:busy', handleBusy);
    };
  }, [route?.params?.directCall, friendCallAccepted, stopIncomingAnim]);
  
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
  
  // Обработка call:declined через socket (дополнительно к session.on('callDeclined'))
  useEffect(() => {
    const handleDeclined = () => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = !!route?.params?.directCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }
      
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingAnim();
    };
    
    socket.on('call:declined', handleDeclined);
    
    return () => {
      socket.off('call:declined', handleDeclined);
    };
  }, [route?.params?.directCall, friendCallAccepted, stopIncomingAnim]);
  
  // Обработка declined block
  const declinedBlockRef = useRef<{ userId: string; until: number } | null>(null);
  const setDeclinedBlock = useCallback((userId: string, duration: number) => {
    declinedBlockRef.current = { userId, until: Date.now() + duration };
  }, []);
  const clearDeclinedBlock = useCallback(() => {
    declinedBlockRef.current = null;
  }, []);
  const getDeclinedBlock = useCallback(() => {
    const block = declinedBlockRef.current;
    if (block && Date.now() < block.until) {
      return block;
    }
    declinedBlockRef.current = null;
    return null;
  }, []);
  
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
  
  // Инициализация session и восстановление состояния звонка
  useEffect(() => {
    const isDirectCall = !!route?.params?.directCall;
    const isDirectInitiator = !!route?.params?.directInitiator;
    const resume = !!route?.params?.resume;
    const fromPiP = !!route?.params?.fromPiP;
    
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
        onCallIdChange: (id) => {
          setCallId(id);
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
      getIncomingFriendCall: () => incomingFriendCall,
      getHasIncomingCall: () => !!incomingFriendCall || !!incomingCall,
      sendCameraState: (toPartnerId?: string, enabled?: boolean) => {
        const session = sessionRef.current;
        if (session) {
          // sendCameraState вызывается через session
        }
      },
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
      setLocalStream(stream);
    });
    
    session.on('remoteStream', (stream) => {
      if (stream) {
        setRemoteStream(stream);
      } else {
        setRemoteStream(null);
      }
    });
    
    session.on('remoteViewKeyChanged', (key) => {
      setRemoteViewKey(key);
    });
    
    session.on('callEnded', () => {
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      setIncomingCall(null);
      stopIncomingAnim();
      
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
      hadIncomingCallRef.current = false;
      
      try {
        stopSpeaker();
      } catch {}
    });
    
    session.on('callAnswered', () => {
      setFriendCallAccepted(true);
      setIncomingOverlay(false);
      stopIncomingAnim();
    });
    
    session.on('callDeclined', () => {
      setIncomingFriendCall(null);
      setIncomingCall(null);
      setIncomingOverlay(false);
      stopIncomingAnim();
    });
    
    session.on('incomingCall', ({ callId: incomingCallId, fromUser, fromNick }) => {
      setIncomingFriendCall({ from: fromUser, nick: fromNick });
      if (incomingCallId) {
        setIncomingCall({ callId: incomingCallId, from: fromUser, fromNick });
        currentCallIdRef.current = incomingCallId;
      }
      setIncomingOverlay(true);
      startIncomingAnim();
      hadIncomingCallRef.current = true;
    });
    
    session.on('remoteState', ({ muted }) => {
      if (muted !== undefined) {
        setRemoteMuted(muted);
      }
    });
    
    return () => {
      // Cleanup при размонтировании
      try {
        socket.off('cam-toggle');
      } catch {}
      
      const session = sessionRef.current;
      if (session) {
        // Для видеозвонков не уничтожаем session если есть активный звонок и PiP
        const hasActiveCall = !!roomId || !!callId || !!partnerId;
        const keepAliveForPiP = hasActiveCall || pip.visible;
        
        if (!keepAliveForPiP) {
          session.removeAllListeners();
          session.destroy();
          sessionRef.current = null;
        }
      }
    };
  }, [route?.params, roomId, callId, partnerId, pip.visible]);
  
  // Обработка AppState - форсим спикер при активном звонке
  useEffect(() => {
    if (!remoteStream) return;
    
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') {
        forceSpeakerOnHard();
      }
    });
    
    return () => sub.remove();
  }, [remoteStream]);
  
  // Keep-awake для активного видеозвонка
  useEffect(() => {
    const hasActiveVideoCall = !!remoteStream && (
      remoteStream.getVideoTracks?.()?.length > 0 || 
      remoteStream.getAudioTracks?.()?.length > 0
    ) || (started && !!localStream);
    
    if (hasActiveVideoCall) {
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('[VideoCall] Failed to activate keep-awake:', e);
        });
      }
      
      // Форсим спикер
      forceSpeakerOnHard();
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
  
  // Обработка BackHandler - для видеозвонков показываем PiP
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState;
      
      if (hasActiveCall && !pip.visible) {
        // Показываем PiP вместо закрытия
        const partner = partnerUserId 
          ? friends.find(f => String(f._id) === String(partnerUserId))
          : null;
        
        let avatarUrl: string | undefined = undefined;
        if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
          const SERVER_CONFIG = require('../../src/config/server').SERVER_CONFIG;
          const serverUrl = SERVER_CONFIG.BASE_URL;
          avatarUrl = partner.avatar.startsWith('http') 
            ? partner.avatar 
            : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
        }
        
        pip.showPiP({
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
        
        const session = sessionRef.current;
        if (session) {
          session.enterPiP();
        }
        
        try {
          socket.emit('bg:entered', {
            callId: callId || roomId,
            partnerId: partnerUserId
          });
        } catch (e) {
          logger.warn('[VideoCall] Error emitting bg:entered:', e);
        }
        
        return true; // Предотвращаем закрытие
      }
      
      return false; // Разрешаем закрытие
    });
    
    return () => backHandler.remove();
  }, [roomId, callId, partnerId, isInactiveState, pip, friends, partnerUserId, micOn, remoteMuted, localStream, remoteStream, route?.params]);
  
  
  // Обработчики
  const onAbortCall = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    
    if (isInactiveState) return;
    
    try {
      // Сохраняем roomId и callId перед вызовом endCall
      const currentRoomId = roomId;
      const currentCallId = callId;
      
      // Устанавливаем roomId и callId в session если они есть
      if (currentRoomId && !session.getRoomId?.()) {
        // roomId устанавливается через callbacks, но на всякий случай
      }
      if (currentCallId && !session.getCallId?.()) {
        // callId устанавливается через callbacks
      }
      
      session.endCall();
      setIsInactiveState(true);
      
      // Навигация: используем callOriginRef если есть, иначе returnTo, иначе назад
      const origin = callOriginRef.current;
      if (origin) {
        try {
          (navigation as any).navigate(origin.name, origin.params);
        } catch (e) {
          navigation.goBack();
        }
      } else if (route?.params?.returnTo) {
        try {
          (navigation as any).navigate(route.params.returnTo.name, route.params.returnTo.params);
        } catch (e) {
          navigation.goBack();
        }
      } else {
        navigation.goBack();
      }
    } catch (e) {
      logger.error('[VideoCall] Error ending call:', e);
    }
  }, [isInactiveState, navigation, route?.params, roomId, callId]);
  
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
  const showFriendBadge = useMemo(() => {
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const isInactive = !!isInactiveState;
    const callEnded = !!wasFriendCallEnded;
    const hasActiveConnection = !!remoteStream;
    
    if (!hasPartnerUserId || !hasStarted || isInactive || callEnded || !hasActiveConnection) {
      return false;
    }
    
    return isPartnerFriend;
  }, [partnerUserId, friends, started, isInactiveState, wasFriendCallEnded, remoteStream, isPartnerFriend]);
  
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
            session.exitPiP();
            
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
        const hasActiveCall = (!!roomId || !!callId || !!partnerId) && !isInactiveState;
        const currentPip = pipRef.current;
        
        if (hasActiveCall && !currentPip.visible && !isInactiveState) {
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
          const session = sessionRef.current;
          if (session) {
            session.enterPiP();
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
    <SafeAreaView style={[styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }]}>
        {/* Карточка "Собеседник" */}
        <View style={styles.card}>
          {(() => {
            // КРИТИЧНО: Если звонок завершен (wasFriendCallEnded), также показываем только текст "Собеседник"
            if (wasFriendCallEnded) {
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
            const isFriendCall = true; // Для видеозвонка всегда true
            const hasVideoTrack = !!vt;
            const isTrackLive = videoTrackReadyState === 'live';
            
            // Если нет соединения (нет потока), показываем лоадер при загрузке или текст "Собеседник"
            if (!remoteStream) {
              if (loading && started) {
                return <ActivityIndicator size="large" color="#fff" />;
              } else {
                return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
            }
            
            // КРИТИЧНО: Если есть remoteStream, но трек еще не готов, показываем лоадер
            // но только для дружеских звонков и только если трек существует (не ended)
            if (isFriendCall && hasVideoTrack && !isTrackLive && videoTrackReadyState !== 'ended') {
              return <ActivityIndicator size="large" color="#fff" />;
            }
            
            // КРИТИЧНО: Для дружеских звонков показываем видео если трек live
            const hasLiveVideoTrack = vt && isTrackLive;
            const canShowVideo = hasLiveVideoTrack && isFriendCall;
            
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
            
            // КРИТИЧНО: Заглушка "Отошел" показывается ТОЛЬКО когда:
            // 1. Трек инициализирован (readyState === 'live' или 'ended')
            // 2. И камера выключена
            const isTrackInitialized = videoTrackReadyState === 'live' || videoTrackReadyState === 'ended';
            const isCameraOff = (videoTrackReadyState === 'live' && videoTrackEnabled === false && remoteCamOn === false) || videoTrackReadyState === 'ended';
            
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
          
          {/* Кнопка управления удаленным звуком */}
          {showControls && (
            <Animated.View style={[styles.topLeftAudio, { opacity: buttonsOpacity }]}>
              <TouchableOpacity
                onPress={toggleRemoteAudio}
                disabled={!remoteStream}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                activeOpacity={0.7}
                style={[styles.iconBtn, !remoteStream && styles.iconBtnDisabled]}
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
            </Animated.View>
          )}
          
          {/* Бейдж "Друг" */}
          {showFriendBadge && (
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
          {(() => {
            // КРИТИЧНО: После завершения звонка (isInactiveState или wasFriendCallEnded) 
            // показываем только текст "Вы", без видео, заглушек и кнопок
            if (isInactiveState || wasFriendCallEnded) {
              return <Text style={styles.placeholder}>{L("you")}</Text>;
            }
            
            // ВАЖНО: Показываем видео только если камера включена (camOn === true)
            if (shouldShowLocalVideo) {
              if (localStream && isValidStream(localStream)) {
                return (
                  <RTCView
                    key={`local-video-${localRenderKey}`}
                    streamURL={localStream.toURL()}
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
      <Modal
        visible={incomingOverlay}
        transparent
        animationType="fade"
        onRequestClose={() => {
          const callIdToDecline = incomingCall?.callId || currentCallIdRef.current || roomId;
          if (callIdToDecline) {
            declineCall(callIdToDecline);
          }
          setIncomingFriendCall(null);
          setIncomingCall(null);
          setIncomingOverlay(false);
          stopIncomingAnim();
        }}
      >
        <View style={styles.modalOverlay}>
          <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
          <View style={styles.modalCard}>
            <View style={{ alignItems: 'center' }}>
              <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                <Animated.View style={waveS(waveA, 'left')} />
                <Animated.View style={waveS(waveB, 'right')} />
                <Animated.View style={callIconStyle}>
                  <MaterialIcons name="call" size={48} color="#4FC3F7" />
                </Animated.View>
              </View>
              <Text style={styles.incomingTitle}>Входящий вызов</Text>
              <Text style={styles.incomingName}>
                {incomingFriendCall?.nick || `id: ${String(incomingFriendCall?.from || '').slice(0, 5)}`}
              </Text>
              <View style={styles.incomingButtons}>
                <TouchableOpacity
                  onPress={async () => {
                    const finalCallId = incomingCall?.callId || currentCallIdRef.current;
                    
                    // Устанавливаем флаги
                    setFriendCallAccepted(true);
                    setIsInactiveState(false);
                    setWasFriendCallEnded(false);
                    
                    // Принимаем вызов
                    if (finalCallId) {
                      acceptCall(finalCallId);
                    }
                    
                    // Устанавливаем partnerUserId
                    if (incomingFriendCall?.from) {
                      setPartnerUserId(incomingFriendCall.from);
                    }
                    
                    // Уведомляем друзей что мы заняты
                    try {
                      socket.emit('presence:update', { status: 'busy', roomId: roomId });
                    } catch (e) {
                      logger.warn('[VideoCall] Failed to send presence update:', e);
                    }
                    
                    // Отправляем состояние камеры
                    setTimeout(() => {
                      sendCameraState();
                    }, 100);
                    
                    // Создаем локальный стрим
                    const session = sessionRef.current;
                    if (session) {
                      try {
                        const stream = await session.startLocalStream('front');
                        if (stream) {
                          setCamOn(true);
                          setMicOn(true);
                        }
                      } catch (e) {
                        logger.error('[VideoCall] Failed to get local stream:', e);
                      }
                    }
                    
                    // Сбрасываем счётчик пропущенных
                    try {
                      const key = 'missed_calls_by_user_v1';
                      const raw = await AsyncStorage.getItem(key);
                      const map = raw ? JSON.parse(raw) : {};
                      const uid = String(incomingCall?.from || incomingFriendCall?.from || '');
                      if (uid) {
                        map[uid] = 0;
                        await AsyncStorage.setItem(key, JSON.stringify(map));
                      }
                    } catch {}
                    
                    // Закрываем оверлей
                    setTimeout(() => {
                      setIncomingOverlay(false);
                      stopIncomingAnim();
                    }, 50);
                  }}
                  style={[styles.btnGlassBase, styles.btnGlassSuccess]}
                >
                  <Text style={styles.modalBtnText}>Принять</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => {
                    const callIdToDecline = incomingCall?.callId || currentCallIdRef.current || roomId;
                    if (callIdToDecline) {
                      declineCall(callIdToDecline);
                    }
                    setDeclinedBlock(incomingCall?.from || incomingFriendCall?.from || '', 12000);
                    setIncomingFriendCall(null);
                    setIncomingCall(null);
                    setIncomingOverlay(false);
                    stopIncomingAnim();
                  }}
                  style={[styles.btnGlassBase, styles.btnGlassDanger]}
                >
                  <Text style={styles.modalBtnText}>Отклонить</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>
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

