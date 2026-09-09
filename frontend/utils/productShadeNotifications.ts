/**
 * Пользовательские уведомления в шторке (не call FGS):
 * заявка в друзья, новая версия приложения.
 * Missed / messages остаются в pushNotifications + native FCM.
 */
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadLang, t } from './i18n';
import { logger } from './logger';
import {
  fetchLatestAppVersion,
  isUpdateAvailable,
  isUpdateReminderCooldownActive,
} from './updateCheck';

export const FRIEND_REQUEST_CHANNEL_ID = 'friend_requests';
export const APP_UPDATE_CHANNEL_ID = 'app_updates';

const APP_UPDATE_SHADE_FOR_LATEST_KEY = 'livi.app_update_shade_for_latest_v1';
const FRIEND_REQUEST_NOTIF_ID_PREFIX = 'friend_req_';

let channelsReady = false;

export async function ensureProductShadeChannels(): Promise<void> {
  if (Platform.OS !== 'android' || channelsReady) return;
  try {
    const lang = await loadLang();
    await Notifications.setNotificationChannelAsync(FRIEND_REQUEST_CHANNEL_ID, {
      name: t('friend_request', lang),
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180],
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    await Notifications.setNotificationChannelAsync(APP_UPDATE_CHANNEL_ID, {
      name: t('updateDownloadNew', lang),
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0],
      sound: undefined,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
    channelsReady = true;
  } catch (e) {
    logger.warn('[productShade] ensure channels failed', e as any);
  }
}

/** Заявка в друзья: в фоне — системное уведомление; в foreground UI уже ловит socket. */
export async function presentFriendRequestShadeNotification(opts: {
  fromUserId: string;
  fromNick?: string | null;
}): Promise<void> {
  const fromUserId = String(opts.fromUserId || '').trim();
  if (!fromUserId) return;
  if (AppState.currentState === 'active') return;
  try {
    await ensureProductShadeChannels();
    const lang = await loadLang();
    const nick = String(opts.fromNick || '').trim();
    const title = t('friend_request', lang);
    const body = nick
      ? t('friend_request_text', lang).replace('{user}', nick)
      : t('friend_request_text', lang).replace('{user}', '…');
    await Notifications.scheduleNotificationAsync({
      identifier: `${FRIEND_REQUEST_NOTIF_ID_PREFIX}${fromUserId}`,
      content: {
        title,
        body,
        data: { type: 'friend_request', from: fromUserId, fromNick: nick },
        ...(Platform.OS === 'android' ? { channelId: FRIEND_REQUEST_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
  } catch (e) {
    logger.warn('[productShade] friend_request failed', e as any);
  }
}

export async function dismissFriendRequestShadeNotifications(): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented) {
      const type = String((n as any)?.request?.content?.data?.type || '');
      const id = String((n as any)?.request?.identifier || '');
      if (type === 'friend_request' || id.startsWith(FRIEND_REQUEST_NOTIF_ID_PREFIX)) {
        await Notifications.dismissNotificationAsync(id);
      }
    }
  } catch (_) {}
}

/**
 * Одна тихая карточка «Скачайте обновление» на latest-версию (без спама).
 * Учитывает тот же 24h кулдаун, что и in-app badge.
 */
export async function presentAppUpdateShadeNotificationIfNeeded(): Promise<void> {
  try {
    if (__DEV__) return;
    const available = await isUpdateAvailable();
    if (!available) return;
    if (await isUpdateReminderCooldownActive()) return;

    const latest = (await fetchLatestAppVersion())?.trim() || '';
    if (latest) {
      const shownFor = await AsyncStorage.getItem(APP_UPDATE_SHADE_FOR_LATEST_KEY);
      if (shownFor && shownFor === latest) return;
    }

    await ensureProductShadeChannels();
    const lang = await loadLang();
    const title = t('updateDownloadNew', lang);
    await Notifications.scheduleNotificationAsync({
      identifier: `app_update_${latest || 'latest'}`,
      content: {
        title,
        body: title,
        data: { type: 'app_update', latest },
        ...(Platform.OS === 'android' ? { channelId: APP_UPDATE_CHANNEL_ID } : {}),
      },
      trigger: null,
    });
    if (latest) {
      await AsyncStorage.setItem(APP_UPDATE_SHADE_FOR_LATEST_KEY, latest);
    }
  } catch (e) {
    logger.warn('[productShade] app_update failed', e as any);
  }
}

export async function dismissAppUpdateShadeNotifications(): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented) {
      const type = String((n as any)?.request?.content?.data?.type || '');
      const id = String((n as any)?.request?.identifier || '');
      if (type === 'app_update' || id.startsWith('app_update_')) {
        await Notifications.dismissNotificationAsync(id);
      }
    }
  } catch (_) {}
}
