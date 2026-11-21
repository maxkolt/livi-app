import type { RequestHandler } from 'express';
import type { AuthenticatedRequest } from './runtimeTypes';
import MediaUpload from '../models/MediaUpload';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import Message from '../models/Message';
import OfflineMessage from '../models/OfflineMessage';
import FriendshipMessages from '../models/FriendshipMessages';
import path from 'node:path';
import { Types } from 'mongoose';

export function validMediaFileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(name) && !name.includes('..');
}

/** Both the upload owner and participants in a persisted message may read a file. */
export async function canReadMedia(userId: string, filename: string): Promise<boolean> {
  if (!/^[a-f\d]{24}$/i.test(userId) || !validMediaFileName(filename)) return false;
  if (await MediaUpload.exists({ filename, owner: userId })) return true;
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const url = new RegExp('(?:^|/)uploads/media/' + escaped + '$');
  const filter = { $and: [
    { $or: [{ from: userId }, { to: userId }] },
    { $or: [{ uri: url }, { uris: url }, { thumbUri: url }] },
  ] };
  for (const model of [FriendshipMessageItem, Message]) {
    if (await model.exists(filter)) return true;
  }
  if (await OfflineMessage.exists({ $and: [
    { $or: [{ senderId: userId }, { recipientId: userId }] },
    { $or: [{ 'messageData.uri': url }, { 'messageData.uris': url }, { 'messageData.thumbUri': url }] },
  ] })) return true;
  const legacyFilter = { $and: [{ $or: [{ from: new Types.ObjectId(userId) }, { to: new Types.ObjectId(userId) }] }, filter.$and[1]] };
  for (const field of ['messages', 'textMessages', 'imageMessages', 'audioMessages', 'stickerMessages']) {
    if (await FriendshipMessages.collection.findOne({ [field]: { $elemMatch: legacyFilter } }, { projection: { _id: 1 } })) return true;
  }
  return false;
}

/** Mounted before every static handler, including the root static fallback. */
export function privateMediaAccess(options: { enabled: () => boolean; authorize?: typeof canReadMedia }): RequestHandler {
  return async (req, res, next) => {
    let canonical: string;
    try { canonical = path.posix.normalize(decodeURIComponent(req.path).replace(/\\/g, '/')); }
    catch { res.status(400).end(); return; }
    if (!(canonical === '/uploads/media' || canonical.startsWith('/uploads/media/'))) return next();
    // Encrypted attachments always require ownership, including staged rollout
    // while older clients still read their legacy plaintext attachments.
    if (!options.enabled() && !canonical.endsWith('.livi')) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'x-install-id, x-install-secret');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!userId) { res.status(401).end(); return; }
    const filename = canonical.slice('/uploads/media/'.length);
    try {
      if (!validMediaFileName(filename) || !await (options.authorize || canReadMedia)(userId, filename)) {
        res.status(404).end(); return;
      }
      next();
    } catch { res.status(503).end(); }
  };
}
