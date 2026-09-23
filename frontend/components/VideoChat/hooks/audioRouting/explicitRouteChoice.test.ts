import {
  markActiveCallAudioRouteCallId,
  rememberManualBuiltinCallAudioRoute,
  setUserSelectedCallAudioRoute,
} from '../../../../utils/activeCallSession';
import {
  hasExplicitBuiltInIntent,
  isExplicitBuiltInRouteChoice,
  isManualRouteReason,
  readExplicitBuiltInFromGlobal,
  readExplicitUserSelectedBuiltInRoute,
  readUserSelectedBuiltInRoute,
  readUserSelectedExternalRoute,
  setExplicitBuiltInGlobal,
  userLockedBuiltinAudioOutput,
} from './explicitRouteChoice';

function reset() {
  const g = global as any;
  for (const k of Object.keys(g)) {
    if (/CallAudio|callAudio|BuiltIn|builtin|Builtin/i.test(k)) {
      try { delete g[k]; } catch {}
    }
  }
  setUserSelectedCallAudioRoute(null);
  setExplicitBuiltInGlobal(false);
  // Ручной выбор привязан к звонку: без активного callId он не читается.
  markActiveCallAudioRouteCallId('call-under-test');
}
beforeEach(reset);
afterAll(reset);

describe('флаг «выбрал встроенный маршрут сам»', () => {
  it('по умолчанию не выставлен', () => {
    expect(readExplicitBuiltInFromGlobal()).toBe(false);
  });

  it('ставится и снимается', () => {
    setExplicitBuiltInGlobal(true);
    expect(readExplicitBuiltInFromGlobal()).toBe(true);
    setExplicitBuiltInGlobal(false);
    expect(readExplicitBuiltInFromGlobal()).toBe(false);
  });
});

describe('readUserSelectedBuiltInRoute', () => {
  it('отдаёт только встроенные маршруты', () => {
    setUserSelectedCallAudioRoute('EARPIECE');
    expect(readUserSelectedBuiltInRoute()).toBe('EARPIECE');
    setUserSelectedCallAudioRoute('SPEAKER_PHONE');
    expect(readUserSelectedBuiltInRoute()).toBe('SPEAKER_PHONE');
  });

  it('гарнитура встроенным маршрутом не считается', () => {
    setUserSelectedCallAudioRoute('BLUETOOTH');
    expect(readUserSelectedBuiltInRoute()).toBeNull();
    expect(readUserSelectedExternalRoute()).toBe('BLUETOOTH');
  });
});

describe('readExplicitUserSelectedBuiltInRoute', () => {
  it('без явного флага выбор не считается явным', () => {
    setUserSelectedCallAudioRoute('EARPIECE');
    expect(readExplicitUserSelectedBuiltInRoute()).toBeNull();
  });

  it('с явным флагом выбор засчитывается', () => {
    setUserSelectedCallAudioRoute('EARPIECE');
    setExplicitBuiltInGlobal(true);
    expect(readExplicitUserSelectedBuiltInRoute()).toBe('EARPIECE');
  });

  it('ручной выбор через cycle засчитывается и без флага', () => {
    rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
    expect(readExplicitUserSelectedBuiltInRoute()).toBe('SPEAKER_PHONE');
    expect(userLockedBuiltinAudioOutput()).toBe(true);
  });
});

describe('привязка ручного выбора к звонку', () => {
  it('выбор из прошлого звонка не протекает в новый', () => {
    rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
    expect(userLockedBuiltinAudioOutput()).toBe(true);

    markActiveCallAudioRouteCallId('another-call');
    expect(userLockedBuiltinAudioOutput()).toBe(false);
    expect(readExplicitUserSelectedBuiltInRoute()).toBeNull();
  });
});

describe('hasExplicitBuiltInIntent', () => {
  it('без выбора намерения нет', () => {
    expect(hasExplicitBuiltInIntent()).toBe(false);
  });

  it('совпадение с явно выбранным маршрутом', () => {
    rememberManualBuiltinCallAudioRoute('EARPIECE');
    expect(hasExplicitBuiltInIntent('EARPIECE')).toBe(true);
    expect(hasExplicitBuiltInIntent('SPEAKER_PHONE')).toBe(false);
  });

  it('без указания маршрута достаточно самого факта выбора', () => {
    rememberManualBuiltinCallAudioRoute('EARPIECE');
    expect(hasExplicitBuiltInIntent()).toBe(true);
  });
});

describe('isManualRouteReason', () => {
  it.each(['cycle', 'cycle_user', 'toggle', 'toggle_speaker', 'in_app_pip_audio_route_toggle'])(
    '«%s» — ручное действие пользователя',
    (reason) => expect(isManualRouteReason(reason)).toBe(true),
  );

  it.each(['bootstrap', 'poll_bt', 'applyRouting', 'onAudioDeviceChanged'])(
    '«%s» — автоматика',
    (reason) => expect(isManualRouteReason(reason)).toBe(false),
  );
});

describe('isExplicitBuiltInRouteChoice', () => {
  it('гарнитура встроенным выбором быть не может', () => {
    expect(isExplicitBuiltInRouteChoice('cycle', 'BLUETOOTH')).toBe(false);
    expect(isExplicitBuiltInRouteChoice('cycle', 'WIRED_HEADSET')).toBe(false);
  });

  it('ручная причина делает выбор явным', () => {
    expect(isExplicitBuiltInRouteChoice('cycle', 'EARPIECE')).toBe(true);
    expect(isExplicitBuiltInRouteChoice('toggle', 'SPEAKER_PHONE')).toBe(true);
  });

  it('залоченный пользователем маршрут — явный выбор', () => {
    rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
    expect(isExplicitBuiltInRouteChoice('bootstrap', 'SPEAKER_PHONE')).toBe(true);
  });

  it('автоматика без выбора пользователя явным выбором не считается', () => {
    expect(isExplicitBuiltInRouteChoice('bootstrap', 'EARPIECE')).toBe(false);
    expect(isExplicitBuiltInRouteChoice('poll_bt', 'SPEAKER_PHONE')).toBe(false);
  });

  it('приём аудио-звонка: ухо да, громкая — только если залочена', () => {
    expect(isExplicitBuiltInRouteChoice('direct_call_accept_audio_route', 'EARPIECE')).toBe(true);
    expect(isExplicitBuiltInRouteChoice('direct_call_accept_audio_route', 'SPEAKER_PHONE')).toBe(false);
    rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
    expect(isExplicitBuiltInRouteChoice('direct_call_accept_audio_route', 'SPEAKER_PHONE')).toBe(true);
  });

  it('native repin сохраняет оба встроенных маршрута', () => {
    expect(isExplicitBuiltInRouteChoice('something_native_repin', 'EARPIECE')).toBe(true);
    expect(isExplicitBuiltInRouteChoice('something_native_repin', 'SPEAKER_PHONE')).toBe(true);
  });

  it('возврат на аудио-экран уважает выбор пользователя', () => {
    setUserSelectedCallAudioRoute('SPEAKER_PHONE');
    expect(isExplicitBuiltInRouteChoice('return_to_audio_ui', 'SPEAKER_PHONE')).toBe(true);
    expect(isExplicitBuiltInRouteChoice('return_to_audio_ui', 'EARPIECE')).toBe(false);
  });
});
