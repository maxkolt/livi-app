const mockLocal = jest.fn();
const mockFetch = jest.fn();
const mockSave = jest.fn<Promise<boolean>, unknown[]>().mockResolvedValue(true);
const mockCleared = new Set<string>();
jest.mock('../../../sockets/socket', () => ({
  getCurrentUserId: () => 'me',
  getChatMessagesLocal: (...args: unknown[]) => mockLocal(...args),
  fetchChatPreviews: (...args: unknown[]) => mockFetch(...args),
  globalMessageStorage: { saveMessage: (...args: unknown[]) => mockSave(...args) },
  isMessagePendingInOutbox: () => false,
}));
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(async () => null) }));
jest.mock('../chatClearedForMe', () => ({
  getClearedForMePeerIds: async () => mockCleared,
  unmarkChatsClearedForMe: jest.fn(async () => {}),
}));
jest.mock('../../chat/chatMessageMeta', () => ({
  getChatReplyPreviewText: (message: { text?: string }) => message.text || '',
}));
jest.mock('../../../utils/i18n', () => ({ t: (key: string) => key }));
jest.mock('../../../utils/globalEvents', () => ({}));

import { getChatPreviewSnapshot, noteLocalChatPreview, prefetchChatPreviews } from './useChatPreviews';
import { beginChatExitTransition, finishChatExitTransition } from '../../chat/chatExitTransition';
const message = (id: string, text: string, at: number, from = 'peer') => ({
  id, text, timestamp: new Date(at).toISOString(), from, to: from === 'me' ? 'peer' : 'me', type: 'text',
});
beforeEach(() => {
  mockLocal.mockReset(); mockFetch.mockReset(); mockSave.mockClear(); mockCleared.clear();
});
afterEach(() => { finishChatExitTransition(); jest.useRealTimers(); });

it('keeps the live preview visible and postpones all heavy reload work during Back', async () => {
  noteLocalChatPreview('return-peer', message('return-new', 'already visible', 10_000), 'ru');
  beginChatExitTransition();
  mockFetch.mockResolvedValue({ ok: true, previews: { 'return-peer': message('server-latest', 'fresh from server', 11_000) } });
  const pending = prefetchChatPreviews(['return-peer'], 'ru', true);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(getChatPreviewSnapshot()['return-peer'].text).toBe('already visible');
  expect(mockLocal).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
  finishChatExitTransition();
  await pending;
  expect(mockLocal).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledWith(['return-peer']);
  expect(getChatPreviewSnapshot()['return-peer'].text).toBe('fresh from server');
});

it('reads history only for missing previews and still checks every contact on the server', async () => {
  noteLocalChatPreview('known-peer', message('known', 'cached live', 12_000), 'ru');
  mockLocal.mockResolvedValue([message('missing', 'local fallback', 13_000)]);
  mockFetch.mockRejectedValue(new Error('VPN timeout'));
  await prefetchChatPreviews(['known-peer', 'missing-peer'], 'ru', true);
  expect(mockLocal).toHaveBeenCalledTimes(1);
  expect(mockLocal).toHaveBeenCalledWith('missing-peer');
  expect(mockFetch).toHaveBeenCalledWith(['known-peer', 'missing-peer']);
  expect(getChatPreviewSnapshot()['known-peer'].text).toBe('cached live');
  expect(getChatPreviewSnapshot()['missing-peer'].text).toBe('local fallback');
});

it('holds an already running server response if Back begins before it completes', async () => {
  noteLocalChatPreview('inflight-peer', message('before', 'visible before Back', 14_000), 'ru');
  let finish!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = prefetchChatPreviews(['inflight-peer'], 'ru', true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  beginChatExitTransition();
  finish({ ok: true, previews: { 'inflight-peer': message('after', 'server after Back', 15_000) } });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(getChatPreviewSnapshot()['inflight-peer'].text).toBe('visible before Back');
  expect(mockSave).not.toHaveBeenCalled();
  finishChatExitTransition();
  await pending;
  expect(getChatPreviewSnapshot()['inflight-peer'].text).toBe('server after Back');
});

it('replaces an existing outgoing preview with the latest unread incoming message', async () => {
  mockLocal.mockResolvedValue([message('old', 'old outgoing', 1000, 'me')]);
  mockFetch.mockResolvedValue({ ok: true, previews: { peer: message('new', 'latest unread', 2000) } });
  await prefetchChatPreviews(['peer'], 'ru');
  expect(mockFetch).toHaveBeenCalledWith(['peer']);
  expect(getChatPreviewSnapshot().peer).toEqual({ id: 'new', text: 'latest unread', at: 2000 });
  expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }), 'me');
});
it('shows local history while the VPN/server response is delayed and then updates it', async () => {
  mockLocal.mockResolvedValue([message('cached', 'cached text', 3000, 'me')]);
  let resolve!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = prefetchChatPreviews(['peer'], 'ru');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(getChatPreviewSnapshot().peer.text).toBe('cached text');
  resolve({ ok: true, previews: { peer: message('vpn', 'arrived through VPN', 4000) } });
  await pending;
  expect(getChatPreviewSnapshot().peer.text).toBe('arrived through VPN');
});
it('keeps a newer live message when an older server request finishes later', async () => {
  mockLocal.mockResolvedValue([message('local', 'local', 5000)]);
  mockFetch.mockImplementation(async () => {
    noteLocalChatPreview('peer', message('live', 'live latest', 7000), 'ru');
    return { ok: true, previews: { peer: message('server-old', 'older server response', 6000) } };
  });
  await prefetchChatPreviews(['peer'], 'ru');
  expect(getChatPreviewSnapshot().peer.id).toBe('live');
});
it('keeps a newer pending outgoing message and preserves local previews on network failure', async () => {
  mockLocal.mockResolvedValue([message('pending', 'offline outgoing', 9000, 'me')]);
  mockFetch.mockResolvedValue({ ok: true, previews: { peer: message('older', 'older incoming', 8000) } });
  await prefetchChatPreviews(['peer'], 'ru');
  expect(getChatPreviewSnapshot().peer.id).toBe('pending');
  mockFetch.mockRejectedValue(new Error('offline'));
  await prefetchChatPreviews(['peer'], 'ru');
  expect(getChatPreviewSnapshot().peer.id).toBe('pending');
});
it('does not resurrect a chat cleared locally', async () => {
  mockLocal.mockResolvedValue([]);
  mockCleared.add('cleared');
  await prefetchChatPreviews(['cleared'], 'ru');
  expect(mockFetch).not.toHaveBeenCalled();
  expect(getChatPreviewSnapshot().cleared).toBeUndefined();
});
it('refreshes more than 100 contacts in bounded batches', async () => {
  mockLocal.mockResolvedValue([]);
  mockFetch.mockResolvedValue({ ok: true, previews: {} });
  await prefetchChatPreviews(Array.from({ length: 205 }, (_, i) => `peer-${i}`), 'ru');
  expect(mockFetch.mock.calls.map(args => args[0].length)).toEqual([100, 100, 5]);
});
