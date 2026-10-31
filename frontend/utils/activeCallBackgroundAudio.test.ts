jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { currentState: 'active', addEventListener: jest.fn() },
  NativeModules: { LiviAppModule: { maintainActiveCallVoiceAudio: jest.fn() } },
}));
jest.mock('./activeCallSession', () => ({
  isOngoingCallSession: jest.fn(() => true),
  resolveActiveCallInCallMedia: () => 'audio',
  captureCallAudioRouteFromUi: jest.fn(),
}));
jest.mock('./callAudioRoutePersist', () => ({
  shouldApplyHomeLoudSpeakerPin: () => false,
  armCallAudioPreservePriority: jest.fn(),
  isCallAudioPiPTransitionWindow: () => false,
  scheduleReapplyPersistedCallAudioRoute: jest.fn(),
  reapplyPersistedCallAudioRoute: jest.fn(async () => {}),
}));
jest.mock('../src/pip/pipPlaceholderOnly', () => ({}));
jest.mock('./activeCallNotification', () => ({
  armAndroidLeaveHintForVideoCallHome: jest.fn(),
  syncAndroidLeaveHintForOngoingCall: jest.fn(),
}));
jest.mock('./nativeCallAudioProbe', () => ({}));
jest.mock('./safeRootNavigation', () => ({}));
jest.mock('./externalCallHold', () => ({ isExternalCallHoldActive: jest.fn(() => false) }));

import { AppState, NativeModules } from 'react-native';
import { installActiveCallBackgroundAudioHandlers } from './activeCallBackgroundAudio';
import { isOngoingCallSession } from './activeCallSession';
import { isExternalCallHoldActive } from './externalCallHold';
import { recoverLocalAudioTrack } from '../src/webrtc/sessions/videoCall/localAudioRecovery';

describe('background call audio maintenance', () => {
  let changeState: (state: string) => void;
  let restore: jest.Mock;
  beforeAll(() => {
    installActiveCallBackgroundAudioHandlers();
    changeState = (AppState.addEventListener as jest.Mock).mock.calls[0][1];
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    (isOngoingCallSession as jest.Mock).mockReturnValue(true);
    (isExternalCallHoldActive as jest.Mock).mockReturnValue(false);
    restore = jest.fn(async () => {});
    (global as any).__webrtcSessionRef = { current: { restoreMicrophoneAfterAppBackground: restore } };
    Object.assign(AppState, { currentState: 'background' });
    changeState('background');
  });
  afterEach(() => {
    Object.assign(AppState, { currentState: 'active' });
    // A completed call clears the interval without running foreground navigation logic.
    (isOngoingCallSession as jest.Mock).mockReturnValue(false);
    changeState('active');
    delete (global as any).__webrtcSessionRef;
    jest.useRealTimers();
  });

  it('repairs delayed capture loss while both screens remain locked for five minutes', async () => {
    const track = {
      mediaStreamTrack: { readyState: 'live', enabled: true }, isUpstreamPaused: false,
      unmute: jest.fn(async () => {}), mute: jest.fn(async () => {}),
      restartTrack: jest.fn(async () => {}), resumeUpstream: jest.fn(async () => {}),
    };
    restore.mockImplementation(() => recoverLocalAudioTrack(track, () => true));
    await jest.advanceTimersByTimeAsync(120000);
    track.mediaStreamTrack.enabled = false;
    await jest.advanceTimersByTimeAsync(12000);
    expect(track.mediaStreamTrack.enabled).toBe(true);
    await jest.advanceTimersByTimeAsync(168000);
    expect(restore).toHaveBeenCalledTimes(26); // entry + 25 maintenance ticks
    expect(track.restartTrack).not.toHaveBeenCalled();
    expect(NativeModules.LiviAppModule.maintainActiveCallVoiceAudio).toHaveBeenCalled();
  });

  it('does not recover microphone or focus while an external call holds the session', async () => {
    restore.mockClear();
    NativeModules.LiviAppModule.maintainActiveCallVoiceAudio.mockClear();
    (isExternalCallHoldActive as jest.Mock).mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(300000);
    expect(restore).not.toHaveBeenCalled();
    expect(NativeModules.LiviAppModule.maintainActiveCallVoiceAudio).not.toHaveBeenCalled();
  });

  it('stops maintenance after hangup even if AppState remains background', async () => {
    restore.mockClear();
    (isOngoingCallSession as jest.Mock).mockReturnValue(false);
    await jest.advanceTimersByTimeAsync(300000);
    expect(restore).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries on the next tick when recovery rejects', async () => {
    restore.mockRejectedValueOnce(new Error('temporary capture failure'));
    await jest.advanceTimersByTimeAsync(24000);
    expect(restore).toHaveBeenCalledTimes(3);
  });
});
