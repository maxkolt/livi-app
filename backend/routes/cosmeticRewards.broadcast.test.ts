jest.mock('../models/User', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn() } }));
jest.mock('../utils/liviRewards', () => ({
  ...jest.requireActual('../utils/liviRewards'), reconcileInviteRewards: jest.fn(async () => {}),
}));
import User from '../models/User';
import { createCosmeticRewardsRouter } from './cosmeticRewards';

it.each([['delete', '/cosmetics/owned'], ['post', '/cosmetics/redeem']])(
  'responds to %s %s without waiting for friend fanout', async (method, path) => {
    let complete!: () => void;
    const broadcast = jest.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const user = { purchasedFrameIds: [], activeFrameId: '', liviPoints: 0 };
    (User.findOneAndUpdate as jest.Mock).mockReturnValue({ select: () => ({ lean: async () => user }) });
    const router = createCosmeticRewardsRouter(broadcast);
    const route = (router as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method]);
    const res = { setHeader: jest.fn(), json: jest.fn() };
    const pending = route.route.stack[0].handle({ userId: '507f1f77bcf86cd799439011', body: { kind: 'frame', itemId: 'fire' } }, res);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    complete(); await pending;
  },
);
