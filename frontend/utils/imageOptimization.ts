// utils/imageOptimization.ts
import { Image as ExpoImage } from 'expo-image';
import { Platform } from 'react-native';
import { logger } from './logger';

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
