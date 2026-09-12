// utils/callAudioRouteReapply.test.ts
//
// Кластер "какой маршрут восстанавливать": решение, которое срабатывает при уходе
// приложения в фон во время аудиозвонка и при возврате из system PiP. Именно тут
// живёт правило "audio-only в фоне → громкая связь, кроме гарнитуры" и защита от
// перезаписи маршрута во время перехода в/из system PiP.
// После рефакторинга логика — чистые функции от снимка (CallAudioRouteReapplyState).
import type {
  CallAudioRouteReapplyState,
  OngoingCallMediaState,
} from './activeCallSession';
import {
  isAudioOnlyOngoingCallContextFromState,
  resolvePersistedCallAudioRouteForActiveUiFromState,
  resolvePersistedCallAudioRouteForReapplyFromState,
  isSystemPiPRouteTransitionFromState,
} from './activeCallSession';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';

const NOW = 1_700_000_000_000;

function baseMedia(overrides: Partial<OngoingCallMediaState> = {}): OngoingCallMediaState {
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

function baseState(
  overrides: Partial<Omit<CallAudioRouteReapplyState, 'media'>> = {},
  mediaOverrides: Partial<OngoingCallMediaState> = {},
): CallAudioRouteReapplyState {
  return {
    media: baseMedia(mediaOverrides),
    appInBackground: false,
    ongoingCallSession: false,
    pipAudioOnlyPlaceholder: false,
    now: NOW,
    returningFromSystemPiPUntil: 0,
    systemPiPEntryInProgressUntil: 0,
    callAudioPreservePriorityUntil: 0,
    ...overrides,
  };
}

const EARPIECE = 'EARPIECE' as InCallAudioRoute;
const SPEAKER = 'SPEAKER_PHONE' as InCallAudioRoute;
const BT = 'BLUETOOTH' as InCallAudioRoute;
const WIRED = 'WIRED_HEADSET' as InCallAudioRoute;

describe('isAudioOnlyOngoingCallContextFromState', () => {
  it('false, если звонок предпочитает видео (камера включена)', () => {
    expect(
      isAudioOnlyOngoingCallContextFromState(
        baseState({ ongoingCallSession: true }, { sessionExists: true, sessionCamOn: true }),
      ),
    ).toBe(false);
  });

  it('true на экране аудиозвонка (isInAudioOnlyCallUi), даже без активной сессии', () => {
    expect(
      isAudioOnlyOngoingCallContextFromState(baseState({}, { isInAudioOnlyCallUiFlag: true })),
    ).toBe(true);
  });

  it('false, если звонка нет вообще', () => {
    expect(isAudioOnlyOngoingCallContextFromState(baseState())).toBe(false);
  });

  it('true, если звонок идёт и params.inAudioOnlyUi === true', () => {
    expect(
      isAudioOnlyOngoingCallContextFromState(
        baseState({ ongoingCallSession: true }, { paramsInAudioOnlyUi: true }),
      ),
    ).toBe(true);
  });

  it('true, если звонок идёт и висит audio-only заглушка PiP', () => {
    expect(
      isAudioOnlyOngoingCallContextFromState(
        baseState({ ongoingCallSession: true, pipAudioOnlyPlaceholder: true }),
      ),
    ).toBe(true);
  });

  it('false, если звонок идёт, но ни один audio-признак не выставлен', () => {
    expect(isAudioOnlyOngoingCallContextFromState(baseState({ ongoingCallSession: true }))).toBe(false);
  });
});

describe('resolvePersistedCallAudioRouteForActiveUiFromState', () => {
  it('null для пустого маршрута', () => {
    expect(resolvePersistedCallAudioRouteForActiveUiFromState(null, baseState())).toBeNull();
  });

  it('внешняя гарнитура возвращается как есть (BT / проводная)', () => {
    expect(resolvePersistedCallAudioRouteForActiveUiFromState(BT, baseState())).toBe(BT);
    expect(resolvePersistedCallAudioRouteForActiveUiFromState(WIRED, baseState())).toBe(WIRED);
  });

  it('на экране аудиозвонка ухо остаётся ухом', () => {
    expect(
      resolvePersistedCallAudioRouteForActiveUiFromState(
        EARPIECE,
        baseState({}, { isInAudioOnlyCallUiFlag: true }),
      ),
    ).toBe(EARPIECE);
  });

  it('в окне стабилизации после accept ухо остаётся ухом', () => {
    expect(
      resolvePersistedCallAudioRouteForActiveUiFromState(
        EARPIECE,
        baseState({}, { isDirectAudioEarpieceStabilizeWindowFlag: true }),
      ),
    ).toBe(EARPIECE);
  });

  it('на video UI ухо превращается в громкую связь', () => {
    expect(resolvePersistedCallAudioRouteForActiveUiFromState(EARPIECE, baseState())).toBe(SPEAKER);
  });

  it('громкая связь на video UI не меняется', () => {
    expect(resolvePersistedCallAudioRouteForActiveUiFromState(SPEAKER, baseState())).toBe(SPEAKER);
  });
});

describe('isSystemPiPRouteTransitionFromState', () => {
  it('true при активном окне возврата из system PiP', () => {
    expect(
      isSystemPiPRouteTransitionFromState(baseState({ returningFromSystemPiPUntil: NOW + 1000 })),
    ).toBe(true);
  });

  it('true, когда PiP уже в системном режиме', () => {
    expect(isSystemPiPRouteTransitionFromState(baseState({}, { isPipInSystemModeFlag: true }))).toBe(true);
  });

  it('true при активном окне входа в system PiP', () => {
    expect(
      isSystemPiPRouteTransitionFromState(baseState({ systemPiPEntryInProgressUntil: NOW + 1000 })),
    ).toBe(true);
  });

  it('true при активном окне preserve-priority', () => {
    expect(
      isSystemPiPRouteTransitionFromState(baseState({ callAudioPreservePriorityUntil: NOW + 1000 })),
    ).toBe(true);
  });

  it('false, если все окна уже истекли', () => {
    expect(
      isSystemPiPRouteTransitionFromState(
        baseState({
          returningFromSystemPiPUntil: NOW - 1,
          systemPiPEntryInProgressUntil: NOW - 5000,
          callAudioPreservePriorityUntil: 0,
        }),
      ),
    ).toBe(false);
  });
});

describe('resolvePersistedCallAudioRouteForReapplyFromState', () => {
  /** Аудиозвонок идёт, приложение ушло в фон, никаких PiP-переходов. */
  function backgroundAudioCall(
    overrides: Partial<Omit<CallAudioRouteReapplyState, 'media'>> = {},
  ): CallAudioRouteReapplyState {
    return baseState(
      { appInBackground: true, ongoingCallSession: true, ...overrides },
      { isInAudioOnlyCallUiFlag: true },
    );
  }

  it('КЛЮЧЕВОЕ ПРАВИЛО: audio-only в фоне → громкая связь', () => {
    expect(resolvePersistedCallAudioRouteForReapplyFromState(EARPIECE, backgroundAudioCall())).toBe(
      SPEAKER,
    );
    expect(resolvePersistedCallAudioRouteForReapplyFromState(null, backgroundAudioCall())).toBe(
      SPEAKER,
    );
  });

  it('гарнитура (BT / провод) в фоне НЕ перебивается громкой связью', () => {
    expect(resolvePersistedCallAudioRouteForReapplyFromState(BT, backgroundAudioCall())).toBe(BT);
    expect(resolvePersistedCallAudioRouteForReapplyFromState(WIRED, backgroundAudioCall())).toBe(
      WIRED,
    );
  });

  it('во время перехода system PiP маршрут сохраняется как есть (ухо не переписывается на громкую)', () => {
    const state = backgroundAudioCall({ systemPiPEntryInProgressUntil: NOW + 1000 });
    expect(resolvePersistedCallAudioRouteForReapplyFromState(EARPIECE, state)).toBe(EARPIECE);
    expect(resolvePersistedCallAudioRouteForReapplyFromState(SPEAKER, state)).toBe(SPEAKER);
    expect(resolvePersistedCallAudioRouteForReapplyFromState(BT, state)).toBe(BT);
  });

  it('во время перехода system PiP пустой маршрут даёт EARPIECE по умолчанию', () => {
    expect(
      resolvePersistedCallAudioRouteForReapplyFromState(
        null,
        backgroundAudioCall({ returningFromSystemPiPUntil: NOW + 1000 }),
      ),
    ).toBe(EARPIECE);
  });

  it('в foreground правило фона не применяется — работает логика активного UI', () => {
    // Не в фоне: ухо на video UI превращается в громкую (логика ActiveUi), а не из-за фона.
    expect(
      resolvePersistedCallAudioRouteForReapplyFromState(EARPIECE, baseState({ ongoingCallSession: true })),
    ).toBe(SPEAKER);
    // Не в фоне, экран аудиозвонка: ухо остаётся ухом.
    expect(
      resolvePersistedCallAudioRouteForReapplyFromState(
        EARPIECE,
        baseState({ ongoingCallSession: true }, { isInAudioOnlyCallUiFlag: true }),
      ),
    ).toBe(EARPIECE);
  });

  it('в фоне, но звонок видео → правило audio-only не применяется', () => {
    const state = baseState(
      { appInBackground: true, ongoingCallSession: true },
      { sessionExists: true, sessionCamOn: true },
    );
    expect(resolvePersistedCallAudioRouteForReapplyFromState(EARPIECE, state)).toBe(SPEAKER);
    expect(resolvePersistedCallAudioRouteForReapplyFromState(null, state)).toBeNull();
  });
});
