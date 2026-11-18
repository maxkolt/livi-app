// utils/imageOptimization.ts
import { Image as ExpoImage, type ImageRef } from 'expo-image';
import { Platform } from 'react-native';
import { logger } from './logger';
import { resolveDataUriForAndroid } from './dataUriToFileUri';

// Keep decoded, content-addressed avatar files available for a newly mounted row.
// A raw picker file may be overwritten, so only our full-hash filenames are reusable.
const decodedAvatars = new Map<string, { image: ImageRef; pixels: number }>();
const avatarWarmups = new Map<string, Promise<void>>();
const localWarmups = new Map<string, Promise<void>>();
const localWaiters: Array<() => void> = [];
let localLoads = 0;
let cacheGeneration = 0;

async function decodeLocalImage(uri: string): Promise<void> {
  const generation = cacheGeneration;
  if (localLoads >= 2) await new Promise<void>(resolve => localWaiters.push(resolve));
  else localLoads++;
  try {
    const image = await ExpoImage.loadAsync({ uri }, { maxWidth: 1024, maxHeight: 1024 });
    if (generation === cacheGeneration) rememberDecodedAvatar(uri, image);
  } finally {
    const next = localWaiters.shift();
    if (next) next();
    else localLoads--;
  }
}
const MAX_DECODED_AVATAR_PIXELS = 4 * 1024 * 1024;
const MAX_DECODED_AVATARS = 48;
let decodedAvatarPixels = 0;

function isImmutableAvatarFile(uri: string): boolean {
  return /^file:.*\/glide_data_uri_avatar_[a-f0-9]{64}\.(?:jpg|png)$/i.test(uri);
}

function rememberDecodedAvatar(uri: string, image: ImageRef): void {
  if (!isImmutableAvatarFile(uri)) return;
  const scale = image.scale || 1;
  const pixels = image.width * image.height * scale * scale;
  if (!Number.isFinite(pixels) || pixels <= 0 || pixels > MAX_DECODED_AVATAR_PIXELS) return;
  const previous = decodedAvatars.get(uri);
  if (previous) decodedAvatarPixels -= previous.pixels;
  decodedAvatars.delete(uri);
  decodedAvatars.set(uri, { image, pixels });
  decodedAvatarPixels += pixels;
  while (decodedAvatars.size > MAX_DECODED_AVATARS || decodedAvatarPixels > MAX_DECODED_AVATAR_PIXELS) {
    const oldest = decodedAvatars.keys().next().value;
    if (oldest === undefined) break;
    decodedAvatarPixels -= decodedAvatars.get(oldest)!.pixels;
    decodedAvatars.delete(oldest);
  }
}

/**
 * Специальные настройки для аватаров на Android
 * Максимально оптимизированы против мерцания.
 * На Android используем разрешённый file: URI, чтобы видимый аватар и его
 * предзагрузка ссылались на один файл. Вызывающий код использует useResolvedImageUri.
 */
export const getAvatarImageProps = (uri: string, key: string, options: { useDecodedSource?: boolean } = {}) => {
  const safeUri = Platform.OS === 'android' && /^data:/i.test(uri) ? '' : uri;
  return {
    source: (options.useDecodedSource !== false && decodedAvatars.get(safeUri)?.image) || { uri: safeUri },
    contentFit: 'cover' as const,
    cachePolicy: 'memory-disk' as const,
    transition: 0,
    recyclingKey: key,
    allowDownscaling: false,
    placeholder: null,
    priority: 'high' as const,
    ...(Platform.OS === 'android' && {
      blurRadius: 0,
      tintColor: undefined,
    }),
  };
};

/** Match the exact thumbnail URI passed to friend/chat rows before warming a full-photo fallback. */
export function selectFriendAvatarWarmSources(
  friends: ReadonlyArray<{ avatarThumbB64?: string; avatar?: string }>,
): string[] {
  return [...new Set(friends.map(friend => friend.avatarThumbB64 || friend.avatar || '').filter(Boolean))];
}

/**
 * Expo's Android prefetch wraps every string in GlideUrl, which accepts HTTP(S)
 * only. Local images must go through loadAsync's normal source-model selection.
 * Decode content-addressed avatars once and keep bounded native references so
 * the first frame of another list can use the already decoded bitmap.
 */
async function warmImage(uri: string): Promise<void> {
  const source = uri.trim();
  if (!source) return;
  if (/^https?:\/\//i.test(source)) {
    await ExpoImage.prefetch(source, 'memory-disk');
    return;
  }
  const resolved = await resolveDataUriForAndroid(source);
  const localScheme = Platform.OS === 'android'
    ? /^(?:file:|data:|content:|android\.resource:|res:)/i
    : /^(?:file:|data:|content:|asset:|ph:|assets-library:|android\.resource:|res:)/i;
  if (!localScheme.test(resolved)) return;
  if (decodedAvatars.has(resolved)) return;
  const pending = localWarmups.get(resolved);
  if (pending) return pending;
  const load = decodeLocalImage(resolved).finally(() => localWarmups.delete(resolved));
  localWarmups.set(resolved, load);
  return load;
}

export const prefetchImages = async (urls: string[]): Promise<void> => {
  await Promise.all([...new Set(urls.map(uri => uri.trim()).filter(Boolean))].map(uri => {
    const pending = avatarWarmups.get(uri);
    if (pending) return pending;
    const warmup = warmImage(uri).catch(error => {
      logger.warn('Image warmup failed:', error);
    }).finally(() => {
      avatarWarmups.delete(uri);
    });
    avatarWarmups.set(uri, warmup);
    return warmup;
  }));
};

/**
 * Принудительное обновление изображения (для Android)
 */
export const forceImageRefresh = async () => {
  if (Platform.OS === 'android') {
    try {
      // Очищаем кэш памяти и диска
      cacheGeneration++;
      decodedAvatars.clear();
      decodedAvatarPixels = 0;
      await ExpoImage.clearMemoryCache();
      await ExpoImage.clearDiskCache();
    } catch (error) {
      console.warn('[ImageOptimization] Force refresh failed:', error);
    }
  }
};
