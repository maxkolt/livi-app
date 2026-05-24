/**
 * One-time migration: copy all messages from FriendshipMessages (embedded arrays)
 * into the FriendshipMessageItem collection.
 * Run once from project root: npx ts-node backend/scripts/migrate-messages-to-items.ts
 * Or from backend/: npx ts-node scripts/migrate-messages-to-items.ts
 * Requires MONGO_URI/MONGO_DB in env (loads backend/.env if present).
 * Safe to re-run: skips messages that already exist in friendshipmessageitems.
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import mongoose from 'mongoose';
import FriendshipMessages from '../models/FriendshipMessages';
import FriendshipMessageItem from '../models/FriendshipMessageItem';

const MONGO_URI =
  process.env.MONGO_DB ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  '';

async function run() {
  if (!MONGO_URI) {
    console.error('Set MONGO_URI (or MONGO_DB/MONGODB_URI)');
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI);
  const docs = await FriendshipMessages.find({}).lean();
  let inserted = 0;
  for (const doc of docs) {
    const friendshipId = (doc as any)._id;
    const items: any[] = [];
    for (const arr of [
      (doc as any).textMessages || [],
      (doc as any).imageMessages || [],
      (doc as any).audioMessages || [],
      (doc as any).stickerMessages || [],
    ]) {
      for (const m of arr) {
        if (!m || !m.id) continue;
        items.push({
          friendshipId,
          id: m.id,
          from: m.from,
          to: m.to,
          type: m.type || 'text',
          text: m.text,
          uri: m.uri,
          name: m.name,
          size: m.size,
          duration: m.duration,
          stickerId: m.stickerId,
          stickerPackId: m.stickerPackId,
          stickerEmoji: m.stickerEmoji,
          stickerLabel: m.stickerLabel,
          timestamp: m.timestamp || new Date(),
          read: !!m.read,
          reactions: Array.isArray(m.reactions) ? m.reactions : undefined,
          replyTo: m.replyTo && m.replyTo.id ? m.replyTo : undefined,
        });
      }
    }
    if (items.length) {
      const ids = items.map((i) => i.id);
      const existing = await FriendshipMessageItem.find({ id: { $in: ids } }).select('id').lean();
      const existingSet = new Set((existing as any[]).map((e) => e.id));
      const toInsert = items.filter((i) => !existingSet.has(i.id));
      if (toInsert.length) {
        await FriendshipMessageItem.insertMany(toInsert);
        inserted += toInsert.length;
      }
    }
  }
  console.log(`Migrated ${inserted} messages from ${docs.length} friendships.`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
