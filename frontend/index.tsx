import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';

import { registerRootComponent } from 'expo';
import { ErrorUtils, LogBox } from 'react-native';

try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    originalErrorHandler(error, isFatal);
  });
} catch {}

import App from './App';

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
      '[socket]',
      '[onStartStop]',
      '[videochat]',
      '[cam-toggle]',
      '[toggleCam]',
      '[pip:state]',
      '[PiPContext]',
      '[PanGestureHandler]',
      '[support]',
      '[analytics]',
      'friend:call',       // включает [friend:call:incoming]
      'call:incoming',
      '[App] navigateToCall',
      // Теги для отладки видеозвонков
      '[call:accepted]',
      '[ensurePcWithLocal]',
      '[createStreamForReceiver]',
      '[createStreamForInitiator]',
      '[handleOffer]',
      '[handleAnswer]',
      '[handleMatchFound]',
      '[handleRemote]',
      '[attachRemoteHandlers]',
      '[onNext]',
      '[stopRemoteOnly]',
      '[cleanupPeer]',
      '[isPartnerFriend]',
      '[showFriendBadge]',
      '[UI State]',
      '[UI Render]',
      '[DEBUG]',
      '[WARN]',
      '[ERROR]',
      '[INFO]',
    ];
    const noisyPrefixes = [
      'rn-webrtc:', // внутренний спам нативного webrtc
    ];
    const noisySubstrings = [
      'getStats +', // частые периодические логи статистики
      'ontrack +',  // спам ontrack из нативного слоя
      'ctor +',
      'addTrack +',
      'createOffer',
      'createAnswer',
      'setLocalDescription',
      'setRemoteDescription',
      'addIceCandidate',
    ];
    const wrap = (orig: (...a: any[]) => void, isErrorOrWarn = false) => (...args: any[]) => {
      try {
        const first = String(args[0] ?? '');
        // Для warn и error фильтруем только очень шумные префиксы
        if (isErrorOrWarn && noisyPrefixes.some((p) => first.startsWith(p))) {
          return;
        }
        // Для остальных логов применяем полную фильтрацию
        if (!isErrorOrWarn) {
          if (noisyPrefixes.some((p) => first.startsWith(p))) return;
          if (noisySubstrings.some((s) => first.includes(s))) return;
          const pass = allowTags.some(tag => first.includes(tag));
          if (!pass) return;
        }
      } catch {
        // fallthrough
      }
      orig(...args);
    };
    console.log = wrap(console.log.bind(console));
    console.info = wrap(console.info.bind(console));
    console.debug = wrap(console.debug ? console.debug.bind(console) : console.log.bind(console));
    console.warn = wrap(console.warn.bind(console), true); // Отдельная обертка для warn
    console.error = wrap(console.error.bind(console), true); // Отдельная обертка для error

    // Перехватываем нативный логгер RN, чтобы отфильтровать низкоуровневые логи (rn-webrtc: getStats и т.п.)
    try {
      const origNativeHook = (global as any).nativeLoggingHook;
      (global as any).nativeLoggingHook = (message: string, level: number) => {
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