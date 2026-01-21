import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { API_BASE } from '../sockets/socket';
import { getInstallId } from './installId';
import { logger } from './logger';

// Показывать уведомления даже в foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function waitForNavReady(ms = 9000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const nav = (global as any).__navRef;
    if (nav?.isReady?.()) return nav;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function navigateFromPushData(data: any) {
  try {
    const type = String(data?.type || '');
    if (!type) return;

    const nav = await waitForNavReady();
    if (!nav) return;

    if (type === 'message') {
      const peerId = String(data?.from || '');
      const peerName = String(data?.fromNick || '').trim() || '—';
      if (!peerId) return;
      nav.navigate('Chat', { peerId, peerName } as any);
      return;
    }

    if (type === 'call') {
      const peerUserId = String(data?.from || '');
      const callId = String(data?.callId || '');
      if (!peerUserId) return;
      nav.navigate('VideoCall', {
        peerUserId,
        directCall: true,
        directInitiator: false,
        ...(callId ? { callId } : {}),
      } as any);
      return;
    }
  } catch (e) {
    logger.warn('[push] navigateFromPushData failed', e as any);
  }
}

export async function ensureAndroidNotificationChannels() {
  if (Platform.OS !== 'android') return;

  // Сообщения
  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 150, 80, 150],
    sound: 'default',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  // Звонки (как "очень важное уведомление", не CallKit)
  await Notifications.setNotificationChannelAsync('calls', {
    name: 'Calls',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 600, 400, 600, 400, 600],
    sound: 'default',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/**
 * Requests OS notification permission on startup (Android 13+ and iOS).
 * On older Android versions there is no runtime prompt, but this will still
 * return the current permission status.
 */
export async function ensureInitialNotificationPermissions(): Promise<void> {
  try {
    await ensureAndroidNotificationChannels();
  } catch {}

  try {
    const settings = await Notifications.getPermissionsAsync();
    let finalStatus = settings.status;
    if (finalStatus !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      finalStatus = req.status;
    }
    logger.info('[push] notification permission status:', finalStatus);
  } catch (e) {
    logger.warn('[push] Failed to request notification permissions', e as any);
  }
}

export async function registerAndSendPushToken(userId?: string) {
  try {
    if (!userId) return;

    await ensureAndroidNotificationChannels();

    const settings = await Notifications.getPermissionsAsync();
    let finalStatus = settings.status;
    if (finalStatus !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      finalStatus = req.status;
    }
    if (finalStatus !== 'granted') {
      logger.info('[push] permission not granted');
      return;
    }

    // Получаем Expo push token
    const projectId =
      (Constants.expoConfig as any)?.extra?.eas?.projectId ||
      (Constants as any)?.easConfig?.projectId;

    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenResp?.data;
    if (!token) return;
    try {
      logger.info('[push] expo token acquired', {
        userId,
        tokenPrefix: String(token).slice(0, 18),
        platform: Platform.OS,
        hasProjectId: !!projectId,
      });
    } catch {}

    const installId = await getInstallId();

    // Регистрируем токен на backend
    const resp = await fetch(`${API_BASE}/api/push-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': String(userId),
        'x-install-id': String(installId),
      },
      body: JSON.stringify({
        token,
        platform: Platform.OS,
      }),
    }).catch((e) => {
      logger.warn('[push] failed to register token (network)', e);
      return null as any;
    });

    try {
      if (resp && typeof resp?.ok === 'boolean') {
        const text = await resp.text().catch(() => '');
        logger.info('[push] token register response', {
          ok: resp.ok,
          status: resp.status,
          body: text ? text.slice(0, 200) : '',
        });
      }
    } catch {}
  } catch (e: any) {
    // Dev-only noise suppression:
    // In dev builds, Firebase/FCM is often not configured, so expo-notifications may throw.
    // This should not spam logs during everyday debugging.
    const msg = String(e?.message || e || '');
    const looksLikeFcmSetupError =
      msg.includes('fcm-credentials') ||
      msg.includes('Default FirebaseApp is not initialized') ||
      msg.includes('FirebaseApp.initializeApp');

    if (__DEV__ && looksLikeFcmSetupError) {
      logger.debug('[push] Skipping push token registration warning in dev (FCM not configured)', {
        message: msg.slice(0, 220),
      });
      return;
    }

    logger.warn('[push] registerAndSendPushToken error', e as any);
  }
}

export function addNotificationListeners() {
  // 1) Если приложение было "убито" и открылось по тапу по пушу
  (async () => {
    try {
      const last = await Notifications.getLastNotificationResponseAsync();
      const data = (last as any)?.notification?.request?.content?.data;
      if (data) await navigateFromPushData(data);
    } catch {}
  })();

  // 2) Если приложение в фоне/foreground и пользователь нажал на пуш
  const sub2 = Notifications.addNotificationResponseReceivedListener(async (r) => {
    const data = (r as any)?.notification?.request?.content?.data;
    if (data) await navigateFromPushData(data);
  });

  // (опционально) можно слушать received для аналитики
  const sub1 = Notifications.addNotificationReceivedListener((_n) => {});
  return () => {
    sub1.remove();
    sub2.remove();
  };
}

