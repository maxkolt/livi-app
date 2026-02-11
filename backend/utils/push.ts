import { readFileSync } from 'fs';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import type { ExpoPushTicket } from 'expo-server-sdk';
import PushTokenModel from '../models/PushToken';
import { logger } from './logger';

const expo = new Expo();

type PushKind = 'message' | 'call';

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
    userId,
    installId: String(installId || ''),
    platform,
    token,
    updatedAtMs: Date.now(),
  };
  if (platform === 'android' && typeof fcmToken === 'string' && fcmToken.length > 0) {
    update.fcmToken = fcmToken;
  }

  await PushTokenModel.updateOne(
    { token },
    { $set: update },
    { upsert: true }
  ).exec();
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
  const recs = await PushTokenModel.find({ userId }).select('token platform fcmToken').lean();
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
  type Rec = { token: string; platform: string; fcmToken?: string };
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
        await messaging.send({
          token: r.fcmToken,
          data: Object.fromEntries(Object.entries(fcmDataPayload).map(([k, v]) => [k, String(v)])),
          android: { priority: 'high' },
          // без notification — только data, чтобы в фоне вызывался onMessageReceived
        });
        logger.info('[push] call push sent via FCM (data-only)', { userId });
      } catch (e) {
        logger.warn('[push] FCM send failed, falling back to Expo for this device', { error: (e as Error)?.message });
        if (Expo.isExpoPushToken(r.token)) expoTokens.push(r.token);
      }
    } else {
      if (Expo.isExpoPushToken(r.token)) expoTokens.push(r.token);
    }
  }

  if (expoTokens.length > 0) {
    logger.info('[push] sendCallPushToRecipient: sending via Expo (fallback or iOS)', { userId, tokenCount: expoTokens.length });
    const messages: ExpoPushMessage[] = expoTokens.map((to) => ({
      to,
      sound: 'default',
      priority: 'high',
      kind: 'call' as PushKind,
      channelId: 'calls',
      categoryId: 'incoming_call',
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
 * Инициатор отменил вызов — шлём callee FCM data-only call_canceled,
 * чтобы на устройстве получателя сразу сняли уведомление и закрыли IncomingCallActivity без мельканий.
 */
export async function sendCallCanceledToRecipient(calleeUserId: string, callId: string): Promise<void> {
  const messaging = getFirebaseMessaging();
  if (!messaging) return;
  const recs = await PushTokenModel.find({ userId: calleeUserId })
    .select('platform fcmToken')
    .lean();
  type Rec = { platform: string; fcmToken?: string };
  const list = (recs || []) as unknown as Rec[];
  for (const r of list) {
    if (r.platform === 'android' && r.fcmToken) {
      try {
        await messaging.send({
          token: r.fcmToken,
          data: { type: 'call_canceled', callId: String(callId) },
          android: { priority: 'high' },
        });
        logger.info('[push] call_canceled sent via FCM (data-only)', { userId: calleeUserId });
        break;
      } catch (e) {
        logger.warn('[push] FCM call_canceled failed', { userId: calleeUserId, error: (e as Error)?.message });
      }
    }
  }
}
