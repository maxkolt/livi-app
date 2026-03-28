import { AppState, NativeModules, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { CommonActions } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE, setOutgoingCallScreenVisible, setIncomingCallScreenVisible, setActiveVideoCall, acceptCall, declineCall, ensureSocketConnected, getUnreadCount } from '../sockets/socket';
import { getInstallId } from './installId';
import { logger } from './logger';
import { stopIncomingCallAlert } from './incomingCallAlert';
import { displayIncomingCall, isCallKeepAvailable, sendCallAnsweredBroadcast, launchIncomingCallActivityScreen, addEndedCallId, closeOutgoingCallActivity, notifyCallCanceled, isEndedCallId, isOutgoingDeclineHandled, markOutgoingDeclineHandled, stopIncomingCallRingtoneAndVibration } from './callKeep';
import { emitCloseOutgoingCall, emitCloseHomeModals } from './globalEvents';
import { loadLang, t } from './i18n';

const MISSED_CALLS_KEY = 'missed_calls_by_user_v1';
/** Флаг: пользователь заходил во вкладку «Друзья» и «увидел» пропущенные — бейдж и уведомления в шторке скрываем, счётчики в приложении не трогаем. */
const MISSED_BADGE_CLEARED_KEY = 'missed_calls_badge_cleared_v1';

/** ID категории уведомления входящего звонка с кнопками «Поднять» / «Положить» */
export const INCOMING_CALL_CATEGORY_ID = 'incoming_call';
const PUSH_TOKEN_REGISTER_COOLDOWN_MS = 60_000;

type PushTokenSnapshot = {
  userId: string;
  expoToken: string;
  fcmToken: string;
  atMs: number;
};

type RegisterPushTokenOptions = {
  force?: boolean;
  reason?: 'startup' | 'app_active' | 'socket_reconnect' | 'manual';
};

let lastRegisteredPushToken: PushTokenSnapshot | null = null;
let registerPushInFlight: Promise<void> | null = null;

/** Отметить, что пользователь «увидел» пропущенные (зашёл во вкладку Друзья) — бейдж и шторка будут скрыты. */
export async function setMissedBadgeCleared(): Promise<void> {
  try {
    await AsyncStorage.setItem(MISSED_BADGE_CLEARED_KEY, 'true');
  } catch {}
}

/** Сбросить флаг «увидел» при новом пропущенном — бейдж и шторка снова показываются. */
export async function clearMissedBadgeCleared(): Promise<void> {
  try {
    await AsyncStorage.removeItem(MISSED_BADGE_CLEARED_KEY);
  } catch {}
}

/** На Android: счётчики пропущенных из нативного хранилища (источник истины при FCM). На iOS — пустой объект. */
export async function getMissedCountByUserFromNative(): Promise<Record<string, number>> {
  try {
    if (Platform.OS !== 'android') return {};
    if (!NativeModules.LiviAppModule?.getMissedCountByUserJson) {
      if (__DEV__) console.warn('[push] getMissedCountByUserJson not available on LiviAppModule — rebuild Android app (npm run android:install-all)');
      return {};
    }
    const json = await NativeModules.LiviAppModule.getMissedCountByUserJson();
    if (typeof json !== 'string') return {};
    const parsed = JSON.parse(json || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const key of Object.keys(parsed)) {
      const v = parsed[key];
      if (typeof v === 'number' && v > 0) out[String(key)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Формат времени для уведомления о сообщении: «14:35», «вчера 14:35» или «12.03 14:35». Используем getFullYear (не getYear), чтобы не было багов с годом. */
function formatMessageNotificationTime(d: Date): string {
  const now = new Date();
  const today = now.getDate() === d.getDate() && now.getMonth() === d.getMonth() && now.getFullYear() === d.getFullYear();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday = yesterday.getDate() === d.getDate() && yesterday.getMonth() === d.getMonth() && yesterday.getFullYear() === d.getFullYear();
  const h = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  const time = `${h}:${min}`;
  if (today) return time;
  if (wasYesterday) return `вчера ${time}`;
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month} ${time}`;
}

/** Снять уведомление о сообщениях от одного пользователя (при заходе в чат с ним). */
export async function dismissMessageNotificationForUser(peerId: string): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissMessageNotificationForUser && peerId) {
        NativeModules.LiviAppModule.dismissMessageNotificationForUser(peerId);
      }
      return;
    }
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const data = (n?.request?.content?.data as Record<string, unknown>) || {};
      const type = data?.type;
      const from = String(data?.from ?? data?.fromUserId ?? '').trim();
      if (type === 'message' && from === peerId && n?.request?.identifier) {
        try {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Снять только уведомления о сообщениях в шторке (при заходе во вкладку Друзья). */
export async function dismissMessageNotificationsOnly(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissAllMessageNotifications) {
        NativeModules.LiviAppModule.dismissAllMessageNotifications();
      }
      return;
    }
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const type = (n?.request?.content?.data as Record<string, unknown>)?.type;
      if (type === 'message' && n?.request?.identifier) {
        try {
          await Notifications.dismissNotificationAsync(n.request.identifier);
        } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Снять только уведомления «пропущенный вызов» в шторке (без обнуления счётчиков). Вызывать при заходе в Друзья. Android: нативный список; iOS: Expo getPresentedNotificationsAsync + dismiss по type === 'missed_call'. */
export async function dismissMissedCallNotificationsOnly(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      if (NativeModules.LiviAppModule?.dismissAllMissedCallNotifications) {
        NativeModules.LiviAppModule.dismissAllMissedCallNotifications();
      }
      if (NativeModules.LiviAppModule?.dismissMissedCallNotificationOnly) {
        const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
        const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
        for (const uid of Object.keys(map || {})) {
          if (uid && typeof map[uid] === 'number' && map[uid] > 0) {
            try { NativeModules.LiviAppModule.dismissMissedCallNotificationOnly(String(uid)); } catch (_) {}
          }
        }
      }
      return;
    }
    // iOS: снять только уведомления с data.type === 'missed_call' (Expo показывает их при call_ended)
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const n of presented || []) {
      const type = (n?.request?.content?.data as Record<string, unknown>)?.type;
      if (type === 'missed_call' && n?.request?.identifier) {
        try { await Notifications.dismissNotificationAsync(n.request.identifier); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** Синхронизировать бейдж иконки: непрочитанные сообщения + пропущенные вызовы.
 * Если пользователь «увидел» (зашёл во вкладку Друзья) — бейдж = 0 (на иконке и в шторке ничего не показываем).
 * Иначе бейдж = пропущенные звонки + непрочитанные сообщения.
 */
export async function syncAppBadgeFromMissedCount(): Promise<void> {
  try {
    const cleared = await AsyncStorage.getItem(MISSED_BADGE_CLEARED_KEY);
    if (cleared === 'true') {
      await Notifications.setBadgeCountAsync(0);
      if (Platform.OS === 'android' && NativeModules.LiviAppModule) {
        try { NativeModules.LiviAppModule.clearAllMissedCountsAndSetBadgeZero?.(); } catch (_) {}
        try { NativeModules.LiviAppModule.dismissSummaryNotifications(); } catch (_) {}
      }
      return;
    }
    const raw = await AsyncStorage.getItem(MISSED_CALLS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    const missedTotal = Object.values(map).reduce((s: number, n: unknown) => s + (typeof n === 'number' && n > 0 ? n : 0), 0);
    const unreadResult = await getUnreadCount();
    const unreadTotal = unreadResult?.ok ? Math.max(0, Number(unreadResult.count || 0)) : 0;
    const total = Math.min(99, missedTotal + unreadTotal);
    await Notifications.setBadgeCountAsync(total);
    if (Platform.OS === 'android' && NativeModules.LiviAppModule?.updateSummaryNotifications) {
      try { NativeModules.LiviAppModule.updateSummaryNotifications(missedTotal, unreadTotal); } catch (_) {}
    }
  } catch (e) {
    try { await Notifications.setBadgeCountAsync(0); } catch {}
  }
}

/** Убрать уведомления из шторки и выставить бейдж по пропущенным (после отклонения/завершения звонка). */
export async function clearCallRelatedNotificationsAndSyncBadge(): Promise<void> {
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {}
  await syncAppBadgeFromMissedCount();
}

export async function clearNotificationIndicators() {
  try {
    await Notifications.dismissAllNotificationsAsync();
  } catch {}
  await syncAppBadgeFromMissedCount();
}

// Состояние приложения: для звонков показываем пуш только когда приложение в фоне/убито
let appStateRef = AppState.currentState;
AppState.addEventListener('change', (next) => {
  appStateRef = next;
});

/** Текущий peerId чата, если пользователь сейчас в экране переписки. Устанавливается ChatScreen при фокусе, сбрасывается при уходе. */
export function setCurrentChatPeerId(peerId: string | null): void {
  (global as any).__currentChatPeerId = peerId ?? null;
}

// КРИТИЧНО: Захватываем «последний ответ на уведомление» сразу при загрузке модуля,
// чтобы не потерять его к моменту вызова addNotificationListeners (когда приложение открыто из пуша о звонке).
const lastNotificationResponsePromise = Notifications.getLastNotificationResponseAsync();
export function getColdStartNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return lastNotificationResponsePromise;
}

// Показывать уведомления даже в foreground (для сообщений).
// Для звонков: в активном приложении показываем модалку по сокету; в фоне/убитом — показываем пуш на телефоне.
Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const type = String((n as any)?.request?.content?.data?.type || '');
    // Таймаут или отмена: останавливаем вибрацию (снимаем уведомление), затем показываем «Пропущенный вызов» без вибрации.
    // На Android «Пропущенный вызов» показывается только из нативного кода (LiviFirebaseMessagingService), чтобы не было двух одинаковых уведомлений в шторке.
    if (type === 'call_ended') {
      const data = (n as any)?.request?.content?.data || {};
      const endedFromActive = !!data.endedFromActive;
      if (data?.callId) addEndedCallId(String(data.callId));
      try {
        stopIncomingCallAlert();
      } catch {}
      try {
        await Notifications.dismissAllNotificationsAsync();
      } catch {}
      if (!endedFromActive && Platform.OS !== 'android') {
        const fromNick = String(data.fromNick || '').trim();
        const fromUserId = String(data.from || '');
        try {
          const lang = await loadLang();
          const title = t('missedCallTitle', lang);
          const body = fromNick
            ? t('incomingFromPrefix', lang).replace('{name}', fromNick)
            : t('incomingVideoCallBody', lang);
          await Notifications.scheduleNotificationAsync({
            content: {
              title,
              body,
              data: { type: 'missed_call', from: fromUserId, fromNick },
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 0.2 },
          });
        } catch (e) {
          logger.warn('[push] failed to show missed_call notification', e as any);
        }
      }
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call_declined') {
      const data = (n as any)?.request?.content?.data || {};
      const id = data?.callId ? String(data.callId) : '';
      logger.info('[decline/инициатор] push setNotificationHandler call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
      if (id && isOutgoingDeclineHandled(id)) {
        logger.info('[decline/инициатор] push setNotificationHandler — уже обработан, выходим');
        return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
      }
      if (id) markOutgoingDeclineHandled(id);
      try { closeOutgoingCallActivity(); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { emitCloseOutgoingCall(); } catch {}
      logger.info('[decline/инициатор] push setNotificationHandler: закрыли и emitCloseOutgoingCall');
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call_canceled') {
      const data = (n as any)?.request?.content?.data || {};
      logger.info('[push] call_canceled received (handler)', { callId: data?.callId });
      if (data?.callId) {
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled');
      }
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    if (type === 'call') {
      // На Android входящий звонок показываем только нативным экраном (FCM → IncomingCallActivity + одно уведомление в шторке от foreground-сервиса).
      // Expo-уведомление не показываем, иначе будет два уведомления об одном звонке.
      if (Platform.OS === 'android') {
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
      const showCallNotification = appStateRef !== 'active';
      return {
        shouldShowBanner: showCallNotification,
        shouldShowList: showCallNotification,
        shouldPlaySound: showCallNotification,
        shouldSetBadge: false,
      };
    }
    // Одно уведомление о сообщениях: сверху количество, снизу «От X в HH:MM». Не показывать стандартное Expo.
    if (type === 'message') {
      const data = (n as any)?.request?.content?.data || {};
      const fromId = String(data?.from || data?.fromUserId || '').trim();
      const currentPeer = (global as any).__currentChatPeerId;
      if (fromId && currentPeer && fromId === currentPeer) {
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
      // На Android одно уведомление о сообщении показывается из FCM (От кого HH:MM + превью). Сводное «Непрочитанные сообщения» не показываем.
      if (Platform.OS === 'android') {
        syncAppBadgeFromMissedCount().catch(() => {});
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: true,
          shouldSetBadge: false,
        };
      }
    }
    // Не показывать баннер для необработанных типов — иначе возможно пустое уведомление.
    return {
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

async function waitForNavReady(ms = 9000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const nav = (global as any).__navRef;
    if (nav?.isReady?.()) return nav;
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
}

async function navigateToVideoCallIncoming(peerUserId: string, callId: string) {
  const nav = await waitForNavReady();
  if (!nav) return;
  setActiveVideoCall(true);
  try { emitCloseHomeModals(); } catch {}
  // Push VideoCall поверх текущего экрана (не reset), чтобы после завершения звонка goBack() вернул на тот же экран (Chat, Friends и т.д.).
  nav.navigate('VideoCall' as any, {
    peerUserId,
    directCall: true,
    directInitiator: false,
    callId,
    isIncoming: true,
  });
}

/** Открыть экран входящего звонка (для deep link livi://incoming-call и full-screen intent). */
export async function openIncomingCallScreen(peerUserId: string, callId: string): Promise<void> {
  try {
    stopIncomingCallAlert();
  } catch {}
  await navigateToVideoCallIncoming(peerUserId, callId);
}

/** Открыть приложение и принять звонок (для livi://answer-call из нативного IncomingCallActivity).
 * Сначала навигация на VideoCall, затем session.acceptCall() отправит call:accept — так обработчик call:accepted
 * уже зарегистрирован и соединение гарантированно установится (нет гонки с ранним call:accepted). */
export async function openAnswerCallScreen(peerUserId: string, callId: string): Promise<void> {
  try { setIncomingCallScreenVisible(false); } catch {}
  try {
    stopIncomingCallAlert();
  } catch {}
  try {
    await ensureSocketConnected(5000);
  } catch (e) {
    logger.warn('[push] ensureSocketConnected failed on answer-call', { callId, error: (e as Error)?.message });
  }
  if (Platform.OS === 'android') {
    sendCallAnsweredBroadcast(callId);
  }
  await navigateToVideoCallIncoming(peerUserId, callId);
  try {
    await clearCallRelatedNotificationsAndSyncBadge();
  } catch {}
}

/** После отклонения из вне приложения — увести приложение в фон, чтобы пользователь остался на экране блокировки или в меню телефона. */
function moveAppToBackAfterDecline() {
  if (Platform.OS !== 'android') return;
  try {
    const LiviAppModule = NativeModules.LiviAppModule;
    if (LiviAppModule?.moveTaskToBack) {
      LiviAppModule.moveTaskToBack(true);
    }
  } catch {}
}

/** Отклонить звонок (для livi://decline-call из нативного IncomingCallActivity). Ждём сокет, чтобы call:decline дошёл до сервера и у звонящего завершился вызов. После этого уводим приложение в фон.
 * Отклонение получателем не считается пропущенным вызовом — очищаем last_incoming_from. */
export async function handleDeclineCallFromDeepLink(callId: string): Promise<void> {
  try { setIncomingCallScreenVisible(false); } catch {}
  try {
    stopIncomingCallAlert();
  } catch {}
  // Отклонение с нашей стороны — не пропущенный вызов; сбрасываем маркер, чтобы нигде не считать как пропущенный
  try {
    await AsyncStorage.removeItem('last_incoming_from');
  } catch {}
  try {
    await ensureSocketConnected(5000);
    declineCall(callId);
  } catch (e) {
    logger.warn('[push] declineCall from decline-call deep link failed', { callId, error: (e as Error)?.message });
  }
  await clearCallRelatedNotificationsAndSyncBadge();
  moveAppToBackAfterDecline();
}

/**
 * Обработка ответа на уведомление (тап по уведомлению или по кнопке «Поднять»/«Положить»).
 * actionIdentifier: 'answer' = Поднять, 'decline' = Положить, DEFAULT = тап по телу уведомления.
 */
async function handleNotificationResponse(data: any, actionIdentifier: string) {
  try {
    const type = String(data?.type || '');
    if (!type) return;

    if (type === 'call_declined') {
      const id = data?.callId ? String(data.callId) : '';
      logger.info('[decline/инициатор] push handleNotificationResponse call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
      if (id && isOutgoingDeclineHandled(id)) {
        logger.info('[decline/инициатор] push handleNotificationResponse — уже обработан, выходим');
        return;
      }
      if (id) markOutgoingDeclineHandled(id);
      try { closeOutgoingCallActivity(); } catch {}
      try { setOutgoingCallScreenVisible(false); } catch {}
      try { emitCloseOutgoingCall(); } catch {}
      logger.info('[decline/инициатор] push handleNotificationResponse: закрыли и emitCloseOutgoingCall');
      return;
    }
    if (type === 'call_canceled') {
      logger.info('[push] call_canceled received (handleNotificationResponse)', { callId: data?.callId });
      if (data?.callId) {
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled (response)');
      }
      return;
    }
    if (type === 'call_ended') {
      if (data?.callId) addEndedCallId(String(data.callId));
      if (data?.endedFromActive) {
        await clearCallRelatedNotificationsAndSyncBadge();
        try {
          (global as any).__onCallEndedFromPush?.();
        } catch {}
      }
      return;
    }

    if (type === 'missed_call') {
      const nav = await waitForNavReady();
      if (!nav) return;
      // Сразу помечаем «увидел» и снимаем уведомления в шторке (бейдж и шторка очищаются)
      try {
        await setMissedBadgeCleared();
        await dismissMissedCallNotificationsOnly();
        await clearCallRelatedNotificationsAndSyncBadge();
      } catch {}
      nav.dispatch(
        CommonActions.reset({
          index: 0,
          routes: [{ name: 'Home' as never, params: { openFriendsMenu: true, openFriendsTab: true } }],
        })
      );
      return;
    }

    if (type === 'message') {
      const nav = await waitForNavReady();
      if (!nav) return;
      await clearNotificationIndicators();
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

      const isAnswer = actionIdentifier === 'answer';
      const isDecline = actionIdentifier === 'decline';
      const isDefaultTap = actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;

      if (isDecline) {
        try {
          stopIncomingCallAlert();
        } catch {}
        try {
          await ensureSocketConnected(5000);
          declineCall(callId);
        } catch (e) {
          logger.warn('[push] declineCall from notification failed', { callId, error: (e as Error)?.message });
        }
        await clearCallRelatedNotificationsAndSyncBadge();
        moveAppToBackAfterDecline();
        return;
      }

      if (isAnswer || isDefaultTap) {
        try {
          stopIncomingCallAlert();
        } catch {}
        // Сначала ждём сокет и сообщаем серверу о принятии, чтобы звонящий получил call:accepted и оба попали на видеозвонок
        try {
          await ensureSocketConnected(5000);
          acceptCall(callId);
        } catch (e) {
          logger.warn('[push] acceptCall from notification failed', { callId, error: (e as Error)?.message });
        }
        await navigateToVideoCallIncoming(peerUserId, callId);
        try {
          await clearNotificationIndicators();
        } catch {}
      }
    }
  } catch (e) {
    logger.warn('[push] handleNotificationResponse failed', e as any);
  }
}

/** Устаревший путь: только навигация по data (тап по уведомлению без кнопок). */
async function navigateFromPushData(data: any) {
  await handleNotificationResponse(data, Notifications.DEFAULT_ACTION_IDENTIFIER);
}

export async function ensureAndroidNotificationChannels() {
  if (Platform.OS !== 'android') return;
  const lang = await loadLang();

  // Сообщения
  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Messages',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 150, 80, 150],
    sound: 'default',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  // Звонки (приложение закрыто/в фоне). Та же вибрация, что и при входящем в приложении (incomingCallAlert): [0, 700, 900].
  await Notifications.setNotificationChannelAsync('calls', {
    name: 'Calls',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 700, 900],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });

  // Пропущенный вызов — без вибрации, только текст в шторке
  await Notifications.setNotificationChannelAsync('missed_call', {
    name: t('missedCallTitle', lang),
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0],
    sound: undefined,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/**
 * Регистрирует категорию уведомления входящего звонка: справа две кнопки —
 * «Поднять» (принять), «Отменить» (красная, isDestructive).
 */
async function ensureIncomingCallNotificationCategory() {
  try {
    const lang = await loadLang();
    await Notifications.setNotificationCategoryAsync(INCOMING_CALL_CATEGORY_ID, [
      { identifier: 'answer', buttonTitle: t('answerAction', lang) },
      { identifier: 'decline', buttonTitle: t('cancelCall', lang), options: { isDestructive: true } },
    ]);
    logger.debug('[push] incoming call notification category registered');
  } catch (e) {
    logger.warn('[push] setNotificationCategoryAsync failed', e as any);
  }
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
    await ensureIncomingCallNotificationCategory();
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

export async function registerAndSendPushToken(userId?: string, options?: RegisterPushTokenOptions) {
  if (registerPushInFlight) {
    // Avoid parallel duplicate registrations triggered by app-active + reconnect races.
    await registerPushInFlight;
    return;
  }
  registerPushInFlight = (async () => {
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

      // FCM token (Android): для data-only пуша звонка — бэкенд шлёт в FCM, onMessageReceived вызывается в фоне → нативный экран.
      let fcmToken: string | undefined;
      try {
        const deviceTokenResp = await Notifications.getDevicePushTokenAsync();
        const deviceToken = (deviceTokenResp as any)?.data;
        const deviceType = String((deviceTokenResp as any)?.type || '');
        if (deviceToken && Platform.OS === 'android') {
          fcmToken = String(deviceToken);
          logger.debug('[push] device push token acquired', {
            type: deviceType,
            tokenPrefix: fcmToken.slice(0, 18),
          });
          if (__DEV__) {
            console.log('[push][DEV] DEVICE_PUSH_TOKEN (copy into Firebase Test on device):', fcmToken);
          }
        }
      } catch (e) {
        const msg = String((e as any)?.message || e || '');
        const looksLikeFcmSetupError =
          msg.includes('fcm-credentials') ||
          msg.includes('Default FirebaseApp is not initialized') ||
          msg.includes('FirebaseApp.initializeApp');
        if (__DEV__ && looksLikeFcmSetupError) {
          logger.debug('[push] skipping device push token warning (FCM not configured)', { message: msg.slice(0, 220) });
        } else {
          logger.warn('[push] failed to get device push token', e as any);
        }
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
        logger.debug('[push] expo token acquired', {
          userId,
          tokenPrefix: String(token).slice(0, 18),
          platform: Platform.OS,
          hasProjectId: !!projectId,
        });
      } catch {}

      const installId = await getInstallId();

      const snapshotNow: PushTokenSnapshot = {
        userId: String(userId),
        expoToken: String(token),
        fcmToken: String(fcmToken || ''),
        atMs: Date.now(),
      };
      const last = lastRegisteredPushToken;
      const unchanged =
        !!last &&
        last.userId === snapshotNow.userId &&
        last.expoToken === snapshotNow.expoToken &&
        last.fcmToken === snapshotNow.fcmToken;
      const withinCooldown = !!last && snapshotNow.atMs - last.atMs < PUSH_TOKEN_REGISTER_COOLDOWN_MS;
      const force = options?.force === true;
      if (!force && unchanged && withinCooldown) {
        logger.debug('[push] token registration skipped (unchanged + cooldown)', {
          reason: options?.reason || 'manual',
          cooldownLeftMs: Math.max(0, PUSH_TOKEN_REGISTER_COOLDOWN_MS - (snapshotNow.atMs - (last?.atMs || 0))),
        });
        return;
      }

      // Регистрируем токен на backend. Для Android входящий звонок с кнопками возможен только при отправке fcmToken — бэкенд шлёт FCM data-only.
      const body: Record<string, unknown> = {
        token,
        platform: Platform.OS,
        ...(Platform.OS === 'android' && fcmToken ? { fcmToken } : {}),
      };
      if (Platform.OS === 'android') {
        logger.info('[push] registering token', { hasFcmToken: !!fcmToken });
      }
      const resp = await fetch(`${API_BASE}/api/push-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': String(userId),
          'x-install-id': String(installId),
        },
        body: JSON.stringify(body),
      }).catch((e) => {
        logger.warn('[push] failed to register token (network)', e);
        return null as any;
      });

      try {
        if (resp && typeof resp?.ok === 'boolean') {
          const text = await resp.text().catch(() => '');
          logger.debug('[push] token register response', {
            ok: resp.ok,
            status: resp.status,
            body: text ? text.slice(0, 200) : '',
            reason: options?.reason || 'manual',
          });
          if (resp.ok) {
            lastRegisteredPushToken = snapshotNow;
          }
          if (Platform.OS === 'android' && resp.ok) {
            logger.info('[push] token registered', { hasFcmToken: !!fcmToken });
          }
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
        logger.debug('[push] В dev пуш-токен не зарегистрирован (FCM не настроен). Уведомления о звонках не придут. Собери с google-services.json или проверяй на релизной сборке.', {
          message: msg.slice(0, 220),
        });
        return;
      }

      logger.warn('[push] registerAndSendPushToken error', e as any);
    }
  })();
  try {
    await registerPushInFlight;
  } finally {
    registerPushInFlight = null;
  }
}

export function addNotificationListeners() {
  // Не сбрасываем все уведомления при переходе приложения в активное состояние:
  // иначе уведомление о входящем звонке исчезает, как только пользователь открыл приложение.
  // Очистка происходит при открытии чата (ChatScreen) или при ответе на пуш.
  let appStateRef = AppState.currentState;
  const appStateSub = AppState.addEventListener('change', (next) => {
    try {
      appStateRef = next;
    } catch {}
  });

  // 1) Если приложение было "убито" и открылось по тапу по пушу или по кнопке — используем заранее захваченный ответ
  (async () => {
    try {
      const last = await getColdStartNotificationResponse();
      const data = (last as any)?.notification?.request?.content?.data;
      const actionId = (last as any)?.actionIdentifier ?? Notifications.DEFAULT_ACTION_IDENTIFIER;
      if (data) {
        logger.info('[push] cold start: handling notification response', { type: data?.type, actionId });
        await handleNotificationResponse(data, actionId);
      }
    } catch (e) {
      logger.warn('[push] cold start handle failed', e as any);
    }
  })();

  // 2) Если приложение в фоне/foreground и пользователь нажал на пуш или на кнопку «Поднять»/«Положить»
  const sub2 = Notifications.addNotificationResponseReceivedListener(async (r) => {
    const data = (r as any)?.notification?.request?.content?.data;
    const actionId = (r as any)?.actionIdentifier ?? Notifications.DEFAULT_ACTION_IDENTIFIER;
    if (data) await handleNotificationResponse(data, actionId);
  });

  // При получении пуша о звонке: на Android показываем только нативный IncomingCallActivity
  // (Expo-уведомление скрыто в setNotificationHandler; при FCM пуше экран открывает LiviFirebaseMessagingService).
  const sub1 = Notifications.addNotificationReceivedListener(async (n) => {
    try {
      const data = (n as any)?.request?.content?.data;
      if (data?.type === 'call_declined') {
        const id = data?.callId ? String(data.callId) : '';
        logger.info('[decline/инициатор] push notificationReceived call_declined', { callId: id, alreadyHandled: id ? isOutgoingDeclineHandled(id) : false });
        if (id && isOutgoingDeclineHandled(id)) {
          logger.info('[decline/инициатор] push notificationReceived — уже обработан, выходим');
          return;
        }
        if (id) markOutgoingDeclineHandled(id);
        try { closeOutgoingCallActivity(); } catch {}
        try { setOutgoingCallScreenVisible(false); } catch {}
        try { emitCloseOutgoingCall(); } catch {}
        logger.info('[decline/инициатор] push notificationReceived: закрыли и emitCloseOutgoingCall');
        return;
      }
      if (data?.type === 'call_canceled' && data?.callId) {
        logger.info('[push] call_canceled received (notificationReceived)', { callId: data.callId });
        try { stopIncomingCallRingtoneAndVibration(); } catch {}
        try { setIncomingCallScreenVisible(false); } catch {}
        try { notifyCallCanceled(String(data.callId)); } catch {}
        try { addEndedCallId(String(data.callId)); } catch {}
        logger.info('[push] notifyCallCanceled + addEndedCallId called after call_canceled (received)');
        return;
      }
      if (data?.type === 'call' && data?.callId && data?.from) {
        if (await isEndedCallId(data.callId)) {
          logger.info('[push] incoming call notification ignored (call already ended)', { callId: data.callId });
          return;
        }
        // Пуш «call» пришёл с задержкой (устройство было офлайн): показываем только «Пропущенный вызов», не полноэкранный входящий.
        const STALE_CALL_MS = 22 * 1000; // 22 сек — чуть больше таймаута звонка на сервере (20 сек)
        const ts = data.ts != null ? Number(data.ts) : NaN;
        if (!Number.isNaN(ts) && Date.now() - ts > STALE_CALL_MS) {
          logger.info('[push] incoming call notification treated as stale (delayed delivery)', { callId: data.callId, ts, ageMs: Date.now() - ts });
          try {
            addEndedCallId(String(data.callId));
          } catch {}
          // На Android пропущенный уже показывается нативным кодом (FCM → showMissedCallNotification), не дублируем Expo-уведомлением
          if (Platform.OS !== 'android') {
            const fromNick = String(data.fromNick || '').trim();
            const fromUserId = String(data.from || '');
            try {
              const lang = await loadLang();
              const title = t('missedCallTitle', lang);
              const body = fromNick
                ? t('incomingFromPrefix', lang).replace('{name}', fromNick)
                : t('incomingVideoCallBody', lang);
              await Notifications.scheduleNotificationAsync({
                content: {
                  title,
                  body,
                  data: { type: 'missed_call', from: fromUserId, fromNick },
                },
                trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 0.2 },
              });
            } catch (e) {
              logger.warn('[push] failed to show missed_call for stale call', e as any);
            }
          }
          return;
        }
        logger.info('[push] incoming call notification received', { callId: data.callId, from: data.from });
        if (Platform.OS === 'android') {
          await launchIncomingCallActivityScreen(data.callId, data.from, data.fromNick ?? '', true);
        } else if (isCallKeepAvailable() && AppState.currentState !== 'active') {
          displayIncomingCall(data.callId, data.from, data.fromNick ?? '', true);
        }
        const setFromPush = (global as any).__setIncomingCallFromPush;
        if (typeof setFromPush === 'function') {
          setFromPush(data);
        }
      }
    } catch {}
  });
  return () => {
    sub1.remove();
    sub2.remove();
    try {
      appStateSub.remove();
    } catch {}
  };
}

