// eslint-disable-next-line @typescript-eslint/no-require-imports
const incall = require('react-native-incall-manager') as { __calls: () => { method: string }[]; __reset: () => void };
import InCallManager from 'react-native-incall-manager';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  addCallAudioSessionCloseListener,
  closeCallAudioSession,
  getCallAudioSessionOwner,
  isCallAudioSessionOpen,
  openCallAudioSession,
  reassertCallAudioSession,
} from './callAudioSession';

const methods = () => incall.__calls().map((c) => c.method);

describe('call audio session owner', () => {
  beforeEach(() => {
    closeCallAudioSession('direct', 'test-reset');
    closeCallAudioSession('random', 'test-reset');
    incall.__reset();
  });

  it('starts InCallManager once per session', () => {
    expect(openCallAudioSession('direct', 'video', 'test')).toBe(true);
    expect(openCallAudioSession('direct', 'video', 'pip-return')).toBe(false);
    expect(methods().filter((m) => m === 'start')).toHaveLength(1);
    expect(isCallAudioSessionOpen()).toBe(true);
    expect(getCallAudioSessionOwner()).toBe('direct');
  });

  it('keeps the session closed after a failed start so a route bootstrap can retry', () => {
    const start = jest.spyOn(InCallManager, 'start').mockImplementationOnce(() => {
      throw new Error('native module not ready');
    });
    expect(openCallAudioSession('direct', 'audio', 'first-bootstrap')).toBe(false);
    expect(isCallAudioSessionOpen()).toBe(false);
    expect(getCallAudioSessionOwner()).toBeNull();
    expect(openCallAudioSession('direct', 'audio', 'bootstrap-retry')).toBe(true);
    expect(isCallAudioSessionOpen()).toBe(true);
    start.mockRestore();
  });

  it('does not reopen a closed session from a late route reapply', () => {
    expect(reassertCallAudioSession('audio', 'late-reapply')).toBe(false);
    expect(methods()).not.toContain('start');
    openCallAudioSession('direct', 'audio', 'test');
    expect(reassertCallAudioSession('video', 'reapply')).toBe(true);
    expect(methods().filter((m) => m === 'start')).toHaveLength(2);
  });

  it('lets only the owning call close the session', () => {
    openCallAudioSession('direct', 'video', 'test');
    expect(closeCallAudioSession('random', 'random-chat-unmount')).toBe(false);
    expect(methods()).not.toContain('stop');
    expect(closeCallAudioSession('direct', 'call-ended')).toBe(true);
    expect(methods()).toContain('stop');
    expect(isCallAudioSessionOpen()).toBe(false);
    expect(closeCallAudioSession('direct', 'second-teardown')).toBe(false);
    expect(methods().filter((m) => m === 'stop')).toHaveLength(1);
  });

  it('runs close listeners once per close', () => {
    const listener = jest.fn();
    const off = addCallAudioSessionCloseListener(listener);
    openCallAudioSession('random', 'video', 'test');
    closeCallAudioSession('random', 'next');
    closeCallAudioSession('random', 'again');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});
