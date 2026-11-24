import { FliqAmbientCache, type AmbientImage } from './fliqAmbientCache';

function image(width = 2, height = 2) {
  return { width: () => width, height: () => height, dispose: jest.fn() };
}
function deferred() {
  let resolve!: (image: AmbientImage | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AmbientImage | null>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 60; i++) await Promise.resolve(); }
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('deduplicates visible and speculative loads while detaching cancelled subscribers', async () => {
  const task = deferred(), first = jest.fn(), second = jest.fn();
  const load = jest.fn((_url: string, _isCurrent: () => boolean) => task.promise);
  const cache = new FliqAmbientCache({ load });
  cache.prefetch(['same']);
  const cancel = cache.request('same', first);
  cache.request('same', second);
  await flush();
  cancel();
  const result = image(); task.resolve(result); await flush();
  expect(load).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith(result);
  cache.clear();
  expect(result.dispose).not.toHaveBeenCalled(); // A renderer may still own it.
});

it('bounds both native concurrency and the speculative queue', async () => {
  const tasks = Array.from({ length: 20 }, deferred);
  let cursor = 0;
  const load = jest.fn((_url: string) => tasks[cursor++].promise);
  const cache = new FliqAmbientCache({ load });
  cache.prefetch(Array.from({ length: 20 }, (_, i) => `image-${i}`));
  await flush();
  expect(load).toHaveBeenCalledTimes(2);
  for (const task of tasks) task.resolve(image());
  await flush();
  expect(load).toHaveBeenCalledTimes(8);
});

it('expires pending subscribers without inventing free native worker slots', async () => {
  const old = deferred(), fresh = deferred(), first = jest.fn(), second = jest.fn();
  const load = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const cache = new FliqAmbientCache({ load, concurrency: 1, timeoutMs: 100 });
  cache.request('same', first); await flush();
  jest.advanceTimersByTime(100);
  expect(first).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledWith(null);
  cache.request('same', second); await flush();
  expect(load).toHaveBeenCalledTimes(1);
  const stale = image(); old.resolve(stale); await flush();
  expect(stale.dispose).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(2);
  expect(second).not.toHaveBeenCalled();
  const current = image(); fresh.resolve(current); await flush();
  expect(second).toHaveBeenCalledWith(current);
  expect(first).toHaveBeenCalledTimes(1);
});

it('invalidates in-flight generations without deleting a newer request for the same URL', async () => {
  const old = deferred(), fresh = deferred(), listener = jest.fn(), next = jest.fn();
  const load = jest.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const cache = new FliqAmbientCache({ load });
  cache.request('same', listener); await flush();
  const isCurrent = load.mock.calls[0][1] as () => boolean;
  cache.clear();
  expect(isCurrent()).toBe(false);
  expect(listener).toHaveBeenCalledWith(null);
  cache.request('same', next); await flush();
  const stale = image(); old.resolve(stale); await flush();
  expect(stale.dispose).toHaveBeenCalledTimes(1);
  const result = image(); fresh.resolve(result); await flush();
  expect(next).toHaveBeenCalledWith(result);
});

it('evicts by decoded bytes and explicitly disposes only unpublished images', async () => {
  const first = image(2, 2), second = image(3, 2);
  const load = jest.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const cache = new FliqAmbientCache({ load, maxBytes: 32 });
  cache.prefetch(['first']); await flush(); // 16 bytes
  cache.prefetch(['second']); await flush(); // 24 bytes; together exceed 32
  expect(first.dispose).toHaveBeenCalledTimes(1);
  const a = jest.fn(), b = jest.fn();
  cache.request('second', a); cache.request('second', b);
  cache.clear();
  expect(a).toHaveBeenCalledWith(second);
  expect(b).toHaveBeenCalledWith(second);
  expect(second.dispose).not.toHaveBeenCalled();
});

it('refreshes LRU order on a cache hit and also bounds tiny-image entry count', async () => {
  const a = image(), b = image(), c = image();
  const load = jest.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b).mockResolvedValueOnce(c);
  const cache = new FliqAmbientCache({ load, maxEntries: 2 });
  cache.prefetch(['a', 'b']); await flush();
  cache.request('a', jest.fn());
  cache.prefetch(['c']); await flush();
  expect(b.dispose).toHaveBeenCalledTimes(1);
  expect(a.dispose).not.toHaveBeenCalled();
  expect(c.dispose).not.toHaveBeenCalled();
});

it('does not decode a cancelled request and does not retain its callback', async () => {
  const task = deferred(), listener = jest.fn();
  const load = jest.fn((_url: string, _isCurrent: () => boolean) => task.promise);
  const cache = new FliqAmbientCache({ load });
  const cancel = cache.request('a', listener); await flush();
  const isCurrent = load.mock.calls[0][1] as () => boolean;
  cancel();
  expect(isCurrent()).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
  const stale = image(); task.resolve(stale); await flush();
  expect(listener).not.toHaveBeenCalled();
  expect(stale.dispose).toHaveBeenCalledTimes(1);
});

it('completes thrown and rejected loaders once and makes progress afterward', async () => {
  const listener = jest.fn(), result = image();
  const load = jest.fn()
    .mockImplementationOnce(() => { throw Error('setup'); })
    .mockRejectedValueOnce(Error('network'))
    .mockResolvedValueOnce(result);
  const cache = new FliqAmbientCache({ load, concurrency: 1 });
  cache.request('a', listener); await flush();
  cache.request('a', listener); await flush();
  cache.request('a', listener); await flush();
  expect(listener.mock.calls).toEqual([[null], [null], [result]]);
  expect(jest.getTimerCount()).toBe(0);
});

it('rejects oversized and empty images before publishing or caching them', async () => {
  const huge = image(10000, 10000), empty = image(0, 1), listener = jest.fn();
  const load = jest.fn().mockResolvedValueOnce(huge).mockResolvedValueOnce(empty);
  const cache = new FliqAmbientCache({ load });
  cache.request('a', listener); await flush();
  cache.request('a', listener); await flush();
  expect(listener.mock.calls).toEqual([[null], [null]]);
  expect(huge.dispose).toHaveBeenCalledTimes(1);
  expect(empty.dispose).toHaveBeenCalledTimes(1);
});

it('prioritizes the visible image and replaces queued speculation when full', async () => {
  const first = deferred(), load = jest.fn((_url: string) => first.promise);
  const cache = new FliqAmbientCache({ load, concurrency: 1, maxPending: 3 });
  cache.prefetch(['a', 'b', 'c']); await flush();
  cache.request('visible', jest.fn());
  first.resolve(image()); await flush();
  expect(load.mock.calls.map(call => call[0])).toEqual(['a', 'visible', 'c']);
});
