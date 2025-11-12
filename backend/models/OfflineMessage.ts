import mongoose, { Schema, Document } from 'mongoose';

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
    type: 'text' | 'image';
    text?: string;
    uri?: string;
    timestamp: Date;
    read: boolean;
  };
  createdAt: Date;
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
    type: { type: String, enum: ['text', 'image'], required: true },
    text: { type: String },
    uri: { type: String },
    timestamp: { type: Date, required: true },
    read: { type: Boolean, default: false }
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
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

