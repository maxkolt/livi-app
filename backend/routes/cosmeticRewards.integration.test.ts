import express from 'express';
import type { Server } from 'http';
import mongoose from 'mongoose';
import User from '../models/User';
import Edge from '../models/FriendshipEdge';
import cosmetics from './cosmetics';
import { ensureFriendshipEdges, removeFriendshipEdges } from '../utils/friendshipUtils';
import { recordInviteAttribution, reconcileInviteRewards } from '../utils/liviRewards';

// Opt-in real MongoDB checks, always in a new disposable database.
const mongoUri = process.env.LIVI_REWARDS_TEST_MONGO_URI;
const suite = mongoUri ? describe : describe.skip;
suite('LiVi rewards with real MongoDB atomic updates and HTTP routes', () => {
  let server: Server;
  let base: string;
  let userId: string;
  let sequence = 0;
  beforeAll(async () => {
    await mongoose.connect(mongoUri!, { dbName: `livi_rewards_test_${process.pid}_${Date.now()}` });
    await Promise.all([User.init(), Edge.init()]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { userId: req.headers['x-test-user'] }); next(); });
    app.use(cosmetics);
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Edge.deleteMany({})]);
    userId = String((await User.create({ nick: `owner-${++sequence}`, createdAt: new Date(Date.now() - 2 * 86400000) }))._id);
  });
  async function http(path: string, body?: object, uid: string | null = userId, method?: string) {
    const response = await fetch(`${base}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(uid ? { 'x-test-user': uid } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function newInvite(inviter = userId) {
    const friend = String((await User.create({ nick: 'friend' }))._id);
    await recordInviteAttribution(friend, inviter);
    return friend;
  }
  const balance = async () => (await http('/cosmetics/me')).body.entitlements.rewards;

  it('counts five accepted friends once under simultaneous reconciliation and preserves old purchases', async () => {
    await User.updateOne({ _id: userId }, { $addToSet: { purchasedFrameIds: 'fire' } });
    const friends = await Promise.all(Array.from({ length: 5 }, () => newInvite()));
    await Promise.all(friends.map(friend => ensureFriendshipEdges(userId, friend)));
    expect((await User.findById(userId))?.liviPoints).toBe(50);
    await Promise.all(Array.from({ length: 8 }, () => reconcileInviteRewards(userId)));
    expect(await balance()).toMatchObject({ balance: 50, invitedCount: 5 });
    expect((await http('/cosmetics/me')).body.entitlements.purchasedFrameIds).toEqual(['fire']);
    await removeFriendshipEdges(userId, friends[0]);
    await ensureFriendshipEdges(userId, friends[0]);
    expect(await balance()).toMatchObject({ balance: 50, invitedCount: 5 });
  });
  it('does not reward opening or sharing a link before acceptance', async () => {
    await newInvite();
    expect(await balance()).toMatchObject({ balance: 0, invitedCount: 0 });
  });
  it('credits an acceptance after friendship was deleted before opening the store', async () => {
    const friend = await newInvite();
    await ensureFriendshipEdges(userId, friend);
    await removeFriendshipEdges(userId, friend);
    expect(await balance()).toMatchObject({ balance: 10, invitedCount: 1 });
  });
  it('heals an interrupted acceptance marker using durable friendship', async () => {
    const friend = await newInvite();
    await Edge.create({ userId, friendId: friend });
    expect(await balance()).toMatchObject({ balance: 10, invitedCount: 1 });
  });
  it('keeps the first inviter under concurrent link claims', async () => {
    const other = String((await User.create({ nick: 'other', createdAt: new Date(Date.now() - 86400000) }))._id);
    const friend = String((await User.create({ nick: 'friend' }))._id);
    await Promise.all([recordInviteAttribution(friend, userId), recordInviteAttribution(friend, other)]);
    await Promise.all([ensureFriendshipEdges(userId, friend), ensureFriendshipEdges(other, friend)]);
    const first = await balance();
    const second = (await http('/cosmetics/me', undefined, other)).body.entitlements.rewards;
    expect(first.balance + second.balance).toBe(10);
  });
  it('rejects self, nonexistent inviters, old accounts and referral cycles', async () => {
    const old = String((await User.create({ createdAt: new Date(Date.now() - 8 * 86400000) }))._id);
    const friend = await newInvite();
    await recordInviteAttribution(userId, userId);
    await recordInviteAttribution(old, userId);
    await recordInviteAttribution(userId, friend);
    const missing = new mongoose.Types.ObjectId().toString();
    const fresh = String((await User.create({}))._id);
    await recordInviteAttribution(fresh, missing);
    const docs = await User.find({ _id: { $in: [userId, old, fresh] } }).lean();
    expect(docs.every(user => !user.referredBy)).toBe(true);
  });
  it('does not reward existing friends or ordinary friendship without an invite', async () => {
    const friend = String((await User.create({}))._id);
    await ensureFriendshipEdges(userId, friend);
    await recordInviteAttribution(friend, userId);
    expect(await balance()).toMatchObject({ balance: 0, invitedCount: 0 });
  });
  it('atomically redeems and applies a background using only the server price', async () => {
    await User.updateOne({ _id: userId }, { $set: { liviPoints: 50 } });
    const result = await http('/cosmetics/redeem', { kind: 'background', itemId: 'ocean-flow', price: 0, userId: new mongoose.Types.ObjectId() });
    expect(result.status).toBe(200);
    expect(result.body.entitlements).toMatchObject({ purchasedBackgroundIds: ['ocean-flow'], activeBackgroundId: 'ocean-flow', rewards: { balance: 0 } });
  });
  it('never overspends when different items are redeemed concurrently', async () => {
    await User.updateOne({ _id: userId }, { $set: { liviPoints: 50 } });
    const results = await Promise.all(['ocean-flow', 'poetry', 'deep-space'].map(itemId => http('/cosmetics/redeem', { kind: 'background', itemId })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409, 409]);
    expect(await balance()).toMatchObject({ balance: 0 });
    expect((await User.findById(userId))?.purchasedBackgroundIds).toHaveLength(1);
  });
  it('charges once for repeated frame requests, and a replay does not overwrite a newer active frame', async () => {
    await User.updateOne({ _id: userId }, { $set: { liviPoints: 100 } });
    const body = { kind: 'frame', itemId: 'fire' };
    const results = await Promise.all(Array.from({ length: 5 }, () => http('/cosmetics/redeem', body)));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(await balance()).toMatchObject({ balance: 0 });
    await User.updateOne({ _id: userId }, { $set: { activeFrameId: '' } });
    await http('/cosmetics/redeem', body);
    expect((await User.findById(userId))?.activeFrameId).toBe('');
  });
  it('rejects insufficient funds without granting or activating anything', async () => {
    const result = await http('/cosmetics/redeem', { kind: 'frame', itemId: 'fire' });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('insufficient_points');
    expect((await User.findById(userId))?.purchasedFrameIds).toEqual([]);
  });
  it('stores critical feedback privately and awards a single gift, without adding points', async () => {
    const text = 'Мне не нравится, что приложение иногда медленно открывается.';
    const result = await http('/cosmetics/feedback', { text });
    expect(result.status).toBe(200);
    expect(result.body.entitlements.rewards).toMatchObject({ balance: 0, feedbackSubmitted: true, feedbackGiftAvailable: true });
    expect(result.body.entitlements.feedbackText).toBeUndefined();
    expect((await User.findById(userId).lean())?.feedbackText).toBeUndefined();
    expect((await User.findById(userId).select('+feedbackText').lean())?.feedbackText).toBe(text);
  });
  it('allows exactly one gift redemption during concurrent requests and cannot replenish it by resubmitting feedback', async () => {
    const text = 'Хотелось бы улучшить скорость и добавить новые цвета.';
    await Promise.all(Array.from({ length: 5 }, () => http('/cosmetics/feedback', { text })));
    const results = await Promise.all(['poetry', 'deep-space', 'ocean-flow'].map(itemId => http('/cosmetics/redeem', { kind: 'background', itemId, useGift: true })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409, 409]);
    await http('/cosmetics/feedback', { text });
    expect(await balance()).toMatchObject({ balance: 0, feedbackGiftAvailable: false, feedbackSubmitted: true });
  });
  it.each(['', 'short', 'x'.repeat(2001)])('rejects feedback of invalid length', async text => {
    expect((await http('/cosmetics/feedback', { text })).status).toBe(400);
    expect((await balance()).feedbackSubmitted).toBe(false);
  });
  it.each([
    { kind: 'frame', itemId: 'aurora' }, { kind: 'frame', itemId: 'fire', useGift: true },
    { kind: 'other', itemId: 'fire' }, { kind: 'background', itemId: { $ne: '' } },
    { kind: 'background', itemId: 'poetry', useGift: 'false' },
  ])('rejects unavailable items and malformed input: %j', async body => {
    expect((await http('/cosmetics/redeem', body)).status).toBe(400);
  });
  it('requires authentication and disables cash checkout creation', async () => {
    expect((await http('/cosmetics/redeem', { kind: 'frame', itemId: 'fire' }, null)).status).toBe(401);
    expect((await http('/cosmetics/feedback', { text: 'x'.repeat(30) }, null)).status).toBe(401);
    expect((await http('/cosmetics/payments', { kind: 'frame', itemId: 'fire' })).status).toBe(410);
    expect((await http('/cosmetics/intellectmoney/checkout/im_old')).status).toBe(410);
  });
  it('keeps ownership enforcement and lets earlier purchases be applied', async () => {
    await User.updateOne({ _id: userId }, { $set: { purchasedFrameIds: ['diamond'] } });
    expect((await http('/cosmetics/active', { kind: 'frame', itemId: 'fire' }, userId, 'PATCH')).status).toBe(403);
    const result = await http('/cosmetics/active', { kind: 'frame', itemId: 'diamond' }, userId, 'PATCH');
    expect(result.status).toBe(200);
    expect(result.body.entitlements.activeFrameId).toBe('diamond');
  });
  it.each(['frame', 'background'] as const)('deletes an active %s completely without refunding points or gifts', async kind => {
    const itemId = kind === 'frame' ? 'fire' : 'poetry';
    const owned = kind === 'frame' ? 'purchasedFrameIds' : 'purchasedBackgroundIds';
    const active = kind === 'frame' ? 'activeFrameId' : 'activeBackgroundId';
    await User.updateOne({ _id: userId }, { $set: { [owned]: [itemId], [active]: itemId, liviPoints: 20, feedbackGiftAvailable: false } });
    const result = await http('/cosmetics/owned', { kind, itemId }, userId, 'DELETE');
    expect(result.status).toBe(200);
    expect(result.body.entitlements).toMatchObject({ [owned]: [], [active]: '', rewards: { balance: 20, feedbackGiftAvailable: false } });
    expect((await http('/cosmetics/active', { kind, itemId }, userId, 'PATCH')).status).toBe(403);
    expect((await http('/cosmetics/owned', { kind, itemId }, userId, 'DELETE')).status).toBe(200);
  });
  it('keeps the active item when deleting another owned item and permits a new purchase later', async () => {
    await User.updateOne({ _id: userId }, { $set: { purchasedFrameIds: ['fire', 'diamond'], activeFrameId: 'diamond', liviPoints: 100 } });
    const deleted = await http('/cosmetics/owned', { kind: 'frame', itemId: 'fire' }, userId, 'DELETE');
    expect(deleted.body.entitlements).toMatchObject({ purchasedFrameIds: ['diamond'], activeFrameId: 'diamond' });
    const redeemed = await http('/cosmetics/redeem', { kind: 'frame', itemId: 'fire' });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body.entitlements).toMatchObject({ purchasedFrameIds: ['diamond', 'fire'], activeFrameId: 'fire', rewards: { balance: 0 } });
  });
  it('does not reactivate a deleted item when application and deletion race', async () => {
    for (let i = 0; i < 12; i++) {
      await User.updateOne({ _id: userId }, { $set: { purchasedBackgroundIds: ['poetry'], activeBackgroundId: '' } });
      await Promise.all([
        http('/cosmetics/active', { kind: 'background', itemId: 'poetry' }, userId, 'PATCH'),
        http('/cosmetics/owned', { kind: 'background', itemId: 'poetry' }, userId, 'DELETE'),
      ]);
      const user = await User.findById(userId).lean();
      expect(user).toMatchObject({ purchasedBackgroundIds: [], activeBackgroundId: '' });
    }
  });
  it('requires authentication and valid input to delete, and never deletes another user’s collection', async () => {
    const other = String((await User.create({ purchasedFrameIds: ['fire'], activeFrameId: 'fire' }))._id);
    const body = { kind: 'frame', itemId: 'fire', userId: other };
    expect((await http('/cosmetics/owned', body, null, 'DELETE')).status).toBe(401);
    expect((await http('/cosmetics/owned', { kind: 'bad', itemId: 'fire' }, userId, 'DELETE')).status).toBe(400);
    expect((await http('/cosmetics/owned', body, userId, 'DELETE')).status).toBe(200);
    expect(await User.findById(other).lean()).toMatchObject({ purchasedFrameIds: ['fire'], activeFrameId: 'fire' });
  });

});
