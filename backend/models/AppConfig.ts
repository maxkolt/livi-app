// models/AppConfig.ts
// Key-value конфиг для сервера (например latestAppVersion для уведомления об обновлении).
import { Schema, model, models, type Model, type Types } from 'mongoose';

interface IAppConfig {
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

export default (models.AppConfig as Model<IAppConfig> | undefined) || model<IAppConfig>('AppConfig', AppConfigSchema);
