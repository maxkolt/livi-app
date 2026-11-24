const mockStore = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockStore.get(key) ?? null);
const mockKeys = jest.fn(async () => [...mockStore.keys()]);
const mockRemove = jest.fn(async (keys: string[]) => { keys.forEach(key => mockStore.delete(key)); });
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => mockGet(key),
  setItem: async (key: string, value: string) => { mockStore.set(key, value); },
  getAllKeys: () => mockKeys(), multiRemove: (keys: string[]) => mockRemove(keys),
}));
jest.mock('./logger', () => ({ logger: { warn: jest.fn() } }));

let avatars: typeof import('./avatarCache');
beforeEach(() => {
  jest.useFakeTimers(); jest.resetModules(); mockStore.clear();
  mockGet.mockReset().mockImplementation(async key => mockStore.get(key) ?? null);
  mockKeys.mockReset().mockImplementation(async () => [...mockStore.keys()]);
  mockRemove.mockReset().mockImplementation(async keys => { keys.forEach(key => mockStore.delete(key)); });
  avatars = require('./avatarCache');
});
afterEach(() => jest.useRealTimers());

it('keeps the most recently read full avatars and reloads evicted values from disk', async () => {
  for (let i = 0; i < 24; i++) await avatars.putFull('friend-' + i, 1, 'image-' + i);
  expect(avatars.peekFull('friend-0', 1)).toBe('image-0');
  await avatars.putFull('new', 1, 'new-image');
  expect(avatars.peekFull('friend-1', 1)).toBeNull();
  expect(await avatars.getFull('friend-1', 1)).toBe('image-1');
});

it('enforces a byte budget without losing oversized avatars from persistent storage', async () => {
  const image = 'data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024);
  await avatars.putFull('a', 1, image); await avatars.putFull('b', 1, image);
  expect(avatars.peekFull('a', 1)).toBeNull();
  expect(avatars.peekFull('b', 1)).toBe(image);
  const huge = image.repeat(3);
  await avatars.putFull('huge', 1, huge);
  expect(avatars.peekFull('huge', 1)).toBeNull();
  expect(await avatars.getFull('huge', 1)).toBe(huge);
  expect(avatars.peekFull('huge', 1)).toBeNull();
});

it('expires idle RAM entries and releases memory under pressure while preserving disk data', async () => {
  await avatars.putFull('a', 1, 'photo');
  jest.advanceTimersByTime(5 * 60 * 1000 + 1);
  expect(avatars.peekFull('a', 1)).toBeNull();
  expect(await avatars.getFull('a', 1)).toBe('photo');
  require('./memoryPressure').notifyMemoryPressure();
  expect(avatars.peekFull('a', 1)).toBeNull();
  expect(mockStore.get('avatar:a:ver:1')).toBe('photo');
});

it('clears only the requested user from RAM, disk and subscribed file/call caches', async () => {
  const invalidated = jest.fn(); require('./avatarCacheInvalidation').subscribeAvatarCacheInvalidation(invalidated);
  await avatars.putFull('a', 1, 'old'); await avatars.putFull('ab', 1, 'other');
  await avatars.putThumb('a', 1, 'thumb'); mockStore.set('unrelated:avatar:a:ver:1', 'keep');
  await avatars.clearAvatarCacheFor('a');
  expect(avatars.peekFull('a', 1)).toBeNull();
  expect(await avatars.getFull('a', 1)).toBeNull();
  expect(await avatars.getAvatarUri('a', 1, true)).toBeNull();
  expect(avatars.peekFull('ab', 1)).toBe('other');
  expect(mockStore.get('unrelated:avatar:a:ver:1')).toBe('keep');
  expect(invalidated).toHaveBeenCalledWith('a');
});

it('releases RAM and invalidates subscribers even when disk cleanup fails', async () => {
  const invalidated = jest.fn(); require('./avatarCacheInvalidation').subscribeAvatarCacheInvalidation(invalidated);
  await avatars.putFull('a', 1, 'photo'); mockKeys.mockRejectedValueOnce(new Error('storage unavailable'));
  await avatars.clearAvatarCache();
  expect(avatars.peekFull('a', 1)).toBeNull(); expect(invalidated).toHaveBeenCalledWith(undefined);
});

it('does not restore a deleted avatar from a late disk read', async () => {
  let finish!: (value: string) => void;
  mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = avatars.getFull('a', 1);
  await avatars.clearAvatarCacheFor('a'); finish('deleted-photo');
  expect(await read).toBeNull(); expect(avatars.peekFull('a', 1)).toBeNull();
});

it('keeps a fresh write when an older disk read finishes later', async () => {
  let finish!: (value: string) => void;
  mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = avatars.getFull('a', 1);
  await avatars.putFull('a', 1, 'new-photo'); finish('old-photo');
  expect(await read).toBe('new-photo'); expect(avatars.peekFull('a', 1)).toBe('new-photo');
});

it('does not discard another user read when a different avatar is cleared', async () => {
  let finish!: (value: string) => void;
  mockGet.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const read = avatars.getFull('b', 1);
  await avatars.clearAvatarCacheFor('a'); finish('other-photo');
  expect(await read).toBe('other-photo');
});

it('does not read stale storage data while avatar deletion is still pending', async () => {
  await avatars.putFull('a', 1, 'old-photo'); await avatars.putThumb('a', 1, 'old-thumb');
  let finish!: (keys: string[]) => void;
  mockKeys.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const clearing = avatars.clearAvatarCacheFor('a');
  expect(await avatars.getFull('a', 1)).toBeNull();
  expect(await avatars.getAvatarUri('a', 1, true)).toBeNull();
  finish([...mockStore.keys()]); await clearing;
  expect(avatars.peekFull('a', 1)).toBeNull();
});
