import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { logger } from './logger';

/**
 * Запрашивает разрешения на камеру и микрофон при первом запуске приложения.
 * На iOS это гарантирует показ системного диалога сразу после переустановки.
 */
export async function ensureInitialMediaPermissions(): Promise<void> {
  try {
    const cam = await Camera.getCameraPermissionsAsync();
    if (cam.status !== 'granted') {
      const requested = await Camera.requestCameraPermissionsAsync();
      logger.info('[mediaPermissions] Camera permission status:', requested.status);
    }
  } catch (e) {
    logger.warn('[mediaPermissions] Failed to request camera permission', e);
  }

  try {
    const mic = await Audio.getPermissionsAsync();
    if (mic.status !== 'granted') {
      const requested = await Audio.requestPermissionsAsync();
      logger.info('[mediaPermissions] Microphone permission status:', requested.status);
    }
  } catch (e) {
    logger.warn('[mediaPermissions] Failed to request microphone permission', e);
  }
}
