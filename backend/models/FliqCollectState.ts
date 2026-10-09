// models/FliqCollectState.ts
// Очередь сборщика Fliq: когда в последний раз искали пару «тема × язык» и какой вариант запроса следующий.
// Запись budget:<день по Тихоокеанскому времени> — счётчик поисков за сутки квоты (в поле variant), переживает перезапуски.
import { Schema, model, models } from 'mongoose';

export interface IFliqCollectState {
  key: string;
  lastRunAt: Date;
  variant: number;
  lastFound: number;
}

const FliqCollectStateSchema = new Schema<IFliqCollectState>(
  {
    key: { type: String, required: true, unique: true },
    lastRunAt: { type: Date, default: () => new Date(0) },
    variant: { type: Number, default: 0 },
    lastFound: { type: Number, default: 0 },
  },
  { collection: 'fliq_collect_state' }
);

export default (models.FliqCollectState as any) || model<IFliqCollectState>('FliqCollectState', FliqCollectStateSchema);
