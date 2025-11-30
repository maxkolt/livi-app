import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';

import { registerRootComponent } from 'expo';
import { ErrorUtils, LogBox } from 'react-native';
import App from './App';

try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    originalErrorHandler(error, isFatal);
  });
} catch {}

// Dev-only: фильтр console.* логов, оставляем только нужные теги
if (__DEV__ && process.env.EXPO_PUBLIC_LOG_FILTER !== 'off') {
  try {
    // Скрываем известные шумные предупреждения в dev
    try {
      LogBox.ignoreLogs([
        'Sending `onAnimatedValueUpdate` with no listeners registered',
      ]);
    } catch {}

    const allowTags = [
      // Только критичные теги для отладки видео в блоке "Собеседник"
      'КРИТИЧНО',
      'ERROR',
      'WARN',
      // Важные события socket
      'match_found',
      'offer',
      'answer',
      // Важные события WebRTC - только критичные
      'ontrack fired',
      'Remote stream received',
      'remoteStream получен',
      'Устанавливаем remoteStream',
      // Ошибки и предупреждения
      '[ERROR]',
      '[WARN]',
      'Error',
      'Warning',
    ];
    const noisyPrefixes = [
      'rn-webrtc:', // внутренний спам нативного webrtc
      'rn-webrtc:pc:DEBUG', // WebRTC debug логи
    ];
    const noisySubstrings = [
      // WebRTC debug логи
      'getStats +',
      'ontrack +',
      'ctor +',
      'addTrack +',
      'createOffer',
      'createAnswer',
      'setLocalDescription',
      'setRemoteDescription',
      'addIceCandidate',
      // UI логи которые создают шум
      '[UI State]',
      '[UI Render]',
      '[isPartnerFriend]',
      '[showFriendBadge]',
      'onRemoteCamStateChange',
      'checkRemoteVideoTrack',
      'remoteCamOn state updated',
      'Set remoteCamOn=',
      'Computed',
      'condition check',
      'Returning false',
      'Returning true',
      // Повторяющиеся логи
      'localStream state updated',
      'localStream event received',
      'onLocalStreamChange callback',
      'shouldShowLocalVideo computed',
      'No remote stream',
      'Showing loader',
      'Showing placeholder',
      // Логи которые не критичны
      '[handleMatchFound] Before',
      '[handleMatchFound] After',
      '[handleMatchFound] Random chat',
      '[handleMatchFound] Determining',
      '[handleMatchFound] Socket ID',
      '[handleMatchFound] Updated',
      '[handleMatchFound] Before stream',
      '[handleMatchFound] Before caller',
      '[handleMatchFound] Caller: Stream',
      '[handleMatchFound] Caller: Final',
      '[WebRTCSession] startLocalStream',
      '[WebRTCSession] startLocalStream checks',
      '[WebRTCSession] startLocalStream:',
      '[WebRTCSession] After startLocalStream',
      '[WebRTCSession] Local stream created',
      '[WebRTCSession] Checking socket',
      '[WebRTCSession] Socket connected',
      '[WebRTCSession] Sent start event',
      '[WebRTCSession] startRandomChat completed',
      '[WebRTCSession] Resetting',
      '[WebRTCSession] Previous',
      '[WebRTCSession] Setting started',
      '[WebRTCSession] Searching event',
      '[WebRTCSession] Creating local',
      '[WebRTCSession] Before startLocalStream',
      '[WebRTCSession] Video track enabled',
      '[WebRTCSession] Setting local stream',
      '[WebRTCSession] Setting mic and cam',
      '[WebRTCSession] restoreCallState',
      '[WebRTCSession] Skipping receivers',
      '[WebRTCSession] Receivers:',
      '[WebRTCSession] Receiver',
      '[WebRTCSession] Video receiver',
      '[WebRTCSession] Audio receiver',
      '[WebRTCSession] cam-toggle ignored',
      '[VideoChat] searching event',
      '[VideoChat] searching event - set',
      '[Render] remoteStream', // Шумный лог - скрываем
      '[VideoChat] onLocalStreamChange',
      '[VideoChat] localStream state',
      '[VideoChat] localStream event',
      '[VideoChat] shouldShowLocalVideo',
      '[VideoChat] No remote stream',
      '[VideoChat] Showing loader',
      '[VideoChat] Showing placeholder',
      '[VideoChat] Search stopped',
      '[onStartStop]',
      '[stopped event]',
      '[stopped]',
      '[searching]',
    ];
    // КРИТИЧНО: Сохраняем оригинальные методы console перед переопределением
    // nativeEventEmitterShim уже мог переопределить console.warn, поэтому берем текущее значение
    const originalConsoleLog = console.log.bind(console);
    const originalConsoleInfo = console.info.bind(console);
    const originalConsoleDebug = (console.debug || console.log).bind(console);
    const originalConsoleWarn = console.warn.bind(console); // Может быть уже переопределен в shim
    const originalConsoleError = console.error.bind(console);
    
    const wrap = (orig: (...a: any[]) => void, isErrorOrWarn = false) => (...args: any[]) => {
      try {
        const message = args.map(a => String(a ?? '')).join(' ');
        
        // Для warn и error - показываем все, кроме очень шумных префиксов
        if (isErrorOrWarn) {
          if (noisyPrefixes.some((p) => message.startsWith(p))) {
            return;
          }
          // Показываем все warn и error
          orig(...args);
          return;
        }
        
        // Для обычных логов - строгая фильтрация
        // 1. Фильтруем по префиксам
        if (noisyPrefixes.some((p) => message.startsWith(p))) {
          return;
        }
        
        // 2. Фильтруем по подстрокам (шумные логи)
        if (noisySubstrings.some((s) => message.includes(s))) {
          return;
        }
        
        // 3. Показываем только если есть разрешенный тег
        const pass = allowTags.some(tag => message.includes(tag));
        if (!pass) {
          return;
        }
        
        orig(...args);
      } catch {
        // fallthrough - показываем если ошибка в фильтрации
        orig(...args);
      }
    };
    
    // Переопределяем методы console с фильтрацией
    console.log = wrap(originalConsoleLog);
    console.info = wrap(originalConsoleInfo);
    console.debug = wrap(originalConsoleDebug);
    console.warn = wrap(originalConsoleWarn, true); // Отдельная обертка для warn
    console.error = wrap(originalConsoleError, true); // Отдельная обертка для error

    // Перехватываем нативный логгер RN, чтобы отфильтровать низкоуровневые логи (rn-webrtc: getStats и т.п.)
    try {
      const globalObj = globalThis as any;
      const origNativeHook = globalObj.nativeLoggingHook;
      globalObj.nativeLoggingHook = (message: string, level: number) => {
        try {
          if (typeof message === 'string') {
            if (message.startsWith('rn-webrtc:') || message.includes('getStats +') || message.includes('ontrack +')) {
              return; // глушим
            }
          }
        } catch {}
        if (origNativeHook) return origNativeHook(message, level);
      };
    } catch {}
  } catch {}
}

registerRootComponent(App);