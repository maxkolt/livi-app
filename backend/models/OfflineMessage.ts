import mongoose, { Schema, Document } from 'mongoose';
import { E2eEnvelopeSchema } from './e2eEnvelopeSchema';
import type { E2eEnvelope } from '../utils/e2eEnvelope';

// Интерфейс для офлайн сообщения
export interface IOfflineMessage extends Document {
  _id: mongoose.Types.ObjectId;
  recipientId: mongoose.Types.ObjectId; // ID получателя
  senderId: mongoose.Types.ObjectId; // ID отправителя
  messageId: string; // ID сообщения
  messageData: {
    id: string;
    from: string;
    to: string;
    type: 'text' | 'image' | 'audio' | 'sticker';
    text?: string;
    enc?: E2eEnvelope;
    uri?: string;
    uris?: string[];
    name?: string;
    size?: number;
    duration?: number;
    stickerId?: string;
    stickerPackId?: string;
    stickerEmoji?: string;
    stickerLabel?: string;
    timestamp: Date;
    read: boolean;
    replyTo?: { id: string; text?: string; from: string };
  };
  createdAt: Date;
  /** Аренда на время ожидания ack клиента (см. sockets/offlineMessageDelivery.ts). */
  claimedUntil?: Date | null;
  expiresAt: Date; // Автоматическое удаление через 30 дней
}

// Схема для офлайн сообщения
const OfflineMessageSchema = new Schema<IOfflineMessage>({
  recipientId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  senderId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  messageId: {
    type: String,
    required: true,
    index: true
  },
  messageData: {
    id: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    type: { type: String, enum: ['text', 'image', 'audio', 'sticker'], required: true },
    text: { type: String },
    enc: { type: E2eEnvelopeSchema, default: undefined },
    uri: { type: String },
    uris: { type: [String], default: undefined },
    name: { type: String },
    size: { type: Number },
    duration: { type: Number },
    stickerId: { type: String },
    stickerPackId: { type: String },
    stickerEmoji: { type: String },
    stickerLabel: { type: String },
    timestamp: { type: Date, required: true },
    read: { type: Boolean, default: false },
    replyTo: {
      type: {
        id: { type: String, required: true },
        text: { type: String },
        from: { type: String, required: true },
      },
      required: false,
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  claimedUntil: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 дней
    index: { expireAfterSeconds: 0 }
  }
});

// Составной индекс для быстрого поиска
OfflineMessageSchema.index({ recipientId: 1, createdAt: -1 });

export default mongoose.model<IOfflineMessage>('OfflineMessage', OfflineMessageSchema);

