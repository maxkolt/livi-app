import { Schema, model, models, type Model, type Types } from 'mongoose';
interface Proof {
  id: string; install: Types.ObjectId; user: Types.ObjectId; publicKey: string;
  newSecretHash: string; proofHash: string; expiresAt: Date;
}
const schema = new Schema<Proof>({
  id: { type: String, required: true, unique: true }, install: { type: Schema.Types.ObjectId, required: true },
  user: { type: Schema.Types.ObjectId, required: true }, publicKey: { type: String, required: true },
  newSecretHash: { type: String, required: true }, proofHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, expires: 0 },
});
export default (models.InstallMigrationProof as Model<Proof> | undefined) || model<Proof>('InstallMigrationProof', schema);
