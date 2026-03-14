import { readFileSync } from 'fs';
import mongoose from 'mongoose';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import type { ExpoPushTicket } from 'expo-server-sdk';
import PushTokenModel from '../models/PushToken';
import { logger } from './logger';
import { pushLog } from './pushLogBuffer';

const expo = new Expo();

type PushKind = 'message' | 'call';

/** Коды ошибок Firebase Admin при невалидном/устаревшем FCM-токене — такой токен нужно снять с записи. */
const FCM_INVALID_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
] as const;

/** Фразы в сообщении об ошибке FCM, по которым считаем токен невалидным. */
const FCM_INVALID_PHRASES = [
  'requested entity was not found',
  'not found',
  'unregistered',
  'registration-token-not-registered',
  'invalid-registration-token',
];

function isFcmInvalidTokenError(e: unknown): boolean {
  const err = e as { message?: string; code?: string; errorInfo?: { message?: string } };
  const msg = String(err?.message ?? err?.errorInfo?.message ?? '').toLowerCase();
  const code = String(err?.code ?? '');
  const raw = String(e).toLowerCase();
  if (FCM_INVALID_TOKEN_CODES.includes(code as any)) return true;
  const fromMsgOrRaw = (phrase: string) => msg.includes(phrase) || raw.includes(phrase);
  return FCM_INVALID_PHRASES.some(fromMsgOrRaw);
}

/** Снимать fcmToken в БД только при явном коде ошибки (не по фразам), чтобы не затирать токен из‑за неоднозначных/временных ошибок. */
function shouldRemoveFcmTokenFromDb(e: unknown): boolean {
  const code = String((e as { code?: string })?.code ?? '');
  return FCM_INVALID_TOKEN_CODES.includes(code as (typeof FCM_INVALID_TOKEN_CODES)[number]);
}

/** Удалить невалидный FCM-токен из БД: по fcmToken (надёжно), иначе по Expo token. */
async function removeInvalidFcmToken(userId: string, r: { token: string; fcmToken?: string }): Promise<boolean> {
  if (!r.fcmToken) return false;
  try {
    let result = await PushTokenModel.updateOne(
      { userId, fcmToken: r.fcmToken },
      { $unset: { fcmToken: 1 }, $set: { updatedAtMs: Date.now() } }
    ).exec();
    let modified = (result as { modifiedCount?: number })?.modifiedCount ?? 0;
    if (modified === 0) {
      result = await PushTokenModel.updateOne(
        { userId, token: r.token },
        { $unset: { fcmToken: 1 }, $set: { updatedAtMs: Date.now() } }
      ).exec();
      modified = (result as { modifiedCount?: number })?.modifiedCount ?? 0;
    }
    if (modified > 0) {
      logger.warn('[push] removed invalid FCM token', { userId, tokenPrefix: String(r.token).slice(0, 20) });
      return true;
    }
    logger.warn('[push] removeInvalidFcmToken: no document matched', { userId, byFcmToken: !!r.fcmToken });
    return false;
  } catch (dbErr) {
    logger.warn('[push] failed to remove invalid FCM token', { userId, error: (dbErr as Error)?.message });
    return false;
  }
}

let firebaseApp: unknown = null;
function getFirebaseMessaging(): { send: (msg: unknown) => Promise<string> } | null {
  if (!firebaseApp) {
    try {
      let cred: object | null = null;
      const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (path) {
        const raw = readFileSync(path, 'utf8');
        cred = JSON.parse(raw) as object;
      } else if (json) {
        cred = JSON.parse(json) as object;
      }
      if (cred) {
        const admin = require('firebase-admin');
        firebaseApp = admin.initializeApp({ credential: admin.credential.cert(cred) });
        logger.info('[push] Firebase Admin initialized (FCM data-only for calls)');
      }
    } catch (e) {
      logger.warn('[push] Firebase Admin init failed (call push will use Expo only)', { error: (e as Error)?.message });
    }
  }
  return firebaseApp ? require('firebase-admin').messaging() : null;
}

export async function upsertExpoPushToken(opts: {
  userId: string;
  installId?: string;
  platform: 'android' | 'ios';
  token: string;
  fcmToken?: string;
}) {
  const { userId, installId, platform, token, fcmToken } = opts;
  if (!Expo.isExpoPushToken(token)) {
    throw new Error('invalid_expo_push_token');
  }

  const update: Record<string, unknown> = {
    userId: new mongoose.Types.ObjectId(userId),
    installId: String(installId || ''),
    platform,
    token,
    updatedAtMs: Date.now(),
  };
  if (platform === 'android' && typeof fcmToken === 'string' && fcmToken.length > 0) {
    update.fcmToken = fcmToken;
  }

  const result = await PushTokenModel.updateOne(
    { token },
    { $set: update },
    { upsert: true }
  ).exec();
  const matched = (result as { matchedCount?: number })?.matchedCount ?? 0;
  const modified = (result as { modifiedCount?: number })?.modifiedCount ?? 0;
  const upsertedId = (result as { upsertedId?: unknown })?.upsertedId;

  if (platform === 'android' && typeof fcmToken === 'string' && fcmToken.length > 0) {
    await PushTokenModel.updateOne(
      { token },
      { $set: { fcmToken, updatedAtMs: Date.now() } }
    ).exec();
  }

  if (platform === 'android' && (update as { fcmToken?: string }).fcmToken) {
    const doc = await PushTokenModel.findOne({ token }).select('_id userId fcmToken').lean();
    const d = doc as { _id?: unknown; userId?: unknown; fcmToken?: string } | null;
    const hasFcmNow = !!(d?.fcmToken && String(d.fcmToken).length > 0);
    const docUserId = d?.userId != null ? String(d.userId) : '';
    pushLog('token_upsert_android_fcm', {
      userId,
      tokenPrefix: String(token).slice(0, 20),
      matched,
      modified,
      hadUpsert: !!upsertedId,
      docId: d?._id != null ? String(d._id) : '',
      docUserId,
      userIdMatch: docUserId === userId,
      fcmLen: d?.fcmToken != null ? String(d.fcmToken).length : 0,
    });
    if (!hasFcmNow) {
      logger.warn('[push] upsertExpoPushToken: fcmToken not persisted after update', { userId, tokenPrefix: String(token).slice(0, 20) });
      pushLog('token_upsert_fcm_missing_after', { userId });
    }
  }
}

/** Пуш о новом сообщении: на Android — только FCM (data-only), чтобы не было пустого уведомления от Expo; на iOS — Expo. */
export async function sendMessagePushToUser(
  userId: string,
  data: {
    type: 'message';
    messageId: string;
    from: string;
    to: string;
    fromNick: string;
    sentAt: string;
    unreadCount: number;
    messagePreview: string;
  }
): Promise<void> {
  const dataStr = {
    type: data.type,
    messageId: data.messageId,
    from: data.from,
    to: data.to,
    fromNick: data.fromNick,
    sentAt: data.sentAt,
    unreadCount: String(data.unreadCount),
    messagePreview: data.messagePreview,
  };
  const messaging = getFirebaseMessaging();
  const recs = await PushTokenModel.find({ userId }).select('token platform fcmToken').lean();
  type Rec = { token: string; platform: string; fcmToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: dataStr,
            android: { priority: 'high' },
          });
          logger.info('[push] message sent via FCM (data-only)', { userId });
          androidSent = true;
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(userId, r);
          logger.warn('[push] FCM message failed', { userId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
  const iosTokens = list.filter((r) => r.platform === 'ios').map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));
  const androidTokens = list.filter((r) => r.platform === 'android').map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));

  if (iosTokens.length > 0) {
    try {
      const messages: ExpoPushMessage[] = iosTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        channelId: 'messages',
        data: { ...dataStr, unreadCount: data.unreadCount },
      }));
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        await expo.sendPushNotificationsAsync(chunk);
      }
      logger.info('[push] message sent via Expo (iOS)', { userId, count: iosTokens.length });
    } catch (e) {
      logger.warn('[push] Expo message failed', { userId, error: (e as Error)?.message });
    }
  }

  // Fallback для Android: если FCM не сработал — шлём через Expo с заполненными title/body (пустых уведомлений не должно быть).
  if (!androidSent && androidTokens.length > 0) {
    const timeStr = formatPushTime(data.sentAt);
    const nick = (data.fromNick || '').trim() || '—';
    const title = `${nick} ${timeStr}`.trim() || 'Новое сообщение';
    const body = (data.messagePreview || '').trim() || 'Новое сообщение';
    try {
      const messages: ExpoPushMessage[] = androidTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        channelId: 'messages',
        title,
        body,
        data: { ...dataStr, unreadCount: data.unreadCount },
      }));
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) {
        await expo.sendPushNotificationsAsync(chunk);
      }
      logger.info('[push] message sent via Expo (Android fallback)', { userId, count: androidTokens.length });
    } catch (e) {
      logger.warn('[push] Expo Android fallback failed', { userId, error: (e as Error)?.message });
    }
  }
}

/** Форматирует ISO время в HH:mm (локальная зона сервера для fallback-уведомления). */
function formatPushTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return `${h}:${m}`;
  } catch {
    return '';
  }
}

export async function sendPushToUser(userId: string, msg: Omit<ExpoPushMessage, 'to'> & { kind: PushKind }) {
  try {
    const recs = await PushTokenModel.find({ userId }).select('token').lean();
    const tokens = (recs || [])
      .map((r: any) => String(r.token || ''))
      .filter((t) => Expo.isExpoPushToken(t));

    if (!tokens.length) {
      logger.warn('[push] sendPushToUser: no tokens for user', { userId, kind: msg.kind });
      return;
    }

    logger.info('[push] sendPushToUser: sending', { userId, kind: msg.kind, tokenCount: tokens.length });

    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      sound: 'default',
      priority: 'high',
      ...msg,
    }));

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const receipts: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);
        // Мягкий лог — без спама
        if (receipts.some((r) => r.status === 'error')) {
          logger.warn('[push] Some push receipts contain errors', {
            errors: receipts
              .filter((r) => r.status === 'error')
              .slice(0, 3)
              .map((r) => {
                const anyR = r as any;
                return { message: anyR?.message, details: anyR?.details };
              }),
          });
        }
      } catch (e) {
        logger.warn('[push] sendPushNotificationsAsync failed', e as any);
      }
    }
  } catch (e) {
    logger.warn('[push] sendPushToUser failed', e as any);
  }
}

/** Данные входящего звонка для пуша */
export type CallPushData = {
  callId: string;
  from: string;
  fromNick: string;
};

/**
 * Отправка пуша о входящем звонке: на Android с FCM-токеном — data-only через FCM (onMessageReceived в фоне),
 * остальным — через Expo (без title/body). Так нативный экран звонка показывается при убитом/фоновом приложении.
 */
export async function sendCallPushToRecipient(userId: string, data: CallPushData): Promise<void> {
  const userIdObj = new mongoose.Types.ObjectId(userId);
  const recs = await PushTokenModel.find({ userId: userIdObj })
    .read('primary')
    .select('_id token platform fcmToken')
    .lean();
  if (!recs?.length) {
    logger.warn('[push] sendCallPushToRecipient: no tokens for user', { userId });
    return;
  }

  const fcmData = {
    type: 'call',
    callId: data.callId,
    from: data.from,
    fromNick: data.fromNick || '',
  };
  // FCM data payload: ключ "from" зарезервирован, используем fromUserId для FCM
  const fcmDataPayload: Record<string, string> = {
    type: 'call',
    callId: data.callId,
    fromUserId: data.from,
    fromNick: data.fromNick || '',
  };

  const messaging = getFirebaseMessaging();
  type Rec = { _id?: unknown; token: string; platform: string; fcmToken?: string };
  const list = recs as unknown as Rec[];
  const androidWithFcm = list.filter((r) => r.platform === 'android' && r.fcmToken).length;
  const androidTotal = list.filter((r) => r.platform === 'android').length;
  logger.info('[push] sendCallPushToRecipient', {
    userId,
    hasFirebase: !!messaging,
    androidTokensWithFcm: androidWithFcm,
    androidTokensTotal: androidTotal,
    totalTokens: list.length,
  });
  const androidRecs = list.filter((r) => r.platform === 'android');
  pushLog('sendCallPushToRecipient_start', {
    userId,
    hasFirebase: !!messaging,
    androidTokensWithFcm: androidWithFcm,
    androidTokensTotal: androidTotal,
    totalTokens: list.length,
    ...(androidTotal > 0
      ? {
          androidTokens: androidRecs.map((r) => ({
            docId: r._id != null ? String(r._id) : '',
            tokenPrefix: String(r.token).slice(0, 24),
            hasFcm: !!(r.fcmToken && String(r.fcmToken).length > 0),
            fcmLen: r.fcmToken != null ? String(r.fcmToken).length : 0,
          })),
        }
      : {}),
  });
  if (!messaging && androidTotal > 0) {
    logger.warn('[push] FCM not configured (FIREBASE_SERVICE_ACCOUNT_JSON missing or invalid). Call pushes will use Expo only — native incoming call screen may NOT show when app is in background.');
  }
  if (messaging && androidTotal > 0 && androidWithFcm === 0) {
    logger.warn('[push] No Android FCM tokens for user — call push will use Expo. Ensure app registered push token with fcmToken (open app, check token register 200 OK).');
  }

  const expoTokens: string[] = [];
  for (const r of list) {
    if (r.platform === 'android' && r.fcmToken && messaging) {
      try {
        // data-only (без notification) — в фоне вызывается onMessageReceived. high priority — доставка без задержек.
        // Не задаём collapseKey — каждый звонок доставляется отдельно, без «схлопывания» с предыдущим.
        await messaging.send({
          token: r.fcmToken,
          data: Object.fromEntries(Object.entries(fcmDataPayload).map(([k, v]) => [k, String(v)])),
          android: {
            priority: 'high',
            // collapseKey не задаём — иначе FCM может отложить/объединить пуши звонков
          },
        });
        logger.info('[push] call push sent via FCM (data-only, high priority)', { userId });
        pushLog('call_push_sent_via_FCM', { userId });
      } catch (e) {
        const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
        const errCode = (e as { code?: string })?.code;
        // Явно по тексту ошибки: Firebase часто отдаёт "Requested entity was not found." при невалидном токене
        const isInvalidToken =
          isFcmInvalidTokenError(e) ||
          /requested entity was not found|not found|unregistered|invalid.registration.token/i.test(errMsg);
        logger.warn('[push] FCM call push error', { userId, errMsg, errCode, isInvalidToken });
        if (shouldRemoveFcmTokenFromDb(e)) {
          const removed = await removeInvalidFcmToken(userId, r);
          if (!removed) logger.warn('[push] FCM invalid token not removed (no match in DB)', { userId });
        } else if (!isInvalidToken) {
          logger.warn('[push] FCM send failed, falling back to Expo for this device', { error: errMsg });
          pushLog('call_push_FCM_failed_fallback_Expo', { userId, errMsg });
        }
        if (Expo.isExpoPushToken(r.token)) expoTokens.push(r.token);
      }
    } else {
      if (Expo.isExpoPushToken(r.token)) expoTokens.push(r.token);
    }
  }

  if (expoTokens.length > 0) {
    logger.info('[push] sendCallPushToRecipient: sending via Expo (fallback or iOS)', { userId, tokenCount: expoTokens.length });
    pushLog('call_push_sending_via_Expo', { userId, tokenCount: expoTokens.length });
    const callTitle = (data.fromNick || '').trim() || 'Входящий видеозвонок';
    const callBody = 'Входящий видеозвонок';
    const messages: ExpoPushMessage[] = expoTokens.map((to) => ({
      to,
      sound: 'default',
      priority: 'high',
      kind: 'call' as PushKind,
      channelId: 'calls',
      categoryId: 'incoming_call',
      title: callTitle,
      body: callBody,
      data: { ...fcmData, categoryId: 'incoming_call', tag: 'incoming_call' },
    }));
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (e) {
        logger.warn('[push] sendCallPushToRecipient Expo failed', e as any);
      }
    }
  }
}

/**
 * Получатель отклонил вызов — шлём caller FCM data-only call_declined,
 * чтобы на устройстве звонящего сразу закрыли OutgoingCallActivity (сокет в фоне может быть отключён).
 * Если FCM не доходит — шлём через Expo, клиент закроет экран из addNotificationReceivedListener.
 */
export async function sendCallDeclinedToCaller(callerUserId: string, callId: string): Promise<void> {
  logger.info('[push] sendCallDeclinedToCaller start', { callerUserId, callId });
  const messaging = getFirebaseMessaging();
  if (messaging) {
    const recs = await PushTokenModel.find({ userId: callerUserId })
      .select('token platform fcmToken')
      .lean();
    type Rec = { token: string; platform: string; fcmToken?: string };
    const list = (recs || []) as unknown as Rec[];
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: { type: 'call_declined', callId: String(callId) },
            android: { priority: 'high' },
          });
          logger.info('[push] call_declined sent via FCM (data-only) to caller', { userId: callerUserId });
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(callerUserId, r);
          logger.warn('[push] FCM call_declined to caller failed', { userId: callerUserId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
  try {
    await sendPushToUser(callerUserId, {
      kind: 'message',
      title: 'Звонок отклонён',
      body: 'Собеседник отклонил вызов',
      data: { type: 'call_declined', callId: String(callId) },
    });
    logger.info('[push] call_declined sent via Expo to caller', { userId: callerUserId });
  } catch (e) {
    logger.warn('[push] Expo call_declined to caller failed', { userId: callerUserId, error: (e as Error)?.message });
  }
}

/**
 * Абонент принял вызов, а инициатор офлайн (сокет отключён) — шлём инициатору call_accepted.
 * Отправляем через Expo (sendPushToUser), т.к. на устройстве пуши приходят в формате body — так же, как call_ended.
 * Дублируем прямым FCM на случай, если у инициатора только fcmToken без Expo token.
 */
export async function sendCallAcceptedToCaller(callerUserId: string, callId: string): Promise<void> {
  try {
    await sendPushToUser(callerUserId, {
      kind: 'call',
      data: { type: 'call_accepted', callId: String(callId) },
    });
    logger.info('[push] call_accepted sent via Expo to caller', { userId: callerUserId, callId });
  } catch (e) {
    logger.warn('[push] Expo call_accepted to caller failed', { userId: callerUserId, error: (e as Error)?.message });
  }
  const messaging = getFirebaseMessaging();
  if (messaging) {
    const recs = await PushTokenModel.find({ userId: callerUserId })
      .select('token platform fcmToken')
      .lean();
    type Rec = { token: string; platform: string; fcmToken?: string };
    const list = (recs || []) as unknown as Rec[];
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: { type: 'call_accepted', callId: String(callId) },
            android: { priority: 'high' },
          });
          logger.info('[push] call_accepted sent via FCM (data-only) to caller', { userId: callerUserId, callId });
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(callerUserId, r);
          logger.warn('[push] FCM call_accepted to caller failed', { userId: callerUserId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
}

/**
 * Инициатор отменил вызов — шлём callee FCM data-only call_canceled (Android), Expo только на iOS.
 * Иначе на Android приходят два уведомления: нативное по FCM и системное по Expo.
 */
export async function sendCallCanceledToRecipient(
  calleeUserId: string,
  callId: string,
  fromUserId: string,
  fromNick?: string
): Promise<void> {
  logger.info('[push] sendCallCanceledToRecipient start', { calleeUserId, callId, fromUserId });
  const messaging = getFirebaseMessaging();
  const recs = await PushTokenModel.find({ userId: calleeUserId })
    .select('token platform fcmToken')
    .lean();
  type Rec = { token: string; platform: string; fcmToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: {
              type: 'call_canceled',
              callId: String(callId),
              fromUserId: String(fromUserId),
              fromNick: String(fromNick ?? ''),
            },
            android: { priority: 'high' },
          });
          logger.info('[push] call_canceled sent via FCM (data-only)', { userId: calleeUserId });
          androidSent = true;
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(calleeUserId, r);
          logger.warn('[push] FCM call_canceled failed', { userId: calleeUserId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
  const iosTokens = list.filter((r) => r.platform === 'ios').map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));
  if (iosTokens.length > 0) {
    try {
      const title = 'Пропущенный видеозвонок';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий видеозвонок';
      const messages: ExpoPushMessage[] = iosTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        title,
        body,
        data: { type: 'call_canceled', callId: String(callId), from: fromUserId, fromNick: fromNick ?? '' },
      }));
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) await expo.sendPushNotificationsAsync(chunk);
      logger.info('[push] call_canceled sent via Expo (iOS)', { userId: calleeUserId, count: iosTokens.length });
    } catch (e) {
      logger.warn('[push] Expo call_canceled to callee failed', { userId: calleeUserId, error: (e as Error)?.message });
    }
  }
  if (!androidSent && list.some((r) => r.platform === 'android')) {
    try {
      const title = 'Пропущенный видеозвонок';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий видеозвонок';
      await sendPushToUser(calleeUserId, {
        kind: 'message',
        title,
        body,
        data: { type: 'call_canceled', callId: String(callId), from: fromUserId, fromNick: fromNick ?? '' },
      });
      logger.info('[push] call_canceled sent via Expo (Android fallback)');
    } catch (e) {
      logger.warn('[push] Expo call_canceled Android fallback failed', { userId: calleeUserId, error: (e as Error)?.message });
    }
  }
}
