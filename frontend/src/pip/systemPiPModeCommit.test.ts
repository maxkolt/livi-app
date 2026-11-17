import { createSystemPiPModeCommitter } from './systemPiPModeCommit';

describe('native system PiP mode commit', () => {
  it('prepares capture while animation frames and timers are paused', async () => {
    jest.useFakeTimers();
    const commit = jest.fn();
    const queue = createSystemPiPModeCommitter();
    try {
      queue.schedule(commit);
      expect(commit).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(commit).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      queue.dispose();
      jest.useRealTimers();
    }
  });

  it('does not revive an enter superseded by an exit', async () => {
    const queue = createSystemPiPModeCommitter();
    const enter = jest.fn();
    const exit = jest.fn();
    queue.schedule(enter);
    queue.schedule(exit);
    await Promise.resolve();
    expect(enter).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  it('drops deferred work when the provider unmounts', async () => {
    const queue = createSystemPiPModeCommitter();
    const commit = jest.fn();
    queue.schedule(commit);
    queue.dispose();
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();
  });
});
