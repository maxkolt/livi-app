let mockMe = 'me';
const mockRead = jest.fn();
const mockAck = jest.fn(async (_json: string) => true);
const mockPreviews = jest.fn();
const mockCounts = jest.fn();
jest.mock('react-native', () => ({
  Platform: { OS: 'android' }, NativeModules: { LiviAppModule: {
    getPendingUnreadMessageEventsJson: () => mockRead(),
    acknowledgePendingUnreadMessageEvents: (json: string) => mockAck(json),
  } },
}));
jest.mock('../sockets/socket', () => ({
  getCurrentUserId: () => mockMe,
  fetchChatPreviews: (...args: unknown[]) => mockPreviews(...args),
  getUnreadCounts: (...args: unknown[]) => mockCounts(...args),
  isMessagePendingInOutbox: () => false,
}));
jest.mock('../screens/home/chatClearedForMe', () => ({ unmarkChatsClearedForMe: async () => {} }));
jest.mock('../utils/globalEvents', () => ({}));
jest.mock('./i18n', () => ({ t: (key: string) => key }));
jest.mock('../screens/chat/chatMessageMeta', () => ({ getChatReplyPreviewText: (m: { text?: string }) => m.text || '' }));
jest.mock('../sockets/modules/e2e', () => ({ decryptIncomingMessage: jest.fn(async m => {
  if (!m.enc) return m;
  const { enc: _enc, ...plain } = m;
  return { ...plain, text: 'locally decrypted' };
}) }));
jest.mock('../sockets/modules/e2eText', () => ({ e2eUndecryptableText: () => 'locked' }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));
import { readPendingUnreadMessages } from './pendingUnreadMessages';
import { getChatPreviewSnapshot, selectChatPreviews } from '../screens/home/hooks/useChatPreviews';
import { decryptIncomingMessage } from '../sockets/modules/e2e';

const event = (from: string, count = 3) => ({
  from, to: 'me', messageId: `${from}-latest`, sentAt: '2026-11-04T17:00:00.000Z',
  messagePreview: 'latest from push', unreadFromSender: count, unreadCount: 99, unreadUpdatedAt: 1234,
});
beforeEach(() => {
  mockMe = 'me'; mockRead.mockReset(); mockAck.mockClear();
  mockPreviews.mockReset(); mockCounts.mockReset();
});
it('hydrates the text and per-chat count together without network access, including multiple senders', async () => {
  mockRead.mockResolvedValue(JSON.stringify([event('push-peer', 3), event('other-peer', 2)]));
  const pending = await readPendingUnreadMessages('ru');
  expect(pending.map(p => p.count)).toEqual([3, 2]);
  const visible = selectChatPreviews(getChatPreviewSnapshot(), { 'push-peer': 3, 'other-peer': 2 });
  expect(visible['push-peer'].text).toBe('latest from push');
  expect(visible['other-peer'].id).toBe('other-peer-latest');
  expect(mockPreviews).not.toHaveBeenCalled(); expect(mockCounts).not.toHaveBeenCalled();
  expect(mockAck).toHaveBeenCalledTimes(1);
});
it('decrypts an encrypted push locally before acknowledging it', async () => {
  mockRead.mockResolvedValue(JSON.stringify([{ ...event('encrypted-peer'), messagePreview: '', enc: '{"c":"ciphertext"}' }]));
  await readPendingUnreadMessages('ru');
  expect(decryptIncomingMessage).toHaveBeenCalledWith(expect.objectContaining({ enc: { c: 'ciphertext' } }), expect.any(Function));
  expect(selectChatPreviews(getChatPreviewSnapshot(), { 'encrypted-peer': 3 })['encrypted-peer'].text).toBe('locally decrypted');
  expect(mockPreviews).not.toHaveBeenCalled();
});
it('replaces a legacy sender marker with its complete snapshot without starting a network read', async () => {
  mockRead.mockResolvedValue(JSON.stringify([{ from: 'migrated-peer' }, event('migrated-peer', 5)]));
  expect(await readPendingUnreadMessages('ru')).toEqual([
    expect.objectContaining({ peerId: 'migrated-peer', count: 5 }),
  ]);
  expect(mockPreviews).not.toHaveBeenCalled(); expect(mockCounts).not.toHaveBeenCalled();
  expect(selectChatPreviews(getChatPreviewSnapshot(), { 'migrated-peer': 5 })['migrated-peer'].text).toBe('latest from push');
});
it('waits for both text and exact count for a legacy push and shares a cold-start/resume import', async () => {
  mockRead.mockResolvedValue(JSON.stringify([{ from: 'legacy-peer' }]));
  let finish!: (value: unknown) => void;
  mockPreviews.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mockCounts.mockResolvedValue({ ok: true, counts: { 'legacy-peer': 4 } });
  const pending = readPendingUnreadMessages('ru');
  expect(readPendingUnreadMessages('ru')).toBe(pending);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(mockAck).not.toHaveBeenCalled();
  finish({ ok: true, previews: { 'legacy-peer': {
    id: 'fetched-latest', from: 'legacy-peer', to: 'me', type: 'text', text: 'server text', timestamp: event('x').sentAt,
  } } });
  expect((await pending)[0].count).toBe(4);
  expect(selectChatPreviews(getChatPreviewSnapshot(), { 'legacy-peer': 4 })['legacy-peer'].text).toBe('server text');
  expect(mockRead).toHaveBeenCalledTimes(1);
});
it('retains an incomplete offline push for retry and excludes notifications for another account', async () => {
  mockRead.mockResolvedValue(JSON.stringify([{ from: 'offline-peer' }, { ...event('foreign-peer'), to: 'someone-else' }]));
  mockCounts.mockRejectedValue(new Error('VPN offline')); mockPreviews.mockRejectedValue(new Error('VPN offline'));
  expect(await readPendingUnreadMessages('ru')).toEqual([{ peerId: 'offline-peer', count: undefined }]);
  expect(mockAck).not.toHaveBeenCalled();
  expect(selectChatPreviews(getChatPreviewSnapshot(), { 'offline-peer': 1 })['offline-peer']).toBeUndefined();
});
