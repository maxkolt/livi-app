jest.mock('react-native', () => {
  const listeners = new Map<string, ((data?: any) => void)[]>();
  class Emitter {
    addListener(name: string, handler: (data?: any) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      return { remove: () => listeners.set(name, (listeners.get(name) ?? []).filter(h => h !== handler)) };
    }
    emit(name: string, data?: any) { listeners.get(name)?.forEach(h => h(data)); }
  }
  return {
    Platform: { OS: 'android' },
    AppState: Object.assign(new Emitter(), { currentState: 'active', addEventListener: Emitter.prototype.addListener }),
    DeviceEventEmitter: new Emitter(),
    NativeEventEmitter: Emitter,
    NativeModules: { LiviAppModule: {
      probeExternalCallHoldSignal: jest.fn(),
      clearExternalCallHoldInterruptSticky: jest.fn(),
      setExternalCallAudioHoldActive: jest.fn(),
      isExternalTelephonyAudioModeActive: jest.fn().mockResolvedValue(false),
    } },
  };
});
jest.mock('./activeCallSession', () => ({ isOngoingCallSession: () => true }));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import { AppState, DeviceEventEmitter, NativeModules } from 'react-native';
import { clearExternalCallHoldForCall, installExternalCallHoldHandlers,
  prepareExternalCallHoldForCall, setExternalCallHoldActive } from './externalCallHold';

const native = NativeModules.LiviAppModule;
const probe = (overrides = {}) => ({
  telephony: false, audioMode: 3, focusLost: true, focusChange: -2, pendingAgeMs: 0,
  screenInteractive: false, keyguardLocked: true, foreignVoicePlayback: false, ...overrides,
});
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const focus = (eventCode: number) => DeviceEventEmitter.emit('onAudioFocusChange', { eventCode });
function appState(state: 'active' | 'background') {
  AppState.currentState = state;
  DeviceEventEmitter.emit('change', state);
}

describe('external hold and a locked display', () => {
  let session: { enterExternalCallHold: jest.Mock; [key: string]: any };
  beforeAll(() => installExternalCallHoldHandlers());
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-30T12:00:00Z'));
    prepareExternalCallHoldForCall('test-call');
    appState('active');
    native.probeExternalCallHoldSignal.mockReset().mockResolvedValue(probe());
    session = {
      isEnded: () => false, getLiveKitRoomState: () => 'connected', getRemoteStream: () => ({}),
      enterExternalCallHold: jest.fn(async () => setExternalCallHoldActive(true)),
      exitExternalCallHold: jest.fn(async () => setExternalCallHoldActive(false)),
    };
    (global as any).__webrtcSessionRef = { current: session };
  });
  afterEach(() => { clearExternalCallHoldForCall(); jest.useRealTimers(); });

  it('does not mute either direction on screen-off plus transient focus loss, including delayed probes', async () => {
    appState('background');
    focus(-2);
    await settle();
    jest.advanceTimersByTime(300000);
    await settle();
    expect(session.enterExternalCallHold).not.toHaveBeenCalled();
  });

  it('does not turn a stale native focusLost flag into a fresh external call', async () => {
    native.probeExternalCallHoldSignal.mockResolvedValue(probe({
      focusChange: 0, pendingAgeMs: -1, screenInteractive: true, keyguardLocked: false,
    }));
    appState('background');
    jest.advanceTimersByTime(3000);
    await settle();
    expect(session.enterExternalCallHold).not.toHaveBeenCalled();
  });

  it.each([
    { telephony: true, audioMode: 2 },
    { foreignVoicePlayback: true },
  ])('still holds a confirmed external call while locked: %p', async evidence => {
    native.probeExternalCallHoldSignal.mockResolvedValue(probe(evidence));
    appState('background');
    focus(-2);
    await settle();
    expect(session.enterExternalCallHold).toHaveBeenCalledTimes(1);
  });

  it('preserves focus-based VoIP hold after switching to another app on an unlocked display', async () => {
    native.probeExternalCallHoldSignal.mockResolvedValue(probe({ screenInteractive: true, keyguardLocked: false }));
    appState('background');
    focus(-1);
    await settle();
    expect(session.enterExternalCallHold).toHaveBeenCalledTimes(1);
  });

  it('still holds for a foreign call UI that wakes the display over the keyguard', async () => {
    native.probeExternalCallHoldSignal.mockResolvedValue(probe({ screenInteractive: true, keyguardLocked: true }));
    appState('background');
    focus(-2);
    await settle();
    expect(session.enterExternalCallHold).toHaveBeenCalledTimes(1);
  });

  it('rechecks display state when a foreground focus loss is followed by locking', async () => {
    native.probeExternalCallHoldSignal.mockResolvedValue(probe({ screenInteractive: true, keyguardLocked: false }));
    focus(-2);
    await settle();
    native.probeExternalCallHoldSignal.mockResolvedValue(probe());
    appState('background');
    jest.advanceTimersByTime(3000);
    await settle();
    expect(session.enterExternalCallHold).not.toHaveBeenCalled();
  });

  it.each(['gain', 'new-call'])('rejects a stale probe after %s', async reason => {
    let resolveProbe!: (value: any) => void;
    native.probeExternalCallHoldSignal.mockImplementation(() => new Promise(resolve => { resolveProbe = resolve; }));
    appState('background');
    focus(-2);
    if (reason === 'gain') focus(1);
    else prepareExternalCallHoldForCall('replacement-call');
    resolveProbe(probe({ foreignVoicePlayback: true }));
    await settle();
    expect(session.enterExternalCallHold).not.toHaveBeenCalled();
  });
});
