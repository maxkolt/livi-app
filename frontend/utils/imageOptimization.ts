// utils/imageOptimization.ts
import { Image as ExpoImage } from 'expo-image';
import { Platform } from 'react-native';
import { logger } from './logger';

/**
 * Оптимизированные настройки для ExpoImage на Android
 * Устраняет мерцание и улучшает производительность
 */
export const getOptimizedImageProps = (uri: string, key: string, size?: number) => ({
  key,
  source: { uri },
  contentFit: 'cover' as const,
  cachePolicy: 'memory-disk' as const,
  // Убираем transition на Android для устранения мерцания
  transition: Platform.OS === 'android' ? 0 : 200,
  recyclingKey: key,
  allowDownscaling: false,
  // Добавляем placeholder для предотвращения мерцания
  placeholder: Platform.OS === 'android' ? require('../assets/icon.png') : null,
  priority: 'high' as const,
  // Дополнительные оптимизации для Android
  ...(Platform.OS === 'android' && {
    blurRadius: 0,
    tintColor: undefined,
  }),
});

/**
 * Специальные настройки для аватаров на Android
 * Максимально оптимизированы против мерцания.
 * На Android не передаём data: в source (Glide падает) — вызывающий код должен использовать useResolvedImageUri или AvatarImage.
 */
export const getAvatarImageProps = (uri: string, key: string) => {
  const safeUri = (Platform.OS === 'android' && typeof uri === 'string' && /^data:/i.test(uri)) ? '' : uri;
  return ({
  source: { uri: safeUri },
  contentFit: 'cover' as const,
  cachePolicy: 'memory-disk' as const,
  transition: 0, // Полностью убираем transition для аватаров
  recyclingKey: key,
  allowDownscaling: false,
  placeholder: null,
  priority: 'high' as const,
  // Дополнительные настройки для предотвращения мерцания
  ...(Platform.OS === 'android' && {
    blurRadius: 0,
    tintColor: undefined,
  }),
});
};

/**
 * Предзагрузка изображений для устранения мерцания
 */
export const prefetchImages = async (urls: string[]) => {
  try {
    await ExpoImage.prefetch(urls);
  } catch (error) {
    logger.warn('Prefetch failed:', error);
  }
};

/**
 * Очистка кэша изображений
 */
export const clearImageCache = async () => {
  try {
    await ExpoImage.clearMemoryCache();
    await ExpoImage.clearDiskCache();
  } catch (error) {
    logger.warn('Cache clear failed:', error);
  }
};

/**
 * Предзагрузка аватаров пользователей для устранения мерцания.
 * На Android не передаём data: URI в prefetch (Glide падает с "Expected URL scheme 'http' or 'https' but was 'data'").
 */
export const prefetchUserAvatars = async (avatarUrls: string[]) => {
  try {
    let validUrls = avatarUrls.filter(url => url && typeof url === 'string');
    if (Platform.OS === 'android') {
      validUrls = validUrls.filter(url => !/^data:/i.test(url));
    }
    if (validUrls.length > 0) {
      await ExpoImage.prefetch(validUrls);
    }
  } catch (error) {
    console.warn('[ImageOptimization] Avatar prefetch failed:', error);
  }
};

/**
 * Стабильный ключ для аватара
 */
export const getAvatarKey = (userId: string, avatarUrl?: string) => {
  if (!avatarUrl) return `avatar_${userId}_none`;
  
  // Для локальных файлов используем полный путь
  if (/^(file|content|ph|assets-library):\/\//i.test(avatarUrl)) {
    return `avatar_${userId}_local_${avatarUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-30)}`;
  }
  
  // Для HTTP URL используем хэш
  return `avatar_${userId}_${avatarUrl.slice(-20)}`;
};

/**
 * Принудительное обновление изображения (для Android)
 */
export const forceImageRefresh = async () => {
  if (Platform.OS === 'android') {
    try {
      // Очищаем кэш памяти и диска
      await ExpoImage.clearMemoryCache();
      await ExpoImage.clearDiskCache();
    } catch (error) {
      console.warn('[ImageOptimization] Force refresh failed:', error);
    }
  }
};
