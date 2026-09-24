import { Schema } from 'mongoose';
import type { E2eEnvelope } from '../utils/e2eEnvelope';

/** Конверт сквозного шифрования (см. utils/e2eEnvelope.ts). Сервер хранит его как есть. */
export const E2eEnvelopeSchema = new Schema<E2eEnvelope>(
  {
    v: { type: Number, required: true },
    n: { type: String, required: true },
    c: { type: String, required: true },
    spk: { type: String, required: true },
    rpk: { type: String, required: true },
  },
  { _id: false }
);
