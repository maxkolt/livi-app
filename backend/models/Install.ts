// models/Install.ts
import { Schema, model, models, type Types } from 'mongoose';

export interface IInstall {
  _id: Types.ObjectId;
  installId: string;
  user: Types.ObjectId;
  /** HMAC-хэш секрета установки (installSecret). См. utils/installSecret.ts.
   *  Отсутствует у install-записей, созданных до внедрения этой защиты (legacy) —
   *  в этом случае identity:attach принимает и сохраняет секрет от первого клиента,
   *  который его пришлёт ("bootstrap"), не требуя его для уже существующих сессий. */
  installSecretHash?: string;
}

const InstallSchema = new Schema<IInstall>(
  {
    installId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    installSecretHash: { type: String, required: false },
  },
  { timestamps: true, collection: 'installs' }
);

export default (models.Install as any) || model<IInstall>('Install', InstallSchema);
