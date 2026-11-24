import { MediaRequestQueue } from './mediaRequestQueue';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('deduplicates work and bounds active and queued native requests', async () => {
  const q = new MediaRequestQueue({ concurrency: 2, maxPending: 3, timeoutMs: 1000 });
  const finishes: Array<(value: string) => void> = [];
  const work = jest.fn(() => new Promise<string>(resolve => finishes.push(resolve)));
  const a = q.run('a', work), b = q.run('b', work), c = q.run('c', work);
  expect(q.run('a', work)).toBe(a); await expect(q.run('d', work)).rejects.toThrow('media_queue_full');
  await flush(); expect(work).toHaveBeenCalledTimes(2); finishes[0]('a'); await flush(); expect(work).toHaveBeenCalledTimes(3);
  finishes[1]('b'); finishes[2]('c'); await expect(Promise.all([a,b,c])).resolves.toEqual(['a','b','c']);
});
it('expires pending consumers but keeps hung native slots occupied and rejects late publication', async () => {
  const q = new MediaRequestQueue({ concurrency: 1, maxPending: 2, timeoutMs: 100 });
  let finish!: (value: string) => void, isCurrent!: () => boolean;
  const a = q.run('a', current => { isCurrent = current; return new Promise(resolve => { finish = resolve; }); });
  const aError = expect(a).rejects.toThrow('media_request_timeout'); await flush();
  jest.advanceTimersByTime(101); await aError; expect(isCurrent()).toBe(false);
  await expect(q.run('a', async () => 'retry')).rejects.toThrow('media_request_busy');
  const work = jest.fn(async () => 'next'); const next = q.run('next', work); await flush(); expect(work).not.toHaveBeenCalled();
  finish('late'); await flush(); expect(await next).toBe('next');
  expect(jest.getTimerCount()).toBe(0);
});

it('releases queued work on clear while keeping the budget of an active native request', async () => {
  const q = new MediaRequestQueue<void>({ concurrency: 1, maxPending: 2, maxCost: 10, timeoutMs: 1000 });
  let finish!: () => void;
  const first = q.run('a', () => new Promise(resolve => { finish = resolve; }), 8);
  const firstError = expect(first).rejects.toThrow('media_request_cleared');
  const queuedWork = jest.fn(async () => {});
  const queued = q.run('b', queuedWork, 2);
  const queuedError = expect(queued).rejects.toThrow('media_request_cleared');
  await flush(); q.clear(); await Promise.all([firstError, queuedError]);
  expect(queuedWork).not.toHaveBeenCalled();
  await expect(q.run('c', async () => {}, 3)).rejects.toThrow('media_queue_full');
  finish(); await flush();
  await expect(q.run('c', async () => {}, 10)).resolves.toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});

it('drops timed-out waiting jobs and never starts more native work behind a hung slot', async () => {
  const q = new MediaRequestQueue({ concurrency: 1, maxPending: 2, timeoutMs: 100 });
  let finish!: (value: string) => void;
  const first = q.run('a', () => new Promise(resolve => { finish = resolve; }));
  const firstError = expect(first).rejects.toThrow('media_request_timeout');
  const work = jest.fn(async () => 'unused');
  const queued = q.run('b', work);
  const queuedError = expect(queued).rejects.toThrow('media_request_timeout');
  await flush(); jest.advanceTimersByTime(101); await Promise.all([firstError, queuedError]);
  finish('late'); await flush();
  expect(work).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
