import mongoose, { Schema, Document } from 'mongoose';

export interface IReaction {
  emoji: string;
  userId: string;
}

export interface IReplyTo {
  id: string;
  text?: string;
  from: string;
}

export interface IFriendshipMessageItem extends Document {
  _id: mongoose.Types.ObjectId;
  friendshipId: mongoose.Types.ObjectId;
  id: string; // messageId (msg_...)
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  type: 'text' | 'image' | 'audio' | 'sticker';
  text?: string;
  uri?: string;
  /** Album: up to 10 image URLs in one message. `uri` stays as first for back-compat. */
  uris?: string[];
  name?: string;
  size?: number;
  duration?: number;
  stickerId?: string;
  stickerPackId?: string;
  stickerEmoji?: string;
  stickerLabel?: string;
  timestamp: Date;
  read: boolean;
  reactions?: IReaction[];
  replyTo?: IReplyTo;
}

const ReactionSchema = new Schema<IReaction>(
  { emoji: { type: String, required: true }, userId: { type: String, required: true } },
  { _id: false }
);

const FriendshipMessageItemSchema = new Schema<IFriendshipMessageItem>(
  {
    friendshipId: { type: Schema.Types.ObjectId, ref: 'FriendshipMessages', required: true },
    id: { type: String, required: true },
    from: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'image', 'audio', 'sticker'], required: true },
    text: String,
    uri: String,
    uris: { type: [String], default: undefined },
    name: String,
    size: Number,
    duration: Number,
    stickerId: String,
    stickerPackId: String,
    stickerEmoji: String,
    stickerLabel: String,
    timestamp: { type: Date, default: Date.now },
    read: { type: Boolean, default: false },
    // Omit empty array on insert — only store when someone reacts.
    reactions: { type: [ReactionSchema], default: undefined },
    replyTo: {
      type: {
        id: { type: String, required: true },
        text: String,
        from: { type: String, required: true }
      },
      default: undefined
    },
  },
  { timestamps: false, versionKey: false }
);

FriendshipMessageItemSchema.index({ friendshipId: 1, timestamp: -1 });
FriendshipMessageItemSchema.index({ friendshipId: 1, id: 1 }, { unique: true });
// Unread scan only — keep small via partial filter (read:false docs only).
FriendshipMessageItemSchema.index(
  { friendshipId: 1, from: 1, to: 1, timestamp: 1, _id: 1 },
  {
    name: 'friendship_unread_partial',
    partialFilterExpression: { read: false },
  }
);
FriendshipMessageItemSchema.index({ id: 1 });

const FriendshipMessageItem = mongoose.model<IFriendshipMessageItem>(
  'FriendshipMessageItem',
  FriendshipMessageItemSchema
);

/** Drop legacy unread compound index if present; ensure current indexes exist. */
export async function ensureFriendshipMessageItemIndexes(): Promise<void> {
  const coll = FriendshipMessageItem.collection;
  const obsoleteNames = [
    'friendshipId_1_from_1_to_1_read_1_timestamp_1__id_1',
  ];
  for (const name of obsoleteNames) {
    try {
      await coll.dropIndex(name);
    } catch (err: any) {
      if (err?.code !== 27 && err?.codeName !== 'IndexNotFound') {
        console.warn(`[FriendshipMessageItem] dropIndex(${name}):`, err?.message || err);
      }
    }
  }
  try {
    await FriendshipMessageItem.createIndexes();
  } catch (err: any) {
    console.warn('[FriendshipMessageItem] createIndexes:', err?.message || err);
  }
}

export default FriendshipMessageItem;
