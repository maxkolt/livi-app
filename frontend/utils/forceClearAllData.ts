// utils/forceClearAllData.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logger } from './logger';

/**
 * Принудительная очистка ВСЕХ данных из AsyncStorage
 * Используйте только в критических случаях
 */
export async function forceClearAllAsyncStorage(): Promise<void> {
  try {
    // Получаем все ключи
    const allKeys = await AsyncStorage.getAllKeys();

    if (allKeys.length > 0) {
      // Удаляем ВСЕ ключи
      await AsyncStorage.multiRemove(allKeys);
    } else {}

    // Проверяем, что все очищено
    const remainingKeys = await AsyncStorage.getAllKeys();
    if (remainingKeys.length > 0) {
      logger.warn('Some keys remain after clearing:', remainingKeys);
    } else {}
  } catch (error) {
    logger.error('Failed to force clear AsyncStorage:', error);
    throw error;
  }
}

/**
 * Очистка только пользовательских данных (без системных настроек)
 */
export async function forceClearUserDataOnly(): Promise<void> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();

    // Фильтруем ключи, связанные с пользовательскими данными
    const userDataKeys = allKeys.filter(key => 
      key.startsWith('user') || 
      key.startsWith('friends') || 
      key.startsWith('chat_') || 
      key.startsWith('profile') ||
      key.startsWith('livi.') ||
      key.startsWith('unread_') ||
      key.startsWith('message_') ||
      key.includes('userId') ||
      key.includes('installId') ||
      key.includes('avatar') ||
      key.includes('cache') ||
      key.includes('draft') ||
      key === 'missed_calls_by_user_v1'
    );

    if (userDataKeys.length > 0) {
      await AsyncStorage.multiRemove(userDataKeys);
    } else {}
  } catch (error) {
    console.error('❌ Failed to force clear user data:', error);
    throw error;
  }
}
