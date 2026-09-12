// utils/pipAudioOutputRoute.test.ts
//
// readInAppPiPAudioOutputRoute() — решает, какой динамик показывать и включать
// в in-app PiP-плашке во время звонка. Это самая сложная функция выбора маршрута
// в проекте (длинная лестница приоритетов источников). После рефакторинга её
// логика — чистая функция от снимка (PiPAudioOutputRouteState).
import type { PiPAudioOutputRouteState } from './activeCallSession';
import {
  readInAppPiPAudioOutputRouteFromState,
  isExternalRouteListedInCallFromState,
  readPiPBuiltinWhenExternalUnavailableFromState,
} from './activeCallSession';
import type { InCallAudioRoute } from '../components/VideoChat/hooks/audioRouteTypes';

const EARPIECE = 'EARPIECE' as InCallAudioRoute;
const SPEAKER = 'SPEAKER_PHONE' as InCallAudioRoute;
const BT = 'BLUETOOTH' as InCallAudioRoute;
const WIRED = 'WIRED_HEADSET' as InCallAudioRoute;

const ALL_AVAILABLE = ['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH', 'WIRED_HEADSET'];

function baseState(overrides: Partial<PiPAudioOutputRouteState> = {}): PiPAudioOutputRouteState {
  return {
    pipVisible: false,
    fromParams: null,
    userSel: null,
    icmSelected: null,
    stored: null,
    lastApplied: null,
    explicitToggle: null,
    extLocked: null,
    availableRoutes: [],
    btHeadsetActiveForCall: false,
    uiLockRoute: null,
    pipInAppRtcFromAudioOnly: false,
    paramsInAudioOnlyUi: undefined,
    paramsPreferVideoCallUi: undefined,
    externalForHint: null,
    ...overrides,
  };
}

describe('isExternalRouteListedInCallFromState', () => {
  it('false для встроенных маршрутов и пустого значения', () => {
    const s = baseState({ availableRoutes: ALL_AVAILABLE, btHeadsetActiveForCall: true });
    expect(isExternalRouteListedInCallFromState(EARPIECE, s)).toBe(false);
    expect(isExternalRouteListedInCallFromState(SPEAKER, s)).toBe(false);
    expect(isExternalRouteListedInCallFromState(null, s)).toBe(false);
  });

  it('BLUETOOTH не считается доступным, если BT-кэш звонка говорит «не подключён»', () => {
    const s = baseState({ availableRoutes: ALL_AVAILABLE, btHeadsetActiveForCall: false });
    expect(isExternalRouteListedInCallFromState(BT, s)).toBe(false);
    // проводная при этом доступна
    expect(isExternalRouteListedInCallFromState(WIRED, s)).toBe(true);
  });

  it('false, если список доступных маршрутов пуст (ICM ещё не ответил)', () => {
    expect(
      isExternalRouteListedInCallFromState(WIRED, baseState({ availableRoutes: [] })),
    ).toBe(false);
  });

  it('true для гарнитуры, которая есть в списке', () => {
    const s = baseState({ availableRoutes: ALL_AVAILABLE, btHeadsetActiveForCall: true });
    expect(isExternalRouteListedInCallFromState(BT, s)).toBe(true);
    expect(isExternalRouteListedInCallFromState(WIRED, s)).toBe(true);
  });
});

describe('readPiPBuiltinWhenExternalUnavailableFromState', () => {
  it('UI-lock имеет наивысший приоритет', () => {
    expect(
      readPiPBuiltinWhenExternalUnavailableFromState(
        baseState({ uiLockRoute: EARPIECE, stored: SPEAKER, paramsPreferVideoCallUi: true }),
      ),
    ).toBe(EARPIECE);
  });

  it('EARPIECE, если PiP пришёл из audio-only UI', () => {
    expect(
      readPiPBuiltinWhenExternalUnavailableFromState(
        baseState({ pipInAppRtcFromAudioOnly: true, stored: SPEAKER }),
      ),
    ).toBe(EARPIECE);
  });

  it('EARPIECE, если params.inAudioOnlyUi === true', () => {
    expect(
      readPiPBuiltinWhenExternalUnavailableFromState(
        baseState({ paramsInAudioOnlyUi: true, stored: SPEAKER }),
      ),
    ).toBe(EARPIECE);
  });

  it('иначе берётся сохранённый встроенный маршрут, затем lastApplied', () => {
    expect(readPiPBuiltinWhenExternalUnavailableFromState(baseState({ stored: SPEAKER }))).toBe(SPEAKER);
    expect(
      readPiPBuiltinWhenExternalUnavailableFromState(baseState({ stored: BT, lastApplied: EARPIECE })),
    ).toBe(EARPIECE);
  });

  it('SPEAKER_PHONE для video UI, если ничего не сохранено', () => {
    expect(
      readPiPBuiltinWhenExternalUnavailableFromState(baseState({ paramsPreferVideoCallUi: true })),
    ).toBe(SPEAKER);
  });

  it('EARPIECE по умолчанию', () => {
    expect(readPiPBuiltinWhenExternalUnavailableFromState(baseState())).toBe(EARPIECE);
  });
});

describe('readInAppPiPAudioOutputRouteFromState', () => {
  it('EARPIECE, когда вообще ничего не известно', () => {
    expect(readInAppPiPAudioOutputRouteFromState(baseState())).toBe(EARPIECE);
  });

  describe('когда PiP-плашка видима', () => {
    it('зафиксированная пользователем гарнитура побеждает всё остальное', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({
            pipVisible: true,
            extLocked: WIRED,
            availableRoutes: ALL_AVAILABLE,
            userSel: SPEAKER,
            icmSelected: EARPIECE,
          }),
        ),
      ).toBe(WIRED);
    });

    it('зафиксированная гарнитура игнорируется, если её нет в списке доступных', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({ pipVisible: true, extLocked: WIRED, availableRoutes: [], userSel: SPEAKER }),
        ),
      ).toBe(SPEAKER);
    });

    it('явный тап по кнопке в плашке (встроенный маршрут) применяется сразу', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({ pipVisible: true, explicitToggle: EARPIECE, stored: SPEAKER }),
        ),
      ).toBe(EARPIECE);
    });

    it('ICM-выбор побеждает устаревшую гарнитуру в params (BT отвалился)', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({
            pipVisible: true,
            icmSelected: SPEAKER,
            fromParams: BT,
            availableRoutes: ['EARPIECE', 'SPEAKER_PHONE'],
          }),
        ),
      ).toBe(SPEAKER);
    });

    it('video→PiP: SPEAKER из params побеждает отстающий ICM EARPIECE', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({ pipVisible: true, fromParams: SPEAKER, icmSelected: EARPIECE }),
        ),
      ).toBe(SPEAKER);
    });

    it('video→PiP: EARPIECE из params не применяется, если ICM уже SPEAKER', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({ pipVisible: true, fromParams: EARPIECE, icmSelected: SPEAKER }),
        ),
      ).toBe(SPEAKER);
    });

    it('правило video→PiP не действует, если PiP пришёл из audio-only', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({
            pipVisible: true,
            pipInAppRtcFromAudioOnly: true,
            fromParams: SPEAKER,
            icmSelected: EARPIECE,
          }),
        ),
      ).toBe(EARPIECE);
    });
  });

  describe('приоритет гарнитуры', () => {
    it('выбор пользователя важнее params и lastApplied', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({
            userSel: WIRED,
            fromParams: BT,
            lastApplied: BT,
            availableRoutes: ALL_AVAILABLE,
            btHeadsetActiveForCall: true,
          }),
        ),
      ).toBe(WIRED);
    });

    it('недоступная гарнитура в params уводит на встроенный fallback', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({ fromParams: BT, availableRoutes: ['EARPIECE', 'SPEAKER_PHONE'], stored: SPEAKER }),
        ),
      ).toBe(SPEAKER);
    });

    it('BT в params при «BT отключён» уводит на fallback, а не на BT', () => {
      expect(
        readInAppPiPAudioOutputRouteFromState(
          baseState({
            fromParams: BT,
            availableRoutes: ALL_AVAILABLE,
            btHeadsetActiveForCall: false,
            stored: EARPIECE,
          }),
        ),
      ).toBe(EARPIECE);
    });
  });

  describe('встроенные маршруты', () => {
    it('явный выбор пользователя (ухо/громкая) применяется', () => {
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ userSel: EARPIECE }))).toBe(EARPIECE);
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ userSel: SPEAKER }))).toBe(SPEAKER);
    });

    it('ICM-выбор применяется, если пользователь ничего не выбирал', () => {
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ icmSelected: SPEAKER }))).toBe(SPEAKER);
    });

    it('сохранённый маршрут применяется, если ICM молчит', () => {
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ stored: SPEAKER }))).toBe(SPEAKER);
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ lastApplied: EARPIECE }))).toBe(EARPIECE);
    });

    it('маршрут из params применяется, когда PiP не видима и больше ничего нет', () => {
      expect(readInAppPiPAudioOutputRouteFromState(baseState({ fromParams: SPEAKER }))).toBe(SPEAKER);
    });
  });

  it('найденная нативно гарнитура применяется, если она есть в списке доступных', () => {
    expect(
      readInAppPiPAudioOutputRouteFromState(
        baseState({ externalForHint: WIRED, availableRoutes: ALL_AVAILABLE }),
      ),
    ).toBe(WIRED);
  });

  it('устаревшая гарнитура в persist без подтверждения уводит на встроенный fallback', () => {
    expect(
      readInAppPiPAudioOutputRouteFromState(
        baseState({ stored: BT, availableRoutes: [], paramsPreferVideoCallUi: true }),
      ),
    ).toBe(SPEAKER);
  });
});
