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
  type: 'text' | 'image' | 'audio';
  text?: string; // Текст сообщения
  uri?: string; // URL изображения
  name?: string; // original filename (optional)
  size?: number; // bytes (optional)
  duration?: number; // seconds (optional, for audio)
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
  textMessages: IMessageItem[]; // Массив текстовых сообщений
  imageMessages: IMessageItem[]; // Массив сообщений с изображениями
  audioMessages: IMessageItem[]; // Массив голосовых сообщений
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
    enum: ['text', 'image', 'audio'],
    required: true
  },
  text: {
    type: String
  },
  uri: {
    type: String
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
  textMessages: [MessageItemSchema],
  imageMessages: [MessageItemSchema],
  audioMessages: [MessageItemSchema],
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
    ...(this.textMessages || []),
    ...(this.imageMessages || []),
    ...(this.audioMessages || [])
  ];
  
  return allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
};

// Метод для добавления нового сообщения (updateOne вместо save для скорости)
FriendshipMessagesSchema.methods.addMessage = function(message: IMessageItem) {
  const messageArray = this.getMessagesArray(message.type);
  messageArray.push(message);
  this.lastMessage = message;
  this.lastActivity = new Date();

  const path = message.type === 'text' ? 'textMessages' : message.type === 'image' ? 'imageMessages' : 'audioMessages';
  return (this as any).constructor.updateOne(
    { _id: this._id },
    { $push: { [path]: message }, $set: { lastMessage: message, lastActivity: new Date() } }
  ).exec();
};

// Метод для получения массива сообщений по типу
FriendshipMessagesSchema.methods.getMessagesArray = function(type: string) {
  switch (type) {
    case 'text': return this.textMessages;
    case 'image': return this.imageMessages;
    case 'audio': return this.audioMessages || (this.audioMessages = []);
    default: return this.textMessages;
  }
};

// Метод для поиска сообщения по ID
FriendshipMessagesSchema.methods.findMessageById = function(messageId: string) {
  const allMessages = this.getAllMessages();
  return allMessages.find((msg: IMessageItem) => msg.id === messageId);
};

// Метод для удаления сообщения (updateOne с $pull вместо save)
FriendshipMessagesSchema.methods.removeMessage = function(messageId: string) {
  const message = this.findMessageById(messageId);
  if (!message) return Promise.resolve(false);
  const array = this.getMessagesArray(message.type);
  const index = array.findIndex((msg: IMessageItem) => msg.id === messageId);
  if (index === -1) return Promise.resolve(false);
  array.splice(index, 1);

  const path = message.type === 'text' ? 'textMessages' : message.type === 'image' ? 'imageMessages' : 'audioMessages';
  return (this as any).constructor.updateOne(
    { _id: this._id },
    { $pull: { [path]: { id: messageId } }, $set: { lastActivity: new Date() } }
  ).exec().then((r: any) => r.modifiedCount > 0);
};

// Метод для редактирования текстового сообщения (updateOne с $set по elemMatch вместо save)
FriendshipMessagesSchema.methods.updateMessage = function(messageId: string, fromUserId: string, newText: string) {
  const message = this.findMessageById(messageId);
  if (!message || message.type !== 'text') return Promise.resolve(false);
  const fromStr = message.from?.toString?.() || String(message.from);
  if (fromStr !== fromUserId) return Promise.resolve(false);
  const array = this.getMessagesArray('text');
  const index = array.findIndex((msg: IMessageItem) => msg.id === messageId);
  if (index === -1) return Promise.resolve(false);
  array[index].text = newText;
  this.lastActivity = new Date();

  return (this as any).constructor.updateOne(
    { _id: this._id, 'textMessages.id': messageId },
    { $set: { 'textMessages.$.text': newText, lastActivity: new Date() } }
  ).exec().then((r: any) => r.modifiedCount > 0);
};

export default mongoose.model<IFriendshipMessages>('FriendshipMessages', FriendshipMessagesSchema);
