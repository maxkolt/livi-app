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
import { useNavigation, useFocusEffect } from '@react-navigation/native';

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
import { getIceConfiguration, getEnvFallbackConfiguration } from '../utils/iceConfig';
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
import { activateKeepAwakeAsync, deactivateKeepAwakeAsync } from '../utils/keepAwake';
import { isValidStream, cleanupStream } from '../utils/streamUtils';

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
  getMyProfile,
  onCallIncoming,
  acceptCall,
  declineCall,
} from '../sockets/socket';
import { onCallCanceled } from '../sockets/socket';

// --------------------------
// Globals / setup
// --------------------------

// Статическая конфигурация ICE_SERVERS удалена - теперь используется динамическая загрузка через getIceConfiguration()

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
      
      // Загружаем ICE конфигурацию с бэкенда
      try {
        const iceConfig = await getIceConfiguration();
        iceConfigRef.current = iceConfig;
        logger.debug('ICE configuration loaded', { 
          hasIceServers: !!iceConfig.iceServers,
          iceServersCount: iceConfig.iceServers?.length || 0
        });
      } catch (e) {
        logger.warn('Failed to load ICE configuration, using fallback:', e);
        // Используем fallback конфигурацию
        const fallbackConfig = await getIceConfiguration(true);
        iceConfigRef.current = fallbackConfig;
      }
    })();
  }, []);

  // Guard от повторных вызовов
  const focusEffectGuardRef = useRef(false);
  const fromPiPProcessedRef = useRef(false);
  // Запоминаем состояние локальной камеры перед входом в PiP,
  // чтобы корректно восстановить его после возврата
  const pipPrevCamOnRef = useRef<boolean | null>(null);
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
    if (focusEffectGuardRef.current) return;

    // Вернулись из PiP -> прячем PiP, включаем свои видео/спикер, стартуем VAD
    const isReturningFromPiP = route?.params?.resume && route?.params?.fromPiP && !fromPiPProcessedRef.current;
    
    if (isReturningFromPiP) {
      fromPiPProcessedRef.current = true;
      focusEffectGuardRef.current = true;

      // Прячем PiP только при возврате из PiP
      if (pipRef.current.visible) {
        pipRef.current.hidePiP();
        
        // Получаем roomId из route.params или ref
        const routeRoomId = (route?.params as any)?.roomId;
        const currentRoomId = roomIdRef.current || routeRoomId;
        
        // Отправляем партнеру что мы вернулись из PiP
        const isFriendCallActive = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        
        if (isFriendCallActive && currentRoomId) {
          try {
            const payload: any = { 
              inPiP: false, 
              from: socket.id,
              roomId: currentRoomId
            };
            if (partnerIdRef.current) payload.to = partnerIdRef.current;
            socket.emit('pip:state', payload);
            setTimeout(() => {
              try { socket.emit('pip:state', payload); } catch {}
            }, 300);
          } catch (e) {
            logger.warn('[useFocusEffect] Error sending pip:state:', e);
          }
        }
      }

      // Если у нас есть удалённый поток из PiP-контекста — подставим его в state
      if (!remoteStreamRef.current && pipRef.current.remoteStream) {
        setRemoteStream(pipRef.current.remoteStream);
        remoteStreamRef.current = pipRef.current.remoteStream as any;
      }
      
      // Включаем локальные и удалённые видео-треки при возврате на экран
      try {
        const lt = (localStream || localStreamRef.current)?.getVideoTracks?.()?.[0];
        if (lt) {
          const shouldEnableAfterPip = (pipPrevCamOnRef.current !== false) && camUserPreferenceRef.current !== false;
          if (shouldEnableAfterPip) {
            if (!lt.enabled) lt.enabled = true;
            setCamOn(true);
            try {
              const currentRoomId = roomIdRef.current;
              const payload: any = { enabled: true, from: socket.id };
              if (currentRoomId) payload.roomId = currentRoomId;
              socket.emit('cam-toggle', payload);
            } catch {}
          } else {
            if (lt.enabled) lt.enabled = false;
            setCamOn(false);
          }
          pipPrevCamOnRef.current = null;
        }
        
        const remoteStreamFromRef = remoteStreamRef.current;
        if (remoteStreamFromRef && !remoteStream) {
          setRemoteStream(remoteStreamFromRef);
        }
        
        const rt = (remoteStream || remoteStreamRef.current)?.getVideoTracks?.()?.[0];
        if (rt) {
          const wasCameraEnabled = rt.enabled;
          if (!rt.enabled) rt.enabled = true;
          
          if (wasCameraEnabled) {
            setRemoteCamOn(true);
            remoteCamOnRef.current = true;
            requestAnimationFrame(() => {
              if (!pipReturnUpdateRef.current) {
                pipReturnUpdateRef.current = true;
                setRemoteViewKey(Date.now());
                setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
              }
            });
          } else {
            requestAnimationFrame(() => {
              const currentVideoTrack = (remoteStream || remoteStreamRef.current)?.getVideoTracks?.()?.[0];
              const isCurrentlyEnabled = currentVideoTrack?.enabled === true;
              
              if (isCurrentlyEnabled) {
                setRemoteCamOn(true);
                remoteCamOnRef.current = true;
              } else if (canAutoShowRemote() && remoteCamOnRef.current !== false) {
                setRemoteCamOn(true);
              } else if (remoteCamOnRef.current) {
                setRemoteCamOn(true);
              } else {
                setRemoteCamOn(false);
                remoteCamOnRef.current = false;
              }
              
              if (!pipReturnUpdateRef.current) {
                pipReturnUpdateRef.current = true;
                setRemoteViewKey(Date.now());
                setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
              }
            });
          }
        }
      } catch (e) {
        logger.warn('[useFocusEffect] Error enabling video tracks:', e);
      }
      
      // Снимаем локальную заглушку без ожидания события от партнёра
      setPartnerInPiP(false);

      // ВАЖНО: Перезапускаем метр микрофона после возврата из PiP
      // Звук продолжает работать в PiP, поэтому эквалайзер должен сразу восстановиться
      try {
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        const isFriendCallActive = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        const stream = localStream || localStreamRef.current;
        const remoteStreamForCheck = remoteStream || remoteStreamRef.current || pipRef.current.remoteStream;
        
        if (isFriendCallActive && hasActiveCall) {
          if (stream && (remoteStreamForCheck || peerRef.current)) {
            try {
              startMicMeter();
            } catch (e) {
              logger.warn('[useFocusEffect] Error restarting mic meter:', e);
            }
          }
        }
      } catch (e) {
        logger.warn('[useFocusEffect] Error in mic meter restart logic:', e);
      }

      try {
        forceSpeakerOnHard();
      } catch (e) {
        logger.warn('[useFocusEffect] Error enabling speaker:', e);
      }


      // Сбрасываем guard через небольшую задержку
      setTimeout(() => {
        focusEffectGuardRef.current = false;
      }, 300);
    } else {
      try {
        const stream = localStream || localStreamRef.current;
        stream?.getVideoTracks()?.forEach((t: any) => {
          if (!t.enabled) {
            t.enabled = true;
          }
        });
      } catch {}
    }

    return () => {
      leavingRef.current = true;
      if (focusEffectGuardRef.current) {
        return;
      }

      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
      // ВАЖНО: Проверяем isJustStarted ПЕРЕД вычислением hasActiveCall
      // Это предотвращает остановку стрима сразу после нажатия "Начать"
      const isJustStarted = startedRef.current && !partnerIdRef.current && !roomIdRef.current;
      // hasActiveCall должен быть false если мы в неактивном состоянии ИЛИ если пользователь только что начал поиск
      // Это предотвращает показ PiP после завершения звонка и остановку стрима при начале поиска
      // Для рандомного чата roomId может быть пустым (direct WebRTC), поэтому
      // считаем звонок активным также при наличии partnerId или установленного pcConnected
      const hasActiveCall = (!!roomIdRef.current || !!partnerIdRef.current || pcConnectedRef.current)
        && !isInactiveStateRef.current
        && !isJustStarted;
      const isRandomChat = !isFriendCall && (roomIdRef.current || partnerIdRef.current || startedRef.current);

      // Для рандомного чата: ЛЮБОЙ уход со страницы = выход из чата/поиска
      // Порядок: сначала сбрасываем состояние и идентификаторы → останавливаем стрим → шлём сокет-события
      if (isRandomChat) {
        const roomIdToLeave = roomIdRef.current;
        // 1) Сброс состояний поиска/активности и идентификаторов ДО остановки стрима
        startedRef.current = false;
        setStarted(false);
        setLoading(false);
        isInactiveStateRef.current = true;
        setIsInactiveState(true);
        // КРИТИЧНО: Сбрасываем refs для дружеских звонков, чтобы они не мешали новому звонку
        friendCallAcceptedRef.current = false;
        inDirectCallRef.current = false;
        setFriendCallAccepted(false);
        setInDirectCall(false);
        partnerIdRef.current = null;
        partnerUserIdRef.current = null as any;
        roomIdRef.current = null;
        currentCallIdRef.current = null;
        // 2) Останавливаем локальный стрим (камера/микрофон)
        try {
          stopLocalStream(false).catch(() => {});
          setLocalStream(null);
          localStreamRef.current = null;
          setCamOn(false);
          setMicOn(false);
        } catch (e) {
          logger.warn('[useFocusEffect] Error stopping local stream:', e);
        }
        try {
          socket.emit('stop');
        } catch (e) {
          logger.warn('[useFocusEffect] Error sending stop:', e);
        }
        try {
          if (roomIdToLeave) {
            socket.emit('room:leave', { roomId: roomIdToLeave });
          }
        } catch (e) {
          logger.warn('[useFocusEffect] Error sending room:leave:', e);
        }
        try {
          const pc = peerRef.current;
          if (pc) cleanupPeer(pc);
        } catch (e) {
          logger.warn('[useFocusEffect] Error cleaning PeerConnection:', e);
        }
        peerRef.current = null;
        preCreatedPcRef.current = null;
        setRemoteStream(null);
        remoteStreamRef.current = null as any;
        setRemoteCamOn(false);
        setRemoteMutedMain(false);
        setPartnerId(null);
        setPartnerUserId(null);
        try { stopMicMeter(); } catch {}
        try { stopSpeaker(); } catch {}
      }

      // Показываем PiP только если его еще нет и есть активный звонок (только для friend calls)
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      // Двойная проверка: и через hasActiveCall (который уже проверяет isInactiveStateRef), и напрямую
      const currentPip = pipRef.current;
      if (isFriendCall && hasActiveCall && !currentPip.visible && !isInactiveState && !isInactiveStateRef.current) {
        focusEffectGuardRef.current = true;

        try {
          const stream = localStream || localStreamRef.current;
          stream?.getVideoTracks()?.forEach((t: any) => {
            t.enabled = false;
          });
        } catch (e) {
          logger.warn('[useFocusEffect] Error disabling local video:', e);
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
        
        // Сохраняем partnerUserId в navParams для восстановления при возврате
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
            partnerId: partnerId || partnerIdRef.current, // Сохраняем partnerId для восстановления соединения
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
            // Показываем у собеседника заглушку «Отошёл…» во время PiP: выключаем камеру логически
            try {
              // Запоминаем прежнее состояние (до выключения) чтобы восстановить после возврата
              const v = (localStream || localStreamRef.current)?.getVideoTracks?.()?.[0];
              pipPrevCamOnRef.current = (typeof v?.enabled === 'boolean') ? v.enabled : camOnRef.current;
              const currentRoomId = roomIdRef.current;
              const payload: any = { enabled: false, from: socket.id };
              if (currentRoomId) {
                payload.roomId = currentRoomId;
              }
              socket.emit('cam-toggle', payload);
            } catch (e) {
              logger.warn('[useFocusEffect] Error emitting cam-toggle:', e);
            }
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
  const loadingRef = useRef(false);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  
  // Защита от повторных нажатий на стоп
  const isStoppingRef = useRef(false);
  
  // Защита от спама кнопки "Далее"
  const [isNexting, setIsNexting] = useState(false);
  

  // Incoming direct friend call state
  const [incomingFriendCall, setIncomingFriendCall] = useState<{ from: string; nick?: string } | null>(null);
  const [friendCallAccepted, setFriendCallAccepted] = useState(false);
  // Флаг ухода со страницы, чтобы не запускать автопоиск и игнорировать поздние сокет-события
  const leavingRef = useRef(false);

  // 3.4. Guard от двойного свайпа
  const swipeHandledRef = useRef(false);

  const [partnerId, setPartnerId] = useState<string | null>(null); // socket.id собеседника
  const partnerIdRef = useRef<string | null>(null);
  useEffect(() => { partnerIdRef.current = partnerId; }, [partnerId]);
  const [partnerUserId, setPartnerUserId] = useState<string | null>(initialPeerUserId || null); // Mongo _id для дружбы

  const [myNick, setMyNick] = useState<string>('');
  const [myAvatar, setMyAvatar] = useState<string>('');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  // Динамическая ICE конфигурация (загружается с бэкенда)
  const iceConfigRef = useRef<RTCConfiguration | null>(null);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);
  
          // Объявляем переменные ДО использования в useEffect ниже
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const remoteCamOnRef = useRef(true);
  useEffect(() => { remoteCamOnRef.current = remoteCamOn; }, [remoteCamOn]);
  // Видели ли cam-toggle от собеседника в текущем соединении
  const camToggleSeenRef = useRef<boolean>(false);
  // Жёсткая блокировка авто‑включений удалённого видео после cam-toggle(false)
  const remoteForcedOffRef = useRef<boolean>(false);
  // Сбрасываем принудительную блокировку при смене собеседника
  useEffect(() => { remoteForcedOffRef.current = false; }, [partnerId]);
  // Хелпер: можно ли автоматически включать remoteCamOn (без явного cam-toggle)
  const canAutoShowRemote = useCallback(() => {
    if (remoteForcedOffRef.current) return false;
    // В звонке друг‑друг, если уже видели cam-toggle — больше не авто‑включаем
    if ((isDirectCall || inDirectCall || friendCallAccepted) && camToggleSeenRef.current) return false;
    return true;
  }, [isDirectCall, inDirectCall, friendCallAccepted]);
  // Было ли явное локальное нажатие на кнопку камеры в этой сессии
  const explicitCamToggledRef = useRef<boolean>(false);
  
  // Состояние неактивного режима после нажатия "Завершить"
  const [isInactiveState, setIsInactiveState] = useState(false);
  const isInactiveStateRef = useRef(false);
  useEffect(() => { isInactiveStateRef.current = isInactiveState; }, [isInactiveState]);
  
          // Автоматически устанавливаем remoteCamOn в true когда появляется video track в remoteStream
  // Это особенно важно при повторных звонках и плохом интернете, когда video track может прийти позже
  useEffect(() => {
    console.log('[useEffect remoteStream] Triggered', {
      hasRemoteStream: !!remoteStream,
      remoteStreamId: remoteStream?.id,
      remoteStreamRefId: remoteStreamRef.current?.id,
      isInactiveState,
      isDirectCall,
      inDirectCall,
      friendCallAccepted,
      remoteCamOn,
      remoteCamOnRef: remoteCamOnRef.current,
      partnerUserId,
      partnerUserIdRef: partnerUserIdRef.current
    });
    
    if (remoteStream && !isInactiveState) {
      try {
        const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
        const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
        
        console.log('[useEffect remoteStream] Checking video track', {
          hasVideoTrack: !!videoTrack,
          videoTrackEnabled: videoTrack?.enabled,
          videoTrackReadyState: videoTrack?.readyState,
          isDirectFriendCall,
          canAutoShowRemote: canAutoShowRemote(),
          remoteCamOnRefCurrent: remoteCamOnRef.current,
          camToggleSeenRefCurrent: camToggleSeenRef.current
        });
        
        if (videoTrack && videoTrack.readyState !== 'ended' && videoTrack.enabled === true) {
          // КРИТИЧНО: Для прямых звонков всегда включаем remoteCamOn если есть видео
          if (isDirectFriendCall) {
            const oldRemoteCamOn = remoteCamOnRef.current;
            setRemoteCamOn(true);
            remoteCamOnRef.current = true;
            console.log('[useEffect remoteStream] ✅ Direct call: Force set remoteCamOn=true', {
              oldValue: oldRemoteCamOn,
              newValue: true,
              videoTrackEnabled: videoTrack.enabled,
              videoTrackReadyState: videoTrack.readyState
            });
          } else if (canAutoShowRemote() && (remoteCamOnRef.current || (isDirectFriendCall && camToggleSeenRef.current === false))) {
            const oldRemoteCamOn = remoteCamOnRef.current;
            setRemoteCamOn(true);
            remoteCamOnRef.current = true;
            console.log('[useEffect remoteStream] ✅ Random chat: Set remoteCamOn=true', {
              oldValue: oldRemoteCamOn,
              newValue: true,
              canAutoShowRemote: canAutoShowRemote(),
              remoteCamOnRefCurrent: remoteCamOnRef.current
            });
          } else {
            console.log('[useEffect remoteStream] ❌ NOT setting remoteCamOn', {
              isDirectFriendCall,
              canAutoShowRemote: canAutoShowRemote(),
              remoteCamOnRefCurrent: remoteCamOnRef.current,
              camToggleSeenRefCurrent: camToggleSeenRef.current
            });
          }
          const newViewKey = Date.now();
          setRemoteViewKey(newViewKey);
          console.log('[useEffect remoteStream] Updated remoteViewKey:', newViewKey);
        } else if (videoTrack && videoTrack.readyState === 'live' && videoTrack.enabled === false) {
          const oldRemoteCamOn = remoteCamOnRef.current;
          setRemoteCamOn(false);
          remoteCamOnRef.current = false;
          console.log('[useEffect remoteStream] Set remoteCamOn=false (video track disabled)', {
            oldValue: oldRemoteCamOn,
            newValue: false,
            videoTrackReadyState: videoTrack.readyState,
            videoTrackEnabled: videoTrack.enabled
          });
          const newViewKey = Date.now();
          setRemoteViewKey(newViewKey);
          console.log('[useEffect remoteStream] Updated remoteViewKey:', newViewKey);
        } else {
          console.log('[useEffect remoteStream] Video track not suitable', {
            hasVideoTrack: !!videoTrack,
            videoTrackReadyState: videoTrack?.readyState,
            videoTrackEnabled: videoTrack?.enabled
          });
        }
      } catch (e) {
        console.error('[useEffect remoteStream] Error:', e);
      }
    } else {
      console.log('[useEffect remoteStream] Skipped - no remote stream or inactive state', {
        hasRemoteStream: !!remoteStream,
        isInactiveState
      });
    }
  }, [remoteStream, isInactiveState, canAutoShowRemote, isDirectCall, inDirectCall, friendCallAccepted]);
  
          // Периодическая проверка video track для случаев плохого интернета
  // Это гарантирует, что видео будет отображаться даже если track приходит с задержкой
  useEffect(() => {
    if (!remoteStream || isInactiveState) return;
    
    const checkVideoTrack = () => {
      try {
        const videoTrack = (remoteStream as any)?.getVideoTracks?.()?.[0];
        if (videoTrack && videoTrack.readyState !== 'ended' && videoTrack.enabled === true && !remoteCamOnRef.current) {
          if (canAutoShowRemote() && ((isDirectCall || inDirectCall || friendCallAccepted) && camToggleSeenRef.current === false)) {
            setRemoteCamOn(true);
          }
          setRemoteViewKey(Date.now());
        } else if (videoTrack && videoTrack.readyState === 'live' && videoTrack.enabled === false && remoteCamOnRef.current) {
          setRemoteCamOn(false);
          setRemoteViewKey(Date.now());
        }
      } catch {}
    };
    
    // Проверяем сразу
    checkVideoTrack();
    
    // Проверяем каждые 500ms для случаев плохого интернета
    const interval = setInterval(checkVideoTrack, 500);
    
    return () => clearInterval(interval);
  }, [remoteStream, isInactiveState, remoteCamOn]);

  const roomIdRef = useRef<string | null>(null);
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
      return;
    }
    
    if (autoSearchTimeoutRef.current) {
      clearTimeout(autoSearchTimeoutRef.current);
      autoSearchTimeoutRef.current = null;
    }
    
    lastAutoSearchRef.current = now;
    
    // Сначала безопасно очищаем PeerConnection
    try {
      const pc = peerRef.current;
      if (pc) {
        try { pc.close(); } catch {}
        peerRef.current = null;
      }
    } catch {}
    
    setStarted(true);
    setLoading(true);
    setRemoteStream(null);
    setIsInactiveState(false);
    setWasFriendCallEnded(false);
    
    autoSearchTimeoutRef.current = setTimeout(() => {
      try { 
        socket.emit('next'); 
      } catch (e) {
        logger.error(`[triggerAutoSearch] Error:`, e);
      }
      autoSearchTimeoutRef.current = null;
    }, 1000);
  }, []);

  // Local media
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  const [streamValid, setStreamValid] = useState(false);

          // Управление keep-awake для активного видеочата (особенно важно для iOS)
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
  const camOnRef = useRef(false);
  const camUserPreferenceRef = useRef(true);
  useEffect(() => { 
    const prevCamOn = camOnRef.current;
    camOnRef.current = camOn;
    // Если камера включена (любым способом), обновляем "предпочтение" пользователя
    if (camOn && camUserPreferenceRef.current !== camOn) {
      camUserPreferenceRef.current = camOn;
    }
  }, [camOn]);
  
  // ЗАЩИТА: Предотвращаем сброс camOn в false при активном соединении
  // Камера должна быть ВСЕГДА включена при подключении и выключаться ТОЛЬКО по нажатию на кнопку
  useEffect(() => {
    // Если есть активное соединение (partnerId или roomId) И started=true И есть localStream,
    // но camOn=false - это ошибка, нужно установить camOn=true
    const hasActiveConnection = !!partnerIdRef.current || !!roomIdRef.current;
    const hasLocalStream = !!(localStreamRef.current || localStream);
    const isRandomChat = !isDirectCall && !inDirectCall && !friendCallAccepted;
    
    if (hasActiveConnection && started && hasLocalStream && !camOn && isRandomChat) {
      // Пользователь намеренно выключил камеру — не включаем её автоматически
      if (camUserPreferenceRef.current === false) {
        return;
      }
      const stream = localStreamRef.current || localStream;
      if (!stream || !isValidStream(stream)) {
        return;
      }
      
      const videoTrack = stream.getVideoTracks()?.[0];
      if (videoTrack && videoTrack.readyState !== 'ended') {
        videoTrack.enabled = true;
        setCamOn(true);
      }
    }
  }, [camOn, started, localStream, partnerId, isDirectCall, inDirectCall, friendCallAccepted]);
  const [remoteMutedMain, setRemoteMutedMain] = useState(false);

  // ДРУЖБА
  const [incomingFriendFrom, setIncomingFriendFrom] = useState<string | null>(null);
  const [friendModalVisible, setFriendModalVisible] = useState(false);
  const [friends, setFriends] = useState<Array<{ _id: string; nick?: string; avatar?: string; avatarUrl?: string; online: boolean }>>([]);
  const [addBlocked, setAddBlocked] = useState(false);
  const [addPending, setAddPending] = useState(false);
  // Запоминаем, кому мы отправили последнюю заявку, чтобы показывать "Вам отказано" только отправителю
  const lastFriendRequestToRef = useRef<string | null>(null);
  
  // Кэш никнеймов пользователей по ID
  const [userNicks, setUserNicks] = useState<Record<string, string>>({});
  const isPartnerFriend = useMemo(() => {
    const result = !!(partnerUserId && started && friends.some(f => String(f._id) === String(partnerUserId)));
    console.log('[isPartnerFriend] Computed', {
      partnerUserId,
      started,
      friendsCount: friends.length,
      isFriend: result,
      friendsIds: friends.map(f => String(f._id)),
      partnerUserIdString: partnerUserId ? String(partnerUserId) : null
    });
    return result;
  }, [friends, partnerUserId, started]);


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

  // === Индикатор громкости (только при соединении) ===
  const [micLevel, setMicLevel] = useState(0);
  const micStatsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
          // Для iOS - отслеживаем низкие значения для определения молчания
  const lowLevelCountRef = useRef<number>(0);

  // Toast
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;
  
const pcConnectedRef = useRef(false);
const [pcConnected, setPcConnected] = useState(false);

const energyRef = useRef<number | null>(null);
const durRef = useRef<number | null>(null);

  const [partnerInPiP, setPartnerInPiP] = useState(false); // Отслеживаем когда партнер ушел в PiP
  const [remoteViewKey, setRemoteViewKey] = useState(0); // Key для принудительной перерисовки RTCView
  // Ref для предотвращения двойного обновления remoteViewKey при возврате из PiP
  const pipReturnUpdateRef = useRef(false);
  // Ref для защиты от множественных обработок pip:state при возврате из PiP
  const pipStateProcessingRef = useRef(false);
  
          // remoteCamOn и isInactiveState объявлены выше (строка 651-658) ДО использования в useEffect
  
  // Флаг для отслеживания завершенного звонка друга (для показа заблокированной кнопки "Завершить")
  const [wasFriendCallEnded, setWasFriendCallEnded] = useState(false);
  
  // Флаг для предотвращения дублирования активации background
  const bgActivationInProgress = useRef(false);

  // Refs для AppState listener чтобы избежать пересоздания listener
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  
  const partnerUserIdRef = useRef(partnerUserId);
  partnerUserIdRef.current = partnerUserId;
  
  remoteCamOnRef.current = remoteCamOn;
  
  const friendCallAcceptedRef = useRef(friendCallAccepted);
  friendCallAcceptedRef.current = friendCallAccepted;

  // Ref для таймера блокировки экрана на iOS
  const inactiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AppState monitoring для background режима (после объявления всех зависимостей)
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s === 'active') {
        if (inactiveTimerRef.current) {
          clearTimeout(inactiveTimerRef.current);
          inactiveTimerRef.current = null;
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
        const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        
        if (isFriendCall && (roomIdRef.current || currentCallIdRef.current)) {
          return;
        }
      } else if (s === 'background') {
        const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
        
        if (isFriendCall && (roomIdRef.current || currentCallIdRef.current)) {
          return;
        } else if (!isFriendCall && (roomIdRef.current || partnerIdRef.current)) {
          try {
            const currentRoomId = roomIdRef.current;
            if (currentRoomId) {
              socket.emit('room:leave', { roomId: currentRoomId });
            }
          } catch {}
          
          try {
            socket.emit('stop');
          } catch {}
          
          // Полная локальная остановка
          try { stopLocalStream(false).catch(() => {}); } catch {}
          setLocalStream(null);
          localStreamRef.current = null;
          setCamOn(false);
          setMicOn(false);
          try { if (peerRef.current) cleanupPeer(peerRef.current); } catch {}
          peerRef.current = null;
          preCreatedPcRef.current = null;
          setRemoteStream(null);
          remoteStreamRef.current = null as any;
          setRemoteCamOn(false);
          setRemoteMutedMain(false);
          // Переводим UI в неактивное состояние
          startedRef.current = false;
          setStarted(false);
          setLoading(false);
          isInactiveStateRef.current = true;
          setIsInactiveState(true);
          partnerIdRef.current = null;
          partnerUserIdRef.current = null as any;
          roomIdRef.current = null;
          currentCallIdRef.current = null;
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
      const hasActiveCall = !!roomIdRef.current;
      
      if (isFriendCall && hasActiveCall) {
        try {
          const partnerNick = friendsRef.current.find(f => String(f._id) === String(partnerUserIdRef.current))?.nick;
          
          const streamToUse = remoteStreamRef.current || remoteStream;
          
          let finalStreamToUse = streamToUse;
          if (!streamToUse && peerRef.current) {
            try {
              const pc = peerRef.current;
              const receivers = pc.getReceivers();
              const videoReceiver = receivers.find(r => r.track && r.track.kind === 'video');
              if (videoReceiver && videoReceiver.track) {
                const fallbackStream = new MediaStream([videoReceiver.track]);
                setRemoteStream(fallbackStream);
                remoteStreamRef.current = fallbackStream;
                finalStreamToUse = fallbackStream;
              }
            } catch {}
          }
          
          try {
            socket.emit('bg:entered', { 
              callId: roomIdRef.current,
              partnerId: partnerUserIdRef.current 
            });
          } catch {}
          
          const nav = (global as any).__navRef;
          if (nav?.canGoBack?.()) {
            nav.goBack();
          } else {
            nav?.dispatch?.(CommonActions.reset({ index: 0, routes: [{ name: 'Home' as any }] }));
          }
          
          return true;
        } catch (e) {
          logger.warn('[BackHandler] Error showing background:', e);
        }
      } else if (!isFriendCall && hasActiveCall) {
        try {
          const currentRoomId = roomIdRef.current;
          if (currentRoomId) {
            socket.emit('room:leave', { roomId: currentRoomId });
          }
          
          socket.emit('stop');
          
          cleanupPeer(peerRef.current);
          peerRef.current = null;
          setRemoteStream(null);
          setPartnerId(null);
          setPartnerUserId(null);
          
        } catch (e) {
          logger.warn('[BackHandler] Error notifying partner:', e);
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
  const stopLocalStream = useCallback(async (preserveStreamForConnection: boolean = false) => {
    if (loadingRef.current && startedRef.current) return;
    
    const isSearching = startedRef.current && !partnerIdRef.current && !isInactiveStateRef.current;
    const hasActiveConnection = !!partnerIdRef.current || !!roomIdRef.current;
    const hasStream = !!(localStreamRef.current || localStream);
    
    if (preserveStreamForConnection || isSearching || hasActiveConnection) {
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
    
    if (!hasStream) {
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
    
    const ls = localStreamRef.current || localStream;
    if (!ls) {
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
    
    const tracks = ls.getTracks?.() || [];
    const allTracksEnded = tracks.length === 0 || tracks.every((t: any) => t.readyState === 'ended');
    if (allTracksEnded && tracks.length > 0) {
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
      localStreamRef.current = null;
      setLocalStream(null);
      return;
    }
    
    try {
      const pc = peerRef.current;
      if (pc) {
        peerRef.current = null;
        const senders = pc.getSenders() || [];
        const replacePromises = senders.map(async (sender: any) => {
          try {
            const track = sender.track;
            if (track) track.enabled = false;
            await sender.replaceTrack(null);
          } catch {}
        });
        await Promise.all(replacePromises);
        try {
          const hadOntrack = !!(pc as any).ontrack;
          (pc as any).ontrack = null;
          (pc as any).onaddstream = null;
          (pc as any).onicecandidate = null;
          (pc as any).onconnectionstatechange = null;
          (pc as any).oniceconnectionstatechange = null;
          (pc as any).onsignalingstatechange = null;
          (pc as any).onicegatheringstatechange = null;
          if (hadOntrack) {
            console.log('[cleanupPeer] Cleared ontrack handler from PC', {
              pcSignalingState: pc?.signalingState,
              pcConnectionState: pc?.connectionState
            });
          }
        } catch {}
        try { pc.close(); } catch {}
      }
      
      if (preCreatedPcRef.current) {
        try {
          const prePc = preCreatedPcRef.current;
          preCreatedPcRef.current = null;
          const preSenders = prePc.getSenders() || [];
          const preReplacePromises = preSenders.map(async (sender: any) => {
            try {
              const track = sender.track;
              if (track) track.enabled = false;
              await sender.replaceTrack(null);
            } catch {}
          });
          await Promise.all(preReplacePromises);
          try {
            (prePc as any).ontrack = null;
            (prePc as any).onaddstream = null;
            (prePc as any).onicecandidate = null;
            (prePc as any).onconnectionstatechange = null;
            (prePc as any).oniceconnectionstatechange = null;
            (prePc as any).onsignalingstatechange = null;
            (prePc as any).onicegatheringstatechange = null;
          } catch {}
          prePc.close();
        } catch {}
      }
    } catch (e) {
      logger.error('[stopLocalStream] Error removing tracks from PeerConnection:', e);
    }
    
    await cleanupStream(ls);
    localStreamRef.current = null;
    setLocalStream(null);
  }, [localStream, started]);

  

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

  // --------------------------
  // Local stream
  // --------------------------
  const startLocalStream = useCallback(async (_: CamSide) => {
    // НЕ запускаем камеру если находимся в неактивном состоянии (завершенный звонок)
    // Используем ref вместо state для проверки, чтобы избежать race condition
    // Также проверяем что нет активного звонка (partnerId, roomId, callId)
    const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
    const hasFriendCallIntent = friendCallAccepted || inDirectCallRef.current || isDirectCall;

    if (isInactiveStateRef.current && !hasActiveCall) {
      if (!hasFriendCallIntent) {
        return null;
      }

      // Пользователь пытается начать дружеский звонок после рандомного чата —
      // выходим из неактивного состояния, иначе getUserMedia будет заблокирован
      isInactiveStateRef.current = false;
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    if (resume && fromPiP && pipLocalStream && isValidStream(pipLocalStream)) {
      setLocalStream(pipLocalStream);
      return pipLocalStream;
    }
    
    const existingStream = localStreamRef.current || localStream;
    if (existingStream && isValidStream(existingStream)) {
      if (!localStream) {
        setLocalStream(existingStream);
      }
      return existingStream;
    }
    
    if (existingStream && !isValidStream(existingStream)) {
      try {
        const tracks = existingStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      setLocalStream(null);
      localStreamRef.current = null;
    }
    
    const audioConstraints: any = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      googEchoCancellation: true,
      googNoiseSuppression: true,
      googAutoGainControl: true,
    };

    const try1 = () => mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
    const try2 = () => mediaDevices.getUserMedia({ audio: audioConstraints, video: { facingMode: 'user' as any } });
    const try3 = async () => {
      const devs = await mediaDevices.enumerateDevices();
      const cams = (devs as any[]).filter(d => d.kind === 'videoinput');
      const front = cams.find(d => /front|user/i.test(d.facing || d.label || '')) || cams[0];
      return mediaDevices.getUserMedia({ audio: audioConstraints, video: { deviceId: (front as any)?.deviceId } as any });
    };

    let stream: MediaStream | null = null;
    try {
      stream = await try1(); 
      if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try1');
    } catch (e1) {
      try { 
        stream = await try2(); 
        if (!stream || !(stream as any)?.getVideoTracks?.()?.[0]) throw new Error('No video track from try2'); 
      }
      catch (e2) {
        try {
          stream = await try3(); 
        } catch (e3) {
          logger.error('[startLocalStream] All getUserMedia attempts failed:', e3);
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
    
    // Всегда включаем микрофон и камеру в стриме (нужно для PeerConnection)
    // Но состояние UI контролируется через camOn/micOn
    if (a) { 
      a.enabled = true; // Микрофон включен по умолчанию
      try { (a as any).contentHint = 'speech'; } catch {} 
    }
    if (v) {
      v.enabled = true; // Включаем трек при создании стрима
    }

    // ВАЖНО: Сначала устанавливаем в ref, потом в state
    // Это гарантирует, что защита в stopLocalStream сработает до того как cleanup попытается остановить стрим
    localStreamRef.current = stream;
    setLocalStream(stream);
    setMicOn(!!a?.enabled); // Микрофон включен по умолчанию
    // ВАЖНО: При создании стрима камера ВСЕГДА включена (пользователь может выключить через toggleCam)
    // Устанавливаем camOn в true если есть video track, и ВСЕГДА включаем video track
    if (v) {
      v.enabled = true;
      setCamOn(true);
    }
    // Небольшая задержка для гарантии что ref установлен до возможного cleanup
    await new Promise(r => setTimeout(r, 50));
    setLocalRenderKey(k => k + 1);

    try { forceSpeakerOnHard(); } catch {}
    if (Platform.OS === 'ios') configureIOSAudioSession();

    return stream;
  }, [resume, fromPiP, pipLocalStream, isValidStream, isInactiveState, friendCallAccepted, isDirectCall]);
  
  const ensureStreamReady = useCallback(async () => {
    // Проверяем валидность существующего стрима
    if (localStream && isValidStream(localStream)) {
      // Убеждаемся что камера включена при использовании существующего стрима
      const videoTrack = localStream.getVideoTracks()?.[0];
      if (videoTrack) {
        videoTrack.enabled = true;
        setCamOn(true);
      }
      return localStream;
    }
    
    // Если стрим существует но невалиден, очищаем его
    if (localStream && !isValidStream(localStream)) {
      try {
        const tracks = localStream.getTracks?.() || [];
        tracks.forEach((t: any) => {
          try { t.stop(); } catch {}
        });
      } catch {}
      setLocalStream(null);
      localStreamRef.current = null;
    }
    
    
    // Если находимся в неактивном состоянии, но это активный звонок (например, приняли входящий),
    // выходим из неактивного состояния перед созданием стрима
    if (isInactiveStateRef.current && (friendCallAccepted || isDirectCall || inDirectCall)) {
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      // Даем время state обновиться
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    const stream = await startLocalStream('front');
    
    // Убеждаемся что камера включена после создания стрима
    if (stream) {
      const videoTrack = stream.getVideoTracks()?.[0];
      if (videoTrack) {
        videoTrack.enabled = true;
        setCamOn(true);
      }
    }
    
    // Если startLocalStream вернул null (например, из-за проверки isInactiveState),
    // создаем напрямую ТОЛЬКО если это активный звонок (не завершенный)
    if (!stream && (friendCallAccepted || isDirectCall || inDirectCall)) {
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
            audioTrack.enabled = true; // Микрофон включен по умолчанию
            setMicOn(true);
          }
          return newStream;
        }
      } catch (directError) {
        logger.error('[ensureStreamReady] Error creating stream:', directError);
        return null;
      }
    }
    
    return stream;
  }, [localStream, startLocalStream, isValidStream, friendCallAccepted, isDirectCall, inDirectCall]);

  const isMicReallyOn = useCallback(() => {
    // Используем localStreamRef.current вместо localStream state
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
    // Обновляем micLevel=0 в PiP при остановке метра
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
    if (!pc) { 
      stopMicMeter(); 
      return; 
    }
    const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
    if (!hasActiveCall && !pcConnectedRef.current) { 
      stopMicMeter(); 
      return; 
    }
    if (micStatsTimerRef.current) return;
    micStatsTimerRef.current = setInterval(async () => {
      try {
        // Проверяем текущий PC из ref (не замыкаем старый)
        const currentPc = peerRef.current;
        if (!currentPc || currentPc.signalingState === 'closed' || currentPc.connectionState === 'closed') {
          stopMicMeter();
          return;
        }
        
        // Проверяем что звонок не завершен
        if (isInactiveStateRef.current) {
          stopMicMeter();
          return;
        }
        
        // Проверяем что соединение еще активно
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
            // На iOS audioLevel может быть в диапазоне 0-127, на Android 0-1
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
        
        // Для iOS - если уровень очень низкий несколько раз подряд, сбрасываем до 0
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
    
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') {
      try { 
        (pc as any).ontrack = null; 
        (pc as any).onaddstream = null; 
        (pc as any).onicecandidate = null; 
        (pc as any).onconnectionstatechange = null;
        (pc as any).oniceconnectionstatechange = null;
        (pc as any).onsignalingstatechange = null;
        (pc as any).onicegatheringstatechange = null;
        // КРИТИЧНО: Сбрасываем флаг, чтобы можно было установить обработчики заново
        (pc as any)._remoteHandlersAttached = false;
      } catch {}
      return;
    }
    
    if (preCreatedPcRef.current === pc) {
      preCreatedPcRef.current = null;
    }
    
    try {
      pc.getSenders?.().forEach((s: any) => {
        try { s.replaceTrack?.(null); } catch {}
      });
    } catch {}
    
    try { 
      (pc as any).ontrack = null; 
      (pc as any).onaddstream = null; 
      (pc as any).onicecandidate = null; 
      (pc as any).onconnectionstatechange = null;
      (pc as any).oniceconnectionstatechange = null;
      (pc as any).onsignalingstatechange = null;
      (pc as any).onicegatheringstatechange = null;
      // КРИТИЧНО: Сбрасываем флаг, чтобы можно было установить обработчики заново
      (pc as any)._remoteHandlersAttached = false;
    } catch {}
    
    try { 
      pc.close();
      // КРИТИЧНО: Запоминаем время закрытия PC для задержки перед созданием нового
      (global as any).__lastPcClosedAt = Date.now();
    } catch (e) {
      logger.warn('[cleanupPeer] Error closing PC:', e);
    }
  }, []);

  const onStartStop = useCallback(async () => {
    // Используем ref для проверки, чтобы избежать проблем с замыканием
    if (startedRef.current) {
      // === STOP ===
      // Защита от повторных нажатий
      if (isStoppingRef.current) {
        return;
      }
      isStoppingRef.current = true;
      
      // ВАЖНО: Устанавливаем loadingRef.current в false СРАЗУ ПЕРЕД всеми операциями
      // Это гарантирует, что stopLocalStream не будет пропущен из-за проверки loadingRef.current
      loadingRef.current = false;
      setLoading(false);

      // Метр — в ноль и стоп
      stopMicMeter();

      // ВАЖНО: Устанавливаем startedRef.current в false СРАЗУ, чтобы состояние было синхронизировано
      startedRef.current = false;
      setStarted(false);
      setIsInactiveState(false); // Сбрасываем неактивное состояние при остановке поиска
      setWasFriendCallEnded(false); // Сбрасываем флаг завершенного звонка

      try { stopSpeaker(); } catch {}
      try { 
        socket.emit('stop'); 
      } catch (e) {
        logger.error('[onStartStop] Error emitting stop:', e);
      }

      try {
        const currentRoomId = roomIdRef.current;
        if (currentRoomId) {
          socket.emit('room:leave', { roomId: currentRoomId });
          roomIdRef.current = null;
        }
      } catch {}

      cleanupPeer(peerRef.current);
      peerRef.current = null;
      
      partnerIdRef.current = null;
      processingOffersRef.current.clear();
      
      const ls = localStreamRef.current || localStream;
      if (ls) {
        try {
          const tracks = ls.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
            } catch {}
          });
        } catch {}
        localStreamRef.current = null;
      }
      
      loadingRef.current = false;
      stopLocalStream();

      setLocalStream(null);
      setRemoteStream(null);
      setLocalRenderKey(k => k + 1);
      setPartnerId(null);
      setPartnerUserId(null);
      setMicOn(false);
      setCamOn(false);
      setRemoteMutedMain(false);
      setRemoteCamOn(false);
      
      // Сбрасываем флаг остановки после небольшой задержки
      setTimeout(() => {
        isStoppingRef.current = false;
      }, 500);
      
      return;
    }

    // === START ===
    if (loadingRef.current) return;
    
    const ok = await requestPermissions();
    if (!ok) {
      Alert.alert('Разрешения', 'Нет доступа к камере/микрофону');
      return;
    }

    setLoading(true);
    loadingRef.current = true;
    startedRef.current = true;
    try {
      const stream = await startLocalStream('front');
      if (stream) {
        const videoTrack = stream.getVideoTracks()?.[0];
        if (videoTrack) {
          const wantCam = camUserPreferenceRef.current === true;
          videoTrack.enabled = wantCam;
          setCamOn(wantCam);
        }
      }
      
      if (stream) {
        const videoTrack = stream.getVideoTracks()?.[0];
        const wantCam = camUserPreferenceRef.current === true;
        if (videoTrack && videoTrack.enabled !== wantCam) {
          videoTrack.enabled = wantCam;
        }
        setCamOn(wantCam);
      }
      
      setStarted(true);
      
      setTimeout(() => {
        if (stream && startedRef.current) {
          const videoTrack = stream.getVideoTracks()?.[0];
          if (videoTrack) {
            const wantCam = camUserPreferenceRef.current === true;
            videoTrack.enabled = wantCam;
            setCamOn(wantCam);
          }
        }
      }, 200);
      
      try { 
        socket.emit('start'); 
      } catch (e) {
        logger.error('[onStartStop] Error emitting start:', e);
      }
    } catch (e) {
      startedRef.current = false;
      setStarted(false);
      setLoading(false);
      loadingRef.current = false;
      setCamOn(false);
      Alert.alert('Ошибка', 'Не удалось запустить камеру/микрофон');
    }
  }, [requestPermissions, startLocalStream, cleanupPeer, stopMicMeter, isDirectCall]);

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
    
    // Очищаем partnerId СНАЧАЛА, чтобы предотвратить обработку устаревших событий
    const oldPartnerId = partnerIdRef.current;
    partnerIdRef.current = null;
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteMutedMain(false); // Сбрасываем состояние кнопки mute собеседника
    setRemoteCamOn(false); // При разрыве соединения показываем заглушку по умолчанию
    
    // Очищаем roomIdRef при разрыве соединения
    roomIdRef.current = null;
    
    console.log('[stopRemoteOnly] Disconnected from partner:', oldPartnerId);
    
    // Остаёмся в режиме «идёт поиск» с включённой локальной камерой
    // НЕ трогаем локальный стрим — остаёмся в режиме готовности
  }, [stopMicMeter]);


  // УПРОЩЕНО: Завершить звонок (1-на-1 friends mode) - переход в неактивное состояние
  const onAbortCall = useCallback(async () => {
    try {
        // ВАЖНО: Для звонков друзей используем roomId, так как сервер использует roomId для поиска участников
        // Для звонков друзей roomId имеет формат room_<socketId1>_<socketId2>
        const roomId = roomIdRef.current;
        const callId = currentCallIdRef.current;
        
      logger.debug('[onAbortCall] Ending 1-on-1 call', {
        callId,
        roomId,
        isDirectCall,
        inDirectCall,
        friendCallAccepted
      });
        
        // Для звонков друзей приоритет у roomId, так как сервер использует его для поиска комнаты
        const idToUse = roomId || callId;
        
        if (!idToUse) {
          logger.warn('[onAbortCall] No roomId or callId available! Cannot send call:end');
          console.warn('[onAbortCall] ⚠️ No roomId or callId - cannot properly end call');
        } else {
          // Отправляем call:end серверу (для обоих участников)
          // Сервер сам отправит call:ended обоим участникам и уберет бейдж "занято" у обоих
          try { 
            socket.emit('call:end', { callId: idToUse }); 
            logger.debug('[onAbortCall] Sent call:end', { 
              callId: idToUse, 
              usedRoomId: !!roomId,
              usedCallId: !!callId && !roomId
            });
            console.log('[onAbortCall] ✅ Sent call:end - server will notify both participants and remove busy badge', {
              id: idToUse,
              type: roomId ? 'roomId' : 'callId'
            });
          } catch (e) {
            logger.error('[onAbortCall] Failed to send call:end:', e);
            console.error('[onAbortCall] ❌ Failed to send call:end:', e);
          }
        }
        
        // ВАЖНО: НЕ отправляем presence:update здесь, так как сервер сам обработает это
        // при получении call:end и отправит presence:update с busy: false обоим участникам
        
        // ВАЖНО: Сохраняем roomId и callId перед очисткой для обработки call:ended
        // (если call:ended придет быстро, нам нужны эти значения для проверки)
        const savedRoomId = roomIdRef.current;
        const savedCallId = currentCallIdRef.current;
        
        // Сначала очищаем ВСЕ refs и state связанные со звонком ПЕРЕД остановкой потоков
        // Это предотвращает восстановление состояния звонка в useEffect
        currentCallIdRef.current = null;
        roomIdRef.current = null;
        partnerUserIdRef.current = null;
        partnerIdRef.current = null;
        setPartnerUserId(null);
        setPartnerId(null);
        
        // Переходим в неактивное состояние
        logger.debug('[onAbortCall] Switching to inactive state');
        
        // САМОЕ ПЕРВОЕ ДЕЛО - устанавливаем peerRef.current = null и isInactiveStateRef.current = true
        // Это должно быть ДО любых других действий, чтобы обработчики видели что звонок завершен
        const pcMain = peerRef.current;
        const pcPreCreated = preCreatedPcRef.current;
        
        // СНАЧАЛА устанавливаем peerRef.current = null, чтобы обработчики не видели активный PC
        peerRef.current = null;
        preCreatedPcRef.current = null;
        
        // СНАЧАЛА очищаем ВСЕ refs СИНХРОННО
        currentCallIdRef.current = null;
        roomIdRef.current = null;
        partnerUserIdRef.current = null;
        partnerIdRef.current = null;
        
        // СНАЧАЛА устанавливаем isInactiveStateRef.current = true СИНХРОННО
        isInactiveStateRef.current = true;
        setIsInactiveState(true);
        console.log('🔴 [onAbortCall] Set peerRef=null, isInactiveState=true, refs cleared FIRST (before any cleanup)');
        
        // Теперь очищаем обработчики ПЕРЕД закрытием PC
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
        
        // Очищаем state
        setPartnerUserId(null);
        setPartnerId(null);
        // Устанавливаем флаг что звонок друга был завершен
        setWasFriendCallEnded(true);
        
        // Устанавливаем started в false для скрытия кнопок в блоках
        setStarted(false);
        setCamOn(false); // Выключаем камеру
        setMicOn(false); // Выключаем микрофон
        setFriendCallAccepted(false);
        setInDirectCall(false);
        
        // Останавливаем локальные потоки (stopLocalStream сам закроет все PeerConnection внутри)
        try {
          await stopLocalStream();
          // localStreamRef и localStream уже очищены в stopLocalStream
          console.log('[onAbortCall] Local stream stopped and cleared');
          
          // Дополнительная проверка для повторных вызовов - убеждаемся что ВСЕ треки действительно остановлены
          // Это особенно важно для второго и последующих вызовов когда камера может оставаться активной
          // Проверяем как localStreamRef, так и локальную переменную localStream (на случай если ref уже очищен)
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
          
          // Дополнительная проверка всех активных mediaDevices
          // Это особенно важно для iOS где индикатор камеры может оставаться активным
          try {
            const allDevices = await mediaDevices.enumerateDevices() as any[];
            const activeVideoDevices = allDevices.filter((d: any) => d.kind === 'videoinput');
            if (activeVideoDevices.length > 0) {
              console.log('[onAbortCall] Video devices still enumerated after cleanup:', activeVideoDevices.length);
            }
        } catch {}
        
          // Дополнительная задержка для iOS чтобы камера полностью освободилась
          // Это особенно важно при повторных вызовах
          await new Promise(resolve => setTimeout(resolve, 200));
        } catch (e) {
          console.error('[onAbortCall] Error stopping local stream:', e);
        }
        
        // Дополнительная проверка - убеждаемся что все PeerConnection закрыты
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
        
        // Очищаем remote потоки - останавливаем треки перед очисткой
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
        
        // Сбрасываем ВСЕ флаги состояния
        setRemoteMutedMain(false);
        setRemoteCamOn(false);
        setPartnerInPiP(false);
        setFriendCallAccepted(false);
        setInDirectCall(false);
        
        // Останавливаем индикаторы
        try { 
          stopMicMeter(); 
          // Дополнительно устанавливаем micLevel=0 для эквалайзера
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
    // Если пользователь в неактивном состоянии (завершенный звонок с задизейбленной кнопкой),
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
      
      // Если это возврат из background, восстанавливаем roomId
      if (returnToActiveCall && !roomIdRef.current) {
        if (routeRoomId) {
          roomIdRef.current = routeRoomId;
        } else {
          const savedStreams = { roomId: null, remoteStream: null, localStream: null };
          if (savedStreams.roomId) {
            roomIdRef.current = savedStreams.roomId;
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
      
      // Устанавливаем все флаги активного звонка для правильного отображения UI
      setStarted(true);
      setPcConnected(true);
      setInDirectCall(true);
      setFriendCallAccepted(true);
      setLoading(false); // Сбрасываем лоадер если был
      
      // Выходим из неактивного состояния при возврате из PiP
      setIsInactiveState(false);
      setWasFriendCallEnded(false);
      
      // Восстанавливаем partnerUserId из route.params (сохранено при уходе в PiP)
      const routePartnerUserId = route?.params?.peerUserId || (route?.params as any)?.partnerUserId;
      if (routePartnerUserId && !partnerUserId) {
        setPartnerUserId(routePartnerUserId);
        partnerUserIdRef.current = routePartnerUserId;
      }
      
      // Восстанавливаем partnerId (socket.id) из route.params для правильного восстановления соединения
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
      // При возврате из PiP состояние кнопки камеры должно оставаться включенной
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
          // Устанавливаем camOn в true если трек включен (независимо от того, был ли он включен до этого или мы его только что включили)
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
      
      // Также проверяем localStreamRef для обратной совместимости
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
      
      if (canAutoShowRemote() && remoteCamOnRef.current) {
        setRemoteCamOn(true);
      }
      setRemoteViewKey(Date.now());
      setPartnerInPiP(false);
      
      // Синхронизируем состояние камеры с партнером при возврате из PiP
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
    
    // НЕ восстанавливаем состояние звонка если находимся в неактивном состоянии
    // Это предотвращает случайное восстановление после завершения звонка
    // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: также не восстанавливаем если wasFriendCallEnded === true (звонок друга был завершен)
    // Дополнительная проверка - убеждаемся что currentCallIdRef тоже не очищен (если это звонок друга)
    // Также проверяем что roomIdRef и partnerUserIdRef не очищены (если они null, значит звонок завершен)
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
      
      // Восстанавливаем состояние звонка только если НЕ в неактивном состоянии
      // (неактивное состояние обрабатывается выше через return в начале useEffect)
      // НЕ восстанавливаем состояние если был завершен звонок друга
      if (!wasFriendCallEnded && hasActiveCallId) {
      setStarted(true);
      setPcConnected(true);
      setInDirectCall(true);
        setFriendCallAccepted(true); // Для инициатора устанавливаем friendCallAccepted при восстановлении
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
            partnerId: partnerId || partnerIdRef.current, // Сохраняем partnerId для восстановления соединения
          } as any,
        });
        // Обновляем micLevel в PiP сразу после показа
        pip.updatePiPState({ micLevel: micLevel });
      }
      
      // Восстанавливаем потоки из глобального контекста background или из refs
      const savedStreams = { roomId: null, remoteStream: null, localStream: null };

      // НЕ трогаем remoteStream и remoteCamOn - ими управляет только партнёр через pip:state
      if (remoteStreamRef.current) {
        setRemoteStream(remoteStreamRef.current);
        // remoteCamOn управляется только через pip:state
      }
      
      if (savedStreams.localStream) {
        setLocalStream(savedStreams.localStream);
        localStreamRef.current = savedStreams.localStream;
      } else if (localStreamRef.current) {
        setLocalStream(localStreamRef.current);
      }
      
      // Принудительно обновляем ключи рендера
      setLocalRenderKey(prev => prev + 1);
      
      // Обновляем состояние локальной камеры только если НЕ в неактивном состоянии
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
        
        // НЕ создаем новый PeerConnection при возврате из background
        return;
      }
    }
  }, [started, route?.params?.returnToActiveCall, route?.params?.callId, route?.params?.roomId, resume, fromPiP, isInactiveState, incomingFriendCall, friendCallAccepted, wasFriendCallEnded]); // Добавлены friendCallAccepted и wasFriendCallEnded для отслеживания принятого звонка и завершенного звонка друга

  const onNext = useCallback(async () => {
    // ЗАЩИТА ОТ СПАМА: Блокируем кнопку на 1.5 секунды
    if (isNexting) return;
    
    setIsNexting(true);
    manuallyRequestedNextRef.current = true;
    setRemoteStream(null);
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteCamOn(false);
    setRemoteMutedMain(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при очистке
    
    // Завершаем только удалённое соединение, локальная камера остаётся включённой
    stopRemoteOnly();
    
    // Ускорение: не ждём пауз — закрытие PC идёт параллельно
    
    // Покидаем текущую комнату перед поиском нового собеседника (только для direct calls)
    try {
      const currentRoomId = roomIdRef.current;
      if (currentRoomId && isDirectCall) {
        socket.emit('room:leave', { roomId: currentRoomId });
        roomIdRef.current = null;
      }
    } catch {}
    
    if (!started) {
      setStarted(true);
    }
    
    if (!localStreamRef.current && !isInactiveStateRef.current) {
      try { 
        const stream = await startLocalStream?.('front');
        if (stream) {
          const videoTrack = stream.getVideoTracks()?.[0];
          if (videoTrack) {
            const wantCam = camUserPreferenceRef.current === true;
            videoTrack.enabled = wantCam;
            setCamOn(wantCam);
          }
        }
      } catch {}
    } else if (localStreamRef.current && !isInactiveStateRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()?.[0];
      if (videoTrack) {
        const wantCam = camUserPreferenceRef.current === true;
        videoTrack.enabled = wantCam;
        setCamOn(wantCam);
      }
    }
    
    if (localStreamRef.current) {
      preCreatePeerConnection();
    }
    
    try { socket.emit('next'); } catch {}
    setLoading(true);
    setIsNexting(false);
  }, [stopRemoteOnly, startLocalStream, isDirectCall, isNexting, started]);

  // --------------------------
  // Local toggles
  // --------------------------
  const toggleMic = useCallback(async () => {
    // Используем localStreamRef.current для работы даже когда компонент размонтирован (в PiP)
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
      // Обновляем micLevel=0 в PiP и останавливаем метр
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
    // Используем refs для работы даже когда компонент размонтирован (в PiP)
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
      camUserPreferenceRef.current = newValue;
      explicitCamToggledRef.current = true;

      videoTrack.enabled = newValue;

      // Синхронизируем состояние камеры у собеседника: показываем/убираем заглушку «Отошел»
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
      const currentRoomId = roomIdRef.current;
      try {
        const payload: any = { enabled: newValue, from: socket.id };
        // Для звонков друг-друг добавляем roomId, если он есть
        if (isFriendCall && currentRoomId) {
          payload.roomId = currentRoomId;
        }
        socket.emit('cam-toggle', payload);
      } catch (e) {
        logger.warn('[toggleCam] Error emitting cam-toggle:', e);
      }

      if (!newValue) {
        setLocalRenderKey(prev => prev + 1);
      }

      return newValue;
    });
  }, [partnerId, isDirectCall, inDirectCall, friendCallAccepted]);

  // Глобальная защита: если пользователь предпочёл камеру off — не даём её включать автоматически
  useEffect(() => {
    if (camUserPreferenceRef.current === false) {
      const s = localStreamRef.current || localStream;
      const v = s?.getVideoTracks?.()?.[0];
      if (v && v.enabled) {
        try { v.enabled = false; } catch {}
      }
      if (camOn) setCamOn(false);
    }
  }, [localStream, started, partnerId, remoteStream, pcConnected]);


  const toggleRemoteAudio = useCallback(() => {
    // Используем remoteStream или pip.remoteStream для работы даже когда компонент размонтирован (в PiP)
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
    
    // Регистрируем функцию очистки в глобальном месте
    // Это нужно чтобы можно было вызвать очистку даже когда компонент размонтирован (в PiP)
    try {
      if ((global as any).__endCallCleanupRef) {
        (global as any).__endCallCleanupRef.current = onAbortCall;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering endCall cleanup:', e);
    }
    
    // Регистрируем функцию переключения микрофона в глобальном месте
    // Это нужно чтобы можно было запустить startMicMeter даже когда компонент размонтирован (в PiP)
    try {
      if ((global as any).__toggleMicRef) {
        (global as any).__toggleMicRef.current = toggleMic;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering toggleMic:', e);
    }
    
    // Регистрируем функцию переключения удаленного аудио в глобальном месте
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
      
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      if (isInactiveState) {
        console.log('[showPiPOnExit] In inactive state, skipping PiP');
        return;
      }
      
      // Сохраняем partnerUserId в navParams для восстановления при возврате
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
          partnerId: partnerId || partnerIdRef.current, // Сохраняем partnerId для восстановления соединения
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
      
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
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
      try { 
        currentCallIdRef.current = d?.callId || null;
      } catch {}
      // НЕ присоединяемся к комнате здесь - roomId будет установлен в call:accepted
      // callId используется только для отслеживания звонка, не для комнаты
      // Комната создается на бэкенде при принятии звонка с форматом room_<socketId1>_<socketId2>
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
    const camToggleHandler = ({ enabled, from }: { enabled: boolean; from: string }) => {
      camToggleSeenRef.current = true;
      // УПРОЩЕНО: только один собеседник
      // Используем refs для актуальных значений
      const currentPartnerId = partnerIdRef.current;
      const currentRoomId = roomIdRef.current;
      const currentRemoteCamOn = remoteCamOnRef.current;
      const currentRemoteStream = remoteStreamRef.current;
      // isDirectCall - это prop из route, не меняется, можно использовать напрямую
      const currentInDirectCall = inDirectCallRef.current;
      const currentFriendCallAccepted = friendCallAcceptedRef.current;
      
      
      // Для звонков друзей проверяем наличие активной комнаты или прямого звонка
      const isDirectFriendCall = isDirectCall || currentInDirectCall || currentFriendCallAccepted;
      // Для звонков «друг-друг» принимаем событие без дополнительных проверок,
      // так как соединение строго 1-на-1 и событие приходит только от собеседника.
      // Для рандомного чата продолжаем чекать socket.id.
      const shouldProcess = isDirectFriendCall
        ? true
        : (partnerIdRef.current === from);
      
      if (!shouldProcess) {
        return;
      }
      
      // если partnerId ещё не восстановился — поднимаем его из 'from' (для рандомного чата)
      if (!isDirectFriendCall && !currentPartnerId) {
        partnerIdRef.current = from;
        setPartnerId(from);
      }

      remoteForcedOffRef.current = !enabled;

      const newRemoteCamOn = !!enabled;
      setRemoteCamOn(newRemoteCamOn);
      remoteCamOnRef.current = newRemoteCamOn;
      
      try {
        const rs = currentRemoteStream;
        const vt = (rs as any)?.getVideoTracks?.()?.[0];
        if (vt) {
          if (!enabled && vt.enabled) {
            vt.enabled = false;
          } else if (enabled && !vt.enabled) {
            vt.enabled = true;
          }
        }
      } catch (e) {
        logger.warn('[cam-toggle] Error toggling remote track:', e);
      }

      setRemoteViewKey(Date.now());
      
      if (enabled) {
        setPartnerInPiP(false);
      } else {
        setPartnerInPiP(false);
      }
    };
    
    socket.on("cam-toggle", camToggleHandler);
  
    return () => {
      offIncoming?.();
      socket.off("cam-toggle", camToggleHandler);
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
    // onPresenceUpdate - НЕ вызываем fetchFriends в рандомном чате
    // Обновления присутствия не связаны с проверкой, является ли текущий собеседник другом
    // Список друзей обновляется только:
    // 1. При инициализации компонента
    // 2. При получении нового матча (handleMatchFound, handleOffer, handleAnswer) - чтобы проверить бейдж "друг"
    // 3. При добавлении/принятии друзей (onFriendAdded, onFriendAccepted)
    const offPresence = onPresenceUpdate?.((_list) => {
      // В рандомном чате не нужно обновлять список друзей при каждом обновлении присутствия
      // Это не влияет на то, является ли текущий собеседник другом
    });
    const offDecl = onFriendDeclined?.(({ userId }: { userId: string }) => {
      setAddPending(false);
      setAddBlocked(true);
      const lastTo = lastFriendRequestToRef.current;
      if (lastTo && String(lastTo) === String(userId || partnerUserId)) {
        showToast('Вам отказано');
      }
      try { lastFriendRequestToRef.current = null; } catch {}
    });

    return () => { 
      offReq?.(); 
      offAdded?.(); 
      offAccepted?.(); 
      offPresence?.(); 
      offDecl?.();
    };
  }, [partnerUserId, showToast]);

  // Сброс флага "отказано" при новом матч-идентификаторе: пользователь может снова отправить заявку
  useEffect(() => { setAddPending(false); setAddBlocked(false); clearDeclinedBlock(); }, [partnerId]);

  // --------------------------
  // Signaling (single initiator)
  // --------------------------
  const attachRemoteHandlers = useCallback((pc: RTCPeerConnection, setToId?: string) => {
    // КРИТИЧНО: Логируем ВСЕГДА в самом начале, даже до проверок
    console.log('[attachRemoteHandlers] ===== ENTRY =====', {
      pcExists: !!pc,
      pcSignalingState: pc?.signalingState,
      pcConnectionState: pc?.connectionState,
      setToId,
      hasFlag: (pc as any)?._remoteHandlersAttached === true,
      hasOntrack: !!(pc as any).ontrack,
      pcDebugId: (pc as any)?._debugId,
      caller: new Error().stack?.split('\n')[2]?.trim()
    });
    
    // КРИТИЧНО: Проверяем, не установлен ли уже ontrack, чтобы не перезаписывать его
    // Используем флаг на PC объекте для более надежной проверки
    if ((pc as any)._remoteHandlersAttached === true) {
      console.log('[attachRemoteHandlers] ===== SKIPPED: ontrack already attached =====', {
        pcExists: !!pc,
        pcSignalingState: pc?.signalingState,
        pcConnectionState: pc?.connectionState,
        setToId,
        pcDebugId: (pc as any)?._debugId,
        hasOntrack: !!(pc as any).ontrack
      });
      return; // Не перезаписываем, если уже установлен наш обработчик
    }
    
    const existingOntrack = (pc as any).ontrack;
    
    // КРИТИЧНО: Логируем ВСЕГДА, даже если есть ошибки
    try {
      console.log('[attachRemoteHandlers] ===== CALLED =====', {
        pcExists: !!pc,
        pcSignalingState: pc?.signalingState,
        pcConnectionState: pc?.connectionState,
        setToId,
        hasOntrack: !!existingOntrack,
        pcDebugId: (pc as any)?._debugId,
        stackTrace: new Error().stack?.split('\n').slice(0, 5).join('\n')
      });
    } catch (e) {
      console.error('[attachRemoteHandlers] Error in initial log:', e);
    }
    
    const handleRemote = (e: any) => {
      console.log('[handleRemote] ===== EVENT FIRED =====', {
        hasEvent: !!e,
        hasStreams: !!e?.streams,
        streamsLength: e?.streams?.length,
        hasStream: !!e?.stream,
        streamId: e?.stream?.id || e?.streams?.[0]?.id
      });
      
      try {
        const rs = e?.streams?.[0] ?? e?.stream;
        if (!rs || !isValidStream(rs)) {
          console.log('[handleRemote] Invalid or missing remote stream', { 
            hasStream: !!rs,
            isValid: rs ? isValidStream(rs) : false
          });
          return;
        }

        // КРИТИЧНО: Проверяем, не является ли удаленный stream локальным
        // Для прямых звонков эта проверка может быть слишком строгой, поэтому добавляем проверку на isDirectFriendCall
        if (Platform.OS !== 'android') {
          try { 
            const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
            if (localStreamRef.current && (rs as any)?.id === (localStreamRef.current as any)?.id) {
              // Для прямых звонков не игнорируем stream, если это действительно удаленный stream
              // Проверяем, что это не локальный stream, сравнивая tracks
              const localVideoTrack = localStreamRef.current?.getVideoTracks?.()?.[0];
              const remoteVideoTrack = rs?.getVideoTracks?.()?.[0];
              const isSameTrack = localVideoTrack && remoteVideoTrack && localVideoTrack.id === remoteVideoTrack.id;
              
              if (isSameTrack && !isDirectFriendCall) {
                console.log('[handleRemote] Ignoring local stream as remote', {
                  streamId: rs.id,
                  localStreamId: localStreamRef.current?.id,
                  isDirectFriendCall,
                  isSameTrack
                });
                return;
              } else if (isSameTrack && isDirectFriendCall) {
                console.log('[handleRemote] WARNING: Same stream ID for direct call, but allowing (may be WebRTC bug)', {
                  streamId: rs.id,
                  localStreamId: localStreamRef.current?.id,
                  isDirectFriendCall,
                  isSameTrack
                });
                // Для прямых звонков не игнорируем, даже если ID совпадают
                // Это может быть баг WebRTC, но мы все равно попробуем обработать stream
              }
            } 
          } catch (e) {
            console.warn('[handleRemote] Error checking local stream:', e);
          }
        }

        // УПРОЩЕНО: только один remoteStream для 1-на-1
        if (isValidStream(rs)) {
            const videoTracks = rs.getVideoTracks?.() || [];
            const audioTracks = rs.getAudioTracks?.() || [];
            const videoTrack = videoTracks[0];
            const audioTrack = audioTracks[0];
            
            console.log('[handleRemote] ===== START: Setting remote stream =====', { 
              streamId: rs.id,
              isDirectCall,
              inDirectCall,
              friendCallAccepted,
              partnerUserId: partnerUserIdRef.current,
              videoTracksCount: videoTracks.length,
              audioTracksCount: audioTracks.length,
              hasExistingRemoteStream: !!remoteStream,
              existingRemoteStreamId: remoteStream?.id,
              currentRemoteCamOn: remoteCamOnRef.current,
              videoTrackEnabled: videoTrack?.enabled,
              videoTrackReadyState: videoTrack?.readyState,
              audioTrackEnabled: audioTrack?.enabled,
              audioTrackReadyState: audioTrack?.readyState
            });
            
            // Для второго и последующих вызовов - очищаем старый remote stream перед установкой нового
            // Это гарантирует что новый stream установится правильно
            // Проверяем и state и ref, так как они могут быть рассинхронизированы при повторных вызовах
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
                  } catch {}
                });
              } catch {}
              setRemoteStream(null);
              remoteStreamRef.current = null;
              
              setTimeout(() => {
                try { 
                  setRemoteStream(rs); 
                  remoteStreamRef.current = rs;
                } catch (e) {
                  logger.error('[handleRemote] Error setting remote stream:', e);
                }
              }, 50);
              return; // Выходим, установка произойдет в setTimeout
            }
            
            // КРИТИЧНО: Всегда устанавливаем remote stream для прямых звонков
            // Проверяем, это ли тот же stream (когда приходит новый track к существующему stream)
            const currentRemoteStream = remoteStreamRef.current || remoteStream;
            const isSameStream = currentRemoteStream && currentRemoteStream.id === rs.id;
            
            // Для прямых звонков ВСЕГДА устанавливаем remote stream, даже если это тот же stream
            // Это гарантирует отображение видео у обоих пользователей
            const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
            
            console.log('[handleRemote] Stream comparison', {
              isSameStream,
              isDirectFriendCall,
              currentStreamId: currentRemoteStream?.id,
              newStreamId: rs.id,
              willUpdateStream: !isSameStream || isDirectFriendCall
            });
            
            // Устанавливаем новый remote stream (для первого вызова или когда stream ID не совпадает)
            // Если это тот же stream, но с новым track, обновляем state для ререндера
            try { 
              if (!isSameStream || isDirectFriendCall) {
                // Для прямых звонков всегда обновляем state, даже если stream ID совпадает
                // Это гарантирует отображение видео при повторных звонках
                console.log('[handleRemote] Setting remote stream in state', {
                  isSameStream,
                  isDirectFriendCall,
                  streamId: rs.id
                });
                setRemoteStream(rs); 
                remoteStreamRef.current = rs;
                // Принудительно обновляем remoteViewKey при установке нового stream
                // для повторных звонков, чтобы гарантировать отображение видеопотока
                const newViewKey = Date.now();
                setRemoteViewKey(newViewKey);
                console.log('[handleRemote] Updated remoteViewKey:', newViewKey);
                
                // Если video track уже есть в новом stream, ВСЕГДА устанавливаем remoteCamOn в true
                // Это особенно важно при повторных звонках и плохом интернете
                // КРИТИЧНО: Для прямых звонков ВСЕГДА показываем видео, если track есть и enabled
                const videoTrack = rs.getVideoTracks?.()?.[0];
                console.log('[handleRemote] Checking video track for remoteCamOn', {
                  hasVideoTrack: !!videoTrack,
                  videoTrackEnabled: videoTrack?.enabled,
                  videoTrackReadyState: videoTrack?.readyState,
                  isDirectFriendCall,
                  canAutoShowRemote: canAutoShowRemote(),
                  remoteCamOnRefCurrent: remoteCamOnRef.current
                });
                
                if (videoTrack && videoTrack.readyState !== 'ended' && videoTrack.enabled === true) {
                  if (isDirectFriendCall) {
                    // Для прямых звонков ВСЕГДА показываем видео, если track enabled
                    const oldRemoteCamOn = remoteCamOnRef.current;
                    setRemoteCamOn(true);
                    remoteCamOnRef.current = true;
                    console.log('[handleRemote] ✅ Direct call: Force set remoteCamOn=true', {
                      oldValue: oldRemoteCamOn,
                      newValue: true,
                      videoTrackEnabled: videoTrack.enabled,
                      videoTrackReadyState: videoTrack.readyState
                    });
                  } else {
                    const canAuto = canAutoShowRemote();
                    const refValue = remoteCamOnRef.current;
                    console.log('[handleRemote] Random chat: Checking conditions for remoteCamOn', {
                      canAutoShowRemote: canAuto,
                      remoteCamOnRefCurrent: refValue,
                      willSet: canAuto && refValue
                    });
                    if (canAuto && refValue) {
                      setRemoteCamOn(true);
                      console.log('[handleRemote] ✅ Random chat: Set remoteCamOn=true');
                    } else {
                      console.log('[handleRemote] ❌ Random chat: NOT setting remoteCamOn', {
                        canAutoShowRemote: canAuto,
                        remoteCamOnRefCurrent: refValue
                      });
                    }
                  }
                } else {
                  console.log('[handleRemote] ❌ Video track not suitable for remoteCamOn', {
                    hasVideoTrack: !!videoTrack,
                    videoTrackEnabled: videoTrack?.enabled,
                    videoTrackReadyState: videoTrack?.readyState
                  });
                }
              } else {
                console.log('[handleRemote] Same stream, checking for new video track', {
                  streamId: rs.id,
                  isDirectFriendCall,
                  currentRemoteStream: remoteStream?.id,
                  currentRemoteCamOn: remoteCamOnRef.current
                });
                remoteStreamRef.current = rs;
                // Принудительно обновляем state для ререндера когда появляется video track
                const videoTracks = rs.getVideoTracks?.() || [];
                if (videoTracks.length > 0) {
                  console.log('[handleRemote] Video track found in same stream, updating state', {
                    videoTracksCount: videoTracks.length,
                    isDirectFriendCall,
                    videoTrackEnabled: videoTracks[0]?.enabled,
                    videoTrackReadyState: videoTracks[0]?.readyState
                  });
                  // КРИТИЧНО: Для прямых звонков ВСЕГДА обновляем remoteStream в state когда появляется video track
                  // Это особенно важно при повторных звонках, когда stream может быть уже установлен, но без video track
                  // Используем новый объект для принудительного обновления React
                  if (isDirectFriendCall) {
                    // Для прямых звонков принудительно обновляем remoteStream даже если stream ID совпадает
                    // Это гарантирует, что useEffect сработает и remoteCamOn будет установлен правильно
                    setRemoteStream(rs);
                    remoteStreamRef.current = rs;
                    console.log('[handleRemote] Direct call: Force updated remoteStream for video track');
                  } else {
                    setRemoteStream(rs);
                  }
                  // Обновляем remoteViewKey при появлении video track
                  const newViewKey = Date.now();
                  setRemoteViewKey(newViewKey);
                  console.log('[handleRemote] Updated remoteViewKey for new video track:', newViewKey);
                  
                  // Устанавливаем remoteCamOn в true когда появляется video track
                  // ВСЕГДА устанавливаем в true если track существует и не ended
                  // Это гарантирует отображение видео даже при плохом интернете
                  // КРИТИЧНО: Для прямых звонков ВСЕГДА показываем видео, если track есть и enabled
                  const vt = videoTracks[0];
                  console.log('[handleRemote] Checking video track for remoteCamOn (same stream)', {
                    hasVideoTrack: !!vt,
                    videoTrackEnabled: vt?.enabled,
                    videoTrackReadyState: vt?.readyState,
                    isDirectFriendCall,
                    canAutoShowRemote: canAutoShowRemote(),
                    remoteCamOnRefCurrent: remoteCamOnRef.current
                  });
                  
                  if (vt && vt.readyState !== 'ended' && vt.enabled === true) {
                    if (isDirectFriendCall) {
                      // Для прямых звонков ВСЕГДА показываем видео, если track enabled
                      const oldRemoteCamOn = remoteCamOnRef.current;
                      setRemoteCamOn(true);
                      remoteCamOnRef.current = true;
                      console.log('[handleRemote] ✅ Direct call: Force set remoteCamOn=true for new video track (same stream)', {
                        oldValue: oldRemoteCamOn,
                        newValue: true,
                        videoTrackEnabled: vt.enabled,
                        videoTrackReadyState: vt.readyState
                      });
                    } else {
                      const canAuto = canAutoShowRemote();
                      const refValue = remoteCamOnRef.current;
                      console.log('[handleRemote] Random chat: Checking conditions for remoteCamOn (same stream)', {
                        canAutoShowRemote: canAuto,
                        remoteCamOnRefCurrent: refValue,
                        willSet: canAuto && refValue
                      });
                      if (canAuto && refValue) {
                        // Уважаем cam-toggle=false и remoteForcedOffRef для рандомных чатов
                        setRemoteCamOn(true);
                        console.log('[handleRemote] ✅ Random chat: Set remoteCamOn=true (same stream)');
                      } else {
                        console.log('[handleRemote] ❌ Random chat: NOT setting remoteCamOn (same stream)', {
                          canAutoShowRemote: canAuto,
                          remoteCamOnRefCurrent: refValue
                        });
                      }
                    }
                  } else {
                    console.log('[handleRemote] ❌ Video track not suitable for remoteCamOn (same stream)', {
                      hasVideoTrack: !!vt,
                      videoTrackEnabled: vt?.enabled,
                      videoTrackReadyState: vt?.readyState
                    });
                  }
                } else {
                  const audioTracks = rs.getAudioTracks?.() || [];
                  console.log('[handleRemote] No video track, checking audio tracks', {
                    audioTracksCount: audioTracks.length
                  });
                  if (audioTracks.length > 0) {
                    setRemoteStream(rs);
                    console.log('[handleRemote] Set remote stream for audio only');
                  }
                }
              }
            } catch (e) {
              logger.error('[handleRemote] Error setting remote stream:', e);
            }
            const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!partnerUserId;
            if (isFriendCall) {
              try {
                setPartnerInPiP(false);
              } catch {}
            }
            
            const hasVideoTrack = !!(rs as any)?.getVideoTracks?.()?.[0];
            console.log('[handleRemote] Final check for video track', {
              hasVideoTrack,
              isDirectFriendCall,
              currentRemoteCamOn: remoteCamOnRef.current
            });
            
            if (hasVideoTrack) {
              try {
                const vt = (rs as any).getVideoTracks()[0];
                const isLive = (vt.readyState === 'live' || vt.readyState === 'ready');
                const isEnabled = vt.enabled === true;
                
                console.log('[handleRemote] Final video track check', {
                  readyState: vt.readyState,
                  enabled: vt.enabled,
                  isLive,
                  isEnabled,
                  isDirectFriendCall,
                  canAutoShowRemote: canAutoShowRemote(),
                  remoteCamOnRefCurrent: remoteCamOnRef.current
                });
                
                if (isLive && isEnabled) {
                  // КРИТИЧНО: Для прямых звонков ВСЕГДА показываем видео, если track enabled
                  if (isDirectFriendCall) {
                    const oldRemoteCamOn = remoteCamOnRef.current;
                    setRemoteCamOn(true);
                    remoteCamOnRef.current = true;
                    console.log('[handleRemote] ✅ Direct call: Force set remoteCamOn=true for live video track (final check)', {
                      oldValue: oldRemoteCamOn,
                      newValue: true,
                      readyState: vt.readyState,
                      enabled: vt.enabled
                    });
                  } else {
                    const canAuto = canAutoShowRemote();
                    const refValue = remoteCamOnRef.current;
                    console.log('[handleRemote] Random chat: Final check for remoteCamOn', {
                      canAutoShowRemote: canAuto,
                      remoteCamOnRefCurrent: refValue,
                      willSet: canAuto && refValue
                    });
                    if (canAuto && refValue) {
                      setRemoteCamOn(true);
                      console.log('[handleRemote] ✅ Random chat: Set remoteCamOn=true (final check)');
                    } else {
                      console.log('[handleRemote] ❌ Random chat: NOT setting remoteCamOn (final check)', {
                        canAutoShowRemote: canAuto,
                        remoteCamOnRefCurrent: refValue
                      });
                    }
                  }
                } else {
                  console.log('[handleRemote] ❌ Video track not live or not enabled (final check)', {
                    readyState: vt.readyState,
                    enabled: vt.enabled,
                    isLive,
                    isEnabled
                  });
                }
              } catch (e) {
                logger.warn('[handleRemote] Error checking video track:', e);
              }
            }
            
            console.log('[handleRemote] ===== END: Remote stream setup complete =====', {
              streamId: rs.id,
              remoteStreamSet: !!remoteStreamRef.current,
              remoteCamOn: remoteCamOnRef.current,
              isDirectFriendCall,
              partnerUserId: partnerUserIdRef.current
            });
            
            // Для звонков друзьям запускаем метры при получении remoteStream
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
                logger.warn('[handleRemote] Error starting mic meter:', e);
              }
            }
            
            try {
              setLoading(false);
              setStarted(true);
              
              const localVideoTrack = localStreamRef.current?.getVideoTracks()?.[0];
              if (localVideoTrack) {
                const wantCam = camUserPreferenceRef.current === true;
                localVideoTrack.enabled = wantCam;
                setCamOn(wantCam);
              }
              
              // Не форсируем camOn для рандом-чата — уважаем camUserPreferenceRef
            } catch (e) {
              console.error('[handleRemote] Error setting started/camOn:', e);
            } // Сбрасываем loading при получении потока

            // Явно включаем видео и аудио треки если они есть и выключены
            // Это особенно важно при втором вызове, когда remote stream может не отображаться
            try {
              const vt = (rs as any)?.getVideoTracks?.()?.[0];
              const at = (rs as any)?.getAudioTracks?.()?.[0];
              
              // Включаем видео трек
              if (vt) {
                if (!vt.enabled) {
                  vt.enabled = true;
                  console.log('[handleRemote] Enabled remote video track');
                }
                // Убеждаемся что трек действительно active
                if (vt.readyState !== 'live') {
                  console.warn('[handleRemote] Remote video track is not live:', vt.readyState);
                }
              }
              
              // ВАЖНО: Включаем аудио трек для звука СРАЗУ при получении remote stream
              // Звук должен работать сразу при подключении собеседника
              if (at) {
                // ВСЕГДА включаем audio track сразу, даже если он уже enabled
                // Это гарантирует, что звук работает сразу при подключении
                at.enabled = true;
                console.log('[handleRemote] Enabled remote audio track for sound immediately', {
                  wasEnabled: at.enabled,
                  readyState: at.readyState,
                  trackId: at.id
                });
                // Убеждаемся что трек действительно active
                if (at.readyState !== 'live') {
                  console.warn('[handleRemote] Remote audio track is not live yet:', at.readyState, '- will work when live');
                } else {
                  console.log('[handleRemote] Remote audio track is live, sound should work NOW');
                }
              } else {
                console.warn('[handleRemote] No audio track found in remote stream - sound will not work');
              }
              
              // Проверяем наличие треков
              if (!vt && !at) {
                console.warn('[handleRemote] No tracks found in remote stream');
              }
            } catch (e) {
              console.warn('[handleRemote] Error enabling remote tracks:', e);
            }
            
            // Принудительно обновляем remoteViewKey для гарантированного ререндера
            // Это особенно важно при втором и последующих вызовах
            try {
              setRemoteViewKey(Date.now());
            } catch {}

            // Bump ключа для принудительного ререндера при первом приходе видео
            // Это особенно важно при повторных звонках
            try {
              const vt = (rs as any)?.getVideoTracks?.()?.[0];
              if (vt) {
                const liveAndEnabled = vt.readyState === 'live' && vt.enabled === true;
                if (liveAndEnabled) {
                  setRemoteViewKey(Date.now());
                  // remoteCamOn=true только если трек действительно live И включён и не был явно выключен cam-toggle
                  if (canAutoShowRemote() && remoteCamOnRef.current) {
                    setRemoteCamOn(true);
                  }
                  console.log('[handleRemote] Video track is live and enabled, updated remoteViewKey and remoteCamOn');
                } else {
                  // НЕ поднимаем remoteCamOn автоматически, если трек выключен или не live.
                  // Оставляем состояние согласно cam-toggle.
                  console.log('[handleRemote] Remote video track not live/enabled, keep remoteCamOn as is', {
                    readyState: vt.readyState,
                    enabled: vt.enabled
                  });
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

    const oldOntrack = (pc as any).ontrack;
    // Сохраняем ссылку на PC для отладки
    const pcId = `PC_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    (pc as any)._debugId = pcId;
    
    (pc as any).ontrack = (e: any) => {
      // КРИТИЧНО: Логируем ВСЕГДА, даже если есть ошибки
      // Логируем СРАЗУ, до любых проверок
      console.log('[attachRemoteHandlers] ===== ONTRACK EVENT FIRED (IMMEDIATE) =====', {
        pcId,
        pcDebugId: (pc as any)?._debugId,
        pcSignalingState: pc?.signalingState,
        pcConnectionState: pc?.connectionState,
        hasEvent: !!e,
        hasStreams: !!e?.streams,
        streamsLength: e?.streams?.length,
        hasStream: !!e?.stream,
        streamId: e?.stream?.id || e?.streams?.[0]?.id,
        handlerFunction: typeof handleRemote,
        currentOntrack: typeof (pc as any).ontrack,
        timestamp: Date.now()
      });
      
      try {
        console.log('[attachRemoteHandlers] ===== ONTRACK EVENT FIRED (DETAILED) =====', {
          pcId,
          pcDebugId: (pc as any)?._debugId,
          pcSignalingState: pc?.signalingState,
          pcConnectionState: pc?.connectionState,
          hasEvent: !!e,
          hasStreams: !!e?.streams,
          streamsLength: e?.streams?.length,
          hasStream: !!e?.stream,
          streamId: e?.stream?.id || e?.streams?.[0]?.id,
          handlerFunction: typeof handleRemote,
          currentOntrack: typeof (pc as any).ontrack
        });
      } catch (logErr) {
        console.error('[attachRemoteHandlers] Error in ontrack log:', logErr);
      }
      
      try {
        console.log('[attachRemoteHandlers] ===== CALLING handleRemote =====', {
          pcId,
          hasEvent: !!e,
          hasStreams: !!e?.streams
        });
        handleRemote(e);
        console.log('[attachRemoteHandlers] ===== handleRemote CALLED SUCCESSFULLY =====', {
          pcId
        });
      } catch (handleErr) {
        console.error('[attachRemoteHandlers] Error in handleRemote:', handleErr);
      }
    };
    
    // КРИТИЧНО: Устанавливаем флаг, что обработчики уже установлены
    (pc as any)._remoteHandlersAttached = true;
    
    // КРИТИЧНО: Проверяем что ontrack установлен правильно
    const actualOntrack = (pc as any).ontrack;
    console.log('[attachRemoteHandlers] ===== SET ONTRACK HANDLER =====', {
      pcId,
      pcDebugId: (pc as any)?._debugId,
      hadOldHandler: !!oldOntrack,
      newHandlerSet: !!actualOntrack,
      pcSignalingState: pc?.signalingState,
      pcConnectionState: pc?.connectionState,
      handlerType: typeof actualOntrack,
      handlerIsFunction: typeof actualOntrack === 'function',
      handlerMatches: actualOntrack === (pc as any).ontrack,
      flagSet: (pc as any)._remoteHandlersAttached
    });
    
    // КРИТИЧНО: Проверяем что ontrack не был перезаписан
    setTimeout(() => {
      const currentOntrack = (pc as any).ontrack;
      if (currentOntrack !== actualOntrack) {
        console.error('[attachRemoteHandlers] WARNING: ontrack was overwritten!', {
          pcId,
          originalHandler: typeof actualOntrack,
          currentHandler: typeof currentOntrack
        });
      }
    }, 100);
    
    // Добавляем альтернативный обработчик для совместимости
    const oldOnaddstream = (pc as any).onaddstream;
    (pc as any).onaddstream = (e: any) => {
      console.log('[attachRemoteHandlers] onaddstream fired', {
        hasStream: !!e?.stream,
        streamId: e?.stream?.id
      });
      if (e?.stream) {
        handleRemote({ stream: e.stream });
      }
    };
    console.log('[attachRemoteHandlers] Set onaddstream handler', {
      hadOldHandler: !!oldOnaddstream,
      newHandlerSet: !!(pc as any).onaddstream
    });

    (pc as any).onicecandidate = (e: any) => {
      if (e.candidate && setToId) {
        // КРИТИЧНО: Для прямых звонков отправляем ice-candidate с roomId для гарантированной доставки
        const currentRoomId = roomIdRef.current;
        const isDirectFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
        const candidatePayload: any = { to: setToId, candidate: e.candidate };
        if (isDirectFriendCall && currentRoomId) {
          candidatePayload.roomId = currentRoomId;
        }
        socket.emit('ice-candidate', candidatePayload);
      }
    };
  }, [remoteStream, remoteCamOn, loading, isDirectCall, inDirectCall, friendCallAccepted, partnerUserId, startMicMeter, roomIdRef]);

  

  const restartCooldownRef = useRef<number>(0);
  const iceRestartInProgressRef = useRef<boolean>(false);
  const tryIceRestart = useCallback(async (pc: RTCPeerConnection, toId: string) => {
    try {
      if (!pc) return;
      
      if (iceRestartInProgressRef.current) return;
      
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
      
      const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
      if (isInactiveStateRef.current || !hasActiveCall) return;
      
      const now = Date.now();
      if (restartCooldownRef.current > now) return;
      restartCooldownRef.current = now + 10000;
      iceRestartInProgressRef.current = true;
      
      if (!peerRef.current || peerRef.current !== pc) {
        iceRestartInProgressRef.current = false;
        return;
      }
      
      const offer = await pc.createOffer({ iceRestart: true } as any);
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: toId, offer });
      
      setTimeout(() => {
        iceRestartInProgressRef.current = false;
      }, 5000);
    } catch (err) {
      logger.error('[tryIceRestart] Error:', err);
      iceRestartInProgressRef.current = false;
    }
  }, []);

  const bindConnHandlers = (pc: RTCPeerConnection, expectedPartnerId?: string) => {
    const bump = () => {
      // СНАЧАЛА проверяем что PC все еще валиден (не закрыт и не null)
      if (!pc || pc.signalingState === 'closed' || (pc as any).connectionState === 'closed') {
        return;
      }
      
      // СНАЧАЛА проверяем что звонок не завершен - это самая важная проверка
      // Делаем это ДО проверки peerRef, чтобы не обрабатывать события от завершенного звонка
      if (isInactiveStateRef.current) {
        return; // НЕ обрабатываем никакие изменения состояния если звонок завершен
      }
      
      // Проверяем что это все еще тот же PC, на который ссылается peerRef
      // Если PC был заменен или удален, игнорируем изменения старого PC
      if (!peerRef.current || peerRef.current !== pc) {
        return;
      }
      
      // Дополнительная проверка - если refs очищены, не обрабатываем события
      const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
      if (!hasActiveCall) {
        return;
      }
      
      // Дополнительная проверка - если звонок завершен, не обрабатываем соединение
      if (isInactiveStateRef.current || !hasActiveCall) {
        return; // Уже проверили выше, но проверяем еще раз перед обработкой соединения
      }
      
      const st = (pc as any).connectionState || pc.iceConnectionState;
      const ok = st === 'connected' || st === 'completed';
      pcConnectedRef.current = ok;
      setPcConnected(ok);
      if (ok) {
        // Проверяем что это соединение с текущим партнером, а не со старым
        const currentPartnerId = partnerIdRef.current;
        if (expectedPartnerId && expectedPartnerId !== currentPartnerId) {
          return; // Игнорируем соединение со старым партнером
        }
        
        // Проверяем что звонок все еще активен перед запуском метра
        //, потому что обработчик может сработать после завершения звонка
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        if (isInactiveStateRef.current || !hasActiveCall) {
          return; // НЕ запускаем метры если звонок завершен
        }
        
        startMicMeter();
        // Сбрасываем loading при успешном соединении с ТЕКУЩИМ партнером
        setLoading(false);
        setIsNexting(false); // Сбрасываем блокировку кнопки при успешном соединении
      } else {
        stopMicMeter();
      }

      // УПРОЩЕНО: Авто-ICE рестарт при сбоях (только один PC)
      if (st === 'failed' || st === 'disconnected') {
        // Не пытаемся перезапустить если звонок завершен
        // Проверяем СНАЧАЛА isInactiveState - это самая важная проверка
        // Проверяем ДО всех остальных проверок, чтобы избежать race condition
        if (isInactiveStateRef.current) {
          return;
        }
        
        // Проверяем что peerRef.current все еще указывает на этот PC
        // Это должно быть проверено ДО проверки hasActiveCall
        if (!peerRef.current || peerRef.current !== pc) {
          return;
        }
        
        // Проверяем наличие активного звонка
        const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
        if (!hasActiveCall) {
          return;
        }
        
        // Проверяем еще раз isInactiveState после всех проверок (на случай если изменился)
        //, потому что обработчик может сработать асинхронно после завершения звонка
        if (isInactiveStateRef.current) {
          return;
        }
        
        // Не пытаемся перезапустить если приложение в background (заблокирован экран)
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
  
  const ensurePcWithLocal = useCallback(async (stream: MediaStream): Promise<RTCPeerConnection | null> => {
    // Вспомогательная функция для получения ICE конфигурации
    const getIceConfig = (): RTCConfiguration => {
      // Используем кэшированную конфигурацию если доступна
      if (iceConfigRef.current) {
        return iceConfigRef.current;
      }
      return getEnvFallbackConfiguration();
    };
    
    // При возврате из PiP проверяем существующий PC
    // Если PC существует и валиден - возвращаем его, иначе создаем новый
    if (resume && fromPiP) {
      const existingPc = peerRef.current;
      if (existingPc) {
        try {
          // Проверяем что PC еще валиден
          const state = existingPc.signalingState;
          if (state !== 'closed') {
            return existingPc;
          }
        } catch {}
      }
    }
    
    let pc = peerRef.current;
    
     // Проверяем состояние существующего PC
     // Если PC существует, проверяем что он в правильном состоянии для переиспользования
     if (pc) {
       try {
         // Пытаемся получить состояние PC
         const state = pc.signalingState;
         const hasLocalDesc = !!(pc as any)?.currentLocalDescription || !!(pc as any)?.localDescription;
         const hasRemoteDesc = !!(pc as any)?.currentRemoteDescription || !!(pc as any)?.remoteDescription;
         
        // Если у нас уже есть активный/используемый PC (есть локальное/удалённое описание),
        // НЕ закрываем его — просто переиспользуем. Закрываем только если PC реально невалиден (closed).
        const hasNoDescriptions = !hasLocalDesc && !hasRemoteDesc;
        const isInitial = state === 'stable' && hasNoDescriptions;
        const isClosed = state === 'closed' || (pc as any).connectionState === 'closed';
        
        if (isClosed) {
          try { 
            cleanupPeer(pc);
          } catch (e) {
            console.warn('[ensurePcWithLocal] Error cleaning up closed PC:', e);
          }
          pc = null;
          peerRef.current = null;
        } else if (!isInitial) {
          // PC уже в процессе/активе — возвращаем его как есть, треки ниже будут заменены/добавлены
          return pc;
        }
       } catch (e) {
         // Если не можем получить состояние - PC скорее всего закрыт или недоступен
         console.warn('[ensurePcWithLocal] Cannot access PC state, creating new one:', e);
         try { 
           cleanupPeer(pc);
         } catch {}
         pc = null;
         peerRef.current = null;
         // КРИТИЧНО: Запоминаем время закрытия PC для задержки перед созданием нового
         (global as any).__lastPcClosedAt = Date.now();
       }
     }
     
     // Также очищаем preCreatedPcRef перед созданием нового PC
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
        // Убеждаемся что stream существует и валиден перед созданием PC
        if (!stream || !isValidStream(stream)) {
          console.error('[ensurePcWithLocal] Cannot create PC - stream is invalid or null', {
            streamExists: !!stream,
            streamValid: stream ? isValidStream(stream) : false,
            streamId: stream?.id
          });
          return null;
        }
        
        // Дополнительная проверка валидности стрима перед созданием PC
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
        
        // Проверяем аудио трек тоже
        if (audioTrack && audioTrack.readyState === 'ended') {
          console.error('[ensurePcWithLocal] Audio track is ended, cannot create PC', {
            streamId: stream.id,
            audioTrackId: audioTrack.id,
            readyState: audioTrack.readyState
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
        
      let iceConfig: RTCConfiguration = getIceConfig();
      
      // КРИТИЧНО: Если недавно был закрыт PC (менее 2 секунд назад), добавляем задержку
      // чтобы нативный модуль успел освободить ресурсы
      const lastPcClosedAt = (global as any).__lastPcClosedAt;
      if (lastPcClosedAt && (Date.now() - lastPcClosedAt) < 2000) {
        const delay = 2000 - (Date.now() - lastPcClosedAt);
        console.log(`[ensurePcWithLocal] Waiting ${delay}ms before creating new PC after recent close`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      try {
        pc = new RTCPeerConnection(iceConfig); 
        peerRef.current = pc; 
          // Передаем текущий partnerId для проверки в bindConnHandlers
          bindConnHandlers(pc, partnerIdRef.current || undefined);
          // ВАЖНО: Устанавливаем обработчик ontrack сразу после создания PC
          // Это гарантирует что удаленные треки будут обработаны даже если attachRemoteHandlers
          // еще не был вызван из handleMatchFound или handleOffer
          if (partnerIdRef.current) {
            console.log('[ensurePcWithLocal] BEFORE calling attachRemoteHandlers', {
              partnerId: partnerIdRef.current,
              pcExists: !!pc,
              pcSignalingState: pc?.signalingState
            });
            attachRemoteHandlers(pc, partnerIdRef.current);
            console.log('[ensurePcWithLocal] AFTER calling attachRemoteHandlers', {
              partnerId: partnerIdRef.current,
              hasOntrack: !!(pc as any).ontrack,
              hasFlag: (pc as any)?._remoteHandlersAttached === true
            });
            console.log('[ensurePcWithLocal] Attached remote handlers immediately after PC creation', {
              partnerId: partnerIdRef.current
            });
          }
          console.log('[ensurePcWithLocal] Created new PeerConnection successfully', { 
            partnerId: partnerIdRef.current,
            pcSignalingState: pc.signalingState,
            iceServersCount: iceConfig.iceServers?.length || 0
          });
        } catch (createError: any) {
          console.error('[ensurePcWithLocal] RTCPeerConnection constructor failed:', createError, {
            errorMessage: createError?.message,
            errorStack: createError?.stack,
            streamId: stream.id,
            iceConfig: JSON.stringify(iceConfig)
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
  }, [bindConnHandlers, attachRemoteHandlers, resume, fromPiP]); 
  
  // Функция для предварительного создания PeerConnection
  const preCreatePeerConnection = useCallback(() => {
    // Не создаем PC вне активного звонка
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
    // Получаем ICE конфигурацию (используем кэш или fallback)
    const iceConfig = iceConfigRef.current || getEnvFallbackConfiguration();
    const pc = new RTCPeerConnection(iceConfig);
    
    // Добавляем только LIVE треки - не используем старые остановленные треки
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
    console.log('[handleMatchFound] Received match_found', {
      id,
      userId,
      roomId,
      currentPartnerId: partnerIdRef.current,
      hasPeerRef: !!peerRef.current,
      isDirectCall,
      inDirectCall,
      friendCallAccepted
    });
    
    const matchKey = `match_${id}`;
    if (processingOffersRef.current.has(matchKey)) {
      console.log('[handleMatchFound] Already processing offer for this match, skipping');
      return;
    }
    
    // КРИТИЧНО: Для прямых звонков используем inDirectCall и friendCallAccepted вместо isDirectCall
    // потому что isDirectCall может быть не установлен правильно из route params
    const isDirectFriendCall = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
    
    // КРИТИЧНО: Логируем определение isDirectFriendCall для отладки
    console.log('[handleMatchFound] Determining call type', {
      isDirectCall,
      inDirectCall: inDirectCallRef.current,
      friendCallAccepted: friendCallAcceptedRef.current,
      isDirectFriendCall,
      isDirectInitiator,
      currentPartnerId: partnerIdRef.current,
      newPartnerId: id
    });
    
    // КРИТИЧНО: Для прямых звонков НЕ пропускаем если partnerId уже установлен
    // потому что partnerId может быть установлен из call:accepted, но PC еще не создан
    // Для рандомных чатов пропускаем если partnerId уже установлен
    if (!isDirectFriendCall) {
      if (partnerIdRef.current === id) {
        console.log('[handleMatchFound] Random chat: partnerId matches, skipping');
        return;
      }
      const currentPartnerId = partnerIdRef.current;
      if (currentPartnerId === id) {
        console.log('[handleMatchFound] Random chat: currentPartnerId matches, skipping');
        return;
      }
    } else {
      // Для прямых звонков: если partnerId уже установлен и совпадает, но PC еще не создан,
      // продолжаем создание PC
      if (partnerIdRef.current === id && peerRef.current) {
        console.log('[handleMatchFound] Direct call: partnerId matches and PC exists, skipping duplicate match_found');
        return;
      }
      // Если partnerId не установлен, устанавливаем его
      if (!partnerIdRef.current) {
        partnerIdRef.current = id;
        setPartnerId(id);
        console.log('[handleMatchFound] Direct call: Set partnerId from match_found:', id);
      } else if (partnerIdRef.current !== id) {
        console.warn('[handleMatchFound] Direct call: partnerId mismatch!', {
          current: partnerIdRef.current,
          new: id
        });
        // Обновляем partnerId если он отличается
        partnerIdRef.current = id;
        setPartnerId(id);
      }
      
      // КРИТИЧНО: Устанавливаем partnerUserId для ВСЕХ участников прямого звонка из match_found
      // Это гарантирует, что partnerUserId установлен даже если он не был передан в call:accepted
      // КРИТИЧНО: Обновляем partnerUserId даже если он уже установлен, чтобы гарантировать правильное значение
      console.log('[handleMatchFound] Checking userId for partnerUserId setup', {
        userId,
        hasUserId: !!userId,
        currentPartnerUserId: partnerUserIdRef.current,
        isDirectInitiator,
        isReceiver: !isDirectInitiator
      });
      
      if (userId) {
        // КРИТИЧНО: Для прямых звонков userId в match_found должен быть ID партнера
        // Для receiver: userId - это ID инициатора (правильно)
        // Для инициатора: userId - это ID receiver (правильно)
        // КРИТИЧНО: Для инициатора не устанавливаем partnerUserId из userId, если userId совпадает с myUserId
        // Это предотвращает установку неправильного partnerUserId (собственного ID вместо ID receiver)
        const isInitiatorOwnId = isDirectInitiator && myUserId && String(userId) === String(myUserId);
        const currentPartnerUserId = partnerUserIdRef.current;
        
        if (isInitiatorOwnId) {
          // Для инициатора userId совпадает с myUserId - это неправильный userId (возможно от рандомного чата)
          // Не устанавливаем partnerUserId для инициатора, если userId - это собственный ID
          console.warn('[handleMatchFound] Direct call: Initiator received own userId in match_found, ignoring', {
            userId,
            myUserId,
            currentPartnerUserId,
            note: 'userId should be receiver\'s ID, not initiator\'s own ID. Will use partnerUserId from call:accepted or handleOffer'
          });
        } else if (!currentPartnerUserId) {
          // partnerUserId еще не установлен - устанавливаем из match_found
          partnerUserIdRef.current = userId;
          setPartnerUserId(userId);
          console.log('[handleMatchFound] Direct call: Set partnerUserId from match_found:', userId, {
            isInitiator: isDirectInitiator,
            isReceiver: !isDirectInitiator,
            myUserId
          });
        } else {
          // partnerUserId уже установлен из call:accepted - не обновляем
          console.log('[handleMatchFound] Direct call: partnerUserId already set from call:accepted, not updating from match_found', {
            currentPartnerUserId,
            matchFoundUserId: userId,
            isInitiator: isDirectInitiator,
            isReceiver: !isDirectInitiator,
            myUserId
          });
        }
      } else {
        console.warn('[handleMatchFound] Direct call: No userId in match_found!', {
          id,
          roomId,
          isDirectInitiator,
          isReceiver: !isDirectInitiator,
          currentPartnerUserId: partnerUserIdRef.current,
          myUserId
        });
      }
    }

    if (!isDirectFriendCall && peerRef.current && peerRef.current.signalingState === 'stable') {
      return;
    }

    if (!isDirectFriendCall && peerRef.current && (peerRef.current as any).localDescription) {
      return;
    }
    
    if (peerRef.current) {
      try {
        cleanupPeer(peerRef.current);
      } catch {}
      peerRef.current = null;
    }
    
    if (preCreatedPcRef.current) {
      peerRef.current = preCreatedPcRef.current;
      preCreatedPcRef.current = null;
    }
    
    // Принудительно очищаем remoteStream и все связанные состояния перед новым звонком
    // для повторных звонков, чтобы гарантировать правильное отображение видеопотока
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
    } catch {}
    setRemoteStream(null);
    remoteStreamRef.current = null;
    setRemoteViewKey(0);
    setRemoteCamOn(false);
    setRemoteMutedMain(false);
    setPartnerInPiP(false);
    
    await new Promise(resolve => setTimeout(resolve, 800));
    
    processingOffersRef.current.add(matchKey);
    setLoading(true);
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
      setStarted(true);
      
      if (stream && !isValidStream(stream)) {
        try {
          const tracks = stream.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try { t.stop(); } catch {}
          });
        } catch {}
        stream = null;
        setLocalStream(null);
        localStreamRef.current = null;
        setStreamValid(false);
      }
      
      if (!stream) {
        if (!started) return;
        stream = await startLocalStream('front');
        if (stream) {
          const videoTrack = stream.getVideoTracks()?.[0];
          const wantCam = camUserPreferenceRef.current === true;
          if (videoTrack) {
            videoTrack.enabled = wantCam;
            setCamOn(wantCam);
            setStreamValid(true);
            setLocalStream(stream);
            localStreamRef.current = stream;
          }
        }
      } else {
        setLocalStream(stream);
        localStreamRef.current = stream;
        
        const videoTrack = stream.getVideoTracks()?.[0];
        const wantCam = camUserPreferenceRef.current === true;
        if (videoTrack) {
          if (videoTrack.enabled !== wantCam) {
            videoTrack.enabled = wantCam;
          }
          setCamOn(wantCam);
          setStreamValid(true);
        }
        
        if (stream && isValidStream(stream)) {
          const videoTrack2 = stream.getVideoTracks()?.[0];
          const wantCam2 = camUserPreferenceRef.current === true;
          if (videoTrack2) {
            videoTrack2.enabled = wantCam2;
          }
          setCamOn(wantCam2);
        }
      }
      
      if (stream && !isValidStream(stream)) {
        try {
          const tracks = stream.getTracks?.() || [];
          tracks.forEach((t: any) => {
            try { t.stop(); } catch {}
          });
        } catch {}
        stream = null;
        setLocalStream(null);
        localStreamRef.current = null;
        setStreamValid(false);
        
        if (!started) return;
        
        stream = await startLocalStream('front');
        if (stream) {
          const videoTrack = stream.getVideoTracks()?.[0];
          const wantCam = camUserPreferenceRef.current === true;
          if (videoTrack) {
            videoTrack.enabled = wantCam;
            setCamOn(wantCam);
            setStreamValid(true);
            setLocalStream(stream);
            localStreamRef.current = stream;
          }
        }
      }
      
      if (!socket.connected) await new Promise<void>(res => socket.once('connect', () => res()));
      
      const myId = String(socket.id);
      const partnerIdNow = String(id);
      // КРИТИЧНО: Для прямых звонков используем isDirectFriendCall вместо isDirectCall
      // потому что isDirectCall может быть не установлен правильно из route params
      const isDirectFriendCallForCaller = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
      
      // КРИТИЧНО: Для прямых звонков определяем инициатора по флагам, а не по route params
      // Инициатор = есть friendCallAccepted/inDirectCall, но нет incomingFriendCall
      // Receiver = есть incomingFriendCall или partnerId был установлен из call:accepted
      const hasIncomingCall = !!incomingFriendCall || !!incomingCall;
      
      // КРИТИЧНО: Для прямых звонков определяем инициатора по флагам:
      // - Если есть friendCallAccepted и inDirectCall, но нет incomingFriendCall - это инициатор
      // - Если есть incomingFriendCall - это receiver
      // - Если partnerId был установлен из call:accepted (для receiver) - это receiver
      // НО: для инициатора partnerId может быть установлен из match_found, поэтому проверяем порядок:
      // если partnerId был установлен ДО call:accepted (из match_found), это инициатор
      // если partnerId был установлен В call:accepted, это receiver
      const isDirectInitiatorForCaller = isDirectFriendCallForCaller && 
                                          !hasIncomingCall && 
                                          friendCallAcceptedRef.current && 
                                          inDirectCallRef.current;
      
      // Используем route params как fallback, но приоритет отдаем флагам
      const effectiveIsDirectInitiator = isDirectFriendCallForCaller ? 
        (isDirectInitiatorForCaller || isDirectInitiator) : false;
      
      const iAmCaller = isDirectFriendCallForCaller ? effectiveIsDirectInitiator : (myId < partnerIdNow);
      
      // КРИТИЧНО: Логируем определение iAmCaller для отладки
      console.log('[handleMatchFound] Determining caller role', {
        isDirectCall,
        isDirectInitiator,
        isDirectInitiatorForCaller,
        effectiveIsDirectInitiator,
        hasIncomingCall,
        inDirectCall: inDirectCallRef.current,
        friendCallAccepted: friendCallAcceptedRef.current,
        isDirectFriendCallForCaller,
        myId,
        partnerIdNow,
        iAmCaller,
        comparison: myId < partnerIdNow
      });
      
      setPartnerId(partnerIdNow);
      setPartnerUserId(userId ? String(userId) : null);
      partnerIdRef.current = partnerIdNow;
      
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
  
      // КРИТИЧНО: Логируем перед проверкой iAmCaller
      console.log('[handleMatchFound] Before caller check', {
        iAmCaller,
        isDirectCall,
        isDirectInitiator,
        inDirectCall: inDirectCallRef.current,
        friendCallAccepted: friendCallAcceptedRef.current,
        hasPeerRef: !!peerRef.current,
        partnerId: partnerIdNow
      });
  
        if (iAmCaller) {
          // Caller - создаем PC и отправляем offer
          console.log('[handleMatchFound] Caller - creating PC and sending offer', {
            isDirectCall,
            isDirectInitiator,
            isDirectFriendCall,
            friendCallAccepted: friendCallAcceptedRef.current,
            inDirectCall: inDirectCallRef.current,
            hasPeerRef: !!peerRef.current,
            partnerId: partnerIdNow,
            iAmCaller
          });
          
          // КРИТИЧНО: Для инициатора partnerId устанавливается из match_found (socket.id партнера)
          // Поэтому PC должен создаваться здесь в handleMatchFound, а не из call:accepted
          // Для receiver PC создается из call:accepted с задержкой, поэтому там есть проверка
          // НО: для инициатора НЕ пропускаем создание PC, даже если friendCallAccepted установлен,
          // потому что для инициатора PC создается в handleMatchFound, а не в call:accepted
          
          // ВАЖНО: Используем стрим из state или ref, чтобы убедиться что мы используем актуальный стрим
          // Это предотвращает использование устаревшего стрима, который мог быть очищен
          const currentStream = localStreamRef.current || localStream || stream;
          if (currentStream !== stream) {
            console.log('[handleMatchFound] Caller: Stream changed, using current stream from state/ref', {
              oldStreamId: stream?.id,
              newStreamId: currentStream?.id
            });
            stream = currentStream;
          }
          
          // Проверяем текущее состояние стрима перед проверкой валидности
          console.log('[handleMatchFound] Caller: Stream state check', {
            streamExists: !!stream,
            streamId: stream?.id,
            streamFromLocalStream: stream === localStream,
            streamFromLocalStreamRef: stream === localStreamRef.current,
            localStreamId: localStream?.id,
            localStreamRefId: localStreamRef.current?.id,
            streamValidState: streamValid,
            tracksCount: stream ? stream.getTracks()?.length : 0,
            videoTracksCount: stream ? stream.getVideoTracks()?.length : 0,
            audioTracksCount: stream ? stream.getAudioTracks()?.length : 0,
            videoTracks: stream ? stream.getVideoTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : [],
            audioTracks: stream ? stream.getAudioTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : []
          });
          
          // Проверяем что stream валиден перед созданием PC
          const streamIsValid = stream ? isValidStream(stream) : false;
          console.log('[handleMatchFound] Caller: Stream validation result', {
            streamExists: !!stream,
            streamIsValid,
            streamId: stream?.id
          });
          
          if (!stream || !streamIsValid) {
            console.error('[handleMatchFound] Caller: Cannot create PC - stream is invalid', {
              streamExists: !!stream,
              streamValid: streamIsValid,
              streamId: stream?.id,
              tracksCount: stream ? stream.getTracks()?.length : 0,
              videoTracks: stream ? stream.getVideoTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : [],
              audioTracks: stream ? stream.getAudioTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : []
            });
            
            // Пытаемся пересоздать стрим для caller
            // ВАЖНО: Пересоздаем только если пользователь нажал "Начать"
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            console.log('[handleMatchFound] Caller: Attempting to recreate stream (started=true)');
            try {
              if (stream) {
                const tracks = stream.getTracks?.() || [];
                tracks.forEach((t: any) => {
                  try { t.stop(); } catch {}
                });
              }
              stream = await startLocalStream('front');
              if (stream && isValidStream(stream)) {
                // Сохраняем стрим в state и ref для использования в PC
                setLocalStream(stream);
                localStreamRef.current = stream;
                setStreamValid(true);
                console.log('[handleMatchFound] Caller: Successfully recreated stream', {
                  streamId: stream.id,
                  tracksCount: stream.getTracks()?.length || 0
                });
              } else {
                console.error('[handleMatchFound] Caller: Failed to recreate valid stream');
                return;
              }
            } catch (recreateError) {
              console.error('[handleMatchFound] Caller: Error recreating stream:', recreateError);
              return;
            }
          }
          
          // Устанавливаем partnerIdRef синхронно перед созданием PC
          partnerIdRef.current = partnerIdNow;
          
          // Финальная проверка стрима перед созданием PC
          console.log('[handleMatchFound] Caller: Final stream check before PC creation', {
            streamExists: !!stream,
            streamId: stream?.id,
            streamValid: stream ? isValidStream(stream) : false,
            streamFromLocalStream: stream === localStream,
            streamFromLocalStreamRef: stream === localStreamRef.current,
            localStreamId: localStream?.id,
            localStreamRefId: localStreamRef.current?.id,
            tracksCount: stream ? stream.getTracks()?.length : 0,
            videoTracksCount: stream ? stream.getVideoTracks()?.length : 0,
            audioTracksCount: stream ? stream.getAudioTracks()?.length : 0,
            videoTracks: stream ? stream.getVideoTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : [],
            audioTracks: stream ? stream.getAudioTracks()?.map(t => ({ id: t.id, enabled: t.enabled, readyState: t.readyState })) : [],
            partnerId: partnerIdNow
          });
          
          // Проверяем что треки не остановлены перед созданием PC
          const videoTrack = stream?.getVideoTracks()?.[0];
          const audioTrack = stream?.getAudioTracks()?.[0];
          if (videoTrack && videoTrack.readyState === 'ended') {
            console.warn('[handleMatchFound] Caller: Video track is ended, attempting to recreate stream', {
              streamId: stream?.id,
              videoTrackId: videoTrack.id,
              readyState: videoTrack.readyState
            });
            
            // Пытаемся пересоздать стрим если трек ended
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            try {
              if (stream) {
                const tracks = stream.getTracks?.() || [];
                tracks.forEach((t: any) => {
                  try { t.stop(); } catch {}
                });
              }
              stream = await startLocalStream('front');
              if (stream && isValidStream(stream)) {
                const newVideoTrack = stream.getVideoTracks()?.[0];
                const wantCam = camUserPreferenceRef.current === true;
                if (newVideoTrack) {
                  newVideoTrack.enabled = wantCam;
                }
                setLocalStream(stream);
                localStreamRef.current = stream;
                setStreamValid(true);
                setCamOn(wantCam);
                console.log('[handleMatchFound] Caller: Successfully recreated stream after ended track', {
                  streamId: stream.id,
                  tracksCount: stream.getTracks()?.length || 0
                });
              } else {
                console.error('[handleMatchFound] Caller: Failed to recreate valid stream after ended track');
                return;
              }
            } catch (recreateError) {
              console.error('[handleMatchFound] Caller: Error recreating stream after ended track:', recreateError);
              return;
            }
          }
          
          // Обновляем переменные треков перед проверкой аудио трека (на случай если стрим был пересоздан)
          const currentVideoTrack = stream?.getVideoTracks()?.[0];
          const currentAudioTrack = stream?.getAudioTracks()?.[0];
          
          // Проверяем аудио трек тоже
          if (currentAudioTrack && currentAudioTrack.readyState === 'ended') {
            console.warn('[handleMatchFound] Caller: Audio track is ended, attempting to recreate stream', {
              streamId: stream?.id,
              audioTrackId: currentAudioTrack.id,
              readyState: currentAudioTrack.readyState
            });
            
            // Пытаемся пересоздать стрим если трек ended
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            try {
              if (stream) {
                const tracks = stream.getTracks?.() || [];
                tracks.forEach((t: any) => {
                  try { t.stop(); } catch {}
                });
              }
              stream = await startLocalStream('front');
              if (stream && isValidStream(stream)) {
                const newVideoTrack = stream.getVideoTracks()?.[0];
                const wantCam = camUserPreferenceRef.current === true;
                if (newVideoTrack) {
                  newVideoTrack.enabled = wantCam;
                }
                setLocalStream(stream);
                localStreamRef.current = stream;
                setStreamValid(true);
                setCamOn(wantCam);
                console.log('[handleMatchFound] Caller: Successfully recreated stream after ended audio track', {
                  streamId: stream.id,
                  tracksCount: stream.getTracks()?.length || 0
                });
              } else {
                console.error('[handleMatchFound] Caller: Failed to recreate valid stream after ended audio track');
                return;
              }
            } catch (recreateError) {
              console.error('[handleMatchFound] Caller: Error recreating stream after ended audio track:', recreateError);
              return;
            }
          }
          
          console.log('[handleMatchFound] Caller: Creating PC with validated stream', {
            streamId: stream.id,
            hasVideoTrack: !!stream.getVideoTracks()?.[0],
            hasAudioTrack: !!stream.getAudioTracks()?.[0],
            partnerId: partnerIdNow
          });
          
          const pc = await ensurePcWithLocal(stream);
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
          
          // Обновляем bindConnHandlers с новым partnerId если PC был переиспользован
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
              // НО: не прерываем если partnerId изменился на null (это может быть временное состояние)
              const currentPartnerId = partnerIdRef.current;
              if (currentPartnerId && currentPartnerId !== partnerIdNow) {
                console.warn('[handleMatchFound] Partner changed during offer creation, aborting', {
                  expected: partnerIdNow,
                  current: currentPartnerId
                });
                return;
              }
              
              // Если partnerId был очищен, но мы все еще обрабатываем этот матч - восстанавливаем его
              if (!currentPartnerId && partnerIdNow) {
                console.log('[handleMatchFound] PartnerId was cleared, restoring it', { partnerIdNow });
                partnerIdRef.current = partnerIdNow;
                setPartnerId(partnerIdNow);
              }
              
              // В background не пытаемся перевыстроить PC
              if (false) {
                console.log('[handleMatchFound] Skipping offer creation - in background mode');
                return;
              }
              
              // Проверяем signalingState - нельзя создавать offer если уже установлен remote description
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
              
              // Проверяем что PC в правильном состоянии для создания offer (stable без описаний)
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
              
              // КРИТИЧНО: Для прямых звонков отправляем offer с roomId для гарантированной доставки
              const currentRoomId = roomId || roomIdRef.current;
              const offerPayload: any = { 
                to: partnerIdNow, 
                offer, 
                fromUserId: myUserId 
              };
              if (isDirectFriendCall && currentRoomId) {
                offerPayload.roomId = currentRoomId;
                console.log('[handleMatchFound] Sending offer with roomId for direct call:', currentRoomId);
              }
              
              socket.emit('offer', offerPayload);
              console.log('⚫ [handleMatchFound] Created and sent offer for match', {
                partnerId: partnerIdNow,
                roomId: currentRoomId,
                hasRoomId: !!currentRoomId,
                isDirectCall: isDirectFriendCall,
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
          
          // КРИТИЧНО: Для receiver в прямых звонках проверяем, не создается ли уже PC из call:accepted
          // Если friendCallAccepted и inDirectCall установлены, но PC еще не создан,
          // значит PC создается из call:accepted с задержкой - не создаем его здесь
          // Проверяем что это receiver по отсутствию isDirectCall (инициатор имеет isDirectCall=true)
          const isReceiverInDirectCall = isDirectFriendCall && !isDirectCall && friendCallAcceptedRef.current && inDirectCallRef.current && !peerRef.current;
          if (isReceiverInDirectCall) {
            console.log('[handleMatchFound] Receiver: PC is being created from call:accepted with delay, skipping PC creation in handleMatchFound', {
              partnerId: partnerIdNow,
              currentPartnerId: partnerIdRef.current
            });
            // Просто обновляем partnerId если нужно
            if (partnerIdRef.current !== partnerIdNow) {
              partnerIdRef.current = partnerIdNow;
              setPartnerId(partnerIdNow);
              console.log('[handleMatchFound] Receiver: Updated partnerId from match_found:', partnerIdNow);
            }
            return;
          }
          
          // Проверяем, не существует ли уже PC для этого партнера
          // Это может произойти если handleOffer уже создал PC и обрабатывает offer
          // Проверяем не только stable, но и другие состояния (have-local-offer, have-remote-offer)
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
              // КРИТИЧНО: Проверяем, не установлен ли уже ontrack, чтобы не перезаписывать его
              const hasOntrack = !!(existingPc as any).ontrack;
              if (!hasOntrack) {
                attachRemoteHandlers(existingPc, partnerIdNow);
                console.log('[handleMatchFound] Attached remote handlers to existing PC');
              } else {
                console.log('[handleMatchFound] Remote handlers already attached to existing PC, skipping');
              }
              return;
            }
          }
          
          // Устанавливаем partnerIdRef синхронно перед созданием PC
          partnerIdRef.current = partnerIdNow;
          
          // Убеждаемся что локальный стрим готов перед созданием PC
          // Особенно важно при принятии звонка в неактивном состоянии, когда localStream может быть null
          // ВАЖНО: Используем стрим из state или ref, чтобы убедиться что мы используем актуальный стрим
          let finalStream = localStreamRef.current || localStream || stream;
          if (finalStream !== stream) {
            console.log('[handleMatchFound] Receiver: Stream changed, using current stream from state/ref', {
              oldStreamId: stream?.id,
              newStreamId: finalStream?.id
            });
          }
          if (!finalStream) {
            // ВАЖНО: Создаем локальный стрим только если пользователь нажал "Начать" (started === true)
            if (!started) {
              console.log('[handleMatchFound] Receiver: No local stream and started=false, NOT creating stream - user must click Start first');
              return;
            }
            
            console.log('[handleMatchFound] Receiver: No local stream, creating one before PC creation (started=true)');
            try {
              finalStream = await startLocalStream('front');
              // Если startLocalStream вернул null (например, из-за проверки PiP),
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
                // Убеждаемся что стрим действительно валиден
                if (!isValidStream(finalStream)) {
                  console.error('[handleMatchFound] Receiver: Created stream is invalid');
                  try {
                    const tracks = finalStream.getTracks?.() || [];
                    tracks.forEach((t: any) => { try { t.stop(); } catch {} });
                  } catch {}
                  return;
                }
                
                // Сохраняем стрим в state и ref
                setLocalStream(finalStream);
                localStreamRef.current = finalStream;
                setStreamValid(true);
                
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
          
          // Проверяем что finalStream действительно существует и валиден перед созданием PC
          if (!finalStream) {
            console.error('[handleMatchFound] Receiver: No valid stream available for PC creation');
            return;
          }
          
          // КРИТИЧНО: Убеждаемся что камера включена в существующем стриме
          const existingVideoTrack = finalStream.getVideoTracks()?.[0];
          if (existingVideoTrack) {
            if (!existingVideoTrack.enabled) {
              existingVideoTrack.enabled = true;
              console.log('[handleMatchFound] Receiver: Enabled video track in existing stream');
            }
            setCamOn(true);
          } else {
            console.warn('[handleMatchFound] Receiver: No video track in existing stream');
          }
          
          // Проверяем валидность стрима перед использованием
          if (!isValidStream(finalStream)) {
            console.warn('[handleMatchFound] Receiver: Stream is invalid, attempting to recreate', {
              finalStreamExists: !!finalStream,
              finalStreamId: finalStream?.id,
              hasToURL: finalStream ? typeof (finalStream as any).toURL === 'function' : false,
              tracksLength: finalStream ? (finalStream as any).getTracks?.()?.length : 0
            });
            
            // Пытаемся пересоздать стрим
            // ВАЖНО: Пересоздаем только если пользователь нажал "Начать"
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            try {
              const tracks = finalStream.getTracks?.() || [];
              tracks.forEach((t: any) => {
                try { t.stop(); } catch {}
              });
            } catch {}
            
            try {
              finalStream = await startLocalStream('front');
              if (!finalStream) {
                // Если startLocalStream вернул null, создаем напрямую
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
                  localStreamRef.current = finalStream;
                  setStreamValid(true);
                  const videoTrack = finalStream.getVideoTracks()?.[0];
                  if (videoTrack) {
                    videoTrack.enabled = true;
                    setCamOn(true);
                  }
                }
              } else {
                setLocalStream(finalStream);
                localStreamRef.current = finalStream;
                setStreamValid(true);
              }
              
              if (!finalStream || !isValidStream(finalStream)) {
                console.error('[handleMatchFound] Receiver: Failed to recreate valid stream');
                return;
              }
              
              console.log('[handleMatchFound] Receiver: Successfully recreated stream');
            } catch (recreateError) {
              console.error('[handleMatchFound] Receiver: Error recreating stream:', recreateError);
              return;
            }
          }
          
          // Проверяем что треки не остановлены перед созданием PC
          const videoTrack = finalStream.getVideoTracks()?.[0];
          const audioTrack = finalStream.getAudioTracks()?.[0];
          if (videoTrack && videoTrack.readyState === 'ended') {
            console.warn('[handleMatchFound] Receiver: Video track is ended, attempting to recreate stream', {
              streamId: finalStream.id,
              videoTrackId: videoTrack.id,
              readyState: videoTrack.readyState
            });
            
            // Пытаемся пересоздать стрим если трек ended
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            try {
              const tracks = finalStream.getTracks?.() || [];
              tracks.forEach((t: any) => {
                try { t.stop(); } catch {}
              });
              finalStream = await startLocalStream('front');
              if (finalStream && isValidStream(finalStream)) {
                const newVideoTrack = finalStream.getVideoTracks()?.[0];
                const wantCam = camUserPreferenceRef.current === true;
                if (newVideoTrack) {
                  newVideoTrack.enabled = wantCam;
                }
                setLocalStream(finalStream);
                localStreamRef.current = finalStream;
                setStreamValid(true);
                setCamOn(wantCam);
                console.log('[handleMatchFound] Receiver: Successfully recreated stream after ended track', {
                  streamId: finalStream.id,
                  tracksCount: finalStream.getTracks()?.length || 0
                });
              } else {
                console.error('[handleMatchFound] Receiver: Failed to recreate valid stream after ended track');
                return;
              }
            } catch (recreateError) {
              console.error('[handleMatchFound] Receiver: Error recreating stream after ended track:', recreateError);
              return;
            }
          }
          
          // Обновляем переменные треков перед проверкой аудио трека (на случай если стрим был пересоздан)
          const currentVideoTrackReceiver = finalStream?.getVideoTracks()?.[0];
          const currentAudioTrackReceiver = finalStream?.getAudioTracks()?.[0];
          
          // Проверяем аудио трек тоже
          if (currentAudioTrackReceiver && currentAudioTrackReceiver.readyState === 'ended') {
            console.warn('[handleMatchFound] Receiver: Audio track is ended, attempting to recreate stream', {
              streamId: finalStream.id,
              audioTrackId: currentAudioTrackReceiver.id,
              readyState: currentAudioTrackReceiver.readyState
            });
            
            // Пытаемся пересоздать стрим если трек ended
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            try {
              const tracks = finalStream.getTracks?.() || [];
              tracks.forEach((t: any) => {
                try { t.stop(); } catch {}
              });
              finalStream = await startLocalStream('front');
              if (finalStream && isValidStream(finalStream)) {
                const newVideoTrack = finalStream.getVideoTracks()?.[0];
                const wantCam = camUserPreferenceRef.current === true;
                if (newVideoTrack) {
                  newVideoTrack.enabled = wantCam;
                }
                setLocalStream(finalStream);
                localStreamRef.current = finalStream;
                setStreamValid(true);
                setCamOn(wantCam);
                console.log('[handleMatchFound] Receiver: Successfully recreated stream after ended audio track', {
                  streamId: finalStream.id,
                  tracksCount: finalStream.getTracks()?.length || 0
                });
              } else {
                console.error('[handleMatchFound] Receiver: Failed to recreate valid stream after ended audio track');
                return;
              }
            } catch (recreateError) {
              console.error('[handleMatchFound] Receiver: Error recreating stream after ended audio track:', recreateError);
              return;
            }
          }
          
          // Добавляем детальную диагностику перед созданием PC
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
          
          // Очищаем старый PC если он существует и не в правильном состоянии
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
          
          // Также очищаем preCreatedPcRef
          if (preCreatedPcRef.current) {
            try {
              cleanupPeer(preCreatedPcRef.current);
              preCreatedPcRef.current = null;
            } catch (e) {
              console.warn('[handleMatchFound] Receiver: Error cleaning up preCreatedPcRef:', e);
            }
          }
          
          // Убедимся, что PC создан и готов к приему offer
          const pc = await ensurePcWithLocal(finalStream);
          if (!pc) {
            console.error('[handleMatchFound] Failed to create PeerConnection for receiver', {
              streamValid: isValidStream(finalStream),
              streamId: finalStream?.id,
              hasVideoTrack: !!finalStream?.getVideoTracks()?.[0],
              hasAudioTrack: !!finalStream?.getAudioTracks()?.[0]
            });
            return;
          }
          // Обновляем bindConnHandlers с новым partnerId если PC был переиспользован
          bindConnHandlers(pc, partnerIdNow);
          // КРИТИЧНО: Проверяем, не установлен ли уже ontrack, чтобы не перезаписывать его
          // (может быть установлен в ensurePcWithLocal)
          const hasOntrack = !!(pc as any).ontrack;
          if (!hasOntrack) {
            attachRemoteHandlers(pc, partnerIdNow);
            console.log('[handleMatchFound] Attached remote handlers to new PC');
          } else {
            console.log('[handleMatchFound] Remote handlers already attached to new PC (from ensurePcWithLocal), skipping');
          }
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
    
    // Для прямого звонка друга: включаем камеру по умолчанию,
    // если пользователь явно не выключал её в этой сессии
    if ((isDirectCall || inDirectCall || friendCallAccepted) && !explicitCamToggledRef.current) {
      camUserPreferenceRef.current = true;
      try {
        const s = localStreamRef.current || localStream;
        const v = s?.getVideoTracks?.()?.[0];
        if (v && !v.enabled) {
          v.enabled = true;
          setCamOn(true);
          try { socket.emit('cam-toggle', { enabled: true, from: socket.id }); } catch {}
        }
      } catch {}
    }

    // Принудительно очищаем remoteStream перед обработкой нового offer
    // для повторных звонков, чтобы гарантировать правильное отображение видеопотока
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
        // Принудительно сбрасываем remoteViewKey для гарантированного ререндера при новом звонке
        setRemoteViewKey(0);
        // Устанавливаем remoteCamOn в false при очистке, чтобы не показывать заглушку до получения video track
        setRemoteCamOn(false);
        console.log('[handleOffer] Cleared old remote stream before processing new offer');
      } catch (e) {
        console.warn('[handleOffer] Error cleaning up old remote stream:', e);
      }
    }

    // Дополнительная проверка - если у нас уже есть партнер с другим ID
    // КРИТИЧНО: Для прямых звонков НЕ обновляем partnerId если он уже установлен из call:accepted
    // partnerId должен быть socket.id инициатора (который отправил call:initiate)
    // и не должен изменяться при получении offer
    if (partnerIdRef.current && partnerIdRef.current !== from) {
      const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
      if (isDirectFriendCall) {
        // Для прямых звонков: если partnerId уже установлен из call:accepted, используем его
        // и НЕ обновляем на from, так как from - это socket.id отправителя offer (может быть инициатор или receiver)
        // КРИТИЧНО: partnerId должен быть socket.id инициатора, который был установлен в call:accepted
        // Если partnerId не установлен, устанавливаем его на from (socket.id отправителя offer)
        if (!partnerIdRef.current) {
          console.log('[handleOffer] Direct call: setting partnerId to from (socket.id of offer sender):', from);
          partnerIdRef.current = from;
          setPartnerId(from);
        } else {
          // partnerId уже установлен - используем его, даже если он не совпадает с from
          // Это может произойти если offer приходит от receiver, а partnerId установлен как socket.id инициатора
          console.log('[handleOffer] Direct call: partnerId already set, keeping it:', partnerIdRef.current, {
            from,
            partnerId: partnerIdRef.current,
            note: 'partnerId should be socket.id of initiator, not offer sender'
          });
        }
      } else {
        // Для рандомных чатов игнорируем offer от другого партнера
        console.log('[handleOffer] Already matched with different partner:', partnerIdRef.current, 'ignoring offer from:', from);
        return;
      }
    }

    // Определяем тип звонка
    // Входящий прямой звонок от друга: isDirectCall || inDirectCall || есть активный incomingFriendCall
    // Рандомный чат между друзьями: нет isDirectCall/inDirectCall, но fromUserId в списке друзей
    const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
    const isRandomChatWithFriend = !isDirectFriendCall && fromUserId && friends.some(f => String(f._id) === String(fromUserId));
    const isIncomingFriendCall = isDirectFriendCall || isRandomChatWithFriend;
    
    // НЕ обрабатываем offer если:
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
    
    // Для обычного рандомного чата (не с другом) требуем активный поиск
    if (!startedRef.current && !isIncomingFriendCall) {
      console.log('[handleOffer] Not in search mode and not an incoming friend call, ignoring offer from:', from);
      return;
    }
    
    // Для звонков друг-друг: устанавливаем roomId если он еще не установлен
    // КРИТИЧНО: roomId должен иметь формат room_<socketId1>_<socketId2>, а не callId
    // roomId может прийти в событии call:accepted или быть установлен при создании звонка
    if (isDirectFriendCall && !roomIdRef.current) {
      // Пытаемся получить roomId из route params (если он там есть)
      const routeRoomId = (route?.params as any)?.roomId;
      // КРИТИЧНО: НЕ используем currentCallIdRef.current, так как это callId, а не roomId
      // roomId должен начинаться с "room_", а callId - это временный ID
      if (routeRoomId && routeRoomId.startsWith('room_')) {
        roomIdRef.current = routeRoomId;
        console.log('[handleOffer] Set roomId from route params:', routeRoomId);
      } else {
        // Если roomId нет, создаем его из socket.id обоих пользователей
        // Формат: room_<socketId1>_<socketId2> (сортируем для консистентности)
        const ids = [socket.id, from].sort();
        const generatedRoomId = `room_${ids[0]}_${ids[1]}`;
        roomIdRef.current = generatedRoomId;
        console.log('[handleOffer] Generated roomId for friend call:', generatedRoomId);
      }
    }
    
    // Для входящих прямых звонков от друзей устанавливаем started
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
        // Всегда создаем локальный стрим для рандомного чата
        // Это нужно для корректной работы WebRTC
        // Особенно важно при принятии звонка в неактивном состоянии
        console.log('[handleOffer] No local stream, creating one before PC creation');
        
        // Для входящих дружеских звонков гарантируем выход из неактивного состояния
        // ПЕРЕД созданием стрима, чтобы избежать race condition
        // НО не выходим если звонок был завершен (wasFriendCallEnded) - это может быть остаточный offer
        // от предыдущего звонка. Выходим только если это действительно новый входящий звонок (есть incomingFriendCall)
        if (isIncomingFriendCall && isInactiveStateRef.current) {
          // Не обрабатываем offer в неактивном состоянии если звонок был завершен
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
          
          // Проверяем что это действительно новый входящий звонок (есть incomingFriendCall)
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
          // Устанавливаем friendCallAccepted ПЕРЕД выходом из неактивного состояния
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
        
        // ВАЖНО: Проверяем валидность стрима после создания
        // Если стрим существует, но невалиден (нет треков), пересоздаем его
        if (stream && !isValidStream(stream)) {
          console.warn('[handleOffer] Stream is invalid after startLocalStream, stopping and recreating', {
            streamId: stream.id,
            tracksCount: stream.getTracks()?.length || 0
          });
          try {
            const tracks = stream.getTracks() || [];
            tracks.forEach((t: any) => {
              try { t.stop(); } catch {}
            });
          } catch {}
          stream = null; // Сбрасываем, чтобы пересоздать ниже
        }
        
        // Если startLocalStream вернул null или стрим невалиден,
        // принудительно создаем стрим напрямую через getUserMedia
        // Для рандомного чата: создаем стрим если started=true (пользователь нажал "Начать")
        // Для дружеских звонков: создаем всегда
        const isRandomChat = !isDirectCall && !inDirectCall && !friendCallAccepted;
        const shouldCreateStream = !stream && (
          (isRandomChat && started) || // Для рандомного чата только если started=true
          (isIncomingFriendCall || friendCallAccepted || isDirectCall || inDirectCall) // Для дружеских звонков всегда
        );
        
        if (shouldCreateStream) {
          if (isRandomChat) {
            console.log('[handleOffer] Random chat - creating stream directly via getUserMedia (started=true)');
          } else {
            console.log('[handleOffer] startLocalStream returned null, creating stream directly for friend call');
          }
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
              // Проверяем валидность стрима перед сохранением
              if (!isValidStream(stream)) {
                console.error('[handleOffer] Created stream is invalid, stopping and retrying', {
                  streamId: stream.id,
                  tracksCount: stream.getTracks()?.length || 0
                });
                try {
                  const tracks = stream.getTracks?.() || [];
                  tracks.forEach((t: any) => { try { t.stop(); } catch {} });
                } catch {}
                stream = null;
                // Пытаемся еще раз с небольшой задержкой
                await new Promise(resolve => setTimeout(resolve, 100));
                stream = await mediaDevices.getUserMedia({ audio: audioConstraints, video: true });
                // Проверяем валидность после повторной попытки
                if (stream && !isValidStream(stream)) {
                  console.error('[handleOffer] Stream still invalid after retry, stopping', {
                    streamId: stream.id,
                    tracksCount: stream.getTracks()?.length || 0
                  });
                  try {
                    const tracks = stream.getTracks?.() || [];
                    tracks.forEach((t: any) => { try { t.stop(); } catch {} });
                  } catch {}
                  stream = null;
                }
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
                  isValid: isValidStream(stream),
                  isRandomChat
                });
              } else {
                console.error('[handleOffer] Failed to create valid stream after retry', {
                  streamExists: !!stream,
                  streamValid: stream ? isValidStream(stream) : false,
                  isRandomChat
                });
                stream = null;
              }
            }
          } catch (directError) {
            console.error('[handleOffer] Error creating stream directly:', directError);
            return;
          }
        }
        
        if (!stream || !isValidStream(stream)) {
          console.error('[handleOffer] Stream is invalid or null, cannot create PC', {
            streamExists: !!stream,
            streamValid: stream ? isValidStream(stream) : false,
            streamId: stream?.id,
            tracksCount: stream ? stream.getTracks()?.length : 0,
            hasVideoTrack: !!stream?.getVideoTracks()?.[0],
            hasAudioTrack: !!stream?.getAudioTracks()?.[0]
          });
          return;
        }
        
        // Убеждаемся что камера включена
        const videoTrack = stream.getVideoTracks()?.[0];
        if (videoTrack && !videoTrack.enabled) {
          videoTrack.enabled = true;
          setCamOn(true);
          console.log('[handleOffer] Enabled video track after creating stream');
        }
      }
      
      // Проверяем валидность стрима перед использованием
      if (!stream || !isValidStream(stream)) {
        console.error('[handleOffer] Stream is invalid or null, cannot create PC', {
          streamExists: !!stream,
          streamValid: stream ? isValidStream(stream) : false
        });
        return;
      }
      
      // Проверяем существующий PC перед созданием нового
      // Если PC уже существует для этого партнера и он в процессе обработки offer,
      // НЕ создаем новый PC, так как это приведет к потере remote description
      const existingPc = peerRef.current;
      if (existingPc) {
        try {
          const state = existingPc.signalingState;
          const hasLocalDesc = !!(existingPc as any)?.localDescription;
          const hasRemoteDesc = !!(existingPc as any)?.remoteDescription;
          const existingPartnerId = partnerIdRef.current;
          
          // КРИТИЧНО: Если PC уже существует и не закрыт, используем его
          // даже если partnerId был обновлен (для прямых звонков partnerId может обновляться)
          const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
          if (state !== 'closed') {
            // Для прямых звонков используем существующий PC, даже если partnerId не совпадает
            // потому что partnerId мог быть обновлен выше в строке 5104
            if (isDirectFriendCall || existingPartnerId === from) {
              console.log('[handleOffer] PC already exists, reusing existing PC', {
                partnerId: from,
                existingPartnerId,
                signalingState: state,
                hasLocalDesc,
                hasRemoteDesc,
                isDirectFriendCall
              });
              // КРИТИЧНО: НЕ обновляем partnerId для прямых звонков, так как он уже установлен правильно из call:accepted
              // partnerId должен быть socket.id инициатора, а не socket.id отправителя offer
              // Для прямых звонков используем existingPartnerId (который был установлен в call:accepted)
              // Для рандомных чатов используем from (socket.id отправителя offer)
              const partnerIdToUse = isDirectFriendCall ? (existingPartnerId || from) : from;
              if (partnerIdRef.current !== partnerIdToUse && !isDirectFriendCall) {
                partnerIdRef.current = partnerIdToUse;
                setPartnerId(partnerIdToUse);
              }
              // Просто обновляем bindConnHandlers с правильным partnerId
              bindConnHandlers(existingPc, partnerIdToUse);
              // КРИТИЧНО: Проверяем, не установлен ли уже ontrack, чтобы не перезаписывать его
              const hasOntrack = !!(existingPc as any).ontrack;
              if (!hasOntrack) {
                attachRemoteHandlers(existingPc, partnerIdToUse);
                console.log('[handleOffer] Attached remote handlers to existing PC');
              } else {
                console.log('[handleOffer] Remote handlers already attached to existing PC, skipping');
              }
              // Устанавливаем partnerUserId если он передан
              if (fromUserId) {
                setPartnerUserId(String(fromUserId));
                partnerUserIdRef.current = String(fromUserId);
              }
              // Переходим к обработке remote description с существующим PC
              // Пропускаем создание нового PC через ensurePcWithLocal
              // КРИТИЧНО: Если PC уже имеет remote description, не устанавливаем его снова
              if (hasRemoteDesc) {
                console.log('[handleOffer] PC already has remote description, skipping setRemoteDescription and answer creation');
                // Если remote description уже установлен, значит answer уже был создан и отправлен
                // Просто выходим из функции, чтобы не обрабатывать offer повторно
                processingOffersRef.current.delete(offerKey);
                return;
              }
            } else {
              // PC существует, но это другой партнер - очищаем старый PC
              console.log('[handleOffer] PC exists for different partner, cleaning up', {
                existingPartnerId,
                from,
                state
              });
              cleanupPeer(existingPc);
              peerRef.current = null;
            }
          } else {
            // PC закрыт - очищаем его
            console.log('[handleOffer] PC is closed, cleaning up', {
              existingPartnerId,
              from,
              state
            });
            cleanupPeer(existingPc);
            peerRef.current = null;
          }
          
          // Если PC был очищен выше, продолжаем создание нового PC ниже
          if (!peerRef.current && (hasLocalDesc || hasRemoteDesc)) {
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
      
      // Также очищаем preCreatedPcRef
      if (preCreatedPcRef.current) {
        try {
          cleanupPeer(preCreatedPcRef.current);
          preCreatedPcRef.current = null;
        } catch (e) {
          console.warn('[handleOffer] Error cleaning up preCreatedPcRef:', e);
        }
      }
      
      setStarted(true);
      
      // Добавляем детальную диагностику перед созданием PC
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
      
      // Проверяем что треки не остановлены перед созданием PC
      const videoTrack = stream?.getVideoTracks()?.[0];
      const audioTrack = stream?.getAudioTracks()?.[0];
      if (videoTrack && videoTrack.readyState === 'ended') {
        console.warn('[handleOffer] Video track is ended, attempting to recreate stream', {
          streamId: stream?.id,
          videoTrackId: videoTrack.id,
          readyState: videoTrack.readyState
        });
        
        // Пытаемся пересоздать стрим если трек ended
        if (!startedRef.current) {
          // Пользователь остановил поиск, просто выходим без ошибки
          return;
        }
        
        try {
          if (stream) {
            const tracks = stream.getTracks?.() || [];
            tracks.forEach((t: any) => {
              try { t.stop(); } catch {}
            });
          }
          stream = await startLocalStream('front');
          if (stream && isValidStream(stream)) {
            const newVideoTrack = stream.getVideoTracks()?.[0];
            const wantCam = camUserPreferenceRef.current === true;
            if (newVideoTrack) {
              newVideoTrack.enabled = wantCam;
            }
            setLocalStream(stream);
            localStreamRef.current = stream;
            setStreamValid(true);
            setCamOn(wantCam);
            console.log('[handleOffer] Successfully recreated stream after ended track', {
              streamId: stream.id,
              tracksCount: stream.getTracks()?.length || 0
            });
          } else {
            console.error('[handleOffer] Failed to recreate valid stream after ended track');
            return;
          }
        } catch (recreateError) {
          console.error('[handleOffer] Error recreating stream after ended track:', recreateError);
          return;
        }
      }
      
      // Проверяем аудио трек тоже
      if (audioTrack && audioTrack.readyState === 'ended') {
        console.warn('[handleOffer] Audio track is ended, attempting to recreate stream', {
          streamId: stream?.id,
          audioTrackId: audioTrack.id,
          readyState: audioTrack.readyState
        });
        
        // Пытаемся пересоздать стрим если трек ended
        if (!startedRef.current) {
          // Пользователь остановил поиск, просто выходим без ошибки
          return;
        }
        
        try {
          if (stream) {
            const tracks = stream.getTracks?.() || [];
            tracks.forEach((t: any) => {
              try { t.stop(); } catch {}
            });
          }
          stream = await startLocalStream('front');
          if (stream && isValidStream(stream)) {
            const newVideoTrack = stream.getVideoTracks()?.[0];
            const wantCam = camUserPreferenceRef.current === true;
            if (newVideoTrack) {
              newVideoTrack.enabled = wantCam;
            }
            setLocalStream(stream);
            localStreamRef.current = stream;
            setStreamValid(true);
            setCamOn(wantCam);
            console.log('[handleOffer] Successfully recreated stream after ended audio track', {
              streamId: stream.id,
              tracksCount: stream.getTracks()?.length || 0
            });
          } else {
            console.error('[handleOffer] Failed to recreate valid stream after ended audio track');
            return;
          }
        } catch (recreateError) {
          console.error('[handleOffer] Error recreating stream after ended audio track:', recreateError);
          return;
        }
      }
      
      // КРИТИЧНО: НЕ устанавливаем partnerUserId здесь для инициатора!
      // Для инициатора partnerUserId должен быть установлен из call:accepted или handleMatchFound
      // Для receiver partnerUserId будет установлен ниже из fromUserId (ID инициатора)
      const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
      
      // УПРОЩЕНО: только один PC для 1-на-1
      // Проверяем, был ли PC переиспользован выше
      // КРИТИЧНО: Для прямых звонков используем существующий PC, даже если partnerId был обновлен
      let pc = peerRef.current;
      if (!pc || (!isDirectFriendCall && partnerIdRef.current !== from)) {
        // PC не существует или это другой партнер - создаем новый
        console.log('[handleOffer] Creating new PC with stream', {
          streamExists: !!stream,
          streamValid: stream ? isValidStream(stream) : false,
          streamId: stream?.id,
          hasVideoTrack: !!stream?.getVideoTracks()?.[0],
          hasAudioTrack: !!stream?.getAudioTracks()?.[0]
        });
        pc = await ensurePcWithLocal(stream);
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
        
        // КРИТИЧНО: Устанавливаем partnerUserId только для receiver в прямых звонках
        // КРИТИЧНО: Устанавливаем partnerUserId для прямых звонков
        // ВАЖНО: fromUserId в offer - это ID того, кто отправил offer
        // Для receiver: fromUserId - это ID инициатора (правильно)
        // Для инициатора: fromUserId - это ID receiver (правильно, но partnerUserId уже должен быть установлен из call:accepted)
        if (fromUserId) {
          const isDirectFriendCall = isDirectCall || inDirectCall || !!incomingFriendCall;
          const currentPartnerUserId = partnerUserIdRef.current;
          
          if (isDirectFriendCall) {
            // Для прямых звонков:
            // - Если partnerUserId уже установлен, не обновляем (он уже правильный из call:accepted)
            // - Если partnerUserId не установлен, устанавливаем из fromUserId (для receiver)
            // КРИТИЧНО: Для инициатора fromUserId в offer - это его собственный ID, не устанавливаем!
            const isInitiatorOwnId = myUserId && String(fromUserId) === String(myUserId);
            if (isInitiatorOwnId) {
              // Для инициатора fromUserId совпадает с myUserId - это неправильный fromUserId
              // partnerUserId должен быть установлен из call:accepted или handleMatchFound
              console.warn('[handleOffer] Direct call: fromUserId is initiator\'s own ID, not setting partnerUserId', {
                fromUserId,
                myUserId,
                currentPartnerUserId,
                note: 'partnerUserId should be set from call:accepted or handleMatchFound'
              });
            } else if (!currentPartnerUserId) {
              // Для receiver в прямых звонках устанавливаем partnerUserId из fromUserId (ID инициатора)
              partnerUserIdRef.current = String(fromUserId);
              setPartnerUserId(String(fromUserId));
              console.log('[handleOffer] Set partnerUserId for receiver from offer (ID of initiator):', fromUserId);
            } else {
              // partnerUserId уже установлен - не обновляем
              console.log('[handleOffer] partnerUserId already set, not updating:', {
                currentPartnerUserId,
                fromUserId,
                note: 'partnerUserId already set from call:accepted or handleMatchFound'
              });
            }
          } else {
            // Для рандомного чата устанавливаем partnerUserId из fromUserId
            partnerUserIdRef.current = String(fromUserId);
            setPartnerUserId(String(fromUserId));
            console.log('[handleOffer] Set partnerUserId for random chat:', fromUserId);
          }
        } else {
          setPartnerUserId(null);
          partnerUserIdRef.current = null;
        }
      // КРИТИЧНО: Проверяем, не установлен ли уже ontrack, чтобы не перезаписывать его
      const hasOntrack = !!(pc as any).ontrack;
      if (!hasOntrack) {
        attachRemoteHandlers(pc, from);
        console.log('[handleOffer] PC created and handlers attached, proceeding to setRemoteDescription');
      } else {
        console.log('[handleOffer] PC created but handlers already attached, proceeding to setRemoteDescription');
      }
      } else {
        // PC уже существует для этого партнера - он уже настроен выше
        console.log('[handleOffer] Using existing PC for this partner, skipping setup', {
          pcSignalingState: pc?.signalingState,
          pcConnectionState: pc?.connectionState,
          hasOntrack: !!(pc as any).ontrack
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
      
      // Используем peerRef.current вместо локальной переменной pc
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
          // Проверяем еще раз перед вызовом, так как состояние может измениться
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
      
      // Используем peerRef.current для проверки перед созданием answer
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
          // Проверяем еще раз перед созданием answer
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleOffer] PC was changed during answer creation, aborting');
            return;
          }
          const answer = await currentPcForAnswer.createAnswer();
          console.log('[handleOffer] Answer created:', {
            answerType: answer?.type,
            hasAnswer: !!answer
          });
          
          // Проверяем перед setLocalDescription
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleOffer] PC was changed during setLocalDescription, aborting');
            return;
          }
          await currentPcForAnswer.setLocalDescription(answer);
          console.log('[handleOffer] Set local description (answer), PC state:', {
            signalingState: currentPcForAnswer.signalingState,
            connectionState: currentPcForAnswer.connectionState
          });
          // КРИТИЧНО: Для прямых звонков отправляем answer с roomId для гарантированной доставки
          // ВАЖНО: Используем roomId из roomIdRef, а не callId
          // roomId имеет формат room_<socketId1>_<socketId2>, а callId - это временный ID
          const currentRoomId = roomIdRef.current;
          const answerPayload: any = { to: from, answer };
          if ((isDirectCall || inDirectCall || friendCallAccepted) && currentRoomId) {
            // КРИТИЧНО: Проверяем что это действительно roomId (начинается с "room_"), а не callId
            if (currentRoomId.startsWith('room_')) {
              answerPayload.roomId = currentRoomId;
              console.log('[handleOffer] Sending answer with roomId for direct call:', currentRoomId);
            } else {
              // Если roomId не установлен правильно, пытаемся получить его из offer или создать
              const offerRoomId = (offer as any)?.roomId;
              if (offerRoomId && offerRoomId.startsWith('room_')) {
                roomIdRef.current = offerRoomId;
                answerPayload.roomId = offerRoomId;
                console.log('[handleOffer] Using roomId from offer:', offerRoomId);
              } else {
                // Создаем roomId из socket.id обоих пользователей
                const ids = [socket.id, from].sort();
                const generatedRoomId = `room_${ids[0]}_${ids[1]}`;
                roomIdRef.current = generatedRoomId;
                answerPayload.roomId = generatedRoomId;
                console.log('[handleOffer] Generated roomId for answer:', generatedRoomId);
              }
            }
          }
          
          socket.emit('answer', answerPayload);
          console.log('[handleOffer] Created and sent answer to:', from, {
            hasRoomId: !!currentRoomId,
            roomId: currentRoomId,
            isDirectCall: isDirectCall || inDirectCall || friendCallAccepted
          });
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
  
  // Автовыставляем remoteCamOn(true) только если видеотрек «live» И включён (уважаем cam-toggle)
  useEffect(() => {
    if (!remoteStream) return;
    try {
      const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
      if (vt && vt.readyState === 'live' && vt.enabled === true) {
        if (remoteCamOnRef.current !== false) {
          setRemoteCamOn(true);
        }
      }
      // partnerInPiP управляется только через pip:state от партнёра
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
      if (remoteCamOnRef.current !== false) {
        setRemoteCamOn(true);
      }
      setRemoteViewKey(Date.now()); // принудительный ре-рендер RTCView
    }
  }, [partnerInPiP]);
  
  const handleAnswer = useCallback(async ({ from, answer }: { from: string; answer: any }) => {
    console.log('[handleAnswer] Received answer', { from, isDirectCall, hasAnswer: !!answer, pcExists: !!peerRef.current });
    try {
      // Для звонков друг-друг включаем камеру по умолчанию,
      // если пользователь явно не выключал её в этой сессии
      if ((isDirectCall || inDirectCall || friendCallAccepted) && !explicitCamToggledRef.current) {
        camUserPreferenceRef.current = true;
        try {
          const s = localStreamRef.current || localStream;
          const v = s?.getVideoTracks?.()?.[0];
          if (v && !v.enabled) {
            v.enabled = true;
            setCamOn(true);
            try { socket.emit('cam-toggle', { enabled: true, from: socket.id }); } catch {}
          }
        } catch {}
      }
      // УПРОЩЕНО: только один PC для 1-на-1
      let pc = peerRef.current;
      
      // Если PC не существует для инициатора дружеского звонка - создаем его
      // Это может произойти если answer пришел до создания PC в useEffect для call:accepted
      if (!pc && (isDirectCall || inDirectCall || friendCallAccepted)) {
        console.log('[handleAnswer] PC not found for friend call, creating one');
        let stream = localStream || localStreamRef.current;
        
        // Если локального стрима нет, создаем его
        if (!stream) {
          console.log('[handleAnswer] No local stream, creating one');
          try {
            stream = await startLocalStream('front');
            // Если startLocalStream вернул null, создаем напрямую через getUserMedia
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
            pc = await ensurePcWithLocal(stream);
            if (pc) {
              // Устанавливаем partnerId из from если он не установлен (для восстановления после PiP)
              if (!partnerIdRef.current && from) {
                setPartnerId(from);
                partnerIdRef.current = from;
                console.log('[handleAnswer] Set partnerId from answer:', from);
              }
              
              // Используем partnerId из ref или from
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
      
      // Используем peerRef.current вместо локальной переменной pc
      const currentPcForAnswer = peerRef.current;
      if (!currentPcForAnswer || currentPcForAnswer !== pc) {
        console.warn('[handleAnswer] PC was changed or removed, aborting setRemoteDescription');
        return;
      }
      
      // Проверяем состояние PC перед setRemoteDescription
      if (currentPcForAnswer.signalingState === 'have-local-offer') {
        try {
          // КРИТИЧНО: Проверяем что PC не закрыт и валиден
          if (currentPcForAnswer.connectionState === 'closed' ||
              peerRef.current !== currentPcForAnswer) {
            console.warn('[handleAnswer] PC is closed or changed, aborting setRemoteDescription', {
              signalingState: currentPcForAnswer.signalingState,
              connectionState: currentPcForAnswer.connectionState,
              pcMatches: peerRef.current === currentPcForAnswer
            });
            return;
          }
          
          // Проверяем еще раз перед вызовом
          if (peerRef.current !== currentPcForAnswer) {
            console.warn('[handleAnswer] PC was changed right before setRemoteDescription, aborting');
            return;
          }
          
          // КРИТИЧНО: Проверяем состояние еще раз перед setRemoteDescription
          // Если PC уже в stable, значит remote description уже установлен
          if (currentPcForAnswer.signalingState !== 'have-local-offer') {
            console.log('[handleAnswer] PC not in have-local-offer state before setRemoteDescription, current state:', currentPcForAnswer.signalingState);
            return;
          }
          
          await currentPcForAnswer.setRemoteDescription(answer);
          console.log('[handleAnswer] Set remote answer, PC state:', currentPcForAnswer.signalingState);
        } catch (error: any) {
          // Если ошибка связана с закрытым PC или невалидным состоянием, просто игнорируем
          const errorMsg = String(error?.message || '');
          if (errorMsg.includes('closed') || 
              errorMsg.includes('null') || 
              errorMsg.includes('receiver') ||
              errorMsg.includes('undefined') ||
              errorMsg.includes('wrong state') ||
              errorMsg.includes('stable')) {
            console.warn('[handleAnswer] PC was closed or in wrong state during setRemoteDescription, ignoring error', {
              errorMessage: errorMsg,
              signalingState: currentPcForAnswer.signalingState,
              connectionState: currentPcForAnswer.connectionState
            });
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
    // Если уходим со страницы — игнорируем событие и НИЧЕГО не запускаем
    if (leavingRef.current) {
      console.log('[handlePeerStopped] Ignored due to leaving');
      return;
    }
    // Если поиск уже прекращён — игнорируем
    if (!startedRef.current) {
      console.log('[handlePeerStopped] Ignored because started=false');
      return;
    }
    // Сохраняем состояние ДО очистки (stopRemoteOnly сбрасывает ссылки)
    const oldPartnerId = partnerIdRef.current;
    const hadPartner = !!oldPartnerId;
    const isRandomChat = !isDirectCall && !inDirectCallRef.current;
    const wasDirectCall = isDirectCall || inDirectCallRef.current;
    const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
    
    // Партнёр остановил поиск — мягко очищаем удалённое соединение без навигации
    stopRemoteOnly();
    setPartnerInPiP(false);
    try { stopSpeaker(); } catch {}
    
    // Полностью закрываем старое PC чтобы избежать ложных срабатываний bindConnHandlers
    if (peerRef.current) {
      console.log('[handlePeerStopped] Cleaning up old PC');
      try {
        cleanupPeer(peerRef.current);
      } catch (e) {
        console.warn('[handlePeerStopped] Error cleaning PC:', e);
      }
      peerRef.current = null;
    }
    
    // НЕ запускаем автопоиск если:
    // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
    // 2. Это был прямой звонок (isDirectCall или inDirectCall) - для прямых звонков нет автопоиска
    // 3. Это скипнутый пользователь - автопоиск должен запускаться только у того, кто нажал "Далее"
    // ВАЖНО: peer:stopped приходит у скипнутого пользователя, когда его партнер нажал "Далее"
    // У скипнутого пользователя НЕ должен запускаться автопоиск - он должен остаться в текущем состоянии
    // Автопоиск запускается только у того, кто нажал "Далее" (через onNext)
    if (isInactive || wasDirectCall) {
      console.log('[handlePeerStopped] Skipping auto-search - call ended or was direct call', { 
        isInactive, 
        wasDirectCall,
        hadPartner 
      });
      return;
    }
    
    // ВАЖНО: При нажатии "Далее" партнером запускаем автопоиск для ОБОИХ пользователей
    // peer:stopped приходит когда партнер нажал "Далее" - запускаем поиск нового собеседника
    if (isRandomChat && hadPartner && !isInactive) {
      console.log('[handlePeerStopped] Partner stopped (skipped by partner), starting auto-search for both users', { 
        hadPartner, 
        wasStarted: startedRef.current,
        isRandomChat
      });
      
      // Запускаем автопоиск для скипнутого пользователя
      setLoading(true);
      setStarted(true);
      setRemoteStream(null);
      setPartnerId(null);
      setPartnerUserId(null);
      
      // Запускаем поиск нового собеседника без задержки
      try { 
        socket.emit('next'); 
        console.log('[handlePeerStopped] Emitted next for auto-search after partner skipped');
      } catch (e) {
        console.warn('[handlePeerStopped] Error emitting next:', e);
      }
    } else {
      console.log('[handlePeerStopped] Partner stopped, NOT starting auto-search', { 
        hadPartner, 
        wasStarted: startedRef.current,
        isRandomChat,
        isInactive,
        reason: isInactive ? 'inactive state' : !isRandomChat ? 'not random chat' : !hadPartner ? 'no partner' : 'unknown'
      });
    }
    
    // Сбрасываем флаг если он был установлен
    if (manuallyRequestedNextRef.current) {
      manuallyRequestedNextRef.current = false;
    }
  }, [stopRemoteOnly, isDirectCall, cleanupPeer, wasFriendCallEnded, setLoading, setStarted]);

  const handlePeerLeft = useCallback(({ peerId, reason }: { peerId: string; reason?: string }) => {
    if (leavingRef.current) {
      console.log('[handlePeerLeft] Ignored due to leaving');
      return;
    }
    if (!startedRef.current) {
      console.log('[handlePeerLeft] Ignored because started=false');
      return;
    }
    console.log('[handlePeerLeft] Peer left:', peerId, 'reason:', reason);
    // Если это наш текущий собеседник - очищаем соединение
    if (peerId === partnerIdRef.current) {
      const oldPartnerId = partnerIdRef.current;
      const hadPartner = !!oldPartnerId;
      const isRandomChat = !isDirectCall && !inDirectCallRef.current;
      const wasDirectCall = isDirectCall || inDirectCallRef.current;
      const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
      
      stopRemoteOnly();
      setPartnerInPiP(false); // Сбрасываем состояние PiP при остановке партнёра
      
      // Полностью закрываем старое PC чтобы избежать ложных срабатываний bindConnHandlers
      if (peerRef.current) {
        console.log('[handlePeerLeft] Cleaning up old PC');
        try {
          cleanupPeer(peerRef.current);
        } catch (e) {
          console.warn('[handlePeerLeft] Error cleaning PC:', e);
        }
        peerRef.current = null;
      }
      
      // НЕ запускаем автопоиск если:
      // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
      // 2. Это был прямой звонок (isDirectCall или inDirectCall) - для прямых звонков нет автопоиска
      // 3. Это скипнутый пользователь - автопоиск должен запускаться только у того, кто нажал "Далее"
      if (isInactive || wasDirectCall) {
        console.log('[handlePeerLeft] Skipping auto-search - call ended or was direct call', { 
          isInactive, 
          wasDirectCall,
          oldPartnerId 
        });
        return;
      }
      
      // ВАЖНО: При нажатии "Далее" партнером запускаем автопоиск для ОБОИХ пользователей
      // peer:left приходит когда партнер нажал "Далее" или вышел - запускаем поиск нового собеседника
      if (isRandomChat && hadPartner && !isInactive) {
        console.log('[handlePeerLeft] Partner left (skipped by partner), starting auto-search for both users', { 
          wasStarted: startedRef.current,
          isRandomChat,
          reason
        });
        
        // Запускаем автопоиск для скипнутого пользователя
        setLoading(true);
        setStarted(true);
        
        // Запускаем поиск нового собеседника
        try { 
          socket.emit('next'); 
          console.log('[handlePeerLeft] Emitted next for auto-search after partner left');
        } catch (e) {
          console.warn('[handlePeerLeft] Error emitting next:', e);
        }
      } else {
        console.log('[handlePeerLeft] Partner left, NOT starting auto-search', { 
          wasStarted: startedRef.current,
          isRandomChat,
          reason,
          isInactive,
          hadPartner,
          skipReason: isInactive ? 'inactive state' : !isRandomChat ? 'not random chat' : !hadPartner ? 'no partner' : 'unknown'
        });
      }
      
      // Сбрасываем флаг если он был установлен
      if (manuallyRequestedNextRef.current) {
        manuallyRequestedNextRef.current = false;
      }
    }
  }, [stopRemoteOnly, isDirectCall, cleanupPeer, wasFriendCallEnded, setLoading, setStarted]);

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
      setRemoteCamOn(false);
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
    // Не показываем бэйдж в неактивном состоянии (после завершения звонка)
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const isInactive = !!isInactiveState;
    
    if (!hasPartnerUserId || !hasStarted || isInactive) {
      console.log('[showFriendBadge] Returning false - missing conditions', {
        hasPartnerUserId,
        hasStarted,
        isInactive,
        partnerUserId,
        started,
        isInactiveState
      });
      return false;
    }
    
    const isFriend = friends.some(f => String(f._id) === String(partnerUserId));
    const result = isFriend;
    
    console.log('[showFriendBadge] Computed', {
      partnerUserId,
      started,
      isInactiveState,
      friendsCount: friends.length,
      isFriend,
      result,
      friendsIds: friends.map(f => String(f._id)),
      partnerUserIdString: partnerUserId ? String(partnerUserId) : null
    });
    
    return result;
  }, [partnerUserId, friends, started, isInactiveState]);

  // Логируем изменения partnerUserId, isPartnerFriend и showFriendBadge для отладки
  useEffect(() => {
    console.log('[UI State] partnerUserId/isPartnerFriend/showFriendBadge changed', {
      partnerUserId,
      partnerUserIdRef: partnerUserIdRef.current,
      isPartnerFriend,
      showFriendBadge,
      started,
      isInactiveState,
      friendsCount: friends.length,
      friendsIds: friends.map(f => String(f._id)),
      inDirectCall,
      friendCallAccepted,
      isDirectCall
    });
  }, [partnerUserId, isPartnerFriend, showFriendBadge, started, isInactiveState, friends, inDirectCall, friendCallAccepted, isDirectCall]);
  
  // Логируем изменения started для отладки
  useEffect(() => {
    console.log('[UI State] started changed', {
      started,
      startedRef: startedRef.current,
      partnerUserId,
      partnerUserIdRef: partnerUserIdRef.current,
      inDirectCall,
      friendCallAccepted,
      isDirectCall
    });
  }, [started, partnerUserId, inDirectCall, friendCallAccepted, isDirectCall]);
  
  // Логируем изменения friends для отладки
  useEffect(() => {
    console.log('[UI State] friends changed', {
      friendsCount: friends.length,
      friendsIds: friends.map(f => String(f._id)),
      partnerUserId,
      partnerUserIdRef: partnerUserIdRef.current,
      isPartnerFriend,
      showFriendBadge
    });
  }, [friends, partnerUserId, isPartnerFriend, showFriendBadge]);

  // Мемоизированное вычисление shouldShowLocalVideo для оптимизации перерендеров
  const shouldShowLocalVideo = useMemo(() => {
    const isReturnFrombackground = route?.params?.returnToActiveCall;
    const result = !isInactiveState && (
      (inDirectCall && localStream && camOn) || // Показываем видео при звонке друзей если камера включена
      (!inDirectCall && localStream && started && camOn) || // Для рандомного чата показываем если started=true И camOn=true
      (isReturnFrombackground && localStream && camOn) // При возврате из background показываем только если камера включена
    );
    // Гарантируем, что всегда возвращается boolean
    return Boolean(result);
  }, [isInactiveState, inDirectCall, localStream, camOn, started, route?.params?.returnToActiveCall]);

  // УПРОЩЕНО: Кнопка «Завершить» для режима friends с активным соединением
  const showAbort = useMemo(() => {
    const isFriendsMode = isDirectCall || inDirectCall || friendCallAccepted;
    // Для дружеских звонков показываем "Завершить" сразу после принятия звонка
    // Не ждем remoteStream - он может появиться позже
    // hasActiveCall должен быть false если мы в неактивном состоянии
    const hasActiveCall = !isInactiveState && (!!roomIdRef.current || !!currentCallIdRef.current || pcConnected || started);
    
    // Дополнительная проверка для возврата из background
    const isReturnFrombackground = route?.params?.returnToActiveCall;
    const hasbackgroundContext = false;
    
    const result = isFriendsMode && hasActiveCall;
    const resultWithbackground = result || (isReturnFrombackground && hasbackgroundContext);
    
    // ВАЖНО: Показываем кнопку "Завершить" как заблокированную после завершения звонка (неактивное состояние)
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
                  // Останавливаем треки remote stream перед очисткой ref
                  if (remoteStreamRef.current) {
                    try {
                      const tracks = remoteStreamRef.current.getTracks?.() || [];
                      tracks.forEach((t: any) => {
                        try {
                          if (t && t.readyState !== 'ended' && t.readyState !== null) {
                            t.enabled = false;
                            t.stop();
                          }
                        } catch {}
                      });
                    } catch {}
                  }
                  setRemoteStream(null);
                  remoteStreamRef.current = null;
                  setPartnerId(null);
                  setPartnerUserId(null);
                  // КРИТИЧНО: Выключаем локальную камеру для рандомного чата
                  console.log('[handleSwipeBack] Stopping local stream for random chat');
                  try {
                    stopLocalStream(false).catch(() => {});
                    setLocalStream(null);
                    localStreamRef.current = null;
                    setCamOn(false);
                    setMicOn(false);
                  } catch (e) {
                    console.warn('[handleSwipeBack] Error stopping local stream:', e);
                  }
                  
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
    if (leavingRef.current) {
      console.log('[handleDisconnected] Ignored due to leaving');
      return;
    }
    if (!startedRef.current) {
      console.log('[handleDisconnected] Ignored because started=false');
      return;
    }
    // УПРОЩЕНО: При дисконнекте (1-на-1)
    const wasInCall = !!remoteStreamRef.current;
    const wasStarted = started;
    const wasDirectCall = isDirectCall;
    const wasInDirectCall = inDirectCall;
    
    // Сохраняем старые значения ДО очистки для проверки типа звонка
    const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
    
    console.log('[handleDisconnected] State:', { wasInCall, wasStarted, wasDirectCall, wasInDirectCall, isInactive });
    
    stopMicMeter();
    setRemoteCamOn(false);
    try { peerRef.current?.close(); } catch {}
    peerRef.current = null;
    setRemoteStream(null);
    setPartnerId(null);
    setPartnerUserId(null);
    setRemoteMutedMain(false);
    setPartnerInPiP(false); // Сбрасываем состояние PiP при разрыве соединения
    setInDirectCall(false);
    stopSpeaker();
    
    // Определяем тип чата
    const isRandomChat = !wasDirectCall && !wasInDirectCall;
    
    // КРИТИЧНО: Для рандомного чата сбрасываем refs дружеских звонков
    if (isRandomChat) {
      friendCallAcceptedRef.current = false;
      inDirectCallRef.current = false;
      setFriendCallAccepted(false);
      console.log('[handleDisconnected] Reset friend call refs for random chat');
    }
    const wasDirectCallFlag = wasDirectCall || wasInDirectCall;
    
    // НЕ запускаем автопоиск если:
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
    
    // ВАЖНО: Если партнер вышел из общения (любым способом), запускаем автопоиск
    // Это гарантирует, что оставшийся пользователь автоматически найдет нового собеседника
    if (isRandomChat && wasInCall) {
      console.log('[handleDisconnected] Starting auto-search for random chat after connection lost', { wasStarted, wasInCall });
      setLoading(true); // Показываем спиннер загрузки
      setStarted(true); // Включаем поиск
      try { 
        socket.emit('next'); 
        console.log('[handleDisconnected] Emitted next for auto-search');
      } catch (e) {
        console.warn('[handleDisconnected] Error emitting next:', e);
      }
      return;
    }
    
    if (wasInCall) {
      // Если звонок был — возвращаемся в [Home, VideoChat]
      console.log('[handleDisconnected] Returning to VideoChat (was direct call)');
      setLoading(false);
      setStarted(false);
      // КРИТИЧНО: Для рандомного чата выключаем камеру при возврате
      if (isRandomChat) {
        console.log('[handleDisconnected] Stopping local stream for random chat');
        try {
          stopLocalStream(false).catch(() => {});
        } catch (e) {
          console.warn('[handleDisconnected] Error stopping local stream:', e);
        }
      }
      goToVideoChatWithHomeUnder();
    } else {
      // звонок не состоялся — вернёмся на origin
      console.log('[handleDisconnected] No call established, returning to origin');
      setLoading(false);
      setStarted(false);
      // КРИТИЧНО: Для рандомного чата выключаем камеру при возврате
      if (isRandomChat) {
        console.log('[handleDisconnected] Stopping local stream for random chat (no call)');
        try {
          stopLocalStream(false).catch(() => {});
        } catch (e) {
          console.warn('[handleDisconnected] Error stopping local stream:', e);
        }
      }
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
          // Защита от множественных обработок одного и того же события
          // Это предотвращает обработку нескольких pip:state(inPiP=false) событий подряд
          if (pipStateProcessingRef.current) {
            console.log('[pip:state] ⚠️ Already processing pip:state return, skipping duplicate');
            return;
          }
          
          pipStateProcessingRef.current = true;
          
          // ВАЖНО: Восстанавливаем remoteStream в state из ref, если он отсутствует
          // Это предотвращает показ спиннера загрузки вместо видео
          const remoteStreamFromRef = remoteStreamRef.current;
          // Используем state переменную remoteStream (доступна через замыкание)
          if (remoteStreamFromRef && !remoteStream) {
            setRemoteStream(remoteStreamFromRef);
            console.log('[pip:state] ✅ Restored remoteStream in state from ref');
          }
          
          // Используем ref или state для получения потока
          const currentRemoteStream = remoteStreamFromRef || remoteStream || remoteStreamRef.current;
          const videoTrack = (currentRemoteStream as any)?.getVideoTracks?.()?.[0];
          
          console.log('[pip:state] Partner returned from PiP - checking video track state', {
            hasRemoteStream: !!remoteStream,
            hasVideoTrack: !!videoTrack,
            videoTrackEnabled: videoTrack?.enabled,
            videoTrackReadyState: videoTrack?.readyState,
            remoteCamOnRef: remoteCamOnRef.current,
            canAutoShowRemote: canAutoShowRemote(),
            remoteForcedOffRef: remoteForcedOffRef.current
          });
          
          if (videoTrack && currentRemoteStream) {
            // ВАЖНО: Сохраняем реальное состояние камеры ДО включения трека
            const wasCameraEnabled = videoTrack.enabled;
            videoTrack.enabled = true; // включаем трек для отображения
            
            // ВАЖНО: Если камера партнера была включена (wasCameraEnabled === true),
            // устанавливаем remoteCamOn СИНХРОННО, чтобы избежать показа заглушки
            // Это критично для предотвращения мигания UI
            if (wasCameraEnabled) {
              // Камера партнера включена - убираем заглушку СРАЗУ (синхронно)
              setRemoteCamOn(true);
              remoteCamOnRef.current = true;
              console.log('[pip:state] ✅ Partner camera was ON - removed away placeholder immediately (sync), set remoteCamOn=true');
              
              // Обновляем remoteViewKey в следующем кадре для плавности
              requestAnimationFrame(() => {
                if (!pipReturnUpdateRef.current) {
                  pipReturnUpdateRef.current = true;
                  setRemoteViewKey(Date.now());
                  setTimeout(() => {
                    pipReturnUpdateRef.current = false;
                  }, 100);
                }
                setLoading(false);
                // Сбрасываем флаг обработки после завершения
                pipStateProcessingRef.current = false;
                console.log('[pip:state] Partner returned from PiP — remote video restored', {
                  finalRemoteCamOn: remoteCamOnRef.current,
                  videoTrackEnabled: videoTrack.enabled
                });
              });
            } else {
              // Камера была выключена - используем requestAnimationFrame для проверки canAutoShowRemote
              requestAnimationFrame(() => {
                // Проверяем реальное состояние камеры еще раз (может измениться)
                const currentRemoteStream = remoteStreamRef.current;
                const currentVideoTrack = (currentRemoteStream as any)?.getVideoTracks?.()?.[0];
                const isCurrentlyEnabled = currentVideoTrack?.enabled === true;
                
                if (isCurrentlyEnabled) {
                  // Камера включилась между проверками - показываем видео
                  setRemoteCamOn(true);
                  remoteCamOnRef.current = true;
                  console.log('[pip:state] Partner camera enabled after check - set remoteCamOn=true');
                } else if (canAutoShowRemote() && remoteCamOnRef.current !== false) {
                  // Камера была выключена, но можем авто-показать если не было явного cam-toggle(false)
                  setRemoteCamOn(true);
                  console.log('[pip:state] Partner camera was OFF but canAutoShowRemote=true - set remoteCamOn=true');
                } else {
                  // Камера выключена и нельзя авто-показать - показываем заглушку
                  setRemoteCamOn(false);
                  remoteCamOnRef.current = false;
                  console.log('[pip:state] Partner camera was OFF and cannot auto-show - keeping away placeholder');
                }
                
                // Обновляем remoteViewKey один раз после установки remoteCamOn
                if (!pipReturnUpdateRef.current) {
                  pipReturnUpdateRef.current = true;
                  setRemoteViewKey(Date.now());
                  setTimeout(() => {
                    pipReturnUpdateRef.current = false;
                  }, 100);
                }
                setLoading(false);
                // Сбрасываем флаг обработки после завершения
                pipStateProcessingRef.current = false;
                console.log('[pip:state] Partner returned from PiP — remote video restored', {
                  finalRemoteCamOn: remoteCamOnRef.current,
                  videoTrackEnabled: videoTrack.enabled
                });
              });
            }
          } else {
            console.log('[pip:state] Partner back from PiP, but no video track found - keeping remoteCamOn as is', {
              remoteCamOnRef: remoteCamOnRef.current
            });
            if (canAutoShowRemote() && remoteCamOnRef.current !== false) {
              setRemoteCamOn(true);
              remoteCamOnRef.current = true;
              console.log('[pip:state] No video track but canAutoShowRemote=true - set remoteCamOn=true');
            }
            setLoading(false);
            // Сбрасываем флаг обработки даже если videoTrack не найден
            pipStateProcessingRef.current = false;
          }
          
          // ВАЖНО: Перезапускаем метр микрофона после возврата партнера из PiP
          // Звук продолжает работать в PiP, поэтому эквалайзер должен сразу восстановиться
          try {
            const hasActiveCall = !!partnerIdRef.current || !!roomIdRef.current || !!currentCallIdRef.current;
            const isFriendCallActive = isDirectCall || inDirectCallRef.current || friendCallAcceptedRef.current;
            const stream = localStream || localStreamRef.current;
            const remoteStreamForCheck = remoteStream || remoteStreamRef.current;
            
            console.log('[pip:state] Checking conditions for mic meter restart', {
              hasActiveCall,
              isFriendCallActive,
              hasLocalStream: !!stream,
              hasRemoteStream: !!remoteStreamForCheck,
              hasPeer: !!peerRef.current
            });
            
            if (isFriendCallActive && hasActiveCall) {
              if (stream && (remoteStreamForCheck || peerRef.current)) {
                // Вызываем сразу без задержки - звук продолжает работать в PiP
                try {
                  startMicMeter();
                  console.log('[pip:state] ✅ Restarted mic meter after partner returned from PiP (immediate)');
                } catch (e) {
                  console.warn('[pip:state] ❌ Error restarting mic meter:', e);
                }
              } else {
                console.log('[pip:state] ⚠️ Cannot restart mic meter - missing stream or peer', {
                  hasStream: !!stream,
                  hasRemoteStream: !!remoteStreamForCheck,
                  hasPeer: !!peerRef.current
                });
              }
            } else {
              console.log('[pip:state] ⚠️ Cannot restart mic meter - not active friend call', {
                hasActiveCall,
                isFriendCallActive
              });
            }
          } catch (e) {
            console.warn('[pip:state] ❌ Error in mic meter restart logic:', e);
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
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        console.log('[call:timeout] Ignoring - not a friend call');
        return;
      }
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
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        console.log('[call:busy] Ignoring - not a friend call');
        return;
      }
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      stopIncomingAnim();
      setInDirectCall(false);
      
      // НЕ показываем тост - у занятых друзей уже есть бэйдж "Занято" и задизейблена кнопка
      // В рандомном поиске это нормальный процесс поиска свободного собеседника
      
      // Очищаем WebRTC состояние при call:busy
      try {
        console.log('[call:busy] Cleaning up WebRTC state...');
        const pc = peerRef.current;
        if (pc) {
          try { pc.getSenders?.().forEach((s: any) => { try { s.replaceTrack?.(null); } catch {} }); } catch {}
          try {
            const hadOntrack = !!(pc as any).ontrack;
            (pc as any).ontrack = null;
            (pc as any).onaddstream = null;
            (pc as any).onicecandidate = null;
            if (hadOntrack) {
              console.log('[onAbortCall] Cleared ontrack handler from PC', {
                pcSignalingState: pc?.signalingState,
                pcConnectionState: pc?.connectionState
              });
            }
          } catch {}
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
        setRemoteCamOn(false);
        
        // Очищаем roomIdRef
        roomIdRef.current = null;
        console.log('[call:busy] WebRTC cleanup completed');
      } catch (err) {
        console.error('[call:busy] WebRTC cleanup error:', err);
      }
      
      // Если шёл поиск — останавливаем
      try { if (started) onStartStop(); } catch {}
    });
    
    socket.on('call:declined', (d: any) => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        console.log('[call:declined] Ignoring - not a friend call');
        return;
      }
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
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        console.log('[call:canceled] Ignoring - not a friend call');
        return;
      }
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
  }, [handleDisconnected, handleMatchFound, handleOffer, handleAnswer, handleCandidate, handlePeerStopped, handlePeerHangup, handlePeerLeft, incomingFriendCall?.from, showToast, L, isDirectCall, sendCameraState, startMicMeter, canAutoShowRemote, localStream, remoteStream, inDirectCall, friendCallAccepted]);
  
  // Входящий звонок от друга (совместимость: транслируем и из call:incoming)
  useEffect(() => {
    
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
      
      // Устанавливаем incomingCall всегда, даже если callId нет
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

    // Регистрируем обработчики с приоритетом - сначала call:incoming, потом friend:call:incoming
    // Это нужно чтобы оба обработчика могли сработать если событие отправлено в обоих форматах
    socket.on("call:incoming", directCallHandler);
    socket.on("friend:call:incoming", friendCallHandler);
    socket.on("friend:call:end", friendCallEndHandler);

    return () => {
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
        // Устанавливаем roomId если он пришел в событии
        if (d?.roomId && roomIdRef.current !== d.roomId) {
          roomIdRef.current = d.roomId;
          socket.emit('room:join:ack', { roomId: d.roomId });
          console.log('[call:accepted] Set roomId and joined room:', d.roomId);
        }
      } catch {}
      
      // Для friend-call камера по умолчанию ВКЛ, если пользователь её явно не выключал
      if (!explicitCamToggledRef.current) {
        camUserPreferenceRef.current = true;
      }
      
      // КРИТИЧНО: Устанавливаем флаги для ВСЕХ участников звонка (и инициатора, и receiver)
      // Это нужно чтобы handleMatchFound мог корректно обработать соединение
      // КРИТИЧНО: Для инициатора определяем по флагам, а не по route params
      // Инициатор = есть friendCallAccepted/inDirectCall, но нет incomingFriendCall
      const hasIncomingCallForInit = !!incomingFriendCall || !!incomingCall;
      const isInitiator = (isDirectCall && isDirectInitiator) || 
                          (friendCallAccepted && inDirectCall && !hasIncomingCallForInit);
      // Receiver определяется как: не инициатор И (есть входящий звонок ИЛИ уже принят звонок ИЛИ есть callId/roomId в событии)
      // Также проверяем по partnerUserId из route params - если он есть, это может быть receiver
      const hasIncomingCall = !!incomingFriendCall || !!incomingCall;
      const hasCallId = !!d?.callId || !!currentCallIdRef.current;
      const hasRoomId = !!d?.roomId || !!roomIdRef.current;
      const hasPeerUserId = !!route?.params?.peerUserId;
      const isReceiver = !isInitiator && (hasIncomingCall || friendCallAccepted || hasCallId || hasRoomId || hasPeerUserId);
      
      // Для инициатора устанавливаем флаги при получении call:accepted
      if (isInitiator) {
        console.log('[call:accepted] Setting flags for initiator');
        
        // КРИТИЧНО: Сбрасываем неактивное состояние если оно было установлено после рандомного чата
        if (isInactiveStateRef.current) {
          console.log('[call:accepted] Resetting inactive state for initiator');
          isInactiveStateRef.current = false;
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
        }
        
        // КРИТИЧНО: Устанавливаем partnerUserId для инициатора
        // ВАЖНО: d?.fromUserId в call:accepted для инициатора - это ID receiver (который принял звонок)
        // Используем route?.params?.peerUserId как fallback, но приоритет отдаем d?.fromUserId
        const peerUserId = d?.fromUserId || route?.params?.peerUserId;
        console.log('[call:accepted] Initiator: Checking partnerUserId setup', {
          routePeerUserId: route?.params?.peerUserId,
          eventFromUserId: d?.fromUserId,
          peerUserId,
          currentPartnerUserId: partnerUserIdRef.current,
          hasPeerUserId: !!peerUserId
        });
        
        if (peerUserId) {
          // КРИТИЧНО: Всегда обновляем partnerUserId для инициатора, даже если он уже установлен
          // Это гарантирует правильное значение после рандомного чата
          if (!partnerUserIdRef.current || partnerUserIdRef.current !== String(peerUserId)) {
            partnerUserIdRef.current = String(peerUserId);
            setPartnerUserId(String(peerUserId));
            console.log('[call:accepted] Set/Updated partnerUserId for initiator (ID of receiver):', peerUserId, {
              fromEvent: !!d?.fromUserId,
              fromRoute: !!route?.params?.peerUserId && !d?.fromUserId,
              wasAlreadySet: !!partnerUserIdRef.current && partnerUserIdRef.current !== String(peerUserId),
              previousValue: partnerUserIdRef.current
            });
          } else {
            console.log('[call:accepted] Initiator: partnerUserId already correctly set (ID of receiver):', peerUserId);
          }
        } else {
          console.warn('[call:accepted] No partnerUserId available for initiator', {
            routePeerUserId: route?.params?.peerUserId,
            eventFromUserId: d?.fromUserId,
            note: 'Will try to get from handleMatchFound'
          });
        }
        
        // Устанавливаем флаги синхронно через refs для немедленного использования
        friendCallAcceptedRef.current = true;
        inDirectCallRef.current = true;
        setFriendCallAccepted(true);
        setInDirectCall(true);
        setStarted(true);
        
        // Создаем локальный стрим для инициатора, если его еще нет
        // Это нужно чтобы при приходе match_found стрим уже был готов
        if (!localStream) {
          console.log('[call:accepted] Creating local stream for initiator');
          startLocalStream('front').then(async (stream) => {
            if (stream) {
              console.log('[call:accepted] Local stream created for initiator', {
                streamId: stream.id,
                hasVideoTrack: !!stream.getVideoTracks()?.[0],
                hasAudioTrack: !!stream.getAudioTracks()?.[0]
              });
              
              // КРИТИЧНО: Включаем камеру после создания стрима
              const videoTrack = stream.getVideoTracks()?.[0];
              if (videoTrack) {
                videoTrack.enabled = true;
                setCamOn(true);
                console.log('[call:accepted] Camera enabled for initiator');
              }
              
              // КРИТИЧНО: Создаем PeerConnection после создания стрима с задержкой
              if (!peerRef.current && friendCallAcceptedRef.current && inDirectCallRef.current) {
                console.log('[call:accepted] Waiting 2000ms before creating PeerConnection for initiator after stream ready');
                setTimeout(async () => {
                  if (!peerRef.current && friendCallAcceptedRef.current && inDirectCallRef.current) {
                    console.log('[call:accepted] Creating PeerConnection for initiator after delay');
                    try {
                      // КРИТИЧНО: Для инициатора partnerId будет установлен из match_found
                      // Если partnerId еще не установлен, ждем match_found перед созданием PC
                      if (!partnerIdRef.current) {
                        console.log('[call:accepted] Initiator: partnerId not set yet, waiting for match_found before creating PC');
                        return;
                      }
                      
                      const pc = await ensurePcWithLocal(stream);
                      if (pc && partnerIdRef.current) {
                        attachRemoteHandlers(pc, partnerIdRef.current);
                        console.log('[call:accepted] PeerConnection created for initiator with partnerId:', partnerIdRef.current);
                      } else if (pc) {
                        console.warn('[call:accepted] PeerConnection created for initiator but no partnerId');
                      }
                    } catch (e) {
                      console.error('[call:accepted] Error creating PeerConnection for initiator:', e);
                    }
                  }
                }, 2000);
              }
            }
          }).catch((e) => {
            console.error('[call:accepted] Error creating local stream for initiator:', e);
          });
        } else {
          console.log('[call:accepted] Local stream already exists for initiator', {
            streamId: localStream.id,
            hasVideoTrack: !!localStream.getVideoTracks()?.[0],
            hasAudioTrack: !!localStream.getAudioTracks()?.[0]
          });
          // Если стрим уже существует, убеждаемся что камера включена
          const videoTrack = localStream.getVideoTracks()?.[0];
          if (videoTrack && !videoTrack.enabled) {
            videoTrack.enabled = true;
            setCamOn(true);
            console.log('[call:accepted] Camera enabled for initiator (existing stream)');
          }
          // КРИТИЧНО: Создаем PeerConnection если стрим уже есть с задержкой
          if (!peerRef.current && friendCallAcceptedRef.current && inDirectCallRef.current) {
            console.log('[call:accepted] Waiting 2000ms before creating PeerConnection for initiator with existing stream');
            setTimeout(async () => {
              if (!peerRef.current && friendCallAcceptedRef.current && inDirectCallRef.current) {
                console.log('[call:accepted] Creating PeerConnection for initiator with existing stream after delay');
                try {
                  const pc = await ensurePcWithLocal(localStream);
                  if (pc && partnerIdRef.current) {
                    attachRemoteHandlers(pc, partnerIdRef.current);
                    console.log('[call:accepted] PeerConnection created for initiator with existing stream and partnerId:', partnerIdRef.current);
                  } else if (pc) {
                    console.log('[call:accepted] PeerConnection created for initiator with existing stream, partnerId will be set later');
                  }
                } catch (e) {
                  console.error('[call:accepted] Error creating PeerConnection for initiator with existing stream:', e);
                }
              }
            }, 2000);
          }
        }
      }
      
      // КРИТИЧНО: Для receiver также устанавливаем флаги при получении call:accepted
      // Это исправляет проблему когда после случайного чата нельзя позвонить другу
      if (isReceiver) {
        console.log('[call:accepted] Setting flags for receiver', {
          hasIncomingFriendCall: !!incomingFriendCall,
          currentFriendCallAccepted: friendCallAccepted,
          currentInDirectCall: inDirectCall,
          currentStarted: started,
          from: d?.from
        });
        
        // Сбрасываем неактивное состояние если оно было установлено после случайного чата
        if (isInactiveStateRef.current) {
          console.log('[call:accepted] Resetting inactive state for receiver');
          isInactiveStateRef.current = false;
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
        }
        
        // Устанавливаем флаги для receiver синхронно через refs для немедленного использования
        friendCallAcceptedRef.current = true;
        inDirectCallRef.current = true;
        setFriendCallAccepted(true);
        setInDirectCall(true);
        setStarted(true);
        
        // КРИТИЧНО: Устанавливаем partnerId для receiver ДО создания стрима
        // ВАЖНО: d?.from должен содержать socket.id инициатора (не receiver!)
        // Это исправлено в backend: для receiver отправляется from: aSock.id (socket.id инициатора)
        const partnerSocketId = d?.from;
        console.log('[call:accepted] Receiver: partnerId setup', {
          from: d?.from,
          fromUserId: d?.fromUserId,
          currentPartnerId: partnerIdRef.current,
          socketId: socket.id,
          note: 'from should be socket.id of initiator, not receiver'
        });
        if (partnerSocketId && !partnerIdRef.current) {
          // КРИТИЧНО: Проверяем что from не равен нашему socket.id
          // Если from равен нашему socket.id, это ошибка в backend
          if (partnerSocketId === socket.id) {
            console.error('[call:accepted] CRITICAL: from equals our socket.id! This is a backend error!', {
              from: partnerSocketId,
              ourSocketId: socket.id,
              fromUserId: d?.fromUserId
            });
            // Не устанавливаем partnerId если это наш socket.id
            // Будем ждать правильного partnerId из match_found или handleOffer
          } else {
            partnerIdRef.current = partnerSocketId;
            setPartnerId(partnerSocketId);
            console.log('[call:accepted] Set partnerId for receiver (socket.id of initiator):', partnerSocketId);
          }
        } else if (!partnerSocketId) {
          console.warn('[call:accepted] No partnerSocketId in d?.from for receiver', { 
            from: d?.from, 
            fromUserId: d?.fromUserId,
            incomingFriendCallFrom: incomingFriendCall?.from 
          });
        } else if (partnerIdRef.current && partnerIdRef.current !== partnerSocketId) {
          console.warn('[call:accepted] Receiver: partnerId mismatch!', {
            current: partnerIdRef.current,
            new: partnerSocketId,
            from: d?.from,
            fromUserId: d?.fromUserId
          });
          // Обновляем partnerId если он отличается
          partnerIdRef.current = partnerSocketId;
          setPartnerId(partnerSocketId);
        }
        
        // КРИТИЧНО: Устанавливаем partnerUserId для receiver
        // ВАЖНО: d?.fromUserId в call:accepted для receiver - это ID инициатора (который отправил звонок)
        // НЕ используем route?.params?.peerUserId для receiver, так как он может быть неправильным
        // КРИТИЧНО: Для receiver ВСЕГДА устанавливаем partnerUserId из d?.fromUserId, даже если он уже установлен
        // Это гарантирует правильное значение, так как initialPeerUserId может быть неправильным
        if (d?.fromUserId) {
          const previousValue = partnerUserIdRef.current;
          const isCorrectValue = previousValue === String(d.fromUserId);
          
          // ВСЕГДА обновляем partnerUserId для receiver из d?.fromUserId, даже если он уже установлен
          // Это гарантирует правильное значение после рандомного чата или неправильной инициализации
          partnerUserIdRef.current = String(d.fromUserId);
          setPartnerUserId(String(d.fromUserId));
          console.log('[call:accepted] Set/Updated partnerUserId for receiver (ID of initiator):', d.fromUserId, {
            fromEvent: true,
            wasAlreadySet: !!previousValue,
            previousValue: previousValue,
            wasCorrect: isCorrectValue,
            note: 'For receiver, partnerUserId should be ID of initiator (who sent the call)'
          });
        } else {
          console.warn('[call:accepted] No fromUserId in call:accepted for receiver', {
            eventFromUserId: d?.fromUserId,
            note: 'Will try to get from handleMatchFound or handleOffer'
          });
        }
        
        // Скрываем входящий overlay
        setIncomingOverlay(false);
        stopIncomingAnim();
        
        // Создаем локальный стрим для receiver, если его еще нет
        // Это нужно чтобы при приходе match_found стрим уже был готов
        if (!localStream) {
          console.log('[call:accepted] Creating local stream for receiver');
          startLocalStream('front').then(async (stream) => {
            if (stream) {
              console.log('[call:accepted] Local stream created for receiver', {
                streamId: stream.id,
                hasVideoTrack: !!stream.getVideoTracks()?.[0],
                hasAudioTrack: !!stream.getAudioTracks()?.[0]
              });
              
              // КРИТИЧНО: Включаем камеру после создания стрима
              const videoTrack = stream.getVideoTracks()?.[0];
              if (videoTrack) {
                videoTrack.enabled = true;
                setCamOn(true);
                console.log('[call:accepted] Camera enabled for receiver');
              }
              
              // КРИТИЧНО: НЕ создаем PeerConnection для receiver в call:accepted
              // PC будет создан в handleOffer или handleMatchFound когда придет offer
              // Это предотвращает создание нескольких PC
              console.log('[call:accepted] Receiver: Stream ready, waiting for offer/match_found to create PC', {
                hasPartnerId: !!partnerIdRef.current,
                partnerId: partnerIdRef.current,
                partnerUserId: partnerUserIdRef.current
              });
            }
          }).catch((e) => {
            console.error('[call:accepted] Error creating local stream for receiver:', e);
          });
        } else {
          console.log('[call:accepted] Local stream already exists for receiver', {
            streamId: localStream.id,
            hasVideoTrack: !!localStream.getVideoTracks()?.[0],
            hasAudioTrack: !!localStream.getAudioTracks()?.[0]
          });
          // Если стрим уже существует, убеждаемся что камера включена
          const videoTrack = localStream.getVideoTracks()?.[0];
          if (videoTrack && !videoTrack.enabled) {
            videoTrack.enabled = true;
            setCamOn(true);
            console.log('[call:accepted] Camera enabled for receiver (existing stream)');
          }
          // КРИТИЧНО: НЕ создаем PeerConnection для receiver в call:accepted
          // PC будет создан в handleOffer или handleMatchFound когда придет offer
          // Это предотвращает создание нескольких PC
          console.log('[call:accepted] Receiver: Existing stream ready, waiting for offer/match_found to create PC', {
            hasPartnerId: !!partnerIdRef.current,
            partnerId: partnerIdRef.current,
            partnerUserId: partnerUserIdRef.current
          });
        }
      }
      
      // Создаем PeerConnection после принятия вызова
      // КРИТИЧНО: Используем refs вместо state для проверки, так как state обновляется асинхронно
      try {
        const stream = localStream || localStreamRef.current;
        // Используем refs для проверки, так как state может быть еще не обновлен
        const hasFriendCallAccepted = friendCallAcceptedRef.current || friendCallAccepted || isInitiator || isReceiver;
        const hasInDirectCall = inDirectCallRef.current || inDirectCall;
        const shouldCreatePc = hasFriendCallAccepted && hasInDirectCall;
        
        console.log('[call:accepted] Checking PeerConnection creation', {
          isInitiator,
          isReceiver,
          hasStream: !!stream,
          hasFriendCallAccepted,
          hasInDirectCall,
          shouldCreatePc,
          hasPeerRef: !!peerRef.current,
          partnerIdRef: partnerIdRef.current,
          partnerUserIdRef: partnerUserIdRef.current
        });
        
        if (stream && !peerRef.current && shouldCreatePc) {
          console.log('[call:accepted] Creating PeerConnection for accepted call', {
            isInitiator,
            isReceiver,
            hasStream: !!stream
          });
          const pc = await ensurePcWithLocal(stream);
          if (pc) {
            // Устанавливаем partnerId если он еще не установлен (для инициатора)
            const peerUserId = route?.params?.peerUserId || partnerUserIdRef.current;
            if (peerUserId && !partnerIdRef.current) {
              // Для инициатора partnerId будет установлен позже через match_found или offer
              // Но мы можем установить partnerUserId для привязки handlers
              console.log('[call:accepted] Setting partnerUserId for PC handlers:', peerUserId);
            }
            
            // Привязываем handlers если есть partnerId (может быть установлен позже для инициатора)
            if (partnerIdRef.current) {
              attachRemoteHandlers(pc, partnerIdRef.current);
              console.log('[call:accepted] PeerConnection created and ready with partnerId:', partnerIdRef.current);
            } else {
              console.log('[call:accepted] PeerConnection created, partnerId will be set later via match_found/offer');
            }
          }
        } else if (!stream && shouldCreatePc) {
          console.warn('[call:accepted] Cannot create PeerConnection - stream not ready yet, will be created when stream is available');
        } else if (peerRef.current && shouldCreatePc) {
          console.log('[call:accepted] PeerConnection already exists, reusing it');
          // Если PC уже существует, убеждаемся что handlers привязаны
          if (partnerIdRef.current) {
            attachRemoteHandlers(peerRef.current, partnerIdRef.current);
          }
        }
      } catch (e) {
        console.error('[call:accepted] Error creating PeerConnection:', e);
      }
    };
    try { socket.on('call:accepted', onAccepted); } catch {}
    return () => { try { socket.off('call:accepted', onAccepted); } catch {} };
  }, [localStream, friendCallAccepted, inDirectCall, isDirectCall, isDirectInitiator, ensurePcWithLocal, attachRemoteHandlers, incomingFriendCall, incomingCall, isInactiveState, stopIncomingAnim, startLocalStream, route?.params?.peerUserId]);


  // --------------------------
  // Unmount cleanup
  // --------------------------
  useEffect(() => {
    // call:ended только для звонков друзей (directCall/inDirectCall), НЕ для рандомных!
    const onCallEnded = async (data?: any) => {
      logger.debug('[call:ended] Received call:ended event', data);
      
      // Проверяем, был ли это звонок друга, используя и state, и refs
      // Это важно когда пользователь в PiP и state может быть не актуален
      // ВАЖНО: Для рандомного чата НЕ должно быть isDirectCall, inDirectCall, friendCallAccepted, roomIdRef (для друзей), или currentCallIdRef
      // partnerIdRef может быть и для рандомного чата, поэтому НЕ используем его в проверке
      const wasFriendCall = isDirectCall || inDirectCall || friendCallAccepted || 
                           inDirectCallRef.current || friendCallAcceptedRef.current ||
                           !!currentCallIdRef.current || 
                           (!!roomIdRef.current && (roomIdRef.current.startsWith('room_') || roomIdRef.current.includes('call_')));
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
      
      // Также проверяем, что callId/roomId совпадает (если указан)
      // Это предотвращает завершение не того звонка
      // ВАЖНО: Для звонков друзей сервер отправляет roomId как callId
      // ВАЖНО: Если refs уже очищены (один пользователь уже нажал "Завершить"),
      // но это был звонок друга - принимаем call:ended
      const receivedId = data?.callId;
      const currentCallId = currentCallIdRef.current;
      const currentRoomId = roomIdRef.current;
      
      if (receivedId && (currentCallId || currentRoomId)) {
        // Проверяем совпадение с callId или roomId
        const idMatches = receivedId === currentCallId || receivedId === currentRoomId;
        if (!idMatches) {
          console.log('[call:ended] Ignoring call:ended - callId/roomId mismatch', {
            receivedCallId: receivedId,
            currentCallId,
            currentRoomId
          });
          return;
        }
      } else if (receivedId && !currentCallId && !currentRoomId && wasFriendCall) {
        // Если refs уже очищены, но это был звонок друга - принимаем call:ended
        // Это означает, что один пользователь уже нажал "Завершить" и очистил refs
        console.log('[call:ended] ✅ Accepting call:ended even though refs are cleared (wasFriendCall=true)', {
          receivedCallId: receivedId
        });
      }
      
      // Скрываем background если активен и очищаем сохраненные streams
      try {
        // background removed
        // background removed
      } catch {}
      
      // САМОЕ ПЕРВОЕ ДЕЛО - устанавливаем peerRef.current = null и isInactiveStateRef.current = true
      // Это должно быть ДО любых других действий, чтобы обработчики видели что звонок завершен
      const pcMain = peerRef.current;
      const pcPreCreated = preCreatedPcRef.current;
      
      // СНАЧАЛА устанавливаем peerRef.current = null, чтобы обработчики не видели активный PC
      peerRef.current = null;
      preCreatedPcRef.current = null;
      
      // СНАЧАЛА очищаем ВСЕ refs СИНХРОННО
      currentCallIdRef.current = null;
      roomIdRef.current = null;
      partnerUserIdRef.current = null;
      partnerIdRef.current = null;
      
      // СНАЧАЛА устанавливаем isInactiveStateRef.current = true СИНХРОННО
      isInactiveStateRef.current = true;
      setIsInactiveState(true);
      setWasFriendCallEnded(true);
      console.log('🔴 [call:ended] Set peerRef=null, isInactiveState=true, refs cleared FIRST (before any cleanup)');
      
      // Теперь очищаем обработчики ПЕРЕД закрытием PC
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
      
      // Останавливаем все таймеры и метры СРАЗУ
      console.log('[call:ended] Stopping mic meter and cleaning up resources');
      stopMicMeter();
      // Дополнительно устанавливаем micLevel=0 для эквалайзера
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
      
      // Очищаем state
      setPartnerUserId(null);
      setPartnerId(null);
      
      // Также устанавливаем все флаги в false чтобы предотвратить любые автоматические действия
      setStarted(false);
      setCamOn(false);
      setMicOn(false);
      setFriendCallAccepted(false);
      setInDirectCall(false);
      
      // СНАЧАЛА очищаем все PeerConnection и их обработчики ПЕРЕД остановкой стрима
      //, потому что обработчики могут сработать во время остановки стрима
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
      
      // Останавливаем локальные потоки ПОСЛЕ очистки обработчиков
      // Ждем завершения остановки, чтобы камера точно выключилась
      // stopLocalStream сам закроет PeerConnection внутри, но мы также явно очищаем их
      try { 
        await stopLocalStream(); 
        console.log('[call:ended] Local stream stopped successfully');
        
        // Дополнительная проверка - убеждаемся что все треки действительно остановлены
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
      
      // После остановки стрима ЯВНО закрываем ВСЕ PeerConnection
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
      
      // Очищаем remote stream и все связанные состояния
      try {
        const remoteStream = remoteStreamRef.current;
        if (remoteStream) {
          const tracks = (remoteStream as any).getTracks?.() || [];
          tracks.forEach((t: any) => {
            try {
              t.enabled = false;
              t.stop();
              // Дополнительная попытка освободить трек
              try { (t as any).release?.(); } catch {}
            } catch {}
          });
        }
      } catch (e) {
        console.warn('[call:ended] Error cleaning up remote stream:', e);
      }
      setRemoteStream(null);
      remoteStreamRef.current = null;
      // Принудительно обновляем remoteViewKey для очистки отображения
      setRemoteViewKey(0);
      
      // localStreamRef и localStream уже очищены в stopLocalStream выше
      
      // Сбрасываем ВСЕ флаги состояния для правильного отображения неактивного состояния
      // Делаем это ПОСЛЕ очистки всех потоков и PeerConnection
      // чтобы гарантировать что следующему вызову не останется "мусора" от предыдущего
      setLocalRenderKey(k => k + 1);
      setMicOn(false);
      setCamOn(false);
      setRemoteMutedMain(false);
      setRemoteCamOn(false); // Должно быть false после завершения звонка
      setPartnerInPiP(false); // Сбрасываем partnerInPiP
      setFriendCallAccepted(false);
      setInDirectCall(false);
      setStarted(false);
      setPcConnected(false); // Сбрасываем состояние соединения
      setLoading(false); // Сбрасываем loading
      
      // Флаги неактивного состояния уже установлены выше ПЕРЕД остановкой стрима
      // Не дублируем здесь, просто логируем
      
      console.log('[call:ended] Call cleanup completed - all resources cleared, ready for next call');
      console.log('🔴 [call:ended] Call cleanup completed successfully - handlers should be cleared, no more offers should be created, camera should be off');
      
      try { showToast('Звонок завершён'); } catch {}

      // ВАЖНО: НЕ отправляем presence:update здесь, так как сервер уже обработал это
      // при получении call:end и отправил presence:update с busy: false обоим участникам
      // Сервер автоматически убирает бейдж "занято" у обоих друзей при завершении звонка
      
      // Все состояния уже установлены выше, не дублируем
    };

    socket.on('call:ended', onCallEnded);
    return () => { socket.off('call:ended', onCallEnded); };
  }, [isDirectCall, inDirectCall, friendCallAccepted, stopMicMeter, stopSpeaker, stopIncomingAnim, cleanupPeer, stopLocalStream, showToast]);

  // Обработчик уведомления о том, что партнер перешел в background режим
  useEffect(() => {
    const onPartnerEnteredbackground = (data: any) => {
      console.log('[bg:entered] Partner entered background mode:', data);
      console.log('[bg:entered] Partner is in background, but we continue showing video normally');
    };

    const onPartnerExitedbackground = (data: any) => {
      console.log('[bg:exited] Partner exited background mode:', data);
      console.log('[bg:exited] Partner returned from background, video continues normally');
    };

    socket.on('bg:entered', onPartnerEnteredbackground);
    socket.on('bg:exited', onPartnerExitedbackground);

    return () => {
      socket.off('bg:entered', onPartnerEnteredbackground);
      socket.off('bg:exited', onPartnerExitedbackground);
    };
  }, []);

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
      
      // Для дружеских звонков проверяем не только roomId, но и наличие PC или callId
      // Это важно во время установки соединения, когда roomId еще может быть null, но PC уже создан
      const hasActiveCall = hasActiveRoomId || hasActiveCallId || (hasActivePC && hasActivePartner);
      const keepAliveForPiP = (isFriendCall && hasActiveCall) || pip.visible;

      if (keepAliveForPiP) {
        // Не останавливаем спикер, не закрываем PC, не стопим треки
        return;
      }

      // Для рандомного чата отправляем stop и room:leave при unmount
      const isRandomChat = !isFriendCall && (roomIdRef.current || partnerIdRef.current || startedRef.current);
      // ВАЖНО: НЕ останавливаем стрим если пользователь только что начал поиск (started=true, но нет partnerId и roomId)
      // Это предотвращает остановку стрима сразу после нажатия "Начать"
      const isJustStarted = startedRef.current && !partnerIdRef.current && !roomIdRef.current;
      const hasStream = !!(localStreamRef.current || localStream);
      
      if (isRandomChat && !isJustStarted) {
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
      
      // Очищаем глобальные ссылки на функции
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
      
      // Сбрасываем флаг остановки при размонтировании
      isStoppingRef.current = false;

      try {
        const pc = peerRef.current;
        if (pc) cleanupPeer(pc);
      } catch {}
      peerRef.current = null;

      // ВАЖНО: НЕ останавливаем стрим если пользователь только что начал поиск ИЛИ стрима нет ИЛИ есть активное соединение
      // Это предотвращает остановку стрима сразу после нажатия "Начать" и при активном соединении
      // ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА: Проверяем, что мы не в процессе создания стрима (loading=true)
      const isLoading = loading;
      // ВАЖНО: Проверяем наличие активного соединения (partnerId или roomId)
      // Если есть активное соединение, НЕ останавливаем стрим - он нужен для видеозвонка
      const hasActiveConnection = !!partnerIdRef.current || !!roomIdRef.current;
      if (!isJustStarted && hasStream && !isLoading && !hasActiveConnection) {
        console.log('[Unmount cleanup] Calling stopLocalStream', { isJustStarted, hasStream, isLoading, hasActiveConnection });
        try { stopLocalStream(); } catch {}
      } else {
        console.log('[Unmount cleanup] Skipping stopLocalStream', { 
          isJustStarted, 
          hasStream, 
          isLoading,
          hasActiveConnection,
          reason: isJustStarted ? 'just started search' : isLoading ? 'loading' : hasActiveConnection ? 'active connection' : 'no stream'
        });
      }
      // ВАЖНО: НЕ сбрасываем camOn если есть активное соединение
      // Камера должна оставаться включенной при активном видеозвонке
      if (!hasActiveConnection) {
        try { setCamOn(false); } catch {}
      } else {
        console.log('[Unmount cleanup] Preserving camOn state due to active connection');
      }
      try { setTimeout(() => { mediaDevices.enumerateDevices?.(); }, 0); } catch {}
      try { stopSpeaker(); } catch {}
    };
  }, []); // cleanup только при unmount, без повторных срабатываний на смену зависимостей

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
          
          // Если это не звонок с другом (рандомный чат) — немедленно завершаем поиск и стрим перед навигацией
          if (!isFriendCall) {
            try {
              leavingRef.current = true;
              startedRef.current = false;
              setStarted(false);
              setLoading(false);
              isInactiveStateRef.current = true;
              setIsInactiveState(true);
              // КРИТИЧНО: Выключаем локальную камеру для рандомного чата
              console.log('[PanGestureHandler] Stopping local stream for random chat');
              try {
                stopLocalStream(false).catch(() => {});
                setLocalStream(null);
                localStreamRef.current = null;
                setCamOn(false);
                setMicOn(false);
              } catch (e) {
                console.warn('[PanGestureHandler] Error stopping local stream:', e);
              }
              // Сигналы на сервер
              try { socket.emit('stop'); } catch {}
              const rid = roomIdRef.current;
              if (rid) { try { socket.emit('room:leave', { roomId: rid }); } catch {} }
              // Очистка PC
              try { if (peerRef.current) cleanupPeer(peerRef.current); } catch {}
              peerRef.current = null;
              preCreatedPcRef.current = null;
              setRemoteStream(null);
              remoteStreamRef.current = null as any;
              setRemoteCamOn(false);
              setRemoteMutedMain(false);
              setPartnerId(null);
              setPartnerUserId(null);
              partnerIdRef.current = null;
              partnerUserIdRef.current = null as any;
              roomIdRef.current = null;
              currentCallIdRef.current = null;
            } catch {}
          }
          
          // Если находимся в неактивном состоянии (завершенный звонок),
          // просто навигируем назад без показа PiP и без каких-либо действий
          if (isInactiveStateRef.current) {
            console.log('[PanGestureHandler] In inactive state, stopping media and navigating back');
            // Гарантированно гасим камеру/микрофон и очищаем соединение ПЕРЕД навигацией
            try {
              leavingRef.current = true;
              // Сохраним roomId, чтобы отослать room:leave после остановки стрима
              const rid = roomIdRef.current;
              // Сначала сбрасываем идентификаторы, чтобы stopLocalStream не сохранял стрим
              startedRef.current = false;
              setStarted(false);
              isInactiveStateRef.current = true;
              setIsInactiveState(true);
              partnerIdRef.current = null;
              partnerUserIdRef.current = null as any;
              roomIdRef.current = null;
              currentCallIdRef.current = null;
              // Останавливаем локальный стрим (не ждем)
              try { stopLocalStream(false).catch(() => {}); } catch {}
              setLocalStream(null);
              localStreamRef.current = null;
              setCamOn(false);
              setMicOn(false);
              // Закрываем PC
              try { if (peerRef.current) cleanupPeer(peerRef.current); } catch {}
              peerRef.current = null;
              preCreatedPcRef.current = null;
              // Останавливаем треки remote stream перед очисткой ref
              if (remoteStreamRef.current) {
                try {
                  const tracks = remoteStreamRef.current.getTracks?.() || [];
                  tracks.forEach((t: any) => {
                    try {
                      if (t && t.readyState !== 'ended' && t.readyState !== null) {
                        t.enabled = false;
                        t.stop();
                      }
                    } catch {}
                  });
                } catch {}
              }
              setRemoteStream(null);
              remoteStreamRef.current = null as any;
              setRemoteCamOn(false);
              setRemoteMutedMain(false);
              try { stopMicMeter(); } catch {}
              try { stopSpeaker(); } catch {}
              // Сигналы на сервер (после локальной остановки)
              try { socket.emit('stop'); } catch {}
              try { if (rid) socket.emit('room:leave', { roomId: rid }); } catch {}
            } catch {}
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
            
            // Сохраняем partnerUserId в navParams для восстановления при возврате
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
                partnerId: partnerId || partnerIdRef.current, // Сохраняем partnerId для восстановления соединения
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
          // Убираем условие !remoteStream - модалка должна показываться даже если есть remoteStream
          // из предыдущего звонка (например, в неактивном состоянии после завершенного звонка)
          // Исключение: не показываем если уже принят этот конкретный звонок (friendCallAccepted)
          // или если есть активный remoteStream от того же пользователя (проверяем по partnerUserId)
          // В неактивном состоянии remoteStream не считается активным, даже если существует
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
                      
                      // Для friend-call включаем камеру по умолчанию, если пользователь не нажимал "выкл"
                      if (!explicitCamToggledRef.current) {
                        camUserPreferenceRef.current = true;
                      }
                      
                      // Сбрасываем блокировку (если была) — это новый явный приём вызова
                      try { clearDeclinedBlock(); } catch {}
                      
                      // Используем callId из incomingCall
                      const finalCallId = incomingCall?.callId || currentCallIdRef.current;
                      if (finalCallId) {
                        currentCallIdRef.current = finalCallId;
                        console.log('[Accept Call] Set currentCallIdRef to:', currentCallIdRef.current);
                        // roomId будет установлен в событии call:accepted от бэкенда
                        // Не устанавливаем roomId здесь, чтобы не использовать callId вместо roomId
                      }
                      
                      // СНАЧАЛА устанавливаем флаги режима друзей
                      setFriendCallAccepted(true);
                      setInDirectCall(true);
                      
                      // Устанавливаем partnerUserId из входящего звонка
                      if (incomingFriendCall?.from) {
                        setPartnerUserId(incomingFriendCall.from);
                        partnerUserIdRef.current = incomingFriendCall.from;
                        console.log('[Accept Call] Set partnerUserId:', incomingFriendCall.from);
                      }
                      
                      // Сначала сбрасываем входящий звонок и закрываем модалку
                      setIncomingOverlay(false);
                      setIncomingFriendCall(null);
                      setIncomingCall(null);
                      stopIncomingAnim();
                      
                      // Очищаем старый PeerConnection если он существует
                      // Это важно при принятии звонка в неактивном состоянии, когда может остаться старый PC
                      const oldPc = peerRef.current;
                      if (oldPc) {
                        console.log('[Accept Call] Cleaning up old PeerConnection before accepting new call');
                        try {
                          // Сначала удаляем все треки из старого PC
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
                      
                      // Очищаем remote stream от предыдущего звонка если он существует
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
                      
                      // Выходим из неактивного состояния ПЕРЕД установкой флагов активного звонка
                      // Устанавливаем флаг принятия звонка СРАЗУ, чтобы избежать race condition
                      setFriendCallAccepted(true);
                      setIsInactiveState(false);
                      setWasFriendCallEnded(false); // Сбрасываем флаг завершенного звонка
                      
                      // Даем время для обновления state перед созданием стрима
                      await new Promise(resolve => setTimeout(resolve, 50));
                      
                      // Устанавливаем started для создания PeerConnection
                      setStarted(true);
                      setLoading(true);
                      setCamOn(true); // Включаем камеру сразу при принятии вызова
                      setMicOn(true); // Включаем микрофон сразу при принятии вызова
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
                      
                      // Уведомляем друзей что мы заняты
                      try {
                        socket.emit('presence:update', { status: 'busy', roomId: roomIdRef.current });
                        console.log('[Accept Call] Sent presence:update busy for roomId:', roomIdRef.current);
                      } catch (e) {
                        console.error('[Accept Call] Failed to send presence update:', e);
                      }
                      
                      // Отправляем состояние камеры после принятия вызова
                      setTimeout(() => {
                        try {
                          sendCameraState();
                          console.log('[Accept Call] Sent camera state after accepting call');
                        } catch (e) {
                          console.error('[Accept Call] Failed to send camera state:', e);
                        }
                      }, 100);
                      
                      // Гарантируем локальный поток для ответа
                      // PeerConnection будет создан в handleMatchFound когда придет событие match_found
                      // Это важно чтобы partnerId был установлен правильно перед созданием PC
                      // К этому моменту friendCallAccepted уже установлен в true выше, 
                      // поэтому ensureStreamReady сможет создать стрим даже если был в неактивном состоянии
                      try { 
                        const stream = await ensureStreamReady();
                        if (stream) {
                          // ВАЖНО: сохраняем стрим и в state, и в ref,
                          // чтобы локальный RTCView сразу отрисовал превью
                          setLocalStream(stream);
                          localStreamRef.current = stream;
                          // Убеждаемся что камера включена (camOn уже установлен выше)
                          const videoTrack = stream.getVideoTracks()?.[0];
                          if (videoTrack) {
                            if (!videoTrack.enabled) {
                              videoTrack.enabled = true;
                              console.log('[Accept Call] Enabled video track after ensureStreamReady');
                            }
                            // Убеждаемся что camOn установлен в true
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
              // В неактивном состоянии ВСЕГДА показываем только текст "Собеседник", независимо от наличия remoteStream
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
              const remoteVideoEnded = !remoteVideoTrack || remoteVideoTrack.readyState === 'ended';
              const remoteVideoDisabled = !!remoteVideoTrack && remoteVideoTrack.enabled === false;
              const partnerInPiPState = partnerInPiP && !pip.visible;
              
              // Если собеседник выключил камеру — показываем заглушку «Отошел..»
              if (!remoteCamOn) {
                try {
                  console.log('[videochat] peer:away (remoteCamOn=false)', {
                    hasRemoteStream: !!remoteStream,
                    vt: remoteVideoTrack ? { enabled: remoteVideoTrack.enabled, rs: remoteVideoTrack.readyState } : null,
                    partnerInPiPState
                  });
                } catch {}
                return <AwayPlaceholder />;
              }
              
              // Если партнёр в PiP и НЕТ/ВЫКЛЮЧЕН видеотрек — показываем черный экран (не застывший кадр)
              // Если видеотрек уже есть, отрисовываем видео (иначе у некоторых устройств остаётся чёрный экран)
              if (partnerInPiPState && (remoteVideoEnded || remoteVideoDisabled)) {
                try {
                  console.log('[videochat] peer:black (PiP, no/disabled vt)', {
                    vt: remoteVideoTrack ? { enabled: remoteVideoTrack.enabled, rs: remoteVideoTrack.readyState } : null
                  });
                } catch {}
                return <View style={[styles.rtc, { backgroundColor: 'black' }]} />;
              }
              
              // Если есть поток И remoteCamOn=true — показываем видео (только при живом включённом видеотреке)
              if (remoteStream && remoteCamOn) {
                try {
                  const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
                  const canShowVideo = !!vt && vt.readyState !== 'ended' && vt.enabled === true;
                  if (canShowVideo) {
                    try {
                      console.log('[videochat] peer:video', {
                        vt: { enabled: vt.enabled, rs: vt.readyState },
                        remoteViewKey
                      });
                    } catch {}
                    return (
                      <RTCView
                        key={`remote-video-${remoteViewKey}-${remoteStream.id || 'unknown'}`}
                        streamURL={remoteStream.toURL()}
                        style={styles.rtc}
                        objectFit="cover"
                        zOrder={1}
                      />
                    );
                  }
                } catch (e) {
                  console.warn('[RTCView] Error rendering remote stream:', e);
                }
              }
              
              // Если нет видеотрека, он завершён или выключен — показываем пустой блок с подписью «Собеседник»
              if (!remoteVideoTrack || remoteVideoEnded || remoteVideoDisabled) {
                try {
                  console.log('[videochat] peer:placeholder (no/ended/disabled vt)', {
                    hasRemoteStream: !!remoteStream,
                    vt: remoteVideoTrack ? { enabled: remoteVideoTrack.enabled, rs: remoteVideoTrack.readyState } : null
                  });
                } catch {}
                return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
              
              // Фолбэк: если что-то пошло не так, лучше показать заглушку
              try { console.log('[videochat] peer:fallback-away'); } catch {}
              return <AwayPlaceholder />;
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
                {(() => {
                  const shouldShowAddFriend = started && !isInactiveState && !!partnerUserId && !isPartnerFriend;
                  if (shouldShowAddFriend || (started && !isInactiveState && !!partnerUserId)) {
                    console.log('[UI Render] Add Friend button condition check', {
                      started,
                      isInactiveState,
                      hasPartnerUserId: !!partnerUserId,
                      partnerUserId,
                      isPartnerFriend,
                      shouldShowAddFriend,
                      willRender: shouldShowAddFriend
                    });
                  }
                  return shouldShowAddFriend;
                })() && (
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
                {(() => {
                  const shouldShowBadge = !isInactiveState && showFriendBadge;
                  if (shouldShowBadge || (!isInactiveState && !!partnerUserId)) {
                    console.log('[UI Render] Friend Badge condition check', {
                      isInactiveState,
                      showFriendBadge,
                      partnerUserId,
                      isPartnerFriend,
                      shouldShowBadge,
                      willRender: shouldShowBadge
                    });
                  }
                  return shouldShowBadge;
                })() && (
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
          // ВАЖНО: Показываем видео только если камера включена (camOn === true)
          // Если камера выключена (camOn === false), показываем заглушку с надписью "Вы"
          // Это гарантирует, что при нажатии на кнопку отключения камеры показывается заглушка, а не последний кадр
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
        {/** Завершить только для звонков с другом */}
        {showAbort ? (
          // Во время звонка всегда одна кнопка «Завершить»
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
            <Text style={styles.bigBtnText}>Завершить</Text>
            <MaterialIcons name="call-end" size={18} color="#fff" />
          </TouchableOpacity>)
        ) : (
          // Стандартные кнопки «Начать / Далее» вне звонка
          (<>
            <TouchableOpacity
              style={[styles.bigBtn, started ? styles.btnDanger : styles.btnTitan, isInactiveState && styles.disabled]}
              disabled={isInactiveState}
              onPress={isInactiveState ? undefined : onStartStop}
            >
              <Text style={styles.bigBtnText}>
                {started ? L("stop") : L("start")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.bigBtn, styles.btnTitan, (!started || isNexting || isInactiveState) && styles.disabled]}
              disabled={!started || isNexting || isInactiveState}
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
    ...((Platform.OS === "ios" ? { height: Dimensions.get('window').height * 0.4 } : { height: Dimensions.get('window').height * 0.42 })
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
