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
const message = (id: string, text: string, at: number, from = 'peer') => ({
  id, text, timestamp: new Date(at).toISOString(), from, to: from === 'me' ? 'peer' : 'me', type: 'text',
});
beforeEach(() => {
  mockLocal.mockReset(); mockFetch.mockReset(); mockSave.mockClear(); mockCleared.clear();
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
