import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IFriendshipEdge extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  friendId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FriendshipEdgeSchema = new Schema<IFriendshipEdge>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    friendId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    collection: 'friendship_edges',
  }
);

FriendshipEdgeSchema.index({ userId: 1, friendId: 1 }, { unique: true });
FriendshipEdgeSchema.index({ userId: 1, createdAt: 1, _id: 1 });
FriendshipEdgeSchema.index({ friendId: 1, userId: 1 });

const FriendshipEdgeModel: Model<IFriendshipEdge> =
  (mongoose.models.FriendshipEdge as Model<IFriendshipEdge>) ||
  mongoose.model<IFriendshipEdge>('FriendshipEdge', FriendshipEdgeSchema);

export default FriendshipEdgeModel;
