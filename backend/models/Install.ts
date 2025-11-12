// models/Install.ts
import { Schema, model, models, type Types } from 'mongoose';

export interface IInstall {
  _id: Types.ObjectId;
  installId: string;
  user: Types.ObjectId;
}

const InstallSchema = new Schema<IInstall>(
  {
    installId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true, collection: 'installs' }
);

export default (models.Install as any) || model<IInstall>('Install', InstallSchema);
