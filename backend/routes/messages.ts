import { Router } from 'express';
import mongoose from 'mongoose';
import FriendshipMessages, { IFriendshipMessages } from '../models/FriendshipMessages';
import OfflineMessage from '../models/OfflineMessage';
import { areFriendsCached } from '../utils/friendshipUtils';

const router = Router();

const isOid = (s?: string) => !!s && mongoose.Types.ObjectId.isValid(String(s));

async function getOrCreateFriendship(user1Id: string, user2Id: string): Promise<IFriendshipMessages | null> {
  try {
    const [user1, user2] = [user1Id, user2Id].sort();
    let friendship = await FriendshipMessages.findOne({
      $or: [
        { user1: user1, user2: user2 },
        { user1: user2, user2: user1 },
      ],
    });

    if (!friendship) {
      friendship = new FriendshipMessages({
        user1: new mongoose.Types.ObjectId(user1),
        user2: new mongoose.Types.ObjectId(user2),
        textMessages: [],
        imageMessages: [],
        audioMessages: [],
        lastActivity: new Date(),
      });
      await friendship.save();
    }

    return friendship;
  } catch {
    return null;
  }
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

    if (!isOid(to)) return res.status(400).json({ ok: false, error: 'invalid_to' });
    if (type !== 'text' && type !== 'image' && type !== 'audio') return res.status(400).json({ ok: false, error: 'invalid_type' });

    const isFriend = await areFriendsCached(me, to);
    if (!isFriend) return res.status(403).json({ ok: false, error: 'not_friends' });

    const friendship = await getOrCreateFriendship(me, to);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const timestamp = new Date();

    const messageItem = {
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

    await (friendship as any).addMessage(messageItem);

    // If recipient is offline, persist as offline message (same semantics as socket flow)
    try {
      const io = (req as any).io as any | undefined;
      const isRecipientOnline = !!io?.sockets?.sockets
        && Array.from(io.sockets.sockets.values()).some((s: any) => String(s?.data?.userId) === String(to));

      if (io && isRecipientOnline) {
        const payload = {
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
        for (const s of io.sockets.sockets.values()) {
          if (String((s as any)?.data?.userId) === String(to)) {
            try { s.emit('message:received', payload); } catch {}
          }
        }
        return res.json({ ok: true, messageId, timestamp, delivered: true });
      }

      // offline path
      await OfflineMessage.create({
        recipientId: new mongoose.Types.ObjectId(to),
        senderId: new mongoose.Types.ObjectId(me),
        messageId,
        messageData: {
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
        },
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
    }));

    return res.json({ ok: true, messages: formatted, hasMore: allMessages.length > limit });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * POST /api/messages/mark_read
 * Body: { from }
 */
router.post('/messages/mark_read', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const from = String(req.body?.from || '').trim();
    if (!isOid(from)) return res.status(400).json({ ok: false, error: 'invalid_from' });

    // Keep behavior consistent with socket flow: we mostly update unread queue in memory there.
    // For REST we mark messages as read in the friendship document to provide correctness.
    const friendship = await getOrCreateFriendship(me, from);
    if (!friendship) return res.status(500).json({ ok: false, error: 'friendship_not_found' });

    try {
      (friendship as any).markAllFromAsRead?.(from);
    } catch {
      // fallback: best-effort scan
      const all = (friendship as any).getAllMessages?.() || [];
      for (const m of all) {
        try {
          const isFrom = String(m?.from?.toString?.() || m?.from) === String(from);
          if (isFrom) m.read = true;
        } catch {}
      }
    }
    await friendship.save();

    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'server_error' });
  }
});

/**
 * POST /api/messages/edit
 * Body: { messageId, text }
 * Только текстовые сообщения, только отправитель может редактировать.
 */
router.post('/messages/edit', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const messageId = String(req.body?.messageId || '').trim();
    const text = typeof req.body?.text === 'string' ? String(req.body.text).trim() : '';
    if (!messageId || text === '') return res.status(400).json({ ok: false, error: 'bad_request' });

    const friendship = await FriendshipMessages.findOne({
      $and: [
        { $or: [{ user1: me }, { user2: me }] },
        { $or: [{ 'textMessages.id': messageId }] },
      ],
    });

    if (!friendship) return res.json({ ok: false, error: 'not_found' });

    const updated = await (friendship as any).updateMessage(messageId, me, text);
    if (!updated) return res.json({ ok: false, error: 'not_found_or_forbidden' });

    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        const u1 = String((friendship as any).user1?.toString?.() || (friendship as any).user1 || '');
        const u2 = String((friendship as any).user2?.toString?.() || (friendship as any).user2 || '');
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
 */
router.post('/messages/delete', async (req, res) => {
  try {
    const me = String((req as any)?.userId || '').trim();
    if (!isOid(me)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    const messageId = String(req.body?.messageId || '').trim();
    if (!messageId) return res.status(400).json({ ok: false, error: 'bad_message_id' });

    const friendship = await FriendshipMessages.findOne({
      $and: [
        { $or: [{ user1: me }, { user2: me }] },
        { $or: [{ 'textMessages.id': messageId }, { 'imageMessages.id': messageId }, { 'audioMessages.id': messageId }] },
      ],
    });

    if (!friendship) return res.json({ ok: false, error: 'not_found' });

    const msg = (friendship as any).findMessageById?.(messageId);
    if (!msg) return res.json({ ok: false, error: 'not_found' });

    // Allow either participant to delete any message in this friendship (delete for both).
    // This matches the product requirement: deletion removes message for BOTH users.

    const removed = await (friendship as any).removeMessage(messageId);
    if (!removed) return res.json({ ok: false, error: 'remove_failed' });

    // Best-effort realtime notify (if sockets are up)
    try {
      const io = (req as any).io as any | undefined;
      if (io) {
        const u1 = String((friendship as any).user1?.toString?.() || (friendship as any).user1 || '');
        const u2 = String((friendship as any).user2?.toString?.() || (friendship as any).user2 || '');
        const payload = { messageId, deletedBy: me };
        if (u1) io.to(`u:${u1}`).emit('message:deleted', payload);
        if (u2) io.to(`u:${u2}`).emit('message:deleted', payload);
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

      (friendship as any).textMessages = [];
      (friendship as any).imageMessages = [];
      (friendship as any).audioMessages = [];
      (friendship as any).lastMessage = undefined;
      (friendship as any).lastActivity = new Date();
      await friendship.save();
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

