/**
 * sendMessage сначала кладёт сообщение в очередь на диске, потом шлёт. Без сети не держит
 * вызывающего минуту на таймаутах: сразу «в очереди», а пузырь с часами уже в чате.
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
const mockSocket = { connected: true, on: jest.fn(), off: jest.fn(), emit: jest.fn() };
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('./emit', () => ({ emitAck: (...args: unknown[]) => mockEmitAck(...args), waitForConnect: jest.fn() }));
jest.mock('./apiHttp', () => ({ postApiJson: (...args: unknown[]) => mockPost(...args) }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
jest.mock('./constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../../utils/installId', () => ({ getInstallId: jest.fn(async () => 'inst') }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('./e2e', () => ({
  decryptIncomingMessage: jest.fn(async (m: unknown) => m),
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: jest.fn(),
  onE2eStatus: jest.fn(),
  toWireEditPayload: jest.fn(),
  toWireMessagePayload: jest.fn(async (p: unknown) => p),
}));
jest.mock('./e2eText', () => ({ e2eUndecryptableText: () => 'undecryptable' }));

import { sendMessage } from './messages';
import { isMessagePendingInOutbox } from './outbox';
import { shared } from './shared';

const UI_ID = '1759300000000-abc1234';

beforeEach(() => {
  mockStore.clear();
  mockEmitAck.mockReset();
  mockPost.mockReset();
  mockSocket.connected = true;
  shared.currentUserId = 'me';
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sendMessage', () => {
  it('returns "queued" within moments when there is no connection, and the bubble shows a clock', async () => {
    jest.useFakeTimers();
    mockSocket.connected = false;
    mockPost.mockRejectedValue(new TypeError('Network request failed'));

    const pending = sendMessage({ to: 'peer', type: 'text', text: 'hi', clientUiMessageId: UI_ID });
    // В том же кадре, что и оптимистичный пузырь.
    expect(isMessagePendingInOutbox(UI_ID)).toBe(true);

    await jest.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toEqual({ ok: true, queued: true, messageId: UI_ID, delivered: false });
    expect(isMessagePendingInOutbox(UI_ID)).toBe(true);
    expect(JSON.parse(mockStore.get('chat_message_outbox_v1')!)).toMatchObject([
      { optimisticUiId: UI_ID, payload: { to: 'peer', text: 'hi', clientMessageId: UI_ID } },
    ]);
  });

  it('returns the server ack when online', async () => {
    mockEmitAck.mockImplementation(async (_e: string, p: any) => ({
      ok: true,
      messageId: p.clientMessageId,
      delivered: true,
      timestamp: 't',
    }));

    const r = await sendMessage({ to: 'peer', type: 'text', text: 'hi', clientUiMessageId: UI_ID });

    expect(r).toEqual({ ok: true, messageId: UI_ID, delivered: true, timestamp: 't' });
    expect(isMessagePendingInOutbox(UI_ID)).toBe(false);
    expect(mockStore.has('chat_message_outbox_v1')).toBe(false);
  });

  it('gives every message an id the server can deduplicate retries by', async () => {
    mockEmitAck.mockImplementation(async (_e: string, p: any) => ({ ok: true, messageId: p.clientMessageId }));
    const r = await sendMessage({ to: 'peer', type: 'text', text: 'forwarded' });
    expect(r.messageId).toMatch(/^\d{10,}-[a-z0-9]+$/);
    expect(mockEmitAck.mock.calls[0][1]).toMatchObject({ clientMessageId: r.messageId, clientId: r.messageId });
  });

  it('reports a permanent refusal as an error', async () => {
    mockEmitAck.mockResolvedValue({ ok: false, error: 'not_friends' });
    await expect(sendMessage({ to: 'peer', type: 'text', text: 'hi', clientUiMessageId: UI_ID })).resolves.toEqual({
      ok: false,
      error: 'not_friends',
    });
  });
});
