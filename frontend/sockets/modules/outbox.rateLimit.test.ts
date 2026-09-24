/**
 * Сервер ограничивает частоту message:send. Отказ по лимиту — не ошибка сообщения:
 * outbox останавливает пачку и повторяет её по таймеру retryAfterSec, а не ждёт
 * следующего connect (раньше остаток пачки после офлайна зависал до переподключения).
 */

const store = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
  setItem: jest.fn(async (k: string, v: string) => {
    store.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    store.delete(k);
  }),
}));

const emitAckMock = jest.fn();
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => emitAckMock(...args) }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
jest.mock('./socketCore', () => ({ socket: { connected: true } }));
// Шифрование здесь не проверяем: payload уходит как есть (см. e2e.test.ts).
jest.mock('./e2e', () => ({
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: jest.fn(async () => undefined),
  toWireMessagePayload: jest.fn(async (p: unknown) => p),
  toWireEditPayload: jest.fn(async (messageId: string, text: string) => ({ messageId, text })),
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

import {
  drainMessageOutbox,
  enqueueMessageOutbox,
  readRateLimitRetryAfterSec,
} from './outbox';

const OUTBOX_KEY = 'chat_message_outbox_v1';
const queuedIds = () => JSON.parse(store.get(OUTBOX_KEY) ?? '[]').map((x: any) => x.id);
const enqueue = (id: string, createdAt: number) =>
  enqueueMessageOutbox({ id, optimisticUiId: `ui_${id}`, createdAt, payload: { to: 'peer', type: 'text', text: id } } as any);

describe('readRateLimitRetryAfterSec', () => {
  it('reads the socket rejection', () => {
    expect(readRateLimitRetryAfterSec({ ok: false, error: 'rate_limited', retryAfterSec: 7 })).toBe(7);
  });

  it('reads the HTTP 429 body that sendMessage wraps into the error string', () => {
    const http = { ok: false, error: 'http_429:{"ok":false,"error":"rate_limited","retryAfterSec":12}' };
    expect(readRateLimitRetryAfterSec(http)).toBe(12);
  });

  it('falls back to a short delay when the server gives none, and caps long ones', () => {
    expect(readRateLimitRetryAfterSec({ error: 'rate_limited' })).toBe(5);
    expect(readRateLimitRetryAfterSec({ error: 'http_429:not json' })).toBe(5);
    expect(readRateLimitRetryAfterSec({ error: 'rate_limited', retryAfterSec: 99_999 })).toBe(600);
  });

  it('ignores every other failure', () => {
    expect(readRateLimitRetryAfterSec({ ok: false, error: 'not_friends' })).toBeNull();
    expect(readRateLimitRetryAfterSec({ ok: false, error: 'http_500' })).toBeNull();
    expect(readRateLimitRetryAfterSec(undefined)).toBeNull();
  });
});

describe('drainMessageOutbox under rate limit', () => {
  beforeEach(() => {
    store.clear();
    emitAckMock.mockReset();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops at the rejected message, keeps the rest in order and retries after the delay', async () => {
    await enqueue('o1', 1);
    await enqueue('o2', 2);
    await enqueue('o3', 3);

    emitAckMock
      .mockResolvedValueOnce({ ok: true, messageId: 'o1' })
      .mockResolvedValueOnce({ ok: false, error: 'rate_limited', retryAfterSec: 4 });

    await drainMessageOutbox();
    expect(emitAckMock).toHaveBeenCalledTimes(2);
    expect(queuedIds()).toEqual(['o2', 'o3']);

    emitAckMock.mockImplementation(async (_event: string, payload: any) => ({ ok: true, messageId: payload.text }));
    await jest.advanceTimersByTimeAsync(3_999);
    expect(emitAckMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    await jest.runOnlyPendingTimersAsync();
    expect(emitAckMock.mock.calls.slice(2).map((c) => c[1].text)).toEqual(['o2', 'o3']);
    expect(queuedIds()).toEqual([]);
  });
});
