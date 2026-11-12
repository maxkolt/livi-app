import { UserFrameRefresh } from './userFrameRefresh';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
let refresh: UserFrameRefresh;
let load: jest.Mock;
let publish: jest.Mock;
beforeEach(() => {
  jest.useFakeTimers(); load = jest.fn(); publish = jest.fn();
  refresh = new UserFrameRefresh({ load, publish });
});
afterEach(() => { refresh.stop(); jest.clearAllTimers(); jest.useRealTimers(); });

it('retries a failed first VPN read without a remount and shares simultaneous reads', async () => {
  load.mockRejectedValueOnce(new Error('VPN route switching')).mockResolvedValue('fire');
  const first = refresh.refresh();
  expect(refresh.refresh()).toBe(first);
  await first;
  expect(publish).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledWith('fire');
});

it('bounds a hung response body even when abort does not reject native fetch', async () => {
  let finish!: (frame: string) => void;
  load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('diamond');
  void refresh.refresh(); await flush();
  const signal = load.mock.calls[0][0] as AbortSignal;
  await jest.advanceTimersByTimeAsync(11_000);
  expect(signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledWith('diamond');
  finish(''); await flush();
  expect(publish).not.toHaveBeenCalledWith('');
});

it('abandons the old route and ignores its late response after a VPN change', async () => {
  let finish!: (frame: string) => void;
  load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('frost');
  void refresh.refresh(); await flush();
  refresh.networkChanged();
  await jest.advanceTimersByTimeAsync(400);
  expect(publish).toHaveBeenCalledWith('frost');
  finish('fire'); await flush();
  expect(publish).not.toHaveBeenCalledWith('fire');
});

it('does not replace a newer socket frame with an older HTTP response', async () => {
  let finish!: (frame: string) => void;
  load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  void refresh.refresh(); await flush();
  refresh.received();
  finish(''); await flush();
  expect(publish).not.toHaveBeenCalled();
});

it('keeps the last frame on errors, but accepts an authoritative removal', async () => {
  load.mockResolvedValueOnce('fire').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('');
  await refresh.refresh(); await refresh.refresh(true);
  expect(publish.mock.calls).toEqual([['fire']]);
  await jest.advanceTimersByTimeAsync(1000);
  expect(publish.mock.calls).toEqual([['fire'], ['']]);
});

it('rechecks mounted frames and cancels retries and late results after unmount', async () => {
  load.mockResolvedValue(null);
  await refresh.refresh();
  expect(publish).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
  load.mockRejectedValue(new Error('offline'));
  await refresh.refresh(true); refresh.stop();
  await jest.advanceTimersByTimeAsync(300_000);
  expect(load).toHaveBeenCalledTimes(3);
});
