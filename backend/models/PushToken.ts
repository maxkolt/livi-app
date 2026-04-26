import mongoose from 'mongoose';

export type PushPlatform = 'android' | 'ios';

const PushTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    installId: { type: String, default: '', index: true },
    platform: { type: String, enum: ['android', 'ios'], required: true, index: true },
    token: { type: String, required: true, unique: true, index: true },
    /** FCM registration token (Android only). Для data-only пуша звонка — onMessageReceived вызывается в фоне. */
    fcmToken: { type: String, default: '', index: true },
    /** APNs VoIP token (iOS only). Для PushKit/CallKit входящего при фоне/убитом приложении. */
    voipToken: { type: String, default: '', index: true },
    updatedAtMs: { type: Number, default: () => Date.now(), index: true },
  },
  { timestamps: true }
);

PushTokenSchema.index({ userId: 1, platform: 1 });

export default mongoose.models.PushToken || mongoose.model('PushToken', PushTokenSchema);

