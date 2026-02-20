import { NativeModules, Platform, Vibration } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logger } from './logger';

let started = false;
let iosVibeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Запускает системную мелодию звонка и вибрацию звонка для входящего (когда UI уже виден).
 * На Android: мелодия из Настройки → Мелодия звонка, вибрация из Настройки → Вибрация звонка (USAGE_RINGTONE).
 * В приложении, вне приложения и на заблокированном экране — одинаковое поведение.
 */
export function startIncomingCallAlert() {
  if (started) return;
  started = true;

  try {
    // Системная мелодия звонка (_DEFAULT_ = RingtoneManager.TYPE_RINGTONE). На Android — громкость «Звонок».
    InCallManager.startRingtone('_DEFAULT_', [0, 800, 800], 'default', 25);
  } catch (e) {
    logger.warn('[incomingCallAlert] startRingtone failed:', e);
  }

  try {
    if (Platform.OS === 'android') {
      // Вибрация звонка (как в настройках «Вибрация звонка»), не уведомления.
      NativeModules.LiviAppModule?.startIncomingCallVibration?.();
    } else {
      // iOS: повторяющийся пульс пока висит входящий.
      iosVibeTimer = setInterval(() => {
        try {
          Vibration.vibrate(800);
        } catch {}
      }, 1600);
    }
  } catch (e) {
    logger.warn('[incomingCallAlert] vibration start failed:', e);
  }
}

export function stopIncomingCallAlert() {
  if (!started) return;
  started = false;

  try {
    if (Platform.OS === 'android') {
      NativeModules.LiviAppModule?.stopIncomingCallVibration?.();
    } else {
      Vibration.cancel();
    }
  } catch {}

  try {
    if (iosVibeTimer) {
      clearInterval(iosVibeTimer);
      iosVibeTimer = null;
    }
  } catch {}

  try {
    InCallManager.stopRingtone();
  } catch (e) {
    logger.warn('[incomingCallAlert] stopRingtone failed:', e);
  }
}

