// models/Install.ts
import { Schema, model, models, type Model, type Types } from 'mongoose';

interface IInstall {
  _id: Types.ObjectId;
  installId: string;
  user: Types.ObjectId;
  /** HMAC hash set for a new installation. Existing rows are read as stored;
   * an identifier alone cannot replace their secret or enroll an old record. */
  installSecretHash?: string;
  /** Когда секрет был перепривязан после переустановки приложения (см. isDeviceBoundInstallId). */
  secretRotatedAt?: Date;
  /** Первый HTTP-запрос с верным секретом: дальше REST без секрета для установки отклоняется. */
  httpSecretSeenAt?: Date;
  /** Последний отчёт Play Integrity (routes/integrity.ts): сводка вердикта или ошибка. Только наблюдение. */
  integrity?: Record<string, unknown>;
}

const InstallSchema = new Schema<IInstall>(
  {
    installId: { type: String, required: true, unique: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    installSecretHash: { type: String, required: false },
    secretRotatedAt: { type: Date, required: false },
    httpSecretSeenAt: { type: Date, required: false },
    integrity: { type: Schema.Types.Mixed, required: false },
  },
  { timestamps: true, collection: 'installs' }
);

export default (models.Install as Model<IInstall> | undefined) || model<IInstall>('Install', InstallSchema);
