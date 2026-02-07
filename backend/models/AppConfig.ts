// models/AppConfig.ts
// Key-value конфиг для сервера (например latestAppVersion для уведомления об обновлении).
import { Schema, model, models, type Types } from 'mongoose';

export interface IAppConfig {
  _id?: Types.ObjectId;
  key: string;
  value: string;
}

const AppConfigSchema = new Schema<IAppConfig>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: String, required: true },
  },
  { timestamps: true, collection: 'appconfig' }
);

export default (models.AppConfig as any) || model<IAppConfig>('AppConfig', AppConfigSchema);
