import { connectWithSignalWatchdog, SIGNAL_WATCHDOG_ERROR } from './signalWatchdog';
import { isLikelyLiveKitSignalError } from './signalProxy';

type Harness = {
  emitSignalConnected: () => void;
  subscribed: () => boolean;
  onSignalConnected: (listener: () => void) => () => void;
};

function signalHarness(): Harness {
  let listener: (() => void) | null = null;
  return {
    emitSignalConnected: () => listener?.(),
    subscribed: () => listener !== null,
    onSignalConnected: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
}

const never = () => new Promise<void>(() => {});

describe('connectWithSignalWatchdog', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('отпускает зависший connect ошибкой signal-таймаута, которую подхватывает proxy-fallback', async () => {
    const signal = signalHarness();
    const onTimeout = jest.fn();
    const result = connectWithSignalWatchdog({
      connect: never,
      onSignalConnected: signal.onSignalConnected,
      deadlineMs: 10_000,
      onTimeout,
    });
    const assertion = expect(result).rejects.toThrow(SIGNAL_WATCHDOG_ERROR);

    jest.advanceTimersByTime(9_999);
    expect(onTimeout).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    await assertion;
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(signal.subscribed()).toBe(false);
    expect(isLikelyLiveKitSignalError(SIGNAL_WATCHDOG_ERROR)).toBe(true);
  });

  it('после SignalConnected не трогает фазу PeerConnection', async () => {
    const signal = signalHarness();
    const onTimeout = jest.fn();
    let finishConnect: () => void = () => {};
    const result = connectWithSignalWatchdog({
      connect: () => new Promise<void>((resolve) => { finishConnect = resolve; }),
      onSignalConnected: signal.onSignalConnected,
      deadlineMs: 10_000,
      onTimeout,
    });

    signal.emitSignalConnected();
    jest.advanceTimersByTime(25_000);
    expect(onTimeout).not.toHaveBeenCalled();

    finishConnect();
    await expect(result).resolves.toBeUndefined();
  });

  it('пробрасывает собственную ошибку SDK без изменений', async () => {
    const signal = signalHarness();
    const onTimeout = jest.fn();
    const sdkError = new Error('could not establish signal connection: room connection has timed out (signal)');
    const result = connectWithSignalWatchdog({
      connect: () => Promise.reject(sdkError),
      onSignalConnected: signal.onSignalConnected,
      deadlineMs: 10_000,
      onTimeout,
    });

    await expect(result).rejects.toBe(sdkError);
    jest.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(signal.subscribed()).toBe(false);
  });

  it('успешный connect снимает таймер и подписку', async () => {
    const signal = signalHarness();
    const onTimeout = jest.fn();
    await connectWithSignalWatchdog({
      connect: () => Promise.resolve(),
      onSignalConnected: signal.onSignalConnected,
      deadlineMs: 10_000,
      onTimeout,
    });
    jest.advanceTimersByTime(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(signal.subscribed()).toBe(false);
  });
});
