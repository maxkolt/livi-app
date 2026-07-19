import { Router } from 'express';
import mongoose from 'mongoose';
import FriendshipMessages from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached, getOrCreateFriendship, invalidateFriendshipCache } from '../utils/friendshipUtils';
import {
  MAX_MESSAGE_BATCH_SIZE,
  backfillFriendshipMessageItems,
  clearChatMessagesForUsers,
  deleteMessagesForBothUsersBatch,
  emitMessageDeletedToParticipants,
  emitMessagesDeletedToParticipants,
  fetchFriendshipMessagesPage,
  findLegacyMessageFriendshipId,
  findLegacyMessageForUser,
  markMessagesReadForUser,
  normalizeIncomingImageUris,
  normalizeMessageIdBatch,
  removeLegacyFriendshipMessages,
  removeUnreadMessage,
} from '../sockets/messagesReliable';
import { emitToUser } from '../utils/emitToUser';

const router = Router();

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;

function isDuplicateKeyError(error: any): boolean {
  return error?.code === 11000 || String(error?.message || '').includes('E11000');
}

async function isUserRoomOnline(io: any, userId: string): Promise<boolean> {
  try {
    const sockets = await io?.in?.(`u:${String(userId)}`)?.fetchSockets?.();
    return Array.isArray(sockets) && sockets.length > 0;
  } catch {
    return false;
  }
}

function normalizeClientMessageId(payload: any): string {
  const raw = String(payload?.clientMessageId || payload?.clientId || '').trim();
  return CLIENT_MESSAGE_ID_RE.test(raw) ? raw : '';
}

function toFriendshipMessageSnapshot(message: any): any {
  const snapshot: any = {
    id: String(message.id),
    from: message.from,
    to: message.to,
    type: message.type,
    text: message.text,
    uri: message.uri,
    name: message.name,
    size: message.size,
    duration: message.duration,
    stickerId: message.stickerId,
    stickerPackId: message.stickerPackId,
    stickerEmoji: message.stickerEmoji,
    stickerLabel: message.stickerLabel,
    timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp || Date.now()),
    read: !!message.read,
  };
  if (Array.isArray(message.uris) && message.uris.length > 0) {
    snapshot.uris = message.uris.map((u: any) => String(u || '').trim()).filter(Boolean).slice(0, 10);
    if (!snapshot.uri && snapshot.uris[0]) snapshot.uri = snapshot.uris[0];
  }
  if (Array.isArray(message.reactions)) snapshot.reactions = message.reactions;
  if (message.replyTo && message.replyTo.id) snapshot.replyTo = message.replyTo;
  return snapshot;
}

async function refreshFriendshipLastMessage(friendshipId: mongoose.Types.ObjectId | null) {
  if (!friendshipId) return;
  const latestItem = await FriendshipMessageItem.findOne({ friendshipId })
    .sort({ timestamp: -1 })
    .lean();
  if (latestItem) {
    const snapshot = toFriendshipMessageSnapshot(latestItem);
    await FriendshipMessages.updateOne(
      { _id: friendshipId },
      { $set: { lastMessage: snapshot, lastActivity: snapshot.timestamp } }
    ).exec();
    return;
  }

  await FriendshipMessages.updateOne(
    { _id: friendshipId },
    { $unset: { lastMessage: '' }, $set: { lastActivity: new Date() } }
  ).exec();
}

async function deleteMessageForBothUsers(me: string, messageId: string): Promise<{
  ok: boolean;
  fromUserId?: string;
  toUserId?: string;
  error?: string;
}> {
  let fromUserId = '';
  let toUserId = '';
  let friendshipId: mongoose.Types.ObjectId | null = null;

  const meOid = new mongoose.Types.ObjectId(me);
  let doc = await FriendshipMessageItem.findOne({
    id: messageId,
    $or: [{ from: meOid }, { to: meOid }],
  }).select('from to friendshipId type').lean();
  if (!doc) {
    const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
    if (legacyFriendshipId) {
      await backfillFriendshipMessageItems(legacyFriendshipId);
      doc = await FriendshipMessageItem.findOne({
        id: messageId,
        $or: [{ from: meOid }, { to: meOid }],
      }).select('from to friendshipId type').lean();
    }
  }
  if (!doc) {
    doc = await findLegacyMessageForUser(messageId, meOid) as any;
  }
  if (doc) {
    fromUserId = String((doc as any).from);
    toUserId = String((doc as any).to);
    friendshipId = (doc as any).friendshipId;
    await Promise.all([
      FriendshipMessageItem.deleteOne({ friendshipId, id: messageId }).exec(),
      removeLegacyFriendshipMessages(friendshipId, [messageId]),
    ]);
    await refreshFriendshipLastMessage(friendshipId);
  } else {
    return { ok: false, error: 'not_found' };
  }

  try {
    if (toUserId && fromUserId) {
      removeUnreadMessage(toUserId, fromUserId, messageId);
      await OfflineMessage.deleteMany({
        recipientId: new mongoose.Types.ObjectId(toUserId),
        senderId: new mongoose.Types.ObjectId(fromUserId),
        messageId,
      });
      invalidateFriendshipCache(fromUserId, toUserId);
    }
  } catch {}

  return { ok: true, fromUserId, toUserId };
}

/**
 * POST /api/messages/send
 * Body: { to, type: 'text'|'image'|'audio'|'sticker', text?, uri?, name?, size?, duration?, stickerId? }
 */
router.post('/messages/send', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const to = String(req.body?.to || '').trim();
    const type = String(req.body?.type || '').trim() as 'text' | 'image' | 'audio' | 'sticker';
    const text = typeof req.body?.text === 'string' ? String(req.body.text) : undefined;
    const uri = typeof req.body?.uri === 'string' ? String(req.body.uri) : undefined;
    const rawUris = Array.isArray(req.body?.uris) ? req.body.uris : undefined;
    const name = typeof req.body?.name === 'string' ? String(req.body.name) : undefined;
    const size = typeof req.body?.size === 'number' ? Number(req.body.size) : undefined;
    const duration = typeof req.body?.duration === 'number' ? Number(req.body.duration) : undefined;
    const stickerId = typeof req.body?.stickerId === 'string' ? String(req.body.stickerId) : undefined;
    const stickerPackId = typeof req.body?.stickerPackId === 'string' ? String(req.body.stickerPackId) : undefined;
    const stickerEmoji = typeof req.body?.stickerEmoji === 'string' ? String(req.body.stickerEmoji) : undefined;
    const stickerLabel = typeof req.body?.stickerLabel === 'string' ? String(req.body.stickerLabel) : undefined;
    const clientMessageId = normalizeClientMessageId(req.body);
    const replyTo = req.body?.replyTo && typeof req.body.replyTo === 'object' && req.body.replyTo.id
      ? { id: String(req.body.replyTo.id), text: req.body.replyTo.text != null ? String(req.body.replyTo.text) : undefined, from: String(req.body.replyTo.from || '') }
      : undefined;

    if (!isOid(to)) return res.status(400).json({ ok: false, error: 'invalid_to' });
    if (type !== 'text' && type !== 'image' && type !== 'audio' && type !== 'sticker') return res.status(400).json({ ok: false, error: 'invalid_type' });

    const isFriend = await areFriendsCached(me, to);
    if (!isFriend) return res.status(403).json({ ok: false, error: 'not_friends' });

    const friendship = await getOrCreateFriendship(me, to);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    const friendshipId = (friendship as any)._id;
    if (clientMessageId) {
      const existing = await FriendshipMessageItem.findOne({
        friendshipId,
        id: clientMessageId,
        from: new mongoose.Types.ObjectId(me),
        to: new mongoose.Types.ObjectId(to),
      }).select('id timestamp').lean();
      if (existing) {
        const io = (req as any).io as any | undefined;
        const delivered = io ? await isUserRoomOnline(io, to) : false;
        return res.json({
          ok: true,
          duplicate: true,
          messageId: String((existing as any).id || ''),
          timestamp: (existing as any).timestamp || new Date(),
          delivered,
        });
      }
    }

    const messageId = clientMessageId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const timestamp = new Date();

    const imageUris = type === 'image' ? normalizeIncomingImageUris({ uri, uris: rawUris }) : [];
    if (type === 'image' && imageUris.length === 0) {
      return res.status(400).json({ ok: false, error: 'invalid_uri' });
    }
    const primaryUri = type === 'image' ? imageUris[0] : uri;

    const messageItem: any = {
      id: messageId,
      from: new mongoose.Types.ObjectId(me),
      to: new mongoose.Types.ObjectId(to),
      type,
      text,
      uri: primaryUri,
      name,
      size,
      duration,
      stickerId,
      stickerPackId,
      stickerEmoji,
      stickerLabel,
      timestamp,
      read: false,
    };
    if (type === 'image' && imageUris.length > 1) messageItem.uris = imageUris;
    if (replyTo) messageItem.replyTo = replyTo;

    const createItem: any = {
      friendshipId,
      id: messageId,
      from: messageItem.from,
      to: messageItem.to,
      type,
      text,
      uri: primaryUri,
      name,
      size,
      duration,
      stickerId,
      stickerPackId,
      stickerEmoji,
      stickerLabel,
      timestamp,
      read: false,
    };
    if (type === 'image' && imageUris.length > 1) createItem.uris = imageUris;
    if (replyTo) createItem.replyTo = replyTo;
    try {
      await FriendshipMessageItem.create(createItem);
    } catch (error: any) {
      if (!isDuplicateKeyError(error)) throw error;
      const existing = await FriendshipMessageItem.findOne({
        friendshipId,
        id: messageId,
        from: new mongoose.Types.ObjectId(me),
        to: new mongoose.Types.ObjectId(to),
      }).select('id timestamp').lean();
      if (existing) {
        const io = (req as any).io as any | undefined;
        const delivered = io ? await isUserRoomOnline(io, to) : false;
        return res.json({
          ok: true,
          duplicate: true,
          messageId: String((existing as any).id || ''),
          timestamp: (existing as any).timestamp || new Date(),
          delivered,
        });
      }
      return res.status(409).json({ ok: false, error: 'message_id_conflict' });
    }
    await (friendship as any).addMessage(messageItem);

    // If recipient is offline, persist as offline message (same semantics as socket flow)
    try {
      const io = (req as any).io as any | undefined;
      const isRecipientOnline = io ? await isUserRoomOnline(io, to) : false;

      if (io && isRecipientOnline) {
        const payload: any = {
          id: messageId,
          from: me,
          to,
          type,
          text,
          uri: primaryUri,
          name,
          size,
          duration,
          stickerId,
          stickerPackId,
          stickerEmoji,
          stickerLabel,
          timestamp: timestamp.toISOString(),
          read: false,
        };
        if (type === 'image' && imageUris.length > 1) payload.uris = imageUris;
        if (replyTo) payload.replyTo = replyTo;
        io.to(`u:${String(to)}`).emit('message:received', payload);
        return res.json({ ok: true, messageId, timestamp, delivered: true });
      }

      // offline path
      const messageData: any = {
        id: messageId,
        from: me,
        to,
        type,
        text,
        uri: primaryUri,
        name,
        size,
        duration,
        stickerId,
        stickerPackId,
        stickerEmoji,
        stickerLabel,
        timestamp: timestamp.toISOString(),
        read: false,
      };
      if (type === 'image' && imageUris.length > 1) messageData.uris = imageUris;
      if (replyTo) messageData.replyTo = replyTo;
      await OfflineMessage.create({
        recipientId: new mongoose.Types.ObjectId(to),
        senderId: new mongoose.Types.ObjectId(me),
        messageId,
        messageData,
      });
      return res.json({ ok: true, messageId, timestamp, delivered: false });
    } catch {
      // Even if push/emit/offline persistence fails, message is already persisted in FriendshipMessageItem.
      return res.json({ ok: true, messageId, timestamp, delivered: false });
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * GET /api/messages?with=...&limit=50&before=msgId
 * Reads from FriendshipMessageItem collection (one doc per message) for fast pagination.
 */
router.get('/messages', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const withId = String(req.query.with || '').trim();
    if (!isOid(withId)) return res.status(400).json({ ok: false, error: 'invalid_with' });

    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || '50'), 10) || 50));
    const before = String(req.query.before || '').trim();

    const isFriend = await areFriendsCached(me, withId);
    if (!isFriend) return res.status(403).json({ ok: false, error: 'not_friends' });

    const friendship = await getOrCreateFriendship(me, withId);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    const friendshipId = (friendship as any)._id;
    const { messages, hasMore } = await fetchFriendshipMessagesPage(friendshipId, limit, before);

    return res.json({ ok: true, messages, hasMore });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * POST /api/messages/mark_read
 * Body: { from }
 * updateOne с arrayFilters вместо полного save().
 */
router.post('/messages/mark_read', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const from = String(req.body?.from || '').trim();
    if (!isOid(from)) return res.status(400).json({ ok: false, error: 'invalid_from' });

    const io = (req as any).io as any | undefined;
    const timestamp = new Date().toISOString();
    await markMessagesReadForUser(me, from, (messageIds) => {
      try {
        if (io) {
          io.to(`u:${from}`).emit('messages:read_receipt', {
            messageIds,
            readBy: me,
            timestamp,
          });
        }
      } catch {}
    });

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * POST /api/messages/edit
 * Body: { messageId, text }
 * Только текстовые сообщения, только отправитель может редактировать. Поиск по messageId в БД.
 */
router.post('/messages/edit', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const messageId = String(req.body?.messageId || '').trim();
    const text = typeof req.body?.text === 'string' ? String(req.body.text).trim() : '';
    if (!messageId || text === '') return res.status(400).json({ ok: false, error: 'bad_request' });

    let u1 = '';
    let u2 = '';
    const meOid = new mongoose.Types.ObjectId(me);
    let doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid }).select('from type friendshipId').lean();
    if (!doc) {
      const legacyFriendshipId = await findLegacyMessageFriendshipId(messageId);
      if (legacyFriendshipId) {
        await backfillFriendshipMessageItems(legacyFriendshipId);
        doc = await FriendshipMessageItem.findOne({ id: messageId, from: meOid }).select('from type friendshipId').lean();
      }
    }
    if (!doc) return res.json({ ok: false, error: 'not_found_or_forbidden' });
    if ((doc as any).type !== 'text' || String((doc as any).from) !== me) {
      return res.json({ ok: false, error: 'not_found_or_forbidden' });
    }
    await FriendshipMessageItem.updateOne(
      { friendshipId: (doc as any).friendshipId, id: messageId },
      { $set: { text } }
    ).exec();
    const fr = await FriendshipMessages.findById((doc as any).friendshipId).select('user1 user2').lean();
    if (fr) {
      u1 = String((fr as any).user1);
      u2 = String((fr as any).user2);
    }
    await FriendshipMessages.updateOne(
      { _id: (doc as any).friendshipId, 'lastMessage.id': messageId },
      { $set: { 'lastMessage.text': text, lastActivity: new Date() } }
    ).exec();

    try {
      const io = (req as any).io as any | undefined;
      if (io && (u1 || u2)) {
        const payload = { messageId, text };
        if (u1) io.to(`u:${u1}`).emit('message:edited', payload);
        if (u2) io.to(`u:${u2}`).emit('message:edited', payload);
      }
    } catch {}

    return res.json({ ok: true, messageId, text });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * POST /api/messages/delete
 * Body: { messageId }
 * Поиск по messageId в БД (FriendshipMessageItem или FriendshipMessages).
 */
router.post('/messages/delete', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const messageId = String(req.body?.messageId || '').trim();
    if (!messageId) return res.status(400).json({ ok: false, error: 'bad_message_id' });
    const result = await deleteMessageForBothUsers(me, messageId);
    if (!result.ok) return res.json({ ok: false, error: result.error || 'not_found' });

    try {
      const io = (req as any).io as any | undefined;
      if (io && (result.fromUserId || result.toUserId)) {
        const payload = { messageId, deletedBy: me };
        emitMessageDeletedToParticipants(io, result.fromUserId, result.toUserId, payload);
      }
    } catch {}

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

router.post('/messages/delete_many', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const messageIds = normalizeMessageIdBatch(req.body?.messageIds);
    if (messageIds.length === 0) return res.status(400).json({ ok: false, error: 'bad_message_ids' });
    if (messageIds.length > MAX_MESSAGE_BATCH_SIZE) {
      return res.status(413).json({
        ok: false,
        error: 'too_many_message_ids',
        max: MAX_MESSAGE_BATCH_SIZE,
        deletedIds: [],
        failedIds: messageIds,
      });
    }

    const result = await deleteMessagesForBothUsersBatch(me, messageIds);

    try {
      const io = (req as any).io as any | undefined;
      if (io && result.deletedIds.length > 0) {
        const payload = { messageIds: result.deletedIds, deletedBy: me };
        emitMessagesDeletedToParticipants(io, result.recipients, payload);
      }
    } catch {}

    return res.json({
      ok: result.deletedIds.length > 0,
      deletedIds: result.deletedIds,
      failedIds: result.failedIds,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error', deletedIds: [], failedIds: [] });
  }
});

/**
 * POST /api/messages/clear_chat
 * Body: { with, forAll }
 *
 * IMPORTANT:
 * - forAll=true: clears server history for BOTH users (shared history)
 * - forAll=false: "clear only for me" is a client-local operation in current architecture,
 *   so we acknowledge success and only emit an event to initiator (no DB mutation).
 */
router.post('/messages/clear_chat', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const withId = String(req.body?.with || '').trim();
    const forAll = !!req.body?.forAll;
    if (!isOid(withId)) return res.status(400).json({ ok: false, error: 'invalid_with' });

    const result = await clearChatMessagesForUsers(me, withId, forAll);
    if (!result.ok || !result.payload) {
      const status = result.error === 'not_friends' ? 403 : 500;
      return res.status(status).json({ ok: false, error: result.error || 'server_error' });
    }

    // Best-effort realtime notify (if sockets are up)
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        emitToUser(io, me, 'message:chat_cleared', result.payload);
        if (forAll) {
          emitToUser(io, withId, 'message:chat_cleared', result.payload);
        }
      }
    } catch {}

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

export default router;

