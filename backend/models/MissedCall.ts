// models/MissedCall.ts
// Пропущенные видеозвонки: сохраняются при таймауте/отмене, чтобы получатель мог увидеть их после восстановления сети.
import { Schema, model, models, type Types } from 'mongoose';

export interface IMissedCall {
  _id: Types.ObjectId;
  calleeId: Types.ObjectId;
  callerId: Types.ObjectId;
  callerNick: string;
  createdAt: Date;
}

const MissedCallSchema = new Schema<IMissedCall>(
  {
    calleeId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callerNick: { type: String, default: '' },
  },
  { timestamps: true, collection: 'missed_calls' }
);

MissedCallSchema.index({ calleeId: 1, createdAt: -1 });

export default (models.MissedCall as any) || model<IMissedCall>('MissedCall', MissedCallSchema);
