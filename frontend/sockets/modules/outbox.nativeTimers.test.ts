/** React Native timers return numeric IDs, unlike Node/Jest timer handles. */
const mockStore = new Map<string, string>();
const mockEmitAck = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => mockEmitAck(...args) }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: async () => true }));
jest.mock('./apiHttp', () => ({ postApiJson: jest.fn() }));
jest.mock('./socketCore', () => ({ socket: { connected: true } }));
jest.mock('./e2e', () => ({
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: async () => {},
  toWireMessagePayload: async (payload: unknown) => payload,
  toWireEditPayload: async (messageId: string, text: string) => ({ messageId, text }),
}));
jest.mock('./shared', () => ({
  shared: {
    cancelledOutboxSendIds: new Set<string>(),
    cancelledOutboxDiskHydrated: false,
    outboxDrainInFlight: null,
    editOutboxDrainInFlight: null,
    outboxMessageDeliveredSubs: new Set(),
  },
}));

type Outbox = typeof import('./outbox');
let outbox: Outbox;
let restoreTimers: () => void;

beforeEach(async () => {
  jest.resetModules();
  jest.useFakeTimers();
  mockStore.clear();
  mockEmitAck.mockReset().mockResolvedValue({ ok: true, messageId: 'ui-a' });
  outbox = require('./outbox') as Outbox;

  const setTimer = global.setTimeout;
  const clearTimer = global.clearTimeout;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  Object.defineProperty(global, 'setTimeout', {
    configurable: true, writable: true,
    value: (callback: () => void, delay?: number) => {
      const id = nextId++;
      handles.set(id, setTimer(() => { handles.delete(id); callback(); }, delay));
      return id;
    },
  });
  Object.defineProperty(global, 'clearTimeout', {
    configurable: true, writable: true,
    value: (id: number) => {
      const handle = handles.get(id);
      if (handle) clearTimer(handle);
      handles.delete(id);
    },
  });
  restoreTimers = () => {
    Object.assign(global, { setTimeout: setTimer, clearTimeout: clearTimer });
    jest.useRealTimers();
  };

  await outbox.enqueueMessageOutbox({
    id: 'outbox-a', optimisticUiId: 'ui-a', createdAt: Date.now(),
    payload: { to: 'peer', type: 'text', text: 'a', clientMessageId: 'ui-a' },
  });
});

afterEach(() => restoreTimers());

it('retries a rate-limited message with numeric timer IDs and can schedule another retry', async () => {
  mockEmitAck
    .mockResolvedValueOnce({ ok: false, error: 'rate_limited', retryAfterSec: 4 })
    .mockResolvedValueOnce({ ok: false, error: 'rate_limited', retryAfterSec: 2 });
  await outbox.drainMessageOutbox();
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(3999);
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockEmitAck).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1999);
  expect(mockEmitAck).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(mockEmitAck).toHaveBeenCalledTimes(3);
  expect(mockStore.has('chat_message_outbox_v1')).toBe(false);
});

it('keeps an earlier retry when a later one is requested', async () => {
  outbox.scheduleMessageOutboxDrain(5);
  outbox.scheduleMessageOutboxDrain(20);
  await jest.advanceTimersByTimeAsync(4999);
  expect(mockEmitAck).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(20_000);
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
});

it('replaces a later retry with an earlier one and cancels the previous timer', async () => {
  outbox.scheduleMessageOutboxDrain(20);
  outbox.scheduleMessageOutboxDrain(5);
  await jest.advanceTimersByTimeAsync(5000);
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(20_000);
  expect(mockEmitAck).toHaveBeenCalledTimes(1);
});
