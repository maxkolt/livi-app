import type { Server, Socket } from 'socket.io';
const mockSaved = new Map<string, { id: string; timestamp: Date }>();
const mockOfflineSave = jest.fn(async () => true);
jest.mock('../models/FriendshipMessageItem', () => ({ __esModule: true, default: {
  findOne: (filter: { id: string }) => ({ select: () => ({ lean: async () => mockSaved.get(filter.id) || null }) }),
  create: async (message: { id: string; timestamp: Date }) => { mockSaved.set(message.id, message); },
} }));
jest.mock('../models/FriendshipMessages', () => ({ __esModule: true, default: {} }));
jest.mock('../models/User', () => ({ __esModule: true, default: {
  findById: () => ({ select: () => ({ lean: async () => ({ nick: 'Sender' }) }) }),
} }));
jest.mock('../models/OfflineMessage', () => ({ __esModule: true, default: jest.fn(() => ({ save: mockOfflineSave })) }));
jest.mock('../utils/friendshipUtils', () => ({
  areFriendsCached: async () => true,
  getOrCreateFriendship: async () => ({ _id: '64b000000000000000000004', addMessage: async () => {} }),
}));
jest.mock('../utils/push', () => ({ sendMessagePushToUser: jest.fn(async () => {}) }));
jest.mock('../utils/messageLimits', () => ({ checkMessageSendRateLimit: async () => ({ ok: true }), isMessageTextTooLong: () => false }));
jest.mock('../utils/e2eEnvelope', () => ({ resolveIncomingEnvelope: async () => ({ ok: true }) }));
jest.mock('./e2eKeys', () => ({ loadE2ePublicKeys: jest.fn(), registerE2eKeyHandlers: jest.fn() }));
jest.mock('./liveMessageDelivery', () => ({ deliverLiveMessage: jest.fn(async () => 'offline') }));
jest.mock('../utils/unreadStore', () => {
  const store = jest.requireActual('../utils/unreadStoreMemory').createMemoryUnreadStore();
  return {
    addUnread: store.addUnread, countUnreadFrom: store.countFrom, countUnreadTotal: store.countTotal,
    isViewingChatWithUser: store.isViewingWith,
  };
});
import registerMessageSockets from './messagesReliable';
import { addUnread, countUnreadFrom } from '../utils/unreadStore';
import { deliverLiveMessage } from './liveMessageDelivery';
import { sendMessagePushToUser } from '../utils/push';

it('commits the exact count before delivery and shares it with the push without counting a retry twice', async () => {
  const me = '64b000000000000000000001';
  const to = '64b000000000000000000002';
  const other = '64b000000000000000000003';
  await addUnread(to, 'previous-1', me); await addUnread(to, 'previous-2', me);
  for (let i = 0; i < 5; i++) await addUnread(to, `other-${i}`, other);
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const socket = { data: { userId: me }, on: (event: string, handler: (...args: unknown[]) => Promise<void>) => { handlers.set(event, handler); } };
  const io = {
    on: (_event: string, handler: (socket: Socket) => void) => handler(socket as unknown as Socket),
    in: () => ({ fetchSockets: async () => [] }),
  };
  registerMessageSockets(io as unknown as Server);
  (deliverLiveMessage as jest.Mock).mockImplementationOnce(async (_io, recipient, message) => {
    expect(await countUnreadFrom(recipient, me)).toBe(3);
    expect(message).toMatchObject({ id: 'third', text: 'new text', unreadCount: 3, unreadUpdatedAt: expect.any(Number) });
    return 'offline';
  });
  const ack = jest.fn();
  const payload = { to, type: 'text', text: 'new text', clientMessageId: 'third' };
  await handlers.get('message:send')!(payload, ack);
  expect(ack).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, messageId: 'third' }));
  expect(sendMessagePushToUser).toHaveBeenCalledWith(to, expect.objectContaining({
    messageId: 'third', messagePreview: 'new text', unreadCount: 8, unreadFromSender: 3,
  }));
  await handlers.get('message:send')!(payload, ack);
  expect(ack).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, duplicate: true }));
  expect(await countUnreadFrom(to, me)).toBe(3);
  expect(deliverLiveMessage).toHaveBeenCalledTimes(1);
  expect(sendMessagePushToUser).toHaveBeenCalledTimes(1);
});
