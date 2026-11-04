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

import { getChatPreviewSnapshot, noteIncomingChatPreview, noteLocalChatPreview, prefetchChatPreviews, selectChatPreviews } from './useChatPreviews';
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

it('never renders old disk history for an unread row while the cold server request is pending', async () => {
  const peer = 'cold-unread';
  mockLocal.mockResolvedValue([message('cold-old', 'old outgoing', 20_000, 'me')]);
  let finish!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = prefetchChatPreviews([peer], 'ru', false, { [peer]: 1 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(getChatPreviewSnapshot()[peer].text).toBe('old outgoing');
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 1 })[peer]).toBeUndefined();
  finish({ ok: true, previews: { [peer]: message('cold-fresh', 'newest incoming', 21_000) } });
  await pending;
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 1 })[peer].text).toBe('newest incoming');
  // An unread delivery invalidates the confirmed row before effects or server work run.
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 2 })[peer]).toBeUndefined();
});

it('does not confirm stale unread text on failed fetch or a changed unread count', async () => {
  const peer = 'offline-unread';
  mockLocal.mockResolvedValue([message('offline-cached', 'old cached', 22_000)]);
  mockFetch.mockRejectedValue(new Error('offline'));
  await prefetchChatPreviews([peer], 'ru', false, { [peer]: 1 });
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 1 })[peer]).toBeUndefined();
  // Ordinary chat rows retain their offline preview.
  expect(selectChatPreviews(getChatPreviewSnapshot(), {})[peer].id).toBe('offline-cached');
  mockFetch.mockResolvedValue({ ok: true, previews: { [peer]: message('fresh-one', 'one unread', 23_000) } });
  await prefetchChatPreviews([peer], 'ru', false, { [peer]: 1 });
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 2 })[peer]).toBeUndefined();
});

it('keeps unread confirmation when a generic prefetch or an older unread request finishes later', async () => {
  const peer = 'overlap-unread';
  mockLocal.mockResolvedValue([]);
  let finishOld!: (value: unknown) => void;
  mockFetch.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const older = prefetchChatPreviews([peer], 'ru', false, { [peer]: 1 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const fresh = message('overlap-new', 'latest unread', 25_000);
  mockFetch.mockResolvedValue({ ok: true, previews: { [peer]: fresh } });
  await prefetchChatPreviews([peer], 'ru', false, { [peer]: 2 });
  await prefetchChatPreviews([peer], 'ru');
  finishOld({ ok: true, previews: { [peer]: message('overlap-old', 'older response', 24_000) } });
  await older;
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 2 })[peer].id).toBe('overlap-new');
});

it('shows a push-delivered message immediately and retains it through a stalled VPN read', async () => {
  const peer = 'push-preview';
  mockLocal.mockResolvedValue([message('old', 'old outgoing', 30_000, 'me')]);
  let finish!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = prefetchChatPreviews([peer], 'ru', false, { [peer]: 1 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  noteIncomingChatPreview(message('push-new', 'from notification', 31_000, peer), 'ru', 1);
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 1 })[peer].text).toBe('from notification');
  // An old request that finishes after the push cannot revoke its confirmation.
  finish({ ok: true, previews: { [peer]: message('old', 'old outgoing', 30_000, 'me') } });
  await pending;
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 1 })[peer].id).toBe('push-new');
});

it('confirms live deliveries without another server request and ignores older replay text', () => {
  const peer = 'live-preview';
  noteIncomingChatPreview(message('live-latest', 'latest live', 40_000, peer), 'ru', 3);
  noteIncomingChatPreview(message('live-replay', 'older replay', 39_000, peer), 'ru', 1);
  expect(selectChatPreviews(getChatPreviewSnapshot(), { [peer]: 3 })[peer].text).toBe('latest live');
  expect(mockFetch).not.toHaveBeenCalled();
  expect(noteIncomingChatPreview({ ...message('foreign', 'wrong account', 41_000, peer), to: 'someone-else' }, 'ru', 1)).toBeNull();
});
