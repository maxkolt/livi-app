import * as FileSystem from 'expo-file-system';
import { uploadMediaToServer } from './mediaUpload';
import { getInstallId } from './installId';
import { API_BASE, getCurrentUserId, sendMessage } from '../sockets/socket';
import type { IncomingShareItem } from './incomingShare';

async function uploadRawShareFile(localUri: string): Promise<string> {
  const installId = await getInstallId().catch(() => '');
  const normalizedUri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
  try {
    const mpUrl = `${API_BASE}/api/upload/media/multipart`;
    const mpRes = await FileSystem.uploadAsync(mpUrl, normalizedUri, {
      httpMethod: 'POST',
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      headers: {
        ...(installId ? { 'x-install-id': String(installId) } : {}),
      },
    });
    if (mpRes.status >= 200 && mpRes.status < 300) {
      let json: { ok?: boolean; url?: string; secure_url?: string } | null = null;
      try {
        json = JSON.parse(mpRes.body || '{}');
      } catch {
        json = null;
      }
      if (json?.ok && (json.url || json.secure_url)) {
        return json.url || json.secure_url || '';
      }
    }
  } catch {
    // The share flow is intentionally short; callers show a generic send failure.
  }
  return '';
}

export async function sendIncomingShareToFriend(peerId: string, items: IncomingShareItem[]): Promise<number> {
  const currentUserId = getCurrentUserId();
  if (!currentUserId || !peerId || !items?.length) return 0;

  let sent = 0;
  for (const item of items) {
    if (item.kind === 'text') {
      const text = String(item.text || '').trim();
      if (!text) continue;
      const result: any = await sendMessage({
        to: peerId,
        text,
        type: 'text',
        clientUiMessageId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
      if (result?.ok) sent += 1;
      continue;
    }

    const localUri = String(item.uri || '').trim();
    if (!localUri) continue;

    if (item.kind === 'image' || item.kind === 'audio') {
      const upload = await uploadMediaToServer(localUri, item.kind, undefined, currentUserId, peerId);
      if (!upload.success || !upload.url) continue;
      const result: any = await sendMessage({
        to: peerId,
        type: item.kind,
        uri: upload.url,
        name: item.name || undefined,
        size: item.size || undefined,
        clientUiMessageId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
      if (result?.ok) sent += 1;
      continue;
    }

    if (item.kind === 'document') {
      const remoteUrl = await uploadRawShareFile(localUri);
      if (!remoteUrl) continue;
      const label = item.name ? `File: ${item.name}` : 'File';
      const result: any = await sendMessage({
        to: peerId,
        type: 'text',
        text: `${label}\n${remoteUrl}`,
        clientUiMessageId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      });
      if (result?.ok) sent += 1;
    }
  }

  return sent;
}
