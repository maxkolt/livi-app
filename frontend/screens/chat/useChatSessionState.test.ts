let mockSlots: unknown[] = [];
let mockCursor = 0;
let mockUserId: string | null = 'me';
const mockStorage = new Map<string, string>();

jest.mock('react', () => {
  const react = jest.requireActual('react');
  return {
    ...react,
    useState: (initial: unknown) => {
      const slots = mockSlots, index = mockCursor++;
      if (!(index in slots)) {
        const cell = {
          value: typeof initial === 'function' ? initial() : initial,
          set: (next: unknown) => {
            cell.value = typeof next === 'function' ? next(cell.value) : next;
          },
        };
        slots[index] = cell;
      }
      const cell = slots[index] as { value: unknown; set: (value: unknown) => void };
      return [cell.value, cell.set];
    },
    useRef: (initial: unknown) => {
      const index = mockCursor++;
      if (!(index in mockSlots)) mockSlots[index] = { current: initial };
      return mockSlots[index];
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const index = mockCursor++;
      const previous = mockSlots[index] as { callback: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        mockSlots[index] = { callback, deps };
      }
      return (mockSlots[index] as { callback: unknown }).callback;
    },
  };
});
jest.mock('../../sockets/modules/authState', () => ({ getCurrentUserId: () => mockUserId }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStorage.delete(key); }),
}));

import { useChatSessionState } from './useChatSessionState';
import { getChatHiddenForMeKey, getChatStatusesKey } from './chatStorageKeys';

const RenderSession = (slots: unknown[], peerId = 'peer') => {
  mockSlots = slots;
  mockCursor = 0;
  return useChatSessionState(peerId);
};

beforeEach(() => {
  mockSlots = [];
  mockStorage.clear();
  mockUserId = 'me';
});

it('keeps message, upload and receipt mirrors current while preserving callback identity', () => {
  const slots: unknown[] = [];
  const first = RenderSession(slots);
  first.setMessages([{ id: 'message-1', text: 'pending' }]);
  first.setUploadStatus({ 'message-1': 'sending' });
  first.updateReadStatuses(prev => ({ ...prev, 'message-1': 'sent' }));
  const next = RenderSession(slots);
  expect(next.latestMessagesForPersistRef).toBe(first.latestMessagesForPersistRef);
  expect(next.latestMessagesForPersistRef.current).toEqual(next.messages);
  expect(next.readStatusesRef.current).toEqual({ 'message-1': 'sent' });
  expect(next.uploadStatusRef.current).toEqual({ 'message-1': 'sending' });
  expect(next.updateReadStatuses).toBe(first.updateReadStatuses);
  expect(next.rememberHiddenForMeMessageIds).toBe(first.rememberHiddenForMeMessageIds);
  expect(next.rememberOutboxLocalToServerId).toBe(first.rememberOutboxLocalToServerId);
});

it('uses current peer and account refs even when an older receipt callback is invoked', async () => {
  const slots: unknown[] = [];
  const first = RenderSession(slots, 'old-peer');
  first.setCurrentUserId('new-account');
  RenderSession(slots, 'new-peer');
  first.updateReadStatuses(() => ({ m: 'read' }));
  expect(mockStorage.has(getChatStatusesKey('me', 'old-peer'))).toBe(false);
  expect(JSON.parse(mockStorage.get(getChatStatusesKey('new-account', 'new-peer'))!)).toEqual({ m: 'read' });
  await first.rememberHiddenForMeMessageId('  m  ');
  expect(JSON.parse(mockStorage.get(getChatHiddenForMeKey('new-account', 'new-peer'))!)).toEqual(['m']);
});

it('keeps independent screen instances and their storage separate', async () => {
  const a = RenderSession([], 'peer-a');
  const b = RenderSession([], 'peer-b');
  expect(a.latestMessagesForPersistRef).not.toBe(b.latestMessagesForPersistRef);
  expect(a.deletedServerMessageIdsRef).not.toBe(b.deletedServerMessageIdsRef);
  await a.rememberHiddenForMeMessageIds(['a', 'a', '']);
  await b.rememberHiddenForMeMessageId('b');
  expect(JSON.parse(mockStorage.get(getChatHiddenForMeKey('me', 'peer-a'))!)).toEqual(['a']);
  expect(JSON.parse(mockStorage.get(getChatHiddenForMeKey('me', 'peer-b'))!)).toEqual(['b']);
});

it('retains bounded outbox ID aliases so late acknowledgements can replace optimistic rows', () => {
  const session = RenderSession([]);
  for (let i = 0; i <= 500; i++) session.rememberOutboxLocalToServerId(`local-${i}`, `server-${i}`);
  const ids = session.outboxLocalIdToServerIdRef.current;
  expect(ids.size).toBe(250);
  expect(ids.get('local-500')).toBe('server-500');
  expect(ids.has('local-0')).toBe(false);
  session.rememberOutboxLocalToServerId('', 'server');
  session.rememberOutboxLocalToServerId('same', 'same');
  expect(ids.size).toBe(250);
});

it('handles missing identity and corrupt local metadata without cross-account writes', async () => {
  mockUserId = null;
  const session = RenderSession([]);
  session.updateReadStatuses(() => ({ m: 'delivered' }));
  await session.rememberHiddenForMeMessageId('m');
  expect(mockStorage.size).toBe(0);
  mockStorage.set(getChatHiddenForMeKey('me', 'peer'), '{broken');
  expect(await session.loadHiddenForMeMessageIds('me', 'peer')).toEqual(new Set());
  expect(await session.loadStatuses()).toEqual({});
});
