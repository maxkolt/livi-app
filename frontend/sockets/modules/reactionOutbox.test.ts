/**
 * Реакции при плохой сети: своя видна сразу и не пропадает до подтверждения сервера,
 * переживает перезапуск, повтор не снимает её обратно, а реакция на своё ещё не
 * отправленное сообщение ждёт, пока сообщение дойдёт до сервера.
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
const mockPendingMessages = new Set<string>();
const mockDeliveredSubs: Array<(e: any) => void> = [];
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => mockEmitAck(...args) }));
jest.mock('./apiHttp', () => ({ postApiJson: (...args: unknown[]) => mockPost(...args) }));
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('./shared', () => ({ shared: { currentUserId: 'me', reconnecting: false } }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('./outbox', () => ({
  isMessagePendingInOutbox: (id: string) => mockPendingMessages.has(id),
  onOutboxMessageDelivered: (cb: (e: any) => void) => {
    mockDeliveredSubs.push(cb);
    return () => {};
  },
  readApiErrorCode: (r: any) => String(r?.error || ''),
}));

type ReactionOutbox = typeof import('./reactionOutbox');
let ro: ReactionOutbox;

const KEY = 'chat_reaction_outbox_v1';
const MINE = { emoji: '👍', userId: 'me' };
const stored = () => JSON.parse(mockStore.get(KEY) ?? '[]');
/** Дать отработать цепочкам промисов (hydrate → persist → drain). */
const settle = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  mockStore.clear();
  mockEmitAck.mockReset();
  mockPost.mockReset();
  mockSocket.connected = true;
  mockPendingMessages.clear();
  mockDeliveredSubs.length = 0;
  ro = require('./reactionOutbox');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('reaction outbox', () => {
  it('shows my reaction at once and keeps it until the server confirms', async () => {
    mockSocket.connected = false;
    mockPost.mockRejectedValue(new TypeError('Network request failed'));

    ro.queueMessageReaction('m1', '👍', 'peer', true);
    expect(ro.withPendingReactions([], 'm1', 'me')).toEqual([MINE]);
    await settle();
    expect(ro.withPendingReactions([], 'm1', 'me')).toEqual([MINE]);
    expect(stored()).toMatchObject([{ messageId: 'm1', emoji: '👍', peerId: 'peer', on: true }]);

    const confirmed = jest.fn();
    ro.onReactionsConfirmed(confirmed);
    mockPost.mockResolvedValue({ ok: true, reactions: [MINE] });
    await jest.advanceTimersByTimeAsync(2000);

    expect(mockPost).toHaveBeenLastCalledWith(
      '/api/messages/react',
      { messageId: 'm1', emoji: '👍', with: 'peer', on: true },
      expect.any(Number),
    );
    // По HTTP broadcast до нас не дойдёт — чат получает реакции из ответа.
    expect(confirmed).toHaveBeenCalledWith({ messageId: 'm1', reactions: [MINE] });
    expect(ro.hasPendingReactions('m1')).toBe(false);
    expect(mockStore.has(KEY)).toBe(false);
  });

  it("keeps my queued reaction when the server sends the peer's one", () => {
    mockSocket.connected = false;
    mockPost.mockRejectedValue(new TypeError('Network request failed'));
    ro.queueMessageReaction('m1', '👍', 'peer', true);
    const fromServer = [{ emoji: '❤️', userId: 'peer' }];
    expect(ro.withPendingReactions(fromServer, 'm1', 'me')).toEqual([...fromServer, MINE]);
  });

  it('collapses "add, then remove" made offline into one removal', async () => {
    mockSocket.connected = false;
    mockPost.mockRejectedValue(new TypeError('Network request failed'));
    ro.queueMessageReaction('m1', '👍', 'peer', true);
    ro.queueMessageReaction('m1', '👍', 'peer', false);
    expect(ro.withPendingReactions([MINE], 'm1', 'me')).toEqual([]);
    await settle();

    mockPost.mockReset();
    mockPost.mockResolvedValue({ ok: true, reactions: [] });
    await jest.advanceTimersByTimeAsync(2000);
    expect(mockPost.mock.calls.map((c) => c[1].on)).toEqual([false]);
  });

  it('presses again when an older server toggled the wrong way', async () => {
    mockEmitAck
      .mockResolvedValueOnce({ ok: true, reactions: [] })
      .mockResolvedValueOnce({ ok: true, reactions: [MINE] });
    ro.queueMessageReaction('m1', '👍', 'peer', true);
    await settle();
    expect(mockEmitAck).toHaveBeenCalledTimes(2);
    expect(ro.hasPendingReactions('m1')).toBe(false);
  });

  it('waits until my own queued message reaches the server', async () => {
    mockPendingMessages.add('m1');
    mockEmitAck.mockResolvedValue({ ok: true, reactions: [MINE] });
    ro.queueMessageReaction('m1', '👍', 'peer', true);
    await settle();
    expect(mockEmitAck).not.toHaveBeenCalled();
    expect(ro.withPendingReactions([], 'm1', 'me')).toEqual([MINE]);

    mockPendingMessages.delete('m1');
    for (const cb of mockDeliveredSubs) cb({ to: 'peer', outboxId: 'outbox_1', optimisticUiId: 'm1', serverMessageId: 'm1' });
    await settle();
    expect(mockEmitAck).toHaveBeenCalledTimes(1);
    expect(ro.hasPendingReactions('m1')).toBe(false);
  });

  it('brings queued reactions back after an app restart', async () => {
    mockStore.set(KEY, JSON.stringify([{ messageId: 'm1', emoji: '👍', peerId: 'peer', on: true, createdAt: 1, attempts: 0 }]));
    jest.resetModules();
    ro = require('./reactionOutbox');
    const onChange = jest.fn();
    ro.onReactionOutboxChange(onChange);
    await settle();
    expect(onChange).toHaveBeenCalled();
    expect(ro.withPendingReactions([], 'm1', 'me')).toEqual([MINE]);
  });

  it('gives up on a reaction to a message that no longer exists', async () => {
    mockEmitAck.mockResolvedValue({ ok: false, error: 'message_not_found' });
    ro.queueMessageReaction('m1', '👍', 'peer', true);
    await jest.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 15000 + 1);
    expect(mockEmitAck).toHaveBeenCalledTimes(5);
    expect(ro.hasPendingReactions('m1')).toBe(false);
  });
});
