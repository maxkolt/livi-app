import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage extends Document {
  _id: mongoose.Types.ObjectId;
  clientId?: string; // Кастомный ID с фронтенда (msg_...)
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  type: 'text' | 'image' | 'video' | 'document';
  text?: string;
  uri?: string;
  name?: string;
  size?: number;
  timestamp: Date;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>({
  clientId: {
    type: String
  },
  from: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  to: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['text', 'image', 'video', 'document'],
    default: 'text'
  },
  text: {
    type: String,
    default: ''
  },
  uri: {
    type: String,
    default: ''
  },
  name: {
    type: String,
    default: ''
  },
  size: {
    type: Number,
    default: 0
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  read: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Индексы для быстрого поиска
MessageSchema.index({ from: 1, to: 1, timestamp: -1 });
MessageSchema.index({ to: 1, timestamp: -1 });
MessageSchema.index({ from: 1, timestamp: -1 });
MessageSchema.index({ clientId: 1 }); // Для поиска по клиентскому ID

export default mongoose.model<IMessage>('Message', MessageSchema);
