import { Schema, model, models, type Model, type Types } from 'mongoose';
import type { CosmeticKind } from './CosmeticPurchase';

export interface IntellectMoneyPurchaseRecord {
  _id: Types.ObjectId;
  paymentId: string;
  user: Types.ObjectId;
  kind: CosmeticKind;
  itemId: string;
  eshopId: string;
  amount: string;
  currency: 'TST' | 'RUB';
  serviceName: string;
  status: 'pending' | 'succeeded' | 'canceled' | 'refunded';
  openKey?: string;
  invoiceId?: string;
  expiresAt: Date;
  grantedAt?: Date;
  createdAt: Date;
}

// A separate collection leaves existing YooKassa records and their unique index intact.
const schema = new Schema<IntellectMoneyPurchaseRecord>({
  paymentId: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['frame', 'background'], required: true },
  itemId: { type: String, required: true },
  eshopId: { type: String, required: true },
  amount: { type: String, required: true },
  currency: { type: String, enum: ['TST', 'RUB'], required: true },
  serviceName: { type: String, required: true },
  status: { type: String, enum: ['pending', 'succeeded', 'canceled', 'refunded'], default: 'pending' },
  openKey: { type: String, unique: true, sparse: true },
  invoiceId: { type: String },
  expiresAt: { type: Date, required: true },
  grantedAt: { type: Date },
}, { timestamps: true, collection: 'intellectmoney_cosmetic_purchases' });

export default (models.IntellectMoneyPurchase as Model<IntellectMoneyPurchaseRecord>) ||
  model<IntellectMoneyPurchaseRecord>('IntellectMoneyPurchase', schema);
