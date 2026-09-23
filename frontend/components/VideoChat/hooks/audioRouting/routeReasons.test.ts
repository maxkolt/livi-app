import {
  defaultUserRoute,
  isHeadsetDisconnectFallbackReason,
  isHeadsetUnplugReason,
  isPhysicalHeadsetGainReason,
  shouldPreferBluetoothEarlyInCall,
} from './routeReasons';

describe('defaultUserRoute', () => {
  it('аудио-звонок стартует с разговорного динамика', () => {
    expect(defaultUserRoute({ defaultToEarpiece: true })).toBe('EARPIECE');
  });

  it('иначе — громкая связь', () => {
    expect(defaultUserRoute({ defaultToEarpiece: false })).toBe('SPEAKER_PHONE');
    expect(defaultUserRoute(undefined)).toBe('SPEAKER_PHONE');
  });
});

describe('isPhysicalHeadsetGainReason', () => {
  const none = { gainedBt: false, gainedWired: false };

  it('фактическое подключение важнее причины', () => {
    expect(isPhysicalHeadsetGainReason('bootstrap', { gainedBt: true, gainedWired: false })).toBe(true);
    expect(isPhysicalHeadsetGainReason('bootstrap', { gainedBt: false, gainedWired: true })).toBe(true);
  });

  it.each(['headset_poll_bt', 'onAudioDeviceChanged_gained_bt', 'WiredHeadset'])(
    'причина «%s» считается подключением',
    (r) => expect(isPhysicalHeadsetGainReason(r, none)).toBe(true),
  );

  it('обычная автоматика подключением не считается', () => {
    expect(isPhysicalHeadsetGainReason('applyRouting', none)).toBe(false);
    expect(isPhysicalHeadsetGainReason('cycle', none)).toBe(false);
  });
});

describe('shouldPreferBluetoothEarlyInCall', () => {
  it.each(['bootstrap', 'poll_1000', 'applyRouting', 'remote_stream', 'native_probe'])(
    '«%s» допускает ранний автоподхват BT',
    (r) => expect(shouldPreferBluetoothEarlyInCall(r)).toBe(true),
  );

  it('ручное действие пользователя сюда не попадает', () => {
    expect(shouldPreferBluetoothEarlyInCall('cycle')).toBe(false);
    expect(shouldPreferBluetoothEarlyInCall('toggle_speaker')).toBe(false);
  });
});

describe('причины отключения гарнитуры', () => {
  it.each(['WiredHeadset_unplug', 'headset_poll_unplug', 'headset_bt_unplug', 'headset_unplug'])(
    '«%s» — снятие гарнитуры',
    (r) => expect(isHeadsetUnplugReason(r)).toBe(true),
  );

  it('подключение снятием не считается', () => {
    expect(isHeadsetUnplugReason('headset_poll_bt')).toBe(false);
  });

  it.each(['headset_unplug', 'headset_bt_unplug', 'headset_poll_bt_inactive', 'native_bt_unwear_x'])(
    '«%s» — повод откатиться на сохранённый встроенный маршрут',
    (r) => expect(isHeadsetDisconnectFallbackReason(r)).toBe(true),
  );

  it('обычная автоматика откат не запускает', () => {
    expect(isHeadsetDisconnectFallbackReason('applyRouting')).toBe(false);
  });
});
