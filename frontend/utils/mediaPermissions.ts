import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { Platform, PermissionsAndroid } from 'react-native';
import { logger } from './logger';

/**
 * Запрашивает разрешение «Устройства рядом» (Bluetooth) на Android 12+ при старте.
 * Системный диалог: «Разрешить приложению LiVi находить устройства поблизости…»
 */
async function requestNearbyDevicesPermissionAndroid(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const ver = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  if (!Number.isFinite(ver) || ver < 31) return; // BLUETOOTH_CONNECT с Android 12 (API 31)

  const perm = (PermissionsAndroid as any)?.PERMISSIONS?.BLUETOOTH_CONNECT;
  if (!perm) return;

  try {
    const already = await PermissionsAndroid.check(perm);
    if (already) return;
  } catch {}

  try {
    const res = await PermissionsAndroid.request(perm);
    logger.info('[mediaPermissions] Nearby devices (BLUETOOTH_CONNECT) permission:', res);
  } catch (e) {
    logger.warn('[mediaPermissions] Nearby devices permission request failed', e);
  }
}

/**
 * Запрашивает разрешения на камеру, микрофон и «Устройства рядом» при первом запуске приложения.
 * На iOS — камера и микрофон. На Android — камера, микрофон и (с Android 12) «Устройства рядом».
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

  await requestNearbyDevicesPermissionAndroid();
}
