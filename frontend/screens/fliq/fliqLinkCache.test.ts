const mockGet = jest.fn();
const mockSet = jest.fn(async (_key: string, _value: string) => {});
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => mockGet(key), setItem: (key: string, value: string) => mockSet(key, value),
}));

let links: typeof import('./fliqLinks');
let fetchMock: jest.Mock;
const originalFetch = global.fetch;
const video = (i: number): import('./fliqLinks').FliqLink => ({
  source: 'youtube', id: String(i).padStart(11, '0'), url: `https://youtu.be/${String(i).padStart(11, '0')}`,
});
const short = (i: number): import('./fliqLinks').FliqLink => ({ source: 'tiktok', id: '', short: true, url: `https://vm.tiktok.com/QA${i}/` });
const fullUrl = 'https://www.tiktok.com/@qa/video/7300000000000000000';
const response = (title = 'Title') => ({ ok: true, json: async () => ({ title, author_name: 'Author', thumbnail_url: 'https://image.test/preview' }) });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers(); jest.resetModules(); mockGet.mockReset().mockResolvedValue(null); mockSet.mockClear();
  fetchMock = jest.fn().mockResolvedValue(response()); global.fetch = fetchMock;
  links = require('./fliqLinks');
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); global.fetch = originalFetch; });

it('shares metadata reads and evicts the least recently used result after 128 videos', async () => {
  const first = links.fetchFliqMeta(video(0)); expect(links.fetchFliqMeta(video(0))).toBe(first); await first;
  for (let i = 1; i < 128; i++) await links.fetchFliqMeta(video(i));
  links.peekFliqMeta(video(0)); await links.fetchFliqMeta(video(128));
  expect(links.peekFliqMeta(video(0))?.title).toBe('Title');
  expect(links.peekFliqMeta(video(1))).toBeUndefined();
  expect(links.peekFliqMeta(video(128))?.author).toBe('Author');
});

it('enforces the metadata byte budget without truncating results shown by the card', async () => {
  const large = 'A'.repeat(150_000); fetchMock.mockResolvedValue(response(large));
  await links.fetchFliqMeta(video(0)); await links.fetchFliqMeta(video(1));
  expect(links.peekFliqMeta(video(0))).toBeUndefined(); expect(links.peekFliqMeta(video(1))?.title).toBe(large);
  const huge = large.repeat(2); fetchMock.mockResolvedValue(response(huge)); mockSet.mockClear();
  expect((await links.fetchFliqMeta(video(2))).title).toBe(huge);
  expect(links.peekFliqMeta(video(2))).toBeUndefined(); expect(mockSet).not.toHaveBeenCalled();
});

it('expires RAM while idle and restores valid metadata from disk without a network read', async () => {
  const link = video(1); await links.fetchFliqMeta(link);
  const saved = mockSet.mock.calls[0][1]; mockGet.mockResolvedValue(saved);
  await jest.advanceTimersByTimeAsync(30 * 60_000 + 1);
  expect(links.peekFliqMeta(link)).toBeUndefined();
  expect((await links.fetchFliqMeta(link)).title).toBe('Title'); expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not extend a TikTok signed preview lifetime when disk metadata enters RAM', async () => {
  const link = { source: 'tiktok' as const, id: '7300000000000000000', url: fullUrl };
  mockGet.mockResolvedValue(JSON.stringify({ at: Date.now() - 12 * 3_600_000 + 1000, meta: { title: 'Old', thumb: 'https://old.test/signed' } }));
  expect((await links.fetchFliqMeta(link)).title).toBe('Old'); expect(fetchMock).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1001); expect(links.peekFliqMeta(link)).toBeUndefined();
  expect((await links.fetchFliqMeta(link)).title).toBe('Title'); expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('retries an unsuccessful metadata read after a short TTL rather than caching failure for the session', async () => {
  fetchMock.mockRejectedValueOnce(new Error('offline'));
  expect((await links.fetchFliqMeta(video(1))).thumb).toContain('hqdefault.jpg');
  await jest.advanceTimersByTimeAsync(30_001);
  expect((await links.fetchFliqMeta(video(1))).title).toBe('Title'); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('bounds metadata requests including hung native fetch and ignores a late body', async () => {
  const finishes: Array<(value: ReturnType<typeof response>) => void> = [];
  fetchMock.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
  const pending = Array.from({ length: 100 }, (_, i) => links.fetchFliqMeta(video(i)));
  const results = Promise.allSettled(pending); await flush();
  expect(fetchMock).toHaveBeenCalledTimes(4); expect(mockGet).toHaveBeenCalledTimes(4);
  jest.advanceTimersByTime(15_001); const settled = await results;
  expect(settled.every(result => result.status === 'rejected')).toBe(true);
  expect(fetchMock.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  await expect(links.fetchFliqMeta(video(0))).rejects.toThrow('media_request_busy');
  finishes.forEach(finish => finish(response('Late'))); await flush();
  expect(links.peekFliqMeta(video(0))).toBeUndefined(); expect(mockSet).not.toHaveBeenCalled();
  fetchMock.mockResolvedValue(response('Fresh'));
  expect((await links.fetchFliqMeta(video(0))).title).toBe('Fresh');
});

it('bounds a stalled response.json as well as fetch and does not publish its late data', async () => {
  let finish!: (value: { title: string }) => void;
  fetchMock.mockResolvedValue({ ok: true, json: () => new Promise(resolve => { finish = resolve; }) });
  const pending = links.fetchFliqMeta(video(0)); const timeout = expect(pending).rejects.toThrow('media_request_timeout');
  await flush(); jest.advanceTimersByTime(15_001); await timeout;
  finish({ title: 'Late body' }); await flush(); expect(links.peekFliqMeta(video(0))).toBeUndefined();
  expect(mockSet).not.toHaveBeenCalled();
});

it('clears optional metadata on pressure without dropping mounted consumers or repopulating RAM late', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = links.fetchFliqMeta(video(1)); await flush();
  require('../../utils/memoryPressure').notifyMemoryPressure();
  finish(response()); expect((await pending).title).toBe('Title'); expect(links.peekFliqMeta(video(1))).toBeUndefined();
});

it('shares redirects, bounds cached short links and expires unsuccessful resolutions', async () => {
  fetchMock.mockResolvedValue({ url: fullUrl });
  await Promise.all([links.resolveFliqLink(short(0)), links.resolveFliqLink(short(0))]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  for (let i = 1; i < 129; i++) await links.resolveFliqLink(short(i));
  await links.resolveFliqLink(short(128)); expect(fetchMock).toHaveBeenCalledTimes(129);
  await links.resolveFliqLink(short(0)); expect(fetchMock).toHaveBeenCalledTimes(130);
  fetchMock.mockResolvedValueOnce({ url: 'https://example.test/unavailable' });
  expect(await links.resolveFliqLink(short(1000))).toBeNull();
  expect(await links.resolveFliqLink(short(1000))).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(131);
  jest.advanceTimersByTime(30_001);
  expect((await links.resolveFliqLink(short(1000)))?.id).toBe('7300000000000000000');
});

it('bounds redirect waiters and active requests when abort does not settle fetch', async () => {
  const finishes: Array<(value: { url: string }) => void> = [];
  fetchMock.mockImplementation(() => new Promise(resolve => finishes.push(resolve)));
  const pending = Promise.all(Array.from({ length: 100 }, (_, i) => links.resolveFliqLink(short(i)))); await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(15_001); expect((await pending).every(value => value === null)).toBe(true);
  finishes.forEach(finish => finish({ url: fullUrl })); await flush();
  fetchMock.mockResolvedValue({ url: fullUrl });
  expect((await links.resolveFliqLink(short(0)))?.id).toBe('7300000000000000000');
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
