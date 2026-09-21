import { randomUUID } from 'crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import UserModel from '../models/User';
import CosmeticPurchaseModel, { type CosmeticKind } from '../models/CosmeticPurchase';
import { logger } from '../utils/logger';

const router = Router();

const SHOP_ID = String(process.env.YUKASSA_SHOP_ID || '').trim();
const SECRET_KEY = String(process.env.YUKASSA_SECRET_KEY || '').trim();
const CONFIGURED_RETURN_URL = String(process.env.YUKASSA_RETURN_URL || '').trim();
const APP_RETURN_DEEP_LINK = CONFIGURED_RETURN_URL.startsWith('livi://')
  ? CONFIGURED_RETURN_URL
  : 'livi://legendary/payment-result';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://api.liviapp.com').replace(/\/+$/, '');
// Redirect-сценарий ЮKassa ожидает абсолютный HTTPS URL. Промежуточная страница
// на нашем backend возвращает пользователя в приложение по livi:// deep link.
const RETURN_URL = CONFIGURED_RETURN_URL.startsWith('https://')
  ? CONFIGURED_RETURN_URL
  : `${PUBLIC_BASE_URL}/api/cosmetics/payment-return`;
const PRICE = '299.00';

const FRAME_IDS = new Set(['fire', 'diamond', 'aurora', 'palladium', 'frost', 'jade', 'void', 'obsidian']);
const BACKGROUND_IDS = new Set(['aurora-chat', 'deep-space', 'poetry', 'ocean-flow', 'graphite-chat']);

type YooPayment = {
  id?: string;
  status?: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid?: boolean;
  test?: boolean;
  amount?: { value?: string; currency?: string };
  confirmation?: { confirmation_url?: string };
  metadata?: Record<string, unknown>;
};

function isValidItem(kind: CosmeticKind, itemId: string): boolean {
  return kind === 'frame' ? FRAME_IDS.has(itemId) : BACKGROUND_IDS.has(itemId);
}

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

function serializeEntitlements(user: any) {
  return {
    purchasedFrameIds: Array.isArray(user?.purchasedFrameIds) ? user.purchasedFrameIds.map(String) : [],
    purchasedBackgroundIds: Array.isArray(user?.purchasedBackgroundIds)
      ? user.purchasedBackgroundIds.map(String)
      : [],
    activeFrameId: String(user?.activeFrameId || ''),
    activeBackgroundId: String(user?.activeBackgroundId || ''),
  };
}

async function grantVerifiedPayment(payment: YooPayment) {
  const paymentId = String(payment.id || '').trim();
  if (!paymentId || payment.status !== 'succeeded' || payment.paid !== true) return null;
  if (String(payment.amount?.value || '') !== PRICE || payment.amount?.currency !== 'RUB') {
    logger.warn('[cosmetics] payment amount mismatch', { paymentId, amount: payment.amount });
    return null;
  }

  const purchase = await CosmeticPurchaseModel.findOne({ yookassaPaymentId: paymentId });
  if (!purchase) {
    logger.warn('[cosmetics] verified YooKassa payment has no local purchase', { paymentId });
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
  const userId = String((req as any).userId || '').trim();
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
  return res.json({ ok: true, activeFrameId: String((user as any).activeFrameId || '') });
});

router.get('/cosmetics/payment-return', (_req, res) => {
  return res.redirect(302, APP_RETURN_DEEP_LINK);
});

router.post('/cosmetics/payments', async (req, res) => {
  try {
    const userId = String((req as any).userId || '').trim();
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const kind = String(req.body?.kind || '') as CosmeticKind;
    const itemId = String(req.body?.itemId || '').trim();
    if ((kind !== 'frame' && kind !== 'background') || !isValidItem(kind, itemId)) {
      return res.status(400).json({ ok: false, error: 'invalid_item' });
    }

    const user = await UserModel.findById(userId)
      .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
      .lean();
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    const owned = kind === 'frame' ? (user as any).purchasedFrameIds : (user as any).purchasedBackgroundIds;
    if (Array.isArray(owned) && owned.includes(itemId)) {
      return res.json({ ok: true, alreadyOwned: true, entitlements: serializeEntitlements(user) });
    }

    const idempotenceKey = randomUUID();
    const payment = await yooRequest('/payments', {
      method: 'POST',
      headers: { 'Idempotence-Key': idempotenceKey },
      body: JSON.stringify({
        amount: { value: PRICE, currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: RETURN_URL },
        description: `${kind === 'frame' ? 'Рамка' : 'Фон чата'} Legendary: ${itemId}`,
        metadata: { userId, kind, itemId },
      }),
    });
    const paymentId = String(payment.id || '').trim();
    const confirmationUrl = String(payment.confirmation?.confirmation_url || '').trim();
    if (!paymentId || !confirmationUrl) throw new Error('yookassa_invalid_response');

    await CosmeticPurchaseModel.create({
      user: userId,
      kind,
      itemId,
      amount: PRICE,
      currency: 'RUB',
      yookassaPaymentId: paymentId,
      // Право выдаёт только grantVerifiedPayment после независимой проверки ответа ЮKassa.
      status: 'pending',
      test: payment.test === true,
    });

    if (payment.status === 'succeeded' && payment.paid === true) await grantVerifiedPayment(payment);
    return res.json({ ok: true, paymentId, confirmationUrl, status: payment.status || 'pending' });
  } catch (error: any) {
    logger.error('[cosmetics] create payment failed', { error: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: 'payment_create_failed' });
  }
});

router.get('/cosmetics/payments/:paymentId', async (req, res) => {
  try {
    const userId = String((req as any).userId || '').trim();
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
  } catch (error: any) {
    logger.error('[cosmetics] check payment failed', { error: error?.message || String(error) });
    return res.status(502).json({ ok: false, error: 'payment_check_failed' });
  }
});

router.patch('/cosmetics/active', async (req, res) => {
  const userId = String((req as any).userId || '').trim();
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
  const owned = Array.isArray((user as any)[purchaseField]) ? (user as any)[purchaseField].map(String) : [];
  if (itemId && !owned.includes(itemId)) return res.status(403).json({ ok: false, error: 'not_owned' });

  const updated = await UserModel.findByIdAndUpdate(userId, { $set: { [activeField]: itemId } }, { new: true })
    .select('purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId')
    .lean();
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
  } catch (error: any) {
    logger.error('[cosmetics] webhook failed', { error: error?.message || String(error) });
    return res.status(500).json({ ok: false });
  }
});

export default router;
