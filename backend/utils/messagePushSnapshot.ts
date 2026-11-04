import type { E2eEnvelope } from './e2eEnvelope';

export type MessagePushSnapshot = {
  type: 'message';
  messageId: string;
  from: string;
  to: string;
  fromNick: string;
  sentAt: string;
  unreadCount: number;
  unreadFromSender: number;
  unreadUpdatedAt: number;
  messagePreview: string;
  enc?: E2eEnvelope;
};

/** FCM reserves `from`. Keep room below its 4096 byte limit for localized media labels. */
export function messagePushSnapshotData(data: MessagePushSnapshot, fcm = false): Record<string, string> {
  const result: Record<string, string> = {
    type: data.type, messageId: data.messageId, to: data.to,
    [fcm ? 'fromUserId' : 'from']: data.from,
    fromNick: data.fromNick, sentAt: data.sentAt,
    unreadCount: String(data.unreadCount),
    unreadFromSender: String(data.unreadFromSender),
    unreadUpdatedAt: String(data.unreadUpdatedAt),
    messagePreview: data.messagePreview,
  };
  if (data.enc) {
    const enc = JSON.stringify(data.enc);
    if (Buffer.byteLength(JSON.stringify({ ...result, enc }), 'utf8') <= 3500) result.enc = enc;
  }
  return result;
}
