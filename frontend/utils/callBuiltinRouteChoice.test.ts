// utils/callBuiltinRouteChoice.test.ts
//
// Режим звука звонка (ухо/громкая) не зависит от камеры: включил видео на ухе —
// остаёшься на ухе; выбрал громкую на видео — она остаётся и после выключения видео.
// Громкая по умолчанию на video — только пока режим не выбран (звонок начался с видео).
import {
  markActiveCallAudioRouteCallId,
  setUserSelectedCallAudioRoute,
} from './activeCallSession';
import {
  clearStaleVideoSpeakerUiLockForAudioOnlyUi,
  mapRouteForVideoUiKeepingChoice,
  resolveFullVideoCallScreenAudioRoute,
  resolveVideoInAppPiPPreserveRoute,
  setPersistedCallAudioRoute,
  userExplicitlyChoseLoudSpeakerForCall,
} from './callAudioRoutePersist';
import { armCallAudioRouteUiLock, readCallAudioRouteUiLock } from './callAudioRouteTransitionGuards';
import { readCallBuiltinRouteChoice, rememberCallBuiltinRouteChoice } from './callHeadsetAudioFallback';

function reset() {
  const g = global as any;
  for (const k of Object.keys(g)) {
    if (/CallAudio|callAudio|BuiltIn|builtin|Builtin|Headset|headset|bt[A-Z]|webrtcSession|PiP/.test(k)) {
      try { delete g[k]; } catch {}
    }
  }
  setUserSelectedCallAudioRoute(null);
  markActiveCallAudioRouteCallId('call-under-test');
}
beforeEach(reset);
afterAll(reset);

function ownCameraOn() {
  (global as any).__webrtcSessionRef = { current: { getIsCamOn: () => true } };
}

describe('режим звонка на video UI', () => {
  it('без выбранного режима своя камера включает громкую (звонок начался с видео)', () => {
    ownCameraOn();
    expect(resolveFullVideoCallScreenAudioRoute()).toBe('SPEAKER_PHONE');
  });

  it('ухо с audio остаётся ухом после включения камеры', () => {
    rememberCallBuiltinRouteChoice('EARPIECE');
    ownCameraOn();
    expect(resolveFullVideoCallScreenAudioRoute()).toBe('EARPIECE');
    expect(mapRouteForVideoUiKeepingChoice('EARPIECE')).toBe('EARPIECE');
  });

  it('уход в плашку с video тоже сохраняет ухо', () => {
    rememberCallBuiltinRouteChoice('EARPIECE');
    expect(resolveVideoInAppPiPPreserveRoute()).toBe('EARPIECE');
  });

  it('активная гарнитура важнее режима', () => {
    rememberCallBuiltinRouteChoice('EARPIECE');
    (global as any).__inCallAvailableAudioRoutesRef = { current: ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH'] };
    setPersistedCallAudioRoute('BLUETOOTH');
    ownCameraOn();
    expect(resolveFullVideoCallScreenAudioRoute()).toBe('BLUETOOTH');
    expect(mapRouteForVideoUiKeepingChoice('BLUETOOTH')).toBe('BLUETOOTH');
  });
});

describe('возврат video → audio', () => {
  it('громкая, выбранная на видео, не считается остатком video', () => {
    rememberCallBuiltinRouteChoice('SPEAKER_PHONE');
    armCallAudioRouteUiLock('SPEAKER_PHONE');
    clearStaleVideoSpeakerUiLockForAudioOnlyUi();
    expect(readCallAudioRouteUiLock()).toBe('SPEAKER_PHONE');
    expect(userExplicitlyChoseLoudSpeakerForCall()).toBe(true);
  });

  it('при выбранном ухе SPEAKER lock с video снимается', () => {
    rememberCallBuiltinRouteChoice('EARPIECE');
    armCallAudioRouteUiLock('SPEAKER_PHONE');
    clearStaleVideoSpeakerUiLockForAudioOnlyUi();
    expect(readCallAudioRouteUiLock()).toBeNull();
  });
});

describe('время жизни режима', () => {
  it('новый звонок начинается без режима', () => {
    rememberCallBuiltinRouteChoice('SPEAKER_PHONE');
    markActiveCallAudioRouteCallId('next-call');
    expect(readCallBuiltinRouteChoice()).toBeNull();
  });

  it('гарнитура в режим не пишется', () => {
    rememberCallBuiltinRouteChoice('EARPIECE');
    rememberCallBuiltinRouteChoice('BLUETOOTH');
    expect(readCallBuiltinRouteChoice()).toBe('EARPIECE');
  });
});
