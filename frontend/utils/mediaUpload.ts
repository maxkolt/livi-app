// utils/mediaUpload.ts
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { logger } from './logger';
import { getInstallAuthHeaders } from './installId';
import { API_BASE } from '../sockets/socket';
import { encryptMediaForUpload, attachMediaKey } from './protectedMedia';

const MULTIPART_TIMEOUT_MS = { audio: 45_000, image: 180_000, video: 300_000 } as const;
type MediaUploadOptions = { registerCancel?: (cancel: () => void) => void };
type MediaUploadResult = { success: boolean; url?: string; error?: string; kind?: 'network' | 'server' | 'file' };

/** Files leave the device only after encryption; keys stay in the chat envelope. */
export async function uploadMediaToServer(
  localUri: string, type: 'image' | 'audio' | 'video', onProgress?: (progress: number) => void,
  from?: string, to?: string, options?: MediaUploadOptions,
): Promise<MediaUploadResult> {
  if (!from || !to) return { success: false, kind: 'server', error: 'unauthorized' };
  try {
    const authHeaders = await getInstallAuthHeaders();
    const info = await FileSystem.getInfoAsync(localUri);
    if (!info.exists) return { success: false, kind: 'file', error: 'file_missing' };
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

    // Every new attachment is encrypted before it leaves the device. No
    // plaintext retry is allowed when encryption or the peer capability fails.
    if (from && to) {
      const { requireMediaEncryptionPeer } = await import('../sockets/modules/e2e');
      await requireMediaEncryptionPeer(to);
      const protectedFile = await encryptMediaForUpload(workingUri, type);
      try {
        const task = FileSystem.createUploadTask(`${API_BASE}/api/upload/media/multipart`, protectedFile.uri, {
          httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file', mimeType: 'application/vnd.livi.encrypted', headers: authHeaders,
        });
        let cancelled = false;
        const timeout = setTimeout(() => { cancelled = true; void task.cancelAsync(); }, MULTIPART_TIMEOUT_MS[type]);
        options?.registerCancel?.(() => { cancelled = true; void task.cancelAsync(); });
        try {
          const result = await task.uploadAsync();
          if (!result || cancelled) return { success: false, kind: 'network', error: 'upload_cancelled' };
          if (result.status < 200 || result.status >= 300) return { success: false, kind: 'server', error: 'encrypted_upload_failed' };
          const body = JSON.parse(result.body) as { ok: boolean; url?: string };
          if (!body.ok || !body.url) return { success: false, kind: 'server', error: 'encrypted_upload_failed' };
          onProgress?.(100);
          return { success: true, url: attachMediaKey(body.url, protectedFile.key) };
        } finally { clearTimeout(timeout); }
      } finally { await FileSystem.deleteAsync(protectedFile.uri, { idempotent: true }).catch(() => {}); }
    }

    return { success: false, kind: 'server', error: 'encryption_required' };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : '';
    const policyError = /recipient_update_required|requires_update|locked/.test(code);
    logger.warn('Encrypted media upload failed', { reason: policyError ? 'client_update_or_key_required' : 'network_or_upload_error' });
    return { success: false, kind: policyError ? 'server' : 'network', error: policyError ? code : 'encrypted_upload_failed' };
  }
}
