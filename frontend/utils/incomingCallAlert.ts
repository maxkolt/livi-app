import { Platform, Vibration } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { logger } from './logger';

let started = false;
let iosVibeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Запускает звук + вибрацию для входящего звонка (когда UI уже виден).
 *
 * Важно:
 * - Это НЕ пуш и не "звонок как телефон" когда приложение убито.
 * - Работает для сценария "мы уже в приложении и показываем модалку".
 */
export function startIncomingCallAlert() {
  if (started) return;
  started = true;

  try {
    // Рингтон системный. На Android не будет играть, если устройство в "silent" — это нормальное поведение платформы.
    // seconds: android only, ограничиваем длительность как safeguard.
    InCallManager.startRingtone('_DEFAULT_', [0, 800, 800], 'default', 25);
  } catch (e) {
    logger.warn('[incomingCallAlert] startRingtone failed:', e);
  }

  try {
    // Доп. вибрация, чтобы на Android была повторяющаяся, а на iOS — "пульс" пока висит входящий.
    if (Platform.OS === 'android') {
      Vibration.vibrate([0, 700, 900], true);
    } else {
      // iOS: repeat в RN работает ограниченно; делаем безопасный таймер в foreground.
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

  // Сначала обрываем вибрацию, чтобы не было задержки до следующего тика
  try {
    Vibration.cancel();
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

