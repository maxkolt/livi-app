// utils/mediaUpload.ts
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { logger } from './logger';
import { getInstallId } from './installId';
import { API_BASE } from '../sockets/socket';

const API_BASE_URL = API_BASE;
const LEGACY_BASE64_MAX_MB = 10;

// Some production deployments may not have multipart endpoint enabled yet.
// Cache support after the first request to avoid spamming logs and wasting time on repeated 404s.
let multipartSupported: boolean | null = null;

/**
 * Конвертирует локальный файл в dataUri
 */
export const fileToDataUri = async (uri: string): Promise<string | null> => {
  try {
    // Нормализуем URI для разных платформ
    const normalizedUri = uri.startsWith('file://') ? uri : `file://${uri}`;
    
    // Читаем файл как base64
    const base64 = await FileSystem.readAsStringAsync(normalizedUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    
    // Определяем MIME тип по расширению файла
    const extension = uri.split('.').pop()?.toLowerCase();
    let mimeType = 'application/octet-stream';
    
    if (extension) {
      switch (extension) {
        case 'jpg':
        case 'jpeg':
          mimeType = 'image/jpeg';
          break;
        case 'png':
          mimeType = 'image/png';
          break;
        case 'gif':
          mimeType = 'image/gif';
          break;
        case 'webp':
          mimeType = 'image/webp';
          break;
        case 'mp4':
          mimeType = 'video/mp4';
          break;
        case 'mov':
          mimeType = 'video/quicktime';
          break;
        case 'webm':
          mimeType = 'video/webm';
          break;
        // audio (voice messages)
        case 'm4a':
          mimeType = 'audio/mp4';
          break;
        case 'aac':
          mimeType = 'audio/aac';
          break;
        case 'mp3':
          mimeType = 'audio/mpeg';
          break;
        case 'ogg':
          mimeType = 'audio/ogg';
          break;
        case 'wav':
          mimeType = 'audio/wav';
          break;
      }
    }
    
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    logger.error('Error converting file to dataUri:', error);
    return null;
  }
};

/**
 * Загружает медиа файл на сервер и возвращает публичный URL
 */
export const uploadMediaToServer = async (
  localUri: string, 
  type: 'image' | 'audio',
  onProgress?: (progress: number) => void,
  from?: string,
  to?: string
): Promise<{ success: boolean; url?: string; error?: string; abortController?: AbortController }> => {
  try {
    logger.debug('Starting upload to:', API_BASE_URL);
    logger.debug('Local file:', localUri);

    const installId = await getInstallId().catch(() => '');
    
    // IMPORTANT:
    // Uploading raw images as base64-in-JSON is very heavy (size +33%),
    // and becomes extremely slow on VPN / high-latency networks.
    // We proactively resize+compress ONLY for photos to keep UX acceptable.
    let workingUri = localUri;
    try {
      const ext = (localUri.split('?')[0]?.split('#')[0]?.split('.').pop() || '').toLowerCase();
      const isGif = ext === 'gif';
      const isWebp = ext === 'webp';

      // Only images are resized/compressed.
      if (type === 'image' && !isGif && !isWebp) {
        const format =
          ext === 'png' ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG;
        const compress = format === ImageManipulator.SaveFormat.PNG ? 1 : 0.85;

        const manip = await ImageManipulator.manipulateAsync(
          localUri,
          [{ resize: { width: 1280 } }],
          { compress, format }
        );
        if (manip?.uri) workingUri = manip.uri;
      }
    } catch {
      // Non-fatal: fallback to original file.
    }

    // Prefer multipart upload (faster & more stable on bad networks / VPN).
    // Keep legacy base64 JSON upload as fallback for release-safety.
    const normalizedUri = workingUri.startsWith('file://') ? workingUri : `file://${workingUri}`;
    try {
      if (multipartSupported !== false) {
        if (onProgress) onProgress(15);
        const mpUrl = `${API_BASE_URL}/api/upload/media/multipart`;
        const mpRes = await FileSystem.uploadAsync(mpUrl, normalizedUri, {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          headers: {
            ...(installId ? { 'x-install-id': String(installId) } : {}),
          },
        });

        if (mpRes.status === 404) {
          // Endpoint not available on this server — disable multipart for the session.
          multipartSupported = false;
        } else {
          multipartSupported = true;
        }

        if (mpRes.status >= 200 && mpRes.status < 300) {
          let json: any = null;
          try { json = JSON.parse(mpRes.body || '{}'); } catch {}
          if (json?.ok && (json.url || json.secure_url)) {
            if (onProgress) onProgress(100);
            const url = json.url || json.secure_url;
            return { success: true, url };
          }
        }

        // Fall through to legacy upload (avoid warning spam on known-missing endpoint)
        if (mpRes.status !== 404) {
          logger.warn('Multipart upload failed, falling back to base64', { status: mpRes.status });
        }
      }
    } catch (e) {
      // If multipart is flaky, fallback to base64. Keep warning only if we believe endpoint exists.
      if (multipartSupported !== false) {
        logger.warn('Multipart upload error, falling back to base64', e as any);
      }
    }

    // Legacy base64-in-JSON upload (small-file fallback only).
    try {
      const info = await FileSystem.getInfoAsync(normalizedUri);
      const size = Number((info as any)?.size || 0);
      if (size > LEGACY_BASE64_MAX_MB * 1024 * 1024) {
        return { success: false, error: `Multipart upload failed and legacy fallback is limited to ${LEGACY_BASE64_MAX_MB}MB` };
      }
    } catch {
      // If size lookup is unavailable, keep existing fallback behavior.
    }

    const dataUri = await fileToDataUri(normalizedUri);
    if (!dataUri) {
      logger.error('Failed to convert file to dataUri');
      return { success: false, error: 'Failed to convert file to dataUri' };
    }
    
    const fileSizeMB = Math.round(dataUri.length / 1024 / 1024);
    const maxSizeMB = LEGACY_BASE64_MAX_MB;
    if (fileSizeMB > maxSizeMB) {
      logger.error(`File too large: ${fileSizeMB}MB (max: ${maxSizeMB}MB)`);
      return { success: false, error: `File too large: ${fileSizeMB}MB (maximum allowed: ${maxSizeMB}MB)` };
    }

    // Показываем прогресс для всех файлов
    if (onProgress) {
      onProgress(10); // 10% - файл конвертирован
    }
    
    // Симулируем прогресс загрузки для всех файлов
    let progressInterval: NodeJS.Timeout | null = null;
    if (onProgress) {
      let currentProgress = 10;
      progressInterval = setInterval(() => {
        currentProgress += Math.random() * 3; // Увеличиваем на 0-3% каждые 150мс
        if (currentProgress > 90) currentProgress = 90; // Не доходим до 100% до завершения
        onProgress(Math.round(currentProgress));
      }, 150);
    }
    
    // Загружаем на сервер
    
    // Создаем AbortController для таймаута
    const controller = new AbortController();
    const timeoutMs = type === 'audio' ? 120000 : 300000; // audio: 2 мин, images: 5 мин
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    
    let result;
    try {
      
      const response = await fetch(`${API_BASE_URL}/api/upload/media`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(installId ? { 'x-install-id': String(installId) } : {}),
        },
        body: JSON.stringify({
          dataUri,
          type,
          from,
          to,
        }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Server error response:', errorText);
        return { success: false, error: `Server error ${response.status}: ${errorText}` };
      }
      
      result = await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: `Upload timeout after ${timeoutMs/1000} seconds` };
      }
      throw error;
    }
    
    // Показываем прогресс для всех файлов
    if (onProgress) {
      onProgress(80); // 80% - ответ получен
    }
    
    if (result.ok && (result.url || result.secure_url)) {
      const url = result.url || result.secure_url;
      
      // Показываем финальный прогресс для всех файлов
      if (onProgress) {
        onProgress(100); // 100% - загрузка завершена
      }
      
      return { success: true, url, abortController: controller };
    } else {
      console.error('📤 Upload failed:', result.error);
      return { success: false, error: result.error || 'Upload failed' };
    }
  } catch (error) {
    console.error('📤 Upload error:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
};

/**
 * Определяет тип медиа файла по URI
 */
export const getMediaType = (uri: string): 'image' => {
  return 'image';
};
