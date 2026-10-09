// models/FliqUserState.ts
// Что пользователь уже видел в Fliq и какие темы досматривает — по этому строится выдача.
import { Schema, model, models, type Types } from 'mongoose';

export interface IFliqUserState {
  user: Types.ObjectId;
  /** Последние просмотренные ролики (videoId), самые новые в конце. */
  seen: string[];
  /** Вес темы: растёт от досмотров и пересылок, падает от быстрых пролистываний. */
  topicWeights: Record<string, number>;
  updatedAt: Date;
}

const FliqUserStateSchema = new Schema<IFliqUserState>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    seen: { type: [String], default: [] },
    topicWeights: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'fliq_user_state', minimize: false }
);

export default (models.FliqUserState as any) || model<IFliqUserState>('FliqUserState', FliqUserStateSchema);
