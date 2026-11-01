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
  readRateLimitRetryAfterSec: jest.fn(() => null),
  drainMessageOutbox: jest.fn(async () => undefined),
  drainEditOutbox: jest.fn(async () => undefined),
  scheduleMessageOutboxDrain: jest.fn(),
}));
jest.mock('./constants', () => ({ API_BASE: 'https://api.test' }));
// Шифрование здесь не проверяем: сообщения без конверта проходят как есть (см. e2e.test.ts).
jest.mock('./e2e', () => ({
  decryptIncomingMessage: jest.fn(async (m: unknown) => m),
  E2eUnavailableError: class extends Error {},
  invalidateKeysAfterMismatch: jest.fn(),
  onE2eStatus: jest.fn(),
  toWireEditPayload: jest.fn(),
  toWireMessagePayload: jest.fn(async (p: unknown) => p),
}));
jest.mock('./e2eText', () => ({ e2eUndecryptableText: () => 'undecryptable' }));
jest.mock('../../utils/installId', () => ({ getInstallId: jest.fn(async () => 'inst'), getInstallAuthHeaders: jest.fn(async () => ({ 'x-install-id': 'inst' })) }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));


import { fetchChatPreviews } from './messages';
import { emitAck } from './emit';
import { socket } from './socketCore';
import { shared } from './shared';
import { decryptIncomingMessage } from './e2e';
const preview = { id: 'incoming', from: 'peer', to: 'me', type: 'text', text: 'latest', timestamp: '2026-11-01T07:00:00Z' };
const mockHttp = jest.fn();
const originalFetch = global.fetch;
beforeEach(() => {
  jest.useFakeTimers();
  socket.connected = true;
  shared.reconnecting = false;
  global.fetch = mockHttp;
  mockHttp.mockReset().mockResolvedValue({ ok: true, json: async () => ({ ok: true, messages: [preview] }) });
  (emitAck as jest.Mock).mockReset();
});
afterEach(() => { jest.useRealTimers(); global.fetch = originalFetch; });
it('uses the batch socket response on a working connection', async () => {
  (emitAck as jest.Mock).mockResolvedValue({ ok: true, previews: { peer: preview } });
  expect(await fetchChatPreviews(['peer'])).toMatchObject({ ok: true, previews: { peer: preview } });
  expect(mockHttp).not.toHaveBeenCalled();
  expect(decryptIncomingMessage).toHaveBeenCalledWith(preview, expect.any(Function));
});
it('switches to authenticated HTTP after 1.5 seconds when VPN stalls socket acknowledgements', async () => {
  (emitAck as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const pending = fetchChatPreviews(['peer']);
  await jest.advanceTimersByTimeAsync(1500);
  expect(await pending).toMatchObject({ ok: true, previews: { peer: preview } });
  expect(mockHttp).toHaveBeenCalledWith('https://api.test/api/messages?with=peer&limit=1', expect.objectContaining({
    headers: expect.objectContaining({ 'x-install-id': 'inst', 'x-user-id': 'me' }),
  }));
  expect(emitAck).toHaveBeenCalledTimes(1);
  expect(decryptIncomingMessage).toHaveBeenCalledWith(preview, expect.any(Function));
});
it('reads over HTTP immediately when the socket has disconnected', async () => {
  socket.connected = false;
  const response = await fetchChatPreviews(['peer']);
  expect(response.previews?.peer.id).toBe('incoming');
  expect(emitAck).not.toHaveBeenCalled();
});
it('does not manufacture a preview when both transports fail', async () => {
  (emitAck as jest.Mock).mockRejectedValue(new Error('socket offline'));
  mockHttp.mockRejectedValue(new Error('network offline'));
  expect((await fetchChatPreviews(['peer'])).previews).toEqual({});
});
