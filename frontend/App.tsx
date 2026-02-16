// App.tsx
import "react-native-gesture-handler";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Provider as PaperProvider } from "react-native-paper";
import { Platform } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import * as NavigationBar from "expo-navigation-bar";
import { NavigationContainer, createNavigationContainerRef, CommonActions, DefaultTheme } from "@react-navigation/native";
import { ThemeProvider, useAppTheme } from "./theme/ThemeProvider";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import { View, Text, Animated, TouchableOpacity, StyleSheet, Easing, AppState, StatusBar, Linking, LogBox, Keyboard, InteractionManager, NativeModules, NativeEventEmitter } from "react-native";
import { BlurView } from "expo-blur";
import { MaterialIcons } from "@expo/vector-icons";
import { PanGestureHandler } from "react-native-gesture-handler";
import socket, { onCallIncoming, onCallTimeout, onCallDeclined, onCallCanceled, onCallAccepted, acceptCall, declineCall, cancelCall, requestCallAccepted, ensureSocketConnected, checkInviteLink, getCurrentUserId, API_BASE, setOutgoingCallScreenVisible, setIncomingCallScreenVisible } from "./sockets/socket";
import { emitMissedIncrement, emitCloseIncoming, emitRequestCloseIncoming, emitCloseOutgoingCall, onRequestCloseIncoming, onCloseIncoming } from './utils/globalEvents';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './utils/logger';
import InCallManager from 'react-native-incall-manager';
import { startIncomingCallAlert, stopIncomingCallAlert } from './utils/incomingCallAlert';
import HomeScreen from "./screens/HomeScreen";
import VideoCallScreen from "./screens/VideoCallScreen";
import RandomChatScreen from "./screens/RandomChatScreen";
import ChatScreen from "./screens/ChatScreen";
import { PiPProvider, usePiP } from "./src/pip/PiPContext";
import PiPOverlay from "./src/pip/PiPOverlay";
import { ensureCometChatReady } from "./chat/cometchat";
import type { RootStackParamList } from "./navigation/types";
import { registerGlobals as registerLiveKitGlobals } from '@livekit/react-native';
import { addNotificationListeners, ensureInitialNotificationPermissions, openIncomingCallScreen, openAnswerCallScreen, handleDeclineCallFromDeepLink, registerAndSendPushToken, clearCallRelatedNotificationsAndSyncBadge, syncAppBadgeFromMissedCount } from './utils/pushNotifications';
import { getInstallId } from './utils/installId';
import { ensureInitialMediaPermissions } from './utils/mediaPermissions';
import { setupCallKeep, launchIncomingCallActivityScreen, displayIncomingCall, isCallKeepAvailable, registerCallKeepEvents, reportAnswerIncomingCall, reportRejectCall, reportEndCallToCallKeep, setCallKeepAvailable, getPendingCallInfo, closeOutgoingCallActivity, bringMainActivityToFront, OUTGOING_CALL_TIMEOUT_MS, setOutgoingCallTimeoutMs } from './utils/callKeep';
import { useLang } from './store/lang';
import { t } from './utils/i18n';

// Импорт expo-keep-awake с безопасной загрузкой
let activateKeepAwakeAsync: (() => Promise<void>) | null = null;
let deactivateKeepAwakeAsync: (() => Promise<void>) | null = null;

try {
  const keepAwakeModule = require("expo-keep-awake");
  // КРИТИЧНО: Используем асинхронные версии (activateKeepAwakeAsync вместо activateKeepAwake)
  activateKeepAwakeAsync = keepAwakeModule.activateKeepAwakeAsync;
  deactivateKeepAwakeAsync = keepAwakeModule.deactivateKeepAwakeAsync;
  // Fallback: если async версии нет, пробуем синхронные (для обратной совместимости)
  if (!activateKeepAwakeAsync && keepAwakeModule.activateKeepAwake) {
    activateKeepAwakeAsync = async () => { keepAwakeModule.activateKeepAwake(); };
  }
  if (!deactivateKeepAwakeAsync && keepAwakeModule.deactivateKeepAwake) {
    deactivateKeepAwakeAsync = async () => { keepAwakeModule.deactivateKeepAwake(); };
  }
} catch (e) {
  logger.warn("expo-keep-awake module not available, using fallback", e);
  // Fallback функции если модуль недоступен
  activateKeepAwakeAsync = async () => {
    logger.debug("keep-awake activate (fallback - module not available)");
  };
  deactivateKeepAwakeAsync = async () => {
    logger.debug("keep-awake deactivate (fallback - module not available)");
  };
}

// Экспортируем функции для использования в других компонентах
export { activateKeepAwakeAsync, deactivateKeepAwakeAsync };

try { (React as any).useInsertionEffect = (React as any).useEffect; } catch {}

// Dev: hide extremely noisy warning that can spam logs on slower Android devices.
// This does NOT fix the root cause, but makes Metro logs usable while we iterate.
if (__DEV__) {
  try {
    LogBox.ignoreLogs([
      'Excessive number of pending callbacks',
    ]);
  } catch {}
}

// Регистрация глобальных LiveKit штук один раз при старте приложения
try {
  registerLiveKitGlobals();
} catch (e) {
  logger.warn('[App] Failed to register LiveKit globals', e);
}


const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();
// Экспортируем ссылку глобально для простого доступа из модулей без хука
// (безопасно: используется только для navigate на Home при разрыве вызова)
(global as any).__navRef = navRef;

// Звонки, для которых уже пришло call:ended по сокету. Не переходить на VideoCall по call:accepted для такого callId (избегаем мелькания и «произвольных» переходов).
const endedCallIdsFromSocket = new Set<string>();
const ENDED_CALL_IDS_TTL_MS = 120000;
function addEndedCallIdFromSocket(callId: string) {
  endedCallIdsFromSocket.add(callId);
  setTimeout(() => endedCallIdsFromSocket.delete(callId), ENDED_CALL_IDS_TTL_MS);
}

const isVideoSessionRoute = (routeName?: string | null) =>
  routeName === 'VideoCall' || routeName === 'RandomChat';

// КРИТИЧНО: Глобальная ссылка на состояние неактивности экрана видеозвонка/рандомчата
// Когда true - входящий звонок показывается в блоке собеседник, а не глобально
(global as any).__isInactiveStateRef = { current: false };

// КРИТИЧНО: Глобальная ссылка на функцию очистки звонка из VideoCall
// Это нужно чтобы можно было вызвать очистку даже когда экран звонка размонтирован (в PiP)
(global as any).__endCallCleanupRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на WebRTC session
// Это нужно чтобы можно было остановить стримы даже когда экран звонка размонтирован (в PiP)
(global as any).__webrtcSessionRef = { current: null as any };

// КРИТИЧНО: Глобальная ссылка на функцию переключения микрофона из VideoCall
// Это нужно чтобы можно было запустить startMicMeter даже когда экран звонка размонтирован (в PiP)
(global as any).__toggleMicRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на функцию переключения удаленного аудио из VideoCall
// Это нужно чтобы можно было переключать динамик даже когда экран звонка размонтирован (в PiP)
(global as any).__toggleRemoteAudioRef = { current: null as (() => void) | null };

function AppContent() {
  const { theme, isDark } = useAppTheme();
  const pip = usePiP();
  const lang = useLang((s) => s.lang);
  const hydrateLang = useLang((s) => s.hydrate);
  const insets = useSafeAreaInsets();
  /** Пока true — не скрываем оверлей. После обработки initial URL (в т.ч. answer-call) ставим true, чтобы не мелькала Home у принимающего. */
  const [initialUrlProcessed, setInitialUrlProcessed] = React.useState(false);

  React.useEffect(() => {
    void hydrateLang();
  }, [hydrateLang]);

  // Ref для различения в onEnd: мы принимающий (отклонили входящий) или звонящий (отменили исходящий)
  const incomingCallIdRef = React.useRef<string | null>(null);

  // CallKeep (нативный экран звонка на Android): selfManaged + задержка
  React.useEffect(() => {
    const t = setTimeout(() => void setupCallKeep(), 3000);
    return () => clearTimeout(t);
  }, []);

  // События от нативных экранов: инициатор нажал X на исходящем / получатель нажал X на входящем — очищаем состояние
  React.useEffect(() => {
    if (Platform.OS !== 'android') return () => {};
    const emitter = new NativeEventEmitter();
    const sub1 = emitter.addListener('OutgoingCallCanceledByUser', () => {
      (global as any).__outgoingCanceledByNativeRef = (global as any).__outgoingCanceledByNativeRef ?? { current: false };
      (global as any).__outgoingCanceledByNativeRef.current = true;
      try { emitCloseOutgoingCall(); } catch {}
    });
    const sub2 = emitter.addListener('IncomingCallDeclinedByUser', () => {
      incomingCallIdRef.current = null;
      setIncoming(null);
      try { setIncomingCallScreenVisible(false); } catch {}
      try { stopIncomingCallAlert(); } catch {}
      try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
    });
    const sub3 = emitter.addListener('LiviPendingCallAccepted', () => {
      const LiviAppModule = NativeModules.LiviAppModule;
      LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
        if (callId) {
          logger.info('[App] LiviPendingCallAccepted: requesting call:accepted', { callId });
          try { requestCallAccepted(callId); } catch {}
        }
      });
    });
    return () => {
      sub1.remove();
      sub2.remove();
      sub3.remove();
    };
  }, []);

  // События answer/end от нативного экрана звонка (Android) — регистрируем после возможного setup
  React.useEffect(() => {
    let unsub: (() => void) | undefined;
    const t = setTimeout(() => {
      unsub = registerCallKeepEvents({
        onAnswer: async (callId) => {
          const info = getPendingCallInfo(callId);
          if (!info || !navRef.isReady()) return;
          incomingCallIdRef.current = null;
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert();
          setIncoming(null);
          try {
            await ensureSocketConnected(5000);
            acceptCall(callId);
          } catch {}
          reportAnswerIncomingCall(callId);
          navRef.dispatch(
            CommonActions.reset({
              index: 1,
              routes: [
                { name: 'Home' as any },
                { name: 'VideoCall' as any, params: { peerUserId: info.from, directCall: true, directInitiator: false, callId, isIncoming: true } },
              ],
            })
          );
        },
        onEnd: (callId) => {
          const routeName = navRef.getCurrentRoute()?.name;
          if (routeName === 'VideoCall') {
            const endFn = (global as any).__endCallFromNativeRef?.current;
            if (typeof endFn === 'function') endFn(callId, null);
          } else {
            const isCallee = incomingCallIdRef.current === callId;
            if (isCallee) {
              // Принимающий нажал X на нативном экране — отклоняем входящий; сервер пошлёт call:declined звонящему
              incomingCallIdRef.current = null;
              try { declineCall(callId); } catch {}
              try { setIncomingCallScreenVisible(false); } catch {}
              stopIncomingCallAlert();
              setIncoming(null);
              try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
            } else {
              // Звонящий отменил с нативного экрана — отменяем исходящий и сразу закрываем модалку
              try { cancelCall(callId); } catch {}
              try { emitCloseOutgoingCall(); } catch {}
            }
          }
          incomingCallIdRef.current = null;
          reportEndCallToCallKeep(callId);
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert();
          setIncoming(null);
          reportRejectCall(callId);
          clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
        },
      });
    }, 4000);
    return () => {
      clearTimeout(t);
      unsub?.();
    };
  }, []);

  // Убрали постоянные логи для уменьшения шума
  const [routeName, setRouteName] = React.useState<string | undefined>(undefined);
  const lastLoggedRouteRef = React.useRef<string | undefined>(undefined);


  // ==== incoming call (global, когда не на экране видеозвонка) ====
  const [incoming, setIncoming] = React.useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  React.useEffect(() => {
    incomingCallIdRef.current = incoming?.callId ?? null;
  }, [incoming]);
  const bounce = React.useRef(new Animated.Value(0)).current;
  const wave1 = React.useRef(new Animated.Value(0)).current;
  const wave2 = React.useRef(new Animated.Value(0)).current;
  
  // Настройка навигационной панели на Android для edge-to-edge
  React.useEffect(() => {
    if (Platform.OS === 'android') {
      // ВНИМАНИЕ:
      // При включённом edge-to-edge expo-navigation-bar выводит WARN для setPositionAsync/setBackgroundColorAsync/setBorderColorAsync.
      // Мы переносим цвета в app.json (через плагин expo-navigation-bar), а в рантайме меняем только стиль кнопок.
      // Это убирает WARN и не ломает UI.
      NavigationBar.setButtonStyleAsync(isDark ? 'light' : 'dark').catch(() => {});
    }
  }, [isDark]);
  
  // КРИТИЧНО: Управление яркостью экрана при показе модального окна входящего вызова на Android
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    
    if (incoming) {
      // При показе модального окна входящего вызова
      try {
        // Активируем InCallManager для предотвращения падения яркости
        InCallManager.start({ media: 'video', ringback: '' });
        // Устанавливаем keep screen on для предотвращения затемнения
        (InCallManager as any).setKeepScreenOn?.(true);
        logger.debug('[App] InCallManager started for incoming call modal');
      } catch (e) {
        logger.warn('[App] Failed to start InCallManager for incoming call:', e);
      }
    } else {
      // При закрытии модального окна
      try {
        // Останавливаем InCallManager только если нет активного звонка
        // Проверяем через routeName - если мы не на экране видеозвонка, то можно остановить
        let currentRoute: string | undefined = undefined;
        if (navRef.isReady()) {
          currentRoute = navRef.getCurrentRoute()?.name;
        } else {
          // Fallback на routeName из state, если навигация еще не готова
          currentRoute = routeName;
        }
        // КРИТИЧНО: Если PiP видим, нельзя останавливать InCallManager — иначе пропадет звук в PiP.
        const pipVisible = !!(pip as any)?.visible || !!(global as any).__pipVisibleRef?.current;
        if (!isVideoSessionRoute(currentRoute) && !pipVisible) {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
          logger.debug('[App] InCallManager stopped after incoming call modal closed');
        }
      } catch (e) {
        logger.warn('[App] Failed to stop InCallManager:', e);
      }
    }
  }, [incoming, routeName]);

  // 🔔 Рингтон/вибрация для входящего звонка (когда показываем глобальную модалку)
  React.useEffect(() => {
    if (incoming) startIncomingCallAlert();
    else stopIncomingCallAlert();
    return () => {
      // На всякий случай при размонтировании
      stopIncomingCallAlert();
    };
  }, [incoming]);
  // Храним недавно отменённые/истёкшие вызовы, чтобы избежать гонок событий (declined/timeout перед incoming)
  const canceledCallsRef = React.useRef<Map<string, number>>(new Map());
  const timedOutCallsRef = React.useRef<Map<string, number>>(new Map());
  // Ref для хранения обработчика входящего звонка, чтобы он всегда был доступен
  const incomingCallHandlerRef = React.useRef<((d: { callId: string; from: string; fromNick?: string }) => void) | null>(null);


  const startAnim = React.useCallback(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, { toValue: 1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(bounce, { toValue: -1, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(bounce, { toValue: 0, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }),
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
    loop(wave1, 0); loop(wave2, 400);
  }, [bounce, wave1, wave2]);

  const stopAnim = React.useCallback(() => {
    bounce.stopAnimation(); wave1.stopAnimation(); wave2.stopAnimation();
  }, [bounce, wave1, wave2]);
  React.useEffect(() => {
    (async () => {
      try {
        // 🔊 Конфиг аудио
        await Audio.setAudioModeAsync({
          playsInSilentModeIOS: true,
          // Default app-wide mode: playback (not recording). Recording-enabled modes can route audio to the receiver on iOS.
          allowsRecordingIOS: false,
          // IMPORTANT: do not keep audio session alive in background to avoid battery drain.
          staysActiveInBackground: false,
          shouldDuckAndroid: false,
          // IMPORTANT: do not force earpiece output. Let OS route (speaker / wired / BT) for consistent loud playback.
          playThroughEarpieceAndroid: false,
        });
      } catch (e) {
        logger.warn("Audio setAudioModeAsync failed:", e);
      }

      try {
        // ✅ Инициализация CometChat (один раз на старте)
        await ensureCometChatReady();
      } catch (e) {
        logger.error("CometChat init failed:", e);
      }

      // 🔔 Запрашиваем разрешение на уведомления сразу при старте (Android 13+ / iOS),
      // чтобы пользователь увидел системный диалог до любых фоновых токен-регистраций.
      try {
        await ensureInitialNotificationPermissions();
      } catch {}

      // 🎥🎙️ Запрашиваем разрешения камеры/микрофона на старте.
      // На части Android 8.x (в т.ч. ColorOS) это снижает шанс "тихого" фейла WebRTC захвата.
      try {
        await ensureInitialMediaPermissions();
      } catch {}

    })();
  }, []);

  // 🔔 Push notifications: register token once we have userId
  React.useEffect(() => {
    let cancelled = false;
    let cleanupListeners: null | (() => void) = null;

    (async () => {
      try {
        cleanupListeners = addNotificationListeners();
      } catch {}

      // ждём userId (boot() в sockets/socket.ts асинхронный)
      for (let i = 0; i < 12 && !cancelled; i++) {
        try {
          const uid = getCurrentUserId?.();
          if (uid) {
            await registerAndSendPushToken(uid);
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();

    return () => {
      cancelled = true;
      try { cleanupListeners?.(); } catch {}
    };
  }, []);

  // Android: при старте приложения применить пропущенные, показанные из нативного кода (FCM call_ended), чтобы бейдж совпадал с числом уведомлений в шторке
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const LiviAppModule = NativeModules.LiviAppModule;
    LiviAppModule?.getAndClearPendingMissedCalls?.()?.then?.((arr: string[]) => {
      if (arr?.length) {
        (async () => {
          try {
            const key = 'missed_calls_by_user_v1';
            const raw = await AsyncStorage.getItem(key);
            const map = raw ? JSON.parse(raw) : {};
            for (const uid of arr) {
              if (uid) {
                map[uid] = (map[uid] || 0) + 1;
                try { emitMissedIncrement(uid); } catch {}
              }
            }
            await AsyncStorage.setItem(key, JSON.stringify(map));
            await syncAppBadgeFromMissedCount();
          } catch (e) {
            logger.warn('[App] getAndClearPendingMissedCalls on mount failed', e);
          }
        })();
      }
    });
  }, []);

  // ===== Deep Linking: звонки livi://incoming-call | livi://answer-call | livi://decline-call =====
  const handleIncomingCallDeepLink = async (url: string) => {
    try {
      const m = url.match(/livi:\/\/incoming-call[?]?(.*)/i);
      if (!m) return;
      const search = m[1] || '';
      const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
      const callId = params.get('callId') || params.get('call_id') || '';
      const from = params.get('from') || params.get('userId') || '';
      const fromNick = params.get('fromNick') ?? '';
      if (callId && from) {
        logger.info('[App] Incoming call deep link: showing native IncomingCallActivity', { callId, from });
        if (Platform.OS === 'android') {
          await setupCallKeep();
          launchIncomingCallActivityScreen(callId, from, fromNick);
        } else {
          await openIncomingCallScreen(from, callId);
        }
      }
    } catch (e) {
      logger.warn('[App] handleIncomingCallDeepLink failed', e);
    }
  };

  const handleCallDeepLink = async (url: string) => {
    try {
      if (/livi:\/\/answer-call/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        const from = params.get('from') || params.get('userId') || '';
        if (callId && from) {
          logger.info('[App] answer-call deep link: opening call', { callId, from });
          await openAnswerCallScreen(from, callId);
          return true;
        }
      }
      if (/livi:\/\/decline-call/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        if (callId) {
          logger.info('[App] decline-call deep link', { callId });
          await handleDeclineCallFromDeepLink(callId);
          return true;
        }
      }
      if (/livi:\/\/cancel-outgoing/i.test(url)) {
        const params = new URLSearchParams(url.replace(/^[^?]*\?/, ''));
        const callId = params.get('callId') || params.get('call_id') || '';
        if (callId) {
          logger.info('[App] cancel-outgoing deep link', { callId });
          try { cancelCall(callId); } catch {}
          setTimeout(() => { try { cancelCall(callId); } catch {} }, 150);
          try { reportEndCallToCallKeep(callId); } catch {}
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { emitCloseOutgoingCall(); } catch {}
          try { closeOutgoingCallActivity(); } catch {}
          return true;
        }
      }
    } catch (e) {
      logger.warn('[App] handleCallDeepLink failed', e);
    }
    return false;
  };

  // Глобальный обработчик для deep link livi:// (decline-call, answer-call, incoming-call): expo-dev-launcher в dev перехватывает ссылки и показывает модалку — патч вызывает этот ref и не показывает модалку, чтобы отмена/принятие звонка сработали
  const handleCallDeepLinkRef = React.useRef<(url: string) => Promise<boolean>>(async () => false);
  handleCallDeepLinkRef.current = handleCallDeepLink;
  React.useEffect(() => {
    (global as any).__handleCallDeepLinkRef = handleCallDeepLinkRef;
    return () => {
      delete (global as any).__handleCallDeepLinkRef;
    };
  }, []);

  // Сохраняем installId, serverUrl и таймаут исходящего в натив (отклонение по HTTP, LiviOutgoingCallService)
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const LiviAppModule = NativeModules.LiviAppModule;
    if (!LiviAppModule?.setInstallIdForDecline || !LiviAppModule?.setServerUrlForDecline) return;
    (async () => {
      try {
        const [installId, url] = await Promise.all([getInstallId(), Promise.resolve(API_BASE)]);
        if (installId) LiviAppModule.setInstallIdForDecline(installId);
        if (url) LiviAppModule.setServerUrlForDecline(url);
        setOutgoingCallTimeoutMs(OUTGOING_CALL_TIMEOUT_MS);
      } catch {}
    })();
  }, []);

  // ===== Deep Linking обработка для реферальных ссылок =====
  const INVITE_LINK_KEY = 'pending_invite_code';
  React.useEffect(() => {
    const handleInitialUrl = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          const handled = await handleCallDeepLink(initialUrl);
          if (!handled) {
            await handleIncomingCallDeepLink(initialUrl);
            if (!initialUrl.includes('expo-development-client') && !/^exp\+livi-video-chat:\/\//i.test(initialUrl)) {
              handleInviteLink(initialUrl);
            }
          }
        }
      } catch (e) {
        logger.warn('Failed to get initial URL:', e);
      } finally {
        setInitialUrlProcessed(true);
      }
    };

    const handleUrl = async (event: { url: string }) => {
      const handled = await handleCallDeepLink(event.url);
      if (!handled) {
        await handleIncomingCallDeepLink(event.url);
        if (!event.url.includes('expo-development-client') && !/^exp\+livi-video-chat:\/\//i.test(event.url)) {
          handleInviteLink(event.url);
        }
      }
    };

    const subscription = Linking.addEventListener('url', handleUrl);
    
    // Проверяем начальную ссылку
    handleInitialUrl();

    // Проверяем сохраненный код приглашения при старте (с небольшой задержкой для готовности навигации)
    setTimeout(() => {
      checkPendingInvite();
    }, 1000);

    return () => {
      subscription.remove();
    };
  }, []);

  // Функция обработки реферальной ссылки
  const handleInviteLink = async (url: string) => {
    try {
      if (url.includes('expo-development-client') || /^exp\+livi-video-chat:\/\//i.test(url)) {
        return;
      }
      logger.debug('[App] Processing invite link:', url);

      // Парсим URL: 
      // - livi://invite/{code} (custom scheme для тестирования)
      // - https://livi.app/invite/{code} (Universal Links для продакшена)
      // - http://livi.app/invite/{code} (fallback)
      let inviteMatch = url.match(/livi:\/\/invite\/([a-f\d]{24})/i);
      if (!inviteMatch) {
        inviteMatch = url.match(/\/invite\/([a-f\d]{24})/i);
      }
      
      if (!inviteMatch) {
        logger.debug('[App] URL does not match invite pattern');
        return;
      }

      const code = inviteMatch[1];
      logger.info('[App] Extracted invite code:', code);

      const userId = getCurrentUserId();
      
      if (!userId) {
        // Пользователь не авторизован - сохраняем код для обработки после авторизации
        await AsyncStorage.setItem(INVITE_LINK_KEY, code);
        logger.info('[App] User not authorized, saved invite code for later');
        return;
      }

      // Пользователь авторизован - обрабатываем сразу
      await processInviteCode(code);
    } catch (e) {
      logger.error('[App] Error handling invite link:', e);
    }
  };

  // Функция обработки кода приглашения
  const processInviteCode = async (code: string) => {
    try {
      const userId = getCurrentUserId();
      if (!userId) {
        logger.warn('[App] Cannot process invite: user not authorized');
        return;
      }

      // Проверяем ссылку через API
      const result = await checkInviteLink(code);
      
      if (!result.ok) {
        logger.warn('[App] Invalid invite link:', result.error);
        return;
      }

      if (result.areFriends) {
        // Пользователи уже друзья - показываем сообщение
        logger.info('[App] Users are already friends');
        // Можно показать toast или модалку
        return;
      }

      if (result.hasPendingRequest) {
        // Заявка уже отправлена
        logger.info('[App] Friend request already pending');
        return;
      }

      if (result.canAdd && result.inviter) {
        // Можно добавить в друзья - сохраняем информацию для показа модалки
        await AsyncStorage.setItem(INVITE_LINK_KEY, JSON.stringify({
          code,
          inviter: result.inviter,
          timestamp: Date.now(),
        }));
        
        // КРИТИЧНО: Навигация на Home с параметром для показа модалки
        // Используем reset для гарантированного открытия HomeScreen
        if (navRef.isReady()) {
          const currentRoute = navRef.getCurrentRoute()?.name;
          
          // Если уже на Home, просто обновляем параметры
          if (currentRoute === 'Home') {
            navRef.dispatch(
              CommonActions.setParams({
                showInviteModal: true,
                inviteCode: code,
              })
            );
          } else {
            // Если на другом экране - сбрасываем навигацию на Home
            navRef.dispatch(
              CommonActions.reset({
                index: 0,
                routes: [
                  {
                    name: 'Home',
                    params: { showInviteModal: true, inviteCode: code },
                  },
                ],
              })
            );
          }
        } else {
          // Если навигация еще не готова - сохраняем для обработки позже
          logger.info('[App] Navigation not ready, will process invite when ready');
        }
      }
    } catch (e) {
      logger.error('[App] Error processing invite code:', e);
    }
  };

  // Проверка сохраненного кода приглашения
  const checkPendingInvite = async () => {
    try {
      const userId = getCurrentUserId();
      if (!userId) return;

      const saved = await AsyncStorage.getItem(INVITE_LINK_KEY);
      if (!saved) return;

      // Пытаемся распарсить как JSON (новый формат) или как строку (старый формат)
      let code: string;
      try {
        const parsed = JSON.parse(saved);
        code = parsed.code || saved;
      } catch {
        code = saved;
      }

      await processInviteCode(code);
      // Удаляем после обработки
      await AsyncStorage.removeItem(INVITE_LINK_KEY);
    } catch (e) {
      logger.error('[App] Error checking pending invite:', e);
    }
  };

  // КРИТИЧНО: Поддержание экрана включенным ТОЛЬКО когда это нужно (звонок/рандомчат/входящий/PiP).
  // Глобальный агрессивный InCallManager.start на некоторых Android может приводить к сворачиванию/крашам.
  React.useEffect(() => {
    // Проверяем что модуль доступен
    if (!activateKeepAwakeAsync || !deactivateKeepAwakeAsync) {
      logger.warn('Keep-awake module not available, skipping initialization');
      return;
    }

    // Нужно ли держать экран включённым именно сейчас
    let currentRoute: string | undefined = undefined;
    try {
      currentRoute = navRef.isReady() ? navRef.getCurrentRoute()?.name : routeName;
    } catch {
      currentRoute = routeName;
    }
    const pipVisible = !!(pip as any)?.visible || !!(global as any).__pipVisibleRef?.current;
    const shouldKeepOn = isVideoSessionRoute(currentRoute) || !!incoming || pipVisible;

    let appStateSubscription: any = null;
    let keepAwakeInterval: ReturnType<typeof setInterval> | null = null;
    let androidKeepScreenOnInterval: ReturnType<typeof setInterval> | null = null;
    
    const activateKeepAwake = () => {
      if (activateKeepAwakeAsync) {
        activateKeepAwakeAsync().catch((e) => {
          logger.warn('Failed to activate keep-awake:', e);
        });
      }
    };
    
    const activateAndroidKeepScreenOn = () => {
      if (Platform.OS === 'android') {
        try {
          // Убеждаемся что InCallManager запущен
          InCallManager.start({ media: 'video', ringback: '' });
          // Устанавливаем keep screen on
          (InCallManager as any).setKeepScreenOn?.(true);
          // Также активируем expo-keep-awake для Android (дополнительная защита)
          if (activateKeepAwakeAsync) {
            activateKeepAwakeAsync().catch((e) => {
              logger.warn('[App] Failed to activate keep-awake for Android:', e);
            });
          }
          logger.debug('[App] setKeepScreenOn(true) and keep-awake reactivated for Android');
        } catch (e) {
          logger.warn('[App] Failed to reactivate setKeepScreenOn on Android:', e);
        }
      }
    };
    
    const handleAppStateChange = (nextAppState: string) => {
      if (!shouldKeepOn) return;
      if (nextAppState === 'active' || nextAppState === 'inactive') {
        // КРИТИЧНО: Приложение активно или неактивно (но видно) - ВСЕГДА активируем keep-awake
        // 'inactive' на iOS означает, что приложение видно, но не полностью активно
        // (например, показывается Control Center или уведомление)
        // НЕ ДОЛЖНО ЗАКРЫВАТЬСЯ пока пользователь в приложении
        activateKeepAwake();
        
        // КРИТИЧНО: Для Android ВСЕГДА используем InCallManager для предотвращения засыпания экрана
        if (Platform.OS === 'android') {
          activateAndroidKeepScreenOn();
          
          // Запускаем периодическую переактивацию для Android (каждые 3 секунды)
          // чтобы предотвратить затемнение экрана системой
          if (!androidKeepScreenOnInterval) {
            androidKeepScreenOnInterval = setInterval(() => {
              if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
                activateAndroidKeepScreenOn();
              }
            }, 3000); // Переактивируем каждые 3 секунды для Android (максимально агрессивная защита)
          }
        }
      } else if (nextAppState === 'background') {
        // Приложение ушло в фон - деактивируем для экономии батареи
        if (keepAwakeInterval) {
          clearInterval(keepAwakeInterval);
          keepAwakeInterval = null;
        }
        if (androidKeepScreenOnInterval) {
          clearInterval(androidKeepScreenOnInterval);
          androidKeepScreenOnInterval = null;
        }
        if (deactivateKeepAwakeAsync) {
          deactivateKeepAwakeAsync().catch((e) => {
            logger.warn('Failed to deactivate keep-awake:', e);
          });
          logger.debug('Keep-awake deactivated (app background)');
        }
        // Для Android деактивируем setKeepScreenOn
        if (Platform.OS === 'android') {
          try {
            (InCallManager as any).setKeepScreenOn?.(false);
            InCallManager.stop();
            logger.debug('[App] setKeepScreenOn(false) deactivated for Android');
          } catch (e) {
            logger.warn('[App] Failed to setKeepScreenOn(false) on Android:', e);
          }
        }
      }
    };

    // Если не на экранах звонка/нет входящего/PiP — ничего не держим включённым.
    if (!shouldKeepOn) {
      try {
        deactivateKeepAwakeAsync?.().catch(() => {});
      } catch {}
      if (Platform.OS === 'android') {
        try {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
        } catch {}
      }
      return;
    }

    // Активируем сразу при монтировании если приложение активно или неактивно
    const currentState = AppState.currentState;
    
    if (currentState === 'active' || currentState === 'inactive') {
      activateKeepAwake();
      
      // Для Android включаем keep-screen-on только в call-like режиме
      if (Platform.OS === 'android') {
        activateAndroidKeepScreenOn();
        
        // Запускаем периодическую переактивацию реже, чтобы не спамить нативные вызовы
        androidKeepScreenOnInterval = setInterval(() => {
          if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
            activateAndroidKeepScreenOn();
          }
        }, 8000);
      }
    }

    // Отслеживаем изменения AppState
    appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      // Останавливаем интервалы
      if (keepAwakeInterval) {
        clearInterval(keepAwakeInterval);
        keepAwakeInterval = null;
      }
      if (androidKeepScreenOnInterval) {
        clearInterval(androidKeepScreenOnInterval);
        androidKeepScreenOnInterval = null;
      }
      // Деактивируем при unmount
      if (deactivateKeepAwakeAsync) {
        deactivateKeepAwakeAsync().catch((e) => {
          logger.warn('Failed to deactivate keep-awake on unmount:', e);
        });
        logger.debug('Keep-awake deactivated (unmount)');
      }
      // Для Android деактивируем setKeepScreenOn при unmount
      if (Platform.OS === 'android') {
        try {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
          logger.debug('[App] setKeepScreenOn(false) deactivated for Android (unmount)');
        } catch (e) {
          logger.warn('[App] Failed to setKeepScreenOn(false) on Android (unmount):', e);
        }
      }
      if (appStateSubscription) {
        appStateSubscription.remove();
      }
    };
  }, [routeName, incoming, (pip as any)?.visible]); // пересчитываем need-to-keep-on по состоянию приложения

  // КРИТИЧНО: Убрана глобальная обработка блокировки экрана из App.tsx
  // Логика завершения звонков при блокировке экрана теперь полностью обрабатывается в VideoCall.tsx
  // VideoCall.tsx правильно различает звонки друзьям (не завершаются) и рандомные чаты (завершаются)
  // Это предотвращает конфликты и дублирование логики

  // КРИТИЧНО: Обработчик входящего звонка - должен быть всегда зарегистрирован
  // Используем useRef для хранения функции, чтобы она не пересоздавалась
  const INCOMING_CALL_DEBOUNCE_MS = 3000;
  const lastProcessedIncomingRef = React.useRef<{ callId: string; at: number } | null>(null);

  const handleIncomingCall = React.useCallback((d: { callId: string; from: string; fromNick?: string }) => {
    const callId = String(d?.callId ?? '');
    const now = Date.now();
    const last = lastProcessedIncomingRef.current;
    if (callId && last?.callId === callId && now - last.at < INCOMING_CALL_DEBOUNCE_MS) {
      logger.debug('[call:incoming] debounced duplicate', { callId });
      return;
    }
    lastProcessedIncomingRef.current = callId ? { callId, at: now } : null;
    logger.debug('[call:incoming] received', { callId: d.callId, from: d.from, fromNick: d.fromNick });

    // КРИТИЧНО: Используем актуальное значение навигации напрямую, а не routeName (который обновляется асинхронно)
    // Fallback: если навигация не готова, разрешаем показать модалку (лучше показать, чем пропустить)
    let currentRoute: string | undefined = undefined;
    try {
      if (navRef.isReady()) {
        currentRoute = navRef.getCurrentRoute()?.name;
      } else {
        currentRoute = routeName;
      }
    } catch (e) {
      // Если навигация еще не готова - разрешаем показать модалку
      logger.debug('Navigation not ready, allowing modal show', { routeName });
      currentRoute = routeName;
    }
    
    // Защита от гонки: если для этого callId уже пришёл cancel/timeout, игнорируем входящий
    try {
      const id = String((d as any)?.callId || '');
      if (id) {
        const now = Date.now();
        // ленивое очищение старых записей (>10с)
        for (const [k, ts] of canceledCallsRef.current) if (now - ts > 10000) canceledCallsRef.current.delete(k);
        for (const [k, ts] of timedOutCallsRef.current) if (now - ts > 10000) timedOutCallsRef.current.delete(k);
        if (canceledCallsRef.current.has(id) || timedOutCallsRef.current.has(id)) {
          logger.debug('Ignoring incoming call - already canceled/timed out', { callId: id });
          return;
        }
      }
    } catch {}

    // На экране видеозвонка с активным звонком — входящий от того же собеседника игнорируем (дубликат после отмены на нативном экране у звонящего)
    const isOnVideoScreen = isVideoSessionRoute(currentRoute);
    const isInactiveVideoState = !!(global as any)?.__isInactiveStateRef?.current;
    const videoCallPartner = (global as any)?.__videoCallPartnerUserIdRef?.current;
    const videoCallActive = (global as any)?.__videoCallActiveRef?.current;
    if (isOnVideoScreen && !isInactiveVideoState && videoCallActive && videoCallPartner && String(d.from) === String(videoCallPartner)) {
      logger.debug('[call:incoming] Ignoring incoming from current partner (active VideoCall)', { callId: d.callId, from: d.from });
      return;
    }

    // КРИТИЧНО: Показываем глобальную модалку если:
    // 1) НЕ на экране видеозвонка/рандомчата, ИЛИ
    // 2) Навигация не готова (безопаснее показать), ИЛИ
    // 3) Мы на VideoCall/RandomChat, но видеосессия УЖЕ завершена (неактивное состояние) —
    //    тогда модалка должна быть как у "неактивного видеочата": во весь экран.
    const shouldShowGlobal =
      !isOnVideoScreen ||
      !currentRoute ||
      (isOnVideoScreen && isInactiveVideoState);

    if (shouldShowGlobal) {
      logger.debug('Incoming call — показываем нативный IncomingCallActivity', { callId: d.callId, from: d.from, fromNick: d.fromNick, currentRoute });
      incomingCallIdRef.current = d.callId;
      try { Keyboard.dismiss(); } catch {}
      // Единый UI: нативный IncomingCallActivity (foreground — из сокета; background — из FCM full-screen)
      if (Platform.OS === 'android') {
        launchIncomingCallActivityScreen(d.callId, d.from, d.fromNick ?? '');
      } else if (isCallKeepAvailable()) {
        displayIncomingCall(d.callId, d.from, d.fromNick ?? '', true);
      }
      try { AsyncStorage.setItem('last_incoming_from', String(d.from || '')); } catch {}
    } else {
      logger.debug('Skipping global modal - on video/random screen, will show in peer block', { callId: d.callId, from: d.from, currentRoute });
    }
  }, [routeName]);

  // Сохраняем обработчик в ref для использования в fallback и для пуша
  incomingCallHandlerRef.current = handleIncomingCall;
  (global as any).__setIncomingCallFromPush = (data: any) => {
    if (data?.callId && data?.from && incomingCallHandlerRef.current) {
      incomingCallHandlerRef.current({ callId: String(data.callId), from: String(data.from), fromNick: data?.fromNick ?? '' });
    }
  };

  // КРИТИЧНО: Общий прямой обработчик для перерегистрации при переподключении
  // Используем одну функцию для всех случаев чтобы избежать конфликтов
  const sharedDirectHandlerRef = React.useRef<((d: any) => void) | null>(null);

  React.useEffect(() => {
    // Закрытие по внешнему запросу (например, из ChatScreen)
    const offReq = onRequestCloseIncoming?.(() => { try { setIncomingCallScreenVisible(false); } catch {} stopIncomingCallAlert(); setIncoming(null); stopAnim(); });
    const offClose = onCloseIncoming?.(() => { try { setIncomingCallScreenVisible(false); } catch {} stopIncomingCallAlert(); setIncoming(null); stopAnim(); });
    
    // Регистрируем через обертку (основной способ)
    // УБРАНО: Дублирующий прямой слушатель - он регистрируется в отдельном useEffect для переподключения
    const off = onCallIncoming?.(handleIncomingCall);
    
    return () => { 
      off?.(); 
      offReq?.(); 
      offClose?.();
    };
  }, [handleIncomingCall, stopAnim]);

  // КРИТИЧНО: Перерегистрация обработчика при переподключении socket
  // Это гарантирует что обработчик всегда работает после пробуждения телефона
  React.useEffect(() => {
    // Создаем общий обработчик
    const directHandler = (d: any) => {
      // Используем обработчик из ref чтобы всегда был актуальный
      if (incomingCallHandlerRef.current) {
        incomingCallHandlerRef.current(d);
      }
    };
    sharedDirectHandlerRef.current = directHandler;

    const registerHandler = () => {
      try {
        // Убираем старый если есть (защита от дублирования)
        if (sharedDirectHandlerRef.current) {
          socket.off('call:incoming', sharedDirectHandlerRef.current);
        }
        socket.on('call:incoming', directHandler);
        logger.info('[call:incoming] socket handler registered');
      } catch (e) {
        logger.warn('Failed to register call:incoming handler:', e);
      }
    };

    const onConnect = () => {
      logger.debug('Socket connected/reconnected - ensuring call:incoming handler is registered');
      // Небольшая задержка чтобы socket точно был готов и reauth завершился
      setTimeout(() => {
        registerHandler();
      }, 200);
      // FCM call_accepted вывел приложение — запросить call:accepted (инициатор перейдёт на VideoCall). Fallback: ref от HomeScreen, если нативный pending не сработал.
      if (Platform.OS === 'android') {
        setTimeout(() => {
          const LiviAppModule = NativeModules.LiviAppModule;
          LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
            if (callId) {
              logger.info('[App] Socket connected with pending call_accepted, requesting call:accepted', { callId });
              try { requestCallAccepted(callId); } catch {}
              return;
            }
            const refCallId = (global as any).__outgoingCallIdRef?.current;
            if (refCallId) {
              logger.info('[App] Socket connected with outgoing callId ref (FCM fallback), requesting call:accepted', { callId: refCallId });
              (global as any).__outgoingCallIdRef.current = null;
              try { requestCallAccepted(refCallId); } catch {}
            }
          });
        }, 400);
      }
      // После reauth перерегистрируем push-токен, чтобы backend получал его (важно для dev и после выхода из фона)
      setTimeout(() => {
        const uid = getCurrentUserId?.();
        if (uid) registerAndSendPushToken(uid);
      }, 2500);
    };

    // Регистрируем сразу при монтировании
    registerHandler();
    
    socket.on('connect', onConnect);
    socket.on('reconnect', onConnect);
    
    return () => {
      socket.off('connect', onConnect);
      socket.off('reconnect', onConnect);
      if (sharedDirectHandlerRef.current) {
        try {
          socket.off('call:incoming', sharedDirectHandlerRef.current);
        } catch {}
      }
    };
  }, []);

  // При получении call:ended (второй участник завершил с нативного экрана/уведомления) — закрываем модалки, reportEndCallToCallKeep, уведомления у обоих
  React.useEffect(() => {
    const onCallEnded = (data?: { callId?: string }) => {
      if (data?.callId) {
        addEndedCallIdFromSocket(data.callId);
        try { reportEndCallToCallKeep(data.callId); } catch {}
      }
      stopIncomingCallAlert();
      setIncoming(null);
      stopAnim();
      try { emitCloseOutgoingCall(); } catch {}
      try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
    };
    socket.on('call:ended', onCallEnded);
    return () => { socket.off('call:ended', onCallEnded); };
  }, [stopAnim]);

  // Тап по уведомлению «звонок завершён» (другой положил трубку) — уйти с экрана видеозвонка и снять уведомления
  React.useEffect(() => {
    (global as any).__onCallEndedFromPush = () => {
      if (navRef.isReady() && navRef.getCurrentRoute()?.name === 'VideoCall') {
        navRef.dispatch(CommonActions.navigate('Home'));
      }
      clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
    };
    return () => { delete (global as any).__onCallEndedFromPush; };
  }, []);

  // При старте приложения (в т.ч. по FCM call_accepted) — запросить call:accepted, если нативный модуль сохранил callId
  React.useEffect(() => {
    if (Platform.OS !== 'android') return;
    const t = setTimeout(() => {
      const LiviAppModule = NativeModules.LiviAppModule;
      LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
        if (callId) {
          logger.info('[App] Launch with pending call_accepted, requesting call:accepted', { callId });
          try { requestCallAccepted(callId); } catch {}
        }
      });
    }, 500);
    return () => clearTimeout(t);
  }, []);

  // КРИТИЧНО: Перерегистрация обработчика при возврате из спящего режима (AppState change)
  React.useEffect(() => {
    const { AppState } = require('react-native');
    let appStateRef = AppState.currentState;

    const handleAppStateChange = (nextAppState: string) => {
      if (appStateRef.match(/inactive|background/) && nextAppState === 'active') {
        // Если пользователь нажал X на нативном экране исходящего — событие могло не дойти до JS; при возврате в приложение очищаем состояние
        const canceledByNative = (global as any).__outgoingCanceledByNativeRef?.current === true;
        if (canceledByNative) {
          (global as any).__outgoingCanceledByNativeRef.current = false;
          try { emitCloseOutgoingCall(); } catch {}
        }
        if (Platform.OS === 'android') {
          const LiviAppModule = NativeModules.LiviAppModule;
          LiviAppModule?.getAndClearOutgoingCanceledByUserFlag?.()?.then?.((flag: boolean) => {
            if (flag) try { emitCloseOutgoingCall(); } catch {}
          });
          // FCM call_accepted вывел приложение — запросить call:accepted у сервера → переход на VideoCall
          LiviAppModule?.getAndClearPendingCallAcceptedCallId?.()?.then?.((callId: string | null) => {
            if (callId) {
              logger.info('[App] Pending call_accepted from FCM, requesting call:accepted', { callId });
              try { requestCallAccepted(callId); } catch {}
            }
          });
          // Пропущенные, показанные из нативного кода (FCM call_ended) — обновить счётчик и бейдж
          LiviAppModule?.getAndClearPendingMissedCalls?.()?.then?.((arr: string[]) => {
            if (arr?.length) {
              (async () => {
                try {
                  const key = 'missed_calls_by_user_v1';
                  const raw = await AsyncStorage.getItem(key);
                  const map = raw ? JSON.parse(raw) : {};
                  for (const uid of arr) {
                    if (uid) {
                      map[uid] = (map[uid] || 0) + 1;
                      try { emitMissedIncrement(uid); } catch {}
                    }
                  }
                  await AsyncStorage.setItem(key, JSON.stringify(map));
                  await syncAppBadgeFromMissedCount();
                } catch (e) {
                  logger.warn('[App] getAndClearPendingMissedCalls apply failed', e);
                }
              })();
            }
          });
        }
        // Приложение вернулось из спящего режима - перерегистрируем обработчик
        logger.debug('App returned from sleep - re-registering call:incoming handler');
        setTimeout(() => {
          try {
            if (sharedDirectHandlerRef.current) {
              socket.off('call:incoming', sharedDirectHandlerRef.current);
              socket.on('call:incoming', sharedDirectHandlerRef.current);
              logger.debug('Re-registered call:incoming handler after app resume');
            }
          } catch (e) {
            logger.warn('Failed to re-register call:incoming handler after app resume:', e);
          }
        }, 300); // Задержка для завершения reauth и присоединения к комнате
      }
      appStateRef = nextAppState;
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      subscription.remove();
    };
  }, []);

  // Android nav bar: управление перенесено на конкретные экраны (Home/Chat/Video)

  // УБРАНО: Дублирующий обработчик onCallTimeout - он уже зарегистрирован в общем useEffect ниже
  // вместе с onCallDeclined, onCallCanceled, onCallAccepted

  // УБРАНО: Резервные сырые слушатели - они дублируют обработчики через обертки
  // Все события обрабатываются через onCallDeclined, onCallTimeout, onCallCanceled, onCallAccepted
  // которые уже зарегистрированы в useEffect выше

  // Закрываем входящую модалку, если звонящий отменил вызов
  React.useEffect(() => {
    const offDecl = onCallDeclined?.((d) => {
      logger.debug('Call declined received', { callId: d?.callId });
      incomingCallIdRef.current = null;
      if (d?.callId) try { reportEndCallToCallKeep(d.callId); } catch {}
      stopIncomingCallAlert();
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { emitCloseOutgoingCall(); } catch {}
      try { closeOutgoingCallActivity(); } catch {}
      // call:declined = тот, кому звонили, отклонил — пропущенным не считаем, счётчик не увеличиваем
    });
    const offCancel = onCallCanceled?.(async (d) => {
      logger.debug('Call canceled received', { callId: d?.callId });
      incomingCallIdRef.current = null;
      if ((d as any)?.callId) try { reportEndCallToCallKeep((d as any).callId); } catch {}
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      // КРИТИЧНО: Обновляем canceledCallsRef для защиты от гонки событий
      try {
        const id = String((d as any)?.callId || '');
        if (id) canceledCallsRef.current.set(id, Date.now());
      } catch {}
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); emitCloseOutgoingCall(); } catch {}
      // Никакой навигации — остаёмся на текущем экране
      // Инкремент пропущенного только у получателя (callee), не у инициатора
      try {
        const uid = await AsyncStorage.getItem('last_incoming_from');
        const callerId = String((d as any)?.from || '');
        if (uid && callerId && uid === callerId) {
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[uid] = (map[uid] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(uid); } catch {}
          syncAppBadgeFromMissedCount().catch(() => {});
          try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
        }
      } catch {}
    });
    // Если пришло accepted (ответили), синхронно открываем VideoCall у обоих
    const onAccepted = onCallAccepted?.((data) => {
      logger.info('[App] 📥 call:accepted received in App.tsx', {
        callId: data?.callId,
        from: data?.from,
        currentRoute: navRef.getCurrentRoute()?.name,
      });
      const callId = data?.callId ? String(data.callId) : '';
      // Не переходить на VideoCall, если по сокету уже пришло call:ended (звонок уже завершён) — избегаем мелькания и лишних сессий
      if (callId && endedCallIdsFromSocket.has(callId)) {
        logger.info('[App] ⏭️ call:accepted ignored (call already ended)', { callId });
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall(); } catch {}
        try { closeOutgoingCallActivity(); } catch {}
        if ((global as any).__pendingCallAcceptedRef) (global as any).__pendingCallAcceptedRef.current = null;
        stopIncomingCallAlert();
        setIncoming(null);
        stopAnim();
        try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
        clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
        return;
      }
      // КРИТИЧНО: Сохраняем событие call:accepted в глобальный ref на случай, если VideoCallSession еще не создан
      // Это решает проблему, когда call:accepted приходит до того, как VideoCallSession создан
      if (!(global as any).__pendingCallAcceptedRef) {
        (global as any).__pendingCallAcceptedRef = { current: null };
      }
      (global as any).__pendingCallAcceptedRef.current = data;
      logger.info('[App] 💾 Saved call:accepted event to global ref', {
        callId: data?.callId,
        hasLivekitToken: !!(data as any)?.livekitToken,
        hasLivekitRoomName: !!(data as any)?.livekitRoomName,
      });
      
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      setIncoming(null);
      stopAnim();
      try {
        const currentRoute = navRef.getCurrentRoute();
        if (navRef.isReady() && currentRoute?.name !== 'VideoCall') {
          const fromUserId = (data as any)?.fromUserId ?? (data as any)?.from;
          const myUserId = getCurrentUserId();
          const isCaller = myUserId && fromUserId && myUserId !== fromUserId;
          // Caller: we initiated, the other accepted → directInitiator: true, peerUserId = callee (who accepted).
          // Callee: we accepted → we're already on VideoCall (navigated on Accept tap); skip or rare edge case.
          const params = isCaller
            ? { directCall: true, directInitiator: true, callId: (data as any)?.callId, peerUserId: fromUserId }
            : { directCall: true, directInitiator: false, callId: (data as any)?.callId, isIncoming: true, peerUserId: fromUserId ?? undefined };
          logger.info('[App] 🚀 Navigating to VideoCall screen', {
            callId: data?.callId,
            peerUserId: fromUserId,
            isCaller,
          });
          const doNavigate = () => {
            try {
              if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'VideoCall') {
                navRef.dispatch(
                  CommonActions.reset({
                    index: 1,
                    routes: [
                      { name: 'Home' as any },
                      { name: 'VideoCall' as any, params },
                    ],
                  })
                );
              }
            } catch (err) {
              logger.error('[App] ❌ Error navigating to VideoCall', { error: err, callId: data?.callId });
            }
          };
          // Сначала навигация на VideoCall, потом закрытие нативного экрана — при закрытии исходящего пользователь сразу видит экран видеозвонка
          doNavigate();
          try { setOutgoingCallScreenVisible(false); } catch {}
          try { emitCloseOutgoingCall(); } catch {}
          try { closeOutgoingCallActivity(); } catch {}
          // Сценарий «только сокет»: FCM call_accepted не пришёл — явно выводим MainActivity на передний план, чтобы инициатор увидел экран видеозвонка
          if (isCaller) {
            logger.info('[App] 📱 bringMainActivityToFront (socket-only path, caller)');
            try { bringMainActivityToFront(); } catch {}
          }
        } else {
          logger.info('[App] ⏭️ Already on VideoCall screen, skipping navigation', { callId: data?.callId });
        }
      } catch (e) {
        logger.error('[App] ❌ Error navigating to VideoCall', { error: e, callId: data?.callId });
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall(); } catch {}
        try { closeOutgoingCallActivity(); } catch {}
        try { bringMainActivityToFront(); } catch {}
      }
    });
    // Обработчик таймаута
    const offTimeout = onCallTimeout?.(async (d) => {
      logger.debug('Call timeout received', { callId: d?.callId });
      incomingCallIdRef.current = null;
      if (d?.callId) try { reportEndCallToCallKeep(d.callId); } catch {}
      try { setIncomingCallScreenVisible(false); } catch {}
      stopIncomingCallAlert();
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); emitCloseOutgoingCall(); } catch {}
      try {
        const id = String((d as any)?.callId || '');
        if (id) {
          timedOutCallsRef.current.set(id, Date.now());
        }
      } catch {}
      // Инкремент пропущенного только у получателя (callee), не у инициатора
      try {
        const uid = await AsyncStorage.getItem('last_incoming_from');
        const callerId = String((d as any)?.from || '');
        if (uid && callerId && uid === callerId) {
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[uid] = (map[uid] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(uid); } catch {}
          syncAppBadgeFromMissedCount().catch(() => {});
          try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
        }
      } catch {}
    });
    
    return () => { offDecl?.(); offCancel?.(); onAccepted?.(); offTimeout?.(); };
  }, [stopAnim]);

  // Fallback: если по какой-то причине не пришёл call:timeout, авто-сворачиваем через 20с и фиксируем пропущенный
  React.useEffect(() => {
    if (!incoming) return;
    const t = setTimeout(async () => {
      try {
        // если всё ещё висит входящий — считаем пропущенным и сворачиваем
        const cur = incoming; // замкнём
        if (cur) {
          try {
            // если уже пришёл реальный timeout/cancel для этого звонка — не инкрементим повторно
            const cid = String((cur as any)?.callId || '');
            if (cid && (timedOutCallsRef.current.has(cid) || canceledCallsRef.current.has(cid))) {
              try { setIncomingCallScreenVisible(false); } catch {}
              stopIncomingCallAlert(); setIncoming(null); stopAnim();
              return;
            }
            const key = 'missed_calls_by_user_v1';
            const raw = await AsyncStorage.getItem(key);
            const map = raw ? JSON.parse(raw) : {};
            const uid = String(cur.from || '');
            if (uid) {
              map[uid] = (map[uid] || 0) + 1;
              await AsyncStorage.setItem(key, JSON.stringify(map));
              try { emitMissedIncrement(uid); } catch {}
              syncAppBadgeFromMissedCount().catch(() => {});
              try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
            }
            } catch {}
          try { setIncomingCallScreenVisible(false); } catch {}
          stopIncomingCallAlert(); setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
        }
      } catch {}
    }, OUTGOING_CALL_TIMEOUT_MS);
    return () => { try { clearTimeout(t); } catch {} };
  }, [incoming, stopAnim]);

  // Debug logging for incoming call modal
  React.useEffect(() => {
    if (incoming) {
      logger.debug('Incoming call modal state changed', { incoming: !!incoming, callId: incoming?.callId, from: incoming?.from });
    }
  }, [incoming]);

  return (
    <>
      <StatusBar 
        barStyle={isDark ? 'light-content' : 'dark-content'} 
        translucent={Platform.OS === 'android'}
        backgroundColor={Platform.OS === 'android' ? 'transparent' : undefined}
      />
      <PaperProvider theme={theme}>
        <NavigationContainer
          ref={navRef}
          theme={{
            ...DefaultTheme,
            colors: {
              ...DefaultTheme.colors,
              background: (theme.colors.background as string) || '#151F33',
            },
          }}
          onReady={() => {
            try {
              if (navRef.isReady()) {
                const currentRoute = navRef.getCurrentRoute()?.name;
                // Avoid log spam: only log when the route actually changes.
                if (currentRoute && currentRoute !== lastLoggedRouteRef.current) {
                  console.log('[App] Navigation ready, current route:', currentRoute);
                  lastLoggedRouteRef.current = currentRoute;
                }
                setRouteName(currentRoute);
              }
            } catch (e) {
              console.warn('[App] Error in onReady callback:', e);
            }
          }}
          onStateChange={() => {
            try {
              if (navRef.isReady()) {
                const currentRoute = navRef.getCurrentRoute()?.name;
                // Avoid log spam: NavigationContainer can emit many state changes even on the same route.
                if (currentRoute && currentRoute !== lastLoggedRouteRef.current) {
                  console.log('[App] Navigation state changed, current route:', currentRoute);
                  lastLoggedRouteRef.current = currentRoute;
                }
                setRouteName(currentRoute);
              }
            } catch (e) {
              console.warn('[App] Error in onStateChange callback:', e);
            }
          }}
        >
          <Stack.Navigator screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: 'transparent' },
            animation: 'fade',
            animationDuration: 450,
          }}>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen
                name="RandomChat"
                component={RandomChatScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'fade',
                  animationDuration: 450,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="VideoCall"
                component={VideoCallScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'fade',
                  animationDuration: 450,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="Chat"
                component={ChatScreen}
                options={{
                  animation: 'fade',
                  animationDuration: 450,
                  gestureEnabled: true,
                }}
              />
            </Stack.Navigator>
          </NavigationContainer>

          {/* До обработки initial URL (answer-call и т.д.) не показываем контент — иначе у принимающего мелькает Home перед VideoCall */}
          {!initialUrlProcessed && (
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: (theme.colors?.background as string) || '#151F33' }]}
              pointerEvents="none"
            />
          )}

          {/* Глобальный PiP оверлей - виден на всех страницах когда pip.visible === true */}
          <PiPOverlay />

      </PaperProvider>
    </>
  );
}

export default function App() {
  // Навигация в «вернуться к звонку»:
  const navigateToCall = (callId: string | null, roomId: string | null) => {
    console.log('[App] navigateToCall called with:', { callId, roomId });
    // возвращаем ровно на экран друга, НЕ на «Начать/Далее»
    if (navRef.isReady()) {
      navRef.navigate('VideoCall', {
        resume: true,
        callId: callId || undefined,
        roomId: roomId || undefined,
        fromPiP: true,
      });
    }
  };

  const endCallImpl = (callId: string | null, roomId: string | null) => {
    console.log('[App] 🔥 endCallImpl вызван', { callId, roomId });
    reportEndCallToCallKeep(callId);
    setCallKeepAvailable(true);
    clearCallRelatedNotificationsAndSyncBadge().catch(() => {});
    // Закрываем модалки: исходящий у звонящего, входящий у принимающего — без смены экрана
    try { emitCloseOutgoingCall(); } catch {}
    try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
    try {
      const cleanupFn = (global as any).__endCallCleanupRef?.current;
      if (cleanupFn && typeof cleanupFn === 'function') {
        console.log('[App] Вызываем cleanupFunction из __endCallCleanupRef');
        cleanupFn();
      } else {
        const session = (global as any).__webrtcSessionRef?.current;
        if (session && typeof session.endCall === 'function') {
          console.log('[App] Вызываем session.endCall() напрямую (cleanupFunction не установлена)');
          session.endCall();
        } else {
          console.log('[App] Отправляем call:end напрямую на сервер (fallback)');
          socket.emit('call:end', { 
            callId: callId || undefined, 
            roomId: roomId || undefined 
          });
        }
      }
    } catch (e) {
      console.warn('[App] Error calling endCall cleanup:', e);
    }
  };

  const endCallImplRef = React.useRef<(cid: string | null, rid: string | null) => void>(endCallImpl);
  endCallImplRef.current = endCallImpl;
  React.useEffect(() => {
    (global as any).__endCallFromNativeRef = endCallImplRef;
    return () => { delete (global as any).__endCallFromNativeRef; };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <PiPProvider onReturnToCall={navigateToCall} onEndCall={endCallImpl}>
            <AppContent />
          </PiPProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
