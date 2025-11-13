// App.tsx
import "react-native-gesture-handler";
import React from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Provider as PaperProvider } from "react-native-paper";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { NavigationContainer, createNavigationContainerRef, CommonActions, DefaultTheme } from "@react-navigation/native";
import { ThemeProvider, useAppTheme } from "./theme/ThemeProvider";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Audio } from "expo-av";
import { View, Text, Animated, TouchableOpacity, StyleSheet, Easing, AppState, StatusBar } from "react-native";
import { BlurView } from "expo-blur";
import { MaterialIcons } from "@expo/vector-icons";
import { PanGestureHandler } from "react-native-gesture-handler";
import socket, { onCallIncoming, onCallTimeout, onCallDeclined, onCallCanceled, onCallAccepted, acceptCall, declineCall } from "./sockets/socket";
import { emitMissedIncrement, emitCloseIncoming, emitRequestCloseIncoming, onRequestCloseIncoming, onCloseIncoming } from './utils/globalEvents';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './utils/logger';
import InCallManager from 'react-native-incall-manager';

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

import HomeScreen from "./screens/HomeScreen";
import VideoChat from "./components/VideoChat";
import ChatScreen from "./screens/ChatScreen";
import { PiPProvider, usePiP } from "./src/pip/PiPContext";
import { WebRTCProvider } from "./contexts/WebRTCContext";
import PiPOverlay from "./src/pip/PiPOverlay";

import { ensureCometChatReady } from "./chat/cometchat";
 

// Temporary workaround: silence "useInsertionEffect must not schedule updates" warnings
// by redirecting useInsertionEffect to useEffect for RN libraries that update state inside it
try { (React as any).useInsertionEffect = (React as any).useEffect; } catch {}


export type RootStackParamList = {
  Home: undefined;
  VideoChat: { 
    peerUserId?: string; 
    directCall?: boolean; 
    directInitiator?: boolean; 
    returnTo?: { name: keyof RootStackParamList; params?: any };
    mode?: 'friend';
    resume?: boolean;
    callId?: string;
    roomId?: string;
    fromPiP?: boolean;
  } | undefined;
  Chat: { peerId: string; peerName?: string; peerAvatar?: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const navRef = createNavigationContainerRef<RootStackParamList>();
// Экспортируем ссылку глобально для простого доступа из модулей без хука
// (безопасно: используется только для navigate на Home при разрыве вызова)
(global as any).__navRef = navRef;

// КРИТИЧНО: Глобальная ссылка на функцию очистки звонка из VideoChat
// Это нужно чтобы можно было вызвать очистку даже когда VideoChat размонтирован (в PiP)
(global as any).__endCallCleanupRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на функцию переключения микрофона из VideoChat
// Это нужно чтобы можно было запустить startMicMeter даже когда VideoChat размонтирован (в PiP)
(global as any).__toggleMicRef = { current: null as (() => void) | null };

// КРИТИЧНО: Глобальная ссылка на функцию переключения удаленного аудио из VideoChat
// Это нужно чтобы можно было переключать динамик даже когда VideoChat размонтирован (в PiP)
(global as any).__toggleRemoteAudioRef = { current: null as (() => void) | null };

function AppContent() {
  const { theme, isDark } = useAppTheme();
  const pip = usePiP();
  
  // Убрали постоянные логи для уменьшения шума
  const [routeName, setRouteName] = React.useState<string | undefined>(undefined);


  // ==== incoming call (global, non-VideoChat screens) ====
  const [incoming, setIncoming] = React.useState<{ callId: string; from: string; fromNick?: string } | null>(null);
  const bounce = React.useRef(new Animated.Value(0)).current;
  const wave1 = React.useRef(new Animated.Value(0)).current;
  const wave2 = React.useRef(new Animated.Value(0)).current;
  
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
        // Проверяем через routeName - если мы не в VideoChat, то можно остановить
        let currentRoute: string | undefined = undefined;
        if (navRef.isReady()) {
          currentRoute = navRef.getCurrentRoute()?.name;
        } else {
          // Fallback на routeName из state, если навигация еще не готова
          currentRoute = routeName;
        }
        if (currentRoute !== 'VideoChat') {
          (InCallManager as any).setKeepScreenOn?.(false);
          InCallManager.stop();
          logger.debug('[App] InCallManager stopped after incoming call modal closed');
        }
      } catch (e) {
        logger.warn('[App] Failed to stop InCallManager:', e);
      }
    }
  }, [incoming, routeName]);
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

      
    })();
  }, []);

  // КРИТИЧНО: Поддержание экрана включенным пока приложение активно (не в фоне)
  // ВСЕГДА активируем keep-awake и InCallManager когда приложение не в фоне
  // Это предотвращает закрытие приложения системой и затемнение экрана
  React.useEffect(() => {
    // Проверяем что модуль доступен
    if (!activateKeepAwakeAsync || !deactivateKeepAwakeAsync) {
      logger.warn('Keep-awake module not available, skipping initialization');
      return;
    }

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
      if (nextAppState === 'active' || nextAppState === 'inactive') {
        // КРИТИЧНО: Приложение активно или неактивно (но видно) - ВСЕГДА активируем keep-awake
        // 'inactive' на iOS означает, что приложение видно, но не полностью активно
        // (например, показывается Control Center или уведомление)
        // НЕ ДОЛЖНО ЗАКРЫВАТЬСЯ пока пользователь в приложении
        activateKeepAwake();
        
        // КРИТИЧНО: Для iOS ВСЕГДА активируем InCallManager когда приложение не в фоне
        // Это предотвращает закрытие приложения системой
        if (Platform.OS === 'ios') {
          try {
            InCallManager.start({ media: 'video', ringback: '' });
          } catch (e) {
            logger.warn('[App] Failed to start InCallManager (iOS):', e);
          }
        }
        
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
        
        // КРИТИЧНО: На iOS периодически переактивируем keep-awake и InCallManager
        // Уменьшаем интервал до 3 секунд для максимально надежной работы
        if (Platform.OS === 'ios' && !keepAwakeInterval) {
          keepAwakeInterval = setInterval(() => {
            if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
              activateKeepAwake();
              // КРИТИЧНО: ВСЕГДА переактивируем InCallManager на iOS когда приложение не в фоне
              try {
                InCallManager.start({ media: 'video', ringback: '' });
              } catch (e) {
                logger.warn('[App] Failed to re-activate InCallManager (iOS):', e);
              }
            }
          }, 3000); // Переактивируем каждые 3 секунды для iOS (максимально агрессивная защита)
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

    // КРИТИЧНО: Активируем сразу при монтировании если приложение активно или неактивно
    // ВСЕГДА активируем keep-awake и InCallManager когда приложение не в фоне
    const currentState = AppState.currentState;
    
    if (currentState === 'active' || currentState === 'inactive') {
      activateKeepAwake();
      
      // КРИТИЧНО: Для iOS ВСЕГДА активируем InCallManager при монтировании
      // Это предотвращает закрытие приложения системой
      if (Platform.OS === 'ios') {
        try {
          InCallManager.start({ media: 'video', ringback: '' });
        } catch (e) {
          logger.warn('[App] Failed to start InCallManager (iOS, initial mount):', e);
        }
      }
      
      // КРИТИЧНО: Для Android ВСЕГДА используем InCallManager для предотвращения засыпания экрана
      if (Platform.OS === 'android') {
        activateAndroidKeepScreenOn();
        
        // Запускаем периодическую переактивацию для Android (каждые 3 секунды)
        // чтобы предотвратить затемнение экрана системой
        androidKeepScreenOnInterval = setInterval(() => {
          if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
            activateAndroidKeepScreenOn();
          }
        }, 3000); // Переактивируем каждые 3 секунды для Android (максимально агрессивная защита)
      }
      
      // КРИТИЧНО: На iOS запускаем периодическую переактивацию keep-awake и InCallManager
      // Уменьшаем интервал до 3 секунд для максимально надежной работы
      if (Platform.OS === 'ios') {
        keepAwakeInterval = setInterval(() => {
          if (AppState.currentState === 'active' || AppState.currentState === 'inactive') {
            activateKeepAwake();
            // КРИТИЧНО: ВСЕГДА переактивируем InCallManager на iOS когда приложение не в фоне
            try {
              InCallManager.start({ media: 'video', ringback: '' });
            } catch (e) {
              logger.warn('[App] Failed to re-activate InCallManager (iOS):', e);
            }
          }
        }, 3000); // Переактивируем каждые 3 секунды для iOS (максимально агрессивная защита)
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
  }, []); // КРИТИЧНО: Не зависим от PiP - keep-awake должен работать ВСЕГДА когда приложение не в фоне

  // КРИТИЧНО: Глобальная обработка блокировки экрана для завершения звонков в PiP
  // Это нужно чтобы звонок завершался даже когда VideoChat размонтирован (оба пользователя в PiP)
  React.useEffect(() => {
    let inactiveTimerRef: ReturnType<typeof setTimeout> | null = null;
    
    const handleAppStateChange = (nextAppState: string) => {
      // Проверяем, есть ли активный звонок в PiP
      const hasActiveCallInPiP = pip.visible && (!!pip.callId || !!pip.roomId);
      
      if (nextAppState === 'inactive') {
        // iOS: inactive означает что экран может быть заблокирован
        if (Platform.OS === 'ios' && hasActiveCallInPiP) {
          if (inactiveTimerRef) {
            clearTimeout(inactiveTimerRef);
          }
          
          inactiveTimerRef = setTimeout(() => {
            if (AppState.currentState === 'inactive' || AppState.currentState === 'background') {
              const stillHasCall = pip.visible && (!!pip.callId || !!pip.roomId);
              
              if (stillHasCall) {
                // Отправляем call:end на сервер
                try {
                  const callId = pip.callId || pip.roomId;
                  if (callId) {
                    socket.emit('call:end', { callId });
                  }
                } catch (e) {
                  console.warn('[App] Error sending call:end (iOS screen lock):', e);
                }
                
                // Вызываем функцию очистки из VideoChat
                try {
                  const cleanupFn = (global as any).__endCallCleanupRef?.current;
                  if (cleanupFn && typeof cleanupFn === 'function') {
                    cleanupFn();
                  }
                } catch (e) {
                  console.warn('[App] Error calling endCall cleanup (iOS screen lock):', e);
                }
              }
            }
            inactiveTimerRef = null;
          }, 1500); // 1.5 секунды - достаточно для определения блокировки экрана
        }
      } else if (nextAppState === 'background') {
        // Android и iOS: background означает блокировку экрана
        if (hasActiveCallInPiP) {
          // Отправляем call:end на сервер
          try {
            const callId = pip.callId || pip.roomId;
            if (callId) {
              socket.emit('call:end', { callId });
            }
          } catch (e) {
            console.warn('[App] Error sending call:end (screen lock):', e);
          }
          
          // Вызываем функцию очистки из VideoChat
          try {
            const cleanupFn = (global as any).__endCallCleanupRef?.current;
            if (cleanupFn && typeof cleanupFn === 'function') {
              cleanupFn();
            }
          } catch (e) {
            console.warn('[App] Error calling endCall cleanup (screen lock):', e);
          }
        }
      } else if (nextAppState === 'active') {
        // Приложение вернулось в активное состояние - очищаем таймер
        if (inactiveTimerRef) {
          clearTimeout(inactiveTimerRef);
          inactiveTimerRef = null;
        }
      }
    };
    
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    
    return () => {
      if (inactiveTimerRef) {
        clearTimeout(inactiveTimerRef);
        inactiveTimerRef = null;
      }
      subscription.remove();
    };
  }, [pip.visible, pip.callId, pip.roomId]); // Зависим от PiP состояния для отслеживания активных звонков

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

    // КРИТИЧНО: Показываем модалку если НЕ на VideoChat, или если навигация не готова (безопаснее показать)
    if (currentRoute !== 'VideoChat' || !currentRoute) {
      logger.debug('Showing incoming call modal', { callId: d.callId, from: d.from, fromNick: d.fromNick, currentRoute });
      setIncoming(d);
      startAnim();
      // Запомним последнего звонящего для любых экранов
      try { AsyncStorage.setItem('last_incoming_from', String(d.from || '')); } catch {}
    } else {
      logger.debug('Ignoring incoming call - already on VideoChat', { callId: d.callId, from: d.from, currentRoute });
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
    const off = onCallIncoming?.(handleIncomingCall);
    
    // КРИТИЧНО: Дублирующий прямой слушатель socket как fallback
    // Используем общий обработчик из sharedDirectHandlerRef если он уже создан
    // Если нет - создаем новый, но он будет перезаписан в следующем useEffect
    const directHandler = (d: any) => {
      // Используем обработчик из ref чтобы всегда был актуальный
      if (incomingCallHandlerRef.current) {
        incomingCallHandlerRef.current(d);
      }
    };
    
    // Если sharedDirectHandlerRef еще не установлен, устанавливаем его
    if (!sharedDirectHandlerRef.current) {
      sharedDirectHandlerRef.current = directHandler;
    }
    
    try {
      socket.on('call:incoming', sharedDirectHandlerRef.current || directHandler);
      logger.debug('Registered direct call:incoming handler');
    } catch (e) {
      logger.warn('Failed to register direct call:incoming handler:', e);
    }
    
    return () => { 
      off?.(); 
      offReq?.(); 
      offClose?.();
      try {
        if (sharedDirectHandlerRef.current) {
          socket.off('call:incoming', sharedDirectHandlerRef.current);
        }
        logger.debug('Unregistered direct call:incoming handler');
      } catch {}
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

  // Закрываем входящую модалку по таймауту звонка
  React.useEffect(() => {
    const off = onCallTimeout?.(async (p: any) => {
      logger.debug('Call timeout received', { callId: p?.callId });
      // Мгновенно закрываем UI
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
      try {
        const id = String(p?.callId || '');
        if (id) timedOutCallsRef.current.set(id, Date.now());
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
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
    });
    return () => { off?.(); };
  }, [stopAnim]);

  // Резервные сырые слушатели (на случай несоответствия врапперам)
  // КРИТИЧНО: Обновляем ref'ы для синхронизации с основными обработчиками
  React.useEffect(() => {
    const close = () => { setIncoming(null); stopAnim(); };
    const hDeclined = (d: any) => {
      try {
        const id = String((d as any)?.callId || '');
        if (id) canceledCallsRef.current.set(id, Date.now());
      } catch {}
      close();
    };
    const hTimeout = (d: any) => {
      try {
        const id = String((d as any)?.callId || '');
        if (id) timedOutCallsRef.current.set(id, Date.now());
      } catch {}
      close();
    };
    const hCancel = (d: any) => {
      try {
        const id = String((d as any)?.callId || '');
        if (id) canceledCallsRef.current.set(id, Date.now());
      } catch {}
      close();
    };
    const hAccepted = () => close();
    try { socket.on('call:declined', hDeclined); } catch {}
    try { socket.on('call:timeout',  hTimeout); } catch {}
    try { socket.on('call:cancel',   hCancel); } catch {}
    try { socket.on('call:accepted', hAccepted); } catch {}
    return () => {
      try { socket.off('call:declined', hDeclined); } catch {}
      try { socket.off('call:timeout',  hTimeout); } catch {}
      try { socket.off('call:cancel',   hCancel); } catch {}
      try { socket.off('call:accepted', hAccepted); } catch {}
    };
  }, [stopAnim]);

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
    // Если пришло accepted (ответили), синхронно открываем VideoChat у обоих
    const onAccepted = onCallAccepted?.(() => {
      setIncoming(null);
      stopAnim();
      try {
        if (navRef.isReady() && navRef.getCurrentRoute()?.name !== 'VideoChat') {
          navRef.dispatch(
            CommonActions.reset({
              index: 1,
              routes: [
                { name: 'Home' as any },
                { name: 'VideoChat' as any, params: { directCall: true } },
              ],
            })
          );
        }
      } catch {}
    });
    // Обработчик таймаута
    const offTimeout = onCallTimeout?.(async (d) => {
      try {
        const id = String((d as any)?.callId || '');
        if (id) {
          const now = Date.now();
          timedOutCallsRef.current.set(id, now);
        }
      } catch {}
      setIncoming(null); stopAnim(); try { emitCloseIncoming(); emitRequestCloseIncoming(); } catch {}
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
    <SafeAreaProvider>
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
                  console.log('[App] Navigation ready, current route:', currentRoute);
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
                  console.log('[App] Navigation state changed, current route:', currentRoute);
                  setRouteName(currentRoute);
                }
              } catch (e) {
                console.warn('[App] Error in onStateChange callback:', e);
              }
            }}
          >
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen
                name="VideoChat"
                component={VideoChat}
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

          {/* Global incoming call modal (non-VideoChat screens) */}
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
                  { backgroundColor: Platform.OS === 'android' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.35)' },
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
                  <Text style={{ color: '#fff', fontWeight: '700', marginTop: 10 }}>Вам звонит</Text>
                  <Text style={{ color: '#e5e7eb', marginTop: 4 }}>{incoming.fromNick || `id: ${String(incoming.from || '').slice(0, 5)}`}</Text>

                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 300, width: '100%', paddingHorizontal: 15, paddingBottom: 60 }}>
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
              { name: 'VideoChat' as any, params: { peerUserId: incoming.from, directCall: true, directInitiator: false } },
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
    <Text style={{ color: 'rgb(52,199,89)', fontWeight: '700' }}>Принять</Text>
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
    <Text style={{ color: 'rgb(255,90,103)', fontWeight: '700' }}>Отклонить</Text>
  </TouchableOpacity>
</View>

                  <PanGestureHandler onGestureEvent={() => {}} onHandlerStateChange={({ nativeEvent }: any) => {
                    if (nativeEvent.state === 5) {
                      const dx = nativeEvent.translationX || 0;
                      if (dx > 60) { acceptCall(incoming.callId); setIncoming(null); stopAnim(); if (navRef.isReady()) { navRef.dispatch(CommonActions.reset({ index: 1, routes: [ { name: 'Home' as any }, { name: 'VideoChat' as any, params: { peerUserId: incoming.from, directCall: true, directInitiator: false } } ] })); } }
                      else if (dx < -60) { declineCall(incoming.callId); setIncoming(null); stopAnim(); }
                    }
                  }}>
                    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }} />
                  </PanGestureHandler>
                </View>
              </View>
            </View>
          )}

          {/* Глобальный PiP оверлей - виден на всех страницах кроме VideoChat */}
          {routeName !== 'VideoChat' && <PiPOverlay />}

        </PaperProvider>
      </SafeAreaProvider>
  );
}

export default function App() {
  // Навигация в «вернуться к звонку»:
  const navigateToCall = (callId: string | null, roomId: string | null) => {
    console.log('[App] navigateToCall called with:', { callId, roomId });
    // возвращаем ровно на экран друга, НЕ на «Начать/Далее»
    if (navRef.isReady()) {
      navRef.navigate('VideoChat', {
        mode: 'friend',
        resume: true,
        callId: callId || undefined,
        roomId: roomId || undefined,
        fromPiP: true,
      });
    }
  };

  const endCallImpl = (callId: string | null, roomId: string | null) => {
    // КРИТИЧНО: Сначала вызываем локальную очистку (если функция зарегистрирована)
    // Это нужно чтобы очистить PeerConnection, стримы и метр микрофона
    // даже когда VideoChat размонтирован (пользователь в PiP)
    try {
      const cleanupFn = (global as any).__endCallCleanupRef?.current;
      if (cleanupFn && typeof cleanupFn === 'function') {
        cleanupFn();
      }
    } catch (e) {
      console.warn('[App] Error calling endCall cleanup:', e);
    }
    
    // Отправляем сигнал завершения звонка на backend
    try {
      socket.emit('call:end', { roomId: roomId || 'current' });
    } catch (e) {
      console.log('[App] Error ending call:', e);
    }
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <WebRTCProvider>
          <PiPProvider onReturnToCall={navigateToCall} onEndCall={endCallImpl}>
            <AppContent />
          </PiPProvider>
        </WebRTCProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
