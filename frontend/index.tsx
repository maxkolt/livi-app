import './polyfills/ensureCoreJsPolyfills';
import { safeRegisterLiveKitGlobals } from './livekit/safeRegisterGlobals';
import { installCallRuntimeBridges } from './utils/callRuntime';

// Пункт 6: lifecycle/policy флаги звонка — callRuntime; global.__*Ref только bridge.
installCallRuntimeBridges();

// Dev: глушим deprecation-шум до импорта App/expo-av (иначе warn успевает проскочить).
if (__DEV__) {
  try {
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      const msg = String(args[0] ?? '');
      if (msg.includes('[expo-av]: Expo AV has been deprecated')) return;
      if (msg.includes('[expo-image-picker]') && msg.includes('MediaTypeOptions')) return;
      origWarn(...args);
    };
  } catch {}
}

try {
  safeRegisterLiveKitGlobals();
} catch (e) {
  console.warn('[bootstrap] LiveKit globals registration failed (non-fatal)', e);
}

import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';
// Ранняя загрузка модуля пуша, чтобы захватить getLastNotificationResponseAsync до монтирования App (важно для входящего звонка из фона/убитого приложения)
import './utils/pushNotifications';
import { installAppNavigationGuard } from './utils/appNavigationGuard';

installAppNavigationGuard();

import { Alert, AppRegistry, Platform, Text, TextInput } from 'react-native';

// Не следовать системной настройке «Размер шрифта» (iOS/Android JS). На Android плотность dp и fontScale дополнительно фиксируются в MainApplication/MainActivity (FontScaleContextHelper).
const noFontScaling = { allowFontScaling: false as const, maxFontSizeMultiplier: 1 as const };
(Text as any).defaultProps = { ...(Text as any).defaultProps, ...noFontScaling };
(TextInput as any).defaultProps = { ...(TextInput as any).defaultProps, ...noFontScaling };
import { registerRootComponent } from 'expo';
import App from './App';
import { isEndedCallId, setupCallKeep, presentIncomingCall, stopIncomingCallForegroundService } from './utils/callKeep';
import * as Notifications from 'expo-notifications';
import { isIncomingCallExpired } from './utils/callExpiry';

// Headless: один путь presentIncomingCall (Activity/system UI), без CallKeep.displayIncomingCall.
AppRegistry.registerHeadlessTask('RNCallKeepBackgroundMessage', () => async (data: { type?: string; callId?: string; from?: string; fromNick?: string; ts?: number | string; expiresAt?: number | string } | null) => {
  if (Platform.OS !== 'android') return;
  console.log('[headless] RNCallKeepBackgroundMessage received', data ? { type: data.type, callId: data?.callId, from: data?.from } : null);
  if (!data || data.type !== 'call' || !data.callId || !data.from) return;
  try {
    if (isIncomingCallExpired({ expiresAt: data.expiresAt, ts: data.ts })) {
      console.log('[headless] skip stale incoming call', { callId: data.callId, ts: data.ts, expiresAt: data.expiresAt });
      return;
    }
    if (await isEndedCallId(data.callId)) {
      console.log('[headless] skip (call already ended)', data.callId);
      return;
    }
    // Session bookkeeping; UI всегда через presentIncomingCall (forceBackgroundUi).
    await setupCallKeep({ requestPermission: false });
    await presentIncomingCall({
      callId: data.callId,
      from: data.from,
      fromNick: data.fromNick ?? '',
      hasVideo: true,
      checkEnded: true,
      forceBackgroundUi: true,
      source: 'headless:RNCallKeepBackgroundMessage',
    });
    setTimeout(() => {
      try { stopIncomingCallForegroundService(); } catch {}
    }, 1500);
    console.log('[headless] incoming UI shown via presentIncomingCall', { callId: data.callId });
  } catch (e) {
    console.warn('[headless] RNCallKeepBackgroundMessage failed', e);
  }
});

// Глобальный обработчик ошибок для предотвращения крашей
try {
  const originalErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error, isFatal) => {
    // Игнорируем известные неопасные ошибки
    if (error?.message?.includes('useInsertionEffect must not schedule')) {
      return;
    }
    // LiveKit при уходе в фон/системный PiP может выбросить, если leave пришёл во время reconnecting — не показываем красный экран.
    const msg = String(error?.message || error?.reasonName || '');
    if (msg.includes('leave request') || msg.includes('LeaveRequest') || (msg.includes('reconnect') && msg.includes('leave'))) {
      if (typeof console?.warn === 'function') {
        console.warn('[Global Error Handler] Suppressed LiveKit leave/reconnect error (non-fatal)', msg);
      }
      return;
    }
    if (msg.includes('android.software.telecom') || msg.includes('FEATURE_TELECOM')) {
      if (typeof console?.warn === 'function') {
        console.warn('[Global Error Handler] Suppressed Telecom/CallKeep error on device without telephony', msg);
      }
      return;
    }
    if (__DEV__ && /Requiring unknown module "\d+"/.test(msg)) {
      if (typeof console?.warn === 'function') {
        console.warn(
          '[Global Error Handler] Stale Metro module id (often after Fast Refresh). Press r in Metro or restart with npm run start:usb:clean',
          msg,
        );
      }
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
const bootstrapGlobal = global as any;
if (typeof global !== 'undefined' && bootstrapGlobal.HermesInternal) {
  // React Native с Hermes
  const originalUnhandledRejection = bootstrapGlobal.onunhandledrejection;
  bootstrapGlobal.onunhandledrejection = (event: any) => {
    const reason = event?.reason || event;
    const msg = String(reason?.message || reason?.reasonName || reason || '');
    const isLeaveWhileReconnect =
      msg.includes('leave request') ||
      msg.includes('LeaveRequest') ||
      (msg.includes('reconnect') && msg.includes('leave'));
    if (isLeaveWhileReconnect) {
      if (typeof console?.warn === 'function') {
        console.warn('[Unhandled Promise Rejection] Suppressed LiveKit leave/reconnect error (non-fatal)', msg);
      }
      if (event?.preventDefault) {
        event.preventDefault();
      }
      return;
    }
    if (msg.includes('android.software.telecom') || msg.includes('FEATURE_TELECOM')) {
      if (typeof console?.warn === 'function') {
        console.warn('[Unhandled Promise Rejection] Suppressed Telecom/CallKeep error (non-fatal)', msg);
      }
      if (event?.preventDefault) {
        event.preventDefault();
      }
      return;
    }
    if (__DEV__ && /Requiring unknown module "\d+"/.test(msg)) {
      if (typeof console?.warn === 'function') {
        console.warn('[Unhandled Promise Rejection] Stale Metro module id — reload app (r in Metro)', msg);
      }
      if (event?.preventDefault) {
        event.preventDefault();
      }
      return;
    }
    console.error('[Unhandled Promise Rejection]', reason);
    // Предотвращаем краш приложения
    if (event?.preventDefault) {
      event.preventDefault();
    }
    if (typeof originalUnhandledRejection === 'function') {
      (originalUnhandledRejection as (ev: any) => void)(event);
    }
  };
} else {
  // Fallback для других движков
  if (typeof global !== 'undefined') {
    bootstrapGlobal.onunhandledrejection = (event: any) => {
      const reason = event?.reason || event;
      const msg = String(reason?.message || reason?.reasonName || reason || '');
      const isLeaveWhileReconnect =
        msg.includes('leave request') ||
        msg.includes('LeaveRequest') ||
        (msg.includes('reconnect') && msg.includes('leave'));
      if (isLeaveWhileReconnect) {
        if (typeof console?.warn === 'function') {
          console.warn('[Unhandled Promise Rejection] Suppressed LiveKit leave/reconnect error (non-fatal)', msg);
        }
        if (event?.preventDefault) {
          event.preventDefault();
        }
        return;
      }
      if (msg.includes('android.software.telecom') || msg.includes('FEATURE_TELECOM')) {
        if (typeof console?.warn === 'function') {
          console.warn('[Unhandled Promise Rejection] Suppressed Telecom/CallKeep error (non-fatal)', msg);
        }
        if (event?.preventDefault) {
          event.preventDefault();
        }
        return;
      }
      console.error('[Unhandled Promise Rejection]', reason);
      // Предотвращаем краш
      if (event?.preventDefault) {
        event.preventDefault();
      }
    };
  }
}

registerRootComponent(App);