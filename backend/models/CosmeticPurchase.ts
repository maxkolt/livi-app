import { Schema, model, models, Types, Model } from 'mongoose';

export type CosmeticKind = 'frame' | 'background';

export interface ICosmeticPurchase {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  kind: CosmeticKind;
  itemId: string;
  amount: string;
  currency: 'RUB';
  yookassaPaymentId: string;
  status: 'pending' | 'succeeded' | 'canceled';
  test: boolean;
  grantedAt?: Date;
}

const CosmeticPurchaseSchema = new Schema<ICosmeticPurchase>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['frame', 'background'], required: true },
    itemId: { type: String, required: true },
    amount: { type: String, required: true },
    currency: { type: String, enum: ['RUB'], default: 'RUB' },
    yookassaPaymentId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending', 'succeeded', 'canceled'], default: 'pending', index: true },
    test: { type: Boolean, default: false },
    grantedAt: { type: Date },
  },
  { timestamps: true, collection: 'cosmetic_purchases' },
);

const CosmeticPurchaseModel: Model<ICosmeticPurchase> =
  (models.CosmeticPurchase as Model<ICosmeticPurchase>) ||
  model<ICosmeticPurchase>('CosmeticPurchase', CosmeticPurchaseSchema);

export default CosmeticPurchaseModel;
