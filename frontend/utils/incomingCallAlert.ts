import { NativeModules, Platform, Vibration } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logger } from './logger';

let started = false;
let iosVibeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Запускает системную мелодию звонка и вибрацию звонка для входящего (когда UI уже виден).
 * На Android: один путь с LiviAppModule (как CallKeep), без InCallManager — иначе две мелодии поверх IncomingCallActivity.
 * На iOS: InCallManager + повторная вибрация.
 */
export function startIncomingCallAlert() {
  if (started) return;
  started = true;

  try {
    if (Platform.OS === 'android') {
      NativeModules.LiviAppModule?.startIncomingCallRingtoneAndVibration?.();
    } else {
      InCallManager.startRingtone('_DEFAULT_', [0, 800, 800], 'default', 25);
    }
  } catch (e) {
    logger.warn('[incomingCallAlert] startRingtone failed:', e);
  }

  try {
    if (Platform.OS === 'android') {
      // Мелодия + вибрация уже в startIncomingCallRingtoneAndVibration
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
      NativeModules.LiviAppModule?.stopIncomingCallRingtoneAndVibration?.();
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
    if (Platform.OS !== 'android') {
      InCallManager.stopRingtone();
    }
  } catch (e) {
    logger.warn('[incomingCallAlert] stopRingtone failed:', e);
  }
}

