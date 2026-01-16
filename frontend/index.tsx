import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';

import { Alert } from 'react-native';
import { registerRootComponent } from 'expo';
import App from './App';

// Глобальный обработчик ошибок для предотвращения крашей
try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    // Игнорируем известные неопасные ошибки
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    
    // Логируем все ошибки для отладки
    console.error('[Global Error Handler]', {
      message: error?.message,
      stack: error?.stack,
      isFatal,
      name: error?.name
    });

    // Показываем понятную ошибку на устройстве (иначе часто виден просто чёрный экран)
    try {
      // Защита от спама алертами
      const msg = String(error?.message || error || 'Unknown error');
      const key = '__lastJsFatalAlert';
      const last = (global as any)[key];
      if (isFatal && last !== msg) {
        (global as any)[key] = msg;
        Alert.alert('JS Error', msg);
      }
    } catch {}
    
    // Для критических ошибок вызываем оригинальный обработчик
    if (isFatal) {
      originalErrorHandler(error, isFatal);
    } else {
      // Для некритических ошибок просто логируем
      console.warn('[Non-fatal error]', error);
    }
  });
} catch (e) {
  console.error('Failed to set global error handler:', e);
}

// Обработчик необработанных промисов
if (typeof global !== 'undefined' && global.HermesInternal) {
  // React Native с Hermes
  const originalUnhandledRejection = global.onunhandledrejection;
  global.onunhandledrejection = (event: any) => {
    console.error('[Unhandled Promise Rejection]', event?.reason || event);
    // Предотвращаем краш приложения
    if (event?.preventDefault) {
      event.preventDefault();
    }
    if (originalUnhandledRejection) {
      originalUnhandledRejection(event);
    }
  };
} else {
  // Fallback для других движков
  if (typeof global !== 'undefined') {
    (global as any).onunhandledrejection = (event: any) => {
      console.error('[Unhandled Promise Rejection]', event?.reason || event);
      // Предотвращаем краш
      if (event?.preventDefault) {
        event.preventDefault();
      }
    };
  }
}

registerRootComponent(App);