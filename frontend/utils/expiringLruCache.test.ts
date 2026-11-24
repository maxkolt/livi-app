import { ExpiringLruCache } from './expiringLruCache';
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const cache = () => new ExpiringLruCache<string, string>({ maxEntries: 2, maxCost: 6, ttlMs: 1000, cost: v => v.length });
it('evicts the least recently used entries and refuses an oversized value', () => {
  const c = cache(); c.set('a', 'aaa').set('b', 'bb'); c.get('a'); c.set('c', 'ccc');
  expect([...c.keys()]).toEqual(['a', 'c']); c.set('huge', '1234567'); expect(c.has('huge')).toBe(false);
  c.clear(); expect(jest.getTimerCount()).toBe(0);
});
it('expires idle data without any subsequent reads, keeping one timer', () => {
  const c = cache(); c.set('a', 'a'); jest.advanceTimersByTime(600); c.set('b', 'b');
  expect(jest.getTimerCount()).toBe(1); jest.advanceTimersByTime(401); expect([...c.keys()]).toEqual(['b']);
  jest.advanceTimersByTime(600); expect(c.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
});
it('does not extend freshness when an entry is read or overwritten with an old timestamp', () => {
  const c = new ExpiringLruCache<string, { until: number }>({ maxEntries: 2, maxCost: 2, ttlMs: 1000, cost: () => 1, expiresAt: v => v.until });
  c.set('a', { until: Date.now() + 1000 }); jest.advanceTimersByTime(900); c.get('a'); jest.advanceTimersByTime(101);
  expect(c.size).toBe(0); c.set('old', { until: Date.now() - 1 }); expect(c.size).toBe(0);
});
