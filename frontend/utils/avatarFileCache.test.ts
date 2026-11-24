import { searchAvatarFileByKey as files, clearAvatarFileCache } from './avatarFileCache';
import { invalidateAvatarCaches } from './avatarCacheInvalidation';
import { notifyMemoryPressure } from './memoryPressure';
beforeEach(() => jest.useFakeTimers());
afterEach(() => { clearAvatarFileCache(); jest.useRealTimers(); });

it('bounds version locks by count and bytes and removes them while idle', () => {
  for (let i = 0; i < 128; i++) files.set(`friend-${i}_v1`, `file:///avatar-${i}.jpg`);
  files.get('friend-0_v1'); files.set('new_v1', 'file:///new.jpg');
  expect(files.has('friend-0_v1')).toBe(true); expect(files.has('friend-1_v1')).toBe(false);
  files.set('huge_v1', 'file:///' + 'a'.repeat(128 * 1024)); expect(files.has('huge_v1')).toBe(false);
  jest.advanceTimersByTime(30 * 60 * 1000 + 1); expect(files.size).toBe(0);
});

it('invalidates only the requested user and releases all hints on memory pressure', () => {
  files.set('a_v1', 'file:///a.jpg').set('a_v2', 'file:///a2.jpg').set('ab_v1', 'file:///b.jpg');
  invalidateAvatarCaches('a'); expect([...files.keys()]).toEqual(['ab_v1']);
  notifyMemoryPressure(); expect(files.size).toBe(0);
});
