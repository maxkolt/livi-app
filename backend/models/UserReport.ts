import mongoose from 'mongoose';

/** Причины жалобы из карточки «Собеседник» в случайном чате. */
export const USER_REPORT_REASONS = ['nudity', 'minor', 'harassment', 'spam', 'other'] as const;
export type UserReportReason = (typeof USER_REPORT_REASONS)[number];

export function isUserReportReason(value: unknown): value is UserReportReason {
  return typeof value === 'string' && (USER_REPORT_REASONS as readonly string[]).includes(value);
}

/**
 * Ручная жалоба пользователя. Одна запись на пару «кто → на кого»: повторная
 * жалоба обновляет причину и время, а не плодит записи. Для разбора модератором.
 */
const UserReportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reported: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: USER_REPORT_REASONS, required: true },
    source: { type: String, enum: ['random_chat'], default: 'random_chat' },
    status: { type: String, enum: ['open', 'reviewed'], default: 'open', index: true },
  },
  { timestamps: true },
);

UserReportSchema.index({ reporter: 1, reported: 1 }, { unique: true });
UserReportSchema.index({ reported: 1, updatedAt: -1 });
// Жалобы хранятся год для разбора повторных нарушений, потом удаляются сами.
UserReportSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

export default mongoose.models.UserReport || mongoose.model('UserReport', UserReportSchema);
