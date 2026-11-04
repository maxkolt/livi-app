import { FliqRecovery } from './fliqRecovery';

function setup() {
  const reload = jest.fn();
  const stalled = jest.fn();
  const recovery = new FliqRecovery({ reload, stalled });
  recovery.setMode('play', 1000);
  return { recovery, reload, stalled };
}

describe('Fliq recovery with and without VPN', () => {
  it('retries a missing API/first frame on the same video with bounded backoff', () => {
    const { recovery, reload, stalled } = setup();
    recovery.error(-1);
    recovery.check(12_999);
    expect(reload).not.toHaveBeenCalled();
    recovery.check(13_000);
    recovery.check(33_000);
    recovery.check(63_000);
    expect(reload).toHaveBeenCalledTimes(3);
    recovery.check(93_000);
    recovery.check(200_000);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it('detects frozen media time even when PLAYING ticks keep arriving', () => {
    const { recovery, reload } = setup();
    recovery.progress(3, true, 2000);
    for (let now = 3000; now <= 14_000; now += 1000) {
      recovery.progress(3, true, now);
      recovery.check(now);
    }
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(['hold', 'pause'] as const)('never resumes or reloads during %s', (mode) => {
    const { recovery, reload, stalled } = setup();
    recovery.setMode(mode, 2000);
    recovery.error(5);
    recovery.check(200_000);
    recovery.networkRestored(201_000);
    expect(reload).not.toHaveBeenCalled();
    expect(stalled).not.toHaveBeenCalled();
    recovery.setMode('play', 202_000);
    recovery.check(213_000);
    expect(reload).not.toHaveBeenCalled();
    recovery.check(214_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('recovers error 5 as a media failure rather than rejecting or skipping the video', () => {
    const { recovery, reload, stalled } = setup();
    recovery.error(5);
    recovery.check(13_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(stalled).not.toHaveBeenCalled();
  });

  it.each([2, 100, 101, 150])('leaves unavailable video %i for explicit retry or next', (code) => {
    const { recovery, reload, stalled } = setup();
    recovery.error(code);
    recovery.check(200_000);
    recovery.networkRestored(201_000);
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reopens stalled media when the network comes back, including after retry exhaustion', () => {
    const { recovery, reload } = setup();
    [13_000, 33_000, 63_000, 93_000].forEach((now) => recovery.check(now));
    recovery.networkRestored(100_000);
    expect(reload).toHaveBeenCalledTimes(4);
    recovery.check(112_000);
    expect(reload).toHaveBeenCalledTimes(5);
  });

  it('preserves healthy playback during VPN/route notifications', () => {
    const { recovery, reload } = setup();
    for (let i = 1; i <= 50; i++) {
      recovery.progress(i / 2, true, 1000 + i * 500);
      recovery.networkRestored(1000 + i * 500);
      recovery.check(1000 + i * 500);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('restores the retry budget after sustained media advancement', () => {
    const { recovery, reload } = setup();
    recovery.check(13_000);
    for (let i = 1; i <= 12; i++) recovery.progress(i, true, 13_000 + i * 1000);
    recovery.check(37_000);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
