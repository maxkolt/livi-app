import { randomUUID } from 'crypto';
import { Router } from 'express';
import mongoose from 'mongoose';
import UserModel from '../models/User';
import type { CosmeticKind } from '../models/CosmeticPurchase';
import IntellectMoneyPurchaseModel, { type IntellectMoneyPurchaseRecord } from '../models/IntellectMoneyPurchase';
import { COSMETIC_PRICES, isValidCosmetic, serializeCosmeticEntitlements } from '../utils/cosmeticCatalog';
import {
  intellectMoneyConfig, intellectMoneyAmount, intellectMoneyCheckoutHtml,
  intellectMoneyCheckoutUrl, verifyIntellectMoneyNotification,
} from '../utils/intellectMoney';
import type { AuthenticatedRequest } from '../utils/runtimeTypes';
import { logger } from '../utils/logger';

const ENTITLEMENTS = 'purchasedFrameIds purchasedBackgroundIds activeFrameId activeBackgroundId';
const PAYMENT_ID = /^im_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type BroadcastFrame = (req: AuthenticatedRequest, userId: string, frameId: string) => Promise<void>;

export function createIntellectMoneyCosmeticsRouter(broadcastFrame: BroadcastFrame): Router {
  const router = Router();

  router.post('/cosmetics/payments', async (req, res) => {
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const kind = String(req.body?.kind || '') as CosmeticKind;
    const itemId = String(req.body?.itemId || '').trim();
    if (!isValidCosmetic(kind, itemId)) return res.status(400).json({ ok: false, error: 'invalid_item' });
    try {
      const user = await UserModel.findById(userId).select(ENTITLEMENTS).lean();
      if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
      const owned = kind === 'frame' ? user.purchasedFrameIds : user.purchasedBackgroundIds;
      if (owned?.includes(itemId)) {
        return res.json({ ok: true, alreadyOwned: true, entitlements: serializeCosmeticEntitlements(user) });
      }
      const config = intellectMoneyConfig();
      const openKey = [userId, kind, itemId, config.eshopId, config.currency].join(':');
      // One outstanding checkout per item/account. Network retries reuse the same order.
      await IntellectMoneyPurchaseModel.updateMany(
        { openKey, status: 'pending', expiresAt: { $lte: new Date() } },
        { $set: { status: 'canceled' }, $unset: { openKey: 1 } },
      );
      let order;
      try {
        order = await IntellectMoneyPurchaseModel.findOneAndUpdate(
          { openKey },
          { $setOnInsert: {
            paymentId: `im_${randomUUID()}`, user: userId, kind, itemId,
            eshopId: config.eshopId, currency: config.currency, amount: COSMETIC_PRICES[kind],
            serviceName: `${kind === 'frame' ? 'Рамка' : 'Фон чата'} Legendary: ${itemId}`,
            status: 'pending', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
      } catch (error) {
        if ((error as { code?: number })?.code !== 11000) throw error;
        order = await IntellectMoneyPurchaseModel.findOne({ openKey });
      }
      if (!order) throw new Error('order_create_failed');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true, paymentId: order.paymentId,
        confirmationUrl: intellectMoneyCheckoutUrl(config, order.paymentId),
        status: order.status, provider: 'intellectmoney', test: order.currency === 'TST',
      });
    } catch (error) {
      // Provider keys and full checkout payloads must never appear in logs.
      const unavailable = error instanceof Error && error.message.startsWith('intellectmoney_');
      logger.error('[cosmetics] IntellectMoney order creation failed', { unavailable });
      return res.status(unavailable ? 503 : 502).json({ ok: false, error: 'payment_create_failed' });
    }
  });

  router.get('/cosmetics/intellectmoney/checkout/:paymentId', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action https://merchant.intellectmoney.ru; base-uri 'none'; frame-ancestors 'none'");
    const paymentId = String(req.params.paymentId || '');
    if (!PAYMENT_ID.test(paymentId)) return res.status(404).send('Платёж не найден');
    try {
      const order = await IntellectMoneyPurchaseModel.findOne({ paymentId });
      if (!order) return res.status(404).send('Платёж не найден');
      const config = intellectMoneyConfig();
      if (order.eshopId !== config.eshopId || order.currency !== config.currency) {
        return res.status(409).send('Настройки оплаты изменились. Вернитесь в LiVi и создайте новый платёж.');
      }
      if (order.status === 'succeeded') return res.redirect(302, `${config.publicBaseUrl}/api/cosmetics/payment-return`);
      if (order.status !== 'pending' || order.expiresAt.getTime() <= Date.now()) {
        return res.status(410).send('Срок оплаты истёк. Вернитесь в LiVi и создайте новый платёж.');
      }
      const user = await UserModel.findById(order.user).select(ENTITLEMENTS).lean();
      if (!user) return res.status(404).send('Пользователь не найден');
      const owned = order.kind === 'frame' ? user.purchasedFrameIds : user.purchasedBackgroundIds;
      if (owned?.includes(order.itemId)) return res.redirect(302, `${config.publicBaseUrl}/api/cosmetics/payment-return`);
      return res.type('html').send(intellectMoneyCheckoutHtml(order, config));
    } catch {
      return res.status(503).send('Оплата временно недоступна. Попробуйте позже.');
    }
  });

  router.get('/cosmetics/payments/:paymentId', async (req, res, next) => {
    const paymentId = String(req.params.paymentId || '');
    if (!paymentId.startsWith('im_')) return next(); // Existing YooKassa orders stay readable.
    const userId = String((req as AuthenticatedRequest).userId || '');
    if (!mongoose.isValidObjectId(userId)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (!PAYMENT_ID.test(paymentId)) return res.status(404).json({ ok: false, error: 'payment_not_found' });
    try {
      const order = await IntellectMoneyPurchaseModel.findOne({ paymentId, user: userId });
      if (!order) return res.status(404).json({ ok: false, error: 'payment_not_found' });
      const user = order.status === 'succeeded'
        ? await UserModel.findById(userId).select(ENTITLEMENTS).lean() : null;
      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        ok: true, status: order.status === 'refunded' ? 'canceled' : order.status,
        ...(user ? { entitlements: serializeCosmeticEntitlements(user) } : {}),
      });
    } catch {
      return res.status(502).json({ ok: false, error: 'payment_check_failed' });
    }
  });

  async function grantPayment(req: AuthenticatedRequest, order: IntellectMoneyPurchaseRecord): Promise<void> {
    if (order.status === 'succeeded' || order.status === 'refunded') return;
    const ownedField = order.kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
    const activeField = order.kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
    // The ownership condition makes concurrent/repeated notifications harmless. A replay
    // cannot reactivate an older frame over a newer choice, even after a partial DB failure.
    const changed = await UserModel.findOneAndUpdate(
      { _id: order.user, [ownedField]: { $ne: order.itemId } },
      { $addToSet: { [ownedField]: order.itemId }, $set: { [activeField]: order.itemId } },
      { new: true },
    ).select(ENTITLEMENTS).lean();
    if (!changed) {
      const user = await UserModel.findById(order.user).select(ENTITLEMENTS).lean();
      if (!user || !user[ownedField]?.includes(order.itemId)) throw new Error('payment_grant_failed');
    }
    await IntellectMoneyPurchaseModel.updateOne(
      { _id: order._id, status: { $ne: 'refunded' } },
      { $set: { status: 'succeeded', grantedAt: new Date() }, $unset: { openKey: 1 } },
    );
    if (changed && order.kind === 'frame') await broadcastFrame(req, String(order.user), order.itemId);
  }

  router.post('/cosmetics/intellectmoney/webhook', async (req, res) => {
    try {
      const config = intellectMoneyConfig();
      const notification = verifyIntellectMoneyNotification(req.body, config);
      if (!notification) return res.status(403).type('text/plain').send('INVALID');
      const order = await IntellectMoneyPurchaseModel.findOne({ paymentId: notification.orderId });
      if (!order) return res.status(404).type('text/plain').send('UNKNOWN');
      if (order.eshopId !== notification.eshopId || order.currency !== notification.currency ||
          order.currency !== config.currency || intellectMoneyAmount(order.amount) !== intellectMoneyAmount(notification.amount)) {
        return res.status(409).type('text/plain').send('MISMATCH');
      }
      if (notification.status === '5') {
        await grantPayment(req as AuthenticatedRequest, order);
      } else if (notification.status === '4' || notification.status === '8') {
        const status = notification.status === '8' ? 'refunded' : 'canceled';
        await IntellectMoneyPurchaseModel.updateOne(
          { _id: order._id, status: { $nin: status === 'refunded' ? ['refunded'] : ['succeeded', 'refunded'] } },
          { $set: { status }, $unset: { openKey: 1 } },
        );
      }
      // PaymentId is advisory: the official callback hash authenticates OrderId,
      // amount and status, but does not include PaymentId.
      await IntellectMoneyPurchaseModel.updateOne({ _id: order._id }, { $set: { invoiceId: notification.invoiceId } });
      return res.status(200).type('text/plain').send('OK');
    } catch {
      logger.error('[cosmetics] IntellectMoney notification processing failed');
      return res.status(503).type('text/plain').send('RETRY');
    }
  });
  return router;
}
