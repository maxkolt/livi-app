import { Router } from 'express';
import mongoose from 'mongoose';
import FriendshipMessages from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached, getOrCreateFriendship, invalidateFriendshipCache } from '../utils/friendshipUtils';
import { removeUnreadMessage } from '../sockets/messagesReliable';

const router = Router();

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

async function purgeMessageFromFriendship(friendshipId: mongoose.Types.ObjectId | null, messageId: string) {
  if (!friendshipId || !messageId) return;
  await FriendshipMessages.updateOne(
    { _id: friendshipId },
    {
      $pull: {
        textMessages: { id: messageId },
        imageMessages: { id: messageId },
        audioMessages: { id: messageId },
      },
      $set: { lastActivity: new Date() },
    }
  ).exec();
}

/**
 * POST /api/messages/send
 * Body: { to, type: 'text'|'image'|'audio', text?, uri?, name?, size?, duration? }
 */
router.post('/messages/send', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const to = String(req.body?.to || '').trim();
    const type = String(req.body?.type || '').trim() as 'text' | 'image' | 'audio';
    const text = typeof req.body?.text === 'string' ? String(req.body.text) : undefined;
    const uri = typeof req.body?.uri === 'string' ? String(req.body.uri) : undefined;
    const name = typeof req.body?.name === 'string' ? String(req.body.name) : undefined;
    const size = typeof req.body?.size === 'number' ? Number(req.body.size) : undefined;
    const duration = typeof req.body?.duration === 'number' ? Number(req.body.duration) : undefined;
    const replyTo = req.body?.replyTo && typeof req.body.replyTo === 'object' && req.body.replyTo.id
      ? { id: String(req.body.replyTo.id), text: req.body.replyTo.text != null ? String(req.body.replyTo.text) : undefined, from: String(req.body.replyTo.from || '') }
      : undefined;

    if (!isOid(to)) return res.status(400).json({ ok: false, error: 'invalid_to' });
    if (type !== 'text' && type !== 'image' && type !== 'audio') return res.status(400).json({ ok: false, error: 'invalid_type' });

    const isFriend = await areFriendsCached(me, to);
    if (!isFriend) return res.status(403).json({ ok: false, error: 'not_friends' });

    const friendship = await getOrCreateFriendship(me, to);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
      timestamp,
      read: false,
    };
    if (replyTo) messageItem.replyTo = replyTo;

    await (friendship as any).addMessage(messageItem);

    const createItem: any = {
      friendshipId: (friendship as any)._id,
      id: messageId,
      from: messageItem.from,
      to: messageItem.to,
      type,
      text,
      uri,
      name,
      size,
      duration,
      timestamp,
      read: false,
    };
    if (replyTo) createItem.replyTo = replyTo;
    await FriendshipMessageItem.create(createItem);

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
      // Even if push/emit/offline persistence fails, message is already persisted in FriendshipMessages.
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
        },
      },
      {
        arrayFilters: [
          { 't.from': fromOid },
          { 'i.from': fromOid },
          { 'a.from': fromOid },
        ],
      }
    ).exec();
    await FriendshipMessageItem.updateMany(
      { friendshipId: fid, from: fromOid },
      { $set: { read: true } }
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

    let fromUserId = '';
    let toUserId = '';
    let friendshipId: mongoose.Types.ObjectId | null = null;
    let msgType: 'text' | 'image' | 'audio' = 'text';

    const doc = await FriendshipMessageItem.findOne({ id: messageId }).select('from to friendshipId type').lean();
    if (doc) {
      fromUserId = String((doc as any).from);
      toUserId = String((doc as any).to);
      friendshipId = (doc as any).friendshipId;
      msgType = (doc as any).type;
      if (fromUserId !== me && toUserId !== me) return res.json({ ok: false, error: 'not_found' });
      await FriendshipMessageItem.deleteOne({ id: messageId }).exec();
      await purgeMessageFromFriendship(friendshipId, messageId);
    } else {
      const list = await FriendshipMessages.find({
        $and: [
          { $or: [{ user1: me }, { user2: me }] },
          { $or: [{ 'textMessages.id': messageId }, { 'imageMessages.id': messageId }, { 'audioMessages.id': messageId }] },
        ],
      }).lean();
      const fd = list.find((f: any) => {
        const arr = [...(f.textMessages || []), ...(f.imageMessages || []), ...(f.audioMessages || [])];
        const m = arr.find((x: any) => x.id === messageId);
        if (m) {
          fromUserId = String(m.from);
          toUserId = String(m.to);
          friendshipId = f._id;
          msgType = (m.type || 'text');
          return true;
        }
        return false;
      });
      if (!fd) return res.json({ ok: false, error: 'not_found' });
      const friendship = await FriendshipMessages.findOne({ _id: (fd as any)._id });
      if (friendship) await (friendship as any).removeMessage(messageId);
      await purgeMessageFromFriendship(friendshipId, messageId);
    }

    try {
      if (toUserId && fromUserId) {
        removeUnreadMessage(toUserId, fromUserId, messageId);
        await OfflineMessage.deleteMany({
          recipientId: new mongoose.Types.ObjectId(toUserId),
          messageId,
        });
      }
    } catch {}

    try {
      const io = (req as any).io as any | undefined;
      if (io && (fromUserId || toUserId)) {
        const payload = { messageId, deletedBy: me };
        if (fromUserId) io.to(`u:${fromUserId}`).emit('message:deleted', payload);
        if (toUserId) io.to(`u:${toUserId}`).emit('message:deleted', payload);
      }
    } catch {}

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
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
        { $set: { textMessages: [], imageMessages: [], audioMessages: [], lastMessage: undefined, lastActivity: new Date() } }
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

