import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User';
import type { AuthenticatedRequest } from '../utils/runtimeTypes';
import { isValidCosmetic, serializeCosmeticEntitlements } from '../utils/cosmeticCatalog';
import { COSMETIC_FIELDS, POINT_PRICES, reconcileInviteRewards, serializeRewards } from '../utils/liviRewards';

export function createCosmeticRewardsRouter(
  broadcast: (req: AuthenticatedRequest, userId: string, itemId: string) => Promise<void>,
) {
  const router = Router();
  router.delete('/cosmetics/owned', async (req, res) => {
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const kind: unknown = req.body?.kind;
    const itemId: unknown = req.body?.itemId;
    if ((kind !== 'frame' && kind !== 'background') || typeof itemId !== 'string' || !isValidCosmetic(kind, itemId)) {
      return res.status(400).json({ ok: false, error: 'invalid_item' });
    }
    const ownedField = kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
    const activeField = kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
    // Removing ownership and clearing only this active item must happen together.
    const user = await User.findOneAndUpdate({ _id: userId }, [{ $set: {
      [ownedField]: { $filter: { input: { $ifNull: [`$${ownedField}`, []] }, as: 'item', cond: { $ne: ['$$item', { $literal: itemId }] } } },
      [activeField]: { $cond: [{ $eq: [`$${activeField}`, { $literal: itemId }] }, '', { $ifNull: [`$${activeField}`, ''] }] },
    } }], { new: true }).select(COSMETIC_FIELDS).lean();
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (kind === 'frame') await broadcast(req, userId, user.activeFrameId || '');
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, entitlements: { ...serializeCosmeticEntitlements(user), rewards: serializeRewards(user) } });
  });

  router.post('/cosmetics/redeem', async (req, res) => {
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const kind: unknown = req.body?.kind;
    const itemId: unknown = req.body?.itemId;
    const useGift: unknown = req.body?.useGift ?? false;
    if ((kind !== 'frame' && kind !== 'background') || typeof itemId !== 'string' ||
      !isValidCosmetic(kind, itemId) || (kind === 'frame' && !['fire', 'diamond', 'frost'].includes(itemId)) ||
      typeof useGift !== 'boolean' || (useGift && kind !== 'background')) {
      return res.status(400).json({ ok: false, error: 'invalid_item' });
    }
    await reconcileInviteRewards(userId);
    const ownedField = kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
    const activeField = kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
    const price = POINT_PRICES[kind];
    // One conditional update: ownership, debit and activation succeed together.
    const updated = await User.findOneAndUpdate({
      _id: userId, [ownedField]: { $ne: itemId },
      ...(useGift ? { feedbackGiftAvailable: true } : { liviPoints: { $gte: price } }),
    }, {
      $addToSet: { [ownedField]: itemId },
      $set: { [activeField]: itemId, ...(useGift ? { feedbackGiftAvailable: false } : {}) },
      ...(!useGift ? { $inc: { liviPoints: -price } } : {}),
    }, { new: true }).select(COSMETIC_FIELDS).lean();
    const user = updated || await User.findById(userId).select(COSMETIC_FIELDS).lean();
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const entitlements = { ...serializeCosmeticEntitlements(user), rewards: serializeRewards(user) };
    if (!updated && !user[ownedField]?.includes(itemId)) {
      return res.status(409).json({ ok: false, error: useGift ? 'gift_unavailable' : 'insufficient_points', entitlements });
    }
    if (updated && kind === 'frame') await broadcast(req, userId, itemId);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, alreadyOwned: !updated, entitlements });
  });

  router.post('/cosmetics/feedback', async (req, res) => {
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (text.length < 20 || text.length > 2000) return res.status(400).json({ ok: false, error: 'invalid_feedback' });
    // Private feedback only. The gift is independent of sentiment and store ratings.
    const changed = await User.findOneAndUpdate({ _id: userId, feedbackSubmittedAt: { $exists: false } }, {
      $set: { feedbackText: text, feedbackSubmittedAt: new Date(), feedbackGiftAvailable: true },
    }, { new: true }).select(COSMETIC_FIELDS).lean();
    const user = changed || await User.findById(userId).select(COSMETIC_FIELDS).lean();
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, entitlements: { ...serializeCosmeticEntitlements(user), rewards: serializeRewards(user) } });
  });
  return router;
}
