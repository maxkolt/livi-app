import {
  markActiveCallAudioRouteCallId,
  rememberManualBuiltinCallAudioRoute,
  setUserSelectedCallAudioRoute,
} from '../../../../utils/activeCallSession';
import type { InCallAudioRoute } from '../audioRouteTypes';
import { pickDesiredRoute, type PickDesiredRouteContext } from './pickDesiredRoute';
import { setExplicitBuiltInGlobal } from './explicitRouteChoice';

const BUILTIN = ['EARPIECE', 'SPEAKER_PHONE'];
const WITH_BT = [...BUILTIN, 'BLUETOOTH'];
const WITH_WIRED = [...BUILTIN, 'WIRED_HEADSET'];

function makeCtx(over: Partial<PickDesiredRouteContext> = {}) {
  let userRoute: InCallAudioRoute = 'EARPIECE';
  const ctx: PickDesiredRouteContext = {
    routingOptionsRef: { current: { defaultToEarpiece: true } },
    deviceChangeContextRef: { current: { gainedWired: false, gainedBt: false } },
    explicitBuiltInChoiceRef: { current: false },
    lastAppliedRouteRef: { current: '' },
    getUserRoute: () => userRoute,
    setUserRoute: (r) => { userRoute = r; },
    readStickyExternalRouteForAutoRepin: () => null,
    reconcileRouteAfterHeadsetDisconnect: () => null,
    ...over,
  } as PickDesiredRouteContext;
  return ctx;
}

function reset() {
  const g = global as any;
  for (const k of Object.keys(g)) {
    if (/CallAudio|callAudio|BuiltIn|builtin|Builtin|Headset|headset|bt[A-Z]/.test(k)) {
      try { delete g[k]; } catch {}
    }
  }
  setUserSelectedCallAudioRoute(null);
  setExplicitBuiltInGlobal(false);
  markActiveCallAudioRouteCallId('call-under-test');
}
beforeEach(reset);
afterAll(reset);

describe('подключение гарнитуры перебивает прежний выбор', () => {
  it('надетый Bluetooth выигрывает', () => {
    const ctx = makeCtx({ deviceChangeContextRef: { current: { gainedWired: false, gainedBt: true } } });
    expect(pickDesiredRoute(WITH_BT, 'onAudioDeviceChanged_gained_bt', ctx)).toBe('BLUETOOTH');
  });

  it('воткнутый провод выигрывает', () => {
    const ctx = makeCtx({ deviceChangeContextRef: { current: { gainedWired: true, gainedBt: false } } });
    expect(pickDesiredRoute(WITH_WIRED, 'WiredHeadset', ctx)).toBe('WIRED_HEADSET');
  });

  it('но только если устройство реально в списке доступных', () => {
    const ctx = makeCtx({ deviceChangeContextRef: { current: { gainedWired: false, gainedBt: true } } });
    expect(pickDesiredRoute(BUILTIN, 'onAudioDeviceChanged_gained_bt', ctx)).not.toBe('BLUETOOTH');
  });
});

describe('выбор пользователя', () => {
  it('явно выбранная гарнитура удерживается', () => {
    setUserSelectedCallAudioRoute('BLUETOOTH');
    expect(pickDesiredRoute(WITH_BT, 'applyRouting', makeCtx())).toBe('BLUETOOTH');
  });

  it('выбранная гарнитура удерживается, даже если её нет в списке доступных', () => {
    // Намеренно: список устройств от InCallManager врёт, пока поднимается SCO —
    // если верить ему буквально, звук будет срываться с наушников на телефон.
    setUserSelectedCallAudioRoute('BLUETOOTH');
    expect(pickDesiredRoute(BUILTIN, 'applyRouting', makeCtx())).toBe('BLUETOOTH');
  });

  it('но на ручное действие пользователя гарнитура уже не навязывается', () => {
    setUserSelectedCallAudioRoute('BLUETOOTH');
    const route = pickDesiredRoute(BUILTIN, 'cycle', makeCtx());
    expect(route).not.toBe('BLUETOOTH');
  });

  it('залоченный встроенный маршрут удерживается против автоматики', () => {
    rememberManualBuiltinCallAudioRoute('SPEAKER_PHONE');
    expect(pickDesiredRoute(BUILTIN, 'applyRouting', makeCtx())).toBe('SPEAKER_PHONE');
  });

  it('явный встроенный выбор удерживается и при доступном BT', () => {
    const ctx = makeCtx({ explicitBuiltInChoiceRef: { current: true } });
    ctx.setUserRoute('EARPIECE');
    expect(pickDesiredRoute(WITH_BT, 'applyRouting', ctx)).toBe('EARPIECE');
  });
});

describe('UI-лок', () => {
  it('перебивает всё, кроме только что надетой гарнитуры', () => {
    const { armCallAudioRouteUiLock } = require('../../../../utils/callAudioRouteTransitionGuards');
    armCallAudioRouteUiLock('SPEAKER_PHONE');
    expect(pickDesiredRoute(BUILTIN, 'applyRouting', makeCtx())).toBe('SPEAKER_PHONE');
  });
});

describe('отключение гарнитуры', () => {
  it('сохранённый встроенный маршрут возвращается', () => {
    const ctx = makeCtx({ reconcileRouteAfterHeadsetDisconnect: () => 'SPEAKER_PHONE' });
    expect(pickDesiredRoute(BUILTIN, 'headset_unplug', ctx)).toBe('SPEAKER_PHONE');
  });

  it('когда возвращать нечего — выбирается встроенный, а не гарнитура', () => {
    const ctx = makeCtx();
    const route = pickDesiredRoute(BUILTIN, 'headset_unplug', ctx);
    expect(BUILTIN).toContain(route);
  });
});

describe('всегда отдаёт применимый маршрут', () => {
  it.each([
    ['bootstrap', BUILTIN],
    ['applyRouting', WITH_BT],
    ['poll_1000', WITH_WIRED],
    ['cycle', BUILTIN],
    ['remote_stream', WITH_BT],
  ])('причина «%s» даёт маршрут из известных', (reason, available) => {
    const route = pickDesiredRoute(available as string[], reason as string, makeCtx());
    expect(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH', 'WIRED_HEADSET']).toContain(route);
  });

  it('пустой список доступных устройств не роняет выбор', () => {
    const route = pickDesiredRoute([], 'applyRouting', makeCtx());
    expect(typeof route).toBe('string');
    expect(route.length).toBeGreaterThan(0);
  });
});
