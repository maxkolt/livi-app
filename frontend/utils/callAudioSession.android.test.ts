jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: {
    LiviAppModule: { refreshCallProximity: jest.fn(), scheduleCallAudioRelease: jest.fn() },
    InCallManager: { setAutomaticProximityEnabled: jest.fn() },
  },
}));
jest.mock('react-native-incall-manager', () => ({
  start: jest.fn(), stop: jest.fn(), stopProximitySensor: jest.fn(), setSpeakerphoneOn: jest.fn(),
}));
jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import { NativeModules } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import { closeCallAudioSession, openCallAudioSession } from './callAudioSession';

describe('Android proximity ownership across call types', () => {
  beforeEach(() => {
    closeCallAudioSession('direct', 'reset');
    closeCallAudioSession('random', 'reset');
    jest.clearAllMocks();
  });

  it('disables legacy proximity before starting a service-owned direct call', () => {
    openCallAudioSession('direct', 'audio', 'accept');
    const configure = NativeModules.InCallManager.setAutomaticProximityEnabled;
    expect(configure).toHaveBeenCalledWith(false);
    expect(configure.mock.invocationCallOrder[0]).toBeLessThan(
      (InCallManager.start as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it('restores the legacy owner when random chat follows a direct call', () => {
    openCallAudioSession('direct', 'audio', 'accept');
    closeCallAudioSession('direct', 'ended');
    openCallAudioSession('random', 'video', 'match');
    expect(NativeModules.InCallManager.setAutomaticProximityEnabled.mock.calls)
      .toEqual([[false], [true]]);
  });

  it('keeps legacy proximity available on an older native binary', () => {
    const refresh = NativeModules.LiviAppModule.refreshCallProximity;
    delete NativeModules.LiviAppModule.refreshCallProximity;
    try {
      expect(openCallAudioSession('direct', 'audio', 'accept')).toBe(true);
      expect(NativeModules.InCallManager.setAutomaticProximityEnabled).not.toHaveBeenCalled();
    } finally {
      NativeModules.LiviAppModule.refreshCallProximity = refresh;
    }
  });
});
