// backend/utils/friendshipUtils.ts
import mongoose from 'mongoose';
import User from '../models/User';

/**
 * Оптимизированная проверка дружбы между двумя пользователями
 * Использует индексы MongoDB для быстрого поиска
 */
export async function areFriends(userId1: string, userId2: string): Promise<boolean> {
  try {
    // Проверяем валидность ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId1) || !mongoose.Types.ObjectId.isValid(userId2)) {
      return false;
    }

    // Используем $in для поиска пользователя, у которого в массиве friends есть userId2
    const user = await User.findOne(
      { 
        _id: userId1,
        friends: new mongoose.Types.ObjectId(userId2)
      },
      { _id: 1 } // Возвращаем только _id для экономии памяти
    ).lean();

    return !!user;
  } catch (error) {
    console.error('[areFriends] Error:', error);
    return false;
  }
}

/**
 * Проверка дружбы с кэшированием в памяти (для частых запросов)
 */
const friendshipCache = new Map<string, { result: boolean; timestamp: number }>();
const CACHE_TTL = 60000; // 1 минута

export async function areFriendsCached(userId1: string, userId2: string): Promise<boolean> {
  const cacheKey = `${userId1}-${userId2}`;
  const now = Date.now();
  
  // Проверяем кэш
  const cached = friendshipCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.result;
  }

  // Если нет в кэше или истек, делаем запрос к БД
  const result = await areFriends(userId1, userId2);
  
  // Сохраняем в кэш
  friendshipCache.set(cacheKey, { result, timestamp: now });
  
  // Очищаем старые записи из кэша
  if (friendshipCache.size > 1000) {
    for (const [key, value] of friendshipCache.entries()) {
      if ((now - value.timestamp) > CACHE_TTL) {
        friendshipCache.delete(key);
      }
    }
  }

  return result;
}

/**
 * Получить список друзей пользователя с пагинацией
 * Оптимизировано для работы с тысячами друзей
 */
export async function getFriendsPaginated(
  userId: string, 
  page: number = 1, 
  limit: number = 50
): Promise<{ friends: any[]; total: number; hasMore: boolean }> {
  try {
    // Убираем избыточное логирование - функция вызывается слишком часто
    // console.log('[getFriendsPaginated] Request for userId:', userId, 'page:', page, 'limit:', limit);
    const skip = (page - 1) * limit;
    
    // Получаем пользователя с друзьями
    const user = await User.findById(userId)
      .select('friends')
      .lean();

    // Убираем избыточное логирование
    // console.log('[getFriendsPaginated] User found:', !!user, 'friends count:', user?.friends?.length || 0);

    if (!user || !user.friends) {
      // Убираем избыточное логирование
      // console.log('[getFriendsPaginated] No user or friends, returning empty');
      return { friends: [], total: 0, hasMore: false };
    }

    const totalFriends = user.friends.length;
    const friendsIds = user.friends.slice(skip, skip + limit);
    
    // Получаем информацию о друзьях
    const friends = await User.find(
      { _id: { $in: friendsIds } },
      { _id: 1, nick: 1, avatar: 1, avatarVer: 1, avatarThumbB64: 1 }
    ).lean();

    return {
      friends: friends.map(friend => ({
        _id: friend._id,
        nick: friend.nick || '',
        avatar: (friend as any).avatar || '',
        avatarVer: (friend as any).avatarVer || 0,
        avatarThumbB64: (friend as any).avatarThumbB64 || ''
      })),
      total: totalFriends,
      hasMore: skip + limit < totalFriends
    };
  } catch (error) {
    console.error('[getFriendsPaginated] Error:', error);
    return { friends: [], total: 0, hasMore: false };
  }
}

/**
 * Проверить, является ли пользователь другом любого из списка пользователей
 * Полезно для проверки прав доступа к групповым чатам
 */
export async function isFriendOfAny(userId: string, targetUserIds: string[]): Promise<boolean> {
  try {
    if (targetUserIds.length === 0) return false;
    
    const user = await User.findOne(
      { 
        _id: userId,
        friends: { $in: targetUserIds }
      },
      { _id: 1 }
    ).lean();

    return !!user;
  } catch (error) {
    console.error('[isFriendOfAny] Error:', error);
    return false;
  }
}

/**
 * Получить статистику дружбы пользователя
 */
export async function getFriendshipStats(userId: string): Promise<{
  totalFriends: number;
  onlineFriends: number;
  recentFriends: number;
}> {
  try {
    const user = await User.findById(userId)
      .select('friends')
      .lean();

    if (!user || !user.friends) {
      return { totalFriends: 0, onlineFriends: 0, recentFriends: 0 };
    }

    const totalFriends = user.friends.length;
    
    // Здесь можно добавить логику для подсчета онлайн друзей
    // и недавно добавленных друзей
    const onlineFriends = 0; // TODO: реализовать проверку онлайн статуса
    const recentFriends = 0; // TODO: реализовать проверку недавно добавленных

    return {
      totalFriends,
      onlineFriends,
      recentFriends
    };
  } catch (error) {
    console.error('[getFriendshipStats] Error:', error);
    return { totalFriends: 0, onlineFriends: 0, recentFriends: 0 };
  }
}

/**
 * Очистить кэш дружбы для пользователя
 * Вызывается при изменении списка друзей
 */
export function clearFriendshipCache(userId: string): void {
  for (const [key] of friendshipCache.entries()) {
    if (key.includes(userId)) {
      friendshipCache.delete(key);
    }
  }
}

/**
 * Очистить весь кэш дружбы
 */
export function clearAllFriendshipCache(): void {
  friendshipCache.clear();
}
