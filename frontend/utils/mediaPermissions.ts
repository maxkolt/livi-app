import { Camera } from 'expo-camera';
import { Audio } from 'expo-av';
import { Platform, PermissionsAndroid } from 'react-native';
import { logger } from './logger';

/**
 * Нужно ли вообще спрашивать «Устройства рядом»: только Android 12+ и только если ещё не выдано.
 */
export async function needsNearbyDevicesPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const ver = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  if (!Number.isFinite(ver) || ver < 31) return false;
  const perm = (PermissionsAndroid as any)?.PERMISSIONS?.BLUETOOTH_CONNECT;
  if (!perm) return false;
  try {
    return !(await PermissionsAndroid.check(perm));
  } catch {
    return false;
  }
}

/**
 * Запрашивает разрешение «Устройства рядом» (Bluetooth) на Android 12+.
 * Системный диалог: «Разрешить приложению LiVi находить устройства поблизости…»
 *
 * Вызывается только при подключённой Bluetooth-гарнитуре — из контекста понятно, зачем.
 * 'never_ask_again' — Android диалог уже не покажет, включить можно только в настройках.
 */
export async function requestNearbyDevicesPermissionAndroid(): Promise<
  'granted' | 'denied' | 'never_ask_again'
> {
  if (Platform.OS !== 'android') return 'granted';
  const ver = typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version);
  if (!Number.isFinite(ver) || ver < 31) return 'granted'; // BLUETOOTH_CONNECT с Android 12 (API 31)

  const perm = (PermissionsAndroid as any)?.PERMISSIONS?.BLUETOOTH_CONNECT;
  if (!perm) return 'granted';

  try {
    const already = await PermissionsAndroid.check(perm);
    if (already) return 'granted';
  } catch {}

  try {
    const res = await PermissionsAndroid.request(perm);
    logger.info('[mediaPermissions] Nearby devices (BLUETOOTH_CONNECT) permission:', res);
    if (res === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    if (res === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'never_ask_again';
    return 'denied';
  } catch (e) {
    logger.warn('[mediaPermissions] Nearby devices permission request failed', e);
    return 'denied';
  }
}

/** Микрофон уже выдан в этой сессии — чтобы горячий путь звонка не ходил в систему лишний раз. */
let micGrantedCache = false;
let cameraGrantedCache = false;

/** Микрофон уже выдан — только проверка, без системного диалога. */
export async function hasMicPermission(): Promise<boolean> {
  if (micGrantedCache) return true;
  try {
    const mic = await Audio.getPermissionsAsync();
    micGrantedCache = mic.status === 'granted';
  } catch {}
  return micGrantedCache;
}

/** Системные диалоги по очереди: два запроса разом Android не показывает, второй молча отклоняется. */
let callPermissionsChain: Promise<unknown> = Promise.resolve();

/**
 * Разрешения для самого звонка, запрашиваются по факту начала разговора.
 *
 * Обычно всё уже выдано на старте (ensureInitialMediaPermissions) и ответ идёт из кэша без
 * диалога. Если там отказали, переспрашиваем в момент, когда причина очевидна: пользователь
 * сам нажал «Позвонить» или «Ответить». Камеру трогаем только для видеозвонка.
 */
export function ensureCallMediaPermissions(opts?: { video?: boolean }): Promise<boolean> {
  const needCamera = opts?.video === true;
  if (micGrantedCache && (!needCamera || cameraGrantedCache)) return Promise.resolve(true);
  const run = callPermissionsChain.then(
    () => ensureCallMediaPermissionsNow(needCamera),
    () => ensureCallMediaPermissionsNow(needCamera),
  );
  callPermissionsChain = run.catch(() => {});
  return run;
}

async function ensureCallMediaPermissionsNow(needCamera: boolean): Promise<boolean> {
  if (micGrantedCache && (!needCamera || cameraGrantedCache)) return true;

  let micOk = micGrantedCache;
  if (!micOk) {
    try {
      const mic = await Audio.getPermissionsAsync();
      micOk = mic.status === 'granted';
      if (!micOk && mic.canAskAgain !== false) {
        const requested = await Audio.requestPermissionsAsync();
        micOk = requested.status === 'granted';
        logger.info('[mediaPermissions] microphone re-requested at call time:', requested.status);
      }
      micGrantedCache = micOk;
    } catch (e) {
      logger.warn('[mediaPermissions] microphone check at call time failed', e);
    }
  }

  if (!needCamera) return micOk;

  let camOk = cameraGrantedCache;
  if (!camOk) {
    try {
      const cam = await Camera.getCameraPermissionsAsync();
      camOk = cam.status === 'granted';
      if (!camOk && cam.canAskAgain !== false) {
        const requested = await Camera.requestCameraPermissionsAsync();
        camOk = requested.status === 'granted';
        logger.info('[mediaPermissions] camera re-requested at call time:', requested.status);
      }
      cameraGrantedCache = camOk;
    } catch (e) {
      logger.warn('[mediaPermissions] camera check at call time failed', e);
    }
  }

  return micOk && camOk;
}

/**
 * Камера и микрофон при первом запуске, сразу после уведомлений: запрос посреди звонка
 * другу мешает больше. Если здесь отказали — переспросит ensureCallMediaPermissions
 * перед захватом в звонке.
 */
export async function ensureInitialMediaPermissions(): Promise<void> {
  try {
    const cam = await Camera.getCameraPermissionsAsync();
    if (cam.status !== 'granted') {
      const requested = await Camera.requestCameraPermissionsAsync();
      logger.info('[mediaPermissions] Camera permission status:', requested.status);
      cameraGrantedCache = requested.status === 'granted';
    } else {
      cameraGrantedCache = true;
    }
  } catch (e) {
    logger.warn('[mediaPermissions] Failed to request camera permission', e);
  }

  try {
    const mic = await Audio.getPermissionsAsync();
    if (mic.status !== 'granted') {
      const requested = await Audio.requestPermissionsAsync();
      logger.info('[mediaPermissions] Microphone permission status:', requested.status);
      micGrantedCache = requested.status === 'granted';
    } else {
      micGrantedCache = true;
    }
  } catch (e) {
    logger.warn('[mediaPermissions] Failed to request microphone permission', e);
  }

  // «Устройства рядом» намеренно НЕ спрашиваем здесь: диалог идёт из модалки с пояснением.
}
