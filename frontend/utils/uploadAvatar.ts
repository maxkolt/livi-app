// utils/uploadAvatar.ts
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { API_BASE } from '../sockets/socket';
import { getInstallId } from './installId';
import { useMe } from '../store/me';
import { logger } from './logger';

const isHttp = (s?: string) => !!s && /^https?:\/\//i.test(String(s).trim());

function guessMime(filename: string, fallback = 'application/octet-stream') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic';
  return fallback;
}

async function ensureMediaPermissions() {
  try {
    const perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted) {
      const req = await MediaLibrary.requestPermissionsAsync();
      return req.granted;
    }
    return true;
  } catch {
    return false;
  }
}

// Удалено: avatarUrl больше не сохраняем через profile:update. Используем только локальный путь в avatar

/** Приведение к file:// */
export async function normalizeLocalImageUri(
  uri: string | undefined | null,
  assetId?: string | null
): Promise<string> {
  const s = (uri || '').trim();
  if (!s) throw new Error('No image uri');

  // iOS ImagePicker часто возвращает временный файл в Caches/ImagePicker,
  // который может быть удалён системой. Копируем в собственный кэш.
  if (s.startsWith('file://')) {
    try {
      const info = await FileSystem.getInfoAsync(s);
      if (info.exists) {
        const dest = FileSystem.cacheDirectory + `picked_${Date.now()}.jpg`;
        await FileSystem.copyAsync({ from: s, to: dest });
        return dest;
      }
    } catch {}
    // если не удалось — продолжим ниже общим путём
  }

  if (s.startsWith('ph://') || s.startsWith('assets-library://')) {
    const ok = await ensureMediaPermissions();
    if (!ok) throw new Error('No Photos permission');

    const id = assetId || s.replace(/^ph:\/\//, '');
    if (!id) throw new Error('No asset id');

    const info = await MediaLibrary.getAssetInfoAsync(id);
    const local = (info?.localUri || info?.uri) as string | undefined;
    if (local?.startsWith('file://')) return local;

    if (local && local.startsWith('content://')) {
      const dest = FileSystem.cacheDirectory + `picked_${Date.now()}.jpg`;
      await FileSystem.copyAsync({ from: local, to: dest });
      return dest;
    }
    throw new Error('Cannot resolve local file path for iOS asset');
  }

  if (s.startsWith('content://')) {
    const dest = FileSystem.cacheDirectory + `picked_${Date.now()}.jpg`;
    await FileSystem.copyAsync({ from: s, to: dest });
    return dest;
  }

  if (isHttp(s)) {
    const dest = FileSystem.cacheDirectory + `picked_${Date.now()}.jpg`;
    const dl = await FileSystem.downloadAsync(s, dest);
    if (dl?.uri?.startsWith('file://')) return dl.uri;
    throw new Error('Failed to download remote image');
  }

  const dest = FileSystem.cacheDirectory + `picked_${Date.now()}.jpg`;
  await FileSystem.copyAsync({ from: s, to: dest });
  return dest;
}

/** fetch с таймаутом */
async function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 30000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/** Загрузка через FormData */
async function uploadViaFormData(fileUri: string, cloudUrl: string, preset: string): Promise<string> {
  const base = fileUri.split('/').pop() || 'avatar.jpg';
  const name = base.includes('.') ? base : `${base}.jpg`;
  const type = guessMime(name, 'image/jpeg') || 'image/jpeg';


  const form = new FormData();
  form.append('file', { uri: fileUri, name, type } as any);
  form.append('upload_preset', preset);

  const res = await fetchWithTimeout(cloudUrl, { method: 'POST', body: form as any }, 30000);
  const txt = await res.clone().text();
  let json: any = {};
  try { json = JSON.parse(txt); } catch {}

  if (!res.ok || !json?.secure_url) {
    const reason = json?.error?.message || json?.error || `status ${res.status}`;
    throw new Error(reason);
  }
  return String(json.secure_url);
}

/** Загрузка через Base64 */
async function uploadViaBase64(fileUri: string, cloudUrl: string, preset: string): Promise<string> {

  let working = fileUri;
  try {
    const manip = await ImageManipulator.manipulateAsync(
      fileUri,
      [{ resize: { width: 1024 } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    if (manip?.uri) working = manip.uri;
  } catch {}

  const base64 = await FileSystem.readAsStringAsync(working, { encoding: FileSystem.EncodingType.Base64 });
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const form = new FormData();
  form.append('file', dataUrl as any);
  form.append('upload_preset', preset);

  const res = await fetchWithTimeout(cloudUrl, { method: 'POST', body: form as any }, 30000);
  const txt = await res.clone().text();
  let json: any = {};
  try { json = JSON.parse(txt); } catch {}

  if (!res.ok || !json?.secure_url) {
    const reason = json?.error?.message || json?.error || `status ${res.status}`;
    throw new Error(reason);
  }
  return String(json.secure_url);
}

/** Серверный фолбэк */
async function uploadViaServerFallback(fileUri: string, userId?: string, installId?: string): Promise<{ avatar: string; avatarVer: number }> {

  let working = fileUri;
  try {
    const manip = await ImageManipulator.manipulateAsync(
      fileUri,
      [{ resize: { width: 1024 } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
    );
    if (manip?.uri) working = manip.uri;
  } catch {}

  const base64 = await FileSystem.readAsStringAsync(working, { encoding: FileSystem.EncodingType.Base64 });
  const dataUri = `data:image/jpeg;base64,${base64}`;

  const url = `${API_BASE}/api/upload/avatar/dataUri`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (userId) headers['x-user-id'] = userId;
  if (installId) headers['x-install-id'] = installId;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ dataUri }),
  }, 30000);

  const txt = await res.clone().text();
  let json: any = {};
  try { json = JSON.parse(txt); } catch {}

  if (!res.ok || !json?.ok) {
    const reason = json?.error || `server_fallback_failed (${res.status})`;
    throw new Error(reason);
  }
  
  // Возвращаем объект с avatar и avatarVer
  return json;
}

/** Основная функция: загрузка аватара на сервер */
export async function uploadAvatarToCloudinary(localUri: string, assetId?: string | null): Promise<{ avatar: string; avatarVer: number }> {
  // Загружаем напрямую на сервер
  try {
    const fileUri = await normalizeLocalImageUri(localUri, assetId);

    // Получаем userId и installId для авторизации
    const userId = useMe.getState().me?.id;
    const installId = await getInstallId();

    // Загружаем на сервер через /api/upload/avatar/dataUri
    const result = await uploadViaServerFallback(fileUri, userId, installId);

    return result;
  } catch (error) {
    logger.error('Server upload failed:', error);
    throw error;
  }
}

/** Полный пайплайн: загрузить и сохранить (nick не трогаем) */
export async function uploadAvatarAndSave(localUri: string, assetId?: string | null): Promise<{ avatar: string; avatarVer: number }> {
  const result = await uploadAvatarToCloudinary(localUri, assetId);
  return result;
}

/** Миниатюра */
export const toAvatarThumb = (url?: string, w = 240, h = w) => {
  if (!url) return '';
  
  // Если это локальный путь, превращаем в абсолютный
  if (url.startsWith('/uploads/')) {
    return `${API_BASE}${url}`;
  }
  
  // Если это API URL аватара, возвращаем как есть
  if (url.includes('/api/avatar/')) {
    return url;
  }
  
  // Fallback для старых Cloudinary URL
  if (/\/upload\//.test(url)) {
    return url.replace('/upload/', `/upload/f_auto,q_auto:eco,c_fill,g_face,w_${w},h_${h}/`);
  }
  
  return url;
};
