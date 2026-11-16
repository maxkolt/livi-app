import type { AuthenticatedRequest, ErrorDetails } from '../utils/runtimeTypes';
import { Router } from 'express';
import mongoose from 'mongoose';
import UserModel from '../models/User';
import type { CosmeticKind } from '../utils/cosmeticCatalog';
import { logger } from '../utils/logger';
import { getFriendIds } from '../utils/friendshipUtils';
import { serializeCosmeticEntitlements as serializeEntitlements } from '../utils/cosmeticCatalog';
import { createCosmeticRewardsRouter } from './cosmeticRewards';
import { COSMETIC_FIELDS, reconcileInviteRewards, serializeRewards } from '../utils/liviRewards';

const router = Router();
// Old app versions receive a stable retirement response; no provider is loaded.
router.all(/^\/cosmetics\/(?:payments(?:\/.*)?|payment-return|webhook|intellectmoney(?:\/.*)?)\/?$/, (_req, res) =>
  res.status(410).json({ ok: false, error: 'use_livi_points' }));
router.use(createCosmeticRewardsRouter(broadcastFrameChange));

router.get('/cosmetics/me', async (req, res) => {
  const userId = String((req as AuthenticatedRequest).userId || '').trim();
  if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  await reconcileInviteRewards(userId);
  const user = await UserModel.findById(userId)
    .select(COSMETIC_FIELDS)
    .lean();
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, entitlements: { ...serializeEntitlements(user), rewards: serializeRewards(user) } });
});

router.get('/cosmetics/user/:userId', async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ ok: false, error: 'bad_user_id' });
  const user = await UserModel.findById(userId).select('activeFrameId').lean();
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  return res.json({ ok: true, activeFrameId: String((user).activeFrameId || '') });
});

/**
 * Разослать смену рамки друзьям и самому пользователю (у него могут быть другие
 * устройства). Ошибки глушим: смена косметики не должна падать из-за сокета.
 */
async function broadcastFrameChange(req: AuthenticatedRequest, userId: string, frameId: string): Promise<void> {
  try {
    const io: AuthenticatedRequest['io'] = req.app?.get?.('io');
    if (!io) return;
    const payload = { userId, frameId };
    io.to(`u:${userId}`).emit('cosmetics:frame', payload);
    const friends = await getFriendIds(userId);
    for (const friendId of friends) {
      try {
        io.to(`u:${friendId}`).emit('cosmetics:frame', payload);
      } catch {}
    }
  } catch (e: unknown) {
    logger.warn('[cosmetics] broadcastFrameChange failed', { userId, error: (e as ErrorDetails)?.message });
  }
}

router.patch('/cosmetics/active', async (req, res) => {
  const userId = String((req as AuthenticatedRequest).userId || '').trim();
  if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const kind = String(req.body?.kind || '') as CosmeticKind;
  const itemId = String(req.body?.itemId || '').trim();
  if (kind !== 'frame' && kind !== 'background') return res.status(400).json({ ok: false, error: 'invalid_kind' });

  const purchaseField = kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
  const activeField = kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
  // Ownership is checked by the same write: a concurrent deletion cannot leave
  // an active frame/background that no longer belongs to this user.
  const updated = await UserModel.findOneAndUpdate(
    { _id: userId, ...(itemId ? { [purchaseField]: itemId } : {}) },
    { $set: { [activeField]: itemId } }, { new: true },
  )
    .select(COSMETIC_FIELDS)
    .lean();
  if (!updated) {
    const exists = await UserModel.exists({ _id: userId });
    return res.status(exists ? 403 : 404).json({ ok: false, error: exists ? 'not_owned' : 'user_not_found' });
  }

  // Рамка видна другим людям, поэтому её смену надо разослать сразу.
  // Без этого друзья увидят новую рамку только когда протухнет их пятиминутный
  // кеш И перемонтируется компонент — на практике после перезапуска приложения.
  if (kind === 'frame') {
    void broadcastFrameChange(req, userId, itemId);
  }

  return res.json({ ok: true, entitlements: { ...serializeEntitlements(updated), ...(updated ? { rewards: serializeRewards(updated) } : {}) } });
});

export default router;
