import * as FileSystem from 'expo-file-system';
import { uploadMediaToServer } from './mediaUpload';
import { getInstallId } from './installId';
import { API_BASE, getCurrentUserId, sendMessage } from '../sockets/socket';
import type { IncomingShareItem } from './incomingShare';
import { appendOutgoingPendingLocal } from '../screens/chat/appendOutgoingPendingLocal';
import { createOptimisticChatMessageId } from '../screens/chat/chatMessageIds';

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
      const messageId = createOptimisticChatMessageId();
      await appendOutgoingPendingLocal({
        currentUserId,
        peerId,
        message: {
          id: messageId,
          text,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
          type: 'text',
        },
      });
      const result: any = await sendMessage({
        to: peerId,
        text,
        type: 'text',
        clientUiMessageId: messageId,
      });
      if (result?.ok) sent += 1;
      continue;
    }

    const localUri = String(item.uri || '').trim();
    if (!localUri) continue;

    if (item.kind === 'image') {
      const messageId = createOptimisticChatMessageId();
      const fileName = item.name || `file_${Date.now()}`;
      await appendOutgoingPendingLocal({
        currentUserId,
        peerId,
        message: {
          id: messageId,
          type: 'image',
          uri: localUri,
          name: fileName,
          size: item.size || 0,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
        },
      });
      const upload = await uploadMediaToServer(localUri, 'image', undefined, currentUserId, peerId);
      if (!upload.success || !upload.url) continue;
      const result: any = await sendMessage({
        to: peerId,
        type: 'image',
        uri: upload.url,
        name: fileName,
        size: item.size || undefined,
        clientUiMessageId: messageId,
      });
      if (result?.ok) sent += 1;
      continue;
    }

    if (item.kind === 'audio') {
      const messageId = createOptimisticChatMessageId();
      const fileName = item.name || `voice_${Date.now()}.m4a`;
      await appendOutgoingPendingLocal({
        currentUserId,
        peerId,
        message: {
          id: messageId,
          type: 'audio',
          uri: localUri,
          name: fileName,
          size: item.size || 0,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
        },
      });
      const result: any = await sendMessage({
        to: peerId,
        type: 'audio',
        localUri,
        name: fileName,
        size: item.size || undefined,
        clientUiMessageId: messageId,
      });
      if (result?.ok) sent += 1;
      continue;
    }

    if (item.kind === 'document') {
      const messageId = createOptimisticChatMessageId();
      const label = item.name ? `File: ${item.name}` : 'File';
      await appendOutgoingPendingLocal({
        currentUserId,
        peerId,
        message: {
          id: messageId,
          text: label,
          sender: 'me',
          from: currentUserId,
          to: peerId,
          timestamp: new Date(),
          type: 'text',
        },
      });
      const remoteUrl = await uploadRawShareFile(localUri);
      if (!remoteUrl) continue;
      const result: any = await sendMessage({
        to: peerId,
        type: 'text',
        text: `${label}\n${remoteUrl}`,
        clientUiMessageId: messageId,
      });
      if (result?.ok) sent += 1;
    }
  }

  return sent;
}
