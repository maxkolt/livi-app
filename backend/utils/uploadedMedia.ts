import fs from 'fs';
import path from 'path';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import Message from '../models/Message';
import OfflineMessage from '../models/OfflineMessage';
import { logger } from './logger';

const MEDIA_PATH_RE = /\/uploads\/media\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

/** Имя файла в uploads/media из URI сообщения (относительного или полного). Чужие ссылки — null. */
export function uploadedMediaFileName(uri: unknown): string | null {
  if (typeof uri !== 'string' || !uri.trim()) return null;
  let pathname: string;
  try {
    pathname = new URL(uri.trim(), 'http://local').pathname;
  } catch {
    return null;
  }
  const match = MEDIA_PATH_RE.exec(pathname);
  return match ? match[1] : null;
}

/** Имена файлов из сообщений с медиа (uri + альбомы uris). */
export function collectUploadedMediaNames(items: Array<{ uri?: unknown; uris?: unknown }>): string[] {
  const names = new Set<string>();
  for (const item of items) {
    const all = [item?.uri, ...(Array.isArray(item?.uris) ? item.uris : [])];
    for (const uri of all) {
      const name = uploadedMediaFileName(uri);
      if (name) names.add(name);
    }
  }
  return [...names];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Удаляет файлы, на которые больше не ссылается ни одно сообщение.
 * Пересланное фото хранит тот же URI в чужом чате — такие файлы остаются.
 */
export async function deleteUnreferencedUploadedMedia(names: string[], dir: string): Promise<number> {
  if (!names.length) return 0;
  const patterns = names.map((name) => new RegExp(`/uploads/media/${escapeRegex(name)}$`));
  const [friendItems, messages, offline] = await Promise.all([
    FriendshipMessageItem.find({ $or: [{ uri: { $in: patterns } }, { uris: { $in: patterns } }] })
      .select('uri uris')
      .lean(),
    Message.find({ uri: { $in: patterns } }).select('uri').lean(),
    OfflineMessage.find({
      $or: [{ 'messageData.uri': { $in: patterns } }, { 'messageData.uris': { $in: patterns } }],
    })
      .select('messageData.uri messageData.uris')
      .lean(),
  ]);
  const stillUsed = new Set(
    collectUploadedMediaNames([
      ...(friendItems as any[]),
      ...(messages as any[]),
      ...(offline as any[]).map((doc) => doc?.messageData || {}),
    ]),
  );

  let removed = 0;
  for (const name of names) {
    if (stillUsed.has(name)) continue;
    try {
      await fs.promises.unlink(path.join(dir, name));
      removed += 1;
    } catch (e: any) {
      if (e?.code !== 'ENOENT') logger.warn('[uploadedMedia] unlink failed', { name, error: e?.message });
    }
  }
  return removed;
}
