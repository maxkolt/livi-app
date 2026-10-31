// models/MissedCall.ts
// Пропущенные видеозвонки: сохраняются при таймауте/отмене, чтобы получатель мог увидеть их после восстановления сети.
import { Schema, model, models, type Model, type Types } from 'mongoose';

interface IMissedCall {
  _id: Types.ObjectId;
  calleeId: Types.ObjectId;
  callerId: Types.ObjectId;
  callerNick: string;
  callId?: string;
  createdAt: Date;
}

const MissedCallSchema = new Schema<IMissedCall>(
  {
    calleeId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callerNick: { type: String, default: '' },
    callId: { type: String },
  },
  { timestamps: true, collection: 'missed_calls' }
);

MissedCallSchema.index({ calleeId: 1, createdAt: -1 });
MissedCallSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export default (models.MissedCall as Model<IMissedCall> | undefined) || model<IMissedCall>('MissedCall', MissedCallSchema);
