import './shims/nativeEventEmitterShim';
import 'react-native-gesture-handler';
import 'react-native-reanimated';
// Ранняя загрузка модуля пуша, чтобы захватить getLastNotificationResponseAsync до монтирования App (важно для входящего звонка из фона/убитого приложения)
import './utils/pushNotifications';

import { Alert, AppRegistry, Platform, Text, TextInput } from 'react-native';

// Не следовать системной настройке «Размер шрифта» (iOS/Android JS). На Android плотность dp и fontScale дополнительно фиксируются в MainApplication/MainActivity (FontScaleContextHelper).
const noFontScaling = { allowFontScaling: false as const, maxFontSizeMultiplier: 1 as const };
(Text as any).defaultProps = { ...(Text as any).defaultProps, ...noFontScaling };
(TextInput as any).defaultProps = { ...(TextInput as any).defaultProps, ...noFontScaling };
import { registerRootComponent } from 'expo';
import App from './App';
import { isEndedCallId, setupCallKeep, displayIncomingCall, stopIncomingCallForegroundService, showIncomingCallSystemUI } from './utils/callKeep';
import * as Notifications from 'expo-notifications';
import { isIncomingCallExpired } from './utils/callExpiry';

// Headless: при входящем пуше показываем баннер через ConnectionService/CallKeep (как в Telegram) — он не исчезает через 5–7 сек.
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
    // В фоне не запрашиваем runtime-permissions: используем CallKeep только если он уже готов,
    // иначе переключаемся на нативный системный fallback.
    const ready = await setupCallKeep({ requestPermission: false });
    if (ready) {
      displayIncomingCall(data.callId, data.from, data.fromNick ?? '', true);
      // Без второго MediaPlayer: CallKeep/ConnectionService уже играет рингтон.
    } else {
      showIncomingCallSystemUI(data.callId, data.from, data.fromNick ?? '');
    }
    // Даём системе время показать баннер CallKeep, затем снимаем уведомление FGS (иначе на части устройств баннер не успевает появиться)
    setTimeout(() => {
      try { stopIncomingCallForegroundService(); } catch {}
    }, 1500);
    console.log('[headless] incoming UI shown', { callId: data.callId, viaCallKeep: ready });
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
    console.error('[Unhandled Promise Rejection]', reason);
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
      console.error('[Unhandled Promise Rejection]', reason);
      // Предотвращаем краш
      if (event?.preventDefault) {
        event.preventDefault();
      }
    };
  }
}

registerRootComponent(App);