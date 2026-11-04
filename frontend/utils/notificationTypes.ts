import type { CallIncomingPayload } from '../sockets/modules/types';

/** Shared fields delivered by Expo, FCM and the native incoming-call bridge. */
export type PushNotificationData = Partial<CallIncomingPayload> & {
  type?: string;
  fromUserId?: string;
  roomId?: string;
  messageId?: string;
  sentAt?: string;
  messagePreview?: string;
  unreadFromSender?: string | number;
  unreadUpdatedAt?: string | number;
  enc?: unknown;
  /** Producers use platform-specific values; consumers normalize their truthiness. */
  endedFromActive?: unknown;
};
