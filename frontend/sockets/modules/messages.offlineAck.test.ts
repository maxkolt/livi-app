/**
 * Офлайн-очередь приходит пачкой на reconnect. saveMessage — read-modify-write одного
 * ключа AsyncStorage, и без сериализации параллельные записи затирали друг друга.
 * Ack серверу уходит только после записи: по нему сервер удаляет запись из очереди.
 */

const store = new Map<string, string>();
const tick = () => new Promise((r) => setTimeout(r, 0));

jest.mock('@react-native-async-storage/async-storage', () => ({
  // Задержка между чтением и записью — ровно то окно, в котором терялись сообщения.
  getItem: jest.fn(async (k: string) => {
    await tick();
    return store.has(k) ? store.get(k)! : null;
  }),
  setItem: jest.fn(async (k: string, v: string) => {
    await tick();
    store.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    store.delete(k);
  }),
}));

const socketHandlers = new Map<string, Array<(...args: any[]) => void>>();
jest.mock('./socketCore', () => ({
  socket: {
    connected: true,
    emit: jest.fn(),
    on: jest.fn((event: string, h: (...args: any[]) => void) => {
      socketHandlers.set(event, [...(socketHandlers.get(event) ?? []), h]);
    }),
    off: jest.fn(),
  },
}));
jest.mock('./shared', () => ({
  shared: { currentUserId: 'me', messageCache: new Map() },
}));
jest.mock('./emit', () => ({ emitAck: jest.fn(), waitForConnect: jest.fn() }));
jest.mock('./outbox', () => ({
  enqueueEditOutbox: jest.fn(),
  enqueueMessageOutbox: jest.fn(),
  mergePendingMessageOutboxEdit: jest.fn(),
}));
jest.mock('./constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../../utils/installId', () => ({ getInstallId: jest.fn(async () => 'inst') }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { globalMessageStorage } from './messages';
import { shared } from './shared';

const incoming = (id: string) => ({ id, from: 'peer', to: 'me', type: 'text', text: id, timestamp: new Date(0).toISOString() });
const storedIds = () =>
  JSON.parse(store.get(globalMessageStorage.getChatKey('me', 'peer')) ?? '[]').map((m: any) => m.id);
const settle = async () => {
  for (let i = 0; i < 50; i++) await tick();
};

beforeEach(() => {
  store.clear();
  (shared as any).currentUserId = 'me';
});

describe('globalMessageStorage.saveMessage', () => {
  it('keeps every message of a concurrent burst into one chat', async () => {
    const results = await Promise.all(
      ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => globalMessageStorage.saveMessage(incoming(id), 'me')),
    );

    expect(results).toEqual([true, true, true, true, true]);
    expect(storedIds()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('reports an already stored message as saved and does not duplicate it', async () => {
    await globalMessageStorage.saveMessage(incoming('m1'), 'me');
    await expect(globalMessageStorage.saveMessage(incoming('m1'), 'me')).resolves.toBe(true);
    expect(storedIds()).toEqual(['m1']);
  });

  it('returns false when it cannot resolve the chat', async () => {
    await expect(globalMessageStorage.saveMessage(incoming('m1'), '')).resolves.toBe(false);
    await expect(globalMessageStorage.saveMessage({ from: 'peer', to: 'me' }, 'me')).resolves.toBe(false);
  });
});

describe('message:received global handler', () => {
  const deliver = (message: any, ack?: jest.Mock) => {
    for (const h of socketHandlers.get('message:received') ?? []) h(message, ack);
  };

  it('acks an offline-queue message only after it is stored', async () => {
    const ack = jest.fn(() => {
      expect(storedIds()).toContain('m1');
    });
    deliver(incoming('m1'), ack);
    expect(ack).not.toHaveBeenCalled();

    await settle();
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it('acks every message of a burst and stores all of them', async () => {
    const acks = ['m1', 'm2', 'm3'].map((id) => {
      const ack = jest.fn();
      deliver(incoming(id), ack);
      return ack;
    });

    await settle();
    acks.forEach((ack) => expect(ack).toHaveBeenCalledTimes(1));
    expect(storedIds()).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not ack before the user is known, so the server redelivers', async () => {
    (shared as any).currentUserId = undefined;
    const ack = jest.fn();
    deliver(incoming('m1'), ack);

    await settle();
    expect(ack).not.toHaveBeenCalled();
  });

  it('tolerates live messages that carry no ack', async () => {
    deliver(incoming('m1'));
    await settle();
    expect(storedIds()).toEqual(['m1']);
  });
});
