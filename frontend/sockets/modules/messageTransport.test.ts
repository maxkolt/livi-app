import { sendWithHttpFallback } from './messageTransport';

const ok = { ok: true, messageId: 'same-id' };
const pending = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('uses a healthy socket without an HTTP request or leftover timers', async () => {
  const http = jest.fn();
  await expect(sendWithHttpFallback(async () => ok, http, new AbortController().signal))
    .resolves.toEqual({ resp: ok, usedHttp: false });
  await jest.advanceTimersByTimeAsync(9000);
  expect(http).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('bypasses a silent socket or reauth in 1.2 seconds and ignores its late result', async () => {
  const socket = pending<typeof ok>();
  const http = jest.fn(async () => ok);
  const result = sendWithHttpFallback(() => socket.promise, http, new AbortController().signal);
  await jest.advanceTimersByTimeAsync(1199);
  expect(http).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({ resp: ok, usedHttp: true });
  socket.resolve({ ok: false, messageId: 'late-error' });
  await jest.advanceTimersByTimeAsync(20_000);
  expect(http).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('accepts a late socket success when HTTP fails, without losing the message', async () => {
  const socket = pending<typeof ok>();
  const result = sendWithHttpFallback(() => socket.promise, async () => { throw new Error('HTTP blocked'); }, new AbortController().signal);
  await jest.advanceTimersByTimeAsync(1200);
  socket.resolve(ok);
  await expect(result).resolves.toEqual({ resp: ok, usedHttp: false });
});

it('prefers success when a concurrent request is rate limited', async () => {
  const socket = pending<{ ok: boolean; error?: string }>();
  const http = pending<typeof ok>();
  const result = sendWithHttpFallback(() => socket.promise, () => http.promise, new AbortController().signal);
  await jest.advanceTimersByTimeAsync(1200);
  socket.resolve({ ok: false, error: 'rate_limited' });
  http.resolve(ok);
  await expect(result).resolves.toEqual({ resp: ok, usedHttp: true });
});

it('returns an immediate authoritative rejection without retrying it over HTTP', async () => {
  const http = jest.fn();
  const resp = { ok: false, error: 'not_friends' };
  await expect(sendWithHttpFallback(async () => resp, http, new AbortController().signal))
    .resolves.toEqual({ resp, usedHttp: false });
  expect(http).not.toHaveBeenCalled();
});

it('cancels the old route promptly even when its socket never settles', async () => {
  const controller = new AbortController();
  let socketSignal!: AbortSignal;
  let httpSignal!: AbortSignal;
  const result = sendWithHttpFallback((signal) => { socketSignal = signal; return new Promise<typeof ok>(() => {}); },
    (signal) => { httpSignal = signal; return new Promise<typeof ok>(() => {}); }, controller.signal);
  const rejected = expect(result).rejects.toThrow('transport unavailable');
  await jest.advanceTimersByTimeAsync(1200);
  controller.abort();
  await rejected;
  expect(socketSignal.aborted).toBe(true);
  expect(httpSignal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

it('bounds a stuck socket even if HTTP also fails', async () => {
  const result = sendWithHttpFallback(() => new Promise<typeof ok>(() => {}), async () => { throw new Error('offline'); }, new AbortController().signal);
  const rejected = expect(result).rejects.toThrow('transport unavailable');
  await jest.advanceTimersByTimeAsync(8000);
  await rejected;
  expect(jest.getTimerCount()).toBe(0);
});
