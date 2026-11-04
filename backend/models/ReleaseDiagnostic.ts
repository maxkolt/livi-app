import { Schema, model, models, type Model } from 'mongoose';
import type { DiagnosticData, DiagnosticDevice, DiagnosticLevel } from '../utils/releaseDiagnostics';

export interface ReleaseDiagnosticRecord {
  deviceKey: string; eventId: string; session: string; event: string; level: DiagnosticLevel;
  at: Date; receivedAt: Date; operation?: string; data: DiagnosticData; device: DiagnosticDevice;
}
const schema = new Schema<ReleaseDiagnosticRecord>({
  deviceKey: { type: String, required: true }, eventId: { type: String, required: true },
  session: { type: String, required: true }, event: { type: String, required: true },
  level: { type: String, enum: ['info', 'warning', 'error'], required: true },
  at: { type: Date, required: true }, receivedAt: { type: Date, required: true },
  operation: String, data: { type: Schema.Types.Mixed, required: true },
  device: { type: Schema.Types.Mixed, required: true },
}, { collection: 'release_diagnostics', versionKey: false });
schema.index({ deviceKey: 1, eventId: 1 }, { unique: true });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 86400 });
schema.index({ deviceKey: 1, session: 1, at: 1 });
export default (models.ReleaseDiagnostic as Model<ReleaseDiagnosticRecord> | undefined) || model<ReleaseDiagnosticRecord>('ReleaseDiagnostic', schema);

export interface DiagnosticReportRun {
  _id: string; status: string; lockedUntil: Date; attempts: number; sentAt?: Date;
  start: Date; end: Date; failureCode?: string;
}
const runSchema = new Schema<DiagnosticReportRun>({
  _id: String, status: String, lockedUntil: Date, attempts: Number, sentAt: Date,
  start: Date, end: Date, failureCode: String,
}, { collection: 'release_diagnostic_reports', versionKey: false });
export const ReleaseDiagnosticReport = (models.ReleaseDiagnosticReport as Model<DiagnosticReportRun> | undefined) || model<DiagnosticReportRun>('ReleaseDiagnosticReport', runSchema);
