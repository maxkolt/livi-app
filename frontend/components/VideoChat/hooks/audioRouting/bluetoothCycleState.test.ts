import {
  armBtAutoSuppress,
  armBtKeepInCycleAfterManualLeave,
  armBtWearSticky,
  armExpectBtReconnect,
  clearBtAutoSuppress,
  clearBtRemovedFromCycleByUnplug,
  clearBtWearSticky,
  clearExpectBtReconnect,
  isBtKeepInCycleAfterManualLeave,
  isBtRemovedFromCycleByUnplug,
  isBtScoSettleActive,
  isBtWearStickyActive,
  isExpectBtReconnectActive,
  markBtRemovedFromCycleByUnplug,
  shouldShowBluetoothInCycle,
  shouldSuppressBluetoothAutoReconnect,
} from './bluetoothCycleState';

beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 });
  const g = global as any;
  for (const k of [
    '__btAutoSuppressUntilRef',
    '__btKeepInCycleAfterManualLeaveRef',
    '__btRemovedFromCycleByUnplugRef',
    '__btWearStickyUntilRef',
    '__btExpectReconnectUntilRef',
    '__lastBluetoothRouteApplyAtRef',
  ]) delete g[k];
});
afterEach(() => jest.useRealTimers());

describe('окно подавления авто-возврата на BT', () => {
  it('пока окно активно, sticky reconnect подавляется', () => {
    armBtAutoSuppress(12000);
    expect(shouldSuppressBluetoothAutoReconnect('audio_connected')).toBe(true);
  });

  it('после истечения окна подавление снимается само', () => {
    armBtAutoSuppress(12000);
    jest.advanceTimersByTime(12001);
    expect(shouldSuppressBluetoothAutoReconnect('audio_connected')).toBe(false);
  });

  it('физический connect снимает подавление сразу и насовсем', () => {
    armBtAutoSuppress(12000);
    expect(shouldSuppressBluetoothAutoReconnect('acl_connected')).toBe(false);
    // окно снято — следующий не-физический повод тоже уже не подавляется
    expect(shouldSuppressBluetoothAutoReconnect('poll_bt')).toBe(false);
  });

  it('expect_* физическим connect не считается — иначе кейс вернул бы BT', () => {
    armBtAutoSuppress(12000);
    expect(shouldSuppressBluetoothAutoReconnect('expect_acl_connected')).toBe(true);
  });

  it('clear снимает окно вручную', () => {
    armBtAutoSuppress(12000);
    clearBtAutoSuppress();
    expect(shouldSuppressBluetoothAutoReconnect('poll_bt')).toBe(false);
  });
});

describe('sticky-окна одевания и reconnect', () => {
  it('wear-sticky живёт заданное время', () => {
    armBtWearSticky(8000);
    expect(isBtWearStickyActive()).toBe(true);
    jest.advanceTimersByTime(7999);
    expect(isBtWearStickyActive()).toBe(true);
    jest.advanceTimersByTime(2);
    expect(isBtWearStickyActive()).toBe(false);
  });

  it('повторный arm не укорачивает уже большее окно', () => {
    armBtWearSticky(10000);
    armBtWearSticky(1000);
    jest.advanceTimersByTime(5000);
    expect(isBtWearStickyActive()).toBe(true);
  });

  it('ожидание reconnect ведёт себя так же', () => {
    armExpectBtReconnect(10000);
    armExpectBtReconnect(500);
    jest.advanceTimersByTime(5000);
    expect(isExpectBtReconnectActive()).toBe(true);
    clearExpectBtReconnect();
    expect(isExpectBtReconnectActive()).toBe(false);
  });

  it('clearBtWearSticky гасит окно', () => {
    armBtWearSticky(8000);
    clearBtWearSticky();
    expect(isBtWearStickyActive()).toBe(false);
  });
});

describe('окно дребезга SCO', () => {
  it('считается от более позднего из двух источников', () => {
    (global as any).__lastBluetoothRouteApplyAtRef = { current: Date.now() };
    expect(isBtScoSettleActive(0, 2500)).toBe(true);
    jest.advanceTimersByTime(2501);
    expect(isBtScoSettleActive(0, 2500)).toBe(false);
  });

  it('локальная метка тоже удерживает окно', () => {
    expect(isBtScoSettleActive(Date.now(), 2500)).toBe(true);
  });
});

describe('BT в цикле кнопки', () => {
  it('ручной уход с BT оставляет его в цикле — наушники ещё на ушах', () => {
    armBtKeepInCycleAfterManualLeave();
    expect(isBtKeepInCycleAfterManualLeave()).toBe(true);
    expect(shouldShowBluetoothInCycle()).toBe(true);
  });

  it('физическое снятие убирает BT из цикла и отменяет «оставить»', () => {
    armBtKeepInCycleAfterManualLeave();
    markBtRemovedFromCycleByUnplug();
    expect(isBtRemovedFromCycleByUnplug()).toBe(true);
    expect(isBtKeepInCycleAfterManualLeave()).toBe(false);
    expect(shouldShowBluetoothInCycle()).toBe(false);
  });

  it('снятие перевешивает всё остальное', () => {
    markBtRemovedFromCycleByUnplug();
    armBtWearSticky(8000);
    expect(shouldShowBluetoothInCycle({ userRoute: 'BLUETOOTH', wearInFlight: true })).toBe(false);
  });

  it('выбранный пользователем BT держит его в цикле', () => {
    expect(shouldShowBluetoothInCycle({ userRoute: 'BLUETOOTH' })).toBe(true);
    expect(shouldShowBluetoothInCycle({ lastApplied: 'BLUETOOTH' })).toBe(true);
  });

  it('идущее одевание держит BT в цикле', () => {
    expect(shouldShowBluetoothInCycle({ wearInFlight: true })).toBe(true);
  });

  it('без единого признака BT в цикле не показываем', () => {
    expect(shouldShowBluetoothInCycle()).toBe(false);
    expect(shouldShowBluetoothInCycle({ userRoute: 'EARPIECE' })).toBe(false);
  });

  it('после clear снятия BT снова может попасть в цикл', () => {
    markBtRemovedFromCycleByUnplug();
    clearBtRemovedFromCycleByUnplug();
    expect(shouldShowBluetoothInCycle({ userRoute: 'BLUETOOTH' })).toBe(true);
  });
});
