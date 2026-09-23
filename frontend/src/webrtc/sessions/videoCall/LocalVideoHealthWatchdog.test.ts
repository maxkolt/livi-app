import {
  LocalVideoHealthWatchdog,
  isLocalVideoStuck,
  shouldRunLocalVideoWatchdog,
  type DeviceWatchdogEnv,
  type LocalVideoHealthHost,
} from './LocalVideoHealthWatchdog';

describe('shouldRunLocalVideoWatchdog', () => {
  it('не запускается на iOS', () => {
    expect(shouldRunLocalVideoWatchdog({ os: 'ios', version: 18 })).toBe(false);
  });

  it('запускается на Android 8.1 и ниже (API ≤ 27)', () => {
    expect(shouldRunLocalVideoWatchdog({ os: 'android', version: 27 })).toBe(true);
    expect(shouldRunLocalVideoWatchdog({ os: 'android', version: 28 })).toBe(false);
  });

  it('запускается на OPPO-подобных прошивках независимо от версии', () => {
    expect(shouldRunLocalVideoWatchdog({ os: 'android', version: 34, brand: 'OPPO' })).toBe(true);
    expect(shouldRunLocalVideoWatchdog({ os: 'android', version: 34, manufacturer: 'oppo' })).toBe(true);
  });

  it('нечитаемая версия без OPPO не включает сторож', () => {
    expect(shouldRunLocalVideoWatchdog({ os: 'android', version: NaN, brand: 'samsung' })).toBe(false);
  });
});

describe('isLocalVideoStuck', () => {
  const zero = { frames: 0, bytes: 0, packets: 0 };

  it('полное отсутствие прогресса — залипание', () => {
    expect(isLocalVideoStuck(zero, zero)).toBe(true);
  });

  it('растущие кадры — не залипание', () => {
    expect(isLocalVideoStuck(zero, { frames: 1, bytes: 0, packets: 0 })).toBe(false);
  });

  it('заметный рост трафика — не залипание', () => {
    expect(isLocalVideoStuck(zero, { frames: 0, bytes: 5121, packets: 0 })).toBe(false);
  });

  it('мелкий фоновый трафик без кадров и пакетов — всё ещё залипание', () => {
    expect(isLocalVideoStuck(zero, { frames: 0, bytes: 5120, packets: 0 })).toBe(true);
  });

  it('растущие пакеты — не залипание', () => {
    expect(isLocalVideoStuck(zero, { frames: 0, bytes: 0, packets: 1 })).toBe(false);
  });
});

describe('LocalVideoHealthWatchdog', () => {
  const oppo: DeviceWatchdogEnv = { os: 'android', version: 30, brand: 'oppo' };
  const iphone: DeviceWatchdogEnv = { os: 'ios', version: 18 };

  /** Комната, отдающая заданную последовательность срезов статистики. */
  function makeHost(samples: Array<{ framesSent: number; bytesSent: number; packetsSent: number }>, over: Partial<LocalVideoHealthHost> = {}) {
    let call = 0;
    const track = { sid: 'v1', mediaStreamTrack: { readyState: 'live' } };
    const room = {
      state: 'connected',
      localParticipant: {
        getTrackStats: async () => {
          const sample = samples[Math.min(call, samples.length - 1)];
          call += 1;
          return [{ kind: 'video', trackSid: 'v1', ...sample }];
        },
      },
    };
    return {
      isCamOn: jest.fn(() => true),
      getRoom: jest.fn(() => room as any),
      getLocalVideoTrack: jest.fn(() => track as any),
      getCamSide: jest.fn(() => 'front'),
      recoverLocalVideo: jest.fn(async () => {}),
      ...over,
    } as LocalVideoHealthHost & Record<string, jest.Mock>;
  }

  const flat = { framesSent: 100, bytesSent: 1000, packetsSent: 10 };
  const growing = { framesSent: 200, bytesSent: 90000, packetsSent: 90 };

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    // Ремонт камеры логируется через logger.warn — в тестах это ожидаемый шум.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
  });

  async function runOnce(watchdog: LocalVideoHealthWatchdog, context = 'test') {
    const pending = watchdog.runOnce(context);
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
  }

  it('чинит камеру, когда статистика не растёт', async () => {
    const host = makeHost([flat]);
    await runOnce(new LocalVideoHealthWatchdog(host, () => oppo));
    expect(host.recoverLocalVideo).toHaveBeenCalledWith('test');
  });

  it('не трогает камеру, пока кадры идут', async () => {
    const host = makeHost([flat, growing]);
    await runOnce(new LocalVideoHealthWatchdog(host, () => oppo));
    expect(host.recoverLocalVideo).not.toHaveBeenCalled();
  });

  it('на здоровом устройстве не проверяет вовсе', async () => {
    const host = makeHost([flat]);
    await runOnce(new LocalVideoHealthWatchdog(host, () => iphone));
    expect(host.getRoom).not.toHaveBeenCalled();
    expect(host.recoverLocalVideo).not.toHaveBeenCalled();
  });

  it.each([
    ['камера выключена', { isCamOn: jest.fn(() => false) }],
    ['комната не подключена', { getRoom: jest.fn(() => ({ state: 'reconnecting' }) as any) }],
    ['трек завершён', { getLocalVideoTrack: jest.fn(() => ({ mediaStreamTrack: { readyState: 'ended' } }) as any) }],
    ['трека нет', { getLocalVideoTrack: jest.fn(() => null) }],
  ])('не чинит, когда %s', async (_label, over) => {
    const host = makeHost([flat], over as Partial<LocalVideoHealthHost>);
    await runOnce(new LocalVideoHealthWatchdog(host, () => oppo));
    expect(host.recoverLocalVideo).not.toHaveBeenCalled();
  });

  it('останавливается после двух попыток ремонта', async () => {
    const host = makeHost([flat]);
    const watchdog = new LocalVideoHealthWatchdog(host, () => oppo);
    await runOnce(watchdog);
    await runOnce(watchdog);
    await runOnce(watchdog);
    expect(host.recoverLocalVideo).toHaveBeenCalledTimes(2);
  });

  it('недоступная статистика читается как нули → ремонт (как и раньше)', async () => {
    const host = makeHost([flat], {
      getRoom: jest.fn(
        () =>
          ({
            state: 'connected',
            localParticipant: {
              getTrackStats: async () => {
                throw new Error('stats boom');
              },
            },
          }) as any
      ),
    });
    await runOnce(new LocalVideoHealthWatchdog(host, () => oppo));
    expect(host.recoverLocalVideo).toHaveBeenCalled();
  });

  it('падение ремонта не пробрасывается наружу', async () => {
    const host = makeHost([flat], {
      recoverLocalVideo: jest.fn(async () => {
        throw new Error('recover boom');
      }),
    });
    await expect(runOnce(new LocalVideoHealthWatchdog(host, () => oppo))).resolves.toBeUndefined();
  });

  it('schedule запускает проверку с задержкой, clear её отменяет', async () => {
    const host = makeHost([flat]);
    const watchdog = new LocalVideoHealthWatchdog(host, () => oppo);

    watchdog.schedule('scheduled');
    await jest.advanceTimersByTimeAsync(2799);
    expect(host.recoverLocalVideo).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1 + 2000);
    expect(host.recoverLocalVideo).toHaveBeenCalledWith('scheduled');

    const other = makeHost([flat]);
    const cancelled = new LocalVideoHealthWatchdog(other, () => oppo);
    cancelled.schedule('cancelled');
    cancelled.clear();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(other.recoverLocalVideo).not.toHaveBeenCalled();
  });

  it('schedule на здоровом устройстве ничего не планирует', async () => {
    const host = makeHost([flat]);
    new LocalVideoHealthWatchdog(host, () => iphone).schedule('noop');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(host.recoverLocalVideo).not.toHaveBeenCalled();
  });
});
