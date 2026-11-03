import { startChatRecoveryPoll } from './chatRecoveryPoll';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('recovers an open chat without a socket reconnect event', async () => {
  const sync = jest.fn(async () => {});
  const stop = startChatRecoveryPoll(() => true, sync);
  await jest.advanceTimersByTimeAsync(5000);
  expect(sync).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5000);
  expect(sync).toHaveBeenCalledTimes(2);
  stop();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(sync).toHaveBeenCalledTimes(2);
});

it('does not poll a hidden or background chat or overlap a stalled request', async () => {
  let active = false;
  let finish!: () => void;
  const sync = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startChatRecoveryPoll(() => active, sync);
  await jest.advanceTimersByTimeAsync(5000);
  expect(sync).not.toHaveBeenCalled();
  active = true;
  await jest.advanceTimersByTimeAsync(20_000);
  expect(sync).toHaveBeenCalledTimes(1);
  finish();
  await jest.advanceTimersByTimeAsync(5000);
  expect(sync).toHaveBeenCalledTimes(2);
  stop();
});

it('continues after an offline HTTP failure', async () => {
  const sync = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const stop = startChatRecoveryPoll(() => true, sync);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(sync).toHaveBeenCalledTimes(2);
  stop();
});
