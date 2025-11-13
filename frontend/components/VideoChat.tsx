import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  PermissionsAndroid,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Animated,
  Alert,
  Modal,
  AppState,
  NativeModules,
  Easing,
  BackHandler,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';

// Отключаем debug логи WebRTC - показывают только рабочее состояние
if (!(global.console as any)._originalLog) {
  (global.console as any)._originalLog = console.log;
  (global.console as any).log = (...args: any[]) => {
    // Фильтруем WebRTC debug логи
    const message = args.join(' ');
    if (message.includes('rn-webrtc:pc:DEBUG')) {
      return;
    }
    (global.console as any)._originalLog(...args);
  };
}
import { CommonActions } from '@react-navigation/native';
import { MaterialIcons } from '@expo/vector-icons';
import { PanGestureHandler } from 'react-native-gesture-handler';
import { logger } from '../utils/logger';
import { BlurView } from 'expo-blur';
import { SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppTheme } from '../theme/ThemeProvider';
import {
  mediaDevices,
  RTCPeerConnection,
  RTCView,
  MediaStream,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import AwayPlaceholder from './AwayPlaceholder';
import VoiceEqualizer from './VoiceEqualizer';
import { usePiP } from '../src/pip/PiPContext';
import { t, loadLang, defaultLang } from '../utils/i18n';
import type { Lang } from '../utils/i18n';
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../App';

// === sockets (ваш проект) ===
import socket, {
  requestFriend,
  respondFriend,
  fetchFriends,
  onFriendRequest,
  onFriendAccepted,
  onPresenceUpdate,
  onFriendDeclined,
  onFriendAdded,
  createUser,
  getCurrentUserId,
  getMyProfile,
  onCallIncoming,
  acceptCall,
  declineCall,
  API_BASE,
  getMyUserId,
} from '../sockets/socket';
import { onCallCanceled } from '../sockets/socket';

// --------------------------
// Globals / setup
// --------------------------
const screenHeight = Dimensions.get('window').height;

const TURN_URL = process.env.EXPO_PUBLIC_TURN_URL || 'turn.yourdomain.com:5349';

const ICE_SERVERS = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302',
        'stun:stun4.l.google.com:19302',
        'stun:stun.stunprotocol.org:3478',
      ],
    },
    {
      urls: [
        `turn:${TURN_URL}?transport=udp`,
        `turn:${TURN_URL}?transport=tcp`,
        `turns:${TURN_URL.split(':')[0]}:443?transport=tcp`, // безопаснее
      ],
      username: process.env.EXPO_PUBLIC_TURN_USERNAME || 'user',
      credential: process.env.EXPO_PUBLIC_TURN_CREDENTIAL || 'pass',
    },
  ],
};

// Animated wrapper for SafeAreaView (для плавного свайпа)
const AnimatedSafeAreaView = Animated.createAnimatedComponent(SafeAreaView as any);


// --------------------------
// Types
// --------------------------
type CamSide = 'front' | 'back';
type Props = { route?: { params?: { myUserId?: string; peerUserId?: string; directCall?: boolean; directInitiator?: boolean; callId?: string; roomId?: string; returnTo?: { name: string; params?: any }, afterCallEnd?: boolean, returnToActiveCall?: boolean, mode?: 'friend', resume?: boolean, fromPiP?: boolean } } };

// --------------------------
// Audio routing helpers (speakerphone)
// --------------------------
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

const restoreAudioRoute = () => {
  clearSpeakerTimers();
  try { (InCallManager as any).setForceSpeakerphoneOn?.('auto'); } catch {}
  try { InCallManager.setSpeakerphoneOn(false); } catch {}
  try { InCallManager.stop(); } catch {}
};

const stopSpeaker = restoreAudioRoute;

// При возврате приложения на передний фронт повторно форсим спикер, если есть удалённый поток
const useSpeakerReapply = (remoteStream: MediaStream | null) => {
  useEffect(() => {
    if (!remoteStream) return;
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') forceSpeakerOnHard();
    });
    return () => sub.remove();
  }, [remoteStream]);
};

// --------------------------
// VideoChatContent Component (внутренний)
// --------------------------
interface VideoChatContentProps extends Props {
  onRegisterCallbacks: (callbacks: {
    returnToCall: () => void;
    endCall: () => void;
    toggleMic: () => void;
    toggleRemoteAudio: () => void;
  }) => void;
}

const VideoChatContent: React.FC<VideoChatContentProps> = ({ route, onRegisterCallbacks }) => {
  const pip = usePiP();
  // Убрали постоянный лог для уменьшения шума
  const { updatePiPState, localStream: pipLocalStream, remoteStream: pipRemoteStream } = pip;
  
  // Refs для стабильного доступа к pip функциям
  const pipRef = useRef(pip);
  useEffect(() => {
    pipRef.current = pip;
  }, [pip]);
  const navigation = useNavigation();
  const myUserId = route?.params?.myUserId;
  const initialPeerUserId = route?.params?.peerUserId;
  const isDirectCall = !!route?.params?.directCall;
  const isDirectInitiator = !!route?.params?.directInitiator;
  const initialCallId = route?.params?.callId; // ← Получаем callId из параметров
  const returnTo = route?.params?.returnTo;
  const resume = !!route?.params?.resume; // ← Флаг возобновления из PiP
  const fromPiP = !!route?.params?.fromPiP; // ← Флаг возврата из PiP
  const [inDirectCall, setInDirectCall] = useState<boolean>(isDirectCall);
  const inDirectCallRef = useRef(isDirectCall);
  useEffect(() => { inDirectCallRef.current = inDirectCall; }, [inDirectCall]);
  const insets = useSafeAreaInsets();
  const { theme, isDark } = useAppTheme();
  
  // включить видео-треки, если они были вырублены при показе PiP
  const enableVideoTracksIfAny = useCallback(() => {
    try {
      const lt = pipLocalStream?.getVideoTracks?.()[0];
      if (lt && !lt.enabled) {
        lt.enabled = true;
        // Логируем только при реальном включении
      }
      const rt = pipRemoteStream?.getVideoTracks?.()[0];
      if (rt && !rt.enabled) {
        rt.enabled = true;
        // Логируем только при реальном включении
      }
    } catch (e) {
      console.warn('[VideoChat] Error enabling video tracks:', e);
    }
  }, [pipLocalStream, pipRemoteStream]);
  
  // УДАЛЕНО: videoEngine - возвращаемся к оригинальному подходу без сторонних библиотек

  // DEPRECATED: remoteRender больше не используется
  const [localRender, setLocalRender] = useState<any>(null);
  
  useEffect(() => {
    if (!isDirectCall) {
      // DEPRECATED: remoteRender больше не используется
      setLocalRender(null);
      return;
    }

    // УДАЛЕНО: videoEngine interval - возвращаемся к оригинальному подходу
    // setLocalRender больше не используется
  }, [isDirectCall]);


  // Рендерим экран всегда; поведение для direct-call регулируется состояниями внутри
  const applyNavBarForVideo = useCallback(async () => {
    if (Platform.OS !== 'android' || !(NativeModules as any)?.ExpoNavigationBar) return;
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
  }, [theme.colors.background, isDark]);

  // Language state
  const [lang, setLang] = useState<Lang>(defaultLang);
  
  // Load language on mount
  useEffect(() => {
    (async () => {
      setLang(await loadLang());
      
      // Загружаем список друзей при инициализации
      try {
        const r = await fetchFriends();
        const friendsList = r?.list || [];
        setFriends(friendsList);
        logger.debug('Loaded friends on init', { count: friendsList.length });
      } catch (e) {
        logger.warn('Failed to load friends on init:', e);
      }
      
      // Загружаем профиль при инициализации
      try {
        const profileResponse = await getMyProfile();
        if (profileResponse?.ok && profileResponse.profile) {
          const profile = profileResponse.profile;
          logger.debug('Loaded profile on init', { nick: profile.nick });
          
          // Обновляем никнейм из backend
          if (profile.nick && typeof profile.nick === 'string') {
            // Здесь можно обновить никнейм если нужно
            logger.debug('Profile nick loaded:', profile.nick);
          }
        }
      } catch (e) {
        logger.warn('Failed to load profile on init:', e);
      }
    })();
  }, []);

  // Guard от повторных вызовов
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  const lastRouteParamsRef = useRef<any>(null);

  // Сбрасываем флаг when route params change
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

  // 3.1 Один раз регистрируем «фокус»/«уход со страницы»
  useFocusEffect(React.useCallback(() => {
    applyNavBarForVideo();

    // Guard: предотвращаем повторные вызовы
    if (focusEffectGuardRef.current) {
      console.log('[useFocusEffect] Guard: уже обрабатывается, пропускаем');
      return;
    }

    // Вернулись из PiP -> прячем PiP, включаем свои видео/спикер, стартуем VAD
    const isReturningFromPiP = route?.params?.resume && route?.params?.fromPiP && !fromPiPProcessedRef.current;
    
    if (isReturningFromPiP) {
      fromPiPProcessedRef.current = true;
      focusEffectGuardRef.current = true;
      
      console.log('[useFocusEffect] Возврат из PiP - обрабатываем');

      // Прячем PiP только при возврате из PiP
      if (pipRef.current.visible) {
        console.log('[useFocusEffect] Hiding PiP after return from PiP');
        pipRef.current.hidePiP();
        
        // Получаем roomId из route.params или ref
        const routeRoomId = (route?.params as any)?.roomId;
        const currentRoomId = roomIdRef.current || routeRoomId;
        
        // Отправляем партнеру что мы вернулись из PiP
        const isFriendCallActive = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        console.log('[useFocusEffect] Checking conditions for pip:state=false:', {
          isFriendCallActive,
          isDirectCall,
          inDirectCall: inDirectCallRef.current,
          friendCallAccepted: friendCallAcceptedRef.current,
          roomIdFromRef: roomIdRef.current,
          roomIdFromRoute: routeRoomId,
          currentRoomId,
          partnerId: partnerIdRef.current
        });
        
        if (isFriendCallActive && currentRoomId) {
          try {
            const payload: any = { 
              inPiP: false, 
              from: socket.id,
              roomId: currentRoomId
            };
            if (partnerIdRef.current) payload.to = partnerIdRef.current;
            socket.emit('pip:state', payload);
            console.log('[useFocusEffect] ✅ Sent pip:state=false to partner (returned from PiP):', { payload });
            
            // Отправляем повторно через 300мс (гарантия при гонке состояний)
            setTimeout(() => {
              try {
                socket.emit('pip:state', payload);
                console.log('[useFocusEffect] ✅ Re-sent pip:state=false (300ms retry)');
              } catch (e) {
                console.warn('[useFocusEffect] ❌ Error re-sending pip:state:', e);
              }
            }, 300);
          } catch (e) {
            console.warn('[useFocusEffect] ❌ Error sending pip:state:', e);
          }
        } else {
          console.log('[useFocusEffect] ⚠️ Not sending pip:state (return) - conditions not met:', { 
            isFriendCallActive,
            isDirectCall, 
            inDirectCall: inDirectCallRef.current, 
            friendCallAccepted: friendCallAcceptedRef.current, 
            roomIdFromRef: roomIdRef.current,
            roomIdFromRoute: routeRoomId,
            currentRoomId
          });
        }
      }

      // Если у нас есть удалённый поток из PiP-контекста — подставим его в state
      if (!remoteStreamRef.current && pipRef.current.remoteStream) {
        setRemoteStream(pipRef.current.remoteStream);
        remoteStreamRef.current = pipRef.current.remoteStream as any;
        console.log('[useFocusEffect] Restored remoteStream from PiP context');
      }
      
      // Включаем локальные и удалённые видео-треки при возврате на экран
      // КРИТИЧНО: При возврате из PiP состояние кнопки камеры должно оставаться включенной
      try {
        const lt = (localStream || localStreamRef.current)?.getVideoTracks?.()?.[0];
        if (lt) {
          if (!lt.enabled) {
          lt.enabled = true;
          console.log('[useFocusEffect] Re-enabled local video track');
          }
          // КРИТИЧНО: Устанавливаем camOn в true если трек включен при возврате из PiP
          // Это гарантирует что кнопка камеры остается в правильном состоянии
          if (lt.enabled) {
            setCamOn(true);
            console.log('[useFocusEffect] Set camOn=true after PiP return - local video track is enabled');
          }
        }
        
        // Включаем удалённый видео-трек, если он был отключён для PiP
        const rt = (remoteStream || remoteStreamRef.current)?.getVideoTracks?.()?.[0];
        if (rt) {
          if (!rt.enabled) {
          rt.enabled = true;
          }
          setRemoteCamOn(true);
          setRemoteViewKey(Date.now());
          console.log('[useFocusEffect] Re-enabled remote video track after PiP return');
        } else {
          console.log('[useFocusEffect] No remote video track found, setting remoteCamOn=true anyway');
          setRemoteCamOn(true);
        }
      } catch (e) {
        console.warn('[useFocusEffect] Error enabling video tracks:', e);
      }
      
      // Снимаем локальную заглушку без ожидания события от партнёра
      setPartnerInPiP(false);

      // Форсим спикер
      try {
        forceSpeakerOnHard();
        console.log('[useFocusEffect] Force enabled speaker');
      } catch (e) {
        console.warn('[useFocusEffect] Error enabling speaker:', e);
      }


      // Сбрасываем guard через небольшую задержку
      setTimeout(() => {
        focusEffectGuardRef.current = false;
      }, 300);
    } else {
      // Обычный фокус - только включаем видео если оно было выключено
      try {
        const stream = localStream || localStreamRef.current;
        stream?.getVideoTracks()?.forEach((t: any) => {
          if (!t.enabled) {
            t.enabled = true;
            console.log('[useFocusEffect] Re-enabled local video track on focus');
          }
        });
      } catch (e) {
        console.warn('[useFocusEffect] Error checking video tracks:', e);
      }
    }

    // Cleanup при уходе со страницы -> показываем PiP (если идёт звонок)
    return () => {
      // Guard: предотвращаем повторные вызовы cleanup
      if (focusEffectGuardRef.current) {
        console.log('[useFocusEffect] Cleanup: guard активен, пропускаем');
        return;
      }

      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
      // КРИТИЧНО: hasActiveCall должен быть false если мы в неактивном состоянии
      // Это предотвращает показ PiP после завершения звонка
      const hasActiveCall = !!roomIdRef.current && !isInactiveStateRef.current;
      const isRandomChat = !isFriendCall && (roomIdRef.current || partnerIdRef.current || startedRef.current);

      console.log('[useFocusEffect] Cleanup - checking conditions:', {
        isFriendCall,
        isRandomChat,
        hasActiveCall,
        roomId: roomIdRef.current,
        pipVisible: pipRef.current.visible,
      });

      // КРИТИЧНО: Для рандомного чата отправляем stop и room:leave при выходе
      // И ОСТАНАВЛИВАЕМ камеру локально
      if (isRandomChat && hasActiveCall) {
        console.log('[useFocusEffect] Random chat cleanup - sending stop and room:leave');
        try {
          const currentRoomId = roomIdRef.current;
          if (currentRoomId) {
            socket.emit('room:leave', { roomId: currentRoomId });
            console.log('[useFocusEffect] Sent room:leave for random chat:', currentRoomId);
          }
        } catch (e) {
          console.warn('[useFocusEffect] Error sending room:leave for random chat:', e);
        }
        
        try {
          socket.emit('stop');
          console.log('[useFocusEffect] Sent stop for random chat');
        } catch (e) {
          console.warn('[useFocusEffect] Error sending stop for random chat:', e);
        }
        
        // КРИТИЧНО: Останавливаем камеру локально при выходе с рандомного чата
        try {
          stopLocalStream();
          setLocalStream(null);
          localStreamRef.current = null;
          setCamOn(false);
          setMicOn(false);
          console.log('[useFocusEffect] Stopped local stream for random chat');
        } catch (e) {
          console.warn('[useFocusEffect] Error stopping local stream:', e);
        }
      }

      // Показываем PiP только если его еще нет и есть активный звонок (только для friend calls)
      // КРИТИЧНО: НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      // Двойная проверка: и через hasActiveCall (который уже проверяет isInactiveStateRef), и напрямую
      const currentPip = pipRef.current;
      if (isFriendCall && hasActiveCall && !currentPip.visible && !isInactiveState && !isInactiveStateRef.current) {
        focusEffectGuardRef.current = true;
        
        console.log('[useFocusEffect] Выход со страницы - показываем PiP');

        // Выключаем видео локально для экономии
        try {
          const stream = localStream || localStreamRef.current;
          stream?.getVideoTracks()?.forEach((t: any) => {
            t.enabled = false;
            console.log('[useFocusEffect] Disabled local video track for PiP');
          });
        } catch (e) {
          console.warn('[useFocusEffect] Error disabling local video:', e);
        }

        // Ищем партнера в списке друзей
        const partner = partnerUserId 
          ? friends.find(f => String(f._id) === String(partnerUserId))
          : null;
        
        // Строим полный URL аватара из поля avatar (проверяем что не пустая строка)
        let avatarUrl: string | undefined = undefined;
        if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
          const SERVER_CONFIG = require('../src/config/server').SERVER_CONFIG;
          const serverUrl = SERVER_CONFIG.BASE_URL;
          avatarUrl = partner.avatar.startsWith('http') 
            ? partner.avatar 
            : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
        }
        
        // КРИТИЧНО: Сохраняем partnerUserId в navParams для восстановления при возврате
        currentPip.showPiP({
          callId: currentCallIdRef.current || '',
          roomId: roomIdRef.current || '',
          partnerName: partner?.nick || 'Друг',
          partnerAvatarUrl: avatarUrl,
          muteLocal: !micOn,
          muteRemote: remoteMutedMain,
          localStream: localStream || localStreamRef.current || null,
          remoteStream: remoteStream || remoteStreamRef.current || null,
          navParams: {
            ...route?.params,
            peerUserId: partnerUserId || partnerUserIdRef.current,
            partnerId: partnerId || partnerIdRef.current, // КРИТИЧНО: Сохраняем partnerId для восстановления соединения
          } as any,
        });

        // Отправляем партнеру что мы ушли в PiP
        const isFriendCallActive = isDirectCall || inDirectCall || friendCallAcceptedRef.current;
        if (isFriendCallActive && roomIdRef.current) {
          try {
            socket.emit('pip:state', { 
              inPiP: true, 
              roomId: roomIdRef.current,
              from: socket.id 
            });
          } catch (e) {
            console.warn('[useFocusEffect] ❌ Error sending pip:state:', e);
          }
        }
        
        // Сбрасываем guard через задержку
        setTimeout(() => {
          focusEffectGuardRef.current = false;
        }, 300);
      }
    };
  }, [
    route?.params?.resume,
    route?.params?.fromPiP,
    applyNavBarForVideo
  ]));

  // Фиксируем экран на момент входящего звонка, чтобы вернуть пользователя туда после завершения
  const callOriginRef = useRef<{ name: string; params?: any } | null>(null);

  // State — core
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  useEffect(() => { startedRef.current = started; }, [started]);
  
  const [loading, setLoading] = useState(false);
  
  // Защита от спама кнопки "Далее"
  const [isNexting, setIsNexting] = useState(false);
  

  // Incoming direct friend call state
  const [incomingFriendCall, setIncomingFriendCall] = useState<{ from: string; nick?: string } | null>(null);
  const [friendCallAccepted, setFriendCallAccepted] = useState(false);

  // 3.4. Guard от двойного свайпа
  const swipeHandledRef = useRef(false);

  const [partnerId, setPartnerId] = useState<string | null>(null); // socket.id собеседника
  const partnerIdRef = useRef<string | null>(null);
  useEffect(() => { partnerIdRef.current = partnerId; }, [partnerId]);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(initialPeerUserId || null); // Mongo _id для дружбы

  const [myNick, setMyNick] = useState<string>('');
  const [myAvatar, setMyAvatar] = useState<string>('');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // DEPRECATED: remoteRender больше не используется
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);
  
  // КРИТИЧНО: Автоматически устанавливаем remoteCamOn в true когда появляется video track в remoteStream
  // Это особенно важно при повторных звонках, когда video track может прийти позже
  useEffect(() => {
    if (remoteStream && !isInactiveState) {
      try {
        const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack) {
          // КРИТИЧНО: Устанавливаем remoteCamOn в true если video track live или ready
          if (videoTrack.readyState === 'live' || videoTrack.readyState === 'ready') {
            // КРИТИЧНО: Проверяем через ref чтобы избежать лишних обновлений
            if (!remoteCamOnRef.current) {
              setRemoteCamOn(true);
              console.log('[useEffect remoteStream] Auto-set remoteCamOn=true (video track live/ready)', {
                readyState: videoTrack.readyState,
                enabled: videoTrack.enabled
              });
            }
            // КРИТИЧНО: Обновляем remoteViewKey для гарантированного ререндера
            setRemoteViewKey(Date.now());
          }
        }
      } catch (e) {
        console.warn('[useEffect remoteStream] Error checking video track:', e);
      }
    }
  }, [remoteStream, isInactiveState]);

  // DEPRECATED: remoteRender больше не используется
  const roomIdRef = useRef<string | null>(null);
  // УДАЛЕНО: isFriendStream - не нужен для 1-на-1
  // Очередь ICE-кандидатов для случая, когда они приходят раньше setRemoteDescription
  const pendingIceByFromRef = useRef<Record<string, RTCIceCandidateInit[]>>({});
  const enqueueIce = useCallback((from: string, cand: RTCIceCandidateInit) => {
    try {
      const key = String(from || '');
      if (!key) return;
      const map = pendingIceByFromRef.current;
      if (!map[key]) map[key] = [];
      map[key].push(cand);
    } catch {}
  }, []);
  const flushIceFor = useCallback(async (from: string) => {
    try {
      const key = String(from || '');
      if (!key) return;
      const list = pendingIceByFromRef.current[key] || [];
      if (!list.length) return;
      const pc = peerRef.current; // УПРОЩЕНО: только один PC
      if (!pc) return;
      // добавляем по очереди; если ещё нет remoteDescription — оставляем в очереди
      const rd = (pc as any).remoteDescription;
      if (!rd || !rd.type) return;
      for (const cand of list) {
        try { await pc.addIceCandidate(cand); } catch {}
      }
      delete pendingIceByFromRef.current[key];
    } catch {}
  }, []);

  // Блокировка на короткое время после «Отклонить», чтобы не подключиться по гонке
  const declinedBlockRef = useRef<{ userId: string; until: number } | null>(null);
  
  // Защита от повторных вызовов handleOffer для одного пользователя
  const processingOffersRef = useRef<Set<string>>(new Set());
  
  // Защита от множественных вызовов автопоиска
  const autoSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSearchRef = useRef<number>(0);
  
  // Защита от множественных отправок состояния камеры
  const lastCameraStateRef = useRef<number>(0);
  
  // Флаг для отслеживания ручного запроса "Далее" (не автоматического поиска)
  const manuallyRequestedNextRef = useRef<boolean>(false);
  
  // Предварительно созданный PeerConnection для ускорения подключения
  const preCreatedPcRef = useRef<RTCPeerConnection | null>(null);
  
  const setDeclinedBlock = useCallback((userId?: string | null, ms = 12000) => {
    const uid = (userId || '').trim();
    if (!uid) return;
    declinedBlockRef.current = { userId: uid, until: Date.now() + ms };
  }, []);
  const clearDeclinedBlock = useCallback(() => { declinedBlockRef.current = null; }, []);

  // Функция для безопасного автопоиска с защитой от множественных вызовов
  const triggerAutoSearch = useCallback((reason: string) => {
    const now = Date.now();
    const timeSinceLastSearch = now - lastAutoSearchRef.current;
    
    // Если прошло меньше 2 секунд с последнего поиска - игнорируем
    if (timeSinceLastSearch < 2000) {
      console.log(`[triggerAutoSearch] Skipping ${reason} - too soon (${timeSinceLastSearch}ms since last)`);
      return;
    }
    
    // Очищаем предыдущий таймаут если есть
    if (autoSearchTimeoutRef.current) {
      clearTimeout(autoSearchTimeoutRef.current);
      autoSearchTimeoutRef.current = null;
    }
    
    console.log(`[triggerAutoSearch] Scheduling search due to: ${reason}`);
    lastAutoSearchRef.current = now;
    
    // Сначала безопасно очищаем PeerConnection
    try {
      const pc = peerRef.current;
      if (pc) {
        try { pc.close(); } catch {}
        peerRef.current = null;
      }
    } catch (e) {
      console.warn('[triggerAutoSearch] Error closing PC:', e);
    }
    
    // Сразу устанавливаем состояние поиска
    setStarted(true);
    setLoading(true);
    setRemoteStream(null); // Очищаем зависшее видео
    setIsInactiveState(false); // Выходим из неактивного состояния
    setWasFriendCallEnded(false); // Сбрасываем флаг завершенного звонка
    
    autoSearchTimeoutRef.current = setTimeout(() => {
      try { 
        socket.emit('next'); 
        console.log(`[triggerAutoSearch] Executed search for: ${reason}`);
      } catch (e) {
        console.error(`[triggerAutoSearch] Error:`, e);
      }
      autoSearchTimeoutRef.current = null;
    }, 1000);
  }, []);

  // УДАЛЕНО: все friend и extra peer connections для 1-на-1

  // УДАЛЕНО: вся логика для групповых звонков
  
  
  // Local media
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);

  // КРИТИЧНО: Управление keep-awake для активного видеочата (особенно важно для iOS)
  useEffect(() => {
    const hasActiveVideoCall = !!remoteStream && (
      remoteStream.getVideoTracks?.()?.length > 0 || 
      remoteStream.getAudioTracks?.()?.length > 0
    ) || (started && !!localStream);

    let androidKeepScreenOnInterval: ReturnType<typeof setInterval> | null = null;

    if (hasActiveVideoCall) {
      // Активируем keep-awake для активного видеочата
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('[VideoChat] Failed to activate keep-awake:', e);
        });
      }
      // Для iOS также используем InCallManager для предотвращения засыпания
      if (Platform.OS === 'ios') {
        try {
          // InCallManager.start уже вызывается в forceSpeakerOnHard, но убедимся что он активен
          InCallManager.start({ media: 'video', ringback: '' });
        } catch (e) {
          logger.warn('[VideoChat] Failed to start InCallManager on iOS:', e);
        }
      }
      // Для Android также используем InCallManager с периодической переактивацией
      if (Platform.OS === 'android') {
        const activateAndroidKeepScreenOn = () => {
          try {
            InCallManager.start({ media: 'video', ringback: '' });
            (InCallManager as any).setKeepScreenOn?.(true);
            // Также активируем expo-keep-awake для Android (дополнительная защита)
            if (activateKeepAwakeAsync) {
              activateKeepAwakeAsync().catch((e) => {
                logger.warn('[VideoChat] Failed to activate keep-awake for Android:', e);
              });
            }
            logger.debug('[VideoChat] setKeepScreenOn(true) and keep-awake reactivated for Android');
          } catch (e) {
            logger.warn('[VideoChat] Failed to reactivate setKeepScreenOn on Android:', e);
          }
        };
        
        // Активируем сразу
        activateAndroidKeepScreenOn();
        
        // Запускаем периодическую переактивацию каждые 5 секунд (более агрессивная защита)
        androidKeepScreenOnInterval = setInterval(() => {
          activateAndroidKeepScreenOn();
        }, 5000);
      }
    } else {
      // Деактивируем keep-awake когда видеочат завершен
      // НО только если нет активного звонка (проверяем через refs)
      const hasActiveCall = !!roomIdRef.current || !!currentCallIdRef.current || !!peerRef.current || started;
      if (!hasActiveCall) {
        if (deactivateKeepAwakeAsync) {
          deactivateKeepAwakeAsync().catch((e) => {
            logger.warn('[VideoChat] Failed to deactivate keep-awake:', e);
          });
        }
        // Для Android также деактивируем
        if (Platform.OS === 'android') {
          try {
            (InCallManager as any).setKeepScreenOn?.(false);
          } catch (e) {
            logger.warn('[VideoChat] Failed to setKeepScreenOn(false):', e);
          }
        }
      }
    }

    return () => {
      // Очищаем интервал при размонтировании или изменении зависимостей
      if (androidKeepScreenOnInterval) {
        clearInterval(androidKeepScreenOnInterval);
        androidKeepScreenOnInterval = null;
      }
    };
  }, [remoteStream, localStream, started]);

  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [remoteMutedMain, setRemoteMutedMain] = useState(false);

  // ДРУЖБА
  const [incomingFriendFrom, setIncomingFriendFrom] = useState<string | null>(null);
  const [friendModalVisible, setFriendModalVisible] = useState(false);
  const [friends, setFriends] = useState<Array<{ _id: string; nick?: string; avatar?: string; avatarUrl?: string; online: boolean }>>([]);
  // убрано: onlineSetRef больше не нужен
  const [addBlocked, setAddBlocked] = useState(false);
  const [addPending, setAddPending] = useState(false);
  // Запоминаем, кому мы отправили последнюю заявку, чтобы показывать "Вам отказано" только отправителю
  const lastFriendRequestToRef = useRef<string | null>(null);
  
  // Кэш никнеймов пользователей по ID
  const [userNicks, setUserNicks] = useState<Record<string, string>>({});
  const isPartnerFriend = useMemo(() => {
    if (!partnerUserId || !started) {
      console.log('[isPartnerFriend] Returning false:', { partnerUserId, started });
      return false;
    }
    const isFriend = friends.some(f => String(f._id) === String(partnerUserId));
    console.log('[isPartnerFriend] Checking:', {
      partnerUserId,
      started,
      friendsCount: friends.length,
      isFriend,
      friends: friends.map(f => ({ id: f._id, nick: f.nick }))
    });
    return isFriend;
  }, [friends, partnerUserId, started]);

  // Логируем состояние кнопки "Добавить в друзья" только при изменении
  useEffect(() => {
    const shouldShow = started && !!partnerUserId && !isPartnerFriend;
    console.log('[VideoChat] Add friend button state:', {
      shouldShow,
      started,
      partnerUserId,
      isPartnerFriend,
      friendsCount: friends.length,
      platform: Platform.OS
    });
  }, [started, partnerUserId, isPartnerFriend, friends.length]);

  // Функция для форматирования отображения пользователя
  const formatUserDisplay = useCallback((userId: string | null): string => {
    if (!userId) return '';
    
    // Ищем никнейм в кэше
    const nick = userNicks[userId];
    if (nick && nick.trim()) {
      return nick.trim();
    }
    
    // Ищем пользователя среди друзей по ID
    const friend = friends.find(f => String(f._id) === String(userId));
    if (friend && friend.nick && friend.nick.trim()) {
      // Сохраняем в кэш для будущего использования
      setUserNicks(prev => ({ ...prev, [userId]: friend.nick || '' }));
      return friend.nick.trim();
    }
    
    // Если никнейма нет, показываем первые 5 символов ID
    return userId.substring(0, 5);
  }, [userNicks, friends]);

  const [localRenderKey, setLocalRenderKey] = useState(0);
  // DEPRECATED: remoteRender больше не используется

  // === Индикатор громкости (только при соединении) ===
  const [micLevel, setMicLevel] = useState(0);
  const micStatsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // КРИТИЧНО: Для iOS - отслеживаем низкие значения для определения молчания
  const lowLevelCountRef = useRef<number>(0);

  // Toast
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  
const pcConnectedRef = useRef(false);
const [pcConnected, setPcConnected] = useState(false);

const energyRef = useRef<number | null>(null);
const durRef = useRef<number | null>(null);

  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [partnerInPiP, setPartnerInPiP] = useState(false); // Отслеживаем когда партнер ушел в PiP
  const [remoteViewKey, setRemoteViewKey] = useState(0); // Key для принудительной перерисовки RTCView
  
  // Состояние неактивного режима после нажатия "Прервать"
  const [isInactiveState, setIsInactiveState] = useState(false);
  const isInactiveStateRef = useRef(false);
  useEffect(() => { isInactiveStateRef.current = isInactiveState; }, [isInactiveState]);
  
  // Флаг для отслеживания завершенного звонка друга (для показа заблокированной кнопки "Прервать")
  const [wasFriendCallEnded, setWasFriendCallEnded] = useState(false);
  
  // Флаг для предотвращения дублирования активации background
  const bgActivationInProgress = useRef(false);

  // Refs для AppState listener чтобы избежать пересоздания listener
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  
  const partnerUserIdRef = useRef(partnerUserId);
  partnerUserIdRef.current = partnerUserId;
  
  const remoteCamOnRef = useRef(remoteCamOn);
  remoteCamOnRef.current = remoteCamOn;
  
  const friendCallAcceptedRef = useRef(friendCallAccepted);
  friendCallAcceptedRef.current = friendCallAccepted;

  // Ref для таймера блокировки экрана на iOS
  const inactiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AppState monitoring для background режима (после объявления всех зависимостей)
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active') {
        // Возврат в приложение - очищаем таймер блокировки экрана если был установлен
        if (inactiveTimerRef.current) {
          clearTimeout(inactiveTimerRef.current);
          inactiveTimerRef.current = null;
          console.log('[AppState] Cleared inactive timer - app returned to active');
        }
        
        // Возврат в приложение - скрываем background если был активен
        if (false) {
          console.log('[AppState] Returning to app - hiding background');
          
          // Уведомляем партнера что мы вышли из background режима
          try {
            socket.emit('bg:exited', { 
              callId: roomIdRef.current,
              partnerId: partnerUserIdRef.current 
            });
            console.log('[AppState] Notified partner about exiting background mode');
          } catch (e) {
            console.warn('[AppState] Error notifying partner about exiting background:', e);
          }
          
          // background removed
        }
        
        await applyNavBarForVideo();
        if (Platform.OS === 'android' && (NativeModules as any)?.ExpoNavigationBar) {
          try {
            const NavigationBar = await import('expo-navigation-bar');
            await NavigationBar.setVisibilityAsync('hidden');
            setTimeout(async () => { try { await NavigationBar.setVisibilityAsync('visible'); } catch {} }, 20);
          } catch {}
        }
      } else if (s === 'inactive') {
        // inactive - приложение теряет фокус, но еще не в фоне
        // На iOS при блокировке экрана может остаться в inactive без перехода в background
        // Используем таймер для определения блокировки экрана
        const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        
        if (Platform.OS === 'ios' && isFriendCall && (roomIdRef.current || currentCallIdRef.current)) {
          // На iOS при блокировке экрана приложение может остаться в inactive
          // Используем таймер: если через 1.5 секунды все еще inactive - это блокировка
          console.log('[AppState] iOS became inactive during friend call - checking if screen locked');
          
          // Очищаем предыдущий таймер если был
          if (inactiveTimerRef.current) {
            clearTimeout(inactiveTimerRef.current);
          }
          
          inactiveTimerRef.current = setTimeout(() => {
            // Проверяем что все еще в inactive и звонок активен
            if (AppState.currentState === 'inactive' || AppState.currentState === 'background') {
              const stillFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
              const stillHasCall = roomIdRef.current || currentCallIdRef.current;
              
              if (stillFriendCall && stillHasCall) {
                console.log('[AppState] iOS screen locked (inactive timeout) - ending friend call');
                
                try {
                  const callId = currentCallIdRef.current || roomIdRef.current;
                  if (callId) {
                    socket.emit('call:end', { callId });
                    console.log('[AppState] Sent call:end for friend call (iOS inactive):', callId);
                  }
                } catch (e) {
                  console.warn('[AppState] Error sending call:end (iOS inactive):', e);
                }
                
                // Завершаем звонок локально
                try {
                  setIsInactiveState(true);
                  isInactiveStateRef.current = true;
                  stopMicMeter();
                  // КРИТИЧНО: Дополнительно устанавливаем micLevel=0 для эквалайзера
                  setMicLevel(0);
                  try { pip.updatePiPState({ micLevel: 0 }); } catch {}
                  try { stopSpeaker(); } catch {}
                  cleanupPeer(peerRef.current);
                  peerRef.current = null;
                  currentCallIdRef.current = null;
                  roomIdRef.current = null;
                  console.log('[AppState] Friend call ended locally due to iOS screen lock (inactive)');
                } catch (e) {
                  console.warn('[AppState] Error ending call locally (iOS inactive):', e);
                }
              }
            }
            inactiveTimerRef.current = null;
          }, 1500); // 1.5 секунды - достаточно для определения блокировки экрана
        } else {
          console.log('[AppState] App became inactive - not activating background yet');
        }
      } else if (s === 'background') {
        // background - приложение полностью в фоне (блокировка экрана)
        const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        
        if (isFriendCall && (roomIdRef.current || currentCallIdRef.current)) {
          // Звонок другу - завершаем вызов при блокировке экрана
          console.log('[AppState] Friend call backgrounded (screen locked) - ending call');
          
          try {
            const callId = currentCallIdRef.current || roomIdRef.current;
            if (callId) {
              socket.emit('call:end', { callId });
              console.log('[AppState] Sent call:end for friend call:', callId);
            }
          } catch (e) {
            console.warn('[AppState] Error sending call:end:', e);
          }
          
          // Завершаем звонок локально
          try {
            setIsInactiveState(true);
            isInactiveStateRef.current = true;
            stopMicMeter();
            // КРИТИЧНО: Дополнительно устанавливаем micLevel=0 для эквалайзера
            setMicLevel(0);
            try { pip.updatePiPState({ micLevel: 0 }); } catch {}
            try { stopSpeaker(); } catch {}
            cleanupPeer(peerRef.current);
            peerRef.current = null;
            currentCallIdRef.current = null;
            roomIdRef.current = null;
            console.log('[AppState] Friend call ended locally due to screen lock');
          } catch (e) {
            console.warn('[AppState] Error ending call locally:', e);
          }
        } else if (!isFriendCall && (roomIdRef.current || partnerIdRef.current)) {
          // Рандомный чат - отправляем stop/leave
          console.log('[AppState] Random chat backgrounded, notifying partner');
          
          try {
            const currentRoomId = roomIdRef.current;
            if (currentRoomId) {
              socket.emit('room:leave', { roomId: currentRoomId });
              console.log('[AppState] Sent room:leave for:', currentRoomId);
            }
          } catch (e) {
            console.warn('[AppState] Error sending room:leave:', e);
          }
          
          try {
            socket.emit('stop');
            console.log('[AppState] Sent stop signal');
          } catch (e) {
            console.warn('[AppState] Error sending stop:', e);
          }
        }
      }
    });
    return () => {
      // Очищаем таймер при размонтировании
      if (inactiveTimerRef.current) {
        clearTimeout(inactiveTimerRef.current);
        inactiveTimerRef.current = null;
      }
      sub.remove();
    };
  }, [applyNavBarForVideo, isDirectCall]);

  // Обработчик кнопки "Назад" Android для активации background
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Проверяем: это звонок друга с активным соединением?
      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
      const hasActiveCall = !!roomIdRef.current; // Достаточно roomId - поток может быть временно null
      
      console.log('[BackHandler] Checking background activation:', {
        isFriendCall,
        hasActiveCall,
        roomId: roomIdRef.current,
      });
      
      if (isFriendCall && hasActiveCall) {
        // Звонок друга - активируем background вместо завершения звонка
        console.log('[BackHandler] Friend call - activating background instead of ending call');
        
        try {
          const partnerNick = friendsRef.current.find(f => String(f._id) === String(partnerUserIdRef.current))?.nick;
          
          // Используем state remoteStream если ref пустой               
               const streamToUse = remoteStreamRef.current || remoteStream;
               console.log('[BackHandler] Using stream for background:', {
                 hasRefStream: !!remoteStreamRef.current,
                 hasStateStream: !!remoteStream,
                 streamId: streamToUse?.id,
                 streamActive: streamToUse?.active,
                 streamTracks: streamToUse?.getTracks?.()?.length,
                 remoteCamOn: remoteCamOnRef.current,
                 partnerUserId: partnerUserIdRef.current,
               });
               
               // Дополнительная проверка: если поток не найден, попробуем получить из peerConnection
               let finalStreamToUse = streamToUse;
               if (!streamToUse && peerRef.current) {
                 try {
                   const pc = peerRef.current;
                   const receivers = pc.getReceivers();
                   const videoReceiver = receivers.find(r => r.track && r.track.kind === 'video');
                   if (videoReceiver && videoReceiver.track) {
                     console.log('[BackHandler] Found video track in peerConnection, creating stream');
                     const fallbackStream = new MediaStream([videoReceiver.track]);
                     setRemoteStream(fallbackStream);
                     remoteStreamRef.current = fallbackStream;
                     finalStreamToUse = fallbackStream;
                     console.log('[BackHandler] Created fallback stream:', fallbackStream.id);
                   }
                 } catch (e) {
                   console.warn('[BackHandler] Failed to create fallback stream:', e);
                 }
               }
               
               // Передаем живые streams + контекст в background
               const finalRemote = remoteStreamRef.current || remoteStream;
               const finalLocal = localStreamRef.current;
               
               console.log('[BackHandler] Using streams for background:', {
                 hasRemote: !!finalRemote,
                 hasLocal: !!finalLocal,
                 remoteActive: finalRemote?.active,
                 localActive: finalLocal?.active,
               });
               
               // background removed
          
          // Уведомляем партнера что мы покинули экран
          try {
            socket.emit('bg:entered', { 
              callId: roomIdRef.current,
              partnerId: partnerUserIdRef.current 
            });
            console.log('[BackHandler] Notified partner about background mode');
          } catch (e) {
            console.warn('[BackHandler] Error notifying partner about background:', e);
          }
          
          // Навигация назад
          const nav = (global as any).__navRef;
          if (nav?.canGoBack?.()) {
            nav.goBack();
          } else {
            nav?.dispatch?.(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
          }
          
          return true; // Предотвращаем стандартное поведение
        } catch (e) {
          console.warn('[BackHandler] Error showing background:', e);
        }
      } else if (!isFriendCall && hasActiveCall) {
        // Рандомный чат - отправляем сигналы завершения
        console.log('[BackHandler] Random chat - notifying partner and leaving');
        
        try {
          // Отправляем сигнал партнеру что мы покинули чат
          const currentRoomId = roomIdRef.current;
          if (currentRoomId) {
            socket.emit('room:leave', { roomId: currentRoomId });
            console.log('[BackHandler] Sent room:leave for:', currentRoomId);
          }
          
          // Отправляем stop сигнал
          socket.emit('stop');
          console.log('[BackHandler] Sent stop signal');
          
          // Очищаем соединение
          cleanupPeer(peerRef.current);
          peerRef.current = null;
          setRemoteStream(null);
          setPartnerId(null);
          setPartnerUserId(null);
          
        } catch (e) {
          console.warn('[BackHandler] Error notifying partner:', e);
        }
        
        // Навигация назад
        const nav = (global as any).__navRef;
        if (nav?.canGoBack?.()) {
          nav.goBack();
        } else {
          nav?.dispatch?.(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
        }
        
        return true; // Предотвращаем стандартное поведение
      }
      
      return false; // Разрешаем стандартное поведение
    });

    return () => backHandler.remove();
  }, [isDirectCall]);

  // Incoming call card
  const [incomingCall, setIncomingCall] = useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const currentCallIdRef = useRef<string | null>(null);
  
  // Устанавливаем callId из параметров навигации (для инициатора)
  useEffect(() => {
    if (initialCallId) {
      currentCallIdRef.current = initialCallId;
      console.log('[VideoChat] Set currentCallIdRef from route params:', initialCallId);
    }
  }, [initialCallId]);
  
  const [incomingOverlay, setIncomingOverlay] = useState<boolean>(false);
  const callShake = useRef(new Animated.Value(0)).current;
  const waveA = useRef(new Animated.Value(0)).current;
  const waveB = useRef(new Animated.Value(0)).current;

  // Обработка сворачивания приложения партнером - автоматический поиск нового собеседника
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'background' || s === 'inactive') {
        // Партнер свернул или закрыл приложение
        // НЕ запускаем автоматический поиск - пользователь сам выберет "Далее"
      }
    });
    return () => sub.remove();
  }, []);

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
    loop(waveA, 0); loop(waveB, 400);
  }, [callShake, waveA, waveB]);

  const stopIncomingAnim = useCallback(() => {
    callShake.stopAnimation(); waveA.stopAnimation(); waveB.stopAnimation();
  }, [callShake, waveA, waveB]);



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


  const [facing, setFacing] = useState<CamSide>('front');

const flipCam = useCallback(async () => {
  const ls = localStreamRef.current;
  if (!ls) return;
  const videoTrack = ls.getVideoTracks?.()[0];
  if (!videoTrack) return;

  if (typeof (videoTrack as any)._switchCamera === 'function') {
    (videoTrack as any)._switchCamera();
    setFacing(prev => (prev === 'front' ? 'back' : 'front'));
    return;
  }

  try {
    const newFacing: CamSide = facing === 'front' ? 'back' : 'front';
    const newStream = await mediaDevices.getUserMedia({
      video: { facingMode: newFacing },
      audio: true,
    });

    const newVideoTrack = (newStream as any)?.getVideoTracks?.()?.[0];
    if (newVideoTrack) {
      const sender = peerRef.current
        ?.getSenders()
        .find(s => s.track && s.track.kind === 'video');
      // Сначала подменяем трек у sender (чтобы не мигал экран), затем останавливаем старый
      if (sender) await sender.replaceTrack(newVideoTrack);

      ls.addTrack(newVideoTrack);
      setLocalRenderKey(k => k + 1);

      setTimeout(() => {
        try { ls.removeTrack(videoTrack); } catch {}
        try { videoTrack.stop(); } catch {}
      }, 50);
    }
    setFacing(newFacing);
  } catch (err) { console.warn('flipCam fallback error', err); }
}, [facing]);



  // Unified local stream stopper
  const stopLocalStream = useCallback(async () => {
    const ls = localStreamRef.current || localStream;
    if (!ls) {
      console.log('[stopLocalStream] No local stream to stop');
      // КРИТИЧНО: Все равно закрываем все PeerConnection даже если стрима нет
      try {
        if (peerRef.current) {
          cleanupPeer(peerRef.current);
          peerRef.current = null;
        }
        if (preCreatedPcRef.current) {
          cleanupPeer(preCreatedPcRef.current);
          preCreatedPcRef.current = null;
        }
      } catch {}
      return;
    }
    console.log('[stopLocalStream] Stopping local stream tracks');
    
    // КРИТИЧНО: Сначала ЗАКРЫВАЕМ ВСЕ PeerConnection, чтобы iOS точно понял что камера не используется
    try {
      // Закрываем основной PeerConnection
      const pc = peerRef.current;
      if (pc) {
        console.log('[stopLocalStream] Closing main PeerConnection first');
        
        // КРИТИЧНО: СНАЧАЛА устанавливаем peerRef.current = null, чтобы обработчики не видели активный PC
        peerRef.current = null;
        
        // КРИТИЧНО: Отключаем и удаляем все треки из senders ДО закрытия PC
        const senders = pc.getSenders() || [];
        console.log('[stopLocalStream] Removing tracks from', senders.length, 'senders');
        
        // Ждем завершения всех replaceTrack операций
        const replacePromises = senders.map(async (sender: any) => {
          try {
            const track = sender.track;
            if (track) {
              // Отключаем трек перед удалением
              track.enabled = false;
              console.log('[stopLocalStream] Disabled track in sender:', track.kind, track.id);
            }
            // Удаляем трек из sender и ЖДЕМ завершения
            await sender.replaceTrack(null);
            console.log('[stopLocalStream] Replaced track with null in sender:', sender.track?.kind);
          } catch (e) {
            console.warn('[stopLocalStream] Error processing sender:', e);
          }
        });
        
        // Ждем завершения всех replaceTrack операций
        await Promise.all(replacePromises);
        console.log('[stopLocalStream] All tracks removed from main PeerConnection');
        
        // КРИТИЧНО: Очищаем все обработчики событий перед закрытием PC
        // Это предотвращает создание offer'ов после закрытия
        try {
          (pc as any).ontrack = null;
          (pc as any).onaddstream = null;
          (pc as any).onicecandidate = null;
          (pc as any).onconnectionstatechange = null;
          (pc as any).oniceconnectionstatechange = null; // КРИТИЧНО: Очищаем обработчик ICE
          (pc as any).onsignalingstatechange = null;
          (pc as any).onicegatheringstatechange = null;
          console.log('🔴 [stopLocalStream] Handlers cleared from main PeerConnection (correct cleanup)');
        } catch (e) {
          console.warn('⚫ [stopLocalStream] Error clearing handlers from main PC (incorrect cleanup):', e);
        }
        
        // КРИТИЧНО: Закрываем PeerConnection после удаления треков и очистки обработчиков
        try {
          pc.close();
          console.log('🔴 [stopLocalStream] Main PeerConnection closed (correct cleanup)');
        } catch (e) {
          console.warn('⚫ [stopLocalStream] Error closing main PC (incorrect cleanup):', e);
        }
      }
      
      // КРИТИЧНО: Также закрываем предварительно созданный PeerConnection
      if (preCreatedPcRef.current) {
        console.log('[stopLocalStream] Closing pre-created PeerConnection');
        try {
          const prePc = preCreatedPcRef.current;
          
          // КРИТИЧНО: СНАЧАЛА устанавливаем preCreatedPcRef.current = null
          preCreatedPcRef.current = null;
          
          // КРИТИЧНО: Сначала удаляем все треки из senders
          const preSenders = prePc.getSenders() || [];
          const preReplacePromises = preSenders.map(async (sender: any) => {
            try {
              const track = sender.track;
              if (track) {
                // КРИТИЧНО: Отключаем трек перед удалением
                track.enabled = false;
                console.log('[stopLocalStream] Disabled track in pre-created PC sender:', track.kind, track.id);
              }
              await sender.replaceTrack(null);
              console.log('[stopLocalStream] Removed track from pre-created PC sender');
            } catch (e) {
              console.warn('[stopLocalStream] Error processing pre-created PC sender:', e);
            }
          });
          await Promise.all(preReplacePromises);
          console.log('[stopLocalStream] All tracks removed from pre-created PeerConnection');
          
          // КРИТИЧНО: Очищаем обработчики событий перед закрытием
          try {
            (prePc as any).ontrack = null;
            (prePc as any).onaddstream = null;
            (prePc as any).onicecandidate = null;
            (prePc as any).onconnectionstatechange = null;
            (prePc as any).oniceconnectionstatechange = null; // КРИТИЧНО: Очищаем обработчик ICE
            (prePc as any).onsignalingstatechange = null;
            (prePc as any).onicegatheringstatechange = null;
            console.log('🔴 [stopLocalStream] Handlers cleared from pre-created PC (correct cleanup)');
          } catch (e) {
            console.warn('⚫ [stopLocalStream] Error clearing handlers from pre-created PC:', e);
          }
          
          // КРИТИЧНО: Закрываем PeerConnection после удаления треков и очистки обработчиков
          prePc.close();
          console.log('[stopLocalStream] Pre-created PeerConnection closed');
        } catch (e) {
          console.warn('[stopLocalStream] Error closing pre-created PC:', e);
        }
      }
    } catch (e) {
      console.error('[stopLocalStream] Error removing tracks from PeerConnection:', e);
    }
    
    // Затем останавливаем треки в локальном стриме
    try {
      const tracks = ls.getTracks?.() || [];
      console.log('[stopLocalStream] Stopping', tracks.length, 'tracks from local stream');
      
      tracks.forEach((t: any) => {
        try {
          // КРИТИЧНО: Сначала отключаем трек (чтобы iOS понял что камера не используется)
          t.enabled = false;
          console.log('[stopLocalStream] Disabled track:', t.kind, t.id);
        } catch (e) {
          console.warn('[stopLocalStream] Error disabling track:', e);
        }
        try { 
          t.stop(); 
          console.log('[stopLocalStream] Stopped track:', t.kind, t.id);
        } catch (e) {
          console.warn('[stopLocalStream] Error stopping track:', e);
        }
        try { 
          (ls as any).removeTrack?.(t); 
        } catch (e) {
          console.warn('[stopLocalStream] Error removing track:', e);
        }
      });
      
      console.log('[stopLocalStream] Stopped', tracks.length, 'tracks');
      
      // КРИТИЧНО: Дополнительная проверка - убеждаемся что все треки камеры остановлены
      // Это критично для iOS где индикатор камеры может оставаться активным
      const videoTracks = tracks.filter((t: any) => t.kind === 'video');
      videoTracks.forEach((t: any) => {
        try {
          // КРИТИЧНО: Всегда отключаем и останавливаем видео треки
          t.enabled = false;
          if (t.readyState !== 'ended') {
            console.warn('[stopLocalStream] Video track still active:', t.id, 'readyState:', t.readyState, 'stopping');
            t.stop();
          } else {
            console.log('[stopLocalStream] Video track already ended:', t.id);
          }
        } catch (e) {
          console.warn('[stopLocalStream] Error force-stopping video track:', e);
        }
      });
      
      // КРИТИЧНО: Также проверяем аудио треки и убеждаемся что они остановлены
      const audioTracks = tracks.filter((t: any) => t.kind === 'audio');
      audioTracks.forEach((t: any) => {
        try {
          t.enabled = false;
          if (t.readyState !== 'ended') {
            t.stop();
          }
        } catch (e) {
          console.warn('[stopLocalStream] Error force-stopping audio track:', e);
        }
      });
    } catch (e) {
      console.error('[stopLocalStream] Error stopping tracks:', e);
    }
    
    try { 
      (ls as any).release?.(); 
      console.log('[stopLocalStream] Released stream');
    } catch (e) {
      console.warn('[stopLocalStream] Error releasing stream:', e);
    }
    
    console.log('[stopLocalStream] Local stream stopping completed');
    
    // КРИТИЧНО: Гарантированно обнуляем localStreamRef.current СРАЗУ после остановки треков
    // Это предотвращает использование старых треков в preCreatePeerConnection и других местах
    localStreamRef.current = null;
    setLocalStream(null);
    console.log('[stopLocalStream] Cleared localStreamRef and localStream state immediately');
    
    // КРИТИЧНО: Дополнительная проверка - убеждаемся что все треки действительно остановлены
    // Используем ls (локальную переменную), так как ref уже обнулен
    const remainingTracks = ls.getTracks?.() || [];
    if (remainingTracks.length > 0) {
      console.warn('[stopLocalStream] Warning: Some tracks still exist, force stopping:', remainingTracks.length);
      remainingTracks.forEach((t: any) => {
        try {
          t.enabled = false;
          t.stop();
    } catch {}
      });
    }
    
    // КРИТИЧНО: Дополнительная проверка через mediaDevices - убеждаемся что нет активных устройств
    // Это особенно важно при втором и последующих вызовах
    try {
      const devicesResult = await mediaDevices.enumerateDevices();
      if (Array.isArray(devicesResult)) {
        const videoDevices = devicesResult.filter((d: any) => d.kind === 'videoinput');
        console.log('[stopLocalStream] Video devices after cleanup:', videoDevices.length);
      }
    } catch {}
    
    // КРИТИЧНО: Дополнительная задержка чтобы дать iOS время полностью освободить камеру
    // Это критично для iOS, где индикатор камеры может оставаться активным если камера не полностью освобождена
    // Увеличиваем задержку для более надежного освобождения камеры
    // КРИТИЧНО: Для второго и последующих вызовов может потребоваться больше времени
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // КРИТИЧНО: Финальная проверка - убеждаемся что все треки действительно остановлены
    const finalCheckTracks = ls.getTracks?.() || [];
    if (finalCheckTracks.length > 0) {
      console.error('[stopLocalStream] CRITICAL: Tracks still exist after cleanup!', finalCheckTracks.length);
      finalCheckTracks.forEach((t: any) => {
        try {
          console.error('[stopLocalStream] Force stopping remaining track:', t.kind, t.id, t.readyState);
          t.enabled = false;
          t.stop();
          // Дополнительная попытка через release если доступно
          try { (t as any).release?.(); } catch {}
        } catch (e) {
          console.error('[stopLocalStream] Failed to stop remaining track:', e);
        }
      });
    }
    
    console.log('[stopLocalStream] Final cleanup completed, camera should be fully released');
  }, [localStream]);

  

  // Localization function with nickname substitution
  const L = useCallback((key: string, params?: Record<string, string>) => {
    let text = t(key, lang);
    if (params) {
      Object.entries(params).forEach(([paramKey, paramValue]) => {
        let finalValue = paramValue;
        
        // Специальная обработка для friend_request_text: используем formatUserDisplay
        if (key === 'friend_request_text' && paramKey === 'user') {
          finalValue = formatUserDisplay(paramValue);
        }
        
        text = text.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), finalValue);
      });
    }
    return text;
  }, [lang, friends, userNicks, formatUserDisplay]);

  // ==== hooks that must be top-level ====
  useSpeakerReapply(remoteStream);

  // При входе в видеочат с конкретным другом — обнуляем пропущенные вызовы для него
  useEffect(() => {
    const uid = route?.params?.peerUserId ? String(route.params.peerUserId) : '';
    if (!uid) return;
    (async () => {
      try {
        const key = 'missed_calls_by_user_v1';
        const raw = await AsyncStorage.getItem(key);
        const data = raw ? JSON.parse(raw) : {};
        if (data && typeof data === 'object' && data[uid]) {
          data[uid] = 0;
          await AsyncStorage.setItem(key, JSON.stringify(data));
        }
      } catch {}
    })();
  }, [route?.params?.peerUserId]);

  // --------------------------
  // Permissions
  // --------------------------
  const requestPermissions = useCallback(async () => {
    if (Platform.OS !== 'android') return true;
    try {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
      return (
        granted['android.permission.CAMERA'] === PermissionsAndroid.RESULTS.GRANTED &&
        granted['android.permission.RECORD_AUDIO'] === PermissionsAndroid.RESULTS.GRANTED
      );
    } catch { return false; }
  }, []);

  // --------------------------
  // Utils
  // --------------------------
  // === Safe stream check (fix "MediaStream has been disposed") ===
  const isValidStream = (stream?: MediaStream | null) => {
    try {
      return !!stream && typeof (stream as any).toURL === 'function' && (stream as any).getTracks?.().length > 0;
    } catch {
      return false;
    }
  };

  // --------------------------
  // Local stream
  // --------------------------
  const startLocalStream = useCallback(async (_: CamSide) => {
    // КРИТИЧНО: НЕ запускаем камеру если находимся в неактивном состоянии (завершенный звонок)
    // Используем ref вместо state для проверки, чтобы избежать race condition
    // КРИТИЧНО: Также проверяем что нет активного звонка (partnerId, roomId, callId)
    const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
    if (isInactiveStateRef.current && !friendCallAccepted && !hasActiveCall) {
      console.log('🔴 [startLocalStream] Skipping - in inactive state after call ended, no active call', {
        isInactiveState: isInactiveStateRef.current,
        friendCallAccepted,
        hasActiveCall,
        partnerId: partnerIdRef.current,
        roomId: roomIdRef.current,
        callId: currentCallIdRef.current
      });
      return null;
    }
    
    // Пропускаем создание локального стрима при возврате из PiP
    // КРИТИЧНО: Проверяем что pipLocalStream действительно валиден перед использованием
    if (resume && fromPiP && pipLocalStream && isValidStream(pipLocalStream)) {
      console.log('[startLocalStream] Skipping local stream creation - resuming from PiP');
      setLocalStream(pipLocalStream);
      return pipLocalStream;
    }
    
    // Проверяем, не запущен ли уже локальный стрим
    // КРИТИЧНО: Проверяем валидность существующего стрима
    if (localStream && isValidStream(localStream)) {
      console.log('[startLocalStream] Local stream already exists, returning existing stream');
      return localStream;
    }
    
    // КРИТИЧНО: Если localStream существует но невалиден, очищаем его
    if (localStream && !isValidStream(localStream)) {
      console.log('[startLocalStream] Existing local stream is invalid, clearing it');
      try {
        const tracks = localStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      setLocalStream(null);
      localStreamRef.current = null;
    }
    
    console.log('[startLocalStream] Starting media stream...');
    // Никаких измерителей уровня здесь — только запуск камеры/микрофона
    const audioConstraints: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googAutoGainControl: true,
    };

    // КРИТИЧНО: Всегда запрашиваем и камеру и микрофон, даже если камера выключена
    // Это необходимо для корректной работы WebRTC PeerConnection
    const try1 = () => {
      console.log('[startLocalStream] Trying getUserMedia with basic constraints...');
      return mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
    };
    const try2 = () => {
      console.log('[startLocalStream] Trying getUserMedia with facingMode...');
      return mediaDevices.getUserMedia({ audio: audioConstraints, video: { facingMode: 'user' as any } });
    };
    const try3 = async () => {
      console.log('[startLocalStream] Trying getUserMedia with specific device...');
      const devs = await mediaDevices.enumerateDevices();
      const cams = (devs as any[]).filter(d => d.kind === 'videoinput');
      const front = cams.find(d => /front|user/i.test(d.facing || d.label || '')) || cams[0];
      console.log('[startLocalStream] Found camera device:', front?.deviceId);
      return mediaDevices.getUserMedia({ audio: audioConstraints, video: { deviceId: (front as any)?.deviceId } as any });
    };

    let stream: MediaStream | null = null;
    try {
      stream = await try1(); 
      if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try1');
      console.log('[startLocalStream] Success with try1');
    } catch (e1) {
      console.log('[startLocalStream] try1 failed:', e1);
      try { 
        stream = await try2(); 
        if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try2'); 
        console.log('[startLocalStream] Success with try2');
      }
      catch (e2) {
        console.log('[startLocalStream] try2 failed:', e2);
        try {
          stream = await try3(); 
          console.log('[startLocalStream] Success with try3');
        } catch (e3) {
          console.log('[startLocalStream] try3 failed:', e3);
          throw new Error(`All getUserMedia attempts failed. Last error: ${e3 instanceof Error ? e3.message : String(e3)}`);
        }
      }
    }

    if (!stream) {
      throw new Error('Failed to get media stream from all attempts');
    }

    const audioTracks = (stream as any)?.getAudioTracks?.() || [];
    const videoTracks = (stream as any)?.getVideoTracks?.() || [];
    const a = audioTracks[0];
    const v = videoTracks[0];
    
    // КРИТИЧНО: Всегда включаем микрофон и камеру в стриме (нужно для PeerConnection)
    // Но состояние UI контролируется через camOn/micOn
    if (a) { 
      a.enabled = true; // КРИТИЧНО: Микрофон включен по умолчанию
      try { (a as any).contentHint = 'speech'; } catch {} 
    }
    if (v) {
      v.enabled = true; // КРИТИЧНО: Включаем трек при создании стрима
    }

    setLocalStream(stream);
    setMicOn(!!a?.enabled); // КРИТИЧНО: Микрофон включен по умолчанию
    // КРИТИЧНО: При создании стрима камера всегда включена (пользователь может выключить через toggleCam)
    setCamOn(!!v);
    await new Promise(r => setTimeout(r, 30));
    setLocalRenderKey(k => k + 1);

    try { forceSpeakerOnHard(); } catch {}
    if (Platform.OS === 'ios') configureIOSAudioSession();

    return stream;
  }, [localStream, resume, fromPiP, pipLocalStream, isValidStream, isInactiveState, friendCallAccepted]);
  
  const ensureStreamReady = useCallback(async () => {
    // КРИТИЧНО: Проверяем валидность существующего стрима
    if (localStream && isValidStream(localStream)) {
      console.log('[ensureStreamReady] Local stream already exists and is valid, returning existing stream');
      // КРИТИЧНО: Убеждаемся что камера включена при использовании существующего стрима
      const videoTrack = localStream.getVideoTracks()?.[0];
      if (videoTrack) {
        videoTrack.enabled = true;
        setCamOn(true);
        console.log('[ensureStreamReady] Enabled video track in existing stream');
      }
      return localStream;
    }
    
    // Если стрим существует но невалиден, очищаем его
    if (localStream && !isValidStream(localStream)) {
      console.log('[ensureStreamReady] Existing local stream is invalid, clearing and creating new one');
      try {
        const tracks = localStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      setLocalStream(null);
      localStreamRef.current = null;
    }
    
    console.log('[ensureStreamReady] No valid local stream, starting new one');
    
    // КРИТИЧНО: Если находимся в неактивном состоянии, но это активный звонок (например, приняли входящий),
    // выходим из неактивного состояния перед созданием стрима
    if (isInactiveStateRef.current && (friendCallAccepted || isDirectCall || inDirectCall)) {
      console.log('[ensureStreamReady] In inactive state but active call detected, exiting inactive state');
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      // Даем время state обновиться
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const stream = await startLocalStream('front');
    
    // КРИТИЧНО: Убеждаемся что камера включена после создания стрима
    if (stream) {
      const videoTrack = stream.getVideoTracks()?.[0];
      if (videoTrack) {
        videoTrack.enabled = true;
        setCamOn(true);
        console.log('[ensureStreamReady] Enabled video track after startLocalStream');
      }
    }
    
    // КРИТИЧНО: Если startLocalStream вернул null (например, из-за проверки isInactiveState),
    // создаем напрямую ТОЛЬКО если это активный звонок (не завершенный)
    if (!stream && (friendCallAccepted || isDirectCall || inDirectCall)) {
      console.log('[ensureStreamReady] startLocalStream returned null, creating stream directly for active call');
      try {
        const audioConstraints: any = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          googEchoCancellation: true,
          googNoiseSuppression: true,
          googAutoGainControl: true,
        };
        const newStream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
        if (newStream) {
          setLocalStream(newStream);
          localStreamRef.current = newStream;
          const videoTrack = newStream.getVideoTracks()?.[0];
          const audioTrack = newStream.getAudioTracks()?.[0];
          if (videoTrack) {
            videoTrack.enabled = true;
            setCamOn(true);
          }
          if (audioTrack) {
            audioTrack.enabled = true; // КРИТИЧНО: Микрофон включен по умолчанию
            setMicOn(true);
          }
          console.log('[ensureStreamReady] Created stream directly via getUserMedia');
          return newStream;
        }
      } catch (directError) {
        console.error('[ensureStreamReady] Error creating stream directly:', directError);
        return null;
      }
    }
    
    return stream;
  }, [localStream, startLocalStream, isValidStream, friendCallAccepted, isDirectCall, inDirectCall]);

  const isMicReallyOn = useCallback(() => {
    // КРИТИЧНО: Используем localStreamRef.current вместо localStream state
    // так как ref может быть актуальнее state, особенно при быстрых изменениях
    const stream = localStreamRef.current || localStream;
    const a = stream?.getAudioTracks?.()[0];
    return !!(a && a.enabled && a.readyState === 'live');
  }, [localStream, micOn]);

  const isCamReallyOn = useCallback(() => {
    const v = localStream?.getVideoTracks?.()[0];
    return !!(v && v.enabled && v.readyState === 'live');
  }, [localStream]);

  // Универсальная навигация: чистый reset в VideoChat (без Home под низом)
  const goToVideoChatClean = useCallback((params?: any) => {
    try {
      const nav = (global as any).__navRef;
      if (nav?.isReady && nav.isReady() && nav.dispatch) {
        nav.dispatch(
          CommonActions.reset({ index: 0, routes: [{ name: 'VideoChat' as any, params }] })
        );
      }
    } catch {}
  }, []);

  // Универсальная навигация: стек [Home, VideoChat] (VideoChat активен)
  const goToVideoChatWithHomeUnder = useCallback((params?: any) => {
    try {
      const nav = (global as any).__navRef;
      if (nav?.isReady && nav.isReady() && nav.dispatch) {
        nav.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'Home' as any },
              { name: 'VideoChat' as any, params },
            ],
          })
        );
      }
    } catch {}
  }, []);

  // Мгновенный переход на Home
  const goToHomeInstant = useCallback(() => {
    try {
      const nav = (global as any).__navRef;
      if (nav?.isReady && nav.isReady() && nav.dispatch) {
        // Принудительно сбрасываем навигацию и переходим на Home
        nav.dispatch(
          CommonActions.reset({ 
            index: 0, 
            routes: [{ name: 'Home' as any }] 
          })
        );
        logger.debug('[goToHomeInstant] Navigated to Home screen');
      }
    } catch (error) {
      logger.error('[goToHomeInstant] Navigation error:', error);
    }
  }, []);

  // Переход на исходный экран (если указан returnTo) или на Home
  const goToOriginOrHomeInstant = useCallback(() => {
    try {
      const target = returnTo || 'Home';
      const nav = (global as any).__navRef;
      if (nav?.isReady && nav.isReady() && nav.dispatch) {
        nav.dispatch(
          CommonActions.reset({ 
            index: 0, 
            routes: [{ name: target as any }] 
          })
        );
        logger.debug('[goToOriginOrHomeInstant] Navigated to:', target);
      }
    } catch (error) {
      logger.error('[goToOriginOrHomeInstant] Navigation error:', error);
    }
  }, [returnTo]);

  // --------------------------
  // Mic level meter — работаем ТОЛЬКО при соединении
  // --------------------------
  const stopMicMeter = useCallback(() => {
    if (micStatsTimerRef.current) { clearInterval(micStatsTimerRef.current); micStatsTimerRef.current = null; }
    setMicLevel(0);
    // КРИТИЧНО: Обновляем micLevel=0 в PiP при остановке метра
    try {
      pip.updatePiPState({ micLevel: 0 });
    } catch (e) {
      // Игнорируем ошибки если PiP контекст недоступен
    }
    energyRef.current = null; durRef.current = null;   // сбрасываем накопители
    lowLevelCountRef.current = 0; // Сбрасываем счетчик низких значений
  }, [pip]);
  
  const startMicMeter = useCallback(() => {
    const pc = peerRef.current;
    // Для звонков друзьям проверяем наличие PC и соединения, но не требуем строго pcConnectedRef
    // так как для друзей соединение может устанавливаться по-другому
    if (!pc) { 
      stopMicMeter(); 
      return; 
    }
    // Для звонков друзьям проверяем наличие активного звонка вместо только pcConnectedRef
    const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
    if (!hasActiveCall && !pcConnectedRef.current) { 
      stopMicMeter(); 
      return; 
    }
    if (micStatsTimerRef.current) {
      return;
    }
  
    micStatsTimerRef.current = setInterval(async () => {
      try {
        // КРИТИЧНО: Проверяем текущий PC из ref (не замыкаем старый)
        const currentPc = peerRef.current;
        if (!currentPc || currentPc.signalingState === 'closed' || currentPc.connectionState === 'closed') {
          stopMicMeter();
          return;
        }
        
        // КРИТИЧНО: Проверяем что звонок не завершен
        if (isInactiveStateRef.current) {
          stopMicMeter();
          return;
        }
        
        // КРИТИЧНО: Проверяем что соединение еще активно
        // Для звонков друзьям также проверяем наличие активного звонка
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        if (!pcConnectedRef.current && !hasActiveCall) {
          stopMicMeter();
          return;
        }
        
        if (!isMicReallyOn()) { 
          setMicLevel(0);
          // Обновляем micLevel=0 в PiP даже когда микрофон выключен
          try {
            pip.updatePiPState({ micLevel: 0 });
          } catch (e) {}
          // Логируем только периодически, чтобы не засорять логи
          if (Math.random() < 0.01) { // 1% шанс логирования
            const stream = localStreamRef.current || localStream;
            const a = stream?.getAudioTracks?.()[0];
            console.log('[startMicMeter] Mic not really on, skipping stats', {
              hasLocalStream: !!localStream,
              hasLocalStreamRef: !!localStreamRef.current,
              hasStream: !!stream,
              hasAudioTrack: !!a,
              trackEnabled: a?.enabled,
              trackReadyState: a?.readyState,
              micOn,
              isMicReallyOn: isMicReallyOn()
            });
          }
          return; 
        }
  
        const stats: any = await currentPc.getStats();
        let lvl = 0;
  
        stats.forEach((r: any) => {
          const isAudio =
            r.kind === 'audio' || r.mediaType === 'audio' || r.type === 'media-source' || r.type === 'track' || r.type === 'outbound-rtp';
  
          if (!isAudio) return;
  
          // 1) Прямо из audioLevel если есть
          if (typeof r.audioLevel === 'number') {
            // КРИТИЧНО: На iOS audioLevel может быть в диапазоне 0-127, на Android 0-1
            // Нормализуем для iOS
            const audioLvl = Platform.OS === 'ios' && r.audioLevel > 1 
              ? r.audioLevel / 127 
              : r.audioLevel;
            lvl = Math.max(lvl, audioLvl);
          }
  
          // 2) Fallback: по totalAudioEnergy/totalSamplesDuration
          if (typeof r.totalAudioEnergy === 'number' && typeof r.totalSamplesDuration === 'number') {
            const prevE = energyRef.current, prevD = durRef.current;
            if (prevE != null && prevD != null) {
              const dE = r.totalAudioEnergy - prevE;
              const dD = r.totalSamplesDuration - prevD;
              if (dD > 0) {
                const inst = Math.sqrt(Math.max(0, dE / dD)); // нормализация
                lvl = Math.max(lvl, inst);
              } else {
                // Если нет новых сэмплов - звука нет
                // Не сбрасываем сразу, но это будет учтено ниже
              }
            }
            energyRef.current = r.totalAudioEnergy;
            durRef.current = r.totalSamplesDuration;
          }
        });
  
        // clamp [0..1]
        let normalized = Math.max(0, Math.min(1, lvl));
        
        // КРИТИЧНО: Для iOS - если уровень очень низкий несколько раз подряд, сбрасываем до 0
        // Это решает проблему, когда эквалайзер не возвращается к 0 при молчании на iOS
        // Используем более чувствительный порог и быстрее реагируем для лучшей синхронизации с Android
        if (Platform.OS === 'ios') {
          // Порог 0.015 - ниже чем threshold в VoiceEqualizer (0.03), чтобы не блокировать реальный звук
          if (normalized < 0.015) {
            // Увеличиваем счетчик низких значений
            lowLevelCountRef.current += 1;
            // Если уровень низкий 2+ раза подряд (примерно 0.36 секунды), считаем это молчанием
            // Уменьшили с 3 до 2 для более быстрой реакции
            if (lowLevelCountRef.current >= 2) {
              normalized = 0;
              // Сбрасываем накопители энергии при молчании
              energyRef.current = null;
              durRef.current = null;
            }
          } else {
            // Если уровень нормальный - сбрасываем счетчик сразу
            lowLevelCountRef.current = 0;
          }
        }
        
        setMicLevel(normalized);
        // Обновляем micLevel в PiP постоянно (не только когда видим, но и когда он может стать видимым)
        // Это гарантирует что micLevel всегда актуален в PiP контексте
        try {
          pip.updatePiPState({ micLevel: normalized });
        } catch (e) {
          // Игнорируем ошибки если PiP контекст недоступен
        }
      } catch {
        stopMicMeter();
      }
    }, 180);
  }, [isMicReallyOn, stopMicMeter, pip]);
  

  // --------------------------
  // Start / Stop / Next
  // --------------------------
  const cleanupPeer = useCallback((pc?: RTCPeerConnection | null) => {
    if (!pc) return;
    
    // Проверяем что PC еще не закрыт
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') {
      console.log('[cleanupPeer] PC already closed, but clearing handlers anyway');
      // КРИТИЧНО: Даже если PC закрыт, очищаем обработчики на всякий случай
      try { 
        (pc as any).ontrack = null; 
        (pc as any).onaddstream = null; 
        (pc as any).onicecandidate = null; 
        (pc as any).onconnectionstatechange = null;
        (pc as any).oniceconnectionstatechange = null;
        (pc as any).onsignalingstatechange = null;
        (pc as any).onicegatheringstatechange = null;
      } catch (e) {}
      return;
    }
    
    // Очищаем предварительно созданный PC если он совпадает с очищаемым
    if (preCreatedPcRef.current === pc) {
      preCreatedPcRef.current = null;
    }
    
    try {
      pc.getSenders?.().forEach((s: any) => {
        try { s.replaceTrack?.(null); } catch {}
      });
    } catch (e) {
      console.warn('[cleanupPeer] Error cleaning senders:', e);
    }
    
    // КРИТИЧНО: Очищаем ВСЕ обработчики ПЕРЕД закрытием
    try { 
      (pc as any).ontrack = null; 
      (pc as any).onaddstream = null; 
      (pc as any).onicecandidate = null; 
      (pc as any).onconnectionstatechange = null;
      (pc as any).oniceconnectionstatechange = null; // КРИТИЧНО: Очищаем обработчик ICE соединения
      (pc as any).onsignalingstatechange = null;
      (pc as any).onicegatheringstatechange = null; // КРИТИЧНО: Также очищаем этот обработчик
      console.log('🔴 [cleanupPeer] All handlers cleared');
    } catch (e) {
      console.warn('⚫ [cleanupPeer] Error clearing handlers:', e);
    }
    
    try { 
      pc.close(); 
      console.log('🔴 [cleanupPeer] PC closed successfully');
    } catch (e) {
      console.warn('⚫ [cleanupPeer] Error closing PC:', e);
    }
  }, []);

  const onStartStop = useCallback(async () => {
    if (started) {
      // === STOP ===
      setLoading(false);

      // Метр — в ноль и стоп
      stopMicMeter();

      setStarted(false);
      setIsInactiveState(false); // Сбрасываем неактивное состояние при остановке поиска
      setWasFriendCallEnded(false); // Сбрасываем флаг завершенного звонка

      try { stopSpeaker(); } catch {}
      try { socket.emit('stop'); } catch {}

      // КРИТИЧНО: Покидаем комнату при остановке (и для direct calls, и для рандомного чата)
      try {
        const currentRoomId = roomIdRef.current;
        if (currentRoomId) {
          socket.emit('room:leave', { roomId: currentRoomId });
          roomIdRef.current = null;
          if (isDirectCall) {
          console.log('[onStartStop] Left room for direct call:', currentRoomId);
          } else {
            console.log('[onStartStop] Left room for random chat:', currentRoomId);
          }
        }
      } catch {}

      // УПРОЩЕНО: закрыть единственный peer
      cleanupPeer(peerRef.current);
      peerRef.current = null;

      // остановить локальный стрим
      stopLocalStream();

      // сброс стейта
      setLocalStream(null);
      setRemoteStream(null);
      setLocalRenderKey(k => k + 1);
      setPartnerId(null);
      setPartnerUserId(null);
      setMicOn(false);
      setCamOn(false);
      setRemoteMutedMain(false);
      setRemoteCamOn(true);
      return;
    }

    // === START ===
    const ok = await requestPermissions();
    if (!ok) {
      Alert.alert('Разрешения', 'Нет доступа к камере/микрофону');
      return;
    }

    setLoading(true);
    try {
      const stream = await startLocalStream('front');
      // КРИТИЧНО: При начале поиска камера всегда включена
      if (stream) {
        const videoTrack = stream.getVideoTracks()?.[0];
        if (videoTrack) {
          videoTrack.enabled = true;
          setCamOn(true);
          console.log('[onStartStop] Enabled camera for search start');
        }
      }
      setStarted(true);
      try { socket.emit('start'); } catch {}
    } catch (e) {
      setStarted(false);
      setLoading(false);
      Alert.alert('Ошибка', 'Не удалось запустить камеру/микрофон');
    }
  }, [started, requestPermissions, startLocalStream, cleanupPeer, stopMicMeter, isDirectCall]);

  const stopRemoteOnly = useCallback(() => {
    // Метр только при соединении — гасим
    stopMicMeter();

    // Используем нашу функцию cleanupPeer для более надежной очистки
    try {
      const pc = peerRef.current;
      if (pc) {
        console.log('[stopRemoteOnly] Cleaning up PeerConnection');
        cleanupPeer(pc);
      }
    } catch (e) {
      console.warn('[stopRemoteOnly] Error cleaning up PC:', e);
    }
    peerRef.current = null;
    
    // Очищаем предварительно созданный PC
    if (preCreatedPcRef.current) {
      try {
        cleanupPeer(preCreatedPcRef.current);
      } catch (e) {
        console.warn('[stopRemoteOnly] Error cleaning up pre-created PC:', e);
      }
      preCreatedPcRef.current = null;
    }
    // Останавливаем треки основного удалённого потока перед сбросом ссылки (safe)
    if (remoteStreamRef.current) {
      try { remoteStreamRef.current.getTracks?.().forEach((t: any) => { try { t.stop(); } catch {} }); } catch {}
      try { /* @ts-ignore */ remoteStreamRef.current = null; } catch {}
    }
    try {
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks?.().forEach((t: any) => { try { t.stop(); } catch {} });
      }
      // Явно зануляем ref, чтобы исключить повторное использование освобождённого объекта
      // (устраняет MediaStream has been disposed на некоторых девайсах)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      remoteStreamRef.current = null;
    } catch (e) {
      try { console.warn('[cleanup] remote stream already disposed'); } catch {}
    }
    setRemoteStream(null);
    
    // КРИТИЧНО: Очищаем partnerId СНАЧАЛА, чтобы предотвратить обработку устаревших событий
    const oldPartnerId = partnerIdRef.current;
    partnerIdRef.current = null;
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteMutedMain(false); // Сбрасываем состояние кнопки mute собеседника
    setRemoteCamOn(true); // Сбрасываем состояние удаленной камеры
    
    // Очищаем roomIdRef при разрыве соединения
    roomIdRef.current = null;
    
    console.log('[stopRemoteOnly] Disconnected from partner:', oldPartnerId);
    
    // Остаёмся в режиме «идёт поиск» с включённой локальной камерой
    // НЕ трогаем локальный стрим — остаёмся в режиме готовности
  }, [stopMicMeter]);


  // УПРОЩЕНО: Прервать звонок (1-на-1 friends mode) - переход в неактивное состояние
  const onAbortCall = useCallback(async () => {
    try {
        const callId = currentCallIdRef.current;
        
      logger.debug('[onAbortCall] Ending 1-on-1 call, callId:', callId);
      logger.debug('[onAbortCall] Current state:', {
        isDirectCall,
        inDirectCall,
        friendCallAccepted,
        roomId: roomIdRef.current,
      });
        
        if (!callId) {
          logger.warn('[onAbortCall] callId is empty! Cannot send call:end');
          // Попробуем использовать roomId как fallback
          const fallbackCallId = roomIdRef.current;
          if (fallbackCallId) {
            logger.debug('[onAbortCall] Using roomId as fallback callId:', fallbackCallId);
            try { socket.emit('call:end', { callId: fallbackCallId }); } catch {}
          }
        } else {
          // Отправляем call:end серверу (для обоих участников)
          try { 
            socket.emit('call:end', { callId }); 
            logger.debug('[onAbortCall] Sent call:end with callId:', callId);
          } catch (e) {
            logger.error('[onAbortCall] Failed to send call:end:', e);
          }
        }
        
        // КРИТИЧНО: Уведомляем друзей что мы снова доступны
        try {
          socket.emit('presence:update', { status: 'available' });
          console.log('[onAbortCall] Sent presence:update available');
        } catch (e) {
          console.error('[onAbortCall] Failed to send presence update:', e);
        }
        
        // КРИТИЧНО: Сначала очищаем ВСЕ refs и state связанные со звонком ПЕРЕД остановкой потоков
        // Это предотвращает восстановление состояния звонка в useEffect
        currentCallIdRef.current = null;
        roomIdRef.current = null;
        partnerUserIdRef.current = null;
        partnerIdRef.current = null;
        setPartnerUserId(null);
        setPartnerId(null);
        
        // Переходим в неактивное состояние
        logger.debug('[onAbortCall] Switching to inactive state');
        
        // КРИТИЧНО: САМОЕ ПЕРВОЕ ДЕЛО - устанавливаем peerRef.current = null и isInactiveStateRef.current = true
        // Это должно быть ДО любых других действий, чтобы обработчики видели что звонок завершен
        const pcMain = peerRef.current;
        const pcPreCreated = preCreatedPcRef.current;
        
        // КРИТИЧНО: СНАЧАЛА устанавливаем peerRef.current = null, чтобы обработчики не видели активный PC
        peerRef.current = null;
        preCreatedPcRef.current = null;
        
        // КРИТИЧНО: СНАЧАЛА очищаем ВСЕ refs СИНХРОННО
        currentCallIdRef.current = null;
        roomIdRef.current = null;
        partnerUserIdRef.current = null;
        partnerIdRef.current = null;
        
        // КРИТИЧНО: СНАЧАЛА устанавливаем isInactiveStateRef.current = true СИНХРОННО
        isInactiveStateRef.current = true;
        setIsInactiveState(true);
        console.log('🔴 [onAbortCall] Set peerRef=null, isInactiveState=true, refs cleared FIRST (before any cleanup)');
        
        // КРИТИЧНО: Теперь очищаем обработчики ПЕРЕД закрытием PC
        // Это предотвратит их срабатывание
        try {
          if (pcMain) {
            console.log('🔴 [onAbortCall] Clearing handlers from main PC');
            try {
              (pcMain as any).onconnectionstatechange = null;
              (pcMain as any).oniceconnectionstatechange = null;
              (pcMain as any).ontrack = null;
              (pcMain as any).onaddstream = null;
              (pcMain as any).onicecandidate = null;
              (pcMain as any).onsignalingstatechange = null;
              (pcMain as any).onicegatheringstatechange = null;
              console.log('🔴 [onAbortCall] Handlers cleared from main PC');
            } catch (e) {
              console.warn('⚫ [onAbortCall] Error clearing handlers from main PC:', e);
            }
          }

          if (pcPreCreated) {
            console.log('🔴 [onAbortCall] Clearing handlers from pre-created PC');
            try {
              (pcPreCreated as any).onconnectionstatechange = null;
              (pcPreCreated as any).oniceconnectionstatechange = null;
              (pcPreCreated as any).ontrack = null;
              (pcPreCreated as any).onaddstream = null;
              (pcPreCreated as any).onicecandidate = null;
              (pcPreCreated as any).onsignalingstatechange = null;
              (pcPreCreated as any).onicegatheringstatechange = null;
              console.log('🔴 [onAbortCall] Handlers cleared from pre-created PC');
            } catch (e) {
              console.warn('⚫ [onAbortCall] Error clearing handlers from pre-created PC:', e);
            }
          }
        } catch (e) {
          console.warn('⚫ [onAbortCall] Error clearing handlers:', e);
        }
        
        // КРИТИЧНО: Очищаем state
        setPartnerUserId(null);
        setPartnerId(null);
        // КРИТИЧНО: Устанавливаем флаг что звонок друга был завершен
        setWasFriendCallEnded(true);
        
        // КРИТИЧНО: Устанавливаем started в false для скрытия кнопок в блоках
        setStarted(false);
        setCamOn(false); // Выключаем камеру
        setMicOn(false); // Выключаем микрофон
        setFriendCallAccepted(false);
        setInDirectCall(false);
        
        // КРИТИЧНО: Останавливаем локальные потоки (stopLocalStream сам закроет все PeerConnection внутри)
        try {
          await stopLocalStream();
          // КРИТИЧНО: localStreamRef и localStream уже очищены в stopLocalStream
          console.log('[onAbortCall] Local stream stopped and cleared');
          
          // КРИТИЧНО: Дополнительная проверка для повторных вызовов - убеждаемся что ВСЕ треки действительно остановлены
          // Это особенно важно для второго и последующих вызовов когда камера может оставаться активной
          // КРИТИЧНО: Проверяем как localStreamRef, так и локальную переменную localStream (на случай если ref уже очищен)
          const remainingTracksAfterStop = (localStreamRef.current || localStream)?.getTracks?.() || [];
          if (remainingTracksAfterStop.length > 0) {
            console.warn('[onAbortCall] CRITICAL: Tracks still exist after stopLocalStream, force stopping:', remainingTracksAfterStop.length);
            remainingTracksAfterStop.forEach((t: any) => {
              try {
                console.warn('[onAbortCall] Force stopping remaining track:', t.kind, t.id, t.readyState);
                t.enabled = false;
                t.stop();
                try { (t as any).release?.(); } catch {}
              } catch (e) {
                console.error('[onAbortCall] Failed to stop remaining track:', e);
              }
            });
          }
          
          // КРИТИЧНО: Дополнительная проверка всех активных mediaDevices
          // Это особенно важно для iOS где индикатор камеры может оставаться активным
          try {
            const allDevices = await mediaDevices.enumerateDevices() as any[];
            const activeVideoDevices = allDevices.filter((d: any) => d.kind === 'videoinput');
            if (activeVideoDevices.length > 0) {
              console.log('[onAbortCall] Video devices still enumerated after cleanup:', activeVideoDevices.length);
            }
        } catch {}
        
          // КРИТИЧНО: Дополнительная задержка для iOS чтобы камера полностью освободилась
          // Это особенно важно при повторных вызовах
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          console.error('[onAbortCall] Error stopping local stream:', e);
        }
        
        // КРИТИЧНО: Дополнительная проверка - убеждаемся что все PeerConnection закрыты
        // peerRef и preCreatedPcRef уже установлены в null выше, поэтому просто закрываем PC
        try { 
          if (pcMain) {
            cleanupPeer(pcMain);
          }
        } catch {}
        
        try {
          if (pcPreCreated) {
            cleanupPeer(pcPreCreated);
          }
        } catch {}
        
        // КРИТИЧНО: Очищаем remote потоки - останавливаем треки перед очисткой
        try {
          const remoteStream = remoteStreamRef.current;
          if (remoteStream) {
            const tracks = (remoteStream as any).getTracks?.() || [];
            tracks.forEach((t: any) => {
              try {
                t.enabled = false;
                t.stop();
              } catch {}
            });
          }
        } catch (e) {
          console.warn('[onAbortCall] Error cleaning up remote stream:', e);
        }
        setRemoteStream(null);
        remoteStreamRef.current = null;
        // DEPRECATED: remoteRender больше не используется
        
        // КРИТИЧНО: Сбрасываем ВСЕ флаги состояния
        setRemoteMutedMain(false);
        setRemoteCamOn(false);
        setPartnerInPiP(false);
        setFriendCallAccepted(false);
        setInDirectCall(false);
        
        // Останавливаем индикаторы
        try { 
          stopMicMeter(); 
          // КРИТИЧНО: Дополнительно устанавливаем micLevel=0 для эквалайзера
          setMicLevel(0);
          try { pip.updatePiPState({ micLevel: 0 }); } catch {}
        } catch {}
        try { stopSpeaker(); } catch {}
        
        // Скрываем incoming overlay если был показан
        setIncomingOverlay(false);
        
        logger.debug('[onAbortCall] Switched to inactive state successfully');
        console.log('🔴 [onAbortCall] Call cleanup completed successfully - handlers should be cleared, no more offers should be created');
    } catch (err) {
      logger.error('Abort call error', err);
    }
  }, [isDirectCall, inDirectCall, friendCallAccepted, stopLocalStream, stopMicMeter, stopSpeaker]);

  // Callback для возврата из background
  const onReturnToCall = useCallback(() => {
    console.log('[onReturnToCall] Returning to VideoChat from background');
    
    const nav = (global as any).__navRef;
    const currentRoute = nav?.getCurrentRoute?.();
    
    console.log('[onReturnToCall] Current route:', currentRoute?.name);
    
    // Если уже на VideoChat - просто скрываем background
    if (currentRoute?.name === 'VideoChat') {
      console.log('[onReturnToCall] Already on VideoChat, just hiding background');
      // background removed
      return;
    }
    
    // Если на другом экране - НЕ навигируем, а просто скрываем background
    // Это позволит пользователю самому вернуться к звонку через навигацию
    console.log('[onReturnToCall] Not on VideoChat, just hiding background - user can navigate back manually');
    // background removed
    
    // Альтернативно: можно попробовать навигировать с сохранением состояния
    // Но это сложнее и может привести к проблемам с PeerConnection
  }, []);

  // background callbacks removed

  // Guard для предотвращения множественного выполнения возврата из PiP
  const pipResumeProcessedRef = useRef(false);
  
  // Восстанавливаем состояние звонка при монтировании если есть активный звонок
  useEffect(() => {
    // КРИТИЧНО: Если пользователь в неактивном состоянии (завершенный звонок с задизейбленной кнопкой),
    // НЕ восстанавливаем активное состояние. Исключение - только входящий звонок от друга или возврат из PiP
    // ИЛИ если уже принят входящий звонок (friendCallAccepted === true)
    if (isInactiveState && !incomingFriendCall && !(resume && fromPiP) && !friendCallAccepted) {
      // В неактивном состоянии не восстанавливаем звонок (если не принят входящий)
      return;
    }
    
    const isFrombackground = false;
    const returnToActiveCall = route?.params?.returnToActiveCall;
    const routeCallId = route?.params?.callId;
    const routeRoomId = route?.params?.roomId;
    
    // Если есть callId из роута, устанавливаем его
    if (routeCallId && routeCallId !== currentCallIdRef.current) {
      currentCallIdRef.current = routeCallId;
      // Убрали постоянный лог для уменьшения шума
      
      // Если это возврат из background, восстанавливаем roomId
      if (returnToActiveCall && !roomIdRef.current) {
        if (routeRoomId) {
          roomIdRef.current = routeRoomId;
          // Убрали постоянный лог для уменьшения шума
        } else {
          const savedStreams = { roomId: null, remoteStream: null, localStream: null };
          if (savedStreams.roomId) {
            roomIdRef.current = savedStreams.roomId;
            // Убрали постоянный лог для уменьшения шума
          }
        }
      }
    }
    
    // Обработка возврата из PiP - выполняется только один раз
    if (resume && fromPiP && !pipResumeProcessedRef.current) {
      pipResumeProcessedRef.current = true;
      const currentPip = pipRef.current;
      
      console.log('[VideoChat] Resuming call from PiP:', { callId: routeCallId, roomId: routeRoomId });
      
      // Восстанавливаем состояние звонка
      if (routeCallId) {
        currentCallIdRef.current = routeCallId;
      }
      if (routeRoomId) {
        roomIdRef.current = routeRoomId;
      }
      
      // КРИТИЧНО: Устанавливаем все флаги активного звонка для правильного отображения UI
      setStarted(true);
      setPcConnected(true);
      setInDirectCall(true);
      setFriendCallAccepted(true);
      setLoading(false); // Сбрасываем лоадер если был
      
      // КРИТИЧНО: Выходим из неактивного состояния при возврате из PiP
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      
      // КРИТИЧНО: Восстанавливаем partnerUserId из route.params (сохранено при уходе в PiP)
      const routePartnerUserId = route?.params?.peerUserId || (route?.params as any)?.partnerUserId;
      if (routePartnerUserId && !partnerUserId) {
        setPartnerUserId(routePartnerUserId);
        partnerUserIdRef.current = routePartnerUserId;
      }
      
      // КРИТИЧНО: Восстанавливаем partnerId (socket.id) из route.params для правильного восстановления соединения
      const routePartnerId = (route?.params as any)?.partnerId;
      if (routePartnerId && !partnerIdRef.current) {
        setPartnerId(routePartnerId);
        partnerIdRef.current = routePartnerId;
        console.log('[VideoChat] Restored partnerId from route params:', routePartnerId);
      }
      
      // Восстанавливаем потоки из PiP контекста
      if (currentPip.localStream) {
        setLocalStream(currentPip.localStream);
      }
      // НЕ трогаем remoteStream - им управляет только партнёр через pip:state
      
      // Включаем ТОЛЬКО локальные видео треки обратно (они были отключены для PiP)
      // КРИТИЧНО: При возврате из PiP состояние кнопки камеры должно оставаться включенной
      if (currentPip.localStream) {
        try {
          let hasEnabled = false;
          let trackWasEnabled = false;
          (currentPip.localStream as any)?.getVideoTracks?.()?.forEach((t: any) => {
            trackWasEnabled = t.enabled; // Сохраняем текущее состояние трека
            if (!t.enabled) {
              t.enabled = true;
              hasEnabled = true;
            }
          });
          if (hasEnabled) {
            console.log('[VideoChat] Re-enabled local video track');
          }
          // КРИТИЧНО: Устанавливаем camOn в true если трек включен (независимо от того, был ли он включен до этого или мы его только что включили)
          // Это гарантирует что кнопка камеры остается в правильном состоянии при возврате из PiP
          const videoTrack = (currentPip.localStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack && videoTrack.enabled) {
            setCamOn(true);
            console.log('[VideoChat] Set camOn=true after PiP return - video track is enabled');
          }
        } catch (e) {
          console.warn('[VideoChat] Error handling video track after PiP return:', e);
        }
      }
      
      // КРИТИЧНО: Также проверяем localStreamRef для обратной совместимости
      if (localStreamRef.current && !currentPip.localStream) {
        try {
          const videoTrack = localStreamRef.current.getVideoTracks?.()?.[0];
          if (videoTrack && videoTrack.enabled) {
            setCamOn(true);
            console.log('[VideoChat] Set camOn=true from localStreamRef after PiP return');
          }
        } catch {}
      }
      // НЕ трогаем remote треки - ими управляет только партнёр через pip:state
      
      // Скрываем PiP
      currentPip.hidePiP();
      
      // Если у нас есть удалённый поток из PiP-контекста — подставим его в state
      if (!remoteStreamRef.current && pipRef.current.remoteStream) {
        setRemoteStream(pipRef.current.remoteStream);
        remoteStreamRef.current = pipRef.current.remoteStream as any;
      }
      
      // Безопасно включим видеотрек удалённого потока (мы сами его выключали при входе в PiP)
      try {
        const vt = (remoteStreamRef.current as any)?.getVideoTracks?.()?.[0];
        if (vt && !vt.enabled) vt.enabled = true;
      } catch {}
      
      setRemoteCamOn(true);
      setRemoteViewKey(Date.now());
      setPartnerInPiP(false);
      
      // КРИТИЧНО: Синхронизируем состояние камеры с партнером при возврате из PiP
      setTimeout(() => {
        try {
          sendCameraState();
          console.log('[VideoChat] Sent camera state after returning from PiP');
        } catch (e) {
          console.warn('[VideoChat] Failed to send camera state after PiP return:', e);
        }
      }, 300);
      
      console.log('[VideoChat] Call resumed from PiP successfully');
    } else if (!resume || !fromPiP) {
      // Сбрасываем guard если параметры изменились (например, новый звонок)
      pipResumeProcessedRef.current = false;
    }
    
    // КРИТИЧНО: НЕ восстанавливаем состояние звонка если находимся в неактивном состоянии
    // Это предотвращает случайное восстановление после завершения звонка
    // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: также не восстанавливаем если wasFriendCallEnded === true (звонок друга был завершен)
    // КРИТИЧНО: Дополнительная проверка - убеждаемся что currentCallIdRef тоже не очищен (если это звонок друга)
    // КРИТИЧНО: Также проверяем что roomIdRef и partnerUserIdRef не очищены (если они null, значит звонок завершен)
    const hasActiveCallId = currentCallIdRef.current && (isDirectCall || inDirectCall || friendCallAccepted);
    const hasActiveRefs = roomIdRef.current && partnerUserIdRef.current && partnerIdRef.current;
    const shouldRestoreCall = hasActiveRefs && (!started || isFrombackground || returnToActiveCall) && !isInactiveState && !wasFriendCallEnded && hasActiveCallId;
    if (shouldRestoreCall) {
      // Логируем только один раз при первом восстановлении
      if (!lastRouteParamsRef.current?.restored) {
        console.log('[VideoChat] Restoring call state on mount:', {
          roomId: roomIdRef.current,
          partnerUserId: partnerUserIdRef.current,
          partnerId: partnerIdRef.current,
          currentCallId: currentCallIdRef.current,
          currentStarted: started,
          isFrombackground,
          returnToActiveCall,
          routeCallId,
          isInactiveState,
          wasFriendCallEnded,
          hasActiveCallId,
          hasActiveRefs
        });
        if (!lastRouteParamsRef.current) lastRouteParamsRef.current = {};
        lastRouteParamsRef.current.restored = true;
      }
      
      // КРИТИЧНО: Восстанавливаем состояние звонка только если НЕ в неактивном состоянии
      // (неактивное состояние обрабатывается выше через return в начале useEffect)
      // КРИТИЧНО: НЕ восстанавливаем состояние если был завершен звонок друга
      if (!wasFriendCallEnded && hasActiveCallId) {
      setStarted(true);
      setPcConnected(true);
      setInDirectCall(true);
        setFriendCallAccepted(true); // КРИТИЧНО: Для инициатора устанавливаем friendCallAccepted при восстановлении
      } else {
        console.log('[useEffect restore call] Skipping state restoration - friend call ended or no active call ID');
        return; // Выходим если звонок завершен
      }
      
      // Показываем PiP для звонков друзей при восстановлении
      if ((isDirectCall || inDirectCall) && localStream) {
        const partner = partnerUserId 
          ? friends.find(f => String(f._id) === String(partnerUserId))
          : null;
        const partnerNick = partner?.nick || 'Друг';
        
        // Строим полный URL аватара из поля avatar (проверяем что не пустая строка)
        let partnerAvatarUrl: string | undefined = undefined;
        if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
          const SERVER_CONFIG = require('../src/config/server').SERVER_CONFIG;
          const serverUrl = SERVER_CONFIG.BASE_URL;
          partnerAvatarUrl = partner.avatar.startsWith('http') 
            ? partner.avatar 
            : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
        }
        
        pip.showPiP({
          callId: currentCallIdRef.current || '',
          roomId: roomIdRef.current || '',
          partnerName: partnerNick,
          partnerAvatarUrl: partnerAvatarUrl,
          muteLocal: !micOn,
          muteRemote: remoteMutedMain,
          localStream: localStream || null,
          remoteStream: remoteStream || null,
          navParams: {
            ...route?.params,
            peerUserId: partnerUserId || partnerUserIdRef.current,
            partnerId: partnerId || partnerIdRef.current, // КРИТИЧНО: Сохраняем partnerId для восстановления соединения
          } as any,
        });
        // Обновляем micLevel в PiP сразу после показа
        pip.updatePiPState({ micLevel: micLevel });
      }
      
      // Восстанавливаем потоки из глобального контекста background или из refs
      const savedStreams = { roomId: null, remoteStream: null, localStream: null };
      // Убрали постоянный лог для уменьшения шума

      // НЕ трогаем remoteStream и remoteCamOn - ими управляет только партнёр через pip:state
      if (remoteStreamRef.current) {
        setRemoteStream(remoteStreamRef.current);
        // remoteCamOn управляется только через pip:state
      }
      
      if (savedStreams.localStream) {
        setLocalStream(savedStreams.localStream);
        localStreamRef.current = savedStreams.localStream;
        // Убрали постоянный лог для уменьшения шума
      } else if (localStreamRef.current) {
        setLocalStream(localStreamRef.current);
        // Убрали постоянный лог для уменьшения шума
      }
      
      // Принудительно обновляем ключи рендера
      // DEPRECATED: remoteRenderKey больше не используется
      setLocalRenderKey(prev => prev + 1);
      
      // КРИТИЧНО: Обновляем состояние локальной камеры только если НЕ в неактивном состоянии
      // В неактивном состоянии камера должна быть выключена
      // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: также не включаем камеру если был завершен звонок друга
      if (!isInactiveState && !wasFriendCallEnded && hasActiveCallId) {
      setCamOn(true);
      }
      
      // Если это возврат из background или возврат к активному звонку, сразу устанавливаем friendCallAccepted
      if (isFrombackground || returnToActiveCall) {
        setFriendCallAccepted(true);
        setInDirectCall(true);
        // ПРИНУДИТЕЛЬНЫЙ РЕРЕНДЕР RTCView для восстановления видеопотоков
        setLocalRenderKey(prev => prev + 1);
        // DEPRECATED: remoteRenderKey больше не используется
        // Убрали постоянный лог для уменьшения шума
        
        // НЕ создаем новый PeerConnection при возврате из background
        // Убрали постоянный лог для уменьшения шума
        return;
      }
    }
  }, [started, route?.params?.returnToActiveCall, route?.params?.callId, route?.params?.roomId, resume, fromPiP, isInactiveState, incomingFriendCall, friendCallAccepted, wasFriendCallEnded]); // Добавлены friendCallAccepted и wasFriendCallEnded для отслеживания принятого звонка и завершенного звонка друга

  const onNext = useCallback(async () => {
    // ЗАЩИТА ОТ СПАМА: Блокируем кнопку на 1.5 секунды
    if (isNexting) {
      console.log('[onNext] Button blocked - preventing spam clicks');
      return;
    }
    
    console.log('[onNext] User manually requested next partner');
    setIsNexting(true);
    
    // Устанавливаем флаг что это ручной запрос (не автоматический поиск)
    manuallyRequestedNextRef.current = true;
    
    // МГНОВЕННАЯ ОЧИСТКА: Очищаем remote данные до прихода нового match_found
    console.log('[onNext] Instant clear of remote data for faster connection');
    setRemoteStream(null);
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteCamOn(true);
    setRemoteMutedMain(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при очистке
    
    // Завершаем только удалённое соединение, локальная камера остаётся включённой
    stopRemoteOnly();
    
    // Ждем чтобы PC полностью закрылся (уменьшили задержку для ускорения)
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // КРИТИЧНО: Покидаем текущую комнату перед поиском нового собеседника (только для direct calls)
    try {
      const currentRoomId = roomIdRef.current;
      if (currentRoomId && isDirectCall) {
        socket.emit('room:leave', { roomId: currentRoomId });
        roomIdRef.current = null;
        console.log('[onNext] Left room for direct call:', currentRoomId);
      } else if (!isDirectCall) {
        console.log('[onNext] Random chat - no room to leave');
      }
    } catch {}
    
    // Если локального стрима нет (например, пришли из Home), включим его
    // КРИТИЧНО: НЕ запускаем камеру если находимся в неактивном состоянии (завершенный звонок)
    if (!localStreamRef.current && !isInactiveStateRef.current) {
      try { 
        await startLocalStream?.('front'); 
      } catch (e) {
        console.warn('[onNext] Failed to start local stream:', e);
      }
    } else if (isInactiveStateRef.current) {
      console.log('[onNext] Skipping startLocalStream - in inactive state');
    }
    
    // УСКОРЕНИЕ: Предварительно создаем PC в фоне для быстрого подключения
    setTimeout(() => {
      if (localStreamRef.current) {
        preCreatePeerConnection();
      }
    }, 100);
    
    try { socket.emit('next'); } catch {}
    console.log('[onNext] Emitted next event');
    
    // КРИТИЧНО: Устанавливаем loading в true для показа лоадера при поиске
    setLoading(true);
    console.log('[onNext] Set loading to true after emit next for search');
    
    // РАЗБЛОКИРОВКА КНОПКИ: Через 1.5 секунды разрешаем снова нажимать
    setTimeout(() => {
      setIsNexting(false);
      console.log('[onNext] Button unblocked - ready for next click');
    }, 1500);
  }, [stopRemoteOnly, startLocalStream, isDirectCall, isNexting]);

  // --------------------------
  // Local toggles
  // --------------------------
  const toggleMic = useCallback(async () => {
    // КРИТИЧНО: Используем localStreamRef.current для работы даже когда компонент размонтирован (в PiP)
    const stream = localStreamRef.current || localStream;
    if (!stream) {
      return; // не трогаем камеру/мик, если поток не запущен
    }
    const t = stream?.getAudioTracks?.()[0];
    if (!t) {
      return;
    }

    t.enabled = !t.enabled;
    setMicOn(t.enabled);

    // Обновляем состояние PiP
    if (pip.visible) {
      pip.updatePiPState({ isMuted: !t.enabled });
    }

    // Если микрофон выключили — просто показываем 0, без доп. логов
    if (!t.enabled) {
      setMicLevel(0);
      // КРИТИЧНО: Обновляем micLevel=0 в PiP и останавливаем метр
      try {
        pip.updatePiPState({ micLevel: 0, isMuted: true });
      } catch (e) {
        // Игнорируем ошибки если PiP контекст недоступен
      }
      stopMicMeter(); // Останавливаем метр при выключении микрофона
      return;
    }

    // Если микрофон включили и есть соединение — убеждаемся, что метр запущен
    // Для звонков друзьям запускаем метры даже если pcConnectedRef еще не установлен
    // КРИТИЧНО: Используем refs для работы даже когда компонент размонтирован (в PiP)
    const remoteStreamForCheck = remoteStream || (pip.visible ? pip.remoteStream : null);
    if (remoteStreamForCheck || stream) {
      // Небольшая задержка для звонков друзьям, чтобы дать время на установку соединения
      setTimeout(() => {
        startMicMeter();
      }, 300);
    }
  }, [ensureStreamReady, localStream, remoteStream, startMicMeter, pip]);

  // Функция для отправки текущего состояния камеры
  const sendCameraState = useCallback((toPartnerId?: string) => {
    const targetPartnerId = toPartnerId || partnerId;
    if (!targetPartnerId) return;
    
    // Защита от слишком частых отправок (не чаще 1 раза в 500мс)
    const now = Date.now();
    if (now - lastCameraStateRef.current < 500) {
      return;
    }
    lastCameraStateRef.current = now;
    
    const videoTrack = (localStreamRef.current as any)?.getVideoTracks?.()?.[0];
    const isEnabled = videoTrack?.enabled ?? false;
    
    console.log('[sendCameraState] Sending current camera state:', { 
      enabled: isEnabled, 
      from: socket.id,
      to: targetPartnerId 
    });
    
    socket.emit("cam-toggle", { 
      enabled: isEnabled, 
      from: socket.id 
    });
  }, [partnerId]);

  const toggleCam = useCallback(() => {
    if (!localStreamRef.current) return;

    const videoTrack = (localStreamRef.current as any)?.getVideoTracks?.()?.[0];
    if (!videoTrack) return;

    setCamOn((prev) => {
      const newValue = !prev;

      videoTrack.enabled = newValue;

      // отправляем событие собеседнику с указанием отправителя
      console.log('[toggleCam] Sending cam-toggle event:', { 
        enabled: newValue, 
        from: socket.id,
        partnerId 
      });
      socket.emit("cam-toggle", { 
        enabled: newValue, 
        from: socket.id 
      });

      return newValue;
    });
  }, [partnerId]);


  const toggleRemoteAudio = useCallback(() => {
    // КРИТИЧНО: Используем remoteStream или pip.remoteStream для работы даже когда компонент размонтирован (в PiP)
    const stream = remoteStream || (pip.visible ? pip.remoteStream : null);
    if (!stream) {
      return;
    }
    
    (stream as any)?.getAudioTracks?.()?.forEach((tr: any) => (tr.enabled = !tr.enabled));
    setRemoteMutedMain(p => !p);
    
    // Обновляем состояние PiP
    if (pip.visible) {
      pip.updatePiPState({ isRemoteMuted: !remoteMutedMain });
    }
  }, [remoteStream, pip, remoteMutedMain]);

  // Регистрируем колбэки для PiP
  useEffect(() => {
    onRegisterCallbacks({
      returnToCall: () => {
        // Логика возврата обрабатывается в глобальном PiPProvider
      },
      endCall: onAbortCall,
      toggleMic: toggleMic,
      toggleRemoteAudio: toggleRemoteAudio,
    });
    
    // КРИТИЧНО: Регистрируем функцию очистки в глобальном месте
    // Это нужно чтобы можно было вызвать очистку даже когда компонент размонтирован (в PiP)
    try {
      if ((global as any).__endCallCleanupRef) {
        (global as any).__endCallCleanupRef.current = onAbortCall;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering endCall cleanup:', e);
    }
    
    // КРИТИЧНО: Регистрируем функцию переключения микрофона в глобальном месте
    // Это нужно чтобы можно было запустить startMicMeter даже когда компонент размонтирован (в PiP)
    try {
      if ((global as any).__toggleMicRef) {
        (global as any).__toggleMicRef.current = toggleMic;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering toggleMic:', e);
    }
    
    // КРИТИЧНО: Регистрируем функцию переключения удаленного аудио в глобальном месте
    // Это нужно чтобы можно было переключать динамик даже когда компонент размонтирован (в PiP)
    try {
      if ((global as any).__toggleRemoteAudioRef) {
        (global as any).__toggleRemoteAudioRef.current = toggleRemoteAudio;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering toggleRemoteAudio:', e);
    }
  }, [onRegisterCallbacks, onAbortCall, toggleMic, toggleRemoteAudio]);


  // Функция для показа PiP при выходе со страницы
  const showPiPOnExit = useCallback(() => {
    const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
    const hasActiveCall = !!roomIdRef.current;
    
      // Для звонков друзей показываем PiP даже без потоков - они могут быть в refs
      if (isFriendCall && hasActiveCall) {
        const partner = friends.find(f => String(f._id) === String(partnerUserId));
        const partnerNick = partner?.nick || 'Друг';
        // Строим полный URL аватара из поля avatar (проверяем что не пустая строка)
        let partnerAvatarUrl: string | undefined = undefined;
        if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
          const SERVER_CONFIG = require('../src/config/server').SERVER_CONFIG;
          const serverUrl = SERVER_CONFIG.BASE_URL;
          partnerAvatarUrl = partner.avatar.startsWith('http') 
            ? partner.avatar 
            : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
        }
      // Используем потоки из refs если state потоки недоступны
      const finalLocalStream = localStream || localStreamRef.current;
      const finalRemoteStream = remoteStream || remoteStreamRef.current;
      
      // Отключаем ВИДЕО, но не аудио для оптимизации PiP
      try { 
        finalLocalStream?.getVideoTracks()?.forEach((t: any) => { t.enabled = false; }); 
      } catch {}
      
      try {
        finalRemoteStream?.getVideoTracks()?.forEach((t: any) => { t.enabled = false; }); 
      } catch {}
      
      // КРИТИЧНО: НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      if (isInactiveState) {
        console.log('[showPiPOnExit] In inactive state, skipping PiP');
        return;
      }
      
      // КРИТИЧНО: Сохраняем partnerUserId в navParams для восстановления при возврате
      pip.showPiP({
        callId: currentCallIdRef.current || '',
        roomId: roomIdRef.current || '',
        partnerName: partnerNick,
        partnerAvatarUrl: partnerAvatarUrl,
        muteLocal: !micOn,
        muteRemote: remoteMutedMain,
        localStream: finalLocalStream || null,
        remoteStream: finalRemoteStream || null,
        navParams: {
          ...route?.params,
          peerUserId: partnerUserId || partnerUserIdRef.current,
          partnerId: partnerId || partnerIdRef.current, // КРИТИЧНО: Сохраняем partnerId для восстановления соединения
        } as any,
      });
      
      // Отправляем партнеру что мы ушли в PiP
      const isFriendCallActive = isDirectCall || inDirectCall || friendCallAccepted;
      if (isFriendCallActive && roomIdRef.current) {
        try {
          const roomId = roomIdRef.current;
          socket.emit('pip:state', { 
            inPiP: true, 
            roomId: roomId,
            from: socket.id 
          });
        } catch (e) {
          console.warn('[showPiPOnExit] ❌ Error sending pip:state:', e);
        }
      }
    }
  }, [isDirectCall, inDirectCall, friendCallAccepted, remoteStream, localStream, localStreamRef, remoteStreamRef, friends, partnerUserId, micOn, remoteMutedMain, pip, route, isInactiveState]);

  // Обработчик кнопки "Назад" на Android
  useEffect(() => {
    const backAction = () => {
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
      const hasActiveCall = !!roomIdRef.current;
      
      console.log('[BackHandler] Android back button pressed:', {
        isFriendCall,
        hasActiveCall,
        roomId: roomIdRef.current,
        isDirectCall,
        inDirectCall,
        friendCallAccepted,
        isInactiveState,
      });
      
      // КРИТИЧНО: НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      // В этом случае просто возвращаемся назад на Home
      if (isInactiveState) {
        console.log('[BackHandler] In inactive state, just navigating back without PiP');
        navigation.goBack();
        return true;
      }
      
      if (isFriendCall && hasActiveCall) {
        console.log('[BackHandler] Android back button - showing PiP and navigating back');
        // Сбрасываем loading при нажатии назад
        setLoading(false);
        showPiPOnExit();
        // Навигируем назад
        setTimeout(() => {
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Home' as never);
          }
        }, 100);
        return true; // Предотвращаем выход из приложения
      }
      
      console.log('[BackHandler] Conditions not met, allowing default behavior');
      return false; // Позволяем обычное поведение
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    
    return () => backHandler.remove();
  }, [isDirectCall, inDirectCall, friendCallAccepted, showPiPOnExit, navigation, isInactiveState]);

  // Обработчик жестов для обнаружения свайпов навигации
  useEffect(() => {
    const handleGesture = (event: any) => {
      const { translationX, translationY, velocityX, velocityY } = event.nativeEvent;
      
      // Обнаруживаем только свайпы влево и вверх (свайп вправо - обычная навигация назад)
      const isSwipeLeft = translationX < -100 && Math.abs(velocityX) > 500;
      const isSwipeUp = translationY < -100 && Math.abs(velocityY) > 500;
      
      if ((isSwipeLeft || isSwipeUp) && (isDirectCall || inDirectCall || friendCallAccepted)) {
        console.log('[GestureHandler] Navigation swipe detected - showing PiP', { isSwipeLeft, isSwipeUp });
        showPiPOnExit();
      }
    };

    // Добавляем обработчик жестов на корневой View
    return () => {
      // Cleanup будет в PanGestureHandler
    };
  }, [isDirectCall, inDirectCall, friendCallAccepted, showPiPOnExit]);

  // --------------------------
  // Friends & presence
  // --------------------------
  useEffect(() => {
    const offIncoming = onCallIncoming?.((d) => {
      console.log('[onCallIncoming] Received call:incoming', d);
      try { 
        currentCallIdRef.current = d?.callId || null;
        console.log('[onCallIncoming] Set currentCallIdRef to:', currentCallIdRef.current);
      } catch {}
      // Присоединяемся к комнате звонка, чтобы получать call:ended
      try { 
        if (d?.callId && roomIdRef.current !== d.callId) {
          roomIdRef.current = d.callId;
          socket.emit('room:join:ack', { roomId: d.callId });
          console.log('[onCallIncoming] Sent room:join:ack for roomId:', d.callId);
        }
      } catch {}
      // Лимит: сервер блокирует третьего участника через call:busy
      // Фиксируем маршрут на момент входящего звонка
      try {
        const nav = (global as any).__navRef;
        const state = nav?.getRootState?.();
        const idx = state?.index ?? 0;
        const routes = state?.routes || [];
        const cur = routes[idx];
        if (cur?.name) callOriginRef.current = { name: cur.name, params: cur.params };
      } catch {}
      // Отображаем модалку входящего звонка друга внутри блока Собеседник
      setIncomingCall(d);
      setIncomingOverlay(true);
      setIncomingFriendCall({ from: d.from, nick: d.fromNick });
      setFriendCallAccepted(false);
      startIncomingAnim();
    });
    socket.on("cam-toggle", ({ enabled, from }) => {
      // УПРОЩЕНО: только один собеседник
      console.log('[cam-toggle] Received:', { enabled, from, partnerId, partnerIdRef: partnerIdRef.current, roomId: roomIdRef.current });
      console.log('[cam-toggle] Current remoteCamOn state before update:', remoteCamOn);
      
      // КРИТИЧНО: Для звонков друзей проверяем наличие активной комнаты или прямого звонка
      const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
      const hasActiveRoom = !!roomIdRef.current;
      
      // Для рандомного чата проверяем что это событие от текущего партнера (по socket.id)
      // Для звонков друзей принимаем событие если есть активная комната (событие пришло через комнату)
      const shouldProcess = isDirectFriendCall 
        ? hasActiveRoom  // Для звонков друзей - если есть комната, значит это от нашего партнера
        : (partnerIdRef.current === from);  // Для рандомного чата - проверяем по socket.id
      
      if (!shouldProcess) {
        console.log('[cam-toggle] Ignoring event - not from current partner:', { 
          from, 
          currentPartnerId: partnerIdRef.current, 
          isDirectFriendCall,
          hasActiveRoom 
        });
        return;
      }
      
      // если partnerId ещё не восстановился — поднимаем его из 'from' (для рандомного чата)
      if (!isDirectFriendCall && !partnerIdRef.current) {
          partnerIdRef.current = from;
          setPartnerId(from);
          console.log('[cam-toggle] partnerId fallback set to', from);
      }

      // КРИТИЧНО: Обновляем remoteCamOn
      setRemoteCamOn(!!enabled);
      console.log('[cam-toggle] Updated remoteCamOn to:', enabled);
      
      // Принудительное обновление RTCView при изменении состояния камеры
      setRemoteViewKey(Date.now());
      
      // КРИТИЧНО: Если камера включена — сбрасываем флаг PiP (самовосстановление заглушки)
      if (enabled) {
        setPartnerInPiP(false);
        console.log('[cam-toggle] Camera enabled, reset partnerInPiP flag');
      }
      
      // КРИТИЧНО: Если камера выключена, показываем заглушку
      if (!enabled) {
        console.log('[cam-toggle] Camera disabled, showing away placeholder');
      } else {
        console.log('[cam-toggle] Camera enabled, showing video');
      }
    });
  
    return () => {
      offIncoming?.();
      socket.off("cam-toggle");
    };
  }, [partnerId, isDirectCall, inDirectCall, friendCallAccepted]);
  

  useEffect(() => {
    const offReq = onFriendRequest?.(({ from, fromNick }) => { 
      setIncomingFriendFrom(from); 
      setFriendModalVisible(true);
      // Сохраняем никнейм в кэш, если он есть
      if (fromNick) {
        setUserNicks(prev => ({ ...prev, [from]: fromNick }));
      }
    });
    const offAdded = onFriendAdded?.(({ userId }) => {
      try { fetchFriends?.().then((r:any)=> setFriends(r?.list || [])).catch(()=>{}); } catch {}
      if (String(userId) === String(partnerUserId)) {
        setAddPending(false);
        setAddBlocked(true);
        showToast('Добавили в друзья');
      }
    });
    const offAccepted = onFriendAccepted?.(({ userId }) => {
      setAddPending(false);
      try { lastFriendRequestToRef.current = null; } catch {}
      fetchFriends?.().then((r: any) => setFriends(r?.list || [])).catch(() => {});
      if (String(userId) === String(partnerUserId)) showToast('Добавили в друзья');
    });
    const offPresence = onPresenceUpdate?.((_list) => { fetchFriends?.().then((r:any)=> setFriends(r?.list || [])).catch(()=>{}); });
    const offDecl = onFriendDeclined?.(({ userId }: { userId: string }) => {
      setAddPending(false);
      setAddBlocked(true);
      const lastTo = lastFriendRequestToRef.current;
      if (lastTo && String(lastTo) === String(userId || partnerUserId)) {
        showToast('Вам отказано');
      }
      try { lastFriendRequestToRef.current = null; } catch {}
    });

    return () => { offReq?.(); offAdded?.(); offAccepted?.(); offPresence?.(); offDecl?.(); };
  }, [partnerUserId, showToast]);

  // Сброс флага "отказано" при новом матч-идентификаторе: пользователь может снова отправить заявку
  useEffect(() => { setAddPending(false); setAddBlocked(false); clearDeclinedBlock(); }, [partnerId]);

  // --------------------------
  // Signaling (single initiator)
  // --------------------------
  const attachRemoteHandlers = useCallback((pc: RTCPeerConnection, setToId?: string) => {
    const handleRemote = (e: any) => {
      console.log('[handleRemote] Called with event:', e);
      console.log('[handleRemote] Current states:', {
        hasRemoteStream: !!remoteStream,
        remoteCamOn,
        loading,
        started,
        isDirectCall,
        inDirectCall,
        friendCallAccepted
      });
      try {
        const rs = e?.streams?.[0] ?? e?.stream;
        console.log('[handleRemote] Extracted stream:', rs?.id, 'isValid:', isValidStream(rs));
        if (!rs) {
          console.log('[handleRemote] No stream found in event');
          return;
        }
        
        // Проверяем, что объект не уничтожен
        if (!isValidStream(rs)) {
          console.log('[handleRemote] Stream is not valid, skipping');
          return;
        }

        if (Platform.OS !== 'android') {
          try { if (localStreamRef.current && (rs as any)?.id === (localStreamRef.current as any)?.id) return; } catch {}
        }

        // УПРОЩЕНО: только один remoteStream для 1-на-1
        if (isValidStream(rs)) {
            console.log('[handleRemote] Setting remote stream immediately', { 
              streamId: rs.id,
              isDirectCall,
              videoTracks: rs.getVideoTracks?.()?.length || 0,
              audioTracks: rs.getAudioTracks?.()?.length || 0,
              hasExistingRemoteStream: !!remoteStream,
              existingRemoteStreamId: remoteStream?.id
            });
            
            // КРИТИЧНО: Для второго и последующих вызовов - очищаем старый remote stream перед установкой нового
            // Это гарантирует что новый stream установится правильно
            // КРИТИЧНО: Проверяем и state и ref, так как они могут быть рассинхронизированы при повторных вызовах
            const existingRemoteStream = remoteStreamRef.current || remoteStream;
            if (existingRemoteStream && existingRemoteStream.id !== rs.id) {
              console.log('[handleRemote] Clearing old remote stream before setting new one', {
                oldStreamId: existingRemoteStream.id,
                newStreamId: rs.id,
                fromRef: !!remoteStreamRef.current,
                fromState: !!remoteStream
              });
              try {
                const oldTracks = existingRemoteStream.getTracks?.() || [];
                oldTracks.forEach((t: any) => {
                  try {
                    t.enabled = false;
                    t.stop();
                    console.log('[handleRemote] Stopped old remote track:', t.kind, t.id);
                  } catch (e) {
                    console.warn('[handleRemote] Error stopping old remote track:', e);
                  }
                });
              } catch (e) {
                console.warn('[handleRemote] Error cleaning up old remote stream tracks:', e);
              }
              setRemoteStream(null);
              remoteStreamRef.current = null;
              
              // КРИТИЧНО: Небольшая задержка перед установкой нового stream для гарантированной очистки
              // Используем setTimeout так как handleRemote не async
              setTimeout(() => {
                try { 
                  setRemoteStream(rs); 
                  remoteStreamRef.current = rs;
                  console.log('[handleRemote] Remote stream set in state and ref after cleanup delay', {
                    streamId: rs.id,
              videoTracks: rs.getVideoTracks?.()?.length || 0,
              audioTracks: rs.getAudioTracks?.()?.length || 0
            });
                } catch (e) {
                  console.error('[handleRemote] Error setting remote stream after delay:', e);
                }
              }, 50);
              return; // Выходим, установка произойдет в setTimeout
            }
            
            // КРИТИЧНО: Проверяем, это ли тот же stream (когда приходит новый track к существующему stream)
            const currentRemoteStream = remoteStreamRef.current || remoteStream;
            const isSameStream = currentRemoteStream && currentRemoteStream.id === rs.id;
            
            // КРИТИЧНО: Устанавливаем новый remote stream (для первого вызова или когда stream ID совпадает)
            // Если это тот же stream, но с новым track, просто обновляем ref для гарантии актуальности
            try { 
              if (!isSameStream) {
                setRemoteStream(rs); 
                remoteStreamRef.current = rs;
                // КРИТИЧНО: Принудительно обновляем remoteViewKey при установке нового stream
                // Это критично для повторных звонков, чтобы гарантировать отображение видеопотока
                setRemoteViewKey(Date.now());
                console.log('[handleRemote] Remote stream set in state and ref, remoteViewKey updated', {
                  streamId: rs.id,
                  videoTracks: rs.getVideoTracks?.()?.length || 0,
                  audioTracks: rs.getAudioTracks?.()?.length || 0
                });
              } else {
                // Это тот же stream, но возможно с новым track - обновляем ref для гарантии
                remoteStreamRef.current = rs;
                console.log('[handleRemote] Updated existing remote stream ref (new track added)', {
                  streamId: rs.id,
                  videoTracks: rs.getVideoTracks?.()?.length || 0,
                  audioTracks: rs.getAudioTracks?.()?.length || 0,
                  hasVideoTrack: !!rs.getVideoTracks?.()?.[0],
                  hasAudioTrack: !!rs.getAudioTracks?.()?.[0]
                });
                // КРИТИЧНО: Принудительно обновляем state для ререндера когда появляется video track
                if (rs.getVideoTracks?.()?.length > 0 && (!remoteStream || !remoteStream.getVideoTracks?.()?.length)) {
                  setRemoteStream(rs);
                  // КРИТИЧНО: Обновляем remoteViewKey при появлении video track
                  setRemoteViewKey(Date.now());
                  // КРИТИЧНО: Устанавливаем remoteCamOn в true когда появляется video track
                  setRemoteCamOn(true);
                  console.log('[handleRemote] Video track appeared, updated state, remoteViewKey and remoteCamOn for re-render');
                } else if (rs.getVideoTracks?.()?.length > 0) {
                  // КРИТИЧНО: Даже если stream тот же, но video track есть, убеждаемся что remoteCamOn=true
                  const vt = rs.getVideoTracks?.()?.[0];
                  if (vt && vt.readyState === 'live') {
                    setRemoteCamOn(true);
                    setRemoteViewKey(Date.now());
                    console.log('[handleRemote] Video track is live in same stream, ensuring remoteCamOn=true');
                  }
                }
              }
            } catch (e) {
              console.error('[handleRemote] Error setting remote stream:', e);
            }
            // DEPRECATED: remoteRenderKey больше не используется
            // КРИТИЧНО: Для дружеских звонков ВСЕГДА сбрасываем partnerInPiP при получении нового потока
            // Это гарантирует, что useEffect для partnerInPiP не перезапишет remoteCamOn в false
            // КРИТИЧНО: Проверяем не только friendCallAccepted, но и partnerUserId - если он установлен, это дружеский звонок
            const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!partnerUserId;
            if (isFriendCall) {
              try {
                setPartnerInPiP(false);
                console.log('[handleRemote] Reset partnerInPiP=false for friend call', { isDirectCall, inDirectCall, friendCallAccepted, partnerUserId });
              } catch {}
            }
            
            // КРИТИЧНО: Проверяем наличие video track перед установкой remoteCamOn
            // КРИТИЧНО: Это особенно важно при повторных звонках
            const hasVideoTrack = !!(rs as any)?.getVideoTracks?.()?.[0];
            if (hasVideoTrack) {
              try {
                const vt = (rs as any).getVideoTracks()[0];
                // КРИТИЧНО: Устанавливаем remoteCamOn в true только если video track live или ready
                if (vt.readyState === 'live' || vt.readyState === 'ready') {
                  setRemoteCamOn(true);
                  console.log('[handleRemote] Set remoteCamOn to true (video track present and live/ready)', {
                    readyState: vt.readyState,
                    enabled: vt.enabled
                  });
                } else {
                  console.log('[handleRemote] Video track present but not live yet', { readyState: vt.readyState });
                }
              } catch (e) {
                console.warn('[handleRemote] Error checking video track state:', e);
                // В случае ошибки все равно устанавливаем remoteCamOn в true если track есть
                setRemoteCamOn(true);
              }
            } else {
              // Нет video track пока - это нормально, треки приходят асинхронно
              console.log('[handleRemote] Video track not yet available, waiting for it (audio track received)');
            }
            
            // КРИТИЧНО: Для звонков друзьям запускаем метры при получении remoteStream
            // Это гарантирует что эквалайзер работает даже если bindConnHandlers не сработал
            if (isFriendCall) {
              try {
                // Небольшая задержка чтобы дать время на установку соединения
                setTimeout(() => {
                  if (typeof startMicMeter === 'function') {
                    startMicMeter();
                  }
                }, 500);
              } catch (e) {
                console.warn('[handleRemote] Error starting mic meter:', e);
              }
            }
            
            try {
              setLoading(false); 
            } catch {} // КРИТИЧНО: Сбрасываем loading при получении потока

            // КРИТИЧНО: Явно включаем видео трек если он есть и выключен
            // Это особенно важно при втором вызове, когда remote stream может не отображаться
            try {
              const vt = (rs as any)?.getVideoTracks?.()?.[0];
              if (vt) {
                if (!vt.enabled) {
                  vt.enabled = true;
                }
                // КРИТИЧНО: Убеждаемся что трек действительно active
                if (vt.readyState !== 'live') {
                  console.warn('[handleRemote] Remote video track is not live:', vt.readyState);
                }
              } else {
                // КРИТИЧНО: Не выдаем предупреждение если треки еще приходят асинхронно
                // Video track может прийти позже audio track
                const hasAudioTrack = !!(rs as any)?.getAudioTracks?.()?.[0];
                if (!hasAudioTrack) {
                  console.warn('[handleRemote] No tracks found in remote stream');
                }
              }
            } catch (e) {
              console.warn('[handleRemote] Error enabling remote video track:', e);
            }
            
            // КРИТИЧНО: Принудительно обновляем remoteViewKey для гарантированного ререндера
            // Это особенно важно при втором и последующих вызовах
            try {
              setRemoteViewKey(Date.now());
            } catch {}

            // КРИТИЧНО: Bump ключа для принудительного ререндера при первом приходе видео
            // КРИТИЧНО: Это особенно важно при повторных звонках
            try {
              const vt = (rs as any)?.getVideoTracks?.()?.[0];
              if (vt) {
                const live = vt.readyState === 'live' && vt.enabled !== false;
                if (live) {
                  setRemoteViewKey(Date.now());
                  // КРИТИЧНО: Убеждаемся что remoteCamOn установлен в true когда video track live
                  setRemoteCamOn(true);
                  console.log('[handleRemote] Video track is live, updated remoteViewKey and remoteCamOn');
                } else {
                  // КРИТИЧНО: Даже если track не live, но он есть, устанавливаем remoteCamOn в true
                  // Это важно для повторных звонков, когда track может быть еще не live
                  if (vt.readyState === 'ready' || vt.readyState === 'live') {
                    setRemoteCamOn(true);
                    setRemoteViewKey(Date.now());
                    console.log('[handleRemote] Video track ready/live, updated remoteCamOn and remoteViewKey', {
                      readyState: vt.readyState,
                      enabled: vt.enabled
                    });
                  }
                }
              }
              // partnerInPiP управляется только через pip:state от партнёра
            } catch (e) {
              console.warn('[handleRemote] Error in video track bump logic:', e);
            }
              
              // Уведомляем сервер что WebRTC соединение установлено
              try {
                const roomId = roomIdRef.current;
                if (roomId) {
                  socket.emit('connection:established', { roomId });
                }
              } catch {}
        }
      } catch (err) {
        console.warn('[webrtc] invalid remote stream', err);
      }
    };

    (pc as any).ontrack = handleRemote;
    
    // КРИТИЧНО: Добавляем альтернативный обработчик для совместимости
    (pc as any).onaddstream = (e: any) => {
      console.log('[onaddstream] Received stream via onaddstream:', e?.stream?.id);
      if (e?.stream) {
        handleRemote({ stream: e.stream });
      }
    };

    (pc as any).onicecandidate = (e: any) => {
      if (e.candidate && setToId) socket.emit('ice-candidate', { to: setToId, candidate: e.candidate });
    };
  }, [remoteStream, remoteCamOn, loading, isDirectCall, inDirectCall, friendCallAccepted, partnerUserId, startMicMeter]);

  

  const restartCooldownRef = useRef<number>(0);
  const iceRestartInProgressRef = useRef<boolean>(false);
  const tryIceRestart = useCallback(async (pc: RTCPeerConnection, toId: string) => {
    try {
      if (!pc) return;
      
      // Защита от множественных одновременных попыток
      if (iceRestartInProgressRef.current) {
        console.log('🔴 [tryIceRestart] ICE restart already in progress, skipping');
        return;
      }
      
      // КРИТИЧНО: Не пытаемся перезапустить если приложение в background (заблокирован экран)
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
        console.log('🔴 [tryIceRestart] App in background/inactive - skipping ICE restart (screen locked)', {
          appState: AppState.currentState
        });
        return;
      }
      
      // КРИТИЧНО: Не пытаемся перезапустить если звонок завершен
      // КРИТИЧНО: Проверяем не только isInactiveState, но и наличие partnerId
      const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
      if (isInactiveStateRef.current || !hasActiveCall) {
        console.log('🔴 [tryIceRestart] Call ended - skipping ICE restart (correct behavior)', {
          isInactiveState: isInactiveStateRef.current,
          hasActiveCall,
          partnerId: partnerIdRef.current,
          roomId: roomIdRef.current,
          callId: currentCallIdRef.current
        });
        return;
      }
      
      const now = Date.now();
      if (restartCooldownRef.current > now) {
        console.log('🔴 [tryIceRestart] Cooldown active, skipping', {
          remaining: restartCooldownRef.current - now
        });
        return;
      }
      restartCooldownRef.current = now + 10000; // увеличил до 10 секунд для стабильности
      iceRestartInProgressRef.current = true;
      
      // Дополнительная проверка: убеждаемся что pc все еще валиден
      if (!peerRef.current || peerRef.current !== pc) {
        console.warn('[tryIceRestart] PeerConnection changed during execution, aborting');
        iceRestartInProgressRef.current = false;
        return;
      }
      
      const offer = await pc.createOffer({ iceRestart: true } as any);
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: toId, offer });
      console.log('⚫ [tryIceRestart] Created and sent offer for ICE restart', {
        toId,
        isInactiveState: isInactiveStateRef.current,
        partnerId: partnerIdRef.current
      });
      
      // Сбрасываем флаг через 5 секунд (достаточно для обработки ответа)
      setTimeout(() => {
        iceRestartInProgressRef.current = false;
      }, 5000);
    } catch (err) {
      console.error('[tryIceRestart] Error:', err);
      iceRestartInProgressRef.current = false;
    }
  }, []);

  const bindConnHandlers = (pc: RTCPeerConnection, expectedPartnerId?: string) => {
    const bump = () => {
      // КРИТИЧНО: СНАЧАЛА проверяем что PC все еще валиден (не закрыт и не null)
      if (!pc || pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        return;
      }
      
      // КРИТИЧНО: СНАЧАЛА проверяем что звонок не завершен - это самая важная проверка
      // Делаем это ДО проверки peerRef, чтобы не обрабатывать события от завершенного звонка
      if (isInactiveStateRef.current) {
        return; // НЕ обрабатываем никакие изменения состояния если звонок завершен
      }
      
      // КРИТИЧНО: Проверяем что это все еще тот же PC, на который ссылается peerRef
      // Если PC был заменен или удален, игнорируем изменения старого PC
      if (!peerRef.current || peerRef.current !== pc) {
        return;
      }
      
      // КРИТИЧНО: Дополнительная проверка - если refs очищены, не обрабатываем события
      const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
      if (!hasActiveCall) {
        return;
      }
      
      // КРИТИЧНО: Дополнительная проверка - если звонок завершен, не обрабатываем соединение
      if (isInactiveStateRef.current || !hasActiveCall) {
        return; // Уже проверили выше, но проверяем еще раз перед обработкой соединения
      }
      
      const st = (pc as any).connectionState || pc.iceConnectionState;
      const ok = st === 'connected' || st === 'completed';
      pcConnectedRef.current = ok;
      setPcConnected(ok);
      if (ok) {
        // КРИТИЧНО: Проверяем что это соединение с текущим партнером, а не со старым
        const currentPartnerId = partnerIdRef.current;
        if (expectedPartnerId && expectedPartnerId !== currentPartnerId) {
          return; // Игнорируем соединение со старым партнером
        }
        
        // КРИТИЧНО: Проверяем что звонок все еще активен перед запуском метра
        // Это критично, потому что обработчик может сработать после завершения звонка
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        if (isInactiveStateRef.current || !hasActiveCall) {
          return; // НЕ запускаем метры если звонок завершен
        }
        
        startMicMeter();
        // КРИТИЧНО: Сбрасываем loading при успешном соединении с ТЕКУЩИМ партнером
        setLoading(false);
        setIsNexting(false); // Сбрасываем блокировку кнопки при успешном соединении
      } else {
        stopMicMeter();
      }

      // УПРОЩЕНО: Авто-ICE рестарт при сбоях (только один PC)
      if (st === 'failed' || st === 'disconnected') {
        // КРИТИЧНО: Не пытаемся перезапустить если звонок завершен
        // КРИТИЧНО: Проверяем СНАЧАЛА isInactiveState - это самая важная проверка
        // КРИТИЧНО: Проверяем ДО всех остальных проверок, чтобы избежать race condition
        if (isInactiveStateRef.current) {
          return;
        }
        
        // КРИТИЧНО: Проверяем что peerRef.current все еще указывает на этот PC
        // Это должно быть проверено ДО проверки hasActiveCall
        if (!peerRef.current || peerRef.current !== pc) {
          return;
        }
        
        // КРИТИЧНО: Проверяем наличие активного звонка
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        if (!hasActiveCall) {
          return;
        }
        
        // КРИТИЧНО: Проверяем еще раз isInactiveState после всех проверок (на случай если изменился)
        // Это критично, потому что обработчик может сработать асинхронно после завершения звонка
        if (isInactiveStateRef.current) {
          return;
        }
        
        // КРИТИЧНО: Не пытаемся перезапустить если приложение в background (заблокирован экран)
        // При блокировке экрана вызов должен завершаться, а не пытаться перезапускать соединение
        if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
          return;
        }
        
        const toId = partnerIdRef.current;
        if (toId) {
          tryIceRestart(pc, String(toId));
        }
      }
    };
    // Используем только onconnectionstatechange для избежания двойных вызовов
    // oniceconnectionstatechange может срабатывать раньше и вызывать конфликты
    (pc as any).onconnectionstatechange = bump;
    // Отключаем oniceconnectionstatechange чтобы избежать двойных вызовов ICE restart
    try { (pc as any).oniceconnectionstatechange = null; } catch {}
    try { (pc as any).onicegatheringstatechange = null; } catch {}
  };
  
  const ensurePcWithLocal = useCallback((stream: MediaStream): RTCPeerConnection | null => {
    // КРИТИЧНО: При возврате из PiP проверяем существующий PC
    // Если PC существует и валиден - возвращаем его, иначе создаем новый
    if (resume && fromPiP) {
      const existingPc = peerRef.current;
      if (existingPc) {
        try {
          // Проверяем что PC еще валиден
          const state = existingPc.signalingState;
          if (state !== 'closed') {
            console.log('[ensurePcWithLocal] Returning existing PC from PiP resume', {
              signalingState: state,
              connectionState: existingPc.connectionState
            });
            return existingPc;
          }
        } catch (e) {
          console.warn('[ensurePcWithLocal] Existing PC is invalid after PiP resume, will create new one:', e);
        }
      }
      // КРИТИЧНО: Если PC не существует или невалиден при возврате из PiP - создаем новый
      console.log('[ensurePcWithLocal] No valid PC found after PiP resume, will create new one');
    }
    
    let pc = peerRef.current;
    
     // КРИТИЧНО: Проверяем состояние существующего PC
     // Если PC существует, проверяем что он в правильном состоянии для переиспользования
     if (pc) {
       try {
         // Пытаемся получить состояние PC
         const state = pc.signalingState;
         const hasLocalDesc = !!(pc as any)?.currentLocalDescription || !!(pc as any)?.localDescription;
         const hasRemoteDesc = !!(pc as any)?.currentRemoteDescription || !!(pc as any)?.remoteDescription;
         
         // PC можно переиспользовать только если он в состоянии 'stable' БЕЗ описаний
         const isValidState = state === 'stable';
    const hasNoDescriptions = !hasLocalDesc && !hasRemoteDesc;
    
         if (!isValidState || !hasNoDescriptions) {
           console.log('[ensurePcWithLocal] PC not in initial state, creating new one. State:', state, 'hasLocal:', hasLocalDesc, 'hasRemote:', hasRemoteDesc, 'connectionState:', pc.connectionState);
      try { 
        cleanupPeer(pc);
      } catch (e) {
        console.warn('[ensurePcWithLocal] Error cleaning up PC:', e);
      }
      pc = null;
      peerRef.current = null;
         }
       } catch (e) {
         // Если не можем получить состояние - PC скорее всего закрыт или недоступен
         console.warn('[ensurePcWithLocal] Cannot access PC state, creating new one:', e);
         try { 
           cleanupPeer(pc);
         } catch {}
         pc = null;
         peerRef.current = null;
       }
     }
     
     // КРИТИЧНО: Также очищаем preCreatedPcRef перед созданием нового PC
     // чтобы избежать конфликтов
     if (preCreatedPcRef.current) {
       try {
         cleanupPeer(preCreatedPcRef.current);
         preCreatedPcRef.current = null;
       } catch (e) {
         console.warn('[ensurePcWithLocal] Error cleaning up preCreatedPcRef:', e);
       }
    }
    
    if (!pc) { 
      try {
        // КРИТИЧНО: Убеждаемся что stream существует и валиден перед созданием PC
        if (!stream || !isValidStream(stream)) {
          console.error('[ensurePcWithLocal] Cannot create PC - stream is invalid or null', {
            streamExists: !!stream,
            streamValid: stream ? isValidStream(stream) : false,
            streamId: stream?.id
          });
          return null;
        }
        
        // КРИТИЧНО: Дополнительная проверка валидности стрима перед созданием PC
        // Проверяем что треки действительно доступны и не были остановлены
        const videoTrack = stream.getVideoTracks()?.[0];
        const audioTrack = stream.getAudioTracks()?.[0];
        
        if (!videoTrack && !audioTrack) {
          console.error('[ensurePcWithLocal] Stream has no tracks, cannot create PC', {
            streamId: stream.id,
            tracksLength: (stream as any).getTracks?.()?.length
          });
          return null;
        }
        
        // Проверяем что треки не остановлены
        if (videoTrack && videoTrack.readyState === 'ended') {
          console.error('[ensurePcWithLocal] Video track is ended, cannot create PC', {
            streamId: stream.id,
            videoTrackId: videoTrack.id,
            readyState: videoTrack.readyState
          });
          return null;
        }
        
        console.log('[ensurePcWithLocal] Creating new PeerConnection', {
          partnerId: partnerIdRef.current,
          streamId: stream.id,
          hasVideoTrack: !!videoTrack,
          hasAudioTrack: !!audioTrack,
          videoTrackId: videoTrack?.id,
          audioTrackId: audioTrack?.id,
          videoTrackReadyState: videoTrack?.readyState,
          audioTrackReadyState: audioTrack?.readyState,
          videoTrackEnabled: videoTrack?.enabled,
          audioTrackEnabled: audioTrack?.enabled
        });
        
      try {
        pc = new RTCPeerConnection(ICE_SERVERS); 
        peerRef.current = pc; 
          // Передаем текущий partnerId для проверки в bindConnHandlers
          bindConnHandlers(pc, partnerIdRef.current || undefined);
          console.log('[ensurePcWithLocal] Created new PeerConnection successfully', { 
            partnerId: partnerIdRef.current,
            pcSignalingState: pc.signalingState
          });
        } catch (createError: any) {
          console.error('[ensurePcWithLocal] RTCPeerConnection constructor failed:', createError, {
            errorMessage: createError?.message,
            errorStack: createError?.stack,
            streamId: stream.id,
            ICE_SERVERS: JSON.stringify(ICE_SERVERS)
          });
          throw createError; // Пробрасываем ошибку в catch блок выше
        }
      } catch (e) {
        console.error('[ensurePcWithLocal] Failed to create PeerConnection:', e, {
          streamExists: !!stream,
          streamValid: stream ? isValidStream(stream) : false,
          streamId: stream?.id
        });
        return null;
      }
    }

    const senders: RTCRtpSender[] = (pc.getSenders?.() || []) as any;
    const audioTracks = stream?.getAudioTracks?.() || [];
    const videoTracks = stream?.getVideoTracks?.() || [];

    

    const replaceOrAdd = (track: any) => {
      const sameKind = senders.find((s: any) => s?.track?.kind === track.kind);
      if (sameKind) {
        try { sameKind.replaceTrack(track); } catch (e) {}
      } else {
        try { (pc as any).addTrack?.(track, stream as any); } catch (e) {}
      }
    };

    (audioTracks as any[]).forEach((t) => replaceOrAdd(t as any));
    (videoTracks as any[]).forEach((t) => replaceOrAdd(t as any));

    // Для совместимости со старыми реализациями
    try { (pc as any).addStream?.(stream as any); } catch {}

    return pc;
  }, [bindConnHandlers, resume, fromPiP]); 
  
  // Функция для предварительного создания PeerConnection
  const preCreatePeerConnection = useCallback(() => {
    // КРИТИЧНО: Не создаем PC вне активного звонка
    const hasActiveCall = !!roomIdRef.current || !!currentCallIdRef.current || !!partnerIdRef.current;
    if (!hasActiveCall) {
      console.log('[preCreatePeerConnection] Skip precreate - no active call');
      return null;
    }
    
    if (preCreatedPcRef.current) {
      console.log('[preCreatePeerConnection] PC already exists, reusing');
      return preCreatedPcRef.current;
    }
    
    console.log('[preCreatePeerConnection] Creating new PC in background');
    const pc = new RTCPeerConnection(ICE_SERVERS);
    
    // КРИТИЧНО: Добавляем только LIVE треки - не используем старые остановленные треки
    if (localStreamRef.current) {
      const liveTracks = localStreamRef.current.getTracks()
        .filter((t: any) => t.readyState === 'live');
      
      if (liveTracks.length) {
        liveTracks.forEach(track => {
        try { pc.addTrack(track, localStreamRef.current!); } catch {}
      });
      } else {
        console.log('[preCreatePeerConnection] Skip adding tracks - all ended, no live tracks');
      }
    }
    
    // Привязываем обработчики с текущим partnerId
    bindConnHandlers(pc, partnerIdRef.current || undefined);
    
    preCreatedPcRef.current = pc;
    return pc;
  }, [bindConnHandlers]);

  const handleMatchFound = useCallback(async ({ id, userId, roomId }: { id: string; userId?: string | null; roomId?: string }) => {
    // Защита от множественных вызовов для одного и того же партнера
    const matchKey = `match_${id}`;
    if (processingOffersRef.current.has(matchKey)) {
      console.log('[handleMatchFound] Already processing match for:', id);
      return;
    }
    
    // Дополнительная защита - если у нас уже есть партнер с этим ID, игнорируем
    if (partnerIdRef.current === id) {
      console.log('[handleMatchFound] Already matched with this partner:', id);
      return;
    }
    
    // ЗАЩИТА: Если мы уже обрабатываем матч с тем же партнером
    const currentPartnerId = partnerIdRef.current;
    if (currentPartnerId === id) {
      console.warn('[handleMatchFound] Already matched with same partner, skip');
      return;
    }

    // КРИТИЧНО: Для прямых звонков друзей НЕ игнорируем match_found даже если PC существует
    // Это нужно чтобы receiver мог обработать match_found после принятия звонка
    const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;

    // Дополнительная защита - если PC уже в стабильном состоянии, игнорируем новый матч
    // ИСКЛЮЧЕНИЕ: для прямых звонков друзей пропускаем эту проверку
    if (!isDirectFriendCall && peerRef.current && peerRef.current.signalingState === 'stable') {
      console.log('[handleMatchFound] PC already in stable state, ignoring new match from:', id);
      return;
    }

    // Дополнительная защита - если PC уже имеет локальное описание (offer в процессе), игнорируем
    // ИСКЛЮЧЕНИЕ: для прямых звонков друзей пропускаем эту проверку (receiver может иметь answer)
    if (!isDirectFriendCall && peerRef.current && (peerRef.current as any).localDescription) {
      console.log('[handleMatchFound] PC already has local description, ignoring new match from:', id);
      return;
    }
    
    // КРИТИЧНО: Принудительная очистка всех существующих PC перед новым match
    console.log('[handleMatchFound] Force cleaning ALL existing connections');
    if (peerRef.current) {
      try {
        cleanupPeer(peerRef.current);
      } catch (e) {
        console.warn('[handleMatchFound] Error in force cleanup:', e);
      }
      peerRef.current = null;
    }
    
    // УСКОРЕНИЕ: Используем предварительно созданный PC если есть
    if (preCreatedPcRef.current) {
      console.log('[handleMatchFound] Using pre-created PC for faster connection');
      peerRef.current = preCreatedPcRef.current;
      preCreatedPcRef.current = null; // Очищаем ссылку
    }
    
    // КРИТИЧНО: Принудительно очищаем remoteStream и все связанные состояния перед новым звонком
    // Это критично для повторных звонков, чтобы гарантировать правильное отображение видеопотока
    try {
      const oldRemoteStream = remoteStreamRef.current;
      if (oldRemoteStream) {
        const tracks = (oldRemoteStream as any).getTracks?.() || [];
        tracks.forEach((t: any) => {
          try {
            t.enabled = false;
            t.stop();
            try { (t as any).release?.(); } catch {}
          } catch {}
        });
      }
    } catch (e) {
      console.warn('[handleMatchFound] Error cleaning up old remote stream:', e);
    }
    setRemoteStream(null);
    remoteStreamRef.current = null;
    // КРИТИЧНО: Принудительно сбрасываем remoteViewKey для гарантированного ререндера при новом звонке
    setRemoteViewKey(0);
    
    // Очищаем все устаревшие состояния чтобы предотвратить обработку старых событий
    // КРИТИЧНО: Устанавливаем remoteCamOn в false при очистке, чтобы не показывать заглушку до получения video track
    setRemoteCamOn(false);
    setRemoteMutedMain(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при новом соединении
    // НЕ очищаем partnerId здесь - он будет установлен ниже для нового партнера
    
    // Ждем дольше чтобы все PC полностью закрылись
    await new Promise(resolve => setTimeout(resolve, 800));
    
    processingOffersRef.current.add(matchKey);
    
    // КРИТИЧНО: Устанавливаем loading в true при получении match_found
    setLoading(true);
    console.log('[handleMatchFound] Set loading to true, current loading state:', loading);
    setAddBlocked(false);
    setAddPending(false);
    clearDeclinedBlock();
    
    try {
      // Сбрасываем флаг ручного запроса при найденном матче
      manuallyRequestedNextRef.current = false;
      
      // Если недавно отклоняли этого пользователя — игнорируем match
      if (userId && declinedBlockRef.current && declinedBlockRef.current.userId === String(userId) && Date.now() < declinedBlockRef.current.until) {
        return;
      }
      
      // PC уже очищен выше принудительно
      
      let stream = localStream || localStreamRef.current;
      // КРИТИЧНО: Проверяем валидность существующего стрима - если он невалиден или треки остановлены, создаем новый
      if (stream && !isValidStream(stream)) {
        console.log('[handleMatchFound] Existing stream is invalid, clearing and creating new one');
        try {
          const tracks = stream.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try { t.stop(); } catch {}
          });
        } catch {}
        stream = null;
        setLocalStream(null);
        localStreamRef.current = null;
      }
      
      if (!stream) {
        // КРИТИЧНО: Всегда создаем локальный стрим для рандомного чата
        // Это нужно для корректной работы WebRTC
        stream = await startLocalStream('front');
        // КРИТИЧНО: Убеждаемся что камера включена для отображения в блоке "Вы"
        if (stream) {
          const videoTrack = stream.getVideoTracks()?.[0];
          if (videoTrack) {
            videoTrack.enabled = true;
            setCamOn(true);
            console.log('[handleMatchFound] Enabled video track and set camOn=true');
          }
        }
      } else {
        // Если стрим уже существует и валиден, убеждаемся что камера включена
        const videoTrack = stream.getVideoTracks()?.[0];
        if (videoTrack && !videoTrack.enabled) {
          videoTrack.enabled = true;
          setCamOn(true);
          console.log('[handleMatchFound] Enabled existing video track and set camOn=true');
        } else if (videoTrack && videoTrack.enabled) {
          // Камера уже включена, просто обновляем состояние
          setCamOn(true);
        }
      }
      
      setStarted(true);
      if (!socket.connected) await new Promise<void>(res => socket.once('connect', () => res()));
      
      const myId = String(socket.id);
      const partnerIdNow = String(id);
      const iAmCaller = isDirectCall ? isDirectInitiator : (myId < partnerIdNow);

      // УПРОЩЕНО: только один PC для 1-на-1
      setPartnerId(partnerIdNow);
      setPartnerUserId(userId ? String(userId) : null);
      partnerIdRef.current = partnerIdNow;
      console.log('[handleMatchFound] Set partnerUserId:', userId, 'roomId:', roomId, 'partnerIdNow:', partnerIdNow);
      
      // Обновляем информацию о собеседнике в PiP
      if (userId) {
        const partnerProfile = friends.find(f => String(f._id) === String(userId));
        updatePiPState({
          partnerName: partnerProfile?.nick || 'Собеседник',
          // partnerAvatarUrl: partnerProfile?.avatarUrl, // если есть аватар
        });
        console.log('[handleMatchFound] Updated PiP state with partner info:', partnerProfile?.nick);
      }
      
      // Обновим список друзей для бейджа
      try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
      setRemoteMutedMain(false);
      
      // Отправляем текущее состояние камеры новому собеседнику
      setTimeout(() => {
        sendCameraState(partnerIdNow);
      }, 500);

      // Комнаты нужны только для звонков друзей (direct calls)
      if (isDirectCall && roomId && roomIdRef.current !== roomId) {
        roomIdRef.current = roomId;
        socket.emit('room:join:ack', { roomId });
        console.log('[handleMatchFound] Joined room for direct call:', roomId);
      } else if (isDirectCall && roomId && roomIdRef.current === roomId) {
        console.log('[handleMatchFound] Already in room for direct call:', roomId, 'skipping room:join:ack');
      } else if (!isDirectCall) {
        console.log('[handleMatchFound] Random chat - using direct WebRTC connection');
      }
  
        if (iAmCaller) {
          // Caller - создаем PC и отправляем offer
          console.log('[handleMatchFound] Caller - creating PC and sending offer');
          
          // КРИТИЧНО: Проверяем что stream валиден перед созданием PC
          if (!stream || !isValidStream(stream)) {
            console.error('[handleMatchFound] Caller: Cannot create PC - stream is invalid', {
              streamExists: !!stream,
              streamValid: stream ? isValidStream(stream) : false,
              streamId: stream?.id
            });
            return;
          }
          
          // КРИТИЧНО: Устанавливаем partnerIdRef синхронно перед созданием PC
          partnerIdRef.current = partnerIdNow;
          
          console.log('[handleMatchFound] Caller: Creating PC with validated stream', {
            streamId: stream.id,
            hasVideoTrack: !!stream.getVideoTracks()?.[0],
            hasAudioTrack: !!stream.getAudioTracks()?.[0],
            partnerId: partnerIdNow
          });
          
          const pc = ensurePcWithLocal(stream);
          if (!pc) {
            console.error('[handleMatchFound] Failed to create PeerConnection for caller', {
              streamValid: isValidStream(stream),
              streamId: stream?.id,
              hasVideoTrack: !!stream?.getVideoTracks()?.[0],
              hasAudioTrack: !!stream?.getAudioTracks()?.[0],
              peerRefCurrent: !!peerRef.current
            });
            return;
          }
          
          // КРИТИЧНО: Обновляем bindConnHandlers с новым partnerId если PC был переиспользован
          bindConnHandlers(pc, partnerIdNow);
          
          // Проверяем что PC не имеет локального описания ПЕРЕД созданием offer
          if ((pc as any).localDescription) {
            console.log('[handleMatchFound] PC already has local description, skipping offer creation');
            return;
          }
          
          attachRemoteHandlers(pc, partnerIdNow);
          
          setTimeout(async () => {
            try {
              // Проверяем что PC еще валиден
              if (!peerRef.current || peerRef.current !== pc) {
                console.warn('[handleMatchFound] PC changed during offer creation, aborting');
                return;
              }
              
              // Проверяем что partnerId еще актуален
              if (partnerIdRef.current !== partnerIdNow) {
                console.warn('[handleMatchFound] Partner changed during offer creation, aborting');
                return;
              }
              
              // В background не пытаемся перевыстроить PC
              if (false) {
                console.log('[handleMatchFound] Skipping offer creation - in background mode');
                return;
              }
              
              // КРИТИЧНО: Проверяем signalingState - нельзя создавать offer если уже установлен remote description
              const signalingState = pc.signalingState;
              const hasRemoteDesc = !!(pc as any).remoteDescription;
              const hasLocalDesc = !!(pc as any).localDescription;
              
              // Если PC уже в состоянии have-remote-offer или stable с remote description - не создаем offer
              // Это означает что handleOffer уже обработал входящий offer и мы должны создать answer, а не offer
              if (signalingState === 'have-remote-offer' || (signalingState === 'stable' && hasRemoteDesc)) {
                console.log('[handleMatchFound] Skipping offer creation - PC already has remote description, should create answer instead', {
                  signalingState,
                  hasRemoteDesc,
                  hasLocalDesc
                });
                return;
              }
              
              // Дополнительная проверка что PC не имеет локального описания
              if (hasLocalDesc) {
                console.log('[handleMatchFound] Skipping offer creation - PC already has local description');
                return;
              }
              
              // КРИТИЧНО: Проверяем что PC в правильном состоянии для создания offer (stable без описаний)
              if (signalingState !== 'stable') {
                console.warn('[handleMatchFound] PC not in stable state for offer creation:', signalingState);
                return;
              }
              
              console.log('[handleMatchFound] Creating offer with PC', {
                signalingState,
                hasLocalDesc,
                hasRemoteDesc
              });
              
              // Проверка: если звонок завершен, не создаем offer
              if (isInactiveStateRef.current) {
                console.log('🔴 [handleMatchFound] Call ended - skipping offer creation (correct behavior)', {
                  partnerId: partnerIdNow,
                  signalingState
                });
                return;
              }
              
              const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
              await pc.setLocalDescription(offer);
              socket.emit('offer', { to: partnerIdNow, offer, fromUserId: myUserId });
              console.log('⚫ [handleMatchFound] Created and sent offer for match', {
                partnerId: partnerIdNow,
                isInactiveState: isInactiveStateRef.current,
                signalingState
              });
            } catch (e) {
              console.error('[handleMatchFound] Error creating/sending offer:', e);
              // Если ошибка связана с SDP, логируем дополнительную информацию
              if (e instanceof Error && e.message.includes('m-lines')) {
                console.error('[handleMatchFound] SDP m-lines error - PC state:', {
                  signalingState: pc.signalingState,
                  connectionState: pc.connectionState,
                  hasLocalDescription: !!(pc as any).localDescription,
                  hasRemoteDescription: !!(pc as any).remoteDescription
                });
              }
            }
          }, 100); // Небольшая задержка для стабилизации PC
        } else {
          // Receiver - просто ждем offer
          console.log('[handleMatchFound] Receiver - waiting for offer');
          
          // КРИТИЧНО: Проверяем, не существует ли уже PC для этого партнера
          // Это может произойти если handleOffer уже создал PC и обрабатывает offer
          // КРИТИЧНО: Проверяем не только stable, но и другие состояния (have-local-offer, have-remote-offer)
          // потому что handleOffer может создать PC и установить remote description ДО того как мы проверим
          const existingPc = peerRef.current;
          if (existingPc && partnerIdRef.current === partnerIdNow) {
            const state = existingPc.signalingState;
            // Проверяем что PC не закрыт и относится к тому же партнеру
            if (state !== 'closed' && partnerIdRef.current === partnerIdNow) {
              console.log('[handleMatchFound] Receiver: PC already exists for this partner, skipping PC creation', {
                signalingState: state,
                partnerId: partnerIdNow,
                hasLocalDesc: !!(existingPc as any)?.localDescription,
                hasRemoteDesc: !!(existingPc as any)?.remoteDescription
              });
              // Просто обновляем bindConnHandlers с правильным partnerId
              bindConnHandlers(existingPc, partnerIdNow);
              attachRemoteHandlers(existingPc, partnerIdNow);
              return;
            }
          }
          
          // КРИТИЧНО: Устанавливаем partnerIdRef синхронно перед созданием PC
          partnerIdRef.current = partnerIdNow;
          
          // КРИТИЧНО: Убеждаемся что локальный стрим готов перед созданием PC
          // Особенно важно при принятии звонка в неактивном состоянии, когда localStream может быть null
          let finalStream = stream;
          if (!finalStream) {
            console.log('[handleMatchFound] Receiver: No local stream, creating one before PC creation');
            try {
              finalStream = await startLocalStream('front');
              // КРИТИЧНО: Если startLocalStream вернул null (например, из-за проверки PiP),
              // принудительно создаем стрим напрямую через getUserMedia
              if (!finalStream) {
                console.log('[handleMatchFound] Receiver: startLocalStream returned null, creating stream directly');
                try {
                  const audioConstraints: any = {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    googEchoCancellation: true,
                    googNoiseSuppression: true,
                    googAutoGainControl: true,
                  };
                  finalStream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
                  if (finalStream) {
                    setLocalStream(finalStream);
                    const videoTrack = finalStream.getVideoTracks()?.[0];
                    const audioTrack = finalStream.getAudioTracks()?.[0];
                    if (videoTrack) {
                      videoTrack.enabled = true;
                      setCamOn(true);
                    }
                    if (audioTrack) {
                      audioTrack.enabled = true;
                      setMicOn(true);
                    }
                    console.log('[handleMatchFound] Receiver: Created stream directly via getUserMedia');
                  }
                } catch (directError) {
                  console.error('[handleMatchFound] Receiver: Error creating stream directly:', directError);
                  return;
                }
              }
              
              if (finalStream) {
                // КРИТИЧНО: Убеждаемся что стрим действительно валиден
                if (!isValidStream(finalStream)) {
                  console.error('[handleMatchFound] Receiver: Created stream is invalid');
                  try {
                    const tracks = finalStream.getTracks?.() || [];
                    tracks.forEach((t: any) => { try { t.stop(); } catch {} });
                  } catch {}
                  return;
                }
                
                // КРИТИЧНО: Сохраняем стрим в state и ref
                setLocalStream(finalStream);
                localStreamRef.current = finalStream;
                
                const videoTrack = finalStream.getVideoTracks()?.[0];
                if (videoTrack) {
                  if (!videoTrack.enabled) {
                    videoTrack.enabled = true;
                    console.log('[handleMatchFound] Receiver: Enabled video track after creating stream');
                  }
                  setCamOn(true);
                }
                console.log('[handleMatchFound] Receiver: Local stream created and validated', {
                  streamId: finalStream.id,
                  hasVideoTrack: !!videoTrack,
                  videoTrackId: videoTrack?.id
                });
              } else {
                console.error('[handleMatchFound] Receiver: Failed to create local stream after all attempts');
                return;
              }
            } catch (e) {
              console.error('[handleMatchFound] Receiver: Error creating local stream:', e);
              return;
            }
          }
          
          // КРИТИЧНО: Проверяем что finalStream действительно существует и валиден перед созданием PC
          if (!finalStream) {
            console.error('[handleMatchFound] Receiver: No valid stream available for PC creation');
            return;
          }
          
          // КРИТИЧНО: Проверяем валидность стрима перед использованием
          if (!isValidStream(finalStream)) {
            console.error('[handleMatchFound] Receiver: Stream is invalid, cannot create PC', {
              finalStreamExists: !!finalStream,
              finalStreamId: finalStream?.id,
              hasToURL: finalStream ? typeof (finalStream as any).toURL === 'function' : false,
              tracksLength: finalStream ? (finalStream as any).getTracks?.()?.length : 0
            });
            return;
          }
          
          // КРИТИЧНО: Проверяем что треки не остановлены перед созданием PC
          const videoTrack = finalStream.getVideoTracks()?.[0];
          const audioTrack = finalStream.getAudioTracks()?.[0];
          if (videoTrack && videoTrack.readyState === 'ended') {
            console.error('[handleMatchFound] Receiver: Video track is ended, cannot create PC', {
              streamId: finalStream.id,
              videoTrackId: videoTrack.id,
              readyState: videoTrack.readyState
            });
            return;
          }
          
          // КРИТИЧНО: Добавляем детальную диагностику перед созданием PC
          console.log('[handleMatchFound] Receiver: Preparing to create PC', {
            finalStreamExists: !!finalStream,
            finalStreamId: finalStream?.id,
            isValidStreamResult: finalStream ? isValidStream(finalStream) : false,
            hasVideoTrack: !!videoTrack,
            hasAudioTrack: !!audioTrack,
            videoTrackId: videoTrack?.id,
            audioTrackId: audioTrack?.id,
            videoTrackEnabled: videoTrack?.enabled,
            audioTrackEnabled: audioTrack?.enabled,
            videoTrackReadyState: videoTrack?.readyState,
            audioTrackReadyState: audioTrack?.readyState,
            hasToURL: finalStream ? typeof (finalStream as any).toURL === 'function' : false,
            tracksLength: finalStream ? (finalStream as any).getTracks?.()?.length : 0,
            peerRefCurrent: !!peerRef.current,
            preCreatedPcRefCurrent: !!preCreatedPcRef.current
          });
          
          // КРИТИЧНО: Очищаем старый PC если он существует и не в правильном состоянии
          // Это особенно важно при принятии звонка в неактивном состоянии
          const existingPcForReceiver = peerRef.current;
          if (existingPcForReceiver) {
            try {
              const state = existingPcForReceiver.signalingState;
              const hasLocalDesc = !!(existingPcForReceiver as any)?.localDescription;
              const hasRemoteDesc = !!(existingPcForReceiver as any)?.remoteDescription;
              
              // Очищаем если PC не в stable или имеет описания
              if (state !== 'stable' || hasLocalDesc || hasRemoteDesc) {
                console.log('[handleMatchFound] Receiver: Cleaning up old PC before creating new one', {
                  state,
                  hasLocalDesc,
                  hasRemoteDesc
                });
                cleanupPeer(existingPcForReceiver);
                peerRef.current = null;
              }
            } catch (e) {
              // Если не можем получить состояние - закрываем
              console.warn('[handleMatchFound] Receiver: Cannot access PC state, cleaning up:', e);
              try {
                cleanupPeer(existingPcForReceiver);
              } catch {}
              peerRef.current = null;
            }
          }
          
          // КРИТИЧНО: Также очищаем preCreatedPcRef
          if (preCreatedPcRef.current) {
            try {
              cleanupPeer(preCreatedPcRef.current);
              preCreatedPcRef.current = null;
            } catch (e) {
              console.warn('[handleMatchFound] Receiver: Error cleaning up preCreatedPcRef:', e);
            }
          }
          
          // Убедимся, что PC создан и готов к приему offer
          const pc = ensurePcWithLocal(finalStream);
          if (!pc) {
            console.error('[handleMatchFound] Failed to create PeerConnection for receiver', {
              streamValid: isValidStream(finalStream),
              streamId: finalStream?.id,
              hasVideoTrack: !!finalStream?.getVideoTracks()?.[0],
              hasAudioTrack: !!finalStream?.getAudioTracks()?.[0]
            });
            return;
          }
          // КРИТИЧНО: Обновляем bindConnHandlers с новым partnerId если PC был переиспользован
          bindConnHandlers(pc, partnerIdNow);
          attachRemoteHandlers(pc, partnerIdNow);
        }
    } catch (e) {
      // Match found error - не критично
      console.error('[handleMatchFound] Error:', e);
    } finally {
      processingOffersRef.current.delete(matchKey);
    }
  }, [attachRemoteHandlers, ensurePcWithLocal, localStream, startLocalStream, isDirectCall, inDirectCall, friendCallAccepted, clearDeclinedBlock, fetchFriends, setFriends, sendCameraState]);
  
  const handleOffer = useCallback(async ({ from, offer, fromUserId }: { from: string; offer: any; fromUserId?: string }) => {
    console.log('[handleOffer] Received offer', { from, fromUserId, isDirectCall, hasOffer: !!offer, pcExists: !!peerRef.current });
    
    if (!from || !offer) {
      console.warn('[handleOffer] Invalid offer data');
      return;
    }

    // КРИТИЧНО: Принудительно очищаем remoteStream перед обработкой нового offer
    // Это критично для повторных звонков, чтобы гарантировать правильное отображение видеопотока
    // Очищаем только если это новый партнер или если remoteStream существует
    const isNewPartner = !partnerIdRef.current || partnerIdRef.current !== from;
    if (isNewPartner || remoteStreamRef.current) {
      try {
        const oldRemoteStream = remoteStreamRef.current;
        if (oldRemoteStream) {
          const tracks = (oldRemoteStream as any).getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
              try { (t as any).release?.(); } catch {}
            } catch {}
          });
        }
        setRemoteStream(null);
        remoteStreamRef.current = null;
        // КРИТИЧНО: Принудительно сбрасываем remoteViewKey для гарантированного ререндера при новом звонке
        setRemoteViewKey(0);
        // КРИТИЧНО: Устанавливаем remoteCamOn в false при очистке, чтобы не показывать заглушку до получения video track
        setRemoteCamOn(false);
        console.log('[handleOffer] Cleared old remote stream before processing new offer');
      } catch (e) {
        console.warn('[handleOffer] Error cleaning up old remote stream:', e);
      }
    }

    // Дополнительная проверка - если у нас уже есть партнер с другим ID, игнорируем
    if (partnerIdRef.current && partnerIdRef.current !== from) {
      console.log('[handleOffer] Already matched with different partner:', partnerIdRef.current, 'ignoring offer from:', from);
      return;
    }

    // КРИТИЧНО: Определяем тип звонка
    // Входящий прямой звонок от друга: isDirectCall || inDirectCall || есть активный incomingFriendCall
    // Рандомный чат между друзьями: нет isDirectCall/inDirectCall, но fromUserId в списке друзей
    const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
    const isRandomChatWithFriend = !isDirectFriendCall && fromUserId && friends.some(f => String(f._id) === String(fromUserId));
    const isIncomingFriendCall = isDirectFriendCall || isRandomChatWithFriend;
    
    // КРИТИЧНО: НЕ обрабатываем offer если:
    // 1. Мы в неактивном состоянии после завершения звонка друга
    // 2. Это рандомный чат, но мы не в поиске (started=false) - это остаточный offer после завершения звонка
    // 3. Это рандомный чат с другом, но нет активного входящего звонка - остаточный offer
    if (isIncomingFriendCall) {
      // Для прямых звонков от друзей проверяем неактивное состояние
      if (isDirectFriendCall && isInactiveStateRef.current && wasFriendCallEnded) {
        console.log('[handleOffer] Ignoring offer - direct friend call ended, in inactive state', {
          from,
          fromUserId,
          wasFriendCallEnded,
          isInactiveState: isInactiveStateRef.current
        });
      return;
      }
      
      // Для рандомного чата с другом: если не в поиске (started=false) и нет активного входящего звонка,
      // это остаточный offer после завершения звонка - игнорируем
      if (isRandomChatWithFriend && !startedRef.current && !incomingFriendCall) {
        console.log('[handleOffer] Ignoring offer - random chat with friend ended, not in search, no active incoming call', {
          from,
          fromUserId,
          started: startedRef.current,
          hasIncomingFriendCall: !!incomingFriendCall
        });
        return;
      }
    }
    
    // КРИТИЧНО: Для обычного рандомного чата (не с другом) требуем активный поиск
    if (!startedRef.current && !isIncomingFriendCall) {
      console.log('[handleOffer] Not in search mode and not an incoming friend call, ignoring offer from:', from);
      return;
    }
    
    // КРИТИЧНО: Для входящих прямых звонков от друзей устанавливаем started
    // НО НЕ для рандомного чата с другом после завершения звонка
    if (isDirectFriendCall && !startedRef.current) {
      console.log('[handleOffer] Direct friend call, setting started=true');
      setStarted(true);
    }

    // Проверяем что мы не в процессе обработки других матчей
    const anyMatchProcessing = Array.from(processingOffersRef.current.keys()).some(key => key.startsWith('match_'));
    if (anyMatchProcessing) {
      // НЕ игнорируем offer, если он от текущего/ожидаемого партнёра
      const samePartner = !partnerIdRef.current || partnerIdRef.current === from; // тот же собеседник
      
      if (!samePartner) {
        console.log('[handleOffer] Another match is being processed (different partner), ignoring offer from:', from);
        return;
      }
      console.log('[handleOffer] match processing, but same partner — accepting offer');
    }

    // Защита от повторных вызовов для одного и того же пользователя
    const offerKey = `offer_${from}`;
    if (processingOffersRef.current.has(offerKey)) {
      console.log('[handleOffer] Already processing offer from:', from);
      return;
    }
    
    processingOffersRef.current.add(offerKey);

    try {
      setAddBlocked(false);
      setAddPending(false);
      clearDeclinedBlock();
      
      // Если недавно отклоняли этого пользователя — игнорируем
      const declinedUid = declinedBlockRef.current?.userId ? String(declinedBlockRef.current.userId) : null;
      if (fromUserId && declinedUid && declinedUid === String(fromUserId) && Date.now() < (declinedBlockRef.current?.until || 0)) {
        console.log('[handleOffer] User recently declined, ignoring offer');
        return;
      }
      
      let stream = localStream;
      if (!stream) {
        // КРИТИЧНО: Всегда создаем локальный стрим для рандомного чата
        // Это нужно для корректной работы WebRTC
        // Особенно важно при принятии звонка в неактивном состоянии
        console.log('[handleOffer] No local stream, creating one before PC creation');
        
        // КРИТИЧНО: Для входящих дружеских звонков гарантируем выход из неактивного состояния
        // ПЕРЕД созданием стрима, чтобы избежать race condition
        // КРИТИЧНО: НО не выходим если звонок был завершен (wasFriendCallEnded) - это может быть остаточный offer
        // от предыдущего звонка. Выходим только если это действительно новый входящий звонок (есть incomingFriendCall)
        if (isIncomingFriendCall && isInactiveStateRef.current) {
          // КРИТИЧНО: Не обрабатываем offer в неактивном состоянии если звонок был завершен
          // Это может быть остаточный/отложенный offer от завершенного звонка
          if (wasFriendCallEnded) {
            console.log('[handleOffer] Ignoring offer in inactive state after call ended - may be residual offer from previous call', {
              from,
              fromUserId,
              wasFriendCallEnded,
              isIncomingFriendCall,
              hasIncomingFriendCall: !!incomingFriendCall
            });
            return;
          }
          
          // КРИТИЧНО: Проверяем что это действительно новый входящий звонок (есть incomingFriendCall)
          // а не просто остаточный offer от завершенного звонка
          if (!incomingFriendCall) {
            console.log('[handleOffer] Ignoring offer in inactive state - no active incoming call, may be residual offer', {
              from,
              fromUserId,
              wasFriendCallEnded,
              isIncomingFriendCall,
              hasIncomingFriendCall: !!incomingFriendCall
            });
            return;
          }
          
          console.log('[handleOffer] Incoming friend call from inactive state, exiting inactive state first');
          // КРИТИЧНО: Устанавливаем friendCallAccepted ПЕРЕД выходом из неактивного состояния
          // чтобы startLocalStream не блокировал создание стрима
          setFriendCallAccepted(true);
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
          // Даем время state и ref обновиться
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        stream = await startLocalStream('front');
        console.log('[handleOffer] startLocalStream result:', {
          streamExists: !!stream,
          streamId: stream?.id,
          streamValid: stream ? isValidStream(stream) : false,
          hasVideoTrack: !!stream?.getVideoTracks()?.[0],
          hasAudioTrack: !!stream?.getAudioTracks()?.[0]
        });
        
        // КРИТИЧНО: Если startLocalStream вернул null (например, из-за проверки isInactiveState),
        // принудительно создаем стрим напрямую через getUserMedia
        // НО: только если это действительно входящий дружеский звонок (не завершенный)
        if (!stream && (isIncomingFriendCall || friendCallAccepted || isDirectCall || inDirectCall)) {
          console.log('[handleOffer] startLocalStream returned null, creating stream directly for friend call');
          try {
            const audioConstraints: any = {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              googEchoCancellation: true,
              googNoiseSuppression: true,
              googAutoGainControl: true,
            };
            stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
            if (stream) {
              // КРИТИЧНО: Проверяем валидность стрима перед сохранением
              if (!isValidStream(stream)) {
                console.error('[handleOffer] Created stream is invalid, stopping and retrying');
                try {
                  const tracks = stream.getTracks?.() || [];
                  tracks.forEach((t: any) => { try { t.stop(); } catch {} });
                } catch {}
                stream = null;
                // Пытаемся еще раз с небольшой задержкой
                await new Promise(resolve => setTimeout(resolve, 100));
                stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
              }
              
              if (stream && isValidStream(stream)) {
                setLocalStream(stream);
                localStreamRef.current = stream;
                const videoTrack = stream.getVideoTracks()?.[0];
                const audioTrack = stream.getAudioTracks()?.[0];
                if (videoTrack) {
                  videoTrack.enabled = true;
                  setCamOn(true);
                }
                if (audioTrack) {
                  audioTrack.enabled = true;
                  setMicOn(true);
                }
                console.log('[handleOffer] Created stream directly via getUserMedia', {
                  streamId: stream.id,
                  hasVideoTrack: !!videoTrack,
                  hasAudioTrack: !!audioTrack,
                  isValid: isValidStream(stream)
                });
              } else {
                console.error('[handleOffer] Failed to create valid stream after retry');
                stream = null;
              }
            }
          } catch (directError) {
            console.error('[handleOffer] Error creating stream directly:', directError);
            return;
          }
        }
        
        if (!stream) {
          console.error('[handleOffer] Failed to create local stream after all attempts');
          return;
        }
        
        // КРИТИЧНО: Убеждаемся что камера включена
        const videoTrack = stream.getVideoTracks()?.[0];
        if (videoTrack && !videoTrack.enabled) {
          videoTrack.enabled = true;
          setCamOn(true);
          console.log('[handleOffer] Enabled video track after creating stream');
        }
      }
      
      // КРИТИЧНО: Проверяем валидность стрима перед использованием
      if (!stream || !isValidStream(stream)) {
        console.error('[handleOffer] Stream is invalid or null, cannot create PC', {
          streamExists: !!stream,
          streamValid: stream ? isValidStream(stream) : false
        });
        return;
      }
      
      // КРИТИЧНО: Проверяем существующий PC перед созданием нового
      // КРИТИЧНО: Если PC уже существует для этого партнера и он в процессе обработки offer,
      // НЕ создаем новый PC, так как это приведет к потере remote description
      const existingPc = peerRef.current;
      if (existingPc) {
        try {
          const state = existingPc.signalingState;
          const hasLocalDesc = !!(existingPc as any)?.localDescription;
          const hasRemoteDesc = !!(existingPc as any)?.remoteDescription;
          const existingPartnerId = partnerIdRef.current;
          
          // КРИТИЧНО: Если PC уже существует для этого партнера и он не закрыт,
          // НЕ создаем новый PC - используем существующий и продолжаем обработку
          if (existingPartnerId === from && state !== 'closed') {
            console.log('[handleOffer] PC already exists for this partner, reusing existing PC', {
              partnerId: from,
              signalingState: state,
              hasLocalDesc,
              hasRemoteDesc
            });
            // Просто обновляем bindConnHandlers с правильным partnerId
            bindConnHandlers(existingPc, from);
            attachRemoteHandlers(existingPc, from);
            // КРИТИЧНО: Продолжаем обработку offer с существующим PC (не возвращаемся!)
            // Устанавливаем partnerId для продолжения обработки
            partnerIdRef.current = from;
            setPartnerId(from);
            if (fromUserId) {
              setPartnerUserId(String(fromUserId));
              partnerUserIdRef.current = String(fromUserId);
            }
            // Переходим к обработке remote description с существующим PC
            // Пропускаем создание нового PC через ensurePcWithLocal
          } else if (state !== 'stable' || hasLocalDesc || hasRemoteDesc) {
            // Очищаем если PC не в stable или имеет описания И это не тот же партнер
            console.log('[handleOffer] Cleaning up old PC before creating new one', {
              state,
              hasLocalDesc,
              hasRemoteDesc,
              existingPartnerId,
              from,
              samePartner: existingPartnerId === from
            });
            cleanupPeer(existingPc);
            peerRef.current = null;
          }
        } catch (e) {
          // Если не можем получить состояние - закрываем только если это не тот же партнер
          console.warn('[handleOffer] Cannot access PC state, checking partner match:', e);
          const existingPartnerId = partnerIdRef.current;
          if (existingPartnerId !== from) {
            try {
              cleanupPeer(existingPc);
            } catch {}
            peerRef.current = null;
          } else {
            console.log('[handleOffer] PC exists for same partner, reusing despite error accessing state');
          }
        }
      }
      
      // КРИТИЧНО: Также очищаем preCreatedPcRef
      if (preCreatedPcRef.current) {
        try {
          cleanupPeer(preCreatedPcRef.current);
          preCreatedPcRef.current = null;
        } catch (e) {
          console.warn('[handleOffer] Error cleaning up preCreatedPcRef:', e);
        }
      }
      
      setStarted(true);
      
      // КРИТИЧНО: Добавляем детальную диагностику перед созданием PC
      console.log('[handleOffer] Preparing to create PC', {
        streamExists: !!stream,
        streamId: stream?.id,
        isValidStreamResult: stream ? isValidStream(stream) : false,
        hasVideoTrack: !!stream?.getVideoTracks()?.[0],
        hasAudioTrack: !!stream?.getAudioTracks()?.[0],
        videoTrackId: stream?.getVideoTracks()?.[0]?.id,
        audioTrackId: stream?.getAudioTracks()?.[0]?.id,
        videoTrackEnabled: stream?.getVideoTracks()?.[0]?.enabled,
        audioTrackEnabled: stream?.getAudioTracks()?.[0]?.enabled,
        videoTrackReadyState: stream?.getVideoTracks()?.[0]?.readyState,
        audioTrackReadyState: stream?.getAudioTracks()?.[0]?.readyState,
        hasToURL: stream ? typeof (stream as any).toURL === 'function' : false,
        tracksLength: stream ? (stream as any).getTracks?.()?.length : 0,
        peerRefCurrent: !!peerRef.current,
        preCreatedPcRefCurrent: !!preCreatedPcRef.current
      });
      
      // УПРОЩЕНО: только один PC для 1-на-1
      // КРИТИЧНО: Проверяем, был ли PC переиспользован выше
      let pc = peerRef.current;
      if (!pc || partnerIdRef.current !== from) {
        // PC не существует или это другой партнер - создаем новый
        console.log('[handleOffer] Creating new PC with stream', {
          streamExists: !!stream,
          streamValid: stream ? isValidStream(stream) : false,
          streamId: stream?.id,
          hasVideoTrack: !!stream?.getVideoTracks()?.[0],
          hasAudioTrack: !!stream?.getAudioTracks()?.[0]
        });
        pc = ensurePcWithLocal(stream);
        console.log('[handleOffer] ensurePcWithLocal result:', {
          pcCreated: !!pc,
          pcSignalingState: pc?.signalingState,
          pcConnectionState: pc?.connectionState
        });
      if (!pc) {
          console.error('[handleOffer] Failed to create PeerConnection', {
            streamValid: isValidStream(stream),
            streamId: stream?.id,
            hasVideoTrack: !!stream?.getVideoTracks()?.[0],
            hasAudioTrack: !!stream?.getAudioTracks()?.[0],
            videoTrackId: stream?.getVideoTracks()?.[0]?.id,
            audioTrackId: stream?.getAudioTracks()?.[0]?.id,
            peerRefCurrent: !!peerRef.current,
            preCreatedPcRefCurrent: !!preCreatedPcRef.current
          });
        return;
      }
      
      partnerIdRef.current = from;
      setPartnerId(from);
        
        // КРИТИЧНО: Устанавливаем partnerUserId если он передан (для звонков друзей)
        if (fromUserId) {
          setPartnerUserId(String(fromUserId));
          partnerUserIdRef.current = String(fromUserId);
          console.log('[handleOffer] Set partnerUserId:', fromUserId);
        } else {
          setPartnerUserId(null);
          partnerUserIdRef.current = null;
        }
      attachRemoteHandlers(pc, from);
      console.log('[handleOffer] PC created and handlers attached, proceeding to setRemoteDescription');
      } else {
        // PC уже существует для этого партнера - он уже настроен выше
        console.log('[handleOffer] Using existing PC for this partner, skipping setup', {
          pcSignalingState: pc?.signalingState,
          pcConnectionState: pc?.connectionState
        });
      }
      
      // Обновим список друзей
      try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
      setRemoteMutedMain(false);
      
      // Отправляем текущее состояние камеры новому собеседнику
      setTimeout(() => {
        sendCameraState(from);
      }, 500);
      
      // Небольшая задержка для добавления треков
      try { await new Promise(res => setTimeout(res, 150)); } catch {}
      
      // КРИТИЧНО: Используем peerRef.current вместо локальной переменной pc
      // чтобы гарантировать что мы работаем с актуальным PC
      const currentPc = peerRef.current;
      if (!currentPc || currentPc !== pc) {
        console.warn('[handleOffer] PC was changed or removed, aborting setRemoteDescription', {
          pcExists: !!currentPc,
          pcMatches: currentPc === pc
        });
        return;
      }
      
      // Проверяем состояние PC перед установкой remote description
      const hasRemoteDesc = !!(currentPc as any).remoteDescription;
      
      // Дополнительная проверка что PC еще валиден
      // Проверяем что PC все еще в peerRef (не был заменен)
      if (peerRef.current !== currentPc) {
        console.warn('[handleOffer] PC was replaced, aborting setRemoteDescription', {
          signalingState: currentPc.signalingState,
          connectionState: currentPc.connectionState
        });
        return;
      }
      
      if (!hasRemoteDesc) {
        try {
          // КРИТИЧНО: Проверяем еще раз перед вызовом, так как состояние может измениться
          if (peerRef.current !== currentPc) {
            console.warn('[handleOffer] PC was changed right before setRemoteDescription, aborting');
            return;
          }
          console.log('[handleOffer] Setting remote description, current PC state:', {
            signalingState: currentPc.signalingState,
            connectionState: currentPc.connectionState,
            hasOffer: !!offer,
            offerType: offer?.type
          });
          await currentPc.setRemoteDescription(offer);
          console.log('[handleOffer] Successfully set remote description, new PC state:', {
            signalingState: currentPc.signalingState,
            connectionState: currentPc.connectionState
          });
        } catch (error: any) {
          // Если ошибка связана с закрытым PC, просто игнорируем
          if (error?.message?.includes('closed') || error?.message?.includes('null')) {
            console.warn('[handleOffer] PC was closed during setRemoteDescription, ignoring error');
            return;
          }
          console.error('[handleOffer] Error setting remote description:', error, {
            signalingState: currentPc.signalingState,
            connectionState: currentPc.connectionState,
            errorMessage: error?.message
          });
          return;
        }
      } else {
        console.log('[handleOffer] PC already has remote description, state:', currentPc.signalingState);
      }
      
      // Прожигаем отложенные ICE кандидаты
      try { await flushIceFor(from); } catch {}
      
      // КРИТИЧНО: Используем peerRef.current для проверки перед созданием answer
      const currentPcForAnswer = peerRef.current;
      if (!currentPcForAnswer || currentPcForAnswer !== pc) {
        console.warn('[handleOffer] PC was changed before answer creation, aborting');
        return;
      }
      
      // Проверяем состояние PC перед созданием answer
      console.log('[handleOffer] Checking PC state before creating answer', {
        signalingState: currentPcForAnswer.signalingState,
        connectionState: currentPcForAnswer.connectionState,
        hasRemoteDesc: !!(currentPcForAnswer as any).remoteDescription
      });
      
      if (currentPcForAnswer.signalingState === 'have-remote-offer') {
        try {
          // Дополнительная проверка что PC еще валиден перед созданием answer
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleOffer] PC was changed before answer creation, aborting');
            return;
          }
          
          console.log('[handleOffer] Creating answer...');
          // КРИТИЧНО: Проверяем еще раз перед созданием answer
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleOffer] PC was changed during answer creation, aborting');
            return;
          }
          const answer = await currentPcForAnswer.createAnswer();
          console.log('[handleOffer] Answer created:', {
            answerType: answer?.type,
            hasAnswer: !!answer
          });
          
          // КРИТИЧНО: Проверяем перед setLocalDescription
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleOffer] PC was changed during setLocalDescription, aborting');
            return;
          }
          await currentPcForAnswer.setLocalDescription(answer);
          console.log('[handleOffer] Set local description (answer), PC state:', {
            signalingState: currentPcForAnswer.signalingState,
            connectionState: currentPcForAnswer.connectionState
          });
          socket.emit('answer', { to: from, answer });
          console.log('[handleOffer] Created and sent answer to:', from);
        } catch (e) {
          console.error('[handleOffer] Error creating/setting answer:', e, {
            signalingState: currentPcForAnswer.signalingState,
            connectionState: currentPcForAnswer.connectionState,
            errorMessage: (e as any)?.message
          });
        }
      } else if (pc.signalingState === 'stable' && hasRemoteDesc) {
        // PC уже в стабильном состоянии с remote description - это означает что соединение уже установлено
        // Новый offer может прийти при одновременном нажатии "Далее" - игнорируем его
        console.log('[handleOffer] PC already in stable state with remote description, ignoring duplicate offer from:', from);
      } else {
        console.warn('[handleOffer] PC not in have-remote-offer state:', pc.signalingState, 'hasRemote:', hasRemoteDesc);
      }
      setLoading(false);
    } catch (e) {
      console.error('[handleOffer] Error:', e);
    } finally {
      processingOffersRef.current.delete(offerKey);
    }
  }, [attachRemoteHandlers, ensurePcWithLocal, localStream, startLocalStream, isDirectCall, inDirectCall, flushIceFor, clearDeclinedBlock, fetchFriends, sendCameraState, wasFriendCallEnded, incomingFriendCall, friends]);
  
  // Автовыставляем remoteCamOn(true) при живом видеотреке (НЕ трогаем partnerInPiP)
  useEffect(() => {
    if (!remoteStream) return;
    try {
      const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
      if (vt && vt.readyState === 'live') {
        // Всегда устанавливаем remoteCamOn=true если есть живой видеотрек
        setRemoteCamOn(true);
        // Включаем трек если он был отключен
        if (!vt.enabled) {
          vt.enabled = true;
        }
        // partnerInPiP управляется только через pip:state от партнёра
      }
    } catch {}
  }, [remoteStream]);
  
  // Единый источник правды: синхронизируем UI с partnerInPiP
  useEffect(() => {
    if (partnerInPiP) {
      // Друг ушёл в PiP → считаем, что удалённая камера «временно выкл»
      setRemoteCamOn(false);
    } else {
      // Друг вернулся из PiP → включаем трек, снимаем заглушку
      const v = (remoteStreamRef.current as any)?.getVideoTracks?.()?.[0];
      if (v) v.enabled = true;
      setRemoteCamOn(true);
      setRemoteViewKey(Date.now()); // принудительный ре-рендер RTCView
    }
  }, [partnerInPiP]);
  
  const handleAnswer = useCallback(async ({ from, answer }: { from: string; answer: any }) => {
    console.log('[handleAnswer] Received answer', { from, isDirectCall, hasAnswer: !!answer, pcExists: !!peerRef.current });
    try {
      // УПРОЩЕНО: только один PC для 1-на-1
      let pc = peerRef.current;
      
      // КРИТИЧНО: Если PC не существует для инициатора дружеского звонка - создаем его
      // Это может произойти если answer пришел до создания PC в useEffect для call:accepted
      if (!pc && (isDirectCall || inDirectCall || friendCallAccepted)) {
        console.log('[handleAnswer] PC not found for friend call, creating one');
        let stream = localStream || localStreamRef.current;
        
        // КРИТИЧНО: Если локального стрима нет, создаем его
        if (!stream) {
          console.log('[handleAnswer] No local stream, creating one');
          try {
            stream = await startLocalStream('front');
            // КРИТИЧНО: Если startLocalStream вернул null, создаем напрямую через getUserMedia
            if (!stream) {
              console.log('[handleAnswer] startLocalStream returned null, creating stream directly');
              try {
                const audioConstraints: any = {
                  echoCancellation: true,
                  noiseSuppression: true,
                  autoGainControl: true,
                  googEchoCancellation: true,
                  googNoiseSuppression: true,
                  googAutoGainControl: true,
                };
                stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
                if (stream) {
                  setLocalStream(stream);
                  const videoTrack = stream.getVideoTracks()?.[0];
                  const audioTrack = stream.getAudioTracks()?.[0];
                  if (videoTrack) {
                    videoTrack.enabled = true;
                    setCamOn(true);
                  }
                  if (audioTrack) {
                    audioTrack.enabled = true;
                    setMicOn(true);
                  }
                  console.log('[handleAnswer] Created stream directly via getUserMedia');
                }
              } catch (directError) {
                console.error('[handleAnswer] Error creating stream directly:', directError);
                return; // Не можем продолжить без стрима
              }
            }
          } catch (e) {
            console.error('[handleAnswer] Error creating local stream:', e);
            return; // Не можем продолжить без стрима
          }
        }
        
        if (stream) {
          try {
            pc = ensurePcWithLocal(stream);
            if (pc) {
              // КРИТИЧНО: Устанавливаем partnerId из from если он не установлен (для восстановления после PiP)
              if (!partnerIdRef.current && from) {
                setPartnerId(from);
                partnerIdRef.current = from;
                console.log('[handleAnswer] Set partnerId from answer:', from);
              }
              
              // КРИТИЧНО: Используем partnerId из ref или from
              const partnerIdForHandlers = partnerIdRef.current || from;
              if (partnerIdForHandlers) {
                attachRemoteHandlers(pc, partnerIdForHandlers);
                console.log('[handleAnswer] Created PC and attached handlers with partnerId:', partnerIdForHandlers);
              } else {
                console.warn('[handleAnswer] No partnerId available for handlers');
              }
            } else {
              console.warn('[handleAnswer] Failed to create PC');
            }
          } catch (e) {
            console.error('[handleAnswer] Error creating PC:', e);
          }
        } else {
          console.warn('[handleAnswer] No local stream available after creation attempt');
        }
      }
      
      if (!pc) {
        console.warn('[handleAnswer] PeerConnection not found');
        return;
      }
      
      // Проверяем что PC еще валиден
      if ((pc.signalingState as any) === 'closed' || (pc.connectionState as any) === 'closed' || !peerRef.current || peerRef.current !== pc) {
        console.warn('[handleAnswer] PC is closed or changed, aborting', {
          signalingState: pc.signalingState,
          connectionState: pc.connectionState,
          pcExists: !!peerRef.current,
          pcMatches: peerRef.current === pc
        });
        return;
      }
      
      // Проверяем что PC в правильном состоянии для принятия answer
      if (pc.signalingState !== 'have-local-offer') {
        if (pc.signalingState === 'stable') {
          // PC уже в стабильном состоянии - соединение уже установлено
          console.log('[handleAnswer] PC already in stable state, ignoring duplicate answer from:', from);
        } else {
          console.warn('[handleAnswer] PC not in have-local-offer state:', pc.signalingState);
        }
        return;
      }
      
      // Проверяем что еще нет remote description
      const hasRemoteDesc = !!(pc as any).remoteDescription;
      if (hasRemoteDesc) {
        console.warn('[handleAnswer] PC already has remote description');
        return;
      }
      
      // Задержка для снятия гонки одновременных SDP
      try { await new Promise(res => setTimeout(res, 150)); } catch {}
      
      // КРИТИЧНО: Используем peerRef.current вместо локальной переменной pc
      const currentPcForAnswer = peerRef.current;
      if (!currentPcForAnswer || currentPcForAnswer !== pc) {
        console.warn('[handleAnswer] PC was changed or removed, aborting setRemoteDescription');
        return;
      }
      
      // Проверяем состояние PC перед setRemoteDescription
      if (currentPcForAnswer.signalingState === 'have-local-offer') {
        try {
          // КРИТИЧНО: Проверяем еще раз перед вызовом
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleAnswer] PC was changed right before setRemoteDescription, aborting');
            return;
          }
          await currentPcForAnswer.setRemoteDescription(answer);
          console.log('[handleAnswer] Set remote answer, PC state:', currentPcForAnswer.signalingState);
        } catch (error: any) {
          // Если ошибка связана с закрытым PC, просто игнорируем
          if (error?.message?.includes('closed') || error?.message?.includes('null')) {
            console.warn('[handleAnswer] PC was closed during setRemoteDescription, ignoring error');
            return;
          }
          console.error('[handleAnswer] Error setting remote description:', error);
          return;
        }
      } else {
        console.warn('[handleAnswer] PC not in correct state for setRemoteDescription:', currentPcForAnswer.signalingState, 'connectionState:', currentPcForAnswer.connectionState);
      }
      
      setStarted(true);
      
      // После установки — прожечь отложенные ICE
      try { await flushIceFor(from); } catch {}

      // Обновляем список друзей
      try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
      
      // Отправляем текущее состояние камеры новому собеседнику
      setTimeout(() => {
        sendCameraState(from);
      }, 500);
    } catch (e) {
      console.error('[handleAnswer] Error:', e);
    }
  }, [flushIceFor, fetchFriends, sendCameraState, isDirectCall, inDirectCall, friendCallAccepted, localStream, ensurePcWithLocal, attachRemoteHandlers, startLocalStream]);
  
  const handleCandidate = useCallback(async ({ from, candidate }: { from: string; candidate: any }) => {
    // Логируем только если PC существует и это первый кандидат, или если есть ошибка
    const pc = peerRef.current;
    const hasCandidate = !!candidate;
    
    // Логируем только важные случаи
    if (!hasCandidate) {
      console.warn('[handleCandidate] Received invalid candidate', { from });
      return;
    }
    
    try { 
      const key = String(from || '');
      
      // Если remoteDescription ещё не установлен — складируем кандидата
      if (!pc || !(pc as any).remoteDescription || !(pc as any).remoteDescription?.type) {
        // Логируем только первый раз при складировании (не при каждом кандидате)
        const pendingCount = pendingIceByFromRef.current[key]?.length || 0;
        if (pendingCount === 0) {
          console.log('[handleCandidate] Queueing ICE candidate (waiting for remoteDescription)', { from, pcExists: !!pc });
        }
        enqueueIce(key, candidate);
        return;
      }
      
      // Логируем только если это первый добавленный кандидат
      await pc.addIceCandidate(candidate);
      // Убираем постоянный лог - кандидаты приходят часто при установлении соединения
    } catch (e) {
      console.error('[handleCandidate] Error adding ICE candidate:', e);
    }
  }, [enqueueIce]);

  const handlePeerStopped = useCallback(() => {
    // Партнёр остановил поиск — мягко очищаем удалённое соединение без навигации
    stopRemoteOnly();
    try { stopSpeaker(); } catch {}
    
    // КРИТИЧНО: Сохраняем старые значения ДО очистки для проверки типа звонка
    const oldPartnerId = partnerIdRef.current;
    const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
    
    // Очищаем видео партнера
    setRemoteStream(null);
    setPartnerId(null);
    setPartnerUserId(null);
    setPartnerInPiP(false);
    
    // КРИТИЧНО: Полностью закрываем старое PC чтобы избежать ложных срабатываний bindConnHandlers
    if (peerRef.current) {
      console.log('[handlePeerStopped] Cleaning up old PC before auto-search');
      try {
        cleanupPeer(peerRef.current);
      } catch (e) {
        console.warn('[handlePeerStopped] Error cleaning PC:', e);
      }
      peerRef.current = null;
    }
    
    // КРИТИЧНО: Определяем тип чата ДО очистки
    const isRandomChat = !isDirectCall && !inDirectCallRef.current;
    const wasDirectCall = isDirectCall || inDirectCallRef.current;
    const hadPartner = !!oldPartnerId;
    
    // КРИТИЧНО: НЕ запускаем автопоиск если:
    // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
    // 2. Это был прямой звонок (isDirectCall или inDirectCall) - для прямых звонков нет автопоиска
    if (isInactive || wasDirectCall) {
      console.log('[handlePeerStopped] Skipping auto-search - call ended or was direct call', { 
        isInactive, 
        wasDirectCall,
        hadPartner 
      });
      return;
    }
    
    // КРИТИЧНО: Для рандомного чата ВСЕГДА запускаем автопоиск, даже если пользователи друзья
    // Это гарантирует, что оба пользователя начнут поиск нового партнера
    if (isRandomChat && !manuallyRequestedNextRef.current) {
      console.log('[handlePeerStopped] Starting auto-search for random chat', { hadPartner, wasStarted: startedRef.current });
      setLoading(true); // Показываем спиннер загрузки
      setStarted(true); // Включаем поиск
      setTimeout(() => {
        try { 
          socket.emit('next'); 
          console.log('[handlePeerStopped] Emitted next for auto-search');
        } catch (e) {
          console.warn('[handlePeerStopped] Error emitting next:', e);
        }
      }, 300);
    } else if (manuallyRequestedNextRef.current) {
      console.log('[handlePeerStopped] Skipping auto-search - manual next was requested');
      manuallyRequestedNextRef.current = false; // Сбрасываем флаг
    }
  }, [stopRemoteOnly, isDirectCall, cleanupPeer, wasFriendCallEnded]);

  const handlePeerLeft = useCallback(({ peerId, reason }: { peerId: string; reason?: string }) => {
    console.log('[handlePeerLeft] Peer left:', peerId, 'reason:', reason);
    // Если это наш текущий собеседник - очищаем соединение
    if (peerId === partnerIdRef.current) {
      stopRemoteOnly();
      
      // КРИТИЧНО: Сохраняем старые значения ДО очистки для проверки типа звонка
      const oldPartnerId = partnerIdRef.current;
      const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
      
      // Очищаем видео партнера
      setRemoteStream(null);
      setPartnerId(null);
      setPartnerUserId(null);
      setPartnerInPiP(false); // Сбрасываем состояние PiP при остановке партнера
      
      // КРИТИЧНО: Полностью закрываем старое PC чтобы избежать ложных срабатываний bindConnHandlers
      if (peerRef.current) {
        console.log('[handlePeerLeft] Cleaning up old PC before auto-search');
        try {
          cleanupPeer(peerRef.current);
        } catch (e) {
          console.warn('[handlePeerLeft] Error cleaning PC:', e);
        }
        peerRef.current = null;
      }
      
      // КРИТИЧНО: Определяем тип чата ДО очистки
      const isRandomChat = !isDirectCall && !inDirectCallRef.current;
      const wasDirectCall = isDirectCall || inDirectCallRef.current;
      
      // КРИТИЧНО: НЕ запускаем автопоиск если:
      // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
      // 2. Это был прямой звонок (isDirectCall или inDirectCall) - для прямых звонков нет автопоиска
      if (isInactive || wasDirectCall) {
        console.log('[handlePeerLeft] Skipping auto-search - call ended or was direct call', { 
          isInactive, 
          wasDirectCall,
          oldPartnerId 
        });
        return;
      }
      
      // КРИТИЧНО: Для рандомного чата ВСЕГДА запускаем автопоиск, даже если пользователи друзья
      // Это гарантирует, что оба пользователя начнут поиск нового партнера
      if (isRandomChat && !manuallyRequestedNextRef.current) {
        console.log('[handlePeerLeft] Starting auto-search for random chat', { wasStarted: startedRef.current });
        setLoading(true); // Показываем спиннер загрузки
        setStarted(true); // Включаем поиск
        setTimeout(() => {
          try { 
            socket.emit('next'); 
            console.log('[handlePeerLeft] Emitted next for auto-search');
          } catch (e) {
            console.warn('[handlePeerLeft] Error emitting next:', e);
          }
        }, 300);
      } else if (manuallyRequestedNextRef.current) {
        console.log('[handlePeerLeft] Skipping auto-search - manual next was requested');
        manuallyRequestedNextRef.current = false; // Сбрасываем флаг
      }
    }
  }, [stopRemoteOnly, isDirectCall, cleanupPeer, wasFriendCallEnded]);

  const handlePeerHangup = useCallback(() => {
    // УПРОЩЕНО: партнёр завершил звонок (1-на-1)
    stopRemoteOnly();
    setLoading(false);
    setStarted(false);
    try { stopSpeaker(); } catch {}

    // Закрываем оверлей модалки входящего звонка
    setIncomingFriendCall(null);
    setIncomingOverlay(false);
    stopIncomingAnim();
    setFriendCallAccepted(false);
    setInDirectCall(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при завершении звонка
    
    // Навигация: если звонок не начался — возвращаемся на origin
      try { stopLocalStream(); } catch {}
      setLocalStream(null);
      setCamOn(false);
      setMicOn(false);
      setLocalRenderKey(k => k + 1);
    
      if (!remoteStream) {
        const origin = callOriginRef.current;
        if (origin?.name) {
          try { 
            const nav = (global as any).__navRef;
            if (nav?.isReady && nav.isReady() && nav.dispatch) {
              nav.dispatch(CommonActions.reset({ index: 0, routes: [{ name: origin.name as any, params: origin.params }] }));
            }
          } catch {}
        }
      } else {
        goToVideoChatWithHomeUnder();
      }
    
    // Жёсткий сброс состояния
      setRemoteStream(null);
      setPartnerId(null);
      setPartnerUserId(null);
      setInDirectCall(false);
      setRemoteCamOn(true);
  }, [stopRemoteOnly, stopIncomingAnim, stopLocalStream, remoteStream, goToVideoChatWithHomeUnder]);

  // создаём "частотные уровни" на базе micLevel
const eqLevels = useMemo(() => {
  const bars = 19;
  const arr: number[] = [];
  for (let i = 0; i < bars; i++) {
    // добавляем случайный разброс, чтобы полоски были разные
    const jitter = 0.7 + Math.random() * 0.6; 
    arr.push(Math.min(1, micLevel * jitter));
  }
  return arr;
}, [micLevel]);
  

  const showFriendBadge = useMemo(() => {
    // УПРОЩЕНО: бейдж «Друг» для единственного собеседника
    // КРИТИЧНО: Не показываем бэйдж в неактивном состоянии (после завершения звонка)
    if (!partnerUserId || !started || isInactiveState) {
      console.log('[showFriendBadge] Returning false:', { partnerUserId, started, isInactiveState });
      return false;
    }
    const isFriend = friends.some(f => String(f._id) === String(partnerUserId));
    console.log('[showFriendBadge] Checking:', {
      partnerUserId,
      started,
      isInactiveState,
      friendsCount: friends.length,
      isFriend,
      willShow: isFriend
    });
    return isFriend;
  }, [partnerUserId, friends, started, isInactiveState]);

  // УПРОЩЕНО: Кнопка «Прервать» для режима friends с активным соединением
  const showAbort = useMemo(() => {
    const isFriendsMode = isDirectCall || inDirectCall || friendCallAccepted;
    // Для дружеских звонков показываем "Прервать" сразу после принятия звонка
    // Не ждем remoteStream - он может появиться позже
    // КРИТИЧНО: hasActiveCall должен быть false если мы в неактивном состоянии
    const hasActiveCall = !isInactiveState && (!!roomIdRef.current || !!currentCallIdRef.current || pcConnected || started);
    
    // Дополнительная проверка для возврата из background
    const isReturnFrombackground = route?.params?.returnToActiveCall;
    const hasbackgroundContext = false;
    
    const result = isFriendsMode && hasActiveCall;
    const resultWithbackground = result || (isReturnFrombackground && hasbackgroundContext);
    
    // ВАЖНО: Показываем кнопку "Прервать" как заблокированную после завершения звонка (неактивное состояние)
    // Если звонок завершен (isInactiveState === true) И это был звонок друга, показываем заблокированную кнопку
    const showDisabledAbort = isInactiveState && (wasFriendCallEnded || isDirectCall || inDirectCall || friendCallAccepted);
    
    console.log('[showAbort] Calculation:', {
      isFriendsMode,
      hasActiveCall,
      roomId: !!roomIdRef.current,
      callId: !!currentCallIdRef.current,
      pcConnected,
      started,
      result,
      isReturnFrombackground,
      hasbackgroundContext,
      isInactiveState,
      wasFriendCallEnded,
      showDisabledAbort,
      finalResult: resultWithbackground || showDisabledAbort,
      partnerUserId: partnerUserIdRef.current
    });
    
    // Показываем кнопку либо при активном звонке, либо как заблокированную после завершения
    return resultWithbackground || showDisabledAbort;
  }, [isDirectCall, inDirectCall, friendCallAccepted, pcConnected, started, partnerUserId, route?.params?.returnToActiveCall, isInactiveState, wasFriendCallEnded]);

  // Свайп «слева направо» для возврата на экран приветствия (Home),
  // работает только когда звонка нет (видны «Начать/Далее»)
  const swipeX = useRef(new Animated.Value(0)).current;
  // Плавный вход экрана: выезд справа при открытии
  const enterX = useRef(new Animated.Value(Dimensions.get('window').width)).current;
  useEffect(() => {
    try {
      const dur = route?.params?.afterCallEnd ? 380 : 300;
      Animated.timing(enterX, {
        toValue: 0,
        duration: dur,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } catch {}
  }, [enterX, route?.params?.afterCallEnd]);
  const handleSwipeMove = useCallback(({ nativeEvent }: any) => {
    try {
      if (showAbort || started) return;
      const w = Dimensions.get('window').width;
      const x = Math.max(0, Math.min(w, Number(nativeEvent.translationX || 0)));
      swipeX.setValue(x);
    } catch {}
  }, [showAbort, started, swipeX]);
  const handleSwipeBack = useCallback(({ nativeEvent }: any) => {
    try {
      if (nativeEvent.state === 5) { // END
        const dx = Number(nativeEvent.translationX || 0);
        const w = Dimensions.get('window').width;
        const threshold = w * 0.5; // половина экрана
        if (dx > threshold && !showAbort && !started) {
          Animated.timing(swipeX, { toValue: w, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => {
            try {
              // Проверяем: это звонок друга с активным соединением?
              const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
              const hasActiveCall = !!roomIdRef.current; // Достаточно roomId - поток может быть временно null
              
              console.log('[handleSwipeBack] Checking background activation:', {
                isFriendCall,
                hasActiveCall,
                roomId: roomIdRef.current,
              });
              
              if (isFriendCall && hasActiveCall) {
                // Звонок друга - активируем background перед навигацией
                console.log('[handleSwipeBack] Friend call - activating background before navigation');
                
                try {
                  const partnerNick = friendsRef.current.find(f => String(f._id) === String(partnerUserIdRef.current))?.nick;
                  
                  // Используем state remoteStream если ref пустой
                  const streamToUse = remoteStreamRef.current || remoteStream;
                  console.log('[handleSwipeBack] Using stream for background:', {
                    hasRefStream: !!remoteStreamRef.current,
                    hasStateStream: !!remoteStream,
                    streamId: streamToUse?.id,
                    streamActive: streamToUse?.active,
                    streamTracks: streamToUse?.getTracks?.()?.length,
                    remoteCamOn: remoteCamOnRef.current,
                    partnerUserId: partnerUserIdRef.current,
                  });
                  
                  // Дополнительная проверка: если поток не найден, попробуем получить из peerConnection
                  let finalStreamToUse = streamToUse;
                  if (!streamToUse && peerRef.current) {
                    try {
                      const pc = peerRef.current;
                      const receivers = pc.getReceivers();
                      const videoReceiver = receivers.find(r => r.track && r.track.kind === 'video');
                      if (videoReceiver && videoReceiver.track) {
                        console.log('[handleSwipeBack] Found video track in peerConnection, creating stream');
                        const fallbackStream = new MediaStream([videoReceiver.track]);
                        setRemoteStream(fallbackStream);
                        remoteStreamRef.current = fallbackStream;
                        finalStreamToUse = fallbackStream;
                        console.log('[handleSwipeBack] Created fallback stream:', fallbackStream.id);
                      }
                    } catch (e) {
                      console.warn('[handleSwipeBack] Failed to create fallback stream:', e);
                    }
                  }
                  
                  // Передаем живые streams + контекст в background
                  const finalRemote = remoteStreamRef.current || remoteStream;
                  const finalLocal = localStreamRef.current;
                  
                  // background removed
                  
                  // Уведомляем партнера что мы покинули экран
                  try {
                    socket.emit('bg:entered', { 
                      callId: roomIdRef.current,
                      partnerId: partnerUserIdRef.current 
                    });
                    console.log('[handleSwipeBack] Notified partner about background mode');
                  } catch (e) {
                    console.warn('[handleSwipeBack] Error notifying partner about background:', e);
                  }
                } catch (e) {
                  console.warn('[handleSwipeBack] Error showing background:', e);
                }
              } else if (!isFriendCall && hasActiveCall) {
                // Рандомный чат - отправляем сигналы завершения
                console.log('[handleSwipeBack] Random chat - notifying partner and leaving');
                
                try {
                  // Отправляем сигнал партнеру что мы покинули чат
                  const currentRoomId = roomIdRef.current;
                  if (currentRoomId) {
                    socket.emit('room:leave', { roomId: currentRoomId });
                    console.log('[handleSwipeBack] Sent room:leave for:', currentRoomId);
                  }
                  
                  // Отправляем stop сигнал
                  socket.emit('stop');
                  console.log('[handleSwipeBack] Sent stop signal');
                  
                  // Очищаем соединение
                  cleanupPeer(peerRef.current);
                  peerRef.current = null;
                  setRemoteStream(null);
                  setPartnerId(null);
                  setPartnerUserId(null);
                  
                } catch (e) {
                  console.warn('[handleSwipeBack] Error notifying partner:', e);
                }
              }
              
              const nav = (global as any).__navRef;
              if (nav?.canGoBack?.()) {
                nav.goBack();
              } else {
                nav?.dispatch?.(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
              }
            } catch {}
          });
        } else {
          Animated.spring(swipeX, { toValue: 0, useNativeDriver: true, bounciness: 6, speed: 18 }).start();
        }
      }
    } catch {}
  }, [showAbort, started, swipeX]);

  const handleDisconnected = useCallback(() => {
    // УПРОЩЕНО: При дисконнекте (1-на-1)
    const wasInCall = !!remoteStreamRef.current;
    const wasStarted = started;
    const wasDirectCall = isDirectCall;
    const wasInDirectCall = inDirectCall;
    
    // КРИТИЧНО: Сохраняем старые значения ДО очистки для проверки типа звонка
    const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
    
    console.log('[handleDisconnected] State:', { wasInCall, wasStarted, wasDirectCall, wasInDirectCall, isInactive });
    
    stopMicMeter();
    setRemoteCamOn(true);
    try { peerRef.current?.close(); } catch {}
    peerRef.current = null;
    setRemoteStream(null);
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteMutedMain(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при разрыве соединения
    setInDirectCall(false);
    stopSpeaker();
    
    // КРИТИЧНО: Определяем тип чата
    const isRandomChat = !wasDirectCall && !wasInDirectCall;
    const wasDirectCallFlag = wasDirectCall || wasInDirectCall;
    
    // КРИТИЧНО: НЕ запускаем автопоиск если:
    // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
    // 2. Это был прямой звонок (wasDirectCall || wasInDirectCall) - для прямых звонков нет автопоиска
    if (isInactive || wasDirectCallFlag) {
      console.log('[handleDisconnected] Skipping auto-search - call ended or was direct call', { 
        isInactive, 
        wasDirectCallFlag, 
        wasInCall 
      });
      // Если был прямой звонок - возвращаемся на VideoChat
      if (wasInCall && wasDirectCallFlag) {
        console.log('[handleDisconnected] Returning to VideoChat (was direct call)');
        setLoading(false);
        setStarted(false);
        goToVideoChatWithHomeUnder();
      }
      return;
    }
    
    // КРИТИЧНО: Автоматически начинаем поиск если были в рандомном чате
    // Для рандомного чата ВСЕГДА запускаем автопоиск, даже если пользователи друзья
    // Это гарантирует, что оба пользователя начнут поиск нового партнера
    if (isRandomChat && wasInCall) {
      console.log('[handleDisconnected] Starting auto-search for random chat', { wasStarted, wasInCall });
      setLoading(true); // Показываем спиннер загрузки
      setStarted(true); // Включаем поиск
      setTimeout(() => {
        try { 
          socket.emit('next'); 
          console.log('[handleDisconnected] Emitted next for auto-search');
        } catch (e) {
          console.warn('[handleDisconnected] Error emitting next:', e);
        }
      }, 300);
      return;
    }
    
    if (wasInCall) {
      // Если звонок был — возвращаемся в [Home, VideoChat]
      console.log('[handleDisconnected] Returning to VideoChat (was direct call)');
      setLoading(false);
      setStarted(false);
      goToVideoChatWithHomeUnder();
    } else {
      // звонок не состоялся — вернёмся на origin
      console.log('[handleDisconnected] No call established, returning to origin');
      setLoading(false);
      setStarted(false);
      const origin = callOriginRef.current;
      if (origin?.name && origin.name !== 'VideoChat') {
        try { (global as any).__navRef?.reset?.({ index: 0, routes: [{ name: origin.name as any, params: origin.params }] }); } catch {}
      }
    }
  }, [stopMicMeter, goToVideoChatWithHomeUnder, isDirectCall, inDirectCall, triggerAutoSearch, started, wasFriendCallEnded]);


  useEffect(() => {
    socket.on('match_found', handleMatchFound);
    
    // WebRTC handlers для всех типов чатов
    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleCandidate);
    logger.debug('[VideoChat] WebRTC handlers registered', { isDirectCall });
    
    socket.on('disconnected', handleDisconnected);
    socket.on('hangup', handlePeerHangup);
    socket.on('peer:stopped', handlePeerStopped);
    socket.on('peer:left', handlePeerLeft);
    
    // Обработчик состояния PiP партнера
    socket.on('pip:state', (data: { inPiP: boolean; from: string; roomId: string }) => {
      const { inPiP, from, roomId: eventRoomId } = data;
      const currentRoomId = roomIdRef.current;
      
      console.log('[pip:state] Received event:', { 
        inPiP, 
        from, 
        eventRoomId, 
        currentRoomId,
        partnerId: partnerId,
        partnerIdRef: partnerIdRef.current,
        isDirectCall,
        inDirectCall: inDirectCallRef.current,
        friendCallAccepted: friendCallAcceptedRef.current
      });
      
      // Игнорируем свои эхо-события
      if (String(from || '') === String(socket.id || '')) {
        console.log('[pip:state] Ignored: own echo event');
        return;
      }
      
      // Ослабляем фильтр: принимаем если хотя бы один из условий выполнен
      const roomOk = !!eventRoomId && !!currentRoomId && eventRoomId === currentRoomId;
      const fromOk = String(from || '') === String(partnerIdRef.current || '');
      const inCall = !!remoteStreamRef.current;
      
      // Детальный лог для диагностики фильтрации
      console.log('[pip:state] Filter check:', { 
        roomOk, 
        fromOk, 
        inCall, 
        eventRoomId, 
        currentRoomId, 
        from, 
        partnerIdRef: partnerIdRef.current,
        hasRemoteStreamRef: !!remoteStreamRef.current
      });
      
      if (roomOk || fromOk || inCall) {
        console.log('[pip:state] Accepting by', roomOk ? 'roomId' : fromOk ? 'from' : 'inCall');
        
        // Если партнёр вернулся из PiP - восстанавливаем видео ПЕРЕД установкой флага
        if (!inPiP) {
          const remoteStream = remoteStreamRef.current;
          const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
          if (videoTrack) {
            videoTrack.enabled = true; // включаем трек
            setRemoteCamOn(true);      // убираем заглушку
            setLoading(false);
            setRemoteViewKey(Date.now()); // принудительная перерисовка RTCView
            console.log('[pip:state] Partner returned from PiP — remote video restored');
          } else {
            console.log('[pip:state] Partner back from PiP, but no video track found - setting remoteCamOn=true anyway');
            setRemoteCamOn(true);
            setLoading(false);
          }
          
          // Шлем наш стейт камеры другу
          try {
            sendCameraState(from);
            console.log('[pip:state] Partner returned from PiP, sent camera state');
          } catch (e) {
            console.warn('[pip:state] Failed to send camera state:', e);
          }
        }
        
        // Устанавливаем флаг ПОСЛЕ восстановления видео
        setPartnerInPiP(inPiP);
      } else {
        console.log('[pip:state] Ignored: no room/from/inCall match', { eventRoomId, currentRoomId, from, partnerId: partnerIdRef.current, inCall });
      }
    });
    const incMissed = async (userId?: string | null) => {
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
    };
    socket.on('call:timeout', () => {
      // Таймаут: просто закрываем модалку. Если мы были в поиске внутри VideoChat — останавливаем поиск.
      const uid = incomingFriendCall?.from ? String(incomingFriendCall.from) : undefined;
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      stopIncomingAnim();
      if (uid) void incMissed(uid);
      setInDirectCall(false);
      // Если сейчас идёт поиск в VideoChat — остановим его (кнопка станет «Начать»)
      try { if (started) onStartStop(); } catch {}
    });
    
    // Новый обработчик: собеседник занят
    socket.on('call:busy', (data: any) => {
      console.log('[call:busy] Received call:busy:', data);
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      stopIncomingAnim();
      setInDirectCall(false);
      
      // НЕ показываем тост - у занятых друзей уже есть бэйдж "Занято" и задизейблена кнопка
      // В рандомном поиске это нормальный процесс поиска свободного собеседника
      
      // КРИТИЧНО: Очищаем WebRTC состояние при call:busy
      try {
        console.log('[call:busy] Cleaning up WebRTC state...');
        const pc = peerRef.current;
        if (pc) {
          try { pc.getSenders?.().forEach((s: any) => { try { s.replaceTrack?.(null); } catch {} }); } catch {}
          try { (pc as any).ontrack = null; (pc as any).onaddstream = null; (pc as any).onicecandidate = null; } catch {}
          try { pc.close(); } catch {}
        }
        peerRef.current = null;
        
        // Очищаем remote stream
        if (remoteStreamRef.current) {
          try { remoteStreamRef.current.getTracks?.().forEach((t: any) => { try { t.stop(); } catch {} }); } catch {}
          try { /* @ts-ignore */ remoteStreamRef.current = null; } catch {}
        }
        setRemoteStream(null);
        setPartnerId(null);
        setPartnerUserId(null);
        setRemoteMutedMain(false);
        setRemoteCamOn(true);
        
        // Очищаем roomIdRef
        roomIdRef.current = null;
        console.log('[call:busy] WebRTC cleanup completed');
      } catch (err) {
        console.error('[call:busy] WebRTC cleanup error:', err);
      }
      
      // Если шёл поиск — останавливаем
      try { if (started) onStartStop(); } catch {}
    });
    
    // УДАЛЕНО: обработчик presence:update
    // HomeScreen.tsx уже обрабатывает это событие глобально
    
    socket.on('call:declined', (d: any) => {
      // Увеличиваем только если отменил звонящий, а не я сам
      const from = d?.from ? String(d.from) : undefined;
      if (from && from !== String(myUserId || '')) void incMissed(from);
      // Если это мы отклонили — блокируем автоподключение к этому пользователь на короткий срок
      if (from && from !== String(myUserId || '')) {
        // пришло «от кого», значит инициатор отменил — просто закрываем
      } else if (incomingFriendCall?.from) {
        setDeclinedBlock(incomingFriendCall.from, 12000);
      }
      // Закрыть любые оверлеи и вернуть вид ожидания
      setIncomingOverlay(false); setIncomingFriendCall(null); stopIncomingAnim();
      setFriendCallAccepted(false); setInDirectCall(false);
      // Если шёл поиск внутри VideoChat — остановим его, без навигации
      try { if (started) onStartStop(); } catch {}
    });
    const offCancel = onCallCanceled?.(async (d) => {
      // Отмена инициатором — закрыть оверлей и отметить пропущенный
      const from = d?.from ? String(d.from) : undefined;
      if (from && from !== String(myUserId || '')) await incMissed(from);
      setIncomingOverlay(false); setIncomingFriendCall(null); stopIncomingAnim();
      // Если шёл поиск внутри VideoChat — остановим его, без навигации
      try { if (started) onStartStop(); } catch {}
    });
    return () => {
      socket.off('match_found', handleMatchFound);
      
      // WebRTC handlers для всех типов чатов
      socket.off('offer', handleOffer);
      socket.off('answer', handleAnswer);
      socket.off('ice-candidate', handleCandidate);
      
      socket.off('disconnected', handleDisconnected);
      socket.off('hangup', handlePeerHangup);
      socket.off('peer:stopped', handlePeerStopped);
      socket.off('peer:left', handlePeerLeft);
      socket.off('pip:state');
      socket.off('call:timeout');
      socket.off('call:busy');
      socket.off('call:declined');
      offCancel?.();
    };
  }, [handleDisconnected, handleMatchFound, handleOffer, handleAnswer, handleCandidate, handlePeerStopped, handlePeerHangup, handlePeerLeft, incomingFriendCall?.from, showToast, L, isDirectCall, sendCameraState]);
  
  // Входящий звонок от друга (совместимость: транслируем и из call:incoming)
  useEffect(() => {
    console.log('[useEffect incoming calls] Registering handlers for friend calls');
    
    const handleIncomingFriend = ({ from, nick, callId }: { from: string; nick?: string; callId?: string }) => {
      logger.debug('[handleIncomingFriend] Received friend call', { from, nick, callId, isInactiveState });
      console.log('[handleIncomingFriend] ===== RECEIVED FRIEND CALL =====', { 
        from, 
        nick, 
        callId, 
        isInactiveState,
        started: startedRef.current,
        partnerId: partnerIdRef.current,
        isDirectCall,
        currentIncomingOverlay: incomingOverlay,
        currentIncomingFriendCall: incomingFriendCall,
        currentFriendCallAccepted: friendCallAccepted
      });
      
      // КРИТИЧНО: Устанавливаем incomingCall всегда, даже если callId нет
      // Это нужно для работы кнопок "Принять" и "Отклонить"
      setIncomingCall({ 
        callId: callId || currentCallIdRef.current || '', 
        from, 
        fromNick: nick 
      });
      
      // Устанавливаем callId если есть
      if (callId) {
        currentCallIdRef.current = callId;
        logger.debug('[handleIncomingFriend] Set currentCallIdRef to:', callId);
        console.log('[handleIncomingFriend] Set currentCallIdRef to:', callId);
      }
      
      // 3.3. Один раз в точке входа звонка передавайте в PiP аватар/ник
      const friend = friends.find(f => String(f._id) === String(from));
      if (typeof updatePiPState === 'function') {
        // Строим полный URL аватара из поля avatar
        let partnerAvatarUrl: string | undefined = undefined;
        if (friend?.avatar) {
          const { SERVER_CONFIG } = require('../src/config/server');
          const serverUrl = SERVER_CONFIG.BASE_URL;
          partnerAvatarUrl = friend.avatar.startsWith('http') 
            ? friend.avatar 
            : `${serverUrl}${friend.avatar.startsWith('/') ? '' : '/'}${friend.avatar}`;
        }
        updatePiPState({
          partnerName: friend?.nick || nick || 'Друг',
          partnerAvatarUrl: partnerAvatarUrl,
        });
        console.log('[handleIncomingFriend] Updated PiP state with partner info:', {
          partnerName: friend?.nick || nick || 'Друг',
          hasAvatar: !!partnerAvatarUrl,
        });
      }
      
      // Показываем входящий звонок в любом состоянии
      logger.debug('[handleIncomingFriend] Showing incoming call overlay');
      console.log('[handleIncomingFriend] Showing incoming call overlay - setting states');
      setIncomingFriendCall({ from, nick });
      setFriendCallAccepted(false);
      setIncomingOverlay(true);
      console.log('[handleIncomingFriend] States set: incomingOverlay=true, incomingFriendCall set');
      startIncomingAnim();
    };

    const friendCallHandler = (d:any) => {
      console.log('[socket.on friend:call:incoming] Received friend:call:incoming event', d);
      logger.debug('[friend:call:incoming] Received friend call', d);
      try { 
        if (d?.callId && roomIdRef.current !== d.callId) {
          roomIdRef.current = d.callId;
          socket.emit('room:join:ack', { roomId: d.callId });
          logger.debug('[friend:call:incoming] Sent room:join:ack for roomId:', d.callId);
          console.log('[friend:call:incoming] Sent room:join:ack for roomId:', d.callId);
        }
      } catch {}
      console.log('[friend:call:incoming] Calling handleIncomingFriend with:', { from: d.from, nick: d.nick, callId: d.callId });
      handleIncomingFriend({ from: d.from, nick: d.nick, callId: d.callId });
    };
    
    const directCallHandler = ({ from, fromNick, callId }: { from: string; fromNick?: string; callId?: string }) => {
      console.log('[socket.on call:incoming] Received direct call:incoming event in VideoChat', { from, fromNick, callId });
      logger.debug('[socket.on call:incoming] Received direct call:incoming event', { from, fromNick, callId });
      console.log('[socket.on call:incoming] Calling handleIncomingFriend with:', { from, nick: fromNick, callId });
      handleIncomingFriend({ from, nick: fromNick, callId });
    };
    
    const friendCallEndHandler = () => {
      setIncomingFriendCall(null);
      setFriendCallAccepted(false);
      setIncomingOverlay(false);
      stopIncomingAnim();
    };

    // КРИТИЧНО: Регистрируем обработчики с приоритетом - сначала call:incoming, потом friend:call:incoming
    // Это нужно чтобы оба обработчика могли сработать если событие отправлено в обоих форматах
    socket.on("call:incoming", directCallHandler);
    socket.on("friend:call:incoming", friendCallHandler);
    socket.on("friend:call:end", friendCallEndHandler);
    
    console.log('[useEffect incoming calls] Handlers registered for call:incoming and friend:call:incoming');
    logger.debug('[useEffect incoming calls] Handlers registered', { socketId: socket.id, socketConnected: socket.connected });

    return () => {
      console.log('[useEffect incoming calls] Cleaning up handlers');
      socket.off("friend:call:incoming", friendCallHandler);
      socket.off("call:incoming", directCallHandler);
      socket.off("friend:call:end", friendCallEndHandler);
    };
  }, [startIncomingAnim, stopIncomingAnim, isInactiveState, friends, updatePiPState]);

  // Фиксируем callId для инициатора после принятия звонка
  useEffect(() => {
    const onAccepted = async (d: any) => {
      console.log('[call:accepted] Received call:accepted', d);
      try { 
        currentCallIdRef.current = d?.callId || null;
        console.log('[call:accepted] Set currentCallIdRef to:', currentCallIdRef.current);
      } catch {}
      
      // КРИТИЧНО: Для инициатора устанавливаем флаги при получении call:accepted
      // Это нужно чтобы handleMatchFound мог корректно обработать соединение
      if (isDirectCall && isDirectInitiator) {
        console.log('[call:accepted] Setting flags for initiator');
        setFriendCallAccepted(true);
        setInDirectCall(true);
        setStarted(true);
        
        // КРИТИЧНО: Создаем локальный стрим для инициатора, если его еще нет
        // Это нужно чтобы при приходе match_found стрим уже был готов
        if (!localStream) {
          console.log('[call:accepted] Creating local stream for initiator');
          startLocalStream('front').then((stream) => {
            if (stream) {
              console.log('[call:accepted] Local stream created for initiator');
            }
          }).catch((e) => {
            console.error('[call:accepted] Error creating local stream for initiator:', e);
          });
        }
      }
      
      // КРИТИЧНО: Создаем PeerConnection после принятия вызова
      try {
        const stream = localStream;
        if (stream && !peerRef.current && (friendCallAccepted || (isDirectCall && isDirectInitiator)) && inDirectCall) {
          console.log('[call:accepted] Creating PeerConnection for accepted call');
          const pc = ensurePcWithLocal(stream);
          if (pc && partnerIdRef.current) {
            attachRemoteHandlers(pc, partnerIdRef.current);
            console.log('[call:accepted] PeerConnection created and ready');
          }
        }
      } catch (e) {
        console.error('[call:accepted] Error creating PeerConnection:', e);
      }
    };
    try { socket.on('call:accepted', onAccepted); } catch {}
    return () => { try { socket.off('call:accepted', onAccepted); } catch {} };
  }, [localStream, friendCallAccepted, inDirectCall, isDirectCall, isDirectInitiator, ensurePcWithLocal, attachRemoteHandlers]);


  // --------------------------
  // Unmount cleanup
  // --------------------------
  useEffect(() => {
    // КРИТИЧНО: call:ended только для звонков друзей (directCall/inDirectCall), НЕ для рандомных!
    const onCallEnded = async (data?: any) => {
      logger.debug('[call:ended] Received call:ended event', data);
      
      // КРИТИЧНО: Проверяем, был ли это звонок друга, используя и state, и refs
      // Это важно когда пользователь в PiP и state может быть не актуален
      const wasFriendCall = isDirectCall || inDirectCall || friendCallAccepted || 
                           inDirectCallRef.current || friendCallAcceptedRef.current ||
                           !!roomIdRef.current || !!currentCallIdRef.current || !!partnerIdRef.current;
      logger.debug('[call:ended] Was friend call?', { 
        wasFriendCall, 
        isDirectCall, 
        inDirectCall, 
        friendCallAccepted,
        inDirectCallRef: inDirectCallRef.current,
        friendCallAcceptedRef: friendCallAcceptedRef.current,
        hasRoomId: !!roomIdRef.current,
        hasCallId: !!currentCallIdRef.current,
        hasPartnerId: !!partnerIdRef.current,
        callId: data?.callId,
        reason: data?.reason 
      });
      
      // Если это НЕ звонок друга - игнорируем (для рандомного чата используется 'disconnected' / 'peer:stopped')
      if (!wasFriendCall) {
        console.log('[call:ended] Ignoring call:ended for random chat');
        return;
      }
      
      // КРИТИЧНО: Также проверяем, что callId совпадает (если указан)
      // Это предотвращает завершение не того звонка
      if (data?.callId && currentCallIdRef.current && data.callId !== currentCallIdRef.current) {
        console.log('[call:ended] Ignoring call:ended - callId mismatch', {
          receivedCallId: data.callId,
          currentCallId: currentCallIdRef.current
        });
        return;
      }
      
      // Скрываем background если активен и очищаем сохраненные streams
      try {
        // background removed
        // background removed
      } catch {}
      
      // КРИТИЧНО: САМОЕ ПЕРВОЕ ДЕЛО - устанавливаем peerRef.current = null и isInactiveStateRef.current = true
      // Это должно быть ДО любых других действий, чтобы обработчики видели что звонок завершен
      const pcMain = peerRef.current;
      const pcPreCreated = preCreatedPcRef.current;
      
      // КРИТИЧНО: СНАЧАЛА устанавливаем peerRef.current = null, чтобы обработчики не видели активный PC
      peerRef.current = null;
      preCreatedPcRef.current = null;
      
      // КРИТИЧНО: СНАЧАЛА очищаем ВСЕ refs СИНХРОННО
      currentCallIdRef.current = null;
      roomIdRef.current = null;
      partnerUserIdRef.current = null;
      partnerIdRef.current = null;
      
      // КРИТИЧНО: СНАЧАЛА устанавливаем isInactiveStateRef.current = true СИНХРОННО
      isInactiveStateRef.current = true;
      setIsInactiveState(true);
      setWasFriendCallEnded(true);
      console.log('🔴 [call:ended] Set peerRef=null, isInactiveState=true, refs cleared FIRST (before any cleanup)');
      
      // КРИТИЧНО: Теперь очищаем обработчики ПЕРЕД закрытием PC
      // Это предотвратит их срабатывание
      try {
        if (pcMain) {
          console.log('🔴 [call:ended] Clearing handlers from main PC');
          try {
            (pcMain as any).onconnectionstatechange = null;
            (pcMain as any).oniceconnectionstatechange = null;
            (pcMain as any).ontrack = null;
            (pcMain as any).onaddstream = null;
            (pcMain as any).onicecandidate = null;
            (pcMain as any).onsignalingstatechange = null;
            (pcMain as any).onicegatheringstatechange = null;
            console.log('🔴 [call:ended] Handlers cleared from main PC');
          } catch (e) {
            console.warn('⚫ [call:ended] Error clearing handlers from main PC:', e);
          }
        }
        
        if (pcPreCreated) {
          console.log('🔴 [call:ended] Clearing handlers from pre-created PC');
          try {
            (pcPreCreated as any).onconnectionstatechange = null;
            (pcPreCreated as any).oniceconnectionstatechange = null;
            (pcPreCreated as any).ontrack = null;
            (pcPreCreated as any).onaddstream = null;
            (pcPreCreated as any).onicecandidate = null;
            (pcPreCreated as any).onsignalingstatechange = null;
            (pcPreCreated as any).onicegatheringstatechange = null;
            console.log('🔴 [call:ended] Handlers cleared from pre-created PC');
          } catch (e) {
            console.warn('⚫ [call:ended] Error clearing handlers from pre-created PC:', e);
          }
        }
      } catch (e) {
        console.warn('⚫ [call:ended] Error clearing handlers:', e);
      }
      
      // КРИТИЧНО: Останавливаем все таймеры и метры СРАЗУ
      console.log('[call:ended] Stopping mic meter and cleaning up resources');
      stopMicMeter();
      // КРИТИЧНО: Дополнительно устанавливаем micLevel=0 для эквалайзера
      setMicLevel(0);
      try { 
        pip.updatePiPState({ micLevel: 0 }); 
        console.log('[call:ended] Updated PiP micLevel to 0');
      } catch (e) {
        console.warn('[call:ended] Error updating PiP micLevel:', e);
      }
      try { stopSpeaker(); } catch {}
      try { setIncomingFriendCall(null); } catch {}
      try { setIncomingOverlay(false); } catch {}
      try { stopIncomingAnim(); } catch {}
      
      // Локальный клинап без повторной отправки событий
      setLoading(false);
      
      // КРИТИЧНО: Очищаем state
      setPartnerUserId(null);
      setPartnerId(null);
      
      // КРИТИЧНО: Также устанавливаем все флаги в false чтобы предотвратить любые автоматические действия
      setStarted(false);
      setCamOn(false);
      setMicOn(false);
      setFriendCallAccepted(false);
      setInDirectCall(false);
      
      // КРИТИЧНО: СНАЧАЛА очищаем все PeerConnection и их обработчики ПЕРЕД остановкой стрима
      // Это критично, потому что обработчики могут сработать во время остановки стрима
      try {
        // Очищаем основной PC и его обработчики СРАЗУ
        if (peerRef.current) {
          const pc = peerRef.current;
          console.log('🔴 [call:ended] Clearing handlers from main PC BEFORE stopLocalStream');
          try {
            (pc as any).onconnectionstatechange = null;
            (pc as any).oniceconnectionstatechange = null;
            (pc as any).ontrack = null;
            (pc as any).onaddstream = null;
            (pc as any).onicecandidate = null;
            (pc as any).onsignalingstatechange = null;
            (pc as any).onicegatheringstatechange = null;
            console.log('🔴 [call:ended] Handlers cleared from main PC BEFORE stopLocalStream');
          } catch (e) {
            console.warn('⚫ [call:ended] Error clearing handlers from main PC:', e);
          }
        }
        
        // Очищаем предварительно созданный PC и его обработчики СРАЗУ
        if (preCreatedPcRef.current) {
          const prePc = preCreatedPcRef.current;
          console.log('🔴 [call:ended] Clearing handlers from pre-created PC BEFORE stopLocalStream');
          try {
            (prePc as any).onconnectionstatechange = null;
            (prePc as any).oniceconnectionstatechange = null;
            (prePc as any).ontrack = null;
            (prePc as any).onaddstream = null;
            (prePc as any).onicecandidate = null;
            (prePc as any).onsignalingstatechange = null;
            (prePc as any).onicegatheringstatechange = null;
            console.log('🔴 [call:ended] Handlers cleared from pre-created PC BEFORE stopLocalStream');
          } catch (e) {
            console.warn('⚫ [call:ended] Error clearing handlers from pre-created PC:', e);
          }
        }
      } catch (e) {
        console.warn('⚫ [call:ended] Error clearing handlers before stopLocalStream:', e);
      }
      
      // КРИТИЧНО: Останавливаем локальные потоки ПОСЛЕ очистки обработчиков
      // КРИТИЧНО: Ждем завершения остановки, чтобы камера точно выключилась
      // КРИТИЧНО: stopLocalStream сам закроет PeerConnection внутри, но мы также явно очищаем их
      try { 
        await stopLocalStream(); 
        console.log('[call:ended] Local stream stopped successfully');
        
        // КРИТИЧНО: Дополнительная проверка - убеждаемся что все треки действительно остановлены
        // Это особенно важно для iOS где индикатор камеры может оставаться активным
        const remainingTracks = localStreamRef.current?.getTracks?.() || [];
        if (remainingTracks.length > 0) {
          console.warn('[call:ended] Some tracks still exist after stopLocalStream, force stopping:', remainingTracks.length);
          remainingTracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
              try { (t as any).release?.(); } catch {}
            } catch {}
          });
        }
      } catch (e) {
        console.error('[call:ended] Error stopping local stream:', e);
      }
      
      // КРИТИЧНО: После остановки стрима ЯВНО закрываем ВСЕ PeerConnection
      // peerRef и preCreatedPcRef уже установлены в null выше, поэтому просто закрываем PC
      try { 
        if (pcMain) {
          cleanupPeer(pcMain);
          console.log('🔴 [call:ended] Main PeerConnection closed');
        }
      } catch (e) {
        console.warn('⚫ [call:ended] Error closing main PC:', e);
      }
      
      try {
        if (pcPreCreated) {
          cleanupPeer(pcPreCreated);
          console.log('🔴 [call:ended] Pre-created PeerConnection closed');
        }
      } catch (e) {
        console.warn('⚫ [call:ended] Error closing pre-created PC:', e);
      }
      
      // КРИТИЧНО: Очищаем remote stream и все связанные состояния
      try {
        const remoteStream = remoteStreamRef.current;
        if (remoteStream) {
          const tracks = (remoteStream as any).getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
              // КРИТИЧНО: Дополнительная попытка освободить трек
              try { (t as any).release?.(); } catch {}
            } catch {}
          });
        }
      } catch (e) {
        console.warn('[call:ended] Error cleaning up remote stream:', e);
      }
      setRemoteStream(null);
      remoteStreamRef.current = null;
      // КРИТИЧНО: Принудительно обновляем remoteViewKey для очистки отображения
      setRemoteViewKey(0);
      
      // КРИТИЧНО: localStreamRef и localStream уже очищены в stopLocalStream выше
      
      // КРИТИЧНО: Сбрасываем ВСЕ флаги состояния для правильного отображения неактивного состояния
      // КРИТИЧНО: Делаем это ПОСЛЕ очистки всех потоков и PeerConnection
      // чтобы гарантировать что следующему вызову не останется "мусора" от предыдущего
      setLocalRenderKey(k => k + 1);
      setMicOn(false);
      setCamOn(false);
      setRemoteMutedMain(false);
      setRemoteCamOn(false); // КРИТИЧНО: Должно быть false после завершения звонка
      setPartnerInPiP(false); // КРИТИЧНО: Сбрасываем partnerInPiP
      setFriendCallAccepted(false);
      setInDirectCall(false);
      setStarted(false);
      setPcConnected(false); // КРИТИЧНО: Сбрасываем состояние соединения
      setLoading(false); // КРИТИЧНО: Сбрасываем loading
      
      // КРИТИЧНО: Флаги неактивного состояния уже установлены выше ПЕРЕД остановкой стрима
      // Не дублируем здесь, просто логируем
      
      console.log('[call:ended] Call cleanup completed - all resources cleared, ready for next call');
      console.log('🔴 [call:ended] Call cleanup completed successfully - handlers should be cleared, no more offers should be created, camera should be off');
      
      try { showToast('Звонок завершён'); } catch {}

      // КРИТИЧНО: Уведомляем друзей что мы снова доступны
      try {
        socket.emit('presence:update', { status: 'available' });
        console.log('[call:ended] Sent presence:update available');
      } catch (e) {
        console.error('[call:ended] Failed to send presence update:', e);
      }
      
      // КРИТИЧНО: Все состояния уже установлены выше, не дублируем
    };

    socket.on('call:ended', onCallEnded);
    return () => { socket.off('call:ended', onCallEnded); };
  }, [isDirectCall, inDirectCall, friendCallAccepted, stopMicMeter, stopSpeaker, stopIncomingAnim, cleanupPeer, stopLocalStream, showToast]);

  // Обработчик уведомления о том, что партнер перешел в background режим
  useEffect(() => {
    const onPartnerEnteredbackground = (data: any) => {
      console.log('[bg:entered] Partner entered background mode:', data);
      // УБРАНО: setPartnerInbackground(true) - партнер НЕ должен видеть заглушку
      // Партнер продолжает видеть видео как обычно
      console.log('[bg:entered] Partner is in background, but we continue showing video normally');
    };

    const onPartnerExitedbackground = (data: any) => {
      console.log('[bg:exited] Partner exited background mode:', data);
      // УБРАНО: setPartnerInbackground(false) - не используется
      console.log('[bg:exited] Partner returned from background, video continues normally');
    };

    socket.on('bg:entered', onPartnerEnteredbackground);
    socket.on('bg:exited', onPartnerExitedbackground);

    return () => {
      socket.off('bg:entered', onPartnerEnteredbackground);
      socket.off('bg:exited', onPartnerExitedbackground);
    };
  }, []);

  // УДАЛЕНО: peer:left - не нужен для 1-на-1 (используется call:ended)

  // --------------------------
  // Unmount cleanup
  // --------------------------
  useEffect(() => {
    return () => {
      // Если это звонок с другом и PiP активен (или вообще есть активный callId/roomId) — НИЧЕГО НЕ РВЁМ
      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
      const hasActiveCallId = !!currentCallIdRef.current;
      const hasActiveRoomId = !!roomIdRef.current;
      const hasActivePC = !!peerRef.current;
      const hasActivePartner = !!partnerIdRef.current || !!partnerUserIdRef.current;
      
      // КРИТИЧНО: Для дружеских звонков проверяем не только roomId, но и наличие PC или callId
      // Это важно во время установки соединения, когда roomId еще может быть null, но PC уже создан
      const hasActiveCall = hasActiveRoomId || hasActiveCallId || (hasActivePC && hasActivePartner);
      const keepAliveForPiP = (isFriendCall && hasActiveCall) || pip.visible;

      if (keepAliveForPiP) {
        // Не останавливаем спикер, не закрываем PC, не стопим треки
        return;
      }

      // КРИТИЧНО: Для рандомного чата отправляем stop и room:leave при unmount
      const isRandomChat = !isFriendCall && (roomIdRef.current || partnerIdRef.current || startedRef.current);
      if (isRandomChat) {
        try {
          const currentRoomId = roomIdRef.current;
          if (currentRoomId) {
            socket.emit('room:leave', { roomId: currentRoomId });
          }
        } catch (e) {
          console.warn('[Unmount cleanup] Error sending room:leave for random chat:', e);
        }
        
        try {
          socket.emit('stop');
        } catch (e) {
          console.warn('[Unmount cleanup] Error sending stop for random chat:', e);
        }
      }
      
      // КРИТИЧНО: Очищаем глобальные ссылки на функции
      try {
        if ((global as any).__endCallCleanupRef) {
          (global as any).__endCallCleanupRef.current = null;
        }
        if ((global as any).__toggleMicRef) {
          (global as any).__toggleMicRef.current = null;
        }
        if ((global as any).__toggleRemoteAudioRef) {
          (global as any).__toggleRemoteAudioRef.current = null;
        }
      } catch (e) {
        console.warn('[Unmount cleanup] Error clearing global references:', e);
      }
      
      stopMicMeter();

      try {
        const pc = peerRef.current;
        if (pc) cleanupPeer(pc);
      } catch {}
      peerRef.current = null;

      try { stopLocalStream(); } catch {}
      try { setCamOn(false); } catch {}
      try { setTimeout(() => { mediaDevices.enumerateDevices?.(); }, 0); } catch {}
      try { stopSpeaker(); } catch {}
    };
  }, [cleanupPeer, stopMicMeter, stopLocalStream, pip.visible, isDirectCall]);

  // --------------------------
  // Friends actions
  // --------------------------
  const onAddFriend = useCallback(async () => {
    if (addPending) return;
    setAddPending(true);
    try {
      const res: any = await requestFriend(partnerUserId!);
      if (res?.status === 'pending') {
        showToast('Заявка отправлена');
        try { lastFriendRequestToRef.current = String(partnerUserId || ''); } catch {}
      } else if (res?.status === 'already') {
        setAddPending(false);
        setAddBlocked(true);
        try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
        showToast('Вы уже друзья');
      } else if (res?.ok === false) {
        setAddPending(false);
        showToast(res?.error || 'Не удалось отправить заявку');
      }
    } catch {
      setAddPending(false);
      showToast('Ошибка отправки заявки');
    }
  }, [addPending, partnerUserId, showToast]);

  // УДАЛЕНО: onAddFriendSecond - больше не нужен для 1-на-1

  const acceptFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try { await respondFriend(incomingFriendFrom, true); }
    finally {
      setFriendModalVisible(false);
      setIncomingFriendFrom(null);
      try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
    }
  }, [incomingFriendFrom]);

  const declineFriend = useCallback(async () => {
    if (!incomingFriendFrom) return;
    try { await respondFriend?.(incomingFriendFrom, false); }
    finally { setFriendModalVisible(false); setIncomingFriendFrom(null); }
  }, [incomingFriendFrom]);

  // ===== RENDER =====
  const { width, height } = Dimensions.get("screen");

  return (
    <PanGestureHandler
      onGestureEvent={(event) => {
        // 3.4. Жест «скип» (iOS back swipe) — однократный вызов с троттлингом
        if (swipeHandledRef.current) return;
        
        const { translationX, translationY, velocityX, velocityY } = event.nativeEvent;
        
        // Обнаруживаем только свайп вправо (слева направо) для навигации назад
        const isSwipeRight = translationX > 100 && Math.abs(velocityX) > 500;
        
        if (isSwipeRight) {
          swipeHandledRef.current = true;
          
          // Проверяем: есть ли активный звонок друга?
          const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
          const hasActiveCall = !!roomIdRef.current && !isInactiveStateRef.current;
          
          // КРИТИЧНО: Если находимся в неактивном состоянии (завершенный звонок),
          // просто навигируем назад без показа PiP и без каких-либо действий
          if (isInactiveStateRef.current) {
            console.log('[PanGestureHandler] In inactive state, just navigating back');
            setTimeout(() => {
              if (navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('Home' as never);
              }
            }, 0);
            // Сбрасываем флаг через небольшую задержку
            setTimeout(() => {
              swipeHandledRef.current = false;
            }, 500);
            return;
          }
          
          // Если есть активный звонок друга - показываем PiP перед навигацией
          if (isFriendCall && hasActiveCall) {
            // Выключаем видео локально для экономии
            try {
              const stream = localStream || localStreamRef.current;
              stream?.getVideoTracks()?.forEach((t: any) => { t.enabled = false; });
            } catch (e) {
              console.warn('[PanGestureHandler] Error disabling local video:', e);
            }

            // Ищем партнера в списке друзей
            const partner = partnerUserId 
              ? friends.find(f => String(f._id) === String(partnerUserId))
              : null;
            
            // Строим полный URL аватара из поля avatar (проверяем что не пустая строка)
            let partnerAvatarUrl: string | undefined = undefined;
            if (partner?.avatar && typeof partner.avatar === 'string' && partner.avatar.trim() !== '') {
              const SERVER_CONFIG = require('../src/config/server').SERVER_CONFIG;
              const serverUrl = SERVER_CONFIG.BASE_URL;
              partnerAvatarUrl = partner.avatar.startsWith('http') 
                ? partner.avatar 
                : `${serverUrl}${partner.avatar.startsWith('/') ? '' : '/'}${partner.avatar}`;
            }
            
            // КРИТИЧНО: Сохраняем partnerUserId в navParams для восстановления при возврате
            pip.showPiP({
              callId: currentCallIdRef.current || '',
              roomId: roomIdRef.current || '',
              partnerName: partner?.nick || 'Друг',
              partnerAvatarUrl: partnerAvatarUrl,
              muteLocal: !micOn,
              muteRemote: remoteMutedMain,
              localStream: localStream || localStreamRef.current || null,
              remoteStream: remoteStream || remoteStreamRef.current || null,
              navParams: {
                ...route?.params,
                peerUserId: partnerUserId || partnerUserIdRef.current,
                partnerId: partnerId || partnerIdRef.current, // КРИТИЧНО: Сохраняем partnerId для восстановления соединения
              } as any,
            });
            
            // Отправляем партнеру что мы ушли в PiP
            const isFriendCallActive = isDirectCall || inDirectCall || friendCallAccepted;
            if (isFriendCallActive && roomIdRef.current) {
              try {
                socket.emit('pip:state', { 
                  inPiP: true, 
                  roomId: roomIdRef.current,
                  from: socket.id 
                });
              } catch (e) {
                console.warn('[PanGestureHandler] ❌ Error sending pip:state:', e);
              }
            }
          }
          
          // Навигируем назад (для активного звонка или просто возврата)
          setTimeout(() => {
            if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Home' as never);
            }
          }, hasActiveCall && isFriendCall ? 100 : 0);
          
          // Сбрасываем флаг через небольшую задержку
          setTimeout(() => {
            swipeHandledRef.current = false;
          }, 500);
        }
      }}
      onHandlerStateChange={(event) => {
        const { state } = event.nativeEvent;
        if (state === 5) { // END state
          // Жест завершен
        }
      }}
    >
      <SafeAreaView
        style={[
          [styles.container, { backgroundColor: isDark ? '#151F33' : (theme.colors.background as string) }],
          Platform.OS === "android"
            ? {
                paddingTop: Math.max(0, insets.top - 25),
              paddingBottom: insets.bottom + 10,
              paddingLeft: insets.left + 6,
              paddingRight: insets.right + 6,
            }
          : {
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              paddingLeft: insets.left,
              paddingRight: insets.right,
            },
      ]}
      edges={['top','bottom','left','right']}
    >
      {/* ───── Карточка «Собеседник» ───── */}
      <View style={styles.card}>
        {/* Модалка входящего звонка друга - показывается в любом состоянии (даже когда поиск не начат) */}
        {(() => {
          // КРИТИЧНО: Убираем условие !remoteStream - модалка должна показываться даже если есть remoteStream
          // из предыдущего звонка (например, в неактивном состоянии после завершенного звонка)
          // Исключение: не показываем если уже принят этот конкретный звонок (friendCallAccepted)
          // или если есть активный remoteStream от того же пользователя (проверяем по partnerUserId)
          // КРИТИЧНО: В неактивном состоянии remoteStream не считается активным, даже если существует
          const hasActiveRemoteStream = !isInactiveState && !!remoteStream && !!partnerUserId && 
            incomingFriendCall && 
            String(partnerUserId) === String(incomingFriendCall.from);
          const shouldShow = incomingOverlay && incomingFriendCall && !friendCallAccepted && !hasActiveRemoteStream;
          if (incomingFriendCall || incomingOverlay) {
            console.log('[Modal render check] Conditions:', {
              incomingOverlay,
              hasIncomingFriendCall: !!incomingFriendCall,
              friendCallAccepted,
              hasRemoteStream: !!remoteStream,
              hasActiveRemoteStream,
              isInactiveState,
              partnerUserId,
              incomingFrom: incomingFriendCall?.from,
              shouldShow,
              started: startedRef.current,
              partnerId: partnerIdRef.current,
              isDirectCall
            });
          }
          return shouldShow;
        })() ? (
          <View style={{ position: 'absolute', inset: 0, zIndex: 1000 }}>
            <BlurView intensity={60} tint={isDark ? 'dark' : 'light'} style={StyleSheet.absoluteFill} />
            <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ alignItems: 'center' }}>
                <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                  <Animated.View style={waveS(waveA, 'left')} />
                  <Animated.View style={waveS(waveB, 'right')} />
                  <Animated.View style={callIconStyle}>
                    <MaterialIcons name="call" size={48} color="#4FC3F7" />
                  </Animated.View>
                </View>
                <Text style={{ color: '#fff', fontWeight: '700', marginTop: 10 }}>Входящий вызов</Text>
                <Text style={{ color: '#e5e7eb', marginTop: 4 }}>
                  {incomingFriendCall?.nick || `id: ${String(incomingFriendCall?.from || '').slice(0, 5)}`}
                </Text>
                <View style={{ flexDirection: 'row', gap: 14, marginTop: 14, width: '100%', paddingHorizontal: 28, justifyContent: 'center', paddingBottom: 40 }}>
                  <TouchableOpacity
                    onPress={async () => {
                      console.log('[Accept Call] Accepting call, callId:', incomingCall?.callId);
                      
                      // Сбрасываем блокировку (если была) — это новый явный приём вызова
                      try { clearDeclinedBlock(); } catch {}
                      
                      // КРИТИЧНО: Используем callId из incomingCall или roomId из ref
                      const finalCallId = incomingCall?.callId || currentCallIdRef.current || roomIdRef.current;
                      if (finalCallId) {
                        currentCallIdRef.current = finalCallId;
                        roomIdRef.current = finalCallId; // КРИТИЧНО: Устанавливаем roomId для приватной комнаты
                        console.log('[Accept Call] Set currentCallIdRef to:', currentCallIdRef.current);
                        console.log('[Accept Call] Set roomId to:', roomIdRef.current);
                      }
                      
                      // СНАЧАЛА устанавливаем флаги режима друзей
                      setFriendCallAccepted(true);
                      setInDirectCall(true);
                      
                      // КРИТИЧНО: Устанавливаем partnerUserId из входящего звонка
                      if (incomingFriendCall?.from) {
                        setPartnerUserId(incomingFriendCall.from);
                        partnerUserIdRef.current = incomingFriendCall.from;
                        console.log('[Accept Call] Set partnerUserId:', incomingFriendCall.from);
                      }
                      
                      // КРИТИЧНО: Сначала сбрасываем входящий звонок и закрываем модалку
                      setIncomingOverlay(false);
                      setIncomingFriendCall(null);
                      setIncomingCall(null);
                      stopIncomingAnim();
                      
                      // КРИТИЧНО: Очищаем старый PeerConnection если он существует
                      // Это важно при принятии звонка в неактивном состоянии, когда может остаться старый PC
                      const oldPc = peerRef.current;
                      if (oldPc) {
                        console.log('[Accept Call] Cleaning up old PeerConnection before accepting new call');
                        try {
                          // КРИТИЧНО: Сначала удаляем все треки из старого PC
                          const oldSenders = oldPc.getSenders() || [];
                          const removePromises = oldSenders.map(async (sender: any) => {
                            try {
                              const track = sender.track;
                              if (track) {
                                track.enabled = false;
                              }
                              await sender.replaceTrack(null);
                            } catch (e) {
                              console.warn('[Accept Call] Error removing track from old PC:', e);
                            }
                          });
                          await Promise.all(removePromises);
                          // Затем закрываем PC
                          cleanupPeer(oldPc);
                          console.log('[Accept Call] Old PeerConnection cleaned up successfully');
                        } catch (e) {
                          console.warn('[Accept Call] Error cleaning up old PC:', e);
                        }
                        peerRef.current = null;
                      }
                      
                      // КРИТИЧНО: Очищаем remote stream от предыдущего звонка если он существует
                      // Это важно при принятии нового звонка в неактивном состоянии
                      if (remoteStream || remoteStreamRef.current) {
                        console.log('[Accept Call] Clearing old remote stream');
                        try {
                          const oldRemoteStream = remoteStreamRef.current || remoteStream;
                          if (oldRemoteStream) {
                            const tracks = oldRemoteStream.getTracks() || [];
                            tracks.forEach((t: any) => {
                              try { t.stop(); } catch {}
                            });
                          }
                        } catch (e) {
                          console.warn('[Accept Call] Error clearing old remote stream:', e);
                        }
                        setRemoteStream(null);
                        remoteStreamRef.current = null;
                        setRemoteCamOn(false);
                        setPartnerInPiP(false);
                      }
                      
                      // КРИТИЧНО: Выходим из неактивного состояния ПЕРЕД установкой флагов активного звонка
                      // КРИТИЧНО: Устанавливаем флаг принятия звонка СРАЗУ, чтобы избежать race condition
                      setFriendCallAccepted(true);
                      setIsInactiveState(false);
                      setWasFriendCallEnded(false); // Сбрасываем флаг завершенного звонка
                      
                      // КРИТИЧНО: Даем время для обновления state перед созданием стрима
                      await new Promise(resolve => setTimeout(resolve, 50));
                      
                      // КРИТИЧНО: Устанавливаем started для создания PeerConnection
                      setStarted(true);
                      setLoading(true);
                      setCamOn(true); // КРИТИЧНО: Включаем камеру сразу при принятии вызова
                      setMicOn(true); // КРИТИЧНО: Включаем микрофон сразу при принятии вызова
                      setPcConnected(false); // Сбрасываем состояние соединения чтобы оно обновилось при установке
                      console.log('[Accept Call] Set started=true, loading=true, camOn=true, micOn=true, isInactiveState=false, friendCallAccepted=true');
                      
                      // Сбрасываем loading через небольшую задержку, чтобы дать время на установку соединения
                      setTimeout(() => {
                        setLoading(false);
                        console.log('[Accept Call] Reset loading to false after timeout');
                      }, 2000);
                      
                      // Принимаем вызов с callId или без него (для звонков друзей callId может прийти позже)
                      try { 
                        if (finalCallId) {
                          acceptCall(finalCallId);
                        }
                      } catch {}
                      
                      // КРИТИЧНО: Уведомляем друзей что мы заняты
                      try {
                        socket.emit('presence:update', { status: 'busy', roomId: roomIdRef.current });
                        console.log('[Accept Call] Sent presence:update busy for roomId:', roomIdRef.current);
                      } catch (e) {
                        console.error('[Accept Call] Failed to send presence update:', e);
                      }
                      
                      // КРИТИЧНО: Отправляем состояние камеры после принятия вызова
                      setTimeout(() => {
                        try {
                          sendCameraState();
                          console.log('[Accept Call] Sent camera state after accepting call');
                        } catch (e) {
                          console.error('[Accept Call] Failed to send camera state:', e);
                        }
                      }, 100);
                      
                      // КРИТИЧНО: Гарантируем локальный поток для ответа
                      // PeerConnection будет создан в handleMatchFound когда придет событие match_found
                      // Это важно чтобы partnerId был установлен правильно перед созданием PC
                      // КРИТИЧНО: К этому моменту friendCallAccepted уже установлен в true выше, 
                      // поэтому ensureStreamReady сможет создать стрим даже если был в неактивном состоянии
                      try { 
                        const stream = await ensureStreamReady();
                        if (stream) {
                          localStreamRef.current = stream;
                          // КРИТИЧНО: Убеждаемся что камера включена (camOn уже установлен выше)
                          const videoTrack = stream.getVideoTracks()?.[0];
                          if (videoTrack) {
                            if (!videoTrack.enabled) {
                              videoTrack.enabled = true;
                              console.log('[Accept Call] Enabled video track after ensureStreamReady');
                            }
                            // КРИТИЧНО: Убеждаемся что camOn установлен в true
                            setCamOn(true);
                          }
                        console.log('[Accept Call] Got local stream:', stream?.id);
                          console.log('[Accept Call] Stream ready, waiting for match_found event to create PC with correct partnerId');
                        }
                      } catch (e) {
                        console.error('[Accept Call] Failed to get local stream:', e);
                      }
                      
                      // Сбросим счётчик пропущенных для этого друга
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
                      
                      // Закрываем оверлей после небольшой задержки для обновления UI
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
                      // Отклоняем вызов с callId или без него
                      try { 
                        const callIdToDecline = incomingCall?.callId || currentCallIdRef.current || roomIdRef.current;
                        if (callIdToDecline) {
                          declineCall(callIdToDecline);
                        }
                      } catch {}
                      // Блокируем повторное автоподключение к этому пользователю на короткое время
                      try { setDeclinedBlock(incomingCall?.from || incomingFriendCall?.from, 12000); } catch {}
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
        ) : (
          // ВСЕГДА показываем блок с видео/заглушкой (не текст "Собеседник")
          <>
            {(() => {
              // КРИТИЧНО: В неактивном состоянии ВСЕГДА показываем только текст "Собеседник", независимо от наличия remoteStream
                if (isInactiveState) {
                  return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
              
              // Если нет соединения (нет потока), показываем лоадер при поиске или текст "Собеседник"
              if (!remoteStream) {
                if (loading && started) {
                  // Если поиск активен или звонок принят, показываем лоадер
                  return <ActivityIndicator size="large" color="#fff" />;
                } else {
                  // Если поиск не активен, показываем текст "Собеседник"
                  return <Text style={styles.placeholder}>{L("peer")}</Text>;
                }
              }
              
              // Проверяем состояние удалённого видео
              const remoteVideoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
              const partnerInPiPState = partnerInPiP && !pip.visible;
              
              // КРИТИЧНО: Если партнёр в PiP - всегда показываем черный экран (не застывший кадр)
              if (partnerInPiPState) {
                return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
              }
              
              // КРИТИЧНО: Если камера выключена - всегда показываем заглушку "Отошёл", даже если трек жив
              // Это нужно чтобы при выключении камеры у друга сразу появлялась заглушка
              if (!remoteCamOn) {
                return <AwayPlaceholder />;
              }
              
              // Если камера включена и есть видеотрек - показываем видео
              if (remoteVideoTrack && remoteVideoTrack.readyState === 'live') {
                if (remoteStream && isValidStream(remoteStream)) {
                  return (
                    <RTCView
                      key={`remote-video-${remoteViewKey}-${remoteStream.id}`}
                      streamURL={remoteStream.toURL()}
                      style={styles.rtc}
                      objectFit="cover"
                    />
                  );
                }
                // Если стрим невалидный - чёрный фон
                return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
              }
              
              // Если нет видеотрека - показываем заглушку "Отошёл"
              if (!remoteVideoTrack) {
                return <AwayPlaceholder />;
              }
              
              // В остальных случаях - чёрный фон
              return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
            })()}

            {/* Иконка звука */}
                {/* КРИТИЧНО: Показываем кнопки только если started=true И НЕ в неактивном состоянии И partnerUserId существует */}
                {started && !isInactiveState && !!partnerUserId && (() => {
                  const remoteBlockedByPiP = partnerInPiP && !pip.visible;
                  return (
                    <TouchableOpacity
                      onPress={toggleRemoteAudio}
                      disabled={!remoteStream || remoteBlockedByPiP}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.7}
                      style={[
                        styles.iconBtn,
                        remoteBlockedByPiP && styles.iconBtnDisabled,
                        {
                          position: "absolute",
                          top: 8,
                          left: 8,
                          opacity: remoteStream ? 1 : 0.5,
                        },
                      ]}
                    >
                      <MaterialIcons
                        name={remoteMutedMain ? "volume-off" : "volume-up"}
                        size={26}
                        color={remoteStream ? "#fff" : "#777"}
                      />
                    </TouchableOpacity>
                  );
                })()}

            {/* Кнопка «Добавить в друзья» */}
                {/* КРИТИЧНО: Показываем кнопки только если started=true И НЕ в неактивном состоянии */}
                {started && !isInactiveState && !!partnerUserId && !isPartnerFriend && (
                  <TouchableOpacity
                    onPress={onAddFriend}
                    disabled={addPending || addBlocked}
                    style={[
                      styles.iconBtn,
                      {
                        position: "absolute",
                        top: 8,
                        right: 8,
                        opacity: addPending || addBlocked ? 0.5 : 1,
                      },
                    ]}
                  >
                    <MaterialIcons
                      name={addBlocked ? "person-add-disabled" : "person-add"}
                      size={26}
                      color="#fff"
                    />
                  </TouchableOpacity>
                )}

            {/* Бейдж «Друг» */}
                {/* КРИТИЧНО: Показываем бэйдж только если НЕ в неактивном состоянии */}
                {!isInactiveState && showFriendBadge && (
                  <View
                    style={[
                      styles.friendBadge,
                      { position: "absolute", top: 8, right: 8 },
                    ]}
                  >
                    <MaterialIcons name="check-circle" size={16} color="#0f0" />
                    <Text style={styles.friendBadgeText}>{L("friend")}</Text>
                  </View>
                )}
          </>
        )}

        {/* УДАЛЕНО: дублирующие элементы UI уже в основном render выше */}
      </View>
      {/* Эквалайзер */}
      <View style={styles.eqWrapper}>
        <VoiceEqualizer
                  level={(() => {
                    const hasActiveCall = pcConnected || (!!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current);
                    const micReallyOn = isMicReallyOn();
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
      {/* Карточка «Вы» */}
      <View style={styles.card}>
        {(() => {
          // КРИТИЧНО: Если камера выключена - всегда показываем заглушку "Вы", даже если стрим существует
          // Это нужно чтобы при выключении камеры сразу появлялась заглушка вместо последнего кадра
          if (!camOn) {
            return <Text style={styles.placeholder}>{L("you")}</Text>;
          }
          
          // При возврате из background показываем видео если есть поток, независимо от camOn
          const isReturnFrombackground = route?.params?.returnToActiveCall;
          // КРИТИЧНО: Для звонков друзей показываем локальное видео если камера включена и есть поток
          // Для рандомного чата показываем видео если есть стрим и started=true
          const shouldShowLocalVideo = !isInactiveState && camOn && (
            (inDirectCall && localStream) || // Показываем видео при звонке друзей если камера включена
            (localStream && started) || // Для рандомного чата показываем если started=true (стрим активен)
            (isReturnFrombackground && (localStream || localRender))
          );
          
          if (shouldShowLocalVideo) {
            // КРИТИЧНО: Возвращаемся к оригинальному RTCView
            if (localRender) {
              return (
                <RTCView
                  key={`local-video-${localRenderKey}`}
                  streamURL={localRender.toURL()}
                  style={styles.rtc}
                  objectFit="cover"
                  mirror
                />
              );
            } else if (localStream && isValidStream(localStream)) {
              // КРИТИЧНО: Возвращаемся к оригинальному методу toURL()
              // Убрали постоянный лог для уменьшения шума
              return (
                <RTCView
                  key={`local-video-${localRenderKey}`}
                  streamURL={localStream.toURL()}
                  style={styles.rtc}
                  objectFit="cover"
                  mirror
                />
              );
            } else {
              return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
            }
          } else {
            return <Text style={styles.placeholder}>{L("you")}</Text>;
          }
        })()}

        {/* КРИТИЧНО: Кнопки показываются только если started=true И НЕ в неактивном состоянии */}
        {started && !isInactiveState && (
          <View style={styles.topLeft}>
            <TouchableOpacity
              onPress={flipCam}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              activeOpacity={0.7}
              style={styles.iconBtn}
            >
              <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
            </TouchableOpacity>
          </View>
        )}

        {/* КРИТИЧНО: Кнопки показываются только если started=true И НЕ в неактивном состоянии */}
        {started && !isInactiveState && (
          <View style={styles.bottomOverlay}>
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
          </View>
        )}
      </View>
      {/* Кнопки снизу */}
      <View style={styles.bottomRow}>
        {/** Прервать только для звонков с другом */}
        {showAbort ? (
          // Во время звонка всегда одна кнопка «Прервать»
          (<TouchableOpacity
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
            <Text style={styles.bigBtnText}>Прервать</Text>
            <MaterialIcons name="call-end" size={18} color="#fff" />
          </TouchableOpacity>)
        ) : (
          // Стандартные кнопки «Начать / Далее» вне звонка
          (<>
            <TouchableOpacity
              style={[styles.bigBtn, started ? styles.btnDanger : styles.btnTitan]}
              onPress={onStartStop}
            >
              <Text style={styles.bigBtnText}>
                {started ? L("stop") : L("start")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.bigBtn, styles.btnTitan, (!started || isNexting) && styles.disabled]}
              disabled={!started || isNexting}
              onPress={onNext}
            >
              <Text style={styles.bigBtnText}>
                {L("next")}
              </Text>
            </TouchableOpacity>
          </>)
        )}
      </View>
      {/* Модалка заявки в друзья */}
      <Modal
        visible={friendModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setFriendModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{L("friend_request")}</Text>
            <Text style={styles.modalText}>
              {L("friend_request_text", { user: formatUserDisplay(incomingFriendFrom) })}
            </Text>
            <View style={{ flexDirection: "row", gap: 12, marginTop: 16 }}>
              <TouchableOpacity
                style={[styles.btnGlassBase, styles.btnGlassDanger]}
                onPress={declineFriend}
              >
                <Text style={styles.modalBtnText}>{L("decline")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnGlassBase, styles.btnGlassTitan]}
                onPress={acceptFriend}
              >
                <Text style={styles.modalBtnText}>{L("accept")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {toastVisible && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]}>
          <Text style={styles.toastText}>{toastText}</Text>
        </Animated.View>
      )}
      
      {/* PiP компонент */}
    </SafeAreaView>
    </PanGestureHandler>
  );
  

  
};

const CARD_BASE = {
  backgroundColor: 'rgba(13,14,16,0.85)',
  borderRadius: 10,
  justifyContent: 'center' as const,
  alignItems: 'center' as const,
  overflow: 'hidden' as const,
  marginVertical: 7,
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#151F33",
    alignItems: "center",
    justifyContent: "center",
    ...(Platform.OS === "android" ? { paddingTop: 0 } : {}),
  },

  card: {
    ...CARD_BASE,
    width: Platform.OS === "android" ? '97%' : '94%', // 🔹 шире на Android
    ...((Platform.OS === "ios" ? { height: screenHeight * 0.4 } : { height: screenHeight * 0.42 }) // 🔹 чуть выше блоки на Android
    ),
  },

  eqWrapper: {
    width: "100%", 
    alignItems: "center",      // по центру горизонтально
    justifyContent: "center",  // по центру вертикально
    
  },

  rtc: { 
    position: 'absolute', 
    top: 0, left: 0, right: 0, bottom: 0, 
    backgroundColor: 'black' 
  },
  placeholder: { 
    color: 'rgba(237,234,234,0.6)', 
    fontSize: 22 
  },
  // incoming friend call UI
  incomingFriendBlock: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(13,14,16,0.85)'
  },
  incomingTitle: { color: '#fff', fontSize: 18, fontWeight: '800', marginBottom: 8 },
  incomingName: { color: '#e5e7eb', fontSize: 16, fontWeight: '600', marginBottom: 12 },
  incomingButtons: { flexDirection: 'row', gap: 12 },
  acceptBtn: { backgroundColor: '#8a8f99', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  rejectBtn: { backgroundColor: '#ff4d4d', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  acceptText: { color: '#333', fontWeight: '700' },
  rejectText: { color: '#333', fontWeight: '700' },

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

  topLeft: { position: 'absolute', top: 10, left: 10 },
  bottomOverlay: { 
    position: 'absolute', 
    bottom: 10, left: 10, right: 10, 
    flexDirection: 'row', 
    justifyContent: 'space-between' 
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
    fontWeight: '600' 
  },

  bottomRow: { 
    width: Platform.OS === "android" ? '96%' : '93%', // 🔹 шире на Android
    flexDirection: 'row', 
    gap: 16, 
    marginTop: 10, 
    marginBottom: 18,
  },
  bigBtn: { 
    flex: 1, 
    height: 55, 
    borderRadius: 10, 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  bigBtnText: { 
    color: '#333333', 
    fontSize: 16, 
    fontWeight: '600' 
  },
  modalBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700'
  },
  btnTranslucent: { opacity: 0.8 },
  btnTitan: { backgroundColor: '#8a8f99' },
  btnDanger: { backgroundColor: '#ff4d4d' },
  disabled: { opacity: 1 },

  // modal
  modalOverlay: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.5)', 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  modalCard: { 
    width: '86%', 
    backgroundColor: '#1f2937', 
    padding: 16, 
    borderRadius: 12 
  },
  // Glass buttons for modal
  btnGlassBase: {
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    height: 48,
    flex: 1,
  },
  btnGlassDanger: {
    // красная стеклянная
    backgroundColor: 'rgba(255,77,77,0.16)',
    borderColor: 'rgba(255,77,77,0.65)'
  },
  btnGlassSuccess: {
    // зелёная стеклянная
    backgroundColor: 'rgba(46, 204, 113, 0.16)',
    borderColor: 'rgba(46, 204, 113, 0.65)'
  },
  btnGlassTitan: {
    // титановая стеклянная
    backgroundColor: 'rgba(138,143,153,0.16)',
    borderColor: 'rgba(138,143,153,0.65)'
  },
  modalTitle: { 
    color: '#fff', 
    fontSize: 18, 
    fontWeight: '700' 
  },
  modalText: { 
    color: '#e5e7eb', 
    marginTop: 8 
  },

  // friend badge
  friendBadge: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    backgroundColor: 'rgba(0, 255, 0, 0.23)', 
    paddingHorizontal: 8, 
    paddingVertical: 4, 
    borderRadius: 12, 
    borderWidth: 1, 
    borderColor: '#0f0' 
  },
  friendBadgeText: { 
    color: '#0f0', 
    fontSize: 12, 
    fontWeight: '600', 
    marginLeft: 4 
  },
  // eqWrapper (absolute) removed
  // === Грид «Собеседник» ===
  gridOne: { position: 'absolute', inset: 0 },
  gridTwo: { position: 'absolute', inset: 0, flexDirection: 'row' },
  gridThree: { position: 'absolute', inset: 0 },
  gridFour: { position: 'absolute', inset: 0, justifyContent: 'space-between' },
  row: { height: '50%' },
  rowSplit: { flexDirection: 'row', height: '50%' },
  col: { flex: 1 },
  peerCard: {
    flex: 1,
    margin: 2,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'black',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)'
  },
});

// --------------------------
// Main VideoChat Component (с PiP Provider)
// --------------------------
const VideoChat: React.FC<Props> = ({ route }) => {
  // Создаем refs для передачи функций из VideoChatContent
  const returnToCallRef = useRef<(() => void) | null>(null);
  const endCallRef = useRef<(() => void) | null>(null);
  const toggleMicRef = useRef<(() => void) | null>(null);
  const toggleRemoteAudioRef = useRef<(() => void) | null>(null);

  return (
    <VideoChatContent 
      route={route} 
      onRegisterCallbacks={(callbacks) => {
        returnToCallRef.current = callbacks.returnToCall;
        endCallRef.current = callbacks.endCall;
        toggleMicRef.current = callbacks.toggleMic;
        toggleRemoteAudioRef.current = callbacks.toggleRemoteAudio;
      }}
    />
  );
};

export default VideoChat;