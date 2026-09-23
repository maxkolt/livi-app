import {
  clearDirectCallAudioAcceptBootstrapped,
  clearDirectCallUserRequestedVideoExpand,
  markDirectCallAudioAcceptBootstrapped,
  markDirectCallUserRequestedVideoExpand,
} from '../../../utils/directCallVideoExpandGuard';
import {
  hasAuthenticDirectCallVideoPiPReturnIntent,
  isAcceptedVideoCallNavCallId,
  isExplicitDirectCallVideoPiPReturnRoute,
  isFreshDirectCallAudioAcceptRoute,
} from './callRouteIntent';

const CALL = 'call-1';

function resetGlobals() {
  const g = global as any;
  g.__acceptedVideoCallNavCallIdRef = { current: '' };
  g.__expandToVideoCallUiFromPiPRef = { current: false };
  g.__pipReturnToCallInFlightRef = { current: false };
  g.__systemPiPReturnTokenRef = { current: 0 };
  g.__outgoingCallPeerUserIdRef = { current: '' };
  g.__stayOnVideoCallUiRef = { current: false };
}

beforeEach(() => {
  resetGlobals();
  clearDirectCallUserRequestedVideoExpand();
  clearDirectCallAudioAcceptBootstrapped();
});

describe('isAcceptedVideoCallNavCallId', () => {
  it('совпадает только с текущим принятым звонком', () => {
    (global as any).__acceptedVideoCallNavCallIdRef.current = CALL;
    expect(isAcceptedVideoCallNavCallId(CALL)).toBe(true);
    expect(isAcceptedVideoCallNavCallId('other')).toBe(false);
  });

  it('пустой callId никогда не совпадает', () => {
    (global as any).__acceptedVideoCallNavCallIdRef.current = CALL;
    expect(isAcceptedVideoCallNavCallId('')).toBe(false);
    expect(isAcceptedVideoCallNavCallId(null)).toBe(false);
  });
});

describe('hasAuthenticDirectCallVideoPiPReturnIntent', () => {
  it('по умолчанию намерения нет', () => {
    expect(hasAuthenticDirectCallVideoPiPReturnIntent()).toBe(false);
  });

  it('явный запрос пользователя на видео — это намерение', () => {
    markDirectCallUserRequestedVideoExpand();
    expect(hasAuthenticDirectCallVideoPiPReturnIntent()).toBe(true);
  });

  it('флаг разворота из PiP — тоже', () => {
    (global as any).__expandToVideoCallUiFromPiPRef.current = true;
    expect(hasAuthenticDirectCallVideoPiPReturnIntent()).toBe(true);
  });

  it('возврат из системного PiP засчитывается только с токеном возврата', () => {
    (global as any).__pipReturnToCallInFlightRef.current = true;
    expect(hasAuthenticDirectCallVideoPiPReturnIntent()).toBe(false);
    (global as any).__systemPiPReturnTokenRef.current = 1;
    expect(hasAuthenticDirectCallVideoPiPReturnIntent()).toBe(true);
  });
});

describe('isExplicitDirectCallVideoPiPReturnRoute', () => {
  const fullReturn = { fromPiP: true, resume: true, preferVideoCallUi: true, callId: CALL };

  it('полный набор флагов + bootstrap + намерение = настоящий возврат в видео', () => {
    markDirectCallAudioAcceptBootstrapped(CALL);
    markDirectCallUserRequestedVideoExpand();
    expect(isExplicitDirectCallVideoPiPReturnRoute(fullReturn)).toBe(true);
  });

  it.each([
    ['без fromPiP', { ...fullReturn, fromPiP: false }],
    ['без resume', { ...fullReturn, resume: false }],
    ['без preferVideoCallUi', { ...fullReturn, preferVideoCallUi: false }],
    ['с audioOnlyPiPReturn', { ...fullReturn, audioOnlyPiPReturn: true }],
  ])('%s — не возврат в видео', (_label, params) => {
    markDirectCallAudioAcceptBootstrapped(CALL);
    markDirectCallUserRequestedVideoExpand();
    expect(isExplicitDirectCallVideoPiPReturnRoute(params)).toBe(false);
  });

  it('без bootstrap звонка флаги маршрута не в счёт — это протухшие параметры', () => {
    markDirectCallUserRequestedVideoExpand();
    expect(isExplicitDirectCallVideoPiPReturnRoute(fullReturn)).toBe(false);
  });

  it('без намерения не открываем видео поверх аудио-звонка', () => {
    markDirectCallAudioAcceptBootstrapped(CALL);
    expect(isExplicitDirectCallVideoPiPReturnRoute(fullReturn)).toBe(false);
  });

  it('пустой payload безопасен', () => {
    expect(isExplicitDirectCallVideoPiPReturnRoute(null)).toBe(false);
    expect(isExplicitDirectCallVideoPiPReturnRoute(undefined)).toBe(false);
  });
});

describe('isFreshDirectCallAudioAcceptRoute', () => {
  it('входящий звонок без PiP-флагов — свежий приём', () => {
    expect(isFreshDirectCallAudioAcceptRoute({ isIncoming: true, callId: CALL })).toBe(true);
  });

  it('исходящий от инициатора — тоже', () => {
    expect(isFreshDirectCallAudioAcceptRoute({ directInitiator: true, callId: CALL })).toBe(true);
  });

  it('совпадение с ожидаемым собеседником исходящего — тоже', () => {
    (global as any).__outgoingCallPeerUserIdRef.current = 'peer-9';
    expect(isFreshDirectCallAudioAcceptRoute({ peerUserId: 'peer-9', callId: CALL })).toBe(true);
    expect(isFreshDirectCallAudioAcceptRoute({ peerUserId: 'peer-8', callId: CALL })).toBe(false);
  });

  it.each([
    ['fromPiP', { fromPiP: true }],
    ['resume', { resume: true }],
    ['preferVideoCallUi', { preferVideoCallUi: true }],
    ['audioOnlyPiPReturn', { audioOnlyPiPReturn: true }],
  ])('любой возвратный флаг (%s) исключает «свежий приём»', (_l, extra) => {
    expect(isFreshDirectCallAudioAcceptRoute({ isIncoming: true, callId: CALL, ...extra })).toBe(false);
  });

  it('уже загруженный звонок не считается свежим приёмом', () => {
    markDirectCallAudioAcceptBootstrapped(CALL);
    expect(isFreshDirectCallAudioAcceptRoute({ isIncoming: true, callId: CALL })).toBe(false);
  });

  it('принятый видеозвонок опознаётся даже после bootstrap', () => {
    (global as any).__acceptedVideoCallNavCallIdRef.current = CALL;
    expect(isFreshDirectCallAudioAcceptRoute({ callId: CALL })).toBe(true);
  });

  it('пустой payload безопасен', () => {
    expect(isFreshDirectCallAudioAcceptRoute(null)).toBe(false);
    expect(isFreshDirectCallAudioAcceptRoute(undefined)).toBe(false);
  });
});
