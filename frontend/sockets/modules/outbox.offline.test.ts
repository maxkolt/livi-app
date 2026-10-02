/**
 * Очередь сообщений при плохой сети: ничего не теряем, порядок держим, зависший под VPN
 * сокет обходим по HTTP, без сети ждём и дошлём сами, а окончательный отказ сервера
 * показываем как «не отправлено», а не держим в очереди вечно.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => (mockStore.has(k) ? mockStore.get(k)! : null)),
  setItem: jest.fn(async (k: string, v: string) => {
    mockStore.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    mockStore.delete(k);
  }),
}));

const mockEmitAck = jest.fn();
const mockPost = jest.fn();
const mockSocket = { connected: true };
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => mockEmitAck(...args) }));
jest.mock('./apiHttp', () => ({ postApiJson: (...args: unknown[]) => mockPost(...args) }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
// Шифрование здесь не проверяем: payload уходит как есть (см. e2e.test.ts).
jest.mock('./e2e', () => ({
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: jest.fn(async () => undefined),
  toWireMessagePayload: jest.fn(async (p: unknown) => p),
  toWireEditPayload: jest.fn(async (messageId: string, text: string) => ({ messageId, text })),
}));
jest.mock('./shared', () => ({
  shared: {
    currentUserId: 'me',
    reconnecting: false,
    cancelledOutboxSendIds: new Set<string>(),
    cancelledOutboxDiskHydrated: false,
    outboxDrainInFlight: null,
    editOutboxDrainInFlight: null,
    outboxMessageDeliveredSubs: new Set(),
  },
}));

type Outbox = typeof import('./outbox');
let outbox: Outbox;

const OUTBOX_KEY = 'chat_message_outbox_v1';
const queued = () => JSON.parse(mockStore.get(OUTBOX_KEY) ?? '[]').map((x: any) => x.optimisticUiId);
const enqueue = (id: string, createdAt: number) =>
  outbox.enqueueMessageOutbox({
    id: `outbox_${id}`,
    optimisticUiId: id,
    createdAt,
    payload: { to: 'peer', type: 'text', text: id, clientMessageId: id },
  });
const ackOk = async (_event: string, p: any) => ({ ok: true, messageId: p.clientMessageId });
const sentIds = (mock: jest.Mock) => mock.mock.calls.map((c) => c[1].clientMessageId);
const networkDown = () => Promise.reject(new TypeError('Network request failed'));

beforeEach(() => {
  jest.resetModules();
  jest.useRealTimers();
  mockStore.clear();
  mockEmitAck.mockReset();
  mockPost.mockReset();
  mockSocket.connected = true;
  outbox = require('./outbox');
});

describe('message outbox', () => {
  it('keeps a message queued while a drain is busy and sends it right after', async () => {
    await enqueue('a', 1);
    let releaseFirst: (v: unknown) => void = () => {};
    mockEmitAck
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockImplementation(ackOk);

    const drain = outbox.drainMessageOutbox();
    while (mockEmitAck.mock.calls.length === 0) await new Promise((r) => setImmediate(r));
    await enqueue('b', 2);
    void outbox.drainMessageOutbox();
    releaseFirst({ ok: true, messageId: 'a' });
    await drain;

    expect(sentIds(mockEmitAck)).toEqual(['a', 'b']);
    expect(queued()).toEqual([]);
  });

  it('goes around a socket that stopped answering (VPN) over HTTP', async () => {
    await enqueue('a', 1);
    await enqueue('b', 2);
    mockEmitAck.mockRejectedValue(new Error('Ack timeout for "message:send"'));
    mockPost.mockImplementation(async (_path: string, p: any) => ({ ok: true, messageId: p.clientMessageId, delivered: true }));
    const delivered: any[] = [];
    outbox.onOutboxMessageDelivered((e) => delivered.push(e));

    await outbox.drainMessageOutbox();

    // После первого молчания сокета остальное сразу идёт по HTTP, без лишних 8 с ожидания.
    expect(mockEmitAck).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls.map((c) => [c[0], c[1].clientMessageId])).toEqual([
      ['/api/messages/send', 'a'],
      ['/api/messages/send', 'b'],
    ]);
    expect(delivered.map((d) => [d.serverMessageId, d.delivered])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(queued()).toEqual([]);
  });

  it('waits without network, backing off, and sends once it is back', async () => {
    jest.useFakeTimers();
    mockSocket.connected = false;
    await enqueue('a', 1);
    mockPost.mockImplementation(networkDown);

    await outbox.drainMessageOutbox();
    expect(mockEmitAck).not.toHaveBeenCalled();
    expect(queued()).toEqual(['a']);
    expect(outbox.isMessagePendingInOutbox('a')).toBe(true);

    await jest.advanceTimersByTimeAsync(2000);
    expect(mockPost).toHaveBeenCalledTimes(2);

    // Вторая пауза длиннее первой.
    mockPost.mockImplementation(async () => ({ ok: true, messageId: 'a', delivered: false }));
    await jest.advanceTimersByTimeAsync(3999);
    expect(mockPost).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockPost).toHaveBeenCalledTimes(3);
    expect(queued()).toEqual([]);
    expect(outbox.isMessagePendingInOutbox('a')).toBe(false);
  });

  it('marks a message failed when the server refuses it for good, and moves on', async () => {
    await enqueue('a', 1);
    await enqueue('b', 2);
    mockEmitAck.mockRejectedValue(new Error('Ack timeout'));
    mockPost
      .mockResolvedValueOnce({ ok: false, error: 'http_403:{"ok":false,"error":"not_friends"}' })
      .mockResolvedValueOnce({ ok: true, messageId: 'b' });
    const failed: any[] = [];
    outbox.onOutboxMessageFailed((e) => failed.push(e));

    await outbox.drainMessageOutbox();

    expect(failed).toEqual([{ to: 'peer', outboxId: 'outbox_a', optimisticUiId: 'a', error: 'not_friends' }]);
    expect(queued()).toEqual([]);
    expect(JSON.parse(mockStore.get('chat_statuses_me_peer')!)).toEqual({ a: 'failed', b: 'sent' });
  });

  it('holds the queue in order while the server has a temporary problem', async () => {
    jest.useFakeTimers();
    await enqueue('a', 1);
    await enqueue('b', 2);
    mockEmitAck.mockResolvedValueOnce({ ok: false, error: 'save_failed' }).mockImplementation(ackOk);

    await outbox.drainMessageOutbox();
    expect(sentIds(mockEmitAck)).toEqual(['a']);
    expect(queued()).toEqual(['a', 'b']);

    await jest.advanceTimersByTimeAsync(2000);
    expect(sentIds(mockEmitAck)).toEqual(['a', 'a', 'b']);
    expect(queued()).toEqual([]);
  });

  it('does not let one stuck chat hold messages to other people', async () => {
    jest.useFakeTimers();
    await outbox.enqueueMessageOutbox({ id: 'outbox_a', optimisticUiId: 'a', createdAt: 1, payload: { to: 'peer', type: 'text', text: 'a', clientMessageId: 'a' } });
    await outbox.enqueueMessageOutbox({ id: 'outbox_b', optimisticUiId: 'b', createdAt: 2, payload: { to: 'peer', type: 'text', text: 'b', clientMessageId: 'b' } });
    await outbox.enqueueMessageOutbox({ id: 'outbox_c', optimisticUiId: 'c', createdAt: 3, payload: { to: 'other', type: 'text', text: 'c', clientMessageId: 'c' } });
    mockEmitAck.mockImplementation(async (_e: string, p: any) =>
      p.to === 'peer' ? { ok: false, error: 'save_failed' } : { ok: true, messageId: p.clientMessageId },
    );

    await outbox.drainMessageOutbox();

    expect(sentIds(mockEmitAck)).toEqual(['a', 'c']);
    expect(queued()).toEqual(['a', 'b']);
  });

  it('records the status in the chat storage so a closed chat opens with ticks, never downgrading', async () => {
    mockStore.set('chat_statuses_me_peer', JSON.stringify({ b: 'read' }));
    await enqueue('a', 1);
    await enqueue('b', 2);
    mockEmitAck.mockImplementation(async (_e: string, p: any) => ({ ok: true, messageId: p.clientMessageId, delivered: true }));

    await outbox.drainMessageOutbox();
    await new Promise((r) => setImmediate(r));

    expect(JSON.parse(mockStore.get('chat_statuses_me_peer')!)).toEqual({ a: 'delivered', b: 'read' });
  });

  it('tells a waiting sender the result, or null while it is still queued', async () => {
    jest.useFakeTimers();
    mockSocket.connected = false;
    mockPost.mockImplementation(networkDown);
    await enqueue('a', 1);
    const waitQueued = outbox.waitForOutboxOutcome('outbox_a', 1500);
    void outbox.drainMessageOutbox();
    await jest.advanceTimersByTimeAsync(1500);
    await expect(waitQueued.promise).resolves.toBeNull();

    mockPost.mockImplementation(async () => ({ ok: true, messageId: 'a', delivered: true, timestamp: 't' }));
    const waitDelivered = outbox.waitForOutboxOutcome('outbox_a', 60_000);
    await jest.advanceTimersByTimeAsync(2000);
    await expect(waitDelivered.promise).resolves.toEqual({
      kind: 'delivered',
      messageId: 'a',
      delivered: true,
      timestamp: 't',
    });
  });

  it('drops a message deleted before it went out', async () => {
    await enqueue('a', 1);
    const wait = outbox.waitForOutboxOutcome('outbox_a', 60_000);
    await outbox.removeQueuedMessagesMatching(['a']);
    mockEmitAck.mockImplementation(ackOk);

    await outbox.drainMessageOutbox();

    await expect(wait.promise).resolves.toEqual({ kind: 'cancelled' });
    expect(mockEmitAck).not.toHaveBeenCalled();
    expect(await enqueue('a', 3)).toBe(false);
  });

  it('notifies the chat whenever the set of queued messages changes', async () => {
    const onChange = jest.fn();
    outbox.onOutboxPendingChange(onChange);
    outbox.markMessagePendingInOutbox('a', true);
    expect(outbox.isMessagePendingInOutbox('a')).toBe(true);
    await enqueue('a', 1);
    outbox.markMessagePendingInOutbox('a', false);
    expect(outbox.isMessagePendingInOutbox('a')).toBe(true);
    mockEmitAck.mockImplementation(ackOk);
    await outbox.drainMessageOutbox();
    expect(outbox.isMessagePendingInOutbox('a')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('survives a chat that re-subscribes while handling the event (sync React render)', async () => {
    // Так ведёт себя открытый чат: setState → синхронный рендер → эффект отписал старый
    // обработчик и подписал новый. Живой Set отдавал бы новых без конца — JS вставал на 100%.
    let calls = 0;
    let off = () => {};
    const subscribe = () => {
      off = outbox.onOutboxMessageDelivered(() => {
        calls += 1;
        if (calls > 50) throw new Error('re-subscription loop');
        off();
        subscribe();
      });
    };
    subscribe();
    const onPending = jest.fn(() => {
      offPending();
      offPending = outbox.onOutboxPendingChange(onPending);
    });
    let offPending = outbox.onOutboxPendingChange(onPending);
    await enqueue('a', 1);
    mockEmitAck.mockImplementation(ackOk);

    await outbox.drainMessageOutbox();

    expect(calls).toBe(1);
    expect(queued()).toEqual([]);
    expect(onPending.mock.calls.length).toBeLessThan(10);
  });
});

describe('readApiErrorCode', () => {
  it('reads socket errors and the error inside an HTTP body', () => {
    const { readApiErrorCode } = outbox;
    expect(readApiErrorCode({ ok: false, error: 'not_friends' })).toBe('not_friends');
    expect(readApiErrorCode({ ok: false, error: 'http_403:{"ok":false,"error":"not_friends"}' })).toBe('not_friends');
    expect(readApiErrorCode({ ok: false, error: 'http_502:<html>bad gateway</html>' })).toBe('http_502:<html>bad gateway</html>');
    expect(readApiErrorCode(undefined)).toBe('');
  });
});
