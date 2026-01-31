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
import { View, Text, Animated, TouchableOpacity, StyleSheet, Easing, AppState, StatusBar, Linking, LogBox, Keyboard } from "react-native";
import { BlurView } from "expo-blur";
import { MaterialIcons } from "@expo/vector-icons";
import { PanGestureHandler } from "react-native-gesture-handler";
import socket, { onCallIncoming, onCallTimeout, onCallDeclined, onCallCanceled, onCallAccepted, acceptCall, declineCall, checkInviteLink, getCurrentUserId } from "./sockets/socket";
import { emitMissedIncrement, emitCloseIncoming, emitRequestCloseIncoming, onRequestCloseIncoming, onCloseIncoming } from './utils/globalEvents';
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
import { addNotificationListeners, ensureInitialNotificationPermissions, registerAndSendPushToken } from './utils/pushNotifications';
import { ensureInitialMediaPermissions } from './utils/mediaPermissions';
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
  
  React.useEffect(() => {
    void hydrateLang();
  }, [hydrateLang]);
  
  // Убрали постоянные логи для уменьшения шума
  const [routeName, setRouteName] = React.useState<string | undefined>(undefined);
  const lastLoggedRouteRef = React.useRef<string | undefined>(undefined);


  // ==== incoming call (global, когда не на экране видеозвонка) ====
  const [incoming, setIncoming] = React.useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const bounce = React.useRef(new Animated.Value(0)).current;
  const wave1 = React.useRef(new Animated.Value(0)).current;
  const wave2 = React.useRef(new Animated.Value(0)).current;
  
  // Настройка навигационной панели на Android для edge-to-edge
  React.useEffect(() => {
    if (Platform.OS === 'android') {
      // Имитируем системный "затемнённый прозрачный" navbar как в dev:
      // bar поверх контента + полупрозрачный тёмный фон + светлые иконки.
      const bg = 'rgba(0,0,0,0.22)';
      NavigationBar.setPositionAsync('absolute').catch(() => {});
      NavigationBar.setBackgroundColorAsync(bg);
      NavigationBar.setButtonStyleAsync('light');
      NavigationBar.setBorderColorAsync(bg).catch(() => {});
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
          allowsRecordingIOS: true,
          staysActiveInBackground: true,   // Включаем для работы аудио в PiP
          shouldDuckAndroid: true,
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

  // ===== Deep Linking обработка для реферальных ссылок =====
  const INVITE_LINK_KEY = 'pending_invite_code';
  React.useEffect(() => {
    // Обработка ссылки при открытии приложения
    const handleInitialUrl = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          handleInviteLink(initialUrl);
        }
      } catch (e) {
        logger.warn('Failed to get initial URL:', e);
      }
    };

    // Обработка ссылки во время работы приложения
    const handleUrl = (event: { url: string }) => {
      handleInviteLink(event.url);
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
      logger.info('[App] Processing invite link:', url);
      
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
  const handleIncomingCall = React.useCallback((d: { callId: string; from: string; fromNick?: string }) => {
    logger.debug('Received call:incoming event', { callId: d.callId, from: d.from, fromNick: d.fromNick });
    
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

    // КРИТИЧНО: Показываем глобальную модалку если:
    // 1) НЕ на экране видеозвонка/рандомчата, ИЛИ
    // 2) Навигация не готова (безопаснее показать), ИЛИ
    // 3) Мы на VideoCall/RandomChat, но видеосессия УЖЕ завершена (неактивное состояние) —
    //    тогда модалка должна быть как у "неактивного видеочата": во весь экран.
    const isOnVideoScreen = isVideoSessionRoute(currentRoute);
    const isInactiveVideoState = !!(global as any)?.__isInactiveStateRef?.current;

    const shouldShowGlobal =
      !isOnVideoScreen ||
      !currentRoute ||
      (isOnVideoScreen && isInactiveVideoState);

    if (shouldShowGlobal) {
      logger.debug('Showing incoming call modal', { callId: d.callId, from: d.from, fromNick: d.fromNick, currentRoute });
      // КРИТИЧНО: если пользователь печатает в чате — закрываем клавиатуру,
      // иначе она может перекрыть кнопки принять/отклонить на входящем экране.
      try { Keyboard.dismiss(); } catch {}
      setIncoming(d);
      startAnim();
      // Запомним последнего звонящего для любых экранов
      try { AsyncStorage.setItem('last_incoming_from', String(d.from || '')); } catch {}
    } else {
      logger.debug('Skipping global modal - on video/random screen, will show in peer block', { callId: d.callId, from: d.from, currentRoute });
    }
  }, [routeName, startAnim]);

  // Сохраняем обработчик в ref для использования в fallback
  incomingCallHandlerRef.current = handleIncomingCall;

  // КРИТИЧНО: Общий прямой обработчик для перерегистрации при переподключении
  // Используем одну функцию для всех случаев чтобы избежать конфликтов
  const sharedDirectHandlerRef = React.useRef<((d: any) => void) | null>(null);

  React.useEffect(() => {
    // Закрытие по внешнему запросу (например, из ChatScreen)
    const offReq = onRequestCloseIncoming?.(() => { setIncoming(null); stopAnim(); });
    const offClose = onCloseIncoming?.(() => { setIncoming(null); stopAnim(); });
    
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
        logger.debug('Registered/re-registered call:incoming handler');
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

  // КРИТИЧНО: Перерегистрация обработчика при возврате из спящего режима (AppState change)
  React.useEffect(() => {
    const { AppState } = require('react-native');
    let appStateRef = AppState.currentState;

    const handleAppStateChange = (nextAppState: string) => {
      if (appStateRef.match(/inactive|background/) && nextAppState === 'active') {
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
    const offDecl = onCallDeclined?.(async (d) => {
      logger.debug('Call declined received', { callId: d?.callId });
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      try {
        // Помечаем callId как отменённый (инициатор нажал Отменить)
        try {
          const id = String((d as any)?.callId || '');
          if (id) canceledCallsRef.current.set(id, Date.now());
        } catch {}
        // Инкремент только у получателя: проверяем, совпадает ли с последним входящим
        const lastFrom = await AsyncStorage.getItem('last_incoming_from');
        if (lastFrom && String(lastFrom) === String(d?.from || '')) {
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[lastFrom] = (map[lastFrom] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          // сразу пушим в UI
          try { emitMissedIncrement(lastFrom); } catch {}
          // и очищаем маркер
          try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
        }
      } catch {}
      // Никакой навигации — пользователь остаётся там, где был
    });
    const offCancel = onCallCanceled?.(async (d) => {
      logger.debug('Call canceled received', { callId: d?.callId });
      // КРИТИЧНО: Обновляем canceledCallsRef для защиты от гонки событий
      try {
        const id = String((d as any)?.callId || '');
        if (id) canceledCallsRef.current.set(id, Date.now());
      } catch {}
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      // Никакой навигации — остаёмся на текущем экране
      // Инкремент пропущенного (на стороне получателя)
      try {
        const uid = await AsyncStorage.getItem('last_incoming_from');
        if (uid) {
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[uid] = (map[uid] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(uid); } catch {}
          // очищаем маркер
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
      
      setIncoming(null);
      stopAnim();
      try {
        if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'VideoCall') {
          logger.info('[App] 🚀 Navigating to VideoCall screen', {
            callId: data?.callId,
          });
          navRef.dispatch(
            CommonActions.reset({
              index: 1,
              routes: [
                { name: 'Home' as any },
                { name: 'VideoCall' as any, params: { directCall: true } },
              ],
            })
          );
        } else {
          logger.info('[App] ⏭️ Already on VideoCall screen, skipping navigation', {
            callId: data?.callId,
          });
        }
      } catch (e) {
        logger.error('[App] ❌ Error navigating to VideoCall', { error: e, callId: data?.callId });
      }
    });
    // Обработчик таймаута
    const offTimeout = onCallTimeout?.(async (d) => {
      logger.debug('Call timeout received', { callId: d?.callId });
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      try {
        const id = String((d as any)?.callId || '');
        if (id) {
          timedOutCallsRef.current.set(id, Date.now());
        }
      } catch {}
      // Инкремент пропущенного — на случай, если HomeScreen ещё не активен
      try {
        const uid = await AsyncStorage.getItem('last_incoming_from');
        if (uid) {
          const key = 'missed_calls_by_user_v1';
          const raw = await AsyncStorage.getItem(key);
          const map = raw ? JSON.parse(raw) : {};
          map[uid] = (map[uid] || 0) + 1;
          await AsyncStorage.setItem(key, JSON.stringify(map));
          try { emitMissedIncrement(uid); } catch {}
          // очищаем маркер, чтобы у звонящего не сработали другие обработчики
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
              setIncoming(null); stopAnim();
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
              try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
            }
          } catch {}
          setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
        }
      } catch {}
    }, 20000);
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
          }}>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen
                name="RandomChat"
                component={RandomChatScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'slide_from_right' as any,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen
                name="VideoCall"
                component={VideoCallScreen}
                options={{
                  presentation: 'card',
                  gestureEnabled: true,
                  animation: 'slide_from_right' as any,
                  contentStyle: { backgroundColor: 'transparent' },
                }}
              />
              <Stack.Screen name="Chat" component={ChatScreen} />
            </Stack.Navigator>
          </NavigationContainer>

          {/* Global incoming call modal (не отображается поверх VideoCall) */}
          {incoming && (
            <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { zIndex: 9999 }]}>
              <BlurView
                intensity={Platform.OS === 'android' ? 100 : 85}
                tint="dark"
                style={StyleSheet.absoluteFill}
              />
              <View
                style={[
                  StyleSheet.absoluteFill,
                  // Android: сильнее затемняем задний фон
                  { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.35)' },
                ]}
              />
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: '100%', padding: 18, borderRadius: Platform.OS === 'android' ? 0 : 16, backgroundColor: Platform.OS === 'ios' ? 'transparent' : 'rgba(13,14,16,0.9)', borderWidth: Platform.OS === 'ios' ? 0 : (Platform.OS === 'android' ? 0 : StyleSheet.hairlineWidth), borderColor: 'rgba(255,255,255,0.12)', alignItems: 'center', ...(Platform.OS === 'android' ? { ...StyleSheet.absoluteFillObject, justifyContent: 'center' } : {}) }}>
                  <View style={{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }}>
                    <Animated.View style={{
                      position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)',
                      opacity: wave1.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                      transform: [{ scale: wave1.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.35] }) }, { translateX: -24 }],
                    }} />
                    <Animated.View style={{
                      position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: 'rgba(255,255,255,0.35)',
                      opacity: wave2.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                      transform: [{ scale: wave2.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.35] }) }, { translateX: 24 }],
                    }} />
                    <Animated.View style={{ transform: [{ translateY: bounce.interpolate({ inputRange: [-1, 0, 1], outputRange: [-6, 0, -6] }) }, { rotate: bounce.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] }) }] }}>
                      <MaterialIcons name="call" size={48} color="#4FC3F7" />
                    </Animated.View>
                  </View>
                  <Text style={{ color: '#fff', fontWeight: '700', marginTop: 10 }}>{t('incomingCallTitle', lang)}</Text>
                  <Text style={{ color: '#e5e7eb', marginTop: 4 }}>{incoming.fromNick || `id: ${String(incoming.from || '').slice(0, 5)}`}</Text>

                  <View
                    style={{
                      position: 'absolute',
                      left: 18,
                      right: 18,
                      bottom: Math.max(insets.bottom, 14) + 18,
                      flexDirection: 'row',
                      gap: 12,
                    }}
                  >
  {/* Принять */}
  <TouchableOpacity
    onPress={async () => {
      try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
      acceptCall(incoming.callId);
      setIncoming(null);
      stopAnim();
      if (navRef.isReady()) {
        navRef.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'Home' as any },
              { name: 'VideoCall' as any, params: { peerUserId: incoming.from, directCall: true, directInitiator: false } },
            ],
          })
        );
      }
    }}
    activeOpacity={0.7}
    style={{
      flex: 1,
      height: 52,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(52,199,89,0.18)',  // прозрачный зелёный
      borderWidth: 1,
      borderColor: 'rgba(36,150,65,0.7)',       // бордер темнее
    }}
  >
    <Text style={{ color: 'rgb(52,199,89)', fontWeight: '700' }}>{t('accept', lang)}</Text>
  </TouchableOpacity>

  {/* Отклонить */}
  <TouchableOpacity
    onPress={async () => {
      try { await AsyncStorage.removeItem('last_incoming_from'); } catch {}
      declineCall(incoming.callId);
      setIncoming(null);
      stopAnim();
    }}
    activeOpacity={0.7}
    style={{
      flex: 1,
      height: 52,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,90,103,0.18)', // прозрачный красный
      borderWidth: 1,
      borderColor: 'rgba(200,50,65,0.7)',       // бордер темнее
    }}
  >
    <Text style={{ color: 'rgb(255,90,103)', fontWeight: '700' }}>{t('decline', lang)}</Text>
  </TouchableOpacity>
</View>

                  <PanGestureHandler onGestureEvent={() => {}} onHandlerStateChange={({ nativeEvent }: any) => {
                    if (nativeEvent.state === 5) {
                      const dx = nativeEvent.translationX || 0;
                      if (dx > 60) { acceptCall(incoming.callId); setIncoming(null); stopAnim(); if (navRef.isReady()) { navRef.dispatch(CommonActions.reset({ index: 1, routes: [ { name: 'Home' as any }, { name: 'VideoCall' as any, params: { peerUserId: incoming.from, directCall: true, directInitiator: false } } ] })); } }
                      else if (dx < -60) { declineCall(incoming.callId); setIncoming(null); stopAnim(); }
                    }
                  }}>
                    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }} />
                  </PanGestureHandler>
                </View>
              </View>
            </View>
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
    
    // КРИТИЧНО: Сначала вызываем локальную очистку (если функция зарегистрирована)
    // Это нужно чтобы очистить PeerConnection, стримы и метр микрофона
    // даже когда экран звонка размонтирован (пользователь в PiP)
    // session.endCall() уже отправит call:end на сервер, поэтому здесь не нужно дублировать
    try {
      const cleanupFn = (global as any).__endCallCleanupRef?.current;
      if (cleanupFn && typeof cleanupFn === 'function') {
        console.log('[App] Вызываем cleanupFunction из __endCallCleanupRef');
        cleanupFn();
      } else {
        // Fallback: если cleanupFunction не установлена, вызываем session.endCall() напрямую
        const session = (global as any).__webrtcSessionRef?.current;
        if (session && typeof session.endCall === 'function') {
          console.log('[App] Вызываем session.endCall() напрямую (cleanupFunction не установлена)');
          session.endCall();
        } else {
          // Последний fallback: отправляем call:end напрямую на сервер
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
