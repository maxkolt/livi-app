import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import type { ExpoPushTicket } from 'expo-server-sdk';
import PushTokenModel from '../models/PushToken';
import { logger } from './logger';

const expo = new Expo();

type PushKind = 'message' | 'call';

export async function upsertExpoPushToken(opts: {
  userId: string;
  installId?: string;
  platform: 'android' | 'ios';
  token: string;
}) {
  const { userId, installId, platform, token } = opts;
  if (!Expo.isExpoPushToken(token)) {
    throw new Error('invalid_expo_push_token');
  }

  // token уникальный, поэтому upsert делаем по token
  await PushTokenModel.updateOne(
    { token },
    {
      $set: {
        userId,
        installId: String(installId || ''),
        platform,
        token,
        updatedAtMs: Date.now(),
      },
    },
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

