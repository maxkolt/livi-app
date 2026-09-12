// utils/activeCallSession.ongoingMedia.test.ts
//
// ongoingCallPrefersVideoMedia() / resolveActiveCallInCallMedia() — самая часто
// переиспользуемая пара функций во всём аудио-роутинге звонков (используется
// напрямую и через callHeadsetAudioFallback.ts, VideoCall.tsx, PiPContext.tsx).
// После рефакторинга это чистые функции от явного снимка (OngoingCallMediaState),
// а не чтение global.* / session.* внутри самой логики принятия решения.
// Эти тесты покрывают именно логику принятия решения.
import type { OngoingCallMediaState } from './activeCallSession';
import {
  ongoingCallPrefersVideoMediaFromState,
  resolveActiveCallInCallMediaFromState,
  gatherOngoingCallMediaState,
} from './activeCallSession';

function baseState(overrides: Partial<OngoingCallMediaState> = {}): OngoingCallMediaState {
  return {
    activeCallId: '',
    callMediaHintIsAudio: false,
    directCallUserRequestedVideoExpand: false,
    directCallVideoExpandGuardActive: false,
    expandToVideoCallUiFromPiP: false,
    sessionExists: false,
    sessionIsEnded: false,
    sessionCamOn: false,
    sessionDeferRemoteVideoSubscription: undefined,
    sessionDirectCallAudioOnlyConsumerDefer: undefined,
    sessionIsCameraSuspendedForAppBackground: undefined,
    paramsLocalCamOn: undefined,
    paramsPreferVideoCallUi: undefined,
    paramsInAudioOnlyUi: undefined,
    stayOnVideoCallUi: false,
    isDirectAudioEarpieceStabilizeWindowFlag: false,
    isInAudioOnlyCallUiFlag: false,
    isInAudioOnlyUiRuntimeFlag: false,
    isPipInSystemModeFlag: false,
    ...overrides,
  };
}

/** Снимок "активный audio-first прямой звонок, пользователь ещё не разворачивал на видео". */
function audioFirstDirectCallState(overrides: Partial<OngoingCallMediaState> = {}): OngoingCallMediaState {
  return baseState({
    activeCallId: 'call-1',
    callMediaHintIsAudio: true,
    directCallUserRequestedVideoExpand: false,
    ...overrides,
  });
}

describe('ongoingCallPrefersVideoMediaFromState', () => {
  describe('пустое состояние / не в звонке', () => {
    it('false, если сессии нет и ни один флаг не выставлен', () => {
      expect(ongoingCallPrefersVideoMediaFromState(baseState())).toBe(false);
    });
  });

  describe('audio-first прямой звонок (activeCallId + callMediaHintIsAudio, без video-запроса пользователя)', () => {
    it('true, если активен video-expand guard (переходная анимация expand)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          audioFirstDirectCallState({ directCallVideoExpandGuardActive: true }),
        ),
      ).toBe(true);
    });

    it('true, если выставлен expandToVideoCallUiFromPiP', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          audioFirstDirectCallState({ expandToVideoCallUiFromPiP: true }),
        ),
      ).toBe(true);
    });

    it('true, если камера сессии включена (sessionCamOn)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(audioFirstDirectCallState({ sessionCamOn: true })),
      ).toBe(true);
    });

    it('true, если params.localCamOn === true', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(audioFirstDirectCallState({ paramsLocalCamOn: true })),
      ).toBe(true);
    });

    it('false, если ни один из video-сигналов не выставлен (чистый audio-first звонок)', () => {
      expect(ongoingCallPrefersVideoMediaFromState(audioFirstDirectCallState())).toBe(false);
    });

    it('stayOnVideoCallUi НЕ учитывается в audio-first ветке (решает только cam/guard/expand)', () => {
      // Регрессия: audio-first ветка перехватывает решение раньше проверки stayOnVideoCallUi —
      // если это когда-нибудь случайно изменится, тест должен упасть.
      expect(
        ongoingCallPrefersVideoMediaFromState(
          audioFirstDirectCallState({ stayOnVideoCallUi: true }),
        ),
      ).toBe(false);
    });
  });

  describe('audio-first звонок, но пользователь запросил video expand', () => {
    it('уходит в обычную (non-direct-audio-first) ветку и учитывает stayOnVideoCallUi', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          audioFirstDirectCallState({ directCallUserRequestedVideoExpand: true, stayOnVideoCallUi: true }),
        ),
      ).toBe(true);
    });
  });

  describe('обычный (не audio-first direct) звонок', () => {
    it('true при stayOnVideoCallUi', () => {
      expect(ongoingCallPrefersVideoMediaFromState(baseState({ stayOnVideoCallUi: true }))).toBe(true);
    });

    it('true при params.preferVideoCallUi === true', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(baseState({ paramsPreferVideoCallUi: true })),
      ).toBe(true);
    });

    it('true при params.localCamOn === true', () => {
      expect(ongoingCallPrefersVideoMediaFromState(baseState({ paramsLocalCamOn: true }))).toBe(true);
    });

    it('false, если сессии нет вообще', () => {
      expect(ongoingCallPrefersVideoMediaFromState(baseState({ sessionExists: false }))).toBe(false);
    });

    it('false, если сессия уже завершена (sessionIsEnded)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(baseState({ sessionExists: true, sessionIsEnded: true })),
      ).toBe(false);
    });

    it('true, если сессия жива и камера включена', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          baseState({ sessionExists: true, sessionCamOn: true }),
        ),
      ).toBe(true);
    });

    it('true, если камера выключена, но оба defer-флага явно false (подписка на remote video активна)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          baseState({
            sessionExists: true,
            sessionDeferRemoteVideoSubscription: false,
            sessionDirectCallAudioOnlyConsumerDefer: false,
          }),
        ),
      ).toBe(true);
    });

    it('false, если defer-флаги не оба false (например defer=true)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(
          baseState({
            sessionExists: true,
            sessionDeferRemoteVideoSubscription: true,
            sessionDirectCallAudioOnlyConsumerDefer: false,
          }),
        ),
      ).toBe(false);
    });

    it('false, если defer-флаги оба undefined (ещё не проставлены)', () => {
      expect(
        ongoingCallPrefersVideoMediaFromState(baseState({ sessionExists: true })),
      ).toBe(false);
    });
  });
});

describe('resolveActiveCallInCallMediaFromState', () => {
  it("'audio', если активно окно стабилизации earpiece — перекрывает всё остальное", () => {
    expect(
      resolveActiveCallInCallMediaFromState(
        baseState({ isDirectAudioEarpieceStabilizeWindowFlag: true, stayOnVideoCallUi: true }),
      ),
    ).toBe('audio');
  });

  it("'video', если ongoingCallPrefersVideoMediaFromState() true (например stayOnVideoCallUi)", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ stayOnVideoCallUi: true })),
    ).toBe('video');
  });

  it("'audio', если isInAudioOnlyCallUiFlag true и видео не предпочитается", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ isInAudioOnlyCallUiFlag: true })),
    ).toBe('audio');
  });

  it("preferVideo (stayOnVideoCallUi) проверяется РАНЬШЕ isInAudioOnlyCallUiFlag — 'video' побеждает", () => {
    expect(
      resolveActiveCallInCallMediaFromState(
        baseState({ stayOnVideoCallUi: true, isInAudioOnlyCallUiFlag: true }),
      ),
    ).toBe('video');
  });

  it("'audio', если isInAudioOnlyUiRuntimeFlag true", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ isInAudioOnlyUiRuntimeFlag: true })),
    ).toBe('audio');
  });

  it("'audio', если params.inAudioOnlyUi === true", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ paramsInAudioOnlyUi: true })),
    ).toBe('audio');
  });

  it("'audio', если params.preferVideoCallUi === false", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ paramsPreferVideoCallUi: false })),
    ).toBe('audio');
  });

  it("'audio', если сессия сообщает isCameraSuspendedForAppBackground === true", () => {
    expect(
      resolveActiveCallInCallMediaFromState(
        baseState({ sessionIsCameraSuspendedForAppBackground: true }),
      ),
    ).toBe('audio');
  });

  it("'audio' в system PiP, если params.localCamOn === false", () => {
    expect(
      resolveActiveCallInCallMediaFromState(
        baseState({ isPipInSystemModeFlag: true, paramsLocalCamOn: false }),
      ),
    ).toBe('audio');
  });

  it("'video' в system PiP, если localCamOn не false (true / undefined)", () => {
    expect(
      resolveActiveCallInCallMediaFromState(baseState({ isPipInSystemModeFlag: true })),
    ).toBe('video');
    expect(
      resolveActiveCallInCallMediaFromState(
        baseState({ isPipInSystemModeFlag: true, paramsLocalCamOn: true }),
      ),
    ).toBe('video');
  });

  it("'video' по умолчанию, если вообще ничего не выставлено", () => {
    expect(resolveActiveCallInCallMediaFromState(baseState())).toBe('video');
  });
});

describe('gatherOngoingCallMediaState (smoke test)', () => {
  it('не бросает исключение и возвращает валидный снимок в пустом окружении', () => {
    const state = gatherOngoingCallMediaState();
    expect(typeof state.activeCallId).toBe('string');
    expect(typeof state.sessionExists).toBe('boolean');
    expect(typeof state.stayOnVideoCallUi).toBe('boolean');
    expect(typeof state.isPipInSystemModeFlag).toBe('boolean');
  });
});
