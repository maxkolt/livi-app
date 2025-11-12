import mongoose from 'mongoose';
import Chat, { IChat, ITextMessage, IMediaMessage } from '../models/Chat';

/**
 * Получить или создать чат между двумя пользователями
 */
export async function getOrCreateChat(userId1: string, userId2: string): Promise<IChat> {
  const participants = [
    new mongoose.Types.ObjectId(userId1),
    new mongoose.Types.ObjectId(userId2)
  ].sort(); // Сортируем для консистентности

  let chat = await Chat.findOne({ participants });
  
  if (!chat) {
    chat = new Chat({ participants });
    await chat.save();
  }
  
  return chat;
}

/**
 * Добавить текстовое сообщение в чат
 */
export async function addTextMessage(
  userId1: string, 
  userId2: string, 
  fromUserId: string, 
  messageId: string, 
  text: string
): Promise<ITextMessage> {
  const chat = await getOrCreateChat(userId1, userId2);
  
  const message = chat.addTextMessage({
    id: messageId,
    from: new mongoose.Types.ObjectId(fromUserId),
    text
  });
  
  await chat.save();
  return message;
}

/**
 * Добавить медиа сообщение в чат
 */
export async function addMediaMessage(
  userId1: string,
  userId2: string,
  fromUserId: string,
  messageId: string,
  type: 'image' | 'video' | 'document',
  uri: string,
  name: string,
  size: number
): Promise<IMediaMessage> {
  const chat = await getOrCreateChat(userId1, userId2);
  
  const message = chat.addMediaMessage({
    id: messageId,
    from: new mongoose.Types.ObjectId(fromUserId),
    type,
    uri,
    name,
    size
  });
  
  await chat.save();
  return message;
}

/**
 * Получить все сообщения между двумя пользователями
 */
export async function getChatMessages(
  userId1: string, 
  userId2: string, 
  limit: number = 50, 
  offset: number = 0
): Promise<any[]> {
  const chat = await Chat.findOne({ 
    participants: [
      new mongoose.Types.ObjectId(userId1),
      new mongoose.Types.ObjectId(userId2)
    ].sort()
  });
  
  if (!chat) {
    return [];
  }
  
  // Получаем все сообщения и сортируем по времени
  const allMessages = [
    ...chat.textMessages.map(msg => ({
      id: msg.id,
      from: msg.from,
      to: chat.participants.find(p => !p.equals(msg.from)),
      type: 'text' as const,
      text: msg.text,
      timestamp: msg.timestamp,
      read: msg.read
    })),
    ...chat.mediaMessages.map(msg => ({
      id: msg.id,
      from: msg.from,
      to: chat.participants.find(p => !p.equals(msg.from)),
      type: msg.type,
      uri: msg.uri,
      name: msg.name,
      size: msg.size,
      timestamp: msg.timestamp,
      read: msg.read
    }))
  ];
  
  // Сортируем по времени (новые в конце)
  allMessages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  
  // Применяем пагинацию
  return allMessages.slice(offset, offset + limit);
}

/**
 * Очистить все сообщения в чате (для обоих пользователей)
 */
export async function clearChatMessages(userId1: string, userId2: string): Promise<boolean> {
  try {
    const chat = await Chat.findOne({ 
      participants: [
        new mongoose.Types.ObjectId(userId1),
        new mongoose.Types.ObjectId(userId2)
      ].sort()
    });

    if (!chat) {
      return false;
    }

    chat.clearAllMessages();
    await chat.save();

    return true;
  } catch (error) {
    console.error('[clearChatMessages] error:', error);
    return false;
  }
}

/**
 * Очистить сообщения только от одного пользователя
 */
export async function clearChatMessagesFromUser(
  fromUserId: string, 
  toUserId: string
): Promise<boolean> {
  try {
    const chat = await Chat.findOne({ 
      participants: [
        new mongoose.Types.ObjectId(fromUserId),
        new mongoose.Types.ObjectId(toUserId)
      ].sort()
    });

    if (!chat) {
      return false;
    }

    chat.clearMessagesFromUser(new mongoose.Types.ObjectId(fromUserId));
    await chat.save();

    return true;
  } catch (error) {
    console.error('[clearChatMessagesFromUser] error:', error);
    return false;
  }
}

/**
 * Отметить сообщения как прочитанные
 */
export async function markMessagesAsRead(
  userId1: string, 
  userId2: string, 
  readerUserId: string
): Promise<boolean> {
  try {
    const chat = await Chat.findOne({ 
      participants: [
        new mongoose.Types.ObjectId(userId1),
        new mongoose.Types.ObjectId(userId2)
      ].sort()
    });
    
    if (!chat) {
      return false;
    }
    
    const readerId = new mongoose.Types.ObjectId(readerUserId);
    
    // Отмечаем как прочитанные только сообщения, которые НЕ от читателя
    chat.textMessages.forEach(msg => {
      if (!msg.from.equals(readerId)) {
        msg.read = true;
      }
    });
    
    chat.mediaMessages.forEach(msg => {
      if (!msg.from.equals(readerId)) {
        msg.read = true;
      }
    });
    
    await chat.save();
    return true;
  } catch (error) {
    console.error('[markMessagesAsRead] error:', error);
    return false;
  }
}

/**
 * Получить количество непрочитанных сообщений
 */
export async function getUnreadCount(
  userId1: string, 
  userId2: string, 
  readerUserId: string
): Promise<number> {
  try {
    const chat = await Chat.findOne({ 
      participants: [
        new mongoose.Types.ObjectId(userId1),
        new mongoose.Types.ObjectId(userId2)
      ].sort()
    });
    
    if (!chat) {
      return 0;
    }
    
    const readerId = new mongoose.Types.ObjectId(readerUserId);
    
    const unreadText = chat.textMessages.filter(msg => 
      !msg.from.equals(readerId) && !msg.read
    ).length;
    
    const unreadMedia = chat.mediaMessages.filter(msg => 
      !msg.from.equals(readerId) && !msg.read
    ).length;
    
    return unreadText + unreadMedia;
  } catch (error) {
    console.error('[getUnreadCount] error:', error);
    return 0;
  }
}
