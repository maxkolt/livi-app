import mongoose, { Schema, Document } from 'mongoose';

// Реакция на сообщение (эмодзи + кто поставил)
export interface IMessageReaction {
  emoji: string;
  userId: string;
}

// Ответ на сообщение (цитата)
export interface IReplyTo {
  id: string;   // id сообщения, на которое отвечаем
  text?: string;
  from: string; // userId автора цитируемого сообщения
}

// Интерфейс для отдельного сообщения
export interface IMessageItem {
  id: string; // Уникальный ID сообщения
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  type: 'text' | 'image' | 'audio' | 'sticker';
  text?: string; // Текст сообщения
  uri?: string; // URL изображения (или первое фото альбома)
  uris?: string[]; // Альбом: до 10 URL в одном сообщении
  name?: string; // original filename (optional)
  size?: number; // bytes (optional)
  duration?: number; // seconds (optional, for audio)
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
  timestamp: Date;
  read: boolean;
  reactions?: IMessageReaction[]; // Реакции (эмодзи + userId)
  replyTo?: IReplyTo; // Ответ на сообщение (цитата)
}

// Интерфейс для документа дружбы с сообщениями
export interface IFriendshipMessages extends Document {
  _id: mongoose.Types.ObjectId;
  user1: mongoose.Types.ObjectId; // Первый пользователь
  user2: mongoose.Types.ObjectId; // Второй пользователь
  lastMessage?: IMessageItem; // Последнее сообщение для быстрого доступа
  lastActivity: Date; // Время последней активности
  createdAt: Date;
  updatedAt: Date;
}

// Схема для отдельного сообщения
const MessageItemSchema = new Schema<IMessageItem>({
  id: {
    type: String,
    required: true
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
    enum: ['text', 'image', 'audio', 'sticker'],
    required: true
  },
  text: {
    type: String
  },
  uri: {
    type: String
  },
  uris: {
    type: [String],
    default: undefined
  },
  name: {
    type: String
  },
  size: {
    type: Number
  },
  duration: {
    type: Number
  },
  stickerId: {
    type: String
  },
  stickerPackId: {
    type: String
  },
  stickerEmoji: {
    type: String
  },
  stickerLabel: {
    type: String
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  read: {
    type: Boolean,
    default: false
  },
  reactions: {
    type: [{
      emoji: { type: String, required: true },
      userId: { type: String, required: true }
    }],
    default: undefined
  },
  replyTo: {
    type: {
      id: { type: String, required: true },
      text: String,
      from: { type: String, required: true }
    },
    default: undefined
  }
}, { _id: false }); // Отключаем автоматический _id для вложенных документов

// Основная схема дружбы с сообщениями
const FriendshipMessagesSchema = new Schema<IFriendshipMessages>({
  user1: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  user2: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  lastMessage: MessageItemSchema,
  lastActivity: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Индексы для быстрого поиска
FriendshipMessagesSchema.index({ user1: 1, user2: 1 }, { unique: true });
FriendshipMessagesSchema.index({ user1: 1, lastActivity: -1 });
FriendshipMessagesSchema.index({ user2: 1, lastActivity: -1 });

// Метод для добавления нового сообщения (updateOne вместо save для скорости)
// Full message history lives in FriendshipMessageItem; this document keeps chat metadata.
FriendshipMessagesSchema.methods.addMessage = function(message: IMessageItem) {
  this.lastMessage = message;
  this.lastActivity = new Date();

  return (this as any).constructor.updateOne(
    { _id: this._id },
    { $set: { lastMessage: message, lastActivity: new Date() } }
  ).exec();
};

export default mongoose.model<IFriendshipMessages>('FriendshipMessages', FriendshipMessagesSchema);
