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
// ICE-конфигурация теперь загружается внутри WebRTCSession
import { BlurView } from 'expo-blur';
import { SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAppTheme } from '../theme/ThemeProvider';
import {
  mediaDevices,
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
import { WebRTCSession, WebRTCSessionConfig } from '../src/webrtc/session';

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
      
      // ICE-конфигурация теперь загружается внутри WebRTCSession
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
    if (focusEffectGuardRef.current) return;
    
    // КРИТИЧНО: Сбрасываем leavingRef при входе на экран
    // Это предотвращает срабатывание cleanup при начале поиска
    leavingRef.current = false;

    // Вернулись из PiP -> прячем PiP, включаем свои видео/спикер, стартуем VAD
    const isReturningFromPiP = route?.params?.resume && route?.params?.fromPiP && !fromPiPProcessedRef.current;
    
    if (isReturningFromPiP) {
      fromPiPProcessedRef.current = true;
      focusEffectGuardRef.current = true;

      // Прячем PiP только при возврате из PiP
      if (pipRef.current.visible) {
        pipRef.current.hidePiP();
        
        // Вызываем exitPiP из session - он сам отправит pip:state и восстановит камеру
        const session = sessionRef.current;
        if (session) {
          session.exitPiP();
        }
      }

      // Обновляем remoteViewKey через session
      const session = sessionRef.current;
      if (session) {
        requestAnimationFrame(() => {
          if (!pipReturnUpdateRef.current) {
            pipReturnUpdateRef.current = true;
            setRemoteViewKey(session.getRemoteViewKey());
            setTimeout(() => { pipReturnUpdateRef.current = false; }, 100);
          }
        });
      }

      // ВАЖНО: Перезапускаем метр микрофона после возврата из PiP
      // Звук продолжает работать в PiP, поэтому эквалайзер должен сразу восстановиться
      try {
        const hasActiveCall = !!partnerId || !!roomId || !!currentCallIdRef.current;
        const isFriendCallActive = isDirectCall || inDirectCall || friendCallAccepted;
        const stream = localStream;
        const remoteStreamForCheck = remoteStream || pipRef.current.remoteStream;
        
        // Управление микрофонным метром теперь полностью в session.ts
        // session сам запускает/останавливает метр при подключении/отключении
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
      // Focus lost
    }

    return () => {
      // КРИТИЧНО: Проверяем, не идет ли процесс начала поиска
      // Если идет, не выполняем cleanup
      // Проверяем не только loading, но и started без партнера/комнаты (начало поиска)
      const justStarted = startedRef.current && !partnerId && !roomId;
      const isStartingSearch = loadingRef.current || justStarted;
      
      
      if (isStartingSearch && !isInactiveStateRef.current) {
        return;
      }
      
      leavingRef.current = true;
      if (focusEffectGuardRef.current) {
        return;
      }

      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      // ВАЖНО: Проверяем isJustStarted ПЕРЕД вычислением hasActiveCall
      // Это предотвращает остановку стрима сразу после нажатия "Начать"
      const isJustStarted = startedRef.current && !partnerId && !roomId;
      
      // hasActiveCall должен быть false если мы в неактивном состоянии ИЛИ если пользователь только что начал поиск
      // Это предотвращает показ PiP после завершения звонка и остановку стрима при начале поиска
      // Для рандомного чата roomId может быть пустым (direct WebRTC), поэтому
      // считаем звонок активным также при наличии partnerId
      const hasActiveCall = (!!roomId || !!partnerId)
        && !isInactiveStateRef.current
        && !isJustStarted;
      // КРИТИЧНО: НЕ останавливаем стрим если пользователь только что начал поиск (isJustStarted)
      // Это предотвращает выключение камеры сразу после нажатия "Начать"
      // КРИТИЧНО: isRandomChat должен быть false если isJustStarted = true ИЛИ идет процесс начала поиска
      // Также не останавливаем если loading=true (идет процесс начала поиска)
      // Используем isStartingSearch из проверки выше
      const isRandomChat = !isFriendCall && !isStartingSearch && (roomId || partnerId || (startedRef.current && partnerId));

      // Для рандомного чата: ЛЮБОЙ уход со страницы = выход из чата/поиска
      // Порядок: сначала сбрасываем состояние и идентификаторы → останавливаем стрим → шлём сокет-события
      if (isRandomChat) {
        const roomIdToLeave = roomId;
        // 1) Сброс состояний поиска/активности и идентификаторов ДО остановки стрима
        startedRef.current = false;
        setStarted(false);
        setLoading(false);
        isInactiveStateRef.current = true;
        setIsInactiveState(true);
        // КРИТИЧНО: Сбрасываем refs для дружеских звонков, чтобы они не мешали новому звонку
        inDirectCallRef.current = false;
        setFriendCallAccepted(false);
        setInDirectCall(false);
        partnerUserIdRef.current = null as any;
        // 2) Останавливаем локальный стрим (камера/микрофон)
        const session = sessionRef.current;
        if (session) {
          session.stopLocalStream(false);
        }
        // localStream управляется через события session
        setCamOn(false);
        setMicOn(false);
        if (session) {
          session.stopRandom();
          if (roomIdToLeave) {
            session.leaveRoom(roomIdToLeave);
          }
        }
        if (session) {
          session.destroy();
        }
        setPartnerUserId(null);
        // Управление микрофонным метром теперь полностью в session.ts
        try { stopSpeaker(); } catch {}
      }

      // Показываем PiP только если его еще нет и есть активный звонок (только для friend calls)
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      // Двойная проверка: и через hasActiveCall (который уже проверяет isInactiveStateRef), и напрямую
      const currentPip = pipRef.current;
      if (isFriendCall && hasActiveCall && !currentPip.visible && !isInactiveState && !isInactiveStateRef.current) {
        focusEffectGuardRef.current = true;

        // Выключение камеры теперь в session.enterPiP()

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
          roomId: roomId || '',
          partnerName: partner?.nick || 'Друг',
          partnerAvatarUrl: avatarUrl,
          muteLocal: !micOn,
          muteRemote: remoteMutedMain,
          localStream: localStream || null,
          remoteStream: remoteStream || null,
          navParams: {
            ...route?.params,
            peerUserId: partnerUserId || partnerUserIdRef.current,
            partnerId: partnerId || partnerId, // Сохраняем partnerId для восстановления соединения
          } as any,
        });

        // Отправка pip:state и выключение камеры теперь в session.enterPiP()
        const session = sessionRef.current;
        if (session) {
          session.enterPiP();
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
  const [partnerUserId, setPartnerUserId] = useState<string | null>(initialPeerUserId || null); // Mongo _id для дружбы
  const [roomId, setRoomId] = useState<string | null>(null); // roomId для прямых звонков

  const [myNick, setMyNick] = useState<string>('');
  const [myAvatar, setMyAvatar] = useState<string>('');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [remoteViewKey, setRemoteViewKey] = useState(0);
  
  // Состояние неактивного режима после нажатия "Завершить"
  const [isInactiveState, setIsInactiveState] = useState(false);
  const isInactiveStateRef = useRef(false);
  useEffect(() => { isInactiveStateRef.current = isInactiveState; }, [isInactiveState]);

  // Блокировка на короткое время после «Отклонить», чтобы не подключиться по гонке
  const declinedBlockRef = useRef<{ userId: string; until: number } | null>(null);
  
  // Защита от повторных вызовов handleOffer для одного пользователя
  const processingOffersRef = useRef<Set<string>>(new Set());
  
  // Защита от множественных отправок состояния камеры
  const lastCameraStateRef = useRef<number>(0);
  
  const setDeclinedBlock = useCallback((userId?: string | null, ms = 12000) => {
    const uid = (userId || '').trim();
    if (!uid) return;
    declinedBlockRef.current = { userId: uid, until: Date.now() + ms };
  }, []);
  const clearDeclinedBlock = useCallback(() => { declinedBlockRef.current = null; }, []);

  // Local media
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [streamValid, setStreamValid] = useState(false);
  
  // ==================== WebRTC Session ====================
  const sessionRef = useRef<WebRTCSession | null>(null);
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
      const hasActiveCall = !!roomId || !!currentCallIdRef.current || started;
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
    // КРИТИЧНО: Обновляем "предпочтение" пользователя только если камера включена
    // Если камера выключена, предпочтение обновляется только через toggleCam (ручное переключение)
    // Это предотвращает автоматическое обновление предпочтения при выключении камеры системой
    if (camOn && camUserPreferenceRef.current !== camOn) {
      camUserPreferenceRef.current = camOn;
    }
  }, [camOn]);
  
  // ЗАЩИТА: Предотвращаем сброс camOn в false при активном соединении
  // Камера должна быть ВСЕГДА включена при подключении и выключаться ТОЛЬКО по нажатию на кнопку
  useEffect(() => {
    // Если есть активное соединение (partnerId или roomId) И started=true И есть localStream,
    // но camOn=false - это ошибка, нужно установить camOn=true
    const hasActiveConnection = !!partnerId || !!roomId;
    const hasLocalStream = !!localStream;
    const isRandomChat = !isDirectCall && !inDirectCall && !friendCallAccepted;
    
    if (hasActiveConnection && started && hasLocalStream && !camOn && isRandomChat) {
      // Пользователь намеренно выключил камеру — не включаем её автоматически
      if (camUserPreferenceRef.current === false) {
        return;
      }
      const stream = localStream;
      if (!stream || !isValidStream(stream)) {
        return;
      }
      
      setCamOn(true);
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

  // Toast
  const [toastText, setToastText] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastOpacity = useRef(new Animated.Value(0)).current;

  // Анимация появления кнопок в блоках (для предотвращения визуального мелькания на Android)
  const buttonsOpacity = useRef(new Animated.Value(0)).current;

  const [partnerInPiP, setPartnerInPiP] = useState(false); // Отслеживаем когда партнер ушел в PiP
  // Ref для предотвращения двойного обновления remoteViewKey при возврате из PiP
  const pipReturnUpdateRef = useRef(false);
  
          // remoteCamOn и isInactiveState объявлены выше (строка 651-658) ДО использования в useEffect
  
  // Флаг для отслеживания завершенного звонка друга (для показа заблокированной кнопки "Завершить")
  const [wasFriendCallEnded, setWasFriendCallEnded] = useState(false);
  const wasFriendCallEndedRef = useRef(wasFriendCallEnded);
  useEffect(() => { wasFriendCallEndedRef.current = wasFriendCallEnded; }, [wasFriendCallEnded]);
  
  // Флаг для предотвращения дублирования активации background
  const bgActivationInProgress = useRef(false);

  // Refs для AppState listener чтобы избежать пересоздания listener
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  
  const partnerUserIdRef = useRef(partnerUserId);
  partnerUserIdRef.current = partnerUserId;

  // Ref для таймера блокировки экрана на iOS
  const inactiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Только UI логика для navigation bar
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
  }, [applyNavBarForVideo]);

  // Обработчик кнопки "Назад" Android для активации background
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Проверяем: это звонок друга с активным соединением?
      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      const hasActiveCall = !!roomId;
      
      if (isFriendCall && hasActiveCall) {
        try {
          const partnerNick = friendsRef.current.find(f => String(f._id) === String(partnerUserIdRef.current))?.nick;
          
          const streamToUse = remoteStream;
          
          let finalStreamToUse = streamToUse;
          
          try {
            socket.emit('bg:entered', { 
              callId: roomId,
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
        const session = sessionRef.current;
        if (session) {
          const currentRoomId = roomId;
          if (currentRoomId) {
            session.leaveRoom(currentRoomId);
          }
          session.stopRandom();
          session.destroy();
        }
        setPartnerUserId(null);
        
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
  // session сам установит callId при обработке событий
  
  const [incomingOverlay, setIncomingOverlay] = useState<boolean>(false);
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
  // Mic level meter — полностью управляется в session.ts
  // session сам запускает/останавливает метр при подключении/отключении и изменении состояния микрофона
  // --------------------------

  // --------------------------
  // Start / Stop / Next
  // --------------------------

  const onStartStop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      console.warn('[onStartStop] Session not initialized yet');
      return;
    }
    
    // Используем ref для проверки, чтобы избежать проблем с замыканием
    if (startedRef.current) {
      // === STOP ===
      // Защита от повторных нажатий
      if (isStoppingRef.current) {
        return;
      }
      isStoppingRef.current = true;
      
      try { stopSpeaker(); } catch {}
      
      // КРИТИЧНО: Сначала сбрасываем состояние started, чтобы UI сразу обновился
      // Это гарантирует, что кнопка "Стоп" сразу изменится на "Начать"
      startedRef.current = false;
      setStarted(false);
      setLoading(false);
      loadingRef.current = false;
      
      // Используем session для остановки
      session.stopRandomChat();
      
      // Дополнительная очистка UI состояния
      setLocalRenderKey(k => k + 1);
      setPartnerUserId(null);
      
      // Сбрасываем флаг остановки после небольшой задержки
      setTimeout(() => {
        isStoppingRef.current = false;
      }, 500);
      
      return;
    }

    // === START ===
    if (loadingRef.current) {
      return;
    }
    
    const ok = await requestPermissions();
    if (!ok) {
      console.warn('[onStartStop] Permissions denied');
      Alert.alert('Разрешения', 'Нет доступа к камере/микрофону');
      return;
    }

    try {
      // Используем session для начала рандомного чата
      const session = sessionRef.current;
      if (!session) {
        console.error('[onStartStop] Session not initialized');
        Alert.alert('Ошибка', 'Session не инициализирован');
        return;
      }
      
      try {
        const result = await session.startRandomChat();
      } catch (error) {
        console.error('[onStartStop] session.startRandomChat() failed:', error);
        console.error('[onStartStop] Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error; // Пробрасываем дальше для обработки в catch блоке
      }
    } catch (e) {
      console.error('[onStartStop] Error starting random chat:', e);
      startedRef.current = false;
      setStarted(false);
      setLoading(false);
      loadingRef.current = false;
      setCamOn(false);
      Alert.alert('Ошибка', 'Не удалось запустить камеру/микрофон');
    }
  }, [requestPermissions]);

  // УПРОЩЕНО: Завершить звонок (1-на-1 friends mode) - переход в неактивное состояние
  const onAbortCall = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      console.warn('[onAbortCall] Session not initialized yet');
      return;
    }
    
    logger.debug('[onAbortCall] Ending 1-on-1 call');
    
    // Используем session для завершения звонка
    session.endCall();
    
    // Дополнительная очистка UI состояния
    setLocalRenderKey(k => k + 1);
    setPartnerUserId(null);
  }, []);

  // Callback для возврата из background
  const onReturnToCall = useCallback(() => {
    
    const nav = (global as any).__navRef;
    const currentRoute = nav?.getCurrentRoute?.();
    
    
    // Если уже на VideoChat - просто скрываем background
    if (currentRoute?.name === 'VideoChat') {
      return;
    }
    
    // Если на другом экране - НЕ навигируем, а просто скрываем background
    // Это позволит пользователю самому вернуться к звонку через навигацию
    
    // Альтернативно: можно попробовать навигировать с сохранением состояния
    // Но это сложнее и может привести к проблемам с PeerConnection
  }, []);

  useEffect(() => {
    if (resume && fromPiP) {
      const currentPip = pipRef.current;
      const session = sessionRef.current;
      
      if (session) {
        session.exitPiP();
        setRemoteViewKey(session.getRemoteViewKey());
      }
      
      // Скрываем PiP
      currentPip.hidePiP();
      return;
    }
    
    // Восстановление звонка через session.restoreCallState()
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    
    const returnToActiveCall = route?.params?.returnToActiveCall;
    const routeCallId = route?.params?.callId;
    const routeRoomId = route?.params?.roomId;
    const routePartnerUserId = route?.params?.peerUserId || (route?.params as any)?.partnerUserId;
    
    // Вызываем session.restoreCallState() для восстановления
    session.restoreCallState({
      roomId: routeRoomId || roomId,
      partnerId: partnerId,
      callId: routeCallId || currentCallIdRef.current,
      partnerUserId: routePartnerUserId || partnerUserId,
      returnToActiveCall: returnToActiveCall,
      isFromBackground: false
    });
  }, [started, resume, fromPiP, isInactiveState, incomingFriendCall, friendCallAccepted, wasFriendCallEnded, route, roomId, partnerId, partnerUserId, currentCallIdRef.current]);

  const onNext = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      console.warn('[onNext] Session not initialized yet');
      return;
    }
    
    // ЗАЩИТА ОТ СПАМА: Блокируем кнопку на 1.5 секунды
    if (isNexting) return;
    
    setIsNexting(true);
    
    // Используем session для перехода к следующему (ручной вызов)
    session.nextRandom();
    
    if (!started) {
      setStarted(true);
    }
    
    setLoading(true);
    
    // Сбрасываем isNexting через небольшую задержку, чтобы защита от спама работала
    setTimeout(() => {
      setIsNexting(false);
    }, 500);
  }, [isNexting, started]);

  // --------------------------
  // Local toggles
  // --------------------------
  const toggleMic = useCallback(async () => {
    
    const session = sessionRef.current;
    if (!session) {
      console.warn('[VideoChat] toggleMic: No session');
      return;
    }
    
    // Получаем текущее состояние микрофона перед переключением
    const currentMicState = micOn;
    
    // Переключаем микрофон через session
    session.toggleMic();
    // micOn обновляется через callback onMicStateChange

    // Обновляем состояние PiP
    if (pip.visible) {
      pip.updatePiPState({ isMuted: currentMicState });
    }

    // Управление микрофонным метром теперь полностью в session.ts
    // session сам запускает/останавливает метр при изменении состояния микрофона и подключения
    // Не нужно вручную вызывать startMicMeter/stopMicMeter - session управляет автоматически
  }, [micOn, localStream, remoteStream, pip, isInactiveState]);

  // Функция для отправки текущего состояния камеры
  const sendCameraState = useCallback((toPartnerId?: string, enabled?: boolean) => {
    // Используем метод из session.ts для отправки состояния камеры
    const session = sessionRef.current;
    if (session) {
      // Защита от слишком частых отправок (не чаще 1 раза в 500мс)
      const now = Date.now();
      if (now - lastCameraStateRef.current < 500) {
        return;
      }
      lastCameraStateRef.current = now;
      
      // Используем переданное состояние камеры или состояние из state
      const isEnabled = enabled !== undefined ? enabled : camOn;
      
      // Вызываем метод из session.ts
      session.sendCameraState(toPartnerId, isEnabled);
      return;
    }
    
    // Fallback: старая логика, если session еще не инициализирован
    const targetPartnerId = toPartnerId || partnerId;
    if (!targetPartnerId) return;
    
    // Защита от слишком частых отправок (не чаще 1 раза в 500мс)
    const now = Date.now();
    if (now - lastCameraStateRef.current < 500) {
      return;
    }
    lastCameraStateRef.current = now;
    
    // Используем переданное состояние камеры или состояние из state
    const isEnabled = enabled !== undefined ? enabled : camOn;
    
    // КРИТИЧНО: Для рандомного чата добавляем to: targetPartnerId, чтобы бэкенд знал кому пересылать
    const isDirectFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
    const payload: any = { 
      enabled: isEnabled, 
      from: socket.id 
    };
    if (!isDirectFriendCall && targetPartnerId) {
      payload.to = targetPartnerId;
    }
    
    socket.emit("cam-toggle", payload);
  }, [partnerId, camOn]);

  const toggleCam = useCallback(() => {
    if (!localStream) {
      console.warn('[VideoChat] toggleCam: No local stream - trying to get from session');
      // Пытаемся получить стрим из session
      const session = sessionRef.current;
      if (session) {
        // Используем метод session для переключения камеры
        session.toggleCam();
        return;
      }
      console.warn('[VideoChat] toggleCam: No local stream and no session');
      return;
    }

    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) {
      console.warn('[VideoChat] toggleCam: No video track');
      return;
    }

    videoTrack.enabled = !videoTrack.enabled;

    setCamOn(videoTrack.enabled);

    // КРИТИЧНО: Обновляем предпочтение пользователя
    camUserPreferenceRef.current = videoTrack.enabled;

    // Отправляем состояние камеры с актуальным значением enabled
    sendCameraState(undefined, videoTrack.enabled);

    if (!videoTrack.enabled) {
      setLocalRenderKey(prev => prev + 1);
    }
  }, [localStream, sendCameraState, camOn]);

  // Глобальная защита: если пользователь предпочёл камеру off — не даём её включать автоматически
  // КРИТИЧНО: Эта защита работает только для автоматического включения камеры, не для ручного переключения
  useEffect(() => {
    // КРИТИЧНО: Проверяем, что это не ручное переключение
    // Если пользователь только что нажал кнопку, camUserPreferenceRef уже обновлен в toggleCam
    // и мы не должны блокировать изменение
    // Защита срабатывает только если camUserPreferenceRef === false И camOn === true
    // Это означает, что камера была включена автоматически, а не пользователем
    if (camUserPreferenceRef.current === false && camOn) {
      // Переключаем камеру через session
      const session = sessionRef.current;
      if (session) {
        session.toggleCam();
      }
      setCamOn(false);
    }
  }, [camOn, sessionRef]);
  const toggleRemoteAudio = useCallback(() => {
    
    // Используем session для переключения remote audio
    const session = sessionRef.current;
    if (!session) {
      console.warn('[VideoChat] toggleRemoteAudio: No session');
      return;
    }
    
    session.toggleRemoteAudio();
    
    // Обновляем состояние PiP
    if (pip.visible) {
      const isMuted = session.getRemoteMuted();
      pip.updatePiPState({ isRemoteMuted: isMuted });
    }
  }, [pip, sessionRef]);

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
    // Управление микрофонным метром теперь полностью в session.ts
    try {
      if ((global as any).__toggleMicRef) {
        (global as any).__toggleMicRef.current = toggleMic;
      }
    } catch (e) {
      console.warn('[VideoChatContent] Error registering toggleMic:', e);
    }
    

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
    const hasActiveCall = !!roomId;
    
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
      
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      if (isInactiveState) {
        return;
      }
      
      // Сохраняем partnerUserId в navParams для восстановления при возврате
      pip.showPiP({
        callId: currentCallIdRef.current || '',
        roomId: roomId || '',
        partnerName: partnerNick,
        partnerAvatarUrl: partnerAvatarUrl,
        muteLocal: !micOn,
        muteRemote: remoteMutedMain,
        localStream: localStream || null,
        remoteStream: remoteStream || null,
        navParams: {
          ...route?.params,
          peerUserId: partnerUserId || partnerUserIdRef.current,
          partnerId: partnerId || partnerId, // Сохраняем partnerId для восстановления соединения
        } as any,
      });
      
      const session = sessionRef.current;
      if (session) {
        session.enterPiP();
      }
    }
  }, [isDirectCall, inDirectCall, friendCallAccepted, remoteStream, localStream, friends, partnerUserId, micOn, remoteMutedMain, pip, route, isInactiveState]);

  // Обработчик кнопки "Назад" на Android
  useEffect(() => {
    const backAction = () => {
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted;
      const hasActiveCall = !!roomId;
      
      
      // НЕ показываем PiP если находимся в неактивном состоянии (звонок завершен)
      // В этом случае просто возвращаемся назад на Home
      if (isInactiveState) {
        navigation.goBack();
        return true;
      }
      
      if (isFriendCall && hasActiveCall) {
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
    // cam-toggle теперь обрабатывается внутри session
  
    return () => {
      offIncoming?.();
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
    // 2. При получении нового матча (handleMatchFound, handleOffer) - чтобы проверить бейдж "друг"
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
  
  const restartCooldownRef = useRef<number>(0);
  const iceRestartInProgressRef = useRef<boolean>(false);

  const handleMatchFound = useCallback(async ({ id, userId, roomId }: { id: string; userId?: string | null; roomId?: string }) => {
    
    const matchKey = `match_${id}`;
    if (processingOffersRef.current.has(matchKey)) {
      return;
    }
    processingOffersRef.current.add(matchKey);
    
    // КРИТИЧНО: Для прямых звонков используем inDirectCall и friendCallAccepted вместо isDirectCall
    // потому что isDirectCall может быть не установлен правильно из route params
    const isDirectFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
    
    // КРИТИЧНО: Логируем определение isDirectFriendCall для отладки
    
    // КРИТИЧНО: Для прямых звонков НЕ пропускаем если partnerId уже установлен
    // потому что partnerId может быть установлен из call:accepted, но PC еще не создан
    // Для рандомных чатов: НЕ пропускаем если partnerId уже установлен, потому что
    // session.handleMatchFound() устанавливает partnerId ДО этой проверки, и это нормально
    // Проверяем только если partnerId установлен И это другой партнер (не текущий матч)
    if (!isDirectFriendCall) {
      // КРИТИЧНО: Проверяем только если partnerId установлен И это ДРУГОЙ партнер
      // Если partnerId совпадает с id из match_found, это означает что это тот же матч
      // и мы должны продолжить создание PC (возможно, PC не был создан ранее)
      // КРИТИЧНО: session.handleMatchFound() устанавливает partnerId ДО этой проверки
      // Поэтому partnerId может быть уже установлен, но это нормально - это тот же матч
      // Проверяем только если partnerId установлен И это ДРУГОЙ партнер
      if (partnerId && partnerId !== id) {
        return;
      }
      
      // КРИТИЧНО: Логируем что продолжаем выполнение
      // Если partnerId === id, это означает что это тот же матч - продолжаем создание PC
    } else {
      // Для прямых звонков: если partnerId уже установлен и совпадает, но PC еще не создан,
      // продолжаем создание PC
      
      // КРИТИЧНО: Устанавливаем partnerUserId для ВСЕХ участников прямого звонка из match_found
      // Это гарантирует, что partnerUserId установлен даже если он не был передан в call:accepted
      // КРИТИЧНО: Обновляем partnerUserId даже если он уже установлен, чтобы гарантировать правильное значение
      
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
        } else {
          // partnerUserId уже установлен из call:accepted - не обновляем
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

    // Принудительно очищаем remoteStream и все связанные состояния перед новым звонком
    // для повторных звонков, чтобы гарантировать правильное отображение видеопотока
    try {
      const oldRemoteStream = remoteStream;
      if (oldRemoteStream) {
        // remoteStream очищается через события session
      }
    } catch {}
    setRemoteViewKey(0);
    // КРИТИЧНО: Обнуляем remoteCamOn в false при новом match_found
    // Это гарантирует, что UI сразу покажет заглушку "Отошел", пока не придет реальный видео-трек
    setRemoteCamOn(false);
    
    // КРИТИЧНО: Для рандомного чата убираем задержку 800ms - она замедляет установление соединения
    // isDirectFriendCall уже определен выше в функции
    const isDirectFriendCallForDelay = isDirectCall || inDirectCallRef.current || friendCallAccepted;
    if (!isDirectFriendCallForDelay) {
      // Рандомный чат - без задержки для быстрого соединения
    } else {
      // Прямой звонок - небольшая задержка для стабилизации
      await new Promise(resolve => setTimeout(resolve, 200)); // Уменьшено с 800ms до 200ms
    }
    setLoading(true);
    setAddBlocked(false);
    setAddPending(false);
    clearDeclinedBlock();
    
    try {
      // Управление флагом ручного запроса теперь внутри session.handleMatchFound()
      const session = sessionRef.current;
      
      // Если недавно отклоняли этого пользователя — игнорируем match
      if (userId && declinedBlockRef.current && declinedBlockRef.current.userId === String(userId) && Date.now() < declinedBlockRef.current.until) {
        return;
      }
      
      // PC уже очищен выше принудительно
      
      let stream = localStream;
      // КРИТИЧНО: Обновляем startedRef синхронно перед setStarted для немедленного использования
      startedRef.current = true;
      setStarted(true);
      
      if (stream && !isValidStream(stream)) {
        // КРИТИЧНО: НЕ вызываем stopLocalStream при смене собеседника/auto-next
        // Просто сбрасываем stream, startLocalStream сам пересоздаст стрим если нужно
        stream = null;
        setStreamValid(false);
      }
      
      if (!stream) {
        // КРИТИЧНО: Используем startedRef.current для синхронной проверки
        if (!startedRef.current) {
          console.warn('[handleMatchFound] Exiting early - startedRef.current=false (no stream)', {
            partnerId: id
          });
          return;
        }
        if (!session) {
          console.error('[handleMatchFound] Session not initialized');
          return;
        }
        stream = await session.startLocalStream('front');
        // session.startLocalStream() автоматически управляет треками и состоянием камеры
        if (stream) {
          const wantCam = camUserPreferenceRef.current === true;
          setCamOn(wantCam);
          setStreamValid(true);
        }
      } else {
        // session.startLocalStream() автоматически управляет треками и состоянием камеры
        const wantCam = camUserPreferenceRef.current === true;
        setCamOn(wantCam);
        setStreamValid(true);
      }
      
      // КРИТИЧНО: Логируем перед проверкой started
      
      // КРИТИЧНО: Используем startedRef.current для синхронной проверки вместо started из замыкания
      if (!startedRef.current) {
        console.warn('[handleMatchFound] Exiting early - startedRef.current=false', {
          partnerId: id,
          hasStream: !!stream,
          started
        });
        return;
      }
      
      if (!session) {
        console.error('[handleMatchFound] Session not initialized');
        return;
      }
      
      // КРИТИЧНО: Логируем перед вторым вызовом startLocalStream
      
      stream = await session.startLocalStream('front');
      // session.startLocalStream() автоматически управляет треками и состоянием камеры
      if (stream) {
        const wantCam = camUserPreferenceRef.current === true;
        setCamOn(wantCam);
        setStreamValid(true);
      }
      
      // КРИТИЧНО: Логируем после получения stream
      
      if (!socket.connected) await new Promise<void>(res => socket.once('connect', () => res()));
      
      // КРИТИЧНО: Проверяем что socket.id установлен перед определением caller/receiver
      if (!socket.id) {
        console.error('[handleMatchFound] socket.id is not set, cannot determine caller/receiver', {
          socketConnected: socket.connected,
          socketId: socket.id,
          partnerId: id
        });
        // Ждем установки socket.id
        await new Promise<void>(res => {
          if (socket.id) {
            res();
          } else {
            socket.once('connect', () => res());
          }
        });
      }
      
      const myId = String(socket.id);
      const partnerIdNow = String(id);
      
      // КРИТИЧНО: Логируем socket.id для диагностики
      // КРИТИЧНО: Для прямых звонков используем isDirectFriendCall вместо isDirectCall
      // потому что isDirectCall может быть не установлен правильно из route params
      const isDirectFriendCallForCaller = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      
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
                                          friendCallAccepted && 
                                          inDirectCallRef.current;
      
      // Используем route params как fallback, но приоритет отдаем флагам
      const effectiveIsDirectInitiator = isDirectFriendCallForCaller ? 
        (isDirectInitiatorForCaller || isDirectInitiator) : false;
      
      const iAmCaller = isDirectFriendCallForCaller ? effectiveIsDirectInitiator : (myId < partnerIdNow);
      
      // КРИТИЧНО: Логируем определение iAmCaller для отладки
      
      // КРИТИЧНО: Добавляем дополнительное логирование для рандомного чата
      if (!isDirectFriendCallForCaller) {
      }
      
      setPartnerUserId(userId ? String(userId) : null);
      
      // Обновляем информацию о собеседнике в PiP
      if (userId) {
        const partnerProfile = friends.find(f => String(f._id) === String(userId));
        updatePiPState({
          partnerName: partnerProfile?.nick || 'Собеседник',
          // partnerAvatarUrl: partnerProfile?.avatarUrl, // если есть аватар
        });
      }
      
      // Обновим список друзей для бейджа
      try { const r = await fetchFriends(); setFriends(r?.list || []); } catch {}
      
      // КРИТИЧНО: Логируем перед проверкой stream и socket.id
      
      // Отправляем текущее состояние камеры новому собеседнику
      // КРИТИЧНО: Для рандомного чата отправляем состояние камеры только если camOn=true
      // Это предотвращает отправку enabled=false при установке соединения
      const isDirectFriendCallForCam = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      if (!isDirectFriendCallForCam) {
        // Для рандомного чата отправляем только если камера включена
      setTimeout(() => {
          if (camOn) {
        sendCameraState(partnerIdNow);
          } else {
          }
      }, 500);
      } else {
        // Для прямых звонков отправляем всегда
        setTimeout(() => {
          sendCameraState(partnerIdNow);
        }, 500);
      }

      // Комнаты нужны только для звонков друзей (direct calls)
      if (isDirectCall && roomId) {
        socket.emit('room:join:ack', { roomId });
      } else if (!isDirectCall) {
      }
  
      // КРИТИЧНО: Логируем перед проверкой iAmCaller
  
      if (iAmCaller) {
          // Caller - создаем PC и отправляем offer
          
          // КРИТИЧНО: Для инициатора partnerId устанавливается из match_found (socket.id партнера)
          // Поэтому PC должен создаваться здесь в handleMatchFound, а не из call:accepted
          // Для receiver PC создается из call:accepted с задержкой, поэтому там есть проверка
          // НО: для инициатора НЕ пропускаем создание PC, даже если friendCallAccepted установлен,
          // потому что для инициатора PC создается в handleMatchFound, а не в call:accepted
          
          // ВАЖНО: Используем стрим из state или ref, чтобы убедиться что мы используем актуальный стрим
          // Это предотвращает использование устаревшего стрима, который мог быть очищен
          const currentStream = localStream || stream;
          if (currentStream !== stream) {
            stream = currentStream;
          }
          
          // Проверяем текущее состояние стрима перед проверкой валидности
          
          // Проверяем что stream валиден перед созданием PC
          const streamIsValid = stream ? isValidStream(stream) : false;
          
          if (!stream || !streamIsValid) {
            console.error('[handleMatchFound] Caller: Cannot create PC - stream is invalid', {
              streamExists: !!stream,
              streamValid: streamIsValid,
              streamId: stream?.id,

            });
            
            // Пытаемся пересоздать стрим для caller
            // ВАЖНО: Пересоздаем только если пользователь нажал "Начать"
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            

            const session = sessionRef.current;
            if (!session) {
              console.error('[handleMatchFound] Session not initialized');
              return;
            }
            // КРИТИЧНО: НЕ вызываем stopLocalStream при смене собеседника/auto-next
            // startLocalStream сам пересоздаст стрим если нужно
            stream = await session.startLocalStream('front');
            if (stream && isValidStream(stream)) {

              setStreamValid(true);
            } else {
              console.error('[handleMatchFound] Caller: Failed to recreate valid stream');
              return;
            }
          }
          

          // session сам установит partnerId при обработке match_found
          
          // Финальная проверка стрима перед созданием PC
          
          // Проверка валидности стрима теперь в session
          // session.startLocalStream() сам проверяет валидность и пересоздает стрим если нужно
          
          // Проверка валидности стрима теперь в session
          // session.startLocalStream() сам проверяет валидность и пересоздает стрим если нужно
          
          

          const session = sessionRef.current;
          if (!session) {
            console.error('[handleMatchFound] ❌ Caller: Session not initialized');
            return;
          }
          
          // КРИТИЧНО: Для рандомного чата создаем PC немедленно, без задержек
          // Создаем PC через session - все обработчики устанавливаются автоматически
          // bindConnHandlers и attachRemoteHandlers вызываются внутри session.ensurePcWithLocal()
          await session.ensurePcWithLocal(stream);
          
          // Создание и отправка offer теперь через session.createAndSendOffer()
          // session.createAndSendOffer() сам проверяет наличие PC и его состояние
          // Все проверки состояния PC и обработка ошибок выполняются внутри session
          // КРИТИЧНО: Для рандомного чата создаем offer немедленно, без задержки
          // Это гарантирует быстрое установление соединения
          const createOffer = async () => {
            try {
              // Проверяем что partnerId еще актуален
              const currentPartnerId = partnerId;
              if (currentPartnerId && currentPartnerId !== partnerIdNow) {
                console.warn('[handleMatchFound] Partner changed during offer creation, aborting', {
                  expected: partnerIdNow,
                  current: currentPartnerId
                });
                return;
              }
              
              // Проверка: если звонок завершен, не создаем offer
              if (isInactiveStateRef.current) {
                return;
              }
              
              // Используем session.createAndSendOffer() вместо прямых вызовов WebRTC API
              const session = sessionRef.current;
              if (!session) {
                console.error('[handleMatchFound] Session not initialized');
                return;
              }
              
              const currentRoomId = roomId;
              await session.createAndSendOffer(partnerIdNow, currentRoomId);
            } catch (e) {
              console.error('[handleMatchFound] Error creating/sending offer:', e);
            }
          };
          
          // Для рандомного чата создаем offer немедленно, для прямых звонков - с небольшой задержкой
          if (!isDirectFriendCall) {
            // Рандомный чат - создаем offer немедленно
            createOffer();
          } else {
            // Прямой звонок - небольшая задержка для стабилизации PC
            setTimeout(createOffer, 100);
          }
        } else {
          // Receiver - создаем PC и ждем offer
          
          // КРИТИЧНО: Для receiver в прямых звонках проверяем, не создается ли уже PC из call:accepted
          // Если friendCallAccepted и inDirectCall установлены, но PC еще не создан,
          // значит PC создается из call:accepted с задержкой - не создаем его здесь
          // Проверяем что это receiver по отсутствию isDirectCall (инициатор имеет isDirectCall=true)

          const isReceiverInDirectCall = isDirectFriendCall && !isDirectCall && friendCallAccepted && inDirectCallRef.current;
          if (isReceiverInDirectCall) {

            // session сам обновит partnerId при обработке match_found
            if (partnerId !== partnerIdNow) {
            }
            return;
          }
          
          // КРИТИЧНО: Для рандомного чата receiver должен создать PC немедленно после match_found
          // Это гарантирует, что PC готов к приему offer, когда он придет
          // Для прямых звонков PC может создаваться из call:accepted, поэтому проверяем isDirectFriendCall
          if (!isDirectFriendCall) {
          }
          
          // Проверяем, не существует ли уже PC для этого партнера
          // Это может произойти если handleOffer уже создал PC и обрабатывает offer
          // Проверяем не только stable, но и другие состояния (have-local-offer, have-remote-offer)
          // потому что handleOffer может создать PC и установить remote description ДО того как мы проверим

          // Session сам проверяет наличие PC перед созданием нового

          // Они вызываются автоматически при создании PC через session.ensurePcWithLocal()
          

          // session сам установит partnerId при обработке match_found
          
          // Убеждаемся что локальный стрим готов перед созданием PC
          // Особенно важно при принятии звонка в неактивном состоянии, когда localStream может быть null
          // ВАЖНО: Используем стрим из state или ref, чтобы убедиться что мы используем актуальный стрим
          let finalStream = localStream || stream;
          if (finalStream !== stream) {
          }
          if (!finalStream) {
            // ВАЖНО: Создаем локальный стрим только если пользователь нажал "Начать" (started === true)
            if (!started) {
              return;
            }
            
            const session = sessionRef.current;
            if (!session) {
              console.error('[handleMatchFound] Session not initialized');
              return;
            }
            finalStream = await session.startLocalStream('front');
            // Если startLocalStream вернул null (например, из-за проверки PiP),
            // принудительно создаем стрим напрямую через getUserMedia
            if (!finalStream) {
              const audioConstraints: any = {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                googEchoCancellation: true,
                googNoiseSuppression: true,
                googAutoGainControl: true,
              };

              if (session) {
                finalStream = await session.startLocalStream('front');
                if (finalStream) {
                  // КРИТИЧНО: Используем предпочтение пользователя вместо принудительного включения
                  const wantCam = camUserPreferenceRef.current === true;
                  setCamOn(wantCam);
                  setMicOn(true);
                }
              }
            }
            
            if (finalStream) {
              // Убеждаемся что стрим действительно валиден
              if (!isValidStream(finalStream)) {
                console.error('[handleMatchFound] Receiver: Created stream is invalid');
                // КРИТИЧНО: НЕ вызываем stopLocalStream при смене собеседника/auto-next
                // Просто возвращаемся, стрим уже невалидный
                return;
              }
              

              setStreamValid(true);
              // КРИТИЧНО: Используем предпочтение пользователя вместо принудительного включения
              const wantCam = camUserPreferenceRef.current === true;
              setCamOn(wantCam);
            } else {
              console.error('[handleMatchFound] Receiver: Failed to create local stream after all attempts');
              return;
            }
          }
          
          // Проверяем что finalStream действительно существует и валиден перед созданием PC
          if (!finalStream) {
            console.error('[handleMatchFound] Receiver: No valid stream available for PC creation');
            return;
          }
          
          // КРИТИЧНО: Используем предпочтение пользователя вместо принудительного включения
          // Не устанавливаем camOn принудительно - это сбрасывает предпочтение пользователя
          // camOn уже установлен выше на основе camUserPreferenceRef
          
          // Проверяем валидность стрима перед использованием
          if (!isValidStream(finalStream)) {
            console.warn('[handleMatchFound] Receiver: Stream is invalid, attempting to recreate', {
              finalStreamExists: !!finalStream,
              finalStreamId: finalStream?.id,
              hasToURL: finalStream ? typeof (finalStream as any).toURL === 'function' : false,
            });
            
            // Пытаемся пересоздать стрим
            // ВАЖНО: Пересоздаем только если пользователь нажал "Начать"
            if (!started) {
              // Пользователь остановил поиск, просто выходим без ошибки
              return;
            }
            
            // КРИТИЧНО: НЕ вызываем stopLocalStream при смене собеседника/auto-next
            // startLocalStream сам пересоздаст стрим если нужно
            try {
              const session = sessionRef.current;
              if (!session) {
                console.error('[handleMatchFound] Session not initialized');
                return;
              }
              finalStream = await session.startLocalStream('front');
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

                const session = sessionRef.current;
                if (session) {
                  finalStream = await session.startLocalStream('front');
                  if (finalStream) {
                    setStreamValid(true);
                    // КРИТИЧНО: Используем предпочтение пользователя вместо принудительного включения
                    const wantCam = camUserPreferenceRef.current === true;
                    setCamOn(wantCam);
                  }
                }
              } else {

                setStreamValid(true);
              }
              
              if (!finalStream || !isValidStream(finalStream)) {
                console.error('[handleMatchFound] Receiver: Failed to recreate valid stream');
                return;
              }
              
            } catch (recreateError) {
              console.error('[handleMatchFound] Receiver: Error recreating stream:', recreateError);
              return;
            }
          }
          
          // Проверка валидности стрима теперь в session
          // session.startLocalStream() сам проверяет валидность и пересоздает стрим если нужно
          
          // Добавляем детальную диагностику перед созданием PC
          

          // Session сам управляет созданием и очисткой PC
          
          // Убедимся, что PC создан и готов к приему offer
          const session = sessionRef.current;
          if (!session) {
            console.error('[handleMatchFound] Session not initialized');
            return;
          }
          
          // bindConnHandlers и attachRemoteHandlers вызываются внутри session.ensurePcWithLocal()
          await session.ensurePcWithLocal(finalStream);
        }
    } catch (e) {
      // Match found error - не критично
      console.error('[handleMatchFound] Error:', e);
    } finally {
      processingOffersRef.current.delete(matchKey);
    }
  }, [localStream, isDirectCall, inDirectCall, friendCallAccepted, clearDeclinedBlock, fetchFriends, setFriends, sendCameraState]);
  

  // Оригинальная функция была ~900 строк, вся логика перенесена в session.ts

  // Вся обработка offer теперь происходит внутри WebRTCSession
  
  
  // Логика восстановления стримов и управления remoteCamOn теперь внутри session
  

  

  // UI-логика обрабатывается в обработчике события 'stopped' от session
  // UI-логика обрабатывается в обработчике события 'nexted' от session
  // hangup и disconnected обрабатываются одинаково в session.handleRandomDisconnected

  const showFriendBadge = useMemo(() => {
    // УПРОЩЕНО: бейдж «Друг» для единственного собеседника
    // Не показываем бэйдж в неактивном состоянии (после завершения звонка)
    // КРИТИЧНО: Показываем бейдж только если установлено активное соединение (есть remoteStream)
    // Пользователь считается в активном поиске до тех пор, пока соединение не установлено
    const hasPartnerUserId = !!partnerUserId;
    const hasStarted = !!started;
    const isInactive = !!isInactiveState;
    const hasActiveConnection = !!remoteStream; // КРИТИЧНО: проверяем наличие активного соединения
    
    if (!hasPartnerUserId || !hasStarted || isInactive || !hasActiveConnection) {
      return false;
    }
    
    const isFriend = friends.some(f => String(f._id) === String(partnerUserId));
    const result = isFriend;
    
    
    return result;
  }, [partnerUserId, friends, started, isInactiveState, remoteStream]);

  // Логируем изменения partnerUserId, isPartnerFriend и showFriendBadge для отладки
  useEffect(() => {
  }, [partnerUserId, isPartnerFriend, showFriendBadge, started, isInactiveState, friends, inDirectCall, friendCallAccepted, isDirectCall]);
  
  // Логируем изменения started для отладки
  useEffect(() => {
  }, [started, partnerUserId, inDirectCall, friendCallAccepted, isDirectCall]);

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
  
  // Логируем изменения friends для отладки
  useEffect(() => {
  }, [friends, partnerUserId, isPartnerFriend, showFriendBadge]);

  // Мемоизированное вычисление shouldShowLocalVideo для оптимизации перерендеров
  const shouldShowLocalVideo = useMemo(() => {
    const isReturnFrombackground = route?.params?.returnToActiveCall;
    // КРИТИЧНО: Показываем видео если есть стрим И камера включена
    // Для рандомного чата проверяем isInactiveState только если started=true
    const result = (
      (inDirectCall && localStream && camOn) || // Показываем видео при звонке друзей если камера включена
      (!inDirectCall && localStream && started && camOn && !isInactiveState) || // Для рандомного чата показываем если started=true И camOn=true И НЕ в неактивном состоянии
      (isReturnFrombackground && localStream && camOn) // При возврате из background показываем только если камера включена
    );
    // Гарантируем, что всегда возвращается boolean
    const finalResult = Boolean(result);
    return finalResult;
  }, [isInactiveState, inDirectCall, localStream, camOn, started, route?.params?.returnToActiveCall]);

  // УПРОЩЕНО: Кнопка «Завершить» для режима friends с активным соединением
  const showAbort = useMemo(() => {
    const isFriendsMode = isDirectCall || inDirectCall || friendCallAccepted;
    // Для дружеских звонков показываем "Завершить" сразу после принятия звонка
    // Не ждем remoteStream - он может появиться позже
    // hasActiveCall должен быть false если мы в неактивном состоянии
    const hasActiveCall = !isInactiveState && (!!roomId || !!currentCallIdRef.current || started);
    
    // Дополнительная проверка для возврата из background
    const isReturnFrombackground = route?.params?.returnToActiveCall;
    const hasbackgroundContext = false;
    
    const result = isFriendsMode && hasActiveCall;
    const resultWithbackground = result || (isReturnFrombackground && hasbackgroundContext);
    
    // ВАЖНО: Показываем кнопку "Завершить" как заблокированную после завершения звонка (неактивное состояние)
    // Если звонок завершен (isInactiveState === true) И это был звонок друга, показываем заблокированную кнопку
    const showDisabledAbort = isInactiveState && (wasFriendCallEnded || isDirectCall || inDirectCall || friendCallAccepted);
    
    
    // Показываем кнопку либо при активном звонке, либо как заблокированную после завершения
    return resultWithbackground || showDisabledAbort;
  }, [isDirectCall, inDirectCall, friendCallAccepted, started, partnerUserId, route?.params?.returnToActiveCall, isInactiveState, wasFriendCallEnded, roomId, currentCallIdRef]);

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
              const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
              const hasActiveCall = !!roomId; // Достаточно roomId - поток может быть временно null
              
              
              if (isFriendCall && hasActiveCall) {
                // Звонок друга - активируем background перед навигацией
                
                try {
                  const partnerNick = friendsRef.current.find(f => String(f._id) === String(partnerUserIdRef.current))?.nick;
                  
                  // Используем state remoteStream если ref пустой
                  const streamToUse = remoteStream;
                  

                  // session автоматически восстанавливает remote stream
                  let finalStreamToUse = streamToUse;
                  
                  // Передаем живые streams + контекст в background
                  const finalRemote = remoteStream;
                  const finalLocal = localStream;
                  
                  // background removed
                  
                  // Уведомляем партнера что мы покинули экран
                  try {
                    socket.emit('bg:entered', { 
                      callId: roomId,
                      partnerId: partnerUserIdRef.current 
                    });
                  } catch (e) {
                    console.warn('[handleSwipeBack] Error notifying partner about background:', e);
                  }
                } catch (e) {
                  console.warn('[handleSwipeBack] Error showing background:', e);
                }
              } else if (!isFriendCall && hasActiveCall) {
                // Рандомный чат - отправляем сигналы завершения
                

                const session = sessionRef.current;
                if (session) {
                  try {
                    // Отправляем сигнал партнеру что мы покинули чат
                    const currentRoomId = roomId;
                    if (currentRoomId) {
                      session.leaveRoom(currentRoomId);
                    }
                    
                    // Отправляем stop сигнал
                    session.stopRandom();
                  } catch (e) {
                    console.warn('[handleSwipeBack] Error in session cleanup:', e);
                  }
                  
                  // Очищаем соединение

                  session.destroy();
                  // Останавливаем треки remote stream перед очисткой
                  // remoteStream управляется через события session
                  if (remoteStream) {
                    session.stopRemoteStream();
                  }
                  

                  setPartnerUserId(null);
                  // КРИТИЧНО: НЕ останавливаем локальный стрим при skip/next
                  // stopLocalStream разрешен только при нажатии "Стоп", уходе со страницы или ошибках WebRTC

                  setCamOn(false);
                  setMicOn(false);
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
  useEffect(() => {
    // match_found теперь обрабатывается через session.on('matchFound')
    // disconnected и hangup теперь обрабатываются через session.on('disconnected')
    // peer:stopped и peer:left теперь обрабатываются в session.ts
    
    // Обработчик состояния PiP партнера теперь в session
    // Подписка на partnerPiPStateChanged уже добавлена выше при создании session
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
        return;
      }
      
      // Очищаем WebRTC состояние
      const session = sessionRef.current;
      if (session) {
        session.cleanupAfterFriendCallFailure('timeout');
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
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
        return;
      }
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      stopIncomingAnim();
      setInDirectCall(false);
      
      // НЕ показываем тост - у занятых друзей уже есть бэйдж "Занято" и задизейблена кнопка
      // В рандомном поиске это нормальный процесс поиска свободного собеседника
      
      // Очищаем WebRTC состояние при call:busy
      const session = sessionRef.current;
      if (session) {
        session.cleanupAfterFriendCallFailure('busy');
      }
      
      setPartnerUserId(null);
      
      // Если шёл поиск — останавливаем
      try { if (started) onStartStop(); } catch {}
    });
    
    socket.on('call:declined', (d: any) => {
      // ВАЖНО: Это событие ТОЛЬКО для звонков друзей, НЕ для рандомного чата
      const isFriendCall = isDirectCall || inDirectCall || friendCallAccepted || !!currentCallIdRef.current;
      if (!isFriendCall) {
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
      // match_found теперь обрабатывается через session.on('matchFound')
      

      
      // disconnected и hangup теперь обрабатываются через session.on('disconnected')
      // peer:stopped и peer:left теперь обрабатываются в session.ts
      socket.off('pip:state');
      socket.off('call:timeout');
      socket.off('call:busy');
      socket.off('call:declined');
      offCancel?.();
    };
  }, [handleMatchFound, incomingFriendCall?.from, showToast, L, isDirectCall, sendCameraState, localStream, remoteStream, inDirectCall, friendCallAccepted]);
  
  // Входящий звонок от друга (совместимость: транслируем и из call:incoming)
  useEffect(() => {
    
    const handleIncomingFriend = ({ from, nick, callId }: { from: string; nick?: string; callId?: string }) => {
      logger.debug('[handleIncomingFriend] Received friend call', { from, nick, callId, isInactiveState });
      
      // Устанавливаем incomingCall всегда, даже если callId нет
      // Это нужно для работы кнопок "Принять" и "Отклонить"
      setIncomingCall({ 
        callId: callId || currentCallIdRef.current || '', 
        from, 
        fromNick: nick 
      });
      

      // session сам установит callId при обработке call:incoming
      
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
      }
      
      // Показываем входящий звонок в любом состоянии
      logger.debug('[handleIncomingFriend] Showing incoming call overlay');
      setIncomingFriendCall({ from, nick });
      setFriendCallAccepted(false);
      setIncomingOverlay(true);
      startIncomingAnim();
    };

    const friendCallHandler = (d:any) => {
      logger.debug('[friend:call:incoming] Received friend call', d);
      try { 

        if (d?.callId && roomId !== d.callId) {
          socket.emit('room:join:ack', { roomId: d.callId });
          logger.debug('[friend:call:incoming] Sent room:join:ack for roomId:', d.callId);
        }
      } catch {}
      handleIncomingFriend({ from: d.from, nick: d.nick, callId: d.callId });
    };
    
    const directCallHandler = ({ from, fromNick, callId }: { from: string; fromNick?: string; callId?: string }) => {
      logger.debug('[socket.on call:incoming] Received direct call:incoming event', { from, fromNick, callId });
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
      try { 

        // session сам установит callId и roomId при обработке call:accepted
        if (d?.roomId && roomId !== d.roomId) {
          socket.emit('room:join:ack', { roomId: d.roomId });
        }
      } catch {}
      

      // Для friend-call камера по умолчанию ВКЛ
      camUserPreferenceRef.current = true;
      
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
      const hasRoomId = !!d?.roomId || !!roomId;
      const hasPeerUserId = !!route?.params?.peerUserId;
      const isReceiver = !isInitiator && (hasIncomingCall || friendCallAccepted || hasCallId || hasRoomId || hasPeerUserId);
      
      // Для инициатора устанавливаем флаги при получении call:accepted
      if (isInitiator) {
        
        // КРИТИЧНО: Сбрасываем неактивное состояние если оно было установлено после рандомного чата
        if (isInactiveStateRef.current) {
          isInactiveStateRef.current = false;
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
        }
        
        // КРИТИЧНО: Устанавливаем partnerUserId для инициатора
        // ВАЖНО: d?.fromUserId в call:accepted для инициатора - это ID receiver (который принял звонок)
        // Используем route?.params?.peerUserId как fallback, но приоритет отдаем d?.fromUserId
        const peerUserId = d?.fromUserId || route?.params?.peerUserId;
        
        if (peerUserId) {
          // КРИТИЧНО: Всегда обновляем partnerUserId для инициатора, даже если он уже установлен
          // Это гарантирует правильное значение после рандомного чата
          if (!partnerUserIdRef.current || partnerUserIdRef.current !== String(peerUserId)) {
            partnerUserIdRef.current = String(peerUserId);
            setPartnerUserId(String(peerUserId));
          } else {
          }
        } else {
          console.warn('[call:accepted] No partnerUserId available for initiator', {
            routePeerUserId: route?.params?.peerUserId,
            eventFromUserId: d?.fromUserId,
            note: 'Will try to get from handleMatchFound'
          });
        }
        
        // Устанавливаем флаги синхронно через refs для немедленного использования
        inDirectCallRef.current = true;
        setFriendCallAccepted(true);
        setInDirectCall(true);
        setStarted(true);
        

        // Логика установки remoteCamOn для прямых звонков теперь в session
        
        // Создаем локальный стрим для инициатора, если его еще нет
        // Это нужно чтобы при приходе match_found стрим уже был готов
        if (!localStream) {
          const session = sessionRef.current;
          if (!session) {
            console.error('Session not initialized');
            return;
          }
          session.startLocalStream('front').then(async (stream) => {
            if (stream) {
              
              // КРИТИЧНО: Включаем камеру после создания стрима

              setCamOn(true);
              
              // КРИТИЧНО: Создаем PeerConnection после создания стрима с задержкой

              if (friendCallAccepted && inDirectCallRef.current) {
                setTimeout(async () => {

                  if (friendCallAccepted && inDirectCallRef.current) {
                    try {
                      // КРИТИЧНО: Для инициатора partnerId будет установлен из match_found
                      // Если partnerId еще не установлен, ждем match_found перед созданием PC
                      if (!partnerId) {
                        return;
                      }
                      
                    const session = sessionRef.current;
                    if (!session) {
                      console.error('[call:accepted] Session not initialized');
                      return;
                    }
                    // attachRemoteHandlers вызывается внутри session.ensurePcWithLocal()
                    await session.ensurePcWithLocal(stream);
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
          // Если стрим уже существует, убеждаемся что камера включена

          setCamOn(true);
          // КРИТИЧНО: Создаем PeerConnection если стрим уже есть с задержкой

          if (friendCallAccepted && inDirectCallRef.current) {
            setTimeout(async () => {

              if (friendCallAccepted && inDirectCallRef.current) {
                try {
                const session = sessionRef.current;
                if (!session) {
                  console.error('[call:accepted] Session not initialized');
                  return;
                }
                // attachRemoteHandlers вызывается внутри session.ensurePcWithLocal()
                await session.ensurePcWithLocal(localStream);
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
        
        // Сбрасываем неактивное состояние если оно было установлено после случайного чата
        if (isInactiveStateRef.current) {
          isInactiveStateRef.current = false;
          setIsInactiveState(false);
          setWasFriendCallEnded(false);
        }
        
        // Устанавливаем флаги для receiver синхронно через refs для немедленного использования
        inDirectCallRef.current = true;
        setFriendCallAccepted(true);
        setInDirectCall(true);
        setStarted(true);
        

        // Логика установки remoteCamOn для прямых звонков теперь в session
        
        // КРИТИЧНО: Устанавливаем partnerId для receiver ДО создания стрима
        // ВАЖНО: d?.from должен содержать socket.id инициатора (не receiver!)
        // Это исправлено в backend: для receiver отправляется from: aSock.id (socket.id инициатора)
        const partnerSocketId = d?.from;
        if (partnerSocketId && !partnerId) {
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

          }
        } else if (!partnerSocketId) {
          console.warn('[call:accepted] No partnerSocketId in d?.from for receiver', { 
            from: d?.from, 
            fromUserId: d?.fromUserId,
            incomingFriendCallFrom: incomingFriendCall?.from 
          });
        } else if (partnerId && partnerId !== partnerSocketId) {
          console.warn('[call:accepted] Receiver: partnerId mismatch!', {
            current: partnerId,
            new: partnerSocketId,
            from: d?.from,
            fromUserId: d?.fromUserId
          });

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
          const session = sessionRef.current;
          if (!session) {
            console.error('Session not initialized');
            return;
          }
          session.startLocalStream('front').then(async (stream) => {
            if (stream) {
              
              // КРИТИЧНО: Включаем камеру после создания стрима

              setCamOn(true);
              
              // КРИТИЧНО: НЕ создаем PeerConnection для receiver в call:accepted
              // PC будет создан в handleOffer или handleMatchFound когда придет offer
              // Это предотвращает создание нескольких PC
            }
          }).catch((e) => {
            console.error('[call:accepted] Error creating local stream for receiver:', e);
          });
        } else {
          // Если стрим уже существует, убеждаемся что камера включена

          setCamOn(true);
          // КРИТИЧНО: НЕ создаем PeerConnection для receiver в call:accepted
          // PC будет создан в handleOffer или handleMatchFound когда придет offer
          // Это предотвращает создание нескольких PC
        }
      }
      
      // Создаем PeerConnection после принятия вызова
      // КРИТИЧНО: Используем refs вместо state для проверки, так как state обновляется асинхронно
      try {
        const stream = localStream;
        // Используем refs для проверки, так как state может быть еще не обновлен
        const hasFriendCallAccepted = friendCallAccepted || friendCallAccepted || isInitiator || isReceiver;
        const hasInDirectCall = inDirectCallRef.current || inDirectCall;
        const shouldCreatePc = hasFriendCallAccepted && hasInDirectCall;
        
        

        if (stream && shouldCreatePc) {
          const session = sessionRef.current;
          if (!session) {
            console.error('[call:accepted] Session not initialized');
            return;
          }
          
          // attachRemoteHandlers вызывается внутри session.ensurePcWithLocal()
          await session.ensurePcWithLocal(stream);
        } else if (!stream && shouldCreatePc) {
          console.warn('[call:accepted] Cannot create PeerConnection - stream not ready yet, will be created when stream is available');

        } else if (shouldCreatePc) {
          // Если PC уже существует, убеждаемся что handlers привязаны
          if (partnerId) {
            // attachRemoteHandlers вызывается внутри session.ensurePcWithLocal()
            // Если нужно обновить handlers, используйте session.ensurePcWithLocal() снова
          }
        }
      } catch (e) {
        console.error('[call:accepted] Error creating PeerConnection:', e);
      }
    };
    try { socket.on('call:accepted', onAccepted); } catch {}
    return () => { try { socket.off('call:accepted', onAccepted); } catch {} };
  }, [localStream, friendCallAccepted, inDirectCall, isDirectCall, isDirectInitiator, incomingFriendCall, incomingCall, isInactiveState, stopIncomingAnim, route?.params?.peerUserId]);
  // --------------------------
  // call:ended теперь обрабатывается через session.on('callEnded')
  
  // ==================== WebRTC Session Initialization ====================
  // Инициализируем session после всех определений функций
  useEffect(() => {
    if (sessionRef.current) return; // Уже инициализирован
    
    const sessionConfig: WebRTCSessionConfig = {
      myUserId,
      callbacks: {
        onLocalStreamChange: (stream) => {
          setLocalStream(stream);

        },
        onRemoteStreamChange: (stream) => {
          // КРИТИЧНО: Проверяем активное соединение перед очисткой remoteStream
          const hasRemoteStream = !!remoteStream;
          const session = sessionRef.current;
          const pc = session?.getPeerConnection?.();
          
          
          // КРИТИЧНО: Устанавливаем remoteStream только если он не null
          // Если stream === null, это означает что соединение разорвано
          if (stream) {
            setRemoteStream(stream);
          } else {
            // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
            // Проверяем наличие remoteStream И состояние PeerConnection
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
            // Если stream === null, сбрасываем только если это явное удаление
            setRemoteStream(null);
          }
        },
        onMicStateChange: (enabled) => setMicOn(enabled),
        onCamStateChange: (enabled) => {
          setCamOn(enabled);
        },
        onRemoteCamStateChange: (enabled) => {
          setRemoteCamOn(enabled);
        },
        onMicLevelChange: (level) => {
          setMicLevel(level);
          // КРИТИЧНО: Используем новое значение level, а не старое micLevel
          // Обновляем micLevel в PiP
          try {
            pip.updatePiPState({ micLevel: level });
          } catch (e) {
            // Игнорируем ошибки если PiP контекст недоступен
          }
        },
        onLoadingChange: (loading) => {
          setLoading(loading);
          loadingRef.current = loading;
        },

      },
      // State getters
      getIsInactiveState: () => isInactiveStateRef.current,
      getIsDirectCall: () => isDirectCall,
      getInDirectCall: () => inDirectCallRef.current,
      getFriendCallAccepted: () => friendCallAccepted,
      getStarted: () => startedRef.current,
      getIsNexting: () => isNexting,
      // State setters
      setIsInactiveState: (value) => {
        setIsInactiveState(value);
        isInactiveStateRef.current = value;
      },
      setWasFriendCallEnded: (value) => {
        setWasFriendCallEnded(value);
        wasFriendCallEndedRef.current = value;
      },
      setFriendCallAccepted: (value) => {
        setFriendCallAccepted(value);
      },
      setInDirectCall: (value) => {
        setInDirectCall(value);
        inDirectCallRef.current = value;
      },
      setStarted: (value) => {
        setStarted(value);
        startedRef.current = value;
      },
      setIsNexting: (value) => setIsNexting(value),
      setAddBlocked: (value) => setAddBlocked(value),
      setAddPending: (value) => setAddPending(value),
      // External functions

      clearDeclinedBlock: () => clearDeclinedBlock(),
      fetchFriends: async () => {
        const r = await fetchFriends();
        setFriends(r?.list || []);
      },
      sendCameraState: (toPartnerId) => sendCameraState(toPartnerId),
      getDeclinedBlock: () => declinedBlockRef.current,
      getIncomingFriendCall: () => incomingFriendCall,
      getWasFriendCallEnded: () => wasFriendCallEndedRef.current,
      getFriends: () => friends,
      // PiP support
      getPipLocalStream: () => pipLocalStream,
      getPipRemoteStream: () => pipRemoteStream,
      getResume: () => resume,
      getFromPiP: () => fromPiP,
    };
    
    sessionRef.current = new WebRTCSession(sessionConfig);
    
    // Подписки на события session
    const session = sessionRef.current;
    
    session.on('localStream', (stream) => {
      setLocalStream(stream);

    });
    
    session.on('remoteStream', (stream) => {
      // КРИТИЧНО: Устанавливаем remoteStream только если он не null
      if (stream) {
        setRemoteStream(stream);
      } else {
        setRemoteStream(null);
      }
    });
    
    session.on('remoteViewKeyChanged', (key) => {
      setRemoteViewKey(key);
    });
    
    session.on('remoteStreamRemoved', () => {
      // КРИТИЧНО: Проверяем активное соединение перед очисткой remoteStream
      const hasRemoteStream = !!remoteStream;
      const session = sessionRef.current;
      const pc = session?.getPeerConnection?.();
      
      
      // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
      // Проверяем наличие remoteStream И состояние PeerConnection
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
      
      // remoteStream управляется через события session
      setRemoteStream(null);
    });
    
    session.on('connected', () => {
      // Состояние подключения и микрофонный метр управляются в session
      // session сам запускает метр при подключении
    });
    
    session.on('disconnected', () => {
      // Вся тяжёлая очистка уже внутри session.handleRandomDisconnected
      
      // UI-логика для disconnected/hangup
      if (leavingRef.current) {
        return;
      }
      if (!startedRef.current) {
        return;
      }
      
      // Сохраняем состояние ДО очистки для проверки типа звонка
      const wasInCall = !!remoteStream;
      const wasStarted = started;
      const wasDirectCall = isDirectCall;
      const wasInDirectCall = inDirectCall;
      const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
      
      
      // UI-очистка
      setPartnerUserId(null);
      setInDirectCall(false);
      stopSpeaker();
      
      // Определяем тип чата
      const isRandomChat = !wasDirectCall && !wasInDirectCall;
      
      // КРИТИЧНО: Для рандомного чата сбрасываем refs дружеских звонков
      if (isRandomChat) {
        inDirectCallRef.current = false;
        setFriendCallAccepted(false);
      }
      const wasDirectCallFlag = wasDirectCall || wasInDirectCall;
      
      // НЕ запускаем автопоиск если:
      // 1. Звонок был завершен (isInactiveState или wasFriendCallEnded) - это завершенный звонок друга
      // 2. Это был прямой звонок (wasDirectCall || wasInDirectCall) - для прямых звонков нет автопоиска
      if (isInactive || wasDirectCallFlag) {
        // Если был прямой звонок - возвращаемся на VideoChat
        if (wasInCall && wasDirectCallFlag) {
          setLoading(false);
          setStarted(false);
          goToVideoChatWithHomeUnder();
        }
        return;
      }
      
      // ВАЖНО: Если партнер вышел из общения (любым способом), автопоиск запускается внутри session
      // Здесь только UI-обновление
      if (isRandomChat && wasInCall) {
        // Автопоиск уже запущен внутри session.handleRandomDisconnected()
        return;
      }
      
      if (wasInCall) {
        // Если звонок был — возвращаемся в [Home, VideoChat]
        setLoading(false);
        setStarted(false);
        goToVideoChatWithHomeUnder();
      } else {
        // звонок не состоялся — вернёмся на origin
        setLoading(false);
        setStarted(false);
        const origin = callOriginRef.current;
        if (origin?.name && origin.name !== 'VideoChat') {
          try { (global as any).__navRef?.reset?.({ index: 0, routes: [{ name: origin.name as any, params: origin.params }] }); } catch {}
        }
      }
    });
    
    session.on('matchFound', ({ partnerId, roomId, userId }) => {
      handleMatchFound({ id: partnerId!, userId, roomId });
    });
    
    session.on('incomingCall', ({ callId, fromUser, fromNick }) => {
      setIncomingFriendCall({ from: fromUser, nick: fromNick });

      setIncomingOverlay(true);
      startIncomingAnim();
    });
    
    session.on('callAnswered', () => {
      setFriendCallAccepted(true);
      setIncomingOverlay(false);
      stopIncomingAnim();
    });
    
    session.on('callDeclined', () => {
      setIncomingFriendCall(null);
      setIncomingOverlay(false);
      stopIncomingAnim();
    });
    
    session.on('callEnded', () => {
      // Здесь только UI:
      // - спрятать оверлеи
      setIncomingOverlay(false);
      setIncomingFriendCall(null);
      stopIncomingAnim();
      
      // - очистить PiP-состояние
      try { 
        pip.updatePiPState({ micLevel: 0 }); 
      } catch (e) {
        console.warn('[callEnded] Error updating PiP micLevel:', e);
      }
      try { stopSpeaker(); } catch {}
      
      // - установить флаги
      setWasFriendCallEnded(true);
      setIsInactiveState(true);
      setPartnerUserId(null);
      setRemoteViewKey(0);
      setLocalRenderKey((k: number) => k + 1);
      setLoading(false);
      setStarted(false);
      setCamOn(false);
      setMicOn(false);
      setFriendCallAccepted(false);
      setInDirectCall(false);
      
      // - показать уведомление
      try { showToast('Звонок завершён'); } catch {}
      
      // ВСЕ session.* вызовы для cleanup уже внутри handleExternalCallEnded
    });
    
    session.on('searching', () => {
      // КРИТИЧНО: Сбрасываем неактивное состояние при начале поиска
      // Это важно для разблокировки кнопок
      if (isInactiveStateRef.current) {
        isInactiveStateRef.current = false;
        setIsInactiveState(false);
      }
      setLoading(true);
      setStarted(true);
      // Убеждаемся, что loading устанавливается правильно
      loadingRef.current = true;
    });
    

    // Теперь используется только второй обработчик (строка 3904) с проверками
    
    // Слушаем событие remoteState для обновления remoteCamOn, remoteMuted, remoteInPiP
    session.on('remoteState', ({ remoteCamOn, remoteMuted, remoteInPiP, remoteViewKey }) => {
      setRemoteCamOn(remoteCamOn);
      setRemoteMutedMain(remoteMuted);
      setPartnerInPiP(remoteInPiP);
      if (remoteViewKey !== undefined) {
        setRemoteViewKey(remoteViewKey);
      }
    });
    
    // Дополнительная обработка события cam-toggle напрямую через сокет для гарантированного обновления UI
    // Это работает как дополнительная защита на случай, если событие приходит до инициализации session
    const handleCamToggle = (data: { enabled: boolean; from: string; to?: string; roomId?: string }) => {
      const { enabled, from, to, roomId: eventRoomId } = data;
      const currentPartnerId = partnerId;
      const currentRoomId = roomId;
      const isDirectFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      
      // Проверяем, что событие предназначено для нас
      // Для рандомного чата: проверяем to === socket.id или from === partnerId
      // Для прямых звонков: проверяем roomId или from === partnerId
      const shouldProcess = 
        (to && to === socket.id) || // Событие адресовано нам напрямую
        (from === currentPartnerId) || // От нашего партнера
        (isDirectFriendCall && eventRoomId && eventRoomId === currentRoomId) || // Прямой звонок, совпадает roomId
        (isDirectFriendCall && currentRoomId && eventRoomId === currentRoomId) || // Прямой звонок, совпадает roomId (дополнительная проверка)
        (isDirectFriendCall && !currentPartnerId); // Прямой звонок, partnerId еще не установлен
      
      if (shouldProcess) {
        // Обновляем состояние камеры собеседника
        setRemoteCamOn(enabled);
        
        // Также обновляем remoteViewKey для принудительного перерендера
        setRemoteViewKey(prev => prev + 1);
      }
    };
    
    // Регистрируем обработчик события cam-toggle
    socket.on('cam-toggle', handleCamToggle);
    
    // Слушаем событие sessionUpdate для обновления roomId, partnerId
    session.on('sessionUpdate', ({ roomId, partnerId, callId }) => {
      setRoomId(roomId);
      setPartnerId(partnerId);
    });
    
    session.on('partnerPiPStateChanged', ({ inPiP }: { inPiP: boolean }) => {

      
      // Перезапускаем метр микрофона после возврата партнера из PiP
      if (!inPiP) {
        try {
          const hasActiveCall = !!partnerId || !!roomId || !!currentCallIdRef.current;
          const isFriendCallActive = isDirectCall || inDirectCallRef.current || friendCallAccepted;
          const stream = localStream;
          const remoteStreamForCheck = remoteStream;
          
          // Управление микрофонным метром теперь полностью в session.ts
          // session сам запускает/останавливает метр при подключении/отключении
        } catch (e) {
          console.warn('[partnerPiPStateChanged] Error in mic meter restart logic:', e);
        }
      }
    });
    
    // Обработчик события 'stopped' от session (peer:stopped)
    session.on('stopped', () => {
      
      // Если уходим со страницы — игнорируем событие
      if (leavingRef.current) {
        return;
      }
      
      // КРИТИЧНО: Игнорируем если идет процесс начала поиска
      const isStartingSearch = loadingRef.current || (startedRef.current && !partnerId && !roomId && !isInactiveStateRef.current);
      if (isStartingSearch) {
        return;
      }
      
      // Если поиск уже прекращён — игнорируем
      if (!startedRef.current) {
        return;
      }
      
      // Сохраняем состояние ДО очистки
      const hadPartner = !!partnerId;
      const isRandomChat = !isDirectCall && !inDirectCallRef.current;
      const wasDirectCall = isDirectCall || inDirectCallRef.current;
      const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
      
      // Партнёр остановил поиск — очищаем UI состояние
      const session = sessionRef.current;
      if (session) {
        session.stopRemoteStream();
      }
      // UI-логика очистки состояний

      setPartnerUserId(null);

      try { stopSpeaker(); } catch {}
      
      // НЕ запускаем автопоиск если:
      // 1. Звонок был завершен
      // 2. Это был прямой звонок
      if (isInactive || wasDirectCall) {
        return;
      }
      
      // ВАЖНО: При нажатии "Далее" партнером автопоиск запускается внутри session (через peer:stopped/peer:left)
      // Здесь только UI-обновление
      if (isRandomChat && hadPartner && !isInactive) {
        
        setLoading(true);
        setStarted(true);
        // remoteStream управляется через события session

        setPartnerUserId(null);
        
        // Автопоиск уже запущен внутри session.handleStop() / session.handleNext()
      }
    });
    
    // Обработчик события 'nexted' от session (peer:left)
    session.on('nexted', () => {
      if (leavingRef.current) {
        return;
      }
      if (!startedRef.current) {
        return;
      }
      
      // Сохраняем состояние ДО очистки
      const hadPartner = !!partnerId;
      const isRandomChat = !isDirectCall && !inDirectCallRef.current;
      const wasDirectCall = isDirectCall || inDirectCallRef.current;
      const isInactive = isInactiveStateRef.current || wasFriendCallEnded;
      
      // КРИТИЧНО: Проверяем активное соединение перед очисткой remoteStream
      const session = sessionRef.current;
      const hasRemoteStream = !!remoteStream;
      const pc = session?.getPeerConnection?.();
      
      
      // КРИТИЧНО: НЕ очищаем remoteStream если соединение активно
      // Проверяем наличие remoteStream И состояние PeerConnection
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
      
      // Очищаем UI состояние
      if (session) {
        session.stopRemoteStream();
      }
      // UI-логика очистки состояний

      setPartnerUserId(null);

      
      // НЕ запускаем автопоиск если:
      // 1. Звонок был завершен
      // 2. Это был прямой звонок
      if (isInactive || wasDirectCall) {
        return;
      }
      
      // ВАЖНО: При нажатии "Далее" партнером запускаем автопоиск для ОБОИХ пользователей
      if (isRandomChat && hadPartner && !isInactive) {
        
        setLoading(true);
        setStarted(true);
        
        // Автопоиск уже запущен внутри session.handleNext() / session.handleStop()
      }
    });
    
    // Обработчик события 'partnerChanged' от session
    session.on('partnerChanged', ({ partnerId: newPartnerId, oldPartnerId }: { partnerId: string | null; oldPartnerId?: string | null }) => {
      // Обновляем UI состояние при изменении партнера

      if (newPartnerId !== partnerId) {
        if (!newPartnerId) {
          setPartnerUserId(null);
        }
      }
    });
    
    // Cleanup при размонтировании
    return () => {
      // Удаляем обработчик события cam-toggle
      try {
        socket.off('cam-toggle', handleCamToggle);
      } catch (e) {
        console.warn('[VideoChat cleanup] Error removing cam-toggle handler:', e);
      }
      
      // КРИТИЧНО: Проверяем, не идет ли процесс начала поиска ИЛИ есть активное соединение
      // Если идет поиск ИЛИ есть активное соединение, не уничтожаем session
      const isStartingSearch = loadingRef.current || (startedRef.current && !partnerId && !roomId && !isInactiveStateRef.current);
      const hasActiveConnection = !!partnerId || !!roomId;
      
      if (isStartingSearch || hasActiveConnection) {
        return;
      }
      
      if (sessionRef.current) {
        sessionRef.current.removeAllListeners();
        sessionRef.current.destroy();
        sessionRef.current = null;
      }
    };
  }, [myUserId, isDirectCall, resume, fromPiP, pipLocalStream, pipRemoteStream, 
      clearDeclinedBlock, sendCameraState, 
      startIncomingAnim, stopIncomingAnim, fetchFriends]);

  // Обработчик уведомления о том, что партнер перешел в background режим
  useEffect(() => {
    const onPartnerEnteredbackground = (data: any) => {
    };

    const onPartnerExitedbackground = (data: any) => {
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
      const isFriendCall = isDirectCall || inDirectCallRef.current || friendCallAccepted;
      const hasActiveCallId = !!currentCallIdRef.current;
      const hasActiveRoomId = !!roomId;

      const hasActivePC = false; // Session сам управляет PC
      const hasActivePartner = !!partnerId || !!partnerUserIdRef.current;
      
      // Для дружеских звонков проверяем не только roomId, но и наличие PC или callId
      // Это важно во время установки соединения, когда roomId еще может быть null, но PC уже создан
      const hasActiveCall = hasActiveRoomId || hasActiveCallId || (hasActivePC && hasActivePartner);
      const keepAliveForPiP = (isFriendCall && hasActiveCall) || pip.visible;

      if (keepAliveForPiP) {
        // Не останавливаем спикер, не закрываем PC, не стопим треки
        return;
      }

      // Для рандомного чата отправляем stop и room:leave при unmount
      const isRandomChat = !isFriendCall && (roomId || partnerId || startedRef.current);
      // ВАЖНО: НЕ останавливаем стрим если пользователь только что начал поиск (started=true, но нет partnerId и roomId)
      // Это предотвращает остановку стрима сразу после нажатия "Начать"
      const isJustStarted = startedRef.current && !partnerId && !roomId;
      const hasStream = !!localStream;
      
      if (isRandomChat && !isJustStarted) {

        const session = sessionRef.current;
        if (session) {
          try {
            const currentRoomId = roomId;
            if (currentRoomId) {
              session.leaveRoom(currentRoomId);
            }
          } catch (e) {
            console.warn('[Unmount cleanup] Error leaving room for random chat:', e);
          }
          
          try {
            session.stopRandom();
          } catch (e) {
            console.warn('[Unmount cleanup] Error stopping random chat:', e);
          }
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
      
      // Управление микрофонным метром теперь полностью в session.ts
      
      // Сбрасываем флаг остановки при размонтировании
      isStoppingRef.current = false;

      // КРИТИЧНО: Проверяем, не идет ли процесс начала поиска
      // Если идет, не уничтожаем session
      const isStartingSearch = loadingRef.current || (startedRef.current && !partnerId && !roomId && !isInactiveStateRef.current);
      if (isStartingSearch) {
        // НЕ вызываем session.destroy() если идет начало поиска
      } else {

        const session = sessionRef.current;
        if (session) {
          session.destroy();
        }
      }

      // ВАЖНО: НЕ останавливаем стрим если пользователь только что начал поиск ИЛИ стрима нет ИЛИ есть активное соединение
      // Это предотвращает остановку стрима сразу после нажатия "Начать" и при активном соединении
      // ДОПОЛНИТЕЛЬНАЯ ЗАЩИТА: Проверяем, что мы не в процессе создания стрима (loading=true)
      const isLoading = loading;
      // ВАЖНО: Проверяем наличие активного соединения (partnerId или roomId)
      // Если есть активное соединение, НЕ останавливаем стрим - он нужен для видеозвонка
      const hasActiveConnection = !!partnerId || !!roomId;
      if (!isJustStarted && hasStream && !isLoading && !hasActiveConnection) {
        try {
        const session = sessionRef.current;
        if (session) {
          session.stopLocalStream().catch(() => {});
        }
      } catch {}
      } else {
      }
      // ВАЖНО: НЕ сбрасываем camOn если есть активное соединение
      // Камера должна оставаться включенной при активном видеозвонке
      if (!hasActiveConnection) {
        try { setCamOn(false); } catch {}
      } else {
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

  // Функция для рендера remote video - вынесена для избежания дублирования
  const renderRemoteVideo = useCallback(() => {
    if (!remoteStream) {
      return null;
    }

    const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
    
    // Минимальный фикс логики показа
    if (!vt) {
      // Нет трека - показываем лоадер
      return (
        <View style={styles.rtc}>
          <ActivityIndicator size="large" color="#fff" />
        </View>
      );
    }

    if (vt.readyState === 'ended') {
      // readyState === 'ended' - это баг, логируем ошибку
      // Для remote track мы не можем перезапустить локальную камеру, это проблема партнера
      console.warn('[VideoChat] VIDEO TRACK DIED - remote video track ended', {
        trackState: vt.readyState,
        trackEnabled: vt.enabled
      });
      return null;
    }

    // enabled === false - это норма (пользователь выключил камеру)
    // Показываем заглушку "Отошёл" в основной логике, здесь возвращаем null
    if (vt.enabled === false) {
      return null;
    }

    // Иначе показываем видео
    const streamURL = remoteStream.toURL?.();
    return (
      <RTCView
        streamURL={streamURL}
        style={styles.rtc}
        objectFit="cover"
        mirror={false}
      />
    );
  }, [remoteStream]);

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
          const hasActiveCall = !!roomId && !isInactiveStateRef.current;
          
          // Если это не звонок с другом (рандомный чат) — немедленно завершаем поиск и стрим перед навигацией
          if (!isFriendCall) {
            try {
              leavingRef.current = true;
              startedRef.current = false;
              setStarted(false);
              setLoading(false);
              isInactiveStateRef.current = true;
              setIsInactiveState(true);
              // КРИТИЧНО: НЕ останавливаем локальный стрим при skip/next
              // stopLocalStream разрешен только при нажатии "Стоп", уходе со страницы или ошибках WebRTC
              try {
                setCamOn(false);
                setMicOn(false);
              } catch (e) {
                console.warn('[PanGestureHandler] Error stopping local stream:', e);
              }

              const session = sessionRef.current;
              if (session) {
                session.stopRandom();
                const rid = roomId;
                if (rid) { session.leaveRoom(rid); }
                // Очистка PC
                session.destroy();
              }
              // remoteStream управляется через события session

              setPartnerUserId(null);

              partnerUserIdRef.current = null as any;
            } catch {}
          }
          
          // Если находимся в неактивном состоянии (завершенный звонок),
          // просто навигируем назад без показа PiP и без каких-либо действий
          if (isInactiveStateRef.current) {
            // Гарантированно гасим камеру/микрофон и очищаем соединение ПЕРЕД навигацией
            try {
              leavingRef.current = true;
              // Сохраним roomId, чтобы отослать room:leave после остановки стрима
              const rid = roomId;
              // Сначала сбрасываем идентификаторы, чтобы stopLocalStream не сохранял стрим
              startedRef.current = false;
              setStarted(false);
              isInactiveStateRef.current = true;
              setIsInactiveState(true);

              partnerUserIdRef.current = null as any;
              // Останавливаем локальный стрим (не ждем)
              try {
                const session = sessionRef.current;
                if (session) {
                  session.stopLocalStream(false).catch(() => {});
                }
              } catch {}

              setCamOn(false);
              setMicOn(false);
              // Закрываем PC
              try {
                const session = sessionRef.current;
                if (session) {
                  session.destroy();
                }
              } catch {}
              // Останавливаем треки remote stream перед очисткой
              // remoteStream управляется через события session
              if (remoteStream) {

                const session = sessionRef.current;
                if (session && remoteStream) {
                  session.stopRemoteStream();
                }
              }
              // Управление микрофонным метром теперь полностью в session.ts
              try { stopSpeaker(); } catch {}

              const session = sessionRef.current;
              if (session) {
                session.stopRandom();
                if (rid) session.leaveRoom(rid);
              }
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
              const session = sessionRef.current;
              if (session && localStream && camOn) {
                session.toggleCam();
              }
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
              roomId: roomId || '',
              partnerName: partner?.nick || 'Друг',
              partnerAvatarUrl: partnerAvatarUrl,
              muteLocal: !micOn,
              muteRemote: remoteMutedMain,
              localStream: localStream || null,
              remoteStream: remoteStream || null,
              navParams: {
                ...route?.params,
                peerUserId: partnerUserId || partnerUserIdRef.current,
                partnerId: partnerId || partnerId, // Сохраняем partnerId для восстановления соединения
              } as any,
            });
            

            const session = sessionRef.current;
            if (session) {
              session.enterPiP();
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
                      
                      // Для friend-call включаем камеру по умолчанию, если пользователь не нажимал "выкл"

                      if (true) { // Всегда устанавливаем предпочтение для friend-call
                        camUserPreferenceRef.current = true;
                      }
                      
                      // Сбрасываем блокировку (если была) — это новый явный приём вызова
                      try { clearDeclinedBlock(); } catch {}
                      

                      // session сам установит callId при обработке call:accepted
                      const finalCallId = incomingCall?.callId || currentCallIdRef.current;
                      if (finalCallId) {
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
                      }
                      
                      // Сначала сбрасываем входящий звонок и закрываем модалку
                      setIncomingOverlay(false);
                      setIncomingFriendCall(null);
                      setIncomingCall(null);
                      stopIncomingAnim();
                      

                      // Session сам управляет PC при принятии нового звонка
                      const session = sessionRef.current;
                      if (session) {
                        session.destroy();
                      }
                      
                      // Очищаем remote stream от предыдущего звонка если он существует
                      // Это важно при принятии нового звонка в неактивном состоянии
                      if (remoteStream) {

                        try {
                          const session = sessionRef.current;
                          if (session && remoteStream) {
                            session.stopRemoteStream();
                          }
                        } catch (e) {
                          console.warn('[Accept Call] Error clearing old remote stream:', e);
                        }
                        // remoteStream управляется через события session
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

                      
                      // Сбрасываем loading через небольшую задержку, чтобы дать время на установку соединения
                      setTimeout(() => {
                        setLoading(false);
                      }, 2000);
                      
                      // Принимаем вызов с callId или без него (для звонков друзей callId может прийти позже)
                      try { 
                        if (finalCallId) {
                          acceptCall(finalCallId);
                        }
                      } catch {}
                      
                      // Уведомляем друзей что мы заняты
                      try {
                        socket.emit('presence:update', { status: 'busy', roomId: roomId });
                      } catch (e) {
                        console.error('[Accept Call] Failed to send presence update:', e);
                      }
                      
                      // Отправляем состояние камеры после принятия вызова
                      setTimeout(() => {
                        try {
                          sendCameraState();
                        } catch (e) {
                          console.error('[Accept Call] Failed to send camera state:', e);
                        }
                      }, 100);
                      
                      // Гарантируем локальный поток для ответа
                      // PeerConnection будет создан в handleMatchFound когда придет событие match_found
                      // Это важно чтобы partnerId был установлен правильно перед созданием PC
                      // К этому моменту friendCallAccepted уже установлен в true выше, 
                      // поэтому session.startLocalStream() сможет создать стрим даже если был в неактивном состоянии
                      try { 
                        const session = sessionRef.current;
                        if (session) {
                          // Если находимся в неактивном состоянии, но это активный звонок, выходим из неактивного состояния
                          if (isInactiveStateRef.current && (friendCallAccepted || isDirectCall || inDirectCall)) {
                            setIsInactiveState(false);
                            setWasFriendCallEnded(false);
                            await new Promise(resolve => setTimeout(resolve, 50));
                          }
                          
                          // session.startLocalStream() сам проверяет валидность существующего стрима
                          // и создает новый если нужно, включая камеру и микрофон
                          const stream = await session.startLocalStream('front');
                          
                          // Обновляем UI состояние камеры и микрофона
                          if (stream) {
                            setCamOn(true);
                            setMicOn(true);
                          }
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
                        const callIdToDecline = incomingCall?.callId || currentCallIdRef.current || roomId;
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
              // КРИТИЧНО: Логируем только изменения remoteStream (не каждый рендер)
              // Убрали лог [Render] remoteStream - он создавал слишком много шума
              
              // КРИТИЧНО: Если поиск остановлен (started=false), всегда показываем "Собеседник"
              if (!started) {
                return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
              
              // В неактивном состоянии ВСЕГДА показываем только текст "Собеседник", независимо от наличия remoteStream
              if (isInactiveState) {
                return <Text style={styles.placeholder}>{L("peer")}</Text>;
              }
              
              // Если нет соединения (нет потока), показываем лоадер при поиске или текст "Собеседник"
              // НЕ используем черный фон - сразу показываем лоадер или текст без подложки
              if (!remoteStream) {
                if (loading && started) {
                  // Если поиск активен или звонок принят, показываем лоадер без черного фона
                  return <ActivityIndicator size="large" color="#fff" />;
                } else {
                  // Если поиск не активен, показываем текст "Собеседник"
                  return <Text style={styles.placeholder}>{L("peer")}</Text>;
                }
              }
              
              // КРИТИЧНО: Используем remoteViewKey для принудительного перерендера при изменении состояния камеры
              // remoteViewKey обновляется в handleCamToggle, что гарантирует перерендер компонента
              // Это необходимо, потому что React не отслеживает изменения в vt.enabled напрямую
              const _forceRerender = remoteViewKey; // Используем remoteViewKey для принудительного перерендера
              
              // Получаем актуальное состояние видео трека
              const vt = (remoteStream as any)?.getVideoTracks?.()?.[0];
              const videoTrackEnabled = vt?.enabled ?? false;
              const videoTrackReadyState = vt?.readyState ?? 'new';

              // КРИТИЧНО: Показываем RTCView ТОЛЬКО если выполнены ВСЕ условия:
              // 1. Есть remoteStream (уже проверено выше)
              // 2. Есть живой видео-трек (readyState === 'live')
              // 3. remoteCamOn === true
              // Во всех остальных случаях сразу показываем AwayPlaceholder, без промежуточного черного фона
              const hasLiveVideoTrack = vt && videoTrackReadyState === 'live';
              const canShowVideo = hasLiveVideoTrack && remoteCamOn === true && videoTrackEnabled === true;
              
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
              
              // Во всех остальных случаях (нет трека, трек ended, камера выключена) - показываем заглушку
              // НЕ используем промежуточный черный фон
              return <AwayPlaceholder />;
            })()}

            {/* Иконка звука */}
                {/* КРИТИЧНО: Показываем кнопки сразу после нажатия "Начать" (started=true), не ждем подключения пользователя */}
                {started && !isInactiveState && (() => {
                  const remoteBlockedByPiP = partnerInPiP && !pip.visible;
                  const baseOpacity = remoteStream ? (remoteMutedMain ? 0.6 : 1) : 0.5;
                  return (
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
                      <View style={{ opacity: baseOpacity }}>
                        <TouchableOpacity
                          onPress={toggleRemoteAudio}
                          disabled={!remoteStream || remoteBlockedByPiP}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          activeOpacity={0.7}
                          style={[
                            styles.iconBtn,
                            remoteBlockedByPiP && styles.iconBtnDisabled,
                          ]}
                        >
                          <View style={{ position: 'relative', justifyContent: 'center', alignItems: 'center' }}>
                            <MaterialIcons
                              name={remoteMutedMain ? "volume-off" : "volume-up"}
                              size={26}
                              color={remoteMutedMain ? "#999" : (remoteStream ? "#fff" : "#777")}
                            />
                            {remoteMutedMain && (
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
                  );
                })()}

            {/* Кнопка «Добавить в друзья» */}
                {/* КРИТИЧНО: Показываем кнопки сразу после нажатия "Начать" (started=true), не ждем подключения пользователя */}
                {(() => {
                  const shouldShowAddFriend = started && !isInactiveState && !!partnerUserId && !isPartnerFriend;
                  if (shouldShowAddFriend || (started && !isInactiveState && !!partnerUserId)) {
                  }
                  return shouldShowAddFriend;
                })() && (
                  <Animated.View
                    style={[
                      {
                        position: "absolute",
                        top: 8,
                        right: 8,
                        opacity: buttonsOpacity,
                      },
                    ]}
                  >
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

            {/* Бейдж «Друг» */}
                {/* КРИТИЧНО: Показываем бэйдж только если НЕ в неактивном состоянии И есть активное соединение (remoteStream) */}
                {/* Пользователь считается в активном поиске до тех пор, пока соединение не установлено */}
                {(() => {
                  const hasActiveConnection = !!remoteStream; // КРИТИЧНО: проверяем наличие активного соединения
                  const shouldShowBadge = !isInactiveState && showFriendBadge && hasActiveConnection;
                  if (shouldShowBadge || (!isInactiveState && !!partnerUserId)) {
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
                    const hasActiveCall = !!partnerId || !!roomId || !!currentCallIdRef.current;

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
      {/* Карточка «Вы» */}
      <View style={styles.card}>
        {(() => {
          // ВАЖНО: Показываем видео только если камера включена (camOn === true)
          // Если камера выключена (camOn === false), показываем заглушку "Отошел"
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
            // КРИТИЧНО: В блоке "Вы" при выключении камеры всегда показываем надпись "Вы"
            // Заглушка "Отошел" показывается только в блоке "Собеседник" когда камера собеседника выключена
            return <Text style={styles.placeholder}>{L("you")}</Text>;
          }
        })()}

        {/* КРИТИЧНО: Кнопки показываются сразу после нажатия "Начать" (started=true), не ждем подключения пользователя */}
        {started && !isInactiveState && (
          <Animated.View style={[styles.topLeft, { opacity: buttonsOpacity }]}>
            <TouchableOpacity
              onPress={() => sessionRef.current?.flipCamera()}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              activeOpacity={0.7}
              style={styles.iconBtn}
            >
              <MaterialIcons name="flip-camera-ios" size={26} color="#fff" />
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* КРИТИЧНО: Кнопки показываются сразу после нажатия "Начать" (started=true), не ждем подключения пользователя */}
        {started && !isInactiveState && (
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
    ...((Platform.OS === "ios" ? { height: Dimensions.get('window').height * 0.4 } : { height: Dimensions.get('window').height * 0.43 })
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
    gap: Platform.OS === "android" ? 14 : 16, 
    marginTop: Platform.OS === "android" ? 6 : 10, 
    marginBottom: 18,
  },
  bigBtn: { 
    flex: 1, 
    height: Platform.OS === "android" ? 50 : 55, 
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