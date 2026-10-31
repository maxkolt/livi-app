import type { AuthenticatedRequest, ErrorDetails } from '../utils/runtimeTypes';
import { Router } from 'express';
import mongoose from 'mongoose';
import UserModel from '../models/User';
import CosmeticPurchaseModel, { type CosmeticKind } from '../models/CosmeticPurchase';
import { logger } from '../utils/logger';
import { getFriendIds } from '../utils/friendshipUtils';
import { serializeCosmeticEntitlements as serializeEntitlements } from '../utils/cosmeticCatalog';
import { createIntellectMoneyCosmeticsRouter } from './intellectMoneyCosmetics';

const router = Router();
router.use(createIntellectMoneyCosmeticsRouter(broadcastFrameChange));

const SHOP_ID = String(process.env.YUKASSA_SHOP_ID || '').trim();
const SECRET_KEY = String(process.env.YUKASSA_SECRET_KEY || '').trim();
const CONFIGURED_RETURN_URL = String(process.env.YUKASSA_RETURN_URL || '').trim();
const APP_RETURN_DEEP_LINK = CONFIGURED_RETURN_URL.startsWith('livi://')
  ? CONFIGURED_RETURN_URL
  : 'livi://legendary/payment-result';
type YooPayment = {
  id?: string;
  status?: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid?: boolean;
  test?: boolean;
  amount?: { value?: string; currency?: string };
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, unknown>;
};

function basicAuth(): string {
  return `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`;
}

async function yooRequest(path: string, init?: RequestInit): Promise<YooPayment> {
  if (!SHOP_ID || !SECRET_KEY) throw new Error('yookassa_not_configured');
  const response = await fetch(`https://api.yookassa.ru/v3${path}`, {
    ...init,
    headers: {
      Authorization: basicAuth(),
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const json = (await response.json().catch(() => ({}))) as YooPayment & { description?: string; code?: string };
  if (!response.ok) {
    logger.error('[cosmetics] YooKassa request failed', {
      path,
      status: response.status,
      code: json.code,
      description: json.description,
    });
    throw new Error(`yookassa_${response.status}`);
  }
  return json;
}

async function grantVerifiedPayment(payment: YooPayment) {
  const paymentId = String(payment.id || '').trim();
  if (!paymentId || payment.status !== 'succeeded' || payment.paid !== true) return null;

  const purchase = await CosmeticPurchaseModel.findOne({ yookassaPaymentId: paymentId });
  if (!purchase) {
    logger.warn('[cosmetics] verified YooKassa payment has no local purchase', { paymentId });
    return null;
  }
  const expectedAmount = String(purchase.amount || '');
  if (String(payment.amount?.value || '') !== expectedAmount || payment.amount?.currency !== purchase.currency) {
    logger.warn('[cosmetics] payment amount mismatch', {
      paymentId,
      expectedAmount,
      expectedCurrency: purchase.currency,
      amount: payment.amount,
    });
    return null;
  }
  if (purchase.status === 'succeeded') {
    return UserModel.findById(purchase.user)
      .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
      .lean();
  }

  const purchaseField = purchase.kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
  const activeField = purchase.kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
  const user = await UserModel.findByIdAndUpdate(
    purchase.user,
    {
      $addToSet: { [purchaseField]: purchase.itemId },
      $set: { [activeField]: purchase.itemId },
    },
    { new: true },
  )
    .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
    .lean();

  await CosmeticPurchaseModel.updateOne(
    { _id: purchase._id, status: { $ne: 'succeeded' } },
    { $set: { status: 'succeeded', grantedAt: new Date() } },
  );
  return user;
}

router.get('/cosmetics/me', async (req, res) => {
  const userId = String((req as AuthenticatedRequest).userId || '').trim();
  if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const user = await UserModel.findById(userId)
    .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
    .lean();
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  return res.json({ ok: true, entitlements: serializeEntitlements(user) });
});

router.get('/cosmetics/user/:userId', async (req, res) => {
  const userId = String(req.params.userId || '').trim();
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ ok: false, error: 'bad_user_id' });
  const user = await UserModel.findById(userId).select('activeFrameId').lean();
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  return res.json({ ok: true, activeFrameId: String((user).activeFrameId || '') });
});

router.get('/cosmetics/payment-return', (_req, res) => {
  return res.redirect(302, APP_RETURN_DEEP_LINK);
});

router.get('/cosmetics/payments/:paymentId', async (req, res) => {
  try {
    const userId = String((req as AuthenticatedRequest).userId || '').trim();
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const paymentId = String(req.params.paymentId || '').trim();
    const purchase = await CosmeticPurchaseModel.findOne({ yookassaPaymentId: paymentId, user: userId });
    if (!purchase) return res.status(404).json({ ok: false, error: 'payment_not_found' });

    const payment = await yooRequest(`/payments/${encodeURIComponent(paymentId)}`);
    if (payment.status === 'canceled' && purchase.status !== 'succeeded') {
      await CosmeticPurchaseModel.updateOne({ _id: purchase._id }, { $set: { status: 'canceled' } });
    }
    const user = await grantVerifiedPayment(payment);
    return res.json({
      ok: true,
      status: payment.status || purchase.status,
      entitlements: user ? serializeEntitlements(user) : undefined,
    });
  } catch (error: unknown) {
    logger.error('[cosmetics] check payment failed', { error: (error as ErrorDetails)?.message || String(error) });
    return res.status(502).json({ ok: false, error: 'payment_check_failed' });
  }
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
  const user = await UserModel.findById(userId)
    .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
    .lean();
  if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
  const owned = Array.isArray((user)[purchaseField]) ? (user)[purchaseField].map(String) : [];
  if (itemId && !owned.includes(itemId)) return res.status(403).json({ ok: false, error: 'not_owned' });

  const updated = await UserModel.findByIdAndUpdate(userId, { $set: { [activeField]: itemId } }, { new: true })
    .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
    .lean();

  // Рамка видна другим людям, поэтому её смену надо разослать сразу.
  // Без этого друзья увидят новую рамку только когда протухнет их пятиминутный
  // кеш И перемонтируется компонент — на практике после перезапуска приложения.
  if (kind === 'frame') {
    void broadcastFrameChange(req, userId, itemId);
  }

  return res.json({ ok: true, entitlements: serializeEntitlements(updated) });
});

router.post('/cosmetics/webhook', async (req, res) => {
  try {
    const event = String(req.body?.event || '');
    const paymentId = String(req.body?.object?.id || '').trim();
    if (!paymentId || !event.startsWith('payment.')) return res.status(400).json({ ok: false });
    const payment = await yooRequest(`/payments/${encodeURIComponent(paymentId)}`);
    if (event === 'payment.succeeded') await grantVerifiedPayment(payment);
    if (event === 'payment.canceled') {
      await CosmeticPurchaseModel.updateOne(
        { yookassaPaymentId: paymentId, status: { $ne: 'succeeded' } },
        { $set: { status: 'canceled' } },
      );
    }
    return res.status(200).json({ ok: true });
  } catch (error: unknown) {
    logger.error('[cosmetics] webhook failed', { error: (error as ErrorDetails)?.message || String(error) });
    return res.status(500).json({ ok: false });
  }
});

export default router;
