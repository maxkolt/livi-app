const mockStorage = { getItem: jest.fn(), setItem: jest.fn() };
const mockFetch = jest.fn();
const mockRespond = jest.fn();
let mockOwner = '111111111111111111111111';
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: mockStorage }));
jest.mock('../sockets/socket', () => ({
  getCurrentUserId: () => mockOwner,
  fetchFriendRequests: () => mockFetch(),
  respondFriend: (...args: unknown[]) => mockRespond(...args),
  checkInviteLink: jest.fn(), onFriendAccepted: jest.fn(), onFriendAdded: jest.fn(),
  onFriendDeclined: jest.fn(), onFriendRequest: jest.fn(),
}));
jest.mock('../utils/logger', () => ({ logger: { warn: jest.fn() } }));
import {
  useFriendRequests, refreshFriendRequests, upsertFriendRequest,
  acceptFriendRequest, declineFriendRequest,
} from './friendRequests';

const fake = '0000000000000000000000de';
const real = '222222222222222222222222';
const item = (id: string) => ({ id, nick: 'A real request', avatarVer: 0, avatarThumbB64: '', online: true });
beforeEach(() => {
  mockOwner = '111111111111111111111111';
  mockStorage.getItem.mockReset().mockResolvedValue(null);
  mockStorage.setItem.mockReset().mockResolvedValue(undefined);
  mockFetch.mockReset().mockResolvedValue({ ok: true, list: [] });
  mockRespond.mockReset().mockResolvedValue({ ok: true });
  useFriendRequests.setState({ ownerId: null, items: [], busy: {} });
});

it('keeps an empty server list empty across account initialization and refreshes', async () => {
  await refreshFriendRequests();
  await refreshFriendRequests();
  expect(useFriendRequests.getState().items).toEqual([]);
  useFriendRequests.setState({ ownerId: null, items: [], busy: {} });
  await refreshFriendRequests();
  expect(useFriendRequests.getState().items).toEqual([]);
});
it('drops an old test fixture from offline cache without losing a real request', async () => {
  mockStorage.getItem.mockResolvedValue(JSON.stringify([item(fake), item(real)]));
  mockFetch.mockRejectedValue(Error('offline'));
  await refreshFriendRequests();
  expect(useFriendRequests.getState().items).toEqual([item(real)]);
});
it('rejects the old fixture from realtime updates and server snapshots', async () => {
  await upsertFriendRequest(item(fake));
  expect(useFriendRequests.getState().items).toEqual([]);
  mockFetch.mockResolvedValue({ ok: true, list: [
    { _id: fake, nick: 'Legacy test' }, { _id: real, nick: 'Real person', online: true },
  ] });
  await refreshFriendRequests();
  expect(useFriendRequests.getState().items.map(row => row.id)).toEqual([real]);
  expect(JSON.parse(mockStorage.setItem.mock.calls.at(-1)![1])).toEqual([
    expect.objectContaining({ id: real, nick: 'Real person' }),
  ]);
});
it.each([acceptFriendRequest, declineFriendRequest])('never submits a response for the old synthetic account', async respond => {
  expect(await respond(fake)).toBe(false);
  expect(mockRespond).not.toHaveBeenCalled();
});
it('still accepts a real request and removes its cached row', async () => {
  await upsertFriendRequest(item(real));
  expect(await acceptFriendRequest(real)).toBe(true);
  expect(mockRespond).toHaveBeenCalledWith(real, true);
  expect(useFriendRequests.getState().items).toEqual([]);
  expect(useFriendRequests.getState().busy).toEqual({});
});
