import mongoose, { Schema, Document } from 'mongoose';

// Интерфейс для текстового сообщения
export interface ITextMessage {
  id: string; // Уникальный ID сообщения
  from: mongoose.Types.ObjectId; // Кто отправил
  text: string; // Текст сообщения
  timestamp: Date; // Время отправки
  read: boolean; // Прочитано ли
}

// Интерфейс для медиа сообщения (картинки, видео, документы)
export interface IMediaMessage {
  id: string; // Уникальный ID сообщения
  from: mongoose.Types.ObjectId; // Кто отправил
  type: 'image' | 'video' | 'document'; // Тип медиа
  uri: string; // URL или путь к файлу
  name: string; // Имя файла
  size: number; // Размер файла
  timestamp: Date; // Время отправки
  read: boolean; // Прочитано ли
}

// Основной интерфейс чата
export interface IChat extends Document {
  _id: mongoose.Types.ObjectId;
  participants: [mongoose.Types.ObjectId, mongoose.Types.ObjectId]; // Два участника чата
  textMessages: ITextMessage[]; // Массив текстовых сообщений
  mediaMessages: IMediaMessage[]; // Массив медиа сообщений
  lastMessageAt: Date; // Время последнего сообщения
  createdAt: Date;
  updatedAt: Date;
}

const TextMessageSchema = new Schema<ITextMessage>({
  id: { type: String, required: true },
  from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
}, { _id: false }); // Отключаем автоматический _id для вложенных объектов

const MediaMessageSchema = new Schema<IMediaMessage>({
  id: { type: String, required: true },
  from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['image', 'video', 'document'], required: true },
  uri: { type: String, required: true },
  name: { type: String, required: true },
  size: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
}, { _id: false }); // Отключаем автоматический _id для вложенных объектов

const ChatSchema = new Schema<IChat>({
  participants: {
    type: [Schema.Types.ObjectId],
    ref: 'User',
    required: true,
    validate: {
      validator: function(participants: mongoose.Types.ObjectId[]) {
        return participants.length === 2;
      },
      message: 'Chat must have exactly 2 participants'
    }
  },
  textMessages: {
    type: [TextMessageSchema],
    default: []
  },
  mediaMessages: {
    type: [MediaMessageSchema],
    default: []
  },
  lastMessageAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Индексы для быстрого поиска
ChatSchema.index({ lastMessageAt: -1 }); // Сортировка по времени последнего сообщения

// Уникальный индекс для пары участников (один чат на пару пользователей)
ChatSchema.index({ participants: 1 }, { unique: true });

// Виртуальное поле для получения всех сообщений в хронологическом порядке
ChatSchema.virtual('allMessages').get(function() {
  const allMessages = [
    ...this.textMessages.map(msg => ({ ...msg.toObject(), type: 'text' })),
    ...this.mediaMessages.map(msg => ({ ...msg.toObject(), type: msg.type }))
  ];
  
  return allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
});

// Метод для добавления текстового сообщения
ChatSchema.methods.addTextMessage = function(messageData: Omit<ITextMessage, 'timestamp' | 'read'>) {
  const message: ITextMessage = {
    ...messageData,
    timestamp: new Date(),
    read: false
  };
  
  this.textMessages.push(message);
  this.lastMessageAt = message.timestamp;
  return message;
};

// Метод для добавления медиа сообщения
ChatSchema.methods.addMediaMessage = function(messageData: Omit<IMediaMessage, 'timestamp' | 'read'>) {
  const message: IMediaMessage = {
    ...messageData,
    timestamp: new Date(),
    read: false
  };
  
  this.mediaMessages.push(message);
  this.lastMessageAt = message.timestamp;
  return message;
};

// Метод для очистки всех сообщений
ChatSchema.methods.clearAllMessages = function() {
  this.textMessages = [];
  this.mediaMessages = [];
  this.lastMessageAt = new Date();
};

// Метод для очистки сообщений только от одного пользователя
ChatSchema.methods.clearMessagesFromUser = function(userId: mongoose.Types.ObjectId) {
  this.textMessages = this.textMessages.filter(msg => !msg.from.equals(userId));
  this.mediaMessages = this.mediaMessages.filter(msg => !msg.from.equals(userId));
  
  // Обновляем время последнего сообщения
  const allMessages = [
    ...this.textMessages,
    ...this.mediaMessages
  ];
  
  if (allMessages.length > 0) {
    this.lastMessageAt = allMessages.reduce((latest, msg) => 
      msg.timestamp > latest ? msg.timestamp : latest, allMessages[0].timestamp
    );
  } else {
    this.lastMessageAt = new Date();
  }
};

export default mongoose.model<IChat>('Chat', ChatSchema);
