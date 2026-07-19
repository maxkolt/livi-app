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
    reactions: [ReactionSchema],
    replyTo: {
      type: {
        id: { type: String, required: true },
        text: String,
        from: { type: String, required: true }
      },
      default: undefined
    },
  },
  { timestamps: false }
);

FriendshipMessageItemSchema.index({ friendshipId: 1, timestamp: -1 });
FriendshipMessageItemSchema.index({ friendshipId: 1, id: 1 }, { unique: true });
FriendshipMessageItemSchema.index({ friendshipId: 1, from: 1, to: 1, read: 1, timestamp: 1, _id: 1 });
FriendshipMessageItemSchema.index({ id: 1 });

export default mongoose.model<IFriendshipMessageItem>(
  'FriendshipMessageItem',
  FriendshipMessageItemSchema
);
