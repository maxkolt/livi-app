/**
 * Реакция с явным `on` идемпотентна: повтор из офлайн-очереди клиента (ack потерялся
 * под VPN, запрос ушёл второй раз) не снимает реакцию обратно, как это делал toggle.
 */

const reactions: Array<{ emoji: string; userId: string }> = [];
const sameReaction = (a: { emoji: string; userId: string }, b: { emoji: string; userId: string }) =>
  a.emoji === b.emoji && a.userId === b.userId;

jest.mock('../models/FriendshipMessageItem', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(() => {
      const doc = { _id: 'item', reactions: [...reactions] };
      return { select: () => ({ lean: async () => doc }), lean: async () => doc };
    }),
    updateOne: jest.fn((_filter: unknown, update: any) => ({
      exec: async () => {
        if (update.$addToSet) {
          const r = update.$addToSet.reactions;
          if (!reactions.some((x) => sameReaction(x, r))) {
            reactions.push(r);
            return { modifiedCount: 1 };
          }
          return { modifiedCount: 0 };
        }
        if (update.$pull) {
          const idx = reactions.findIndex((x) => sameReaction(x, update.$pull.reactions));
          if (idx >= 0) {
            reactions.splice(idx, 1);
            return { modifiedCount: 1 };
          }
          return { modifiedCount: 0 };
        }
        return { modifiedCount: 0 };
      },
    })),
  },
}));
jest.mock('../models/FriendshipMessages', () => ({
  __esModule: true,
  default: { updateOne: jest.fn(() => ({ exec: async () => ({}) })) },
}));
jest.mock('../models/User', () => ({ __esModule: true, default: {} }));
jest.mock('../models/OfflineMessage', () => ({ __esModule: true, default: {} }));
jest.mock('../utils/friendshipUtils', () => ({
  areFriendsCached: jest.fn(async () => true),
  getOrCreateFriendship: jest.fn(async () => ({ _id: 'friendship' })),
  invalidateFriendshipCache: jest.fn(),
}));
jest.mock('../utils/push', () => ({ sendMessagePushToUser: jest.fn() }));
jest.mock('../utils/unreadStore', () => ({}));
jest.mock('./e2eKeys', () => ({ loadE2ePublicKeys: jest.fn(), registerE2eKeyHandlers: jest.fn() }));
jest.mock('./liveMessageDelivery', () => ({ deliverLiveMessage: jest.fn() }));

import { applyMessageReaction } from './messagesReliable';

const ME = '64b000000000000000000001';
const PEER = '64b000000000000000000002';
const react = (on?: boolean) =>
  applyMessageReaction(ME, { messageId: 'm1', emoji: '👍', with: PEER, ...(on === undefined ? {} : { on }) });

beforeEach(() => {
  reactions.length = 0;
});

describe('applyMessageReaction', () => {
  it('keeps the reaction when the same "on" request arrives twice', async () => {
    await react(true);
    const second = await react(true);
    expect(second).toMatchObject({ ok: true, event: { reactions: [{ emoji: '👍', userId: ME }] } });
  });

  it('keeps it removed when the same "off" request arrives twice', async () => {
    reactions.push({ emoji: '👍', userId: ME });
    await react(false);
    const second = await react(false);
    expect(second).toMatchObject({ ok: true, event: { reactions: [] } });
  });

  it('still toggles for older clients that send no "on"', async () => {
    expect(await react()).toMatchObject({ event: { reactions: [{ emoji: '👍', userId: ME }] } });
    expect(await react()).toMatchObject({ event: { reactions: [] } });
  });

  it('names both participants so each gets the update', async () => {
    expect(await react(true)).toMatchObject({ participants: [ME, PEER] });
  });

  it('rejects a payload without a valid peer', async () => {
    expect(await applyMessageReaction(ME, { messageId: 'm1', emoji: '👍', with: 'nope' })).toEqual({
      ok: false,
      error: 'bad_payload',
    });
  });
});
