import type { MessageReaction } from '../../sockets/modules/reactionOutbox';
import type { ImagePickerAsset } from 'expo-image-picker';

export type ChatTimestamp = Date | string | number;

/** Camera, gallery and shared images provide different subsets of picker metadata. */
export type PickedChatImage = Pick<ImagePickerAsset, 'uri'> &
  Partial<Pick<ImagePickerAsset, 'fileName' | 'fileSize' | 'width' | 'height' | 'mimeType' | 'type'>>;

/**
 * Fields shared by cached messages, optimistic rows and partial action previews.
 * Older cache entries can omit metadata; helpers keep their existing fallbacks.
 * The cache also contains locally generated call rows, not only server messages.
 */
export type ChatMessage = {
  id?: string;
  type?: string;
  text?: string;
  /** Optimistic rows can precede restoration of the local account identity. */
  from?: string | null;
  to?: string;
  sender?: string;
  timestamp?: ChatTimestamp;
  read?: boolean;
  uri?: string;
  /** Older cache versions persisted an album as a JSON string. */
  uris?: string[] | string;
  name?: string;
  size?: number;
  duration?: number;
  thumbUri?: string;
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
  callDirection?: string;
  reactions?: MessageReaction[];
  replyTo?: { id: string; text?: string; from?: string | null; isOwn?: boolean } | null;
  localOnly?: boolean;
  e2eUndecryptable?: boolean;
  __albumForwardOne?: boolean;
};

export type ForwardRecipient = {
  _id: string;
  nick?: string;
  name?: string;
  avatar?: string;
  avatarVer?: number;
  avatarThumbB64?: string;
  online?: boolean;
};
