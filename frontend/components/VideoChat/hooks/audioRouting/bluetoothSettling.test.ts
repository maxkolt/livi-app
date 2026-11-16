import {
  BT_SETTLING_WINDOW_MS,
  isBluetoothSettlingWindow,
  isBuiltInRouteCoercible,
  shouldDeferBluetoothUnplug,
} from './bluetoothSettling';

const checks = {
  isHeadsetDisconnectFallbackReason: (r: string) => r.startsWith('headset_unplug'),
  isExplicitBuiltInRouteChoice: (r: string, _route: any) => r === 'explicit',
};

describe('isBuiltInRouteCoercible', () => {
  it('гарнитуру не подменяем — она физическая', () => {
    expect(isBuiltInRouteCoercible('BLUETOOTH', 'applyRouting', checks)).toBe(false);
    expect(isBuiltInRouteCoercible('WIRED_HEADSET', 'applyRouting', checks)).toBe(false);
  });

  it('встроенный маршрут от автоматики подменить можно', () => {
    expect(isBuiltInRouteCoercible('EARPIECE', 'applyRouting', checks)).toBe(true);
    expect(isBuiltInRouteCoercible('SPEAKER_PHONE', 'bootstrap', checks)).toBe(true);
  });

  it('ручное действие пользователя неприкосновенно', () => {
    expect(isBuiltInRouteCoercible('EARPIECE', 'cycle', checks)).toBe(false);
    expect(isBuiltInRouteCoercible('EARPIECE', 'toggle_speaker', checks)).toBe(false);
    expect(isBuiltInRouteCoercible('EARPIECE', 'explicit', checks)).toBe(false);
  });

  it('откат после снятия гарнитуры тоже не подменяем', () => {
    expect(isBuiltInRouteCoercible('EARPIECE', 'headset_unplug_bt', checks)).toBe(false);
  });
});

describe('a lagging native poll during a physical Bluetooth connect', () => {
  const connecting = {
    routedOnBluetooth: true, callAudioActive: false, unplugged: false,
    now: 10_000, lastBluetoothApplyAt: 9_750, wearSticky: true, wearReconnectInFlight: false,
  };
  it('keeps the optimistic BT route when ACL precedes the HFP profile', () => {
    expect(shouldDeferBluetoothUnplug(connecting)).toBe(true);
    expect(shouldDeferBluetoothUnplug({ ...connecting, callAudioActive: true })).toBe(false);
  });
  it('lets a real unplug or a manual builtin choice win even during settling', () => {
    expect(shouldDeferBluetoothUnplug({ ...connecting, unplugged: true })).toBe(false);
    expect(shouldDeferBluetoothUnplug({ ...connecting, routedOnBluetooth: false })).toBe(false);
  });
  it('allows fallback if Bluetooth never establishes audio within the bounded window', () => {
    expect(shouldDeferBluetoothUnplug({ ...connecting, now: 20_000, wearSticky: false })).toBe(false);
  });
});

describe('isBluetoothSettlingWindow', () => {
  const base = { lastBluetoothApplyAt: 0, wearSticky: false, wearReconnectInFlight: false };

  it('только что надели — удерживаем независимо от времени', () => {
    expect(isBluetoothSettlingWindow({ ...base, wearSticky: true, now: 1e12 })).toBe(true);
  });

  it('идёт переподключение — удерживаем', () => {
    expect(isBluetoothSettlingWindow({ ...base, wearReconnectInFlight: true, now: 1e12 })).toBe(true);
  });

  it('свежее применение BT удерживает маршрут', () => {
    const now = 1_000_000;
    expect(isBluetoothSettlingWindow({ ...base, now, lastBluetoothApplyAt: now - 1 })).toBe(true);
    expect(
      isBluetoothSettlingWindow({ ...base, now, lastBluetoothApplyAt: now - (BT_SETTLING_WINDOW_MS - 1) }),
    ).toBe(true);
  });

  it('за пределами окна больше не удерживаем', () => {
    const now = 1_000_000;
    expect(
      isBluetoothSettlingWindow({ ...base, now, lastBluetoothApplyAt: now - BT_SETTLING_WINDOW_MS }),
    ).toBe(false);
    expect(isBluetoothSettlingWindow({ ...base, now, lastBluetoothApplyAt: now - 60_000 })).toBe(false);
  });

  it('без единого признака окна нет', () => {
    expect(isBluetoothSettlingWindow({ ...base, now: 1e12 })).toBe(false);
  });
});
