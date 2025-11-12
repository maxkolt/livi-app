import mongoose, { Schema, Document } from 'mongoose';

// Интерфейс для отдельного сообщения
export interface IMessageItem {
  id: string; // Уникальный ID сообщения
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  type: 'text' | 'image';
  text?: string; // Текст сообщения
  uri?: string; // URL изображения
  timestamp: Date;
  read: boolean;
}

// Интерфейс для документа дружбы с сообщениями
export interface IFriendshipMessages extends Document {
  _id: mongoose.Types.ObjectId;
  user1: mongoose.Types.ObjectId; // Первый пользователь
  user2: mongoose.Types.ObjectId; // Второй пользователь
  textMessages: IMessageItem[]; // Массив текстовых сообщений
  imageMessages: IMessageItem[]; // Массив сообщений с изображениями
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
    enum: ['text', 'image'],
    required: true
  },
  text: {
    type: String
  },
  uri: {
    type: String
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  read: {
    type: Boolean,
    default: false
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
  textMessages: [MessageItemSchema],
  imageMessages: [MessageItemSchema],
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

// Метод для получения всех сообщений в хронологическом порядке
FriendshipMessagesSchema.methods.getAllMessages = function() {
  const allMessages = [
    ...this.textMessages,
    ...this.imageMessages
  ];
  
  return allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
};

// Метод для добавления нового сообщения
FriendshipMessagesSchema.methods.addMessage = function(message: IMessageItem) {
  const messageArray = this.getMessagesArray(message.type);
  messageArray.push(message);
  
  // Обновляем последнее сообщение и активность
  this.lastMessage = message;
  this.lastActivity = new Date();
  
  return this.save();
};

// Метод для получения массива сообщений по типу
FriendshipMessagesSchema.methods.getMessagesArray = function(type: string) {
  switch (type) {
    case 'text': return this.textMessages;
    case 'image': return this.imageMessages;
    default: return this.textMessages;
  }
};

// Метод для поиска сообщения по ID
FriendshipMessagesSchema.methods.findMessageById = function(messageId: string) {
  const allMessages = this.getAllMessages();
  return allMessages.find((msg: IMessageItem) => msg.id === messageId);
};

// Метод для удаления сообщения
FriendshipMessagesSchema.methods.removeMessage = function(messageId: string) {
  const message = this.findMessageById(messageId);
  if (message) {
    const array = this.getMessagesArray(message.type);
    const index = array.findIndex((msg: IMessageItem) => msg.id === messageId);
    if (index !== -1) {
      array.splice(index, 1);
      return this.save();
    }
  }
  return false;
};

export default mongoose.model<IFriendshipMessages>('FriendshipMessages', FriendshipMessagesSchema);
