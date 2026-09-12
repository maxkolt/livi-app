// utils/callHeadsetAudioFallback.test.ts
//
// Раньше эта логика (какой встроенный маршрут включить после отключения
// гарнитуры/Bluetooth во время звонка) читала global.__pipVisibleRef и
// подобные глобальные флаги ПРЯМО внутри функций принятия решения — то есть
// была непроверяемой без подмены глобального состояния. После рефакторинга
// в callHeadsetAudioFallback.ts решение стало чистой функцией от явного
// снимка состояния (HeadsetRouteState) — эти тесты покрывают саму логику
// принятия решения, а не чтение глобалов.
import type { HeadsetRouteState } from './callHeadsetAudioFallback';
import {
  isOnFullScreenVideoCallUiFromState,
  isInAppPiPVideoPathContextFromState,
  isInSystemPiPAudioOnlyContextFromState,
  preferSpeakerAfterHeadsetDisconnectFromState,
  shouldDefaultToEarpieceAfterHeadsetDisconnectFromState,
  resolveCallRouteAfterHeadsetDisconnectFromState,
} from './callHeadsetAudioFallback';

/** Базовое "спокойное" состояние: обычный audio-звонок, ничего не заблокировано. */
function baseState(overrides: Partial<HeadsetRouteState> = {}): HeadsetRouteState {
  return {
    lockedRoute: null,
    currentRouteName: null,
    prefersVideoMedia: false,
    pipVisible: false,
    pipInSystemMode: false,
    pipInAppRtcFromAudioOnly: false,
    isAudioOnlyCallUi: false,
    storedBuiltinRoute: null,
    ...overrides,
  };
}

describe('isOnFullScreenVideoCallUiFromState', () => {
  it('true только на экране VideoCall с video-медиа', () => {
    expect(isOnFullScreenVideoCallUiFromState(baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: true }))).toBe(true);
  });
  it('false на VideoCall без video-медиа (аудио-звонок)', () => {
    expect(isOnFullScreenVideoCallUiFromState(baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: false }))).toBe(false);
  });
  it('false вне экрана VideoCall, даже с video-медиа', () => {
    expect(isOnFullScreenVideoCallUiFromState(baseState({ currentRouteName: 'Home', prefersVideoMedia: true }))).toBe(false);
  });
});

describe('isInAppPiPVideoPathContextFromState', () => {
  it('true: in-app PiP видим, не system PiP, не audio-only-в-PiP, есть video', () => {
    expect(
      isInAppPiPVideoPathContextFromState(baseState({ pipVisible: true, prefersVideoMedia: true }))
    ).toBe(true);
  });
  it('false, если PiP не виден', () => {
    expect(isInAppPiPVideoPathContextFromState(baseState({ pipVisible: false, prefersVideoMedia: true }))).toBe(false);
  });
  it('false, если это на самом деле system PiP', () => {
    expect(
      isInAppPiPVideoPathContextFromState(baseState({ pipVisible: true, pipInSystemMode: true, prefersVideoMedia: true }))
    ).toBe(false);
  });
  it('false, если in-app PiP попал в video из audio-only UI', () => {
    expect(
      isInAppPiPVideoPathContextFromState(
        baseState({ pipVisible: true, pipInAppRtcFromAudioOnly: true, prefersVideoMedia: true })
      )
    ).toBe(false);
  });
});

describe('isInSystemPiPAudioOnlyContextFromState', () => {
  it('true: system PiP + чистое audio', () => {
    expect(isInSystemPiPAudioOnlyContextFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: false }))).toBe(true);
  });
  it('false: system PiP, но с video-медиа', () => {
    expect(isInSystemPiPAudioOnlyContextFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: true }))).toBe(false);
  });
});

describe('preferSpeakerAfterHeadsetDisconnectFromState', () => {
  it('true на полноэкранном video-звонке', () => {
    expect(
      preferSpeakerAfterHeadsetDisconnectFromState(baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: true }))
    ).toBe(true);
  });
  it('true в in-app PiP с video', () => {
    expect(preferSpeakerAfterHeadsetDisconnectFromState(baseState({ pipVisible: true, prefersVideoMedia: true }))).toBe(true);
  });
  it('true в system PiP с video-медиа', () => {
    expect(
      preferSpeakerAfterHeadsetDisconnectFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: true }))
    ).toBe(true);
  });
  it('false на обычном audio-звонке без PiP', () => {
    expect(preferSpeakerAfterHeadsetDisconnectFromState(baseState())).toBe(false);
  });
});

describe('shouldDefaultToEarpieceAfterHeadsetDisconnectFromState', () => {
  it('false, если контекст уже предпочитает громкую связь (video)', () => {
    expect(
      shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(
        baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: true })
      )
    ).toBe(false);
  });
  it('true в system PiP на чистом audio-звонке', () => {
    expect(
      shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: false }))
    ).toBe(true);
  });
  it('уважает lockedRoute=SPEAKER_PHONE (пользователь явно закрепил громкую)', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ lockedRoute: 'SPEAKER_PHONE' }))).toBe(false);
  });
  it('уважает lockedRoute=EARPIECE', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ lockedRoute: 'EARPIECE' }))).toBe(true);
  });
  it('storedBuiltinRoute=SPEAKER_PHONE побеждает дефолт earpiece (если ничего не заблокировано)', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ storedBuiltinRoute: 'SPEAKER_PHONE' }))).toBe(false);
  });
  it('true на audio-only экране звонка', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ isAudioOnlyCallUi: true }))).toBe(true);
  });
  it('true, если виден in-app PiP (даже без явного audio-only флага)', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ pipVisible: true }))).toBe(true);
  });
  it('true вне экрана VideoCall (например, Home)', () => {
    expect(shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ currentRouteName: 'Home' }))).toBe(true);
  });
  it('на VideoCall без video-медиа (аудио на video-экране) — earpiece', () => {
    expect(
      shouldDefaultToEarpieceAfterHeadsetDisconnectFromState(baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: false }))
    ).toBe(true);
  });
});

describe('resolveCallRouteAfterHeadsetDisconnectFromState (главная точка входа)', () => {
  it('приоритет 1: явно закреплённый пользователем маршрут побеждает всё', () => {
    expect(
      resolveCallRouteAfterHeadsetDisconnectFromState(
        baseState({ lockedRoute: 'EARPIECE', currentRouteName: 'VideoCall', prefersVideoMedia: true })
      )
    ).toBe('EARPIECE');
  });

  it('приоритет 2: контекст, предпочитающий громкую связь (video), важнее сохранённого earpiece', () => {
    expect(
      resolveCallRouteAfterHeadsetDisconnectFromState(
        baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: true, storedBuiltinRoute: 'EARPIECE' })
      )
    ).toBe('SPEAKER_PHONE');
  });

  it('приоритет 3: сохранённый маршрут до подключения гарнитуры, если контекст нейтрален', () => {
    expect(resolveCallRouteAfterHeadsetDisconnectFromState(baseState({ storedBuiltinRoute: 'SPEAKER_PHONE' }))).toBe(
      'SPEAKER_PHONE'
    );
  });

  it('дефолт: обычный audio-звонок без истории и блокировок -> earpiece', () => {
    expect(resolveCallRouteAfterHeadsetDisconnectFromState(baseState())).toBe('EARPIECE');
  });

  it('обычный video-звонок на весь экран -> громкая связь', () => {
    expect(
      resolveCallRouteAfterHeadsetDisconnectFromState(baseState({ currentRouteName: 'VideoCall', prefersVideoMedia: true }))
    ).toBe('SPEAKER_PHONE');
  });

  it('система PiP с video-медиа -> громкая связь', () => {
    expect(
      resolveCallRouteAfterHeadsetDisconnectFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: true }))
    ).toBe('SPEAKER_PHONE');
  });

  it('система PiP на чистом audio -> earpiece', () => {
    expect(
      resolveCallRouteAfterHeadsetDisconnectFromState(baseState({ pipInSystemMode: true, prefersVideoMedia: false }))
    ).toBe('EARPIECE');
  });
});
