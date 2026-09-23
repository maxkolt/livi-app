import { readSystemPiPReturnGuard, readSystemPiPReturnState } from './systemPiPReturnGuard';

const NOW = 1_700_000_000_000;

function reset() {
  const g = global as any;
  for (const k of [
    '__systemPiPReturnStateRef',
    '__returningFromSystemPiPUntilRef',
    '__disableSystemPiPUntilRef',
    '__suppressAbortDuringSystemPiPReturnUntilRef',
  ]) delete g[k];
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  reset();
});
afterEach(() => jest.useRealTimers());
afterAll(reset);

describe('readSystemPiPReturnState', () => {
  it('без токена состояния нет', () => {
    expect(readSystemPiPReturnState(0)).toBeNull();
  });

  it('отдаёт состояние своего возврата', () => {
    const state = { token: 42, owner: 'screen', restoredAt: NOW };
    (global as any).__systemPiPReturnStateRef = { current: state };
    expect(readSystemPiPReturnState(42)).toBe(state);
  });

  it('хвост предыдущего возврата не подхватывается', () => {
    (global as any).__systemPiPReturnStateRef = { current: { token: 41, owner: 'screen' } };
    expect(readSystemPiPReturnState(42)).toBeNull();
  });
});

describe('readSystemPiPReturnGuard', () => {
  it('без активных окон возврат не идёт', () => {
    expect(readSystemPiPReturnGuard(0).active).toBe(false);
  });

  it.each([
    ['возврат из PiP', '__returningFromSystemPiPUntilRef'],
    ['подавление PiP', '__disableSystemPiPUntilRef'],
    ['подавление abort', '__suppressAbortDuringSystemPiPReturnUntilRef'],
  ])('окно «%s» делает возврат активным', (_label, key) => {
    (global as any)[key] = { current: NOW + 5000 };
    expect(readSystemPiPReturnGuard(0).active).toBe(true);
  });

  it('истёкшее окно больше не держит возврат', () => {
    (global as any).__returningFromSystemPiPUntilRef = { current: NOW - 1 };
    expect(readSystemPiPReturnGuard(0).active).toBe(false);
  });

  it('незавершённый restore держит возврат активным', () => {
    // Токен — это Date.now() момента разворота, поэтому он же и метка свежести.
    (global as any).__systemPiPReturnStateRef = { current: { token: NOW, owner: 'screen' } };
    expect(readSystemPiPReturnGuard(NOW).active).toBe(true);
  });

  it('но не вечно: устаревший restore перестаёт держать', () => {
    // token — это Date.now() момента разворота; по его возрасту и стареет restore.
    (global as any).__systemPiPReturnStateRef = { current: { token: NOW - 9000, owner: 'screen' } };
    expect(readSystemPiPReturnGuard(NOW - 9000).active).toBe(false);
  });

  it('состояние чужого возврата не влияет', () => {
    (global as any).__systemPiPReturnStateRef = { current: { token: 41, owner: 'screen' } };
    const guard = readSystemPiPReturnGuard(42);
    expect(guard.active).toBe(false);
    expect(guard.returnRestoreOwner).toBeNull();
  });

  it('возвращает окна наружу для логов и решений', () => {
    (global as any).__returningFromSystemPiPUntilRef = { current: NOW + 1000 };
    (global as any).__disableSystemPiPUntilRef = { current: NOW + 2000 };
    const guard = readSystemPiPReturnGuard(0);
    expect(guard.returningUntil).toBe(NOW + 1000);
    expect(guard.disableUntil).toBe(NOW + 2000);
  });
});
