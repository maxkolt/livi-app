const mockWarm = jest.fn();
jest.mock('./imageOptimization', () => ({ warmAndroidAvatarFile: (uri: string) => mockWarm(uri) }));
let calls: typeof import('./callAvatarPrime');
beforeEach(() => {
  jest.useFakeTimers(); jest.resetModules(); mockWarm.mockReset();
  calls = require('./callAvatarPrime');
});
afterEach(() => { calls.clearCallAvatarCache(); jest.useRealTimers(); });
const friend = (id: string, avatar = 'data:image/jpeg;base64,YQ==') => ({ id, name: 'Nick ' + id, avatar });

it('preserves synchronous first-frame avatars/nicks and replaces or removes old data', () => {
  calls.primeCallAvatarsFromFriends([friend('a')]);
  expect(calls.peekCallAvatar('a')).toBe(friend('a').avatar); expect(calls.peekCallNick('a')).toBe('Nick a');
  calls.primeCallAvatarsFromFriends([{ id: 'a', name: 'Renamed', avatarThumbB64: 'Yg==' }]);
  expect(calls.peekCallAvatar('a')).toBe('data:image/jpeg;base64,Yg==');
  expect(calls.peekCallNick('a')).toBe('Renamed');
  calls.primeCallAvatarsFromFriends([{ id: 'a', avatarVer: 0 }]);
  expect(calls.peekCallAvatar('a')).toBeUndefined(); expect(calls.peekCallNick('a')).toBeUndefined();
});

it('bounds both maps by count with LRU eviction', () => {
  calls.primeCallAvatarsFromFriends(Array.from({ length: 128 }, (_, i) => friend(String(i))));
  calls.peekCallAvatar('0'); calls.peekCallNick('0');
  calls.primeCallAvatarsFromFriends([friend('next')]);
  expect(calls.peekCallAvatar('0')).toBeDefined(); expect(calls.peekCallNick('0')).toBe('Nick 0');
  expect(calls.peekCallAvatar('1')).toBeUndefined(); expect(calls.peekCallNick('1')).toBeUndefined();
});

it('bounds base64 strings by bytes and retains nickname hints independently', () => {
  const large = 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024);
  calls.primeCallAvatarsFromFriends([friend('a', large), friend('b', large)]);
  expect(calls.peekCallAvatar('a')).toBeUndefined(); expect(calls.peekCallAvatar('b')).toBe(large);
  expect(calls.peekCallNick('a')).toBe('Nick a');
  calls.primeCallAvatarsFromFriends([friend('huge', large.repeat(3))]);
  expect(calls.peekCallAvatar('huge')).toBeUndefined();
});

it('clears idle hints, pressure caches and per-user invalidation', () => {
  calls.primeCallAvatarsFromFriends([friend('a'), friend('b')]);
  require('./avatarCacheInvalidation').invalidateAvatarCaches('a');
  expect(calls.peekCallAvatar('a')).toBeUndefined(); expect(calls.peekCallNick('b')).toBe('Nick b');
  jest.advanceTimersByTime(15 * 60 * 1000 + 1);
  expect(calls.peekCallAvatar('b')).toBeUndefined(); expect(calls.peekCallNick('b')).toBeUndefined();
  calls.primeCallAvatarsFromFriends([friend('a')]); require('./memoryPressure').notifyMemoryPressure();
  expect(calls.peekCallAvatar('a')).toBeUndefined(); expect(calls.peekCallNick('a')).toBeUndefined();
});
