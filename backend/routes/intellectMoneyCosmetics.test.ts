jest.mock('../models/User', () => ({ __esModule: true, default: { findById: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../models/IntellectMoneyPurchase', () => ({
  __esModule: true, default: { findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() },
}));
jest.mock('../utils/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));

import { createHash } from 'crypto';
import { createIntellectMoneyCosmeticsRouter } from './intellectMoneyCosmetics';
import User from '../models/User';
import Orders from '../models/IntellectMoneyPurchase';

const userId = '507f1f77bcf86cd799439011';
const otherId = '507f191e810c19729de860ea';
const paymentId = 'im_00000000-0000-4000-8000-000000000001';
const secret = 'not-a-real-merchant-key';
const broadcast = jest.fn(async () => {});
const router = createIntellectMoneyCosmeticsRouter(broadcast);

type TestResponse = {
  statusCode: number; body: any; headers: Record<string, string>;
  status: jest.Mock; setHeader: jest.Mock; type: jest.Mock;
  json: jest.Mock; send: jest.Mock; redirect: jest.Mock;
};
function response() {
  const res: TestResponse = { statusCode: 200, body: undefined, headers: {},
    status: jest.fn((code: number) => { res.statusCode = code; return res; }),
    setHeader: jest.fn((key: string, value: string) => { res.headers[key] = value; return res; }),
    type: jest.fn((type: string) => { res.headers['Content-Type'] = type; return res; }),
    json: jest.fn((body: unknown) => { res.body = body; return res; }),
    send: jest.fn((body: unknown) => { res.body = body; return res; }),
    redirect: jest.fn((code: number, url: string) => { res.statusCode = code; res.body = url; return res; }),
  };
  return res;
}
async function invoke(method: string, path: string, data: Record<string, unknown> = {}) {
  const layer = (router as any).stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer) throw Error(`Missing route ${method} ${path}`);
  const res = response(), next = jest.fn();
  await layer.route.stack[0].handle({ userId, body: {}, params: {}, ...data }, res, next);
  return { res, next };
}
function query(value: unknown) {
  return { select: jest.fn().mockReturnThis(), lean: jest.fn(async () => value) };
}
function signed(status: string, changes: Record<string, string> = {}) {
  const body: Record<string, string> = {
    EshopId: '473314', OrderId: paymentId, ServiceName: 'Рамка Legendary: fire', EshopAccount: '12345',
    RecipientAmount: '199.00', RecipientCurrency: 'TST', PaymentStatus: status,
    UserName: '', UserEmail: 'buyer@example.com', PaymentData: '2026-10-31 21:00:00', PaymentId: '3000000001',
    ...changes,
  };
  body.Hash = createHash('md5').update([
    body.EshopId, body.OrderId, body.ServiceName, body.EshopAccount, body.RecipientAmount,
    body.RecipientCurrency, body.PaymentStatus, body.UserName, body.UserEmail, body.PaymentData, secret,
  ].join('::'), 'utf8').digest('hex');
  return body;
}

describe('IntellectMoney Legendary checkout and fulfillment', () => {
  const oldEnv = { ...process.env };
  let order: any;
  let user: any;
  beforeEach(() => {
    process.env.INTELLECTMONEY_ESHOP_ID = '473314';
    process.env.INTELLECTMONEY_SECRET_KEY = secret;
    process.env.INTELLECTMONEY_CURRENCY = 'TST';
    process.env.PUBLIC_BASE_URL = 'https://api.liviapp.com';
    order = {
      _id: '507f1f77bcf86cd799439022', paymentId, user: userId, kind: 'frame', itemId: 'fire',
      eshopId: '473314', amount: '199.00', currency: 'TST', serviceName: 'Рамка Legendary: fire',
      status: 'pending', expiresAt: new Date(Date.now() + 3600000),
    };
    user = { purchasedFrameIds: [] as string[], purchasedBackgroundIds: [] as string[], activeFrameId: '', activeBackgroundId: '' };
    (User.findById as jest.Mock).mockImplementation(() => query(user));
    (User.findOneAndUpdate as jest.Mock).mockImplementation((filter, update) => {
      const field = filter.purchasedFrameIds ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
      if (!user || user[field].includes(order.itemId)) return query(null);
      user[field].push(order.itemId);
      Object.assign(user, update.$set);
      return query({ ...user });
    });
    (Orders.findOne as jest.Mock).mockImplementation(async filter =>
      (filter.user && filter.user !== order.user) || (filter.paymentId && filter.paymentId !== order.paymentId) ? null : { ...order });
    (Orders.findOneAndUpdate as jest.Mock).mockImplementation(async (_filter, update) => ({ ...order, ...update.$setOnInsert, paymentId }));
    (Orders.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
    (Orders.updateOne as jest.Mock).mockImplementation(async (filter, update) => {
      const cond = filter.status;
      if (cond?.$ne === order.status || cond?.$nin?.includes(order.status)) return { modifiedCount: 0 };
      Object.assign(order, update.$set);
      return { modifiedCount: 1 };
    });
  });
  afterAll(() => { process.env = oldEnv; });

  it('creates an IntellectMoney checkout with a server-owned price, ignoring client amount/user fields', async () => {
    const { res } = await invoke('post', '/cosmetics/payments', { body: { kind: 'frame', itemId: 'fire', amount: '1.00', userId: otherId } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ provider: 'intellectmoney', test: true, paymentId });
    expect(res.body.confirmationUrl).toBe(`https://api.liviapp.com/api/cosmetics/intellectmoney/checkout/${paymentId}`);
    expect((Orders.findOneAndUpdate as jest.Mock).mock.calls[0][1].$setOnInsert)
      .toMatchObject({ user: userId, amount: '199.00', currency: 'TST' });
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('charges the existing background price and reuses the pending-order key', async () => {
    await invoke('post', '/cosmetics/payments', { body: { kind: 'background', itemId: 'ocean-flow' } });
    const call = (Orders.findOneAndUpdate as jest.Mock).mock.calls[0];
    expect(call[0].openKey).toBe(`${userId}:background:ocean-flow:473314:TST`);
    expect(call[1].$setOnInsert.amount).toBe('99.00');
    expect(call[2]).toMatchObject({ upsert: true, new: true });
  });
  it('handles concurrent upsert collisions by returning the existing checkout', async () => {
    (Orders.findOneAndUpdate as jest.Mock).mockRejectedValueOnce({ code: 11000 });
    const { res } = await invoke('post', '/cosmetics/payments', { body: { kind: 'frame', itemId: 'fire' } });
    expect(res.body.paymentId).toBe(paymentId);
  });
  it('does not create an order for an already owned item', async () => {
    user.purchasedFrameIds = ['fire'];
    const { res } = await invoke('post', '/cosmetics/payments', { body: { kind: 'frame', itemId: 'fire' } });
    expect(res.body.alreadyOwned).toBe(true);
    expect(Orders.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it.each([{ kind: 'frame', itemId: 'unknown' }, { kind: 'anything', itemId: 'fire' }])('rejects an invalid catalog item: %p', async body => {
    const { res } = await invoke('post', '/cosmetics/payments', { body });
    expect(res.statusCode).toBe(400);
    expect(Orders.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('requires an authenticated user to create an order', async () => {
    const { res } = await invoke('post', '/cosmetics/payments', { userId: undefined, body: { kind: 'frame', itemId: 'fire' } });
    expect(res.statusCode).toBe(401);
  });
  it('fails closed when the new merchant key is missing', async () => {
    delete process.env.INTELLECTMONEY_SECRET_KEY;
    const { res } = await invoke('post', '/cosmetics/payments', { body: { kind: 'frame', itemId: 'fire' } });
    expect(res.statusCode).toBe(503);
    expect(Orders.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('serves a signed, uncached checkout without the app auth headers or merchant key', async () => {
    const { res } = await invoke('get', '/cosmetics/intellectmoney/checkout/:paymentId', { userId: undefined, params: { paymentId } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['Referrer-Policy']).toBe('no-referrer');
    expect(res.body).toContain('name="PurchaseHash"');
    expect(res.body).not.toContain(secret);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('does not serve an expired checkout', async () => {
    order.expiresAt = new Date(0);
    const { res } = await invoke('get', '/cosmetics/intellectmoney/checkout/:paymentId', { params: { paymentId } });
    expect(res.statusCode).toBe(410);
  });
  it('cannot open a test order as a real-money checkout after switching the currency', async () => {
    process.env.INTELLECTMONEY_CURRENCY = 'RUB';
    const { res } = await invoke('get', '/cosmetics/intellectmoney/checkout/:paymentId', { params: { paymentId } });
    expect(res.statusCode).toBe(409);
  });
  it('does not let another user poll the order', async () => {
    const { res } = await invoke('get', '/cosmetics/payments/:paymentId', { userId: otherId, params: { paymentId } });
    expect(res.statusCode).toBe(404);
  });
  it('keeps old YooKassa IDs available to the legacy route', async () => {
    const { next } = await invoke('get', '/cosmetics/payments/:paymentId', { params: { paymentId: 'old-yoo-id' } });
    expect(next).toHaveBeenCalled();
  });
  it('does not grant ownership from a pending status poll', async () => {
    const { res } = await invoke('get', '/cosmetics/payments/:paymentId', { params: { paymentId } });
    expect(res.body).toEqual({ ok: true, status: 'pending' });
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('grants and applies a fully paid, signed order and returns exact OK', async () => {
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { userId: undefined, body: signed('5') });
    expect(res.statusCode).toBe(200); expect(res.body).toBe('OK');
    expect(user.purchasedFrameIds).toEqual(['fire']); expect(user.activeFrameId).toBe('fire');
    expect(order.status).toBe('succeeded');
    expect(broadcast).toHaveBeenCalledWith(expect.anything(), userId, 'fire');
    const result = await invoke('get', '/cosmetics/payments/:paymentId', { params: { paymentId } });
    expect(result.res.body.entitlements.purchasedFrameIds).toEqual(['fire']);
  });
  it.each(['3', '4', '6', '7', '8'])('never grants for non-paid status %s', async status => {
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed(status) });
    expect(res.body).toBe('OK');
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ RecipientAmount: '1.00' }, { RecipientCurrency: 'RUB' }, { EshopId: '123456' }])('rejects a signed but mismatching payment: %p', async fields => {
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5', fields) });
    expect([403, 409]).toContain(res.statusCode);
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('does not acknowledge a forged callback', async () => {
    const body = signed('5'); body.RecipientAmount = '1.00';
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { body });
    expect(res.statusCode).toBe(403); expect(res.body).not.toBe('OK');
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('does not reapply an old frame on duplicate paid notifications', async () => {
    await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5') });
    user.activeFrameId = 'diamond';
    await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5') });
    expect(user.activeFrameId).toBe('diamond');
    expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
  it('recovers from a write failure after ownership was granted without overwriting a later choice', async () => {
    user.purchasedFrameIds = ['fire']; user.activeFrameId = 'diamond';
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5') });
    expect(res.body).toBe('OK'); expect(order.status).toBe('succeeded');
    expect(user.activeFrameId).toBe('diamond'); expect(broadcast).not.toHaveBeenCalled();
  });
  it('ignores a delayed cancellation after successful payment', async () => {
    order.status = 'succeeded';
    await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('4') });
    expect(order.status).toBe('succeeded');
  });
  it('does not grant a refunded order if the paid event arrives later', async () => {
    order.status = 'refunded';
    await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5') });
    expect(User.findOneAndUpdate).not.toHaveBeenCalled();
    expect(order.status).toBe('refunded');
  });
  it('requests a retry if the buyer no longer exists', async () => {
    user = null;
    const { res } = await invoke('post', '/cosmetics/intellectmoney/webhook', { body: signed('5') });
    expect(res.statusCode).toBe(503); expect(res.body).toBe('RETRY');
    expect(order.status).toBe('pending');
  });
});
