import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import type { ExpoPushTicket } from 'expo-server-sdk';
import PushTokenModel from '../models/PushToken';
import { logger } from './logger';
import { pushLog } from './pushLogBuffer';

const expo = new Expo();
const IOS_VOIP_BUNDLE_ID = String(process.env.APNS_BUNDLE_ID || 'com.kolt12max.livi').trim();
const IOS_VOIP_PRODUCTION = !/^(0|false|no)$/i.test(String(process.env.APNS_PRODUCTION || 'true'));

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
let apnsProvider: {
  send: (notification: unknown, recipients: string | string[]) => Promise<{
    sent: Array<{ device: string }>;
    failed: Array<{ device?: string; status?: number; response?: { reason?: string } }>;
  }>;
} | null = null;
let apnsInitAttempted = false;

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

function getApnsVoipProvider():
  | {
      send: (notification: unknown, recipients: string | string[]) => Promise<{
        sent: Array<{ device: string }>;
        failed: Array<{ device?: string; status?: number; response?: { reason?: string } }>;
      }>;
    }
  | null {
  if (apnsProvider || apnsInitAttempted) return apnsProvider;
  apnsInitAttempted = true;
  try {
    const keyId = String(process.env.APNS_KEY_ID || '').trim();
    const teamId = String(process.env.APNS_TEAM_ID || '').trim();
    const keyPath = String(process.env.APNS_AUTH_KEY_PATH || '').trim();
    const keyBase64 = String(process.env.APNS_AUTH_KEY_BASE64 || '').trim();
    const key = keyPath
      ? readFileSync(keyPath, 'utf8')
      : keyBase64
        ? Buffer.from(keyBase64, 'base64').toString('utf8')
        : '';
    if (!keyId || !teamId || !key) {
      logger.warn('[push] APNs VoIP init skipped (missing APNS_* env)');
      return null;
    }
    // `apn` does not ship stable TS types, so keep the provider loosely typed here.
    const apn = require('apn') as {
      Provider: new (opts: {
        token: { key: string; keyId: string; teamId: string };
        production: boolean;
      }) => typeof apnsProvider;
    };
    apnsProvider = new apn.Provider({
      token: { key, keyId, teamId },
      production: IOS_VOIP_PRODUCTION,
    }) as typeof apnsProvider;
    logger.info('[push] APNs VoIP provider initialized', {
      bundleId: IOS_VOIP_BUNDLE_ID,
      production: IOS_VOIP_PRODUCTION,
    });
  } catch (e) {
    logger.warn('[push] APNs VoIP init failed', { error: (e as Error)?.message });
    apnsProvider = null;
  }
  return apnsProvider;
}

function shouldRemoveVoipToken(failure: { status?: number; response?: { reason?: string } }): boolean {
  const status = Number(failure?.status || 0);
  const reason = String(failure?.response?.reason || '');
  return (
    status === 400 ||
    status === 410 ||
    reason === 'BadDeviceToken' ||
    reason === 'DeviceTokenNotForTopic' ||
    reason === 'Unregistered'
  );
}

async function removeInvalidVoipToken(userId: string, rec: { token: string; voipToken?: string }): Promise<boolean> {
  if (!rec.voipToken) return false;
  try {
    let result = await PushTokenModel.updateOne(
      { userId, voipToken: rec.voipToken },
      { $unset: { voipToken: 1 }, $set: { updatedAtMs: Date.now() } }
    ).exec();
    let modified = (result as { modifiedCount?: number })?.modifiedCount ?? 0;
    if (modified === 0) {
      result = await PushTokenModel.updateOne(
        { userId, token: rec.token },
        { $unset: { voipToken: 1 }, $set: { updatedAtMs: Date.now() } }
      ).exec();
      modified = (result as { modifiedCount?: number })?.modifiedCount ?? 0;
    }
    if (modified > 0) {
      logger.warn('[push] removed invalid VoIP token', { userId, tokenPrefix: String(rec.token).slice(0, 20) });
      return true;
    }
  } catch (e) {
    logger.warn('[push] failed to remove invalid VoIP token', { userId, error: (e as Error)?.message });
  }
  return false;
}

async function sendVoipPushToRecipient(
  userId: string,
  recs: Array<{ token: string; voipToken?: string }>,
  payload: Record<string, string>,
  opts?: { expirationMs?: number }
): Promise<number> {
  const provider = getApnsVoipProvider();
  if (!provider) return 0;
  const targets = recs.filter((r) => typeof r.voipToken === 'string' && r.voipToken.length > 0);
  if (!targets.length) return 0;

  let sent = 0;
  for (const rec of targets) {
    try {
      const apn = require('apn') as {
        Notification: new () => {
          topic: string;
          pushType: string;
          priority: number;
          expiry?: number;
          payload: Record<string, string>;
        };
      };
      const note = new apn.Notification();
      note.topic = `${IOS_VOIP_BUNDLE_ID}.voip`;
      note.pushType = 'voip';
      note.priority = 10;
      if (opts?.expirationMs && opts.expirationMs > 0) {
        note.expiry = Math.max(0, Math.floor(opts.expirationMs / 1000));
      }
      note.payload = payload;
      const result = await provider.send(note, rec.voipToken as string);
      sent += result.sent?.length || 0;
      for (const failure of result.failed || []) {
        if (shouldRemoveVoipToken(failure)) {
          await removeInvalidVoipToken(userId, rec);
        }
        logger.warn('[push] APNs VoIP push failed', {
          userId,
          status: failure?.status,
          reason: failure?.response?.reason || '',
        });
      }
    } catch (e) {
      logger.warn('[push] APNs VoIP send failed', { userId, error: (e as Error)?.message });
    }
  }
  return sent;
}

const CALL_PUSH_MAX_ATTEMPTS = 3;
const CALL_PUSH_RETRY_BASE_DELAY_MS = 700;
const CALL_PUSH_ESCALATION_TTL_SECONDS = 15;
const CALL_PUSH_NOTIFICATION_TTL_SECONDS = 15;
const PUSH_TOKEN_STALE_TTL_MS = Math.max(24 * 60 * 60 * 1000, Number(process.env.PUSH_TOKEN_STALE_TTL_MS || 45 * 24 * 60 * 60 * 1000));
const MAX_PUSH_TOKENS_PER_USER_PLATFORM = Math.max(2, Number(process.env.MAX_PUSH_TOKENS_PER_USER_PLATFORM || 4));

export function getCallKitUuid(callId: string): string {
  const hex = createHash('sha1').update(String(callId || '')).digest('hex');
  const base = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return base.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFcmCallPushError(e: unknown): boolean {
  if (isFcmInvalidTokenError(e) || shouldRemoveFcmTokenFromDb(e)) return false;
  const code = String((e as { code?: string })?.code ?? '').toLowerCase();
  const msg = String(
    (e as { message?: string; errorInfo?: { message?: string } })?.message ??
      (e as { errorInfo?: { message?: string } })?.errorInfo?.message ??
      ''
  ).toLowerCase();
  if (
    code === 'messaging/internal-error' ||
    code === 'messaging/server-unavailable' ||
    code === 'messaging/unknown-error' ||
    code === 'messaging/quota-exceeded' ||
    code === 'app/network-error'
  ) {
    return true;
  }
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('temporarily unavailable') ||
    msg.includes('server unavailable') ||
    msg.includes('internal error') ||
    msg.includes('network')
  );
}

async function sendCallPushViaFcmWithRetry(
  messaging: { send: (msg: unknown) => Promise<string> },
  token: string,
  dataPayload: Record<string, string>,
  userId: string
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CALL_PUSH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await messaging.send({
        token,
        data: dataPayload,
        android: {
          priority: 'high',
        },
      });
      if (attempt > 1) {
        pushLog('call_push_sent_via_FCM_after_retry', { userId, attempt });
      }
      return;
    } catch (e) {
      lastError = e;
      const retryable = isRetryableFcmCallPushError(e);
      if (!retryable || attempt >= CALL_PUSH_MAX_ATTEMPTS) break;
      const delayMs = CALL_PUSH_RETRY_BASE_DELAY_MS * attempt;
      logger.warn('[push] FCM call push attempt failed, retry scheduled', {
        userId,
        attempt,
        delayMs,
        error: String((e as Error)?.message ?? ''),
      });
      pushLog('call_push_fcm_retry_scheduled', { userId, attempt, delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'unknown_fcm_error'));
}

async function pruneStalePushTokensForUser(opts: {
  userId: string;
  platform: 'android' | 'ios';
  currentToken: string;
  installId: string;
}): Promise<void> {
  const userIdObj = new mongoose.Types.ObjectId(opts.userId);
  const installId = String(opts.installId || '').trim();
  const now = Date.now();
  const staleBeforeMs = now - PUSH_TOKEN_STALE_TTL_MS;

  // 1) Same install + same platform should keep only current token.
  if (installId) {
    try {
      const dupRes = await PushTokenModel.deleteMany({
        userId: userIdObj,
        platform: opts.platform,
        installId,
        token: { $ne: opts.currentToken },
      }).exec();
      const deleted = (dupRes as { deletedCount?: number })?.deletedCount ?? 0;
      if (deleted > 0) {
        logger.info('[push] pruned duplicate tokens for install', {
          userId: opts.userId,
          platform: opts.platform,
          deleted,
        });
      }
    } catch (e) {
      logger.warn('[push] prune duplicate install tokens failed', {
        userId: opts.userId,
        platform: opts.platform,
        error: (e as Error)?.message,
      });
    }
  }

  // 2) Remove stale tokens by age.
  try {
    const staleRes = await PushTokenModel.deleteMany({
      userId: userIdObj,
      platform: opts.platform,
      updatedAtMs: { $lt: staleBeforeMs },
      token: { $ne: opts.currentToken },
    }).exec();
    const deleted = (staleRes as { deletedCount?: number })?.deletedCount ?? 0;
    if (deleted > 0) {
      logger.info('[push] pruned stale tokens by ttl', {
        userId: opts.userId,
        platform: opts.platform,
        deleted,
        staleTtlMs: PUSH_TOKEN_STALE_TTL_MS,
      });
    }
  } catch (e) {
    logger.warn('[push] prune stale tokens failed', {
      userId: opts.userId,
      platform: opts.platform,
      error: (e as Error)?.message,
    });
  }

  // 3) Keep bounded count of freshest tokens per user/platform.
  try {
    const docs = await PushTokenModel.find({
      userId: userIdObj,
      platform: opts.platform,
    })
      .select('_id token updatedAtMs')
      .sort({ updatedAtMs: -1 })
      .lean();

    const list = (docs || []) as Array<{ _id?: unknown; token?: string }>;
    if (list.length <= MAX_PUSH_TOKENS_PER_USER_PLATFORM) return;

    const toDelete = list
      .slice(MAX_PUSH_TOKENS_PER_USER_PLATFORM)
      .filter((d) => String(d.token || '') !== opts.currentToken)
      .map((d) => d._id)
      .filter(Boolean);

    if (toDelete.length === 0) return;

    const capRes = await PushTokenModel.deleteMany({ _id: { $in: toDelete } }).exec();
    const deleted = (capRes as { deletedCount?: number })?.deletedCount ?? 0;
    if (deleted > 0) {
      logger.info('[push] pruned tokens by cap', {
        userId: opts.userId,
        platform: opts.platform,
        deleted,
        maxPerUserPlatform: MAX_PUSH_TOKENS_PER_USER_PLATFORM,
      });
    }
  } catch (e) {
    logger.warn('[push] prune tokens by cap failed', {
      userId: opts.userId,
      platform: opts.platform,
      error: (e as Error)?.message,
    });
  }
}

export async function upsertExpoPushToken(opts: {
  userId: string;
  installId?: string;
  platform: 'android' | 'ios';
  token: string;
  fcmToken?: string;
  voipToken?: string;
}) {
  const { userId, installId, platform, token, fcmToken, voipToken } = opts;
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
  if (platform === 'ios' && typeof voipToken === 'string' && voipToken.length > 0) {
    update.voipToken = voipToken;
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
  if (platform === 'ios' && typeof voipToken === 'string' && voipToken.length > 0) {
    await PushTokenModel.updateOne(
      { token },
      { $set: { voipToken, updatedAtMs: Date.now() } }
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

  await pruneStalePushTokensForUser({
    userId,
    platform,
    currentToken: token,
    installId: String(installId || ''),
  });
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
  // FCM v1: ключ "from" в data payload зарезервирован — иначе Invalid data payload key: from
  const dataStrFcm: Record<string, string> = {
    type: dataStr.type,
    messageId: dataStr.messageId,
    fromUserId: data.from,
    to: dataStr.to,
    fromNick: dataStr.fromNick,
    sentAt: dataStr.sentAt,
    unreadCount: dataStr.unreadCount,
    messagePreview: dataStr.messagePreview,
  };
  const messaging = getFirebaseMessaging();
  const recs = await PushTokenModel.find({ userId }).select('token platform fcmToken voipToken').lean();
  type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: dataStrFcm,
            android: { priority: 'high' },
          });
          logger.info('[push] message sent via FCM (data-only)', { userId });
          androidSent = true;
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          const isPayloadKeyError = /invalid data payload key/i.test(errMsg);
          // Не снимаем fcmToken при ошибке пуша сообщения — иначе следующий звонок не получит FCM (androidTokensWithFcm=0).
          // Удаление только при ошибке call push (sendCallPushToRecipient и т.д.).
          logger.warn('[push] FCM message failed', {
            userId,
            error: errMsg,
            isInvalidToken: isInvalidToken && !isPayloadKeyError,
          });
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
  createdAtMs: number;
  expiresAtMs: number;
  media?: 'audio' | 'video';
};

/**
 * Отправка пуша о входящем звонке: на Android с FCM-токеном — data-only через FCM (onMessageReceived в фоне),
 * остальным — через Expo (без title/body). Так нативный экран звонка показывается при убитом/фоновом приложении.
 */
export async function sendCallPushToRecipient(userId: string, data: CallPushData): Promise<void> {
  const userIdObj = new mongoose.Types.ObjectId(userId);
  const recs = await PushTokenModel.find({ userId: userIdObj })
    .read('primary')
    .select('_id token platform fcmToken voipToken')
    .lean();
  if (!recs?.length) {
    logger.warn('[push] sendCallPushToRecipient: no tokens for user', { userId });
    return;
  }

  const callTs = Number(data.createdAtMs) > 0 ? Number(data.createdAtMs) : Date.now();
  const callExpiresAtMs = Number(data.expiresAtMs) > 0 ? Number(data.expiresAtMs) : callTs + 27_000;
  const callKitId = getCallKitUuid(data.callId);
  const callMedia = data.media === 'audio' ? 'audio' : 'video';
  const fcmData = {
    type: 'call',
    callId: data.callId,
    callKitId,
    from: data.from,
    fromNick: data.fromNick || '',
    media: callMedia,
    ts: String(callTs),
    expiresAt: String(callExpiresAtMs),
  };
  // FCM data payload: ключ "from" зарезервирован, используем fromUserId для FCM
  const fcmDataPayload: Record<string, string> = {
    type: 'call',
    callId: data.callId,
    callKitId,
    fromUserId: data.from,
    fromNick: data.fromNick || '',
    media: callMedia,
    ts: String(callTs),
    expiresAt: String(callExpiresAtMs),
  };

  const messaging = getFirebaseMessaging();
  type Rec = { _id?: unknown; token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = recs as unknown as Rec[];
  const androidWithFcm = list.filter((r) => r.platform === 'android' && r.fcmToken).length;
  const androidTotal = list.filter((r) => r.platform === 'android').length;
  const iosWithVoip = list.filter((r) => r.platform === 'ios' && r.voipToken).length;
  logger.info('[push] sendCallPushToRecipient', {
    userId,
    hasFirebase: !!messaging,
    androidTokensWithFcm: androidWithFcm,
    androidTokensTotal: androidTotal,
    iosTokensWithVoip: iosWithVoip,
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
  let androidDataSignalSent = 0;
  let androidNotificationSignalSent = 0;
  let iosVoipSent = 0;
  for (const r of list) {
    if (r.platform === 'android' && r.fcmToken && messaging) {
      try {
        // data-only (без notification) — в фоне вызывается onMessageReceived. high priority — доставка без задержек.
        // Не задаём collapseKey — каждый звонок доставляется отдельно, без «схлопывания» с предыдущим.
        await sendCallPushViaFcmWithRetry(
          messaging,
          r.fcmToken,
          Object.fromEntries(Object.entries(fcmDataPayload).map(([k, v]) => [k, String(v)])),
          userId
        );
        pushLog('call_push_sent_via_FCM', { userId });
        androidDataSignalSent += 1;
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
          logger.warn('[push] FCM call push failed — not falling back to Expo for Android (would show small notification without Accept/Decline)', { error: errMsg });
          pushLog('call_push_FCM_failed_no_Expo_fallback', { userId, errMsg });
        }
      }

      // Для Android больше не шлём notification payload по звонкам.
      // Иначе при отложенной доставке после оффлайна система может показать
      // "Откройте, чтобы ответить" для уже просроченного звонка.
      // Оставляем только data-only FCM: клиент сам решает incoming vs missed по expiresAt/ts.
    } else if (r.platform !== 'android') {
      // Только iOS получает звонок через Expo (с кнопками через categoryId).
      if (Expo.isExpoPushToken(r.token)) expoTokens.push(r.token);
    }
  }

  if (iosWithVoip > 0) {
    iosVoipSent = await sendVoipPushToRecipient(
      userId,
      list.filter((r) => r.platform === 'ios'),
      {
        type: 'call',
        callId: data.callId,
        callKitId,
        from: data.from,
        fromNick: data.fromNick || '',
        ts: String(callTs),
        expiresAt: String(callExpiresAtMs),
      },
      { expirationMs: callExpiresAtMs }
    );
    pushLog('call_push_sent_via_apns_voip', {
      userId,
      callId: data.callId,
      iosVoipSent,
      iosTokensWithVoip: iosWithVoip,
    });
  }

  if (androidTotal > 0) {
    logger.info('[push] sendCallPushToRecipient Android dual signals', {
      userId,
      callId: data.callId,
      androidDataSignalSent,
      androidNotificationSignalSent,
      androidTokensTotal: androidTotal,
    });
    pushLog('call_push_android_dual_signals', {
      userId,
      callId: data.callId,
      androidDataSignalSent,
      androidNotificationSignalSent,
      androidTokensTotal: androidTotal,
    });
  }

  if (expoTokens.length > 0 && iosVoipSent === 0) {
    logger.info('[push] sendCallPushToRecipient: sending via Expo (iOS fallback)', {
      userId,
      tokenCount: expoTokens.length,
      iosVoipSent,
    });
    pushLog('call_push_sending_via_Expo', { userId, tokenCount: expoTokens.length });
    const callTitle = (data.fromNick || '').trim() || 'Входящий вызов';
    const callBody = 'Входящий вызов';
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
 * Эскалация входящего звонка (fallback-path):
 * - Android FCM data-only (high priority, короткий TTL);
 * - без Android notification payload/Expo fallback для call, чтобы исключить
 *   системное "Откройте, чтобы ответить" на просроченных звонках.
 * Используется сервером, когда ACK incoming_shown не получен в срок.
 */
export async function sendCallEscalationPushToRecipient(
  userId: string,
  data: CallPushData
): Promise<{ androidTargets: number; fcmSent: number; expoSent: number }> {
  const userIdObj = new mongoose.Types.ObjectId(userId);
  const recs = await PushTokenModel.find({ userId: userIdObj })
    .read('primary')
    .select('_id token platform fcmToken voipToken')
    .lean();
  if (!recs?.length) return { androidTargets: 0, fcmSent: 0, expoSent: 0 };

  type Rec = { _id?: unknown; token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = recs as unknown as Rec[];
  const androidRecs = list.filter((r) => r.platform === 'android');
  const androidTargets = androidRecs.length;
  if (!androidTargets) return { androidTargets: 0, fcmSent: 0, expoSent: 0 };

  const messaging = getFirebaseMessaging();
  const callTs = Number(data.createdAtMs) > 0 ? Number(data.createdAtMs) : Date.now();
  const callExpiresAtMs = Number(data.expiresAtMs) > 0 ? Number(data.expiresAtMs) : callTs + 27_000;
  const callKitId = getCallKitUuid(data.callId);
  const dataPayload: Record<string, string> = {
    type: 'call',
    callId: data.callId,
    callKitId,
    fromUserId: data.from,
    fromNick: data.fromNick || '',
    ts: String(callTs),
    expiresAt: String(callExpiresAtMs),
    escalation: '1',
  };

  let fcmSent = 0;
  let expoSent = 0;

  if (messaging) {
    for (const r of androidRecs) {
      if (!r.fcmToken) continue;
      try {
        await messaging.send({
          token: r.fcmToken,
          data: dataPayload,
          android: {
            priority: 'high',
            ttl: CALL_PUSH_ESCALATION_TTL_SECONDS * 1000,
          },
        });
        fcmSent += 1;
      } catch (e) {
        const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
        const isInvalidToken =
          isFcmInvalidTokenError(e) ||
          /requested entity was not found|not found|unregistered|invalid.registration.token/i.test(errMsg);
        if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(userId, r);
        logger.warn('[push] FCM call escalation failed', { userId, callId: data.callId, error: errMsg, isInvalidToken });
      }
    }
  }

  // Android Expo fallback intentionally disabled for call escalation.
  // Expo notification payload can surface stale "answer" card after offline recovery.

  logger.info('[push] call escalation push sent', {
    userId,
    callId: data.callId,
    androidTargets,
    fcmSent,
    expoSent,
    hasFirebase: !!messaging,
  });
  pushLog('call_push_escalation_sent', {
    userId,
    callId: data.callId,
    androidTargets,
    fcmSent,
    expoSent,
    hasFirebase: !!messaging,
  });
  return { androidTargets, fcmSent, expoSent };
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
      .select('token platform fcmToken voipToken')
      .lean();
    type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
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
      .select('token platform fcmToken voipToken')
      .lean();
    type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
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
    .select('token platform fcmToken voipToken')
    .lean();
  type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  const iosVoipRecs = list.filter((r) => r.platform === 'ios' && r.voipToken);
  if (iosVoipRecs.length > 0) {
    const voipSent = await sendVoipPushToRecipient(
      calleeUserId,
      iosVoipRecs,
      {
        type: 'call_canceled',
        callId: String(callId),
        callKitId: getCallKitUuid(callId),
        fromUserId: String(fromUserId),
        fromNick: String(fromNick ?? ''),
      }
    );
    pushLog('call_canceled_sent_via_apns_voip', { userId: calleeUserId, callId, voipSent });
  }
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: {
              type: 'call_canceled',
              callId: String(callId),
              callKitId: getCallKitUuid(callId),
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
      const title = 'Пропущенный вызов';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий вызов';
      const messages: ExpoPushMessage[] = iosTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        title,
        body,
        data: {
          type: 'call_canceled',
          callId: String(callId),
          callKitId: getCallKitUuid(callId),
          from: fromUserId,
          fromNick: fromNick ?? '',
        },
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
      const title = 'Пропущенный вызов';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий вызов';
      await sendPushToUser(calleeUserId, {
        kind: 'message',
        title,
        body,
        data: {
          type: 'call_canceled',
          callId: String(callId),
          callKitId: getCallKitUuid(callId),
          from: fromUserId,
          fromNick: fromNick ?? '',
        },
      });
      logger.info('[push] call_canceled sent via Expo (Android fallback)');
    } catch (e) {
      logger.warn('[push] Expo call_canceled Android fallback failed', { userId: calleeUserId, error: (e as Error)?.message });
    }
  }
}

/**
 * Таймаут входящего (пропущенный): Android — FCM data-only call_ended (нативное summary в шторке),
 * iOS — Expo с title/body. Без endedFromActive — клиент показывает «пропущенный», а не «звонок завершён».
 */
export async function sendCallMissedToRecipient(
  calleeUserId: string,
  callId: string,
  fromUserId: string,
  fromNick?: string
): Promise<void> {
  logger.info('[push] sendCallMissedToRecipient start', { calleeUserId, callId, fromUserId });
  const messaging = getFirebaseMessaging();
  const recs = await PushTokenModel.find({ userId: calleeUserId })
    .select('token platform fcmToken voipToken')
    .lean();
  type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  const callKitId = getCallKitUuid(callId);
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: {
              type: 'call_ended',
              callId: String(callId),
              callKitId,
              fromUserId: String(fromUserId),
              fromNick: String(fromNick ?? ''),
            },
            android: { priority: 'high' },
          });
          logger.info('[push] call_ended (missed/timeout) sent via FCM (data-only)', { userId: calleeUserId, callId });
          androidSent = true;
          pushLog('call_missed_sent_via_FCM', { userId: calleeUserId, callId });
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(calleeUserId, r);
          logger.warn('[push] FCM call_ended (missed) failed', { userId: calleeUserId, callId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
  const iosTokens = list.filter((r) => r.platform === 'ios').map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));
  if (iosTokens.length > 0) {
    try {
      const title = 'Пропущенный вызов';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий вызов';
      const messages: ExpoPushMessage[] = iosTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        title,
        body,
        channelId: 'missed_call',
        data: {
          type: 'call_ended',
          callId: String(callId),
          callKitId,
          from: fromUserId,
          fromNick: fromNick ?? '',
        },
      }));
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) await expo.sendPushNotificationsAsync(chunk);
      logger.info('[push] call_ended (missed) sent via Expo (iOS)', { userId: calleeUserId, count: iosTokens.length });
    } catch (e) {
      logger.warn('[push] Expo call_ended (missed) to callee failed', { userId: calleeUserId, error: (e as Error)?.message });
    }
  }
  if (!androidSent && list.some((r) => r.platform === 'android')) {
    try {
      const title = 'Пропущенный вызов';
      const body = fromNick?.trim() ? `От ${fromNick.trim()}` : 'Входящий вызов';
      await sendPushToUser(calleeUserId, {
        kind: 'call',
        title,
        body,
        channelId: 'missed_call',
        data: {
          type: 'call_ended',
          callId: String(callId),
          callKitId,
          from: fromUserId,
          fromNick: fromNick ?? '',
        },
      });
      logger.info('[push] call_ended (missed) sent via Expo (Android fallback)', { userId: calleeUserId, callId });
    } catch (e) {
      logger.warn('[push] Expo call_ended (missed) Android fallback failed', {
        userId: calleeUserId,
        error: (e as Error)?.message,
      });
    }
  }
}

/**
 * Активный звонок завершён другим участником.
 * Android получает только FCM data-only, чтобы закрыть PiP/экран без видимого системного уведомления.
 * На iOS оставляем Expo push, чтобы сохранить текущую доставку в фоне/убитом приложении.
 */
export async function sendCallEndedToPeer(
  peerUserId: string,
  callId: string,
  fromUserId: string,
  fromNick?: string
): Promise<void> {
  logger.info('[push] sendCallEndedToPeer start', { peerUserId, callId, fromUserId });
  const messaging = getFirebaseMessaging();
  const recs = await PushTokenModel.find({ userId: peerUserId })
    .select('token platform fcmToken voipToken')
    .lean();
  type Rec = { token: string; platform: string; fcmToken?: string; voipToken?: string };
  const list = (recs || []) as unknown as Rec[];
  let androidSent = false;
  const iosVoipRecs = list.filter((r) => r.platform === 'ios' && r.voipToken);
  if (iosVoipRecs.length > 0) {
    const voipSent = await sendVoipPushToRecipient(
      peerUserId,
      iosVoipRecs,
      {
        type: 'call_ended',
        callId: String(callId),
        callKitId: getCallKitUuid(callId),
        fromUserId: String(fromUserId),
        fromNick: String(fromNick ?? ''),
        endedFromActive: 'true',
      }
    );
    pushLog('call_ended_sent_via_apns_voip', { userId: peerUserId, callId, voipSent });
  }
  if (messaging) {
    for (const r of list) {
      if (r.platform === 'android' && r.fcmToken) {
        try {
          await messaging.send({
            token: r.fcmToken,
            data: {
              type: 'call_ended',
              callId: String(callId),
              callKitId: getCallKitUuid(callId),
              fromUserId: String(fromUserId),
              fromNick: String(fromNick ?? ''),
              endedFromActive: 'true',
            },
            android: { priority: 'high' },
          });
          logger.info('[push] call_ended sent via FCM (data-only)', { userId: peerUserId, callId });
          androidSent = true;
        } catch (e) {
          const errMsg = String((e as Error)?.message ?? (e as { errorInfo?: { message?: string } })?.errorInfo?.message ?? '');
          const isInvalidToken =
            isFcmInvalidTokenError(e) || /requested entity was not found|not found|unregistered/i.test(errMsg);
          if (shouldRemoveFcmTokenFromDb(e)) await removeInvalidFcmToken(peerUserId, r);
          logger.warn('[push] FCM call_ended failed', { userId: peerUserId, callId, error: errMsg, isInvalidToken });
        }
      }
    }
  }
  const iosTokens = list.filter((r) => r.platform === 'ios').map((r) => r.token).filter((t) => Expo.isExpoPushToken(t));
  if (iosTokens.length > 0) {
    try {
      const messages: ExpoPushMessage[] = iosTokens.map((to) => ({
        to,
        sound: 'default',
        priority: 'high',
        title: 'Звонок завершён',
        body: 'Собеседник завершил разговор',
        data: {
          type: 'call_ended',
          from: fromUserId,
          fromNick: fromNick ?? '',
          callId: String(callId),
          callKitId: getCallKitUuid(callId),
          endedFromActive: true,
        },
      }));
      const chunks = expo.chunkPushNotifications(messages);
      for (const chunk of chunks) await expo.sendPushNotificationsAsync(chunk);
      logger.info('[push] call_ended sent via Expo (iOS)', { userId: peerUserId, callId, count: iosTokens.length });
    } catch (e) {
      logger.warn('[push] Expo call_ended to peer failed', { userId: peerUserId, callId, error: (e as Error)?.message });
    }
  }
  if (!androidSent && list.some((r) => r.platform === 'android')) {
    logger.warn('[push] call_ended Android fallback skipped to avoid visible system notification', { userId: peerUserId, callId });
  }
}
