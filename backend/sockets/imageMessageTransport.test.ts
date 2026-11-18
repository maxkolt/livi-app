import type { Server, Socket } from 'socket.io';
import type { Request, Response, NextFunction } from 'express';
const ME = '64b000000000000000000001', PEER = '64b000000000000000000002';
const mockSaved = new Map<string, Record<string, unknown>>();
const mockOffline: Array<Record<string, unknown>> = [];
const mockLast: Array<Record<string, unknown>> = [];
const mockSpk = Buffer.alloc(32, 1).toString('base64'), mockRpk = Buffer.alloc(32, 2).toString('base64');
jest.mock('../models/FriendshipMessageItem', () => ({ __esModule: true, default: {
  findOne: (filter: { id: string }) => ({ select: () => ({ lean: async () => mockSaved.get(filter.id) || null }) }),
  create: async (value: Record<string, unknown>) => { mockSaved.set(String(value.id), value); return value; },
} }));
jest.mock('../models/FriendshipMessages', () => ({ __esModule: true, default: {} }));
jest.mock('../models/OfflineMessage', () => ({ __esModule: true, default: class {
  constructor(private value: Record<string, unknown>) {}
  async save() { mockOffline.push(this.value); }
  static async create(value: Record<string, unknown>) { mockOffline.push(value); return value; }
} }));
jest.mock('../models/User', () => ({ __esModule: true, default: {
  findById: () => ({ select: () => ({ lean: async () => ({ nick: 'Sender' }) }) }),
} }));
jest.mock('../utils/friendshipUtils', () => ({
  areFriendsCached: async () => true,
  getOrCreateFriendship: async () => ({ _id: new (require('mongoose').Types.ObjectId)('64b000000000000000000004'),
    addMessage: async (value: Record<string, unknown>) => { mockLast.push(value); } }),
}));
jest.mock('../utils/push', () => ({ sendMessagePushToUser: jest.fn(async () => {}) }));
jest.mock('../utils/messageLimits', () => ({ ...jest.requireActual('../utils/messageLimits'), checkMessageSendRateLimit: async () => ({ ok: true }) }));
jest.mock('./e2eKeys', () => ({
  loadE2ePublicKeys: async () => ({ [ME]: mockSpk, [PEER]: mockRpk }), registerE2eKeyHandlers: jest.fn(),
}));
jest.mock('./liveMessageDelivery', () => ({ deliverLiveMessage: jest.fn(async () => 'offline') }));
jest.mock('../utils/unreadStore', () => {
  const store = jest.requireActual('../utils/unreadStoreMemory').createMemoryUnreadStore();
  return { addUnread: store.addUnread, countUnreadFrom: store.countFrom, countUnreadTotal: store.countTotal, isViewingChatWithUser: store.isViewingWith };
});
import registerMessageSockets, { formatMessageForClient } from './messagesReliable';
import messagesRouter from '../routes/messages';
import type { IMessageItem } from '../models/FriendshipMessages';
import { deliverLiveMessage } from './liveMessageDelivery';

const envelope = { v: 1, n: Buffer.alloc(24, 3).toString('base64'), c: Buffer.alloc(64, 4).toString('base64'), spk: mockSpk, rpk: mockRpk };
const photo = {
  to: PEER, type: 'image', text: 'must never persist with enc', enc: envelope,
  uri: 'https://x/portrait', uris: ['https://x/portrait', 'https://x/landscape'],
  imageWidth: 900, imageHeight: 1600, imageSizes: [{ width: 900, height: 1600 }, { width: 1600, height: 900 }],
};
const expected = { type: 'image', imageWidth: 900, imageHeight: 1600, imageSizes: photo.imageSizes, uris: photo.uris, enc: envelope };
beforeEach(() => { mockSaved.clear(); mockOffline.length = 0; mockLast.length = 0; jest.clearAllMocks(); });

async function socketSend(payload: Record<string, unknown>) {
  const handlers = new Map<string, (payload: unknown, ack: (...args: unknown[]) => void) => Promise<void>>();
  const socket = { data: { userId: ME }, on: (event: string, handler: (payload: unknown, ack: (...args: unknown[]) => void) => Promise<void>) => { handlers.set(event, handler); } };
  const io = { on: (_event: string, callback: (socket: Socket) => void) => callback(socket as unknown as Socket),
    in: () => ({ fetchSockets: async () => [] }), to: () => ({ emit: jest.fn() }) };
  registerMessageSockets(io as unknown as Server);
  const ack = jest.fn(); await handlers.get('message:send')!(payload, ack); return ack;
}
async function httpSend(payload: Record<string, unknown>) {
  const route = messagesRouter.stack.find(layer => layer.route?.path === '/messages/send')!.route;
  if (!route) throw new Error('send route missing');
  let body: unknown;
  const res = { status: jest.fn().mockReturnThis(), json: (value: unknown) => { body = value; }, setHeader: jest.fn() };
  await route.stack[0].handle({ userId: ME, body: payload } as unknown as Request, res as unknown as Response, (() => {}) as NextFunction);
  return body;
}

it.each(['socket', 'http'])('%s persists the encrypted album caption envelope, dimensions and offline delivery without a plaintext copy', async transport => {
  const id = `album-${transport}`;
  if (transport === 'socket') expect(await socketSend({ ...photo, clientMessageId: id })).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  else expect(await httpSend({ ...photo, clientMessageId: id })).toMatchObject({ ok: true });
  expect(mockSaved.get(id)).toMatchObject(expected);
  expect(mockLast[0]).toMatchObject(expected);
  expect(mockOffline[0].messageData).toMatchObject(expected);
  expect(mockSaved.get(id)?.text).toBeUndefined();
  expect(JSON.stringify(mockSaved.get(id))).not.toContain(photo.text);
  const history = formatMessageForClient(mockSaved.get(id) as unknown as IMessageItem);
  expect(history).toMatchObject(expected);
  expect(history.text).toBeUndefined();
  if (transport === 'socket') expect(deliverLiveMessage).toHaveBeenCalledWith(expect.anything(), PEER, expect.objectContaining(expected), expect.any(Function));
});

it('retains a plain single-photo caption when the established no-envelope policy is used', async () => {
  const { enc: _enc, uris: _uris, imageSizes: _sizes, ...single } = photo;
  expect(await httpSend({ ...single, text: 'ordinary caption', clientMessageId: 'single-plain' })).toMatchObject({ ok: true });
  const history = formatMessageForClient(mockSaved.get('single-plain') as unknown as IMessageItem);
  expect(history).toMatchObject({ text: 'ordinary caption', imageWidth: 900, imageHeight: 1600, uri: photo.uri });
  expect(history.uris).toBeUndefined();
});

it('sanitizes invalid geometry at both transport entry points', async () => {
  const invalid = { to: PEER, type: 'image', uri: 'https://x/a', imageWidth: Infinity, imageHeight: 1600 };
  await socketSend({ ...invalid, clientMessageId: 'bad-socket' });
  await httpSend({ ...invalid, clientMessageId: 'bad-http' });
  for (const value of mockSaved.values()) { expect(value.imageWidth).toBeUndefined(); expect(value.imageHeight).toBeUndefined(); }
});
