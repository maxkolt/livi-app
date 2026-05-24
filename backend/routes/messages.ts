import { Router } from 'express';
import mongoose from 'mongoose';
import FriendshipMessages from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached, getOrCreateFriendship, invalidateFriendshipCache } from '../utils/friendshipUtils';
import { removeUnreadMessage } from '../sockets/messagesReliable';

const router = Router();

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9:_-]{1,120}$/;

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

  const friendship = await FriendshipMessages.findById(friendshipId).lean();
  const legacyMessages = [
    ...((friendship as any)?.textMessages || []),
    ...((friendship as any)?.imageMessages || []),
    ...((friendship as any)?.audioMessages || []),
    ...((friendship as any)?.stickerMessages || []),
  ].sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  if (legacyMessages.length > 0) {
    const snapshot = toFriendshipMessageSnapshot(legacyMessages[0]);
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

async function purgeMessageFromFriendship(friendshipId: mongoose.Types.ObjectId | null, messageId: string) {
  if (!friendshipId || !messageId) return;
  await FriendshipMessages.updateOne(
    { _id: friendshipId },
    {
      $pull: {
        textMessages: { id: messageId },
        imageMessages: { id: messageId },
        audioMessages: { id: messageId },
        stickerMessages: { id: messageId },
      },
    }
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

  const doc = await FriendshipMessageItem.findOne({ id: messageId }).select('from to friendshipId type').lean();
  if (doc) {
    fromUserId = String((doc as any).from);
    toUserId = String((doc as any).to);
    friendshipId = (doc as any).friendshipId;
    if (fromUserId !== me && toUserId !== me) return { ok: false, error: 'not_found' };
    await FriendshipMessageItem.deleteOne({ id: messageId }).exec();
    await purgeMessageFromFriendship(friendshipId, messageId);
    await refreshFriendshipLastMessage(friendshipId);
  } else {
    const list = await FriendshipMessages.find({
      $and: [
        { $or: [{ user1: me }, { user2: me }] },
        { $or: [{ 'textMessages.id': messageId }, { 'imageMessages.id': messageId }, { 'audioMessages.id': messageId }, { 'stickerMessages.id': messageId }] },
      ],
    }).lean();
    const fd = list.find((f: any) => {
      const arr = [...(f.textMessages || []), ...(f.imageMessages || []), ...(f.audioMessages || []), ...(f.stickerMessages || [])];
      const m = arr.find((x: any) => x.id === messageId);
      if (m) {
        fromUserId = String(m.from);
        toUserId = String(m.to);
        friendshipId = f._id;
        return true;
      }
      return false;
    });
    if (!fd) return { ok: false, error: 'not_found' };
    const friendship = await FriendshipMessages.findOne({ _id: (fd as any)._id });
    if (friendship) await (friendship as any).removeMessage(messageId);
    await purgeMessageFromFriendship(friendshipId, messageId);
    await refreshFriendshipLastMessage(friendshipId);
  }

  try {
    if (toUserId && fromUserId) {
      removeUnreadMessage(toUserId, fromUserId, messageId);
      await OfflineMessage.deleteMany({
        recipientId: new mongoose.Types.ObjectId(toUserId),
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
        const delivered = !!io?.sockets?.sockets
          && Array.from(io.sockets.sockets.values()).some((s: any) => String(s?.data?.userId) === String(to));
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

    const messageItem: any = {
      id: messageId,
      from: new mongoose.Types.ObjectId(me),
      to: new mongoose.Types.ObjectId(to),
      type,
      text,
      uri,
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
    if (replyTo) messageItem.replyTo = replyTo;

    const createItem: any = {
      friendshipId,
      id: messageId,
      from: messageItem.from,
      to: messageItem.to,
      type,
      text,
      uri,
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
    if (replyTo) createItem.replyTo = replyTo;
    await FriendshipMessageItem.create(createItem);
    await (friendship as any).addMessage(messageItem);

    // If recipient is offline, persist as offline message (same semantics as socket flow)
    try {
      const io = (req as any).io as any | undefined;
      const isRecipientOnline = !!io?.sockets?.sockets
        && Array.from(io.sockets.sockets.values()).some((s: any) => String(s?.data?.userId) === String(to));

      if (io && isRecipientOnline) {
        const payload: any = {
          id: messageId,
          from: me,
          to,
          type,
          text,
          uri,
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
        if (replyTo) payload.replyTo = replyTo;
        for (const s of io.sockets.sockets.values()) {
          if (String((s as any)?.data?.userId) === String(to)) {
            try { s.emit('message:received', payload); } catch {}
          }
        }
        return res.json({ ok: true, messageId, timestamp, delivered: true });
      }

      // offline path
      const messageData: any = {
        id: messageId,
        from: me,
        to,
        type,
        text,
        uri,
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
    const query: any = { friendshipId };
    if (before) {
      const beforeDoc = await FriendshipMessageItem.findOne(
        { friendshipId, id: before },
        { timestamp: 1 }
      ).lean();
      if (beforeDoc && (beforeDoc as any).timestamp) {
        query.timestamp = { $lt: (beforeDoc as any).timestamp };
      }
    }
    let raw = await FriendshipMessageItem.find(query)
      .sort({ timestamp: -1 })
      .limit(limit + 1)
      .lean();
    if (raw.length === 0) {
      const allMessages = (friendship as any).getAllMessages?.() || [];
      let messages = allMessages;
      if (before) {
        const beforeIndex = messages.findIndex((msg: any) => String(msg?.id) === before);
        if (beforeIndex > 0) messages = messages.slice(0, beforeIndex);
      }
      const sliced = messages.slice(-limit);
      const formatted = sliced.map((msg: any) => ({
        id: String(msg.id),
        from: msg.from?.toString?.() || String(msg.from),
        to: msg.to?.toString?.() || String(msg.to),
        type: msg.type,
        text: msg.text,
        uri: msg.uri,
        name: msg.name,
        size: msg.size,
        duration: msg.duration,
        stickerId: msg.stickerId,
        stickerPackId: msg.stickerPackId,
        stickerEmoji: msg.stickerEmoji,
        stickerLabel: msg.stickerLabel,
        timestamp: msg.timestamp?.toISOString?.() || String(msg.timestamp),
        read: !!msg.read,
        reactions: Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
        ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: String(msg.replyTo.id), text: msg.replyTo.text, from: String(msg.replyTo.from || '') } } : {}),
      }));
      return res.json({ ok: true, messages: formatted, hasMore: allMessages.length > limit });
    }
    const hasMore = raw.length > limit;
    const slice = hasMore ? raw.slice(0, limit) : raw;
    const formatted = slice.reverse().map((msg: any) => ({
      id: String(msg.id),
      from: msg.from?.toString?.() || String(msg.from),
      to: msg.to?.toString?.() || String(msg.to),
      type: msg.type,
      text: msg.text,
      uri: msg.uri,
      name: msg.name,
      size: msg.size,
      duration: msg.duration,
      stickerId: msg.stickerId,
      stickerPackId: msg.stickerPackId,
      stickerEmoji: msg.stickerEmoji,
      stickerLabel: msg.stickerLabel,
      timestamp: msg.timestamp?.toISOString?.() || String(msg.timestamp),
      read: !!msg.read,
      reactions: Array.isArray(msg.reactions) ? msg.reactions.map((r: any) => ({ emoji: r.emoji, userId: String(r.userId) })) : [],
      ...(msg.replyTo && msg.replyTo.id ? { replyTo: { id: String(msg.replyTo.id), text: msg.replyTo.text, from: String(msg.replyTo.from || '') } } : {}),
    }));

    return res.json({ ok: true, messages: formatted, hasMore });
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

    const friendship = await getOrCreateFriendship(me, from);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    const fid = (friendship as any)._id;
    const fromOid = new mongoose.Types.ObjectId(from);
    await FriendshipMessages.updateOne(
      { _id: fid },
      {
        $set: {
          'textMessages.$[t].read': true,
          'imageMessages.$[i].read': true,
          'audioMessages.$[a].read': true,
          'stickerMessages.$[s].read': true,
        },
      },
      {
        arrayFilters: [
          { 't.from': fromOid },
          { 'i.from': fromOid },
          { 'a.from': fromOid },
          { 's.from': fromOid },
        ],
      }
    ).exec();
    await FriendshipMessageItem.updateMany(
      { friendshipId: fid, from: fromOid },
      { $set: { read: true } }
    ).exec();
    await FriendshipMessages.updateOne(
      { _id: fid, 'lastMessage.from': fromOid },
      { $set: { 'lastMessage.read': true } }
    ).exec();

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
    const doc = await FriendshipMessageItem.findOne({ id: messageId }).select('from type friendshipId').lean();
    if (doc) {
      if ((doc as any).type !== 'text' || String((doc as any).from) !== me) {
        return res.json({ ok: false, error: 'not_found_or_forbidden' });
      }
      await FriendshipMessageItem.updateOne({ id: messageId }, { $set: { text } }).exec();
      const fr = await FriendshipMessages.findById((doc as any).friendshipId).select('user1 user2').lean();
      if (fr) {
        u1 = String((fr as any).user1);
        u2 = String((fr as any).user2);
      }
      await FriendshipMessages.updateOne(
        { _id: (doc as any).friendshipId, 'textMessages.id': messageId },
        { $set: { 'textMessages.$.text': text, lastActivity: new Date() } }
      ).exec();
      await FriendshipMessages.updateOne(
        { _id: (doc as any).friendshipId, 'lastMessage.id': messageId },
        { $set: { 'lastMessage.text': text, lastActivity: new Date() } }
      ).exec();
    } else {
      const friendship = await FriendshipMessages.findOne({
        $and: [
          { $or: [{ user1: me }, { user2: me }] },
          { 'textMessages.id': messageId },
        ],
      }).lean();
      if (!friendship) return res.json({ ok: false, error: 'not_found' });
      const msg = ((friendship as any).textMessages || []).find((m: any) => m.id === messageId);
      if (!msg || String(msg.from) !== me) return res.json({ ok: false, error: 'not_found_or_forbidden' });
      u1 = String((friendship as any).user1);
      u2 = String((friendship as any).user2);
      await FriendshipMessages.updateOne(
        { _id: (friendship as any)._id, 'textMessages.id': messageId },
        { $set: { 'textMessages.$.text': text, lastActivity: new Date() } }
      ).exec();
      await FriendshipMessages.updateOne(
        { _id: (friendship as any)._id, 'lastMessage.id': messageId },
        { $set: { 'lastMessage.text': text, lastActivity: new Date() } }
      ).exec();
    }

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
        if (result.fromUserId) io.to(`u:${result.fromUserId}`).emit('message:deleted', payload);
        if (result.toUserId) io.to(`u:${result.toUserId}`).emit('message:deleted', payload);
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

    const messageIds: string[] = Array.from(new Set(
      (Array.isArray(req.body?.messageIds) ? req.body.messageIds : [])
        .map((id: any) => String(id || '').trim())
        .filter(Boolean)
    ));
    if (messageIds.length === 0) return res.status(400).json({ ok: false, error: 'bad_message_ids' });

    const deletedIds: string[] = [];
    const failedIds: string[] = [];
    const recipients = new Set<string>();
    for (const messageId of messageIds) {
      try {
        const result = await deleteMessageForBothUsers(me, messageId);
        if (!result.ok) {
          failedIds.push(messageId);
          continue;
        }
        deletedIds.push(messageId);
        if (result.fromUserId) recipients.add(String(result.fromUserId));
        if (result.toUserId) recipients.add(String(result.toUserId));
      } catch {
        failedIds.push(messageId);
      }
    }

    try {
      const io = (req as any).io as any | undefined;
      if (io && deletedIds.length > 0) {
        const payload = { messageIds: deletedIds, deletedBy: me };
        for (const uid of recipients) {
          io.to(`u:${uid}`).emit('messages:deleted', payload);
          for (const messageId of deletedIds) {
            io.to(`u:${uid}`).emit('message:deleted', { messageId, deletedBy: me });
          }
        }
      }
    } catch {}

    return res.json({ ok: deletedIds.length > 0, deletedIds, failedIds });
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

    const isFriend = await areFriendsCached(me, withId);
    if (!isFriend) return res.status(403).json({ ok: false, error: 'not_friends' });

    if (forAll) {
      const friendship = await getOrCreateFriendship(me, withId);
      if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

      const fid = (friendship as any)._id;
      await FriendshipMessages.updateOne(
        { _id: fid },
        {
          $set: { textMessages: [], imageMessages: [], audioMessages: [], stickerMessages: [], lastActivity: new Date() },
          $unset: { lastMessage: '' },
        }
      ).exec();
      await FriendshipMessageItem.deleteMany({ friendshipId: fid }).exec();
      invalidateFriendshipCache(me, withId);
    }

    // Best-effort realtime notify (if sockets are up)
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        const payload = { by: me, with: withId, forAll };
        io.to(`u:${me}`).emit('message:chat_cleared', payload);
        if (forAll) {
          io.to(`u:${withId}`).emit('message:chat_cleared', payload);
        }
      }
    } catch {}

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

export default router;

