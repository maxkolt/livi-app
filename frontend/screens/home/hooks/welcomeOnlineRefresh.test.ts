import { WelcomeOnlineRefresh } from './welcomeOnlineRefresh';

const snapshot = { ok: true, epoch: 'server', revision: 1, list: ['me', 'peer'] };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let instances: WelcomeOnlineRefresh[];
function setup() {
  const load = jest.fn<Promise<typeof snapshot | null>, [AbortSignal]>();
  const publish = jest.fn();
  const syncSocket = jest.fn();
  const shouldDefer = jest.fn(() => false);
  const controller = new WelcomeOnlineRefresh({ load, publish, syncSocket, shouldDefer });
  instances.push(controller);
  return { controller, load, publish, syncSocket, shouldDefer };
}
beforeEach(() => { jest.useFakeTimers(); instances = []; });
afterEach(() => { instances.forEach(c => c.stop()); jest.useRealTimers(); });

it('retries a failed first VPN read in one second instead of leaving the count unknown for two minutes', async () => {
  const { controller, load, publish, syncSocket } = setup();
  load.mockRejectedValueOnce(new Error('VPN route unavailable')).mockResolvedValueOnce(snapshot);
  await controller.refresh();
  expect(publish).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1000);
  expect(load).toHaveBeenCalledTimes(2);
  expect(syncSocket).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledWith(snapshot);
});

it('bounds a request even if native fetch/body ignores abort and replaces it on a new VPN route', async () => {
  const { controller, load, publish } = setup();
  let finishOld!: (data: typeof snapshot) => void;
  load.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const old = controller.refresh(); await flush();
  const oldSignal = load.mock.calls[0][0];
  controller.networkChanged();
  expect(oldSignal.aborted).toBe(true);
  await old;
  load.mockResolvedValueOnce({ ...snapshot, revision: 2, list: ['me', 'new-peer'] });
  await jest.advanceTimersByTimeAsync(400);
  finishOld(snapshot); await flush();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }));
});

it('times out a hanging response body, coalesces concurrent refreshes and retries', async () => {
  const { controller, load, publish } = setup();
  load.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(snapshot);
  const pending = controller.refresh();
  expect(controller.refresh()).toBe(pending);
  await jest.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(load.mock.calls[0][0].aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledWith(snapshot);
});

it('accepts a socket snapshot immediately during a UI transition and cancels the stale HTTP read', async () => {
  const { controller, load, publish, shouldDefer } = setup();
  let finish!: (data: typeof snapshot) => void;
  load.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = controller.refresh(); await flush();
  shouldDefer.mockReturnValue(true);
  controller.receive({ ...snapshot, revision: 3, list: [] });
  await pending;
  finish(snapshot); await flush();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ list: [] }));
});

it('resumes a deferred refresh without waiting for another connect/resume event', async () => {
  const { controller, load, shouldDefer, publish } = setup();
  shouldDefer.mockReturnValue(true);
  load.mockResolvedValue(snapshot);
  await controller.refresh();
  expect(load).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(500);
  shouldDefer.mockReturnValue(false);
  await jest.advanceTimersByTimeAsync(250);
  expect(publish).toHaveBeenCalledWith(snapshot);
});

it('uses bounded retry backoff and cancels timers and late responses on unmount', async () => {
  const { controller, load, publish } = setup();
  load.mockRejectedValue(new Error('offline'));
  await controller.refresh();
  for (const delay of [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000]) {
    const before = load.mock.calls.length;
    await jest.advanceTimersByTimeAsync(delay - 1);
    expect(load).toHaveBeenCalledTimes(before);
    await jest.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(before + 1);
  }
  controller.stop();
  const before = load.mock.calls.length;
  await jest.advanceTimersByTimeAsync(120_000);
  controller.receive(snapshot); controller.networkChanged(); await controller.refresh();
  expect(load).toHaveBeenCalledTimes(before);
  expect(publish).not.toHaveBeenCalled();
});

it('periodically reconciles a healthy socket so a lost delta does not leave the count stale', async () => {
  const { controller, load, publish } = setup();
  controller.receive(snapshot);
  load.mockResolvedValue({ ...snapshot, revision: 2, list: ['me'] });
  await jest.advanceTimersByTimeAsync(30_000);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ list: ['me'] }));
});
