/**
 * Переустановка приложения на Android: installId выводится из ANDROID_ID и переживает удаление,
 * а installSecret лежит в SecureStore и намеренно исключён из бэкапа — то есть теряется.
 * Сервер отвечает `unauthorized`, и без обработки этого случая пользователь не мог ни войти,
 * ни создать новый аккаунт: resetInstallId вернул бы ровно тот же выведенный из ANDROID_ID id.
 */

/** Ответы на identity:attach по порядку; остальные события обслуживаются отдельно. */
const attachResponses: Array<{ ok: boolean; userId?: string; error?: string }> = [];
const emitAckMock = jest.fn((event: string, _payload?: unknown) => {
  // Проверка существования пользователя идёт тем же emitAck — отвечаем «существует»,
  // иначе createUser уйдёт в ветку пересоздания и тест проверял бы не то.
  if (event === 'user:exists') return Promise.resolve({ ok: true, exists: true });
  if (event === 'identity:attach') {
    return Promise.resolve(attachResponses.shift() ?? { ok: false, error: 'unauthorized' });
  }
  return Promise.resolve({ ok: true });
});
const regenerateRandomInstallIdMock = jest.fn(async () => 'inst_fresh_random');
const getInstallIdMock = jest.fn(async () => 'inst_android_STABLE');
const getInstallSecretMock = jest.fn(async () => 'a'.repeat(64));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
}));

jest.mock('../../utils/installId', () => ({
  getInstallId: (...args: unknown[]) => getInstallIdMock(...(args as [])),
  getInstallSecret: (...args: unknown[]) => getInstallSecretMock(...(args as [])),
  resetInstallId: jest.fn(async () => undefined),
  regenerateRandomInstallId: (...args: unknown[]) => regenerateRandomInstallIdMock(...(args as [])),
}));

jest.mock('./emit', () => ({
  emitAck: (event: string, payload?: unknown) => emitAckMock(event, payload),
}));
jest.mock('./authState', () => ({ __notifyCurrentUserId: jest.fn() }));
jest.mock('./constants', () => ({
  API_BASE: 'https://api.test',
  isOid: (v: string) => /^[a-f\d]{24}$/i.test(String(v || '')),
}));
jest.mock('./outbox', () => ({ clearCancelledOutboxFingerprints: jest.fn() }));
jest.mock('./messages', () => ({ clearAllMessageCache: jest.fn() }));
jest.mock('./shared', () => ({
  shared: {
    currentUserId: null,
    userExistsCache: new Map(),
    pendingChecks: new Map(),
    pendingWaitLogged: new Set(),
    createUserPromise: null,
    lastUserExistsCacheLogAt: 0,
  },
}));
jest.mock('./socketCore', () => ({
  socket: { connected: true, emit: jest.fn(), on: jest.fn(), off: jest.fn() },
  getSocketInstance: () => ({ connected: true, emit: jest.fn() }),
}));
jest.mock('./connect', () => ({ applyAuthAndConnect: jest.fn(async () => undefined) }), { virtual: true });
jest.mock('./reauth', () => ({ emitReauthDeduped: jest.fn(async () => undefined) }), { virtual: true });
jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const USER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('createUser после переустановки приложения', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    attachResponses.length = 0;
    regenerateRandomInstallIdMock.mockResolvedValue('inst_fresh_random');
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never);
    getInstallIdMock.mockResolvedValue('inst_android_STABLE');
    getInstallSecretMock.mockResolvedValue('a'.repeat(64));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('при unauthorized переходит на случайный installId и заводит аккаунт', async () => {
    // Смена installId — крайняя мера, поэтому сначала несколько повторов с тем же id.
    attachResponses.push(
      { ok: false, error: 'unauthorized' },
      { ok: false, error: 'unauthorized' },
      { ok: false, error: 'unauthorized' },
      { ok: false, error: 'unauthorized' },
      { ok: true, userId: USER_ID },
    );

    const { createUser } = await import('./identity');
    const result = await createUser();

    expect(regenerateRandomInstallIdMock).toHaveBeenCalledTimes(1);
    expect(result).toBe(USER_ID);

    // Последняя попытка ушла уже с новым идентификатором, а не с выведенным из ANDROID_ID.
    const attachCalls = emitAckMock.mock.calls.filter((c) => c[0] === 'identity:attach');
    const lastPayload = attachCalls[attachCalls.length - 1]?.[1] as { installId?: string } | undefined;
    expect(lastPayload?.installId).toBe('inst_fresh_random');
  });

  it('не трогает installId, пока секрет не удалось прочитать', async () => {
    getInstallSecretMock.mockResolvedValue(null as unknown as string);
    // attachResponses пуст — по умолчанию отдаётся unauthorized на каждую попытку.

    const { createUser } = await import('./identity');
    await createUser();

    // Секрет не прочитан — отказ мог быть следствием сбоя SecureStore,
    // а не занятого installId. Живой аккаунт стирать нельзя.
    expect(regenerateRandomInstallIdMock).not.toHaveBeenCalled();
  });

  it('не меняет installId, пока отказ не повторился несколько раз', async () => {
    attachResponses.push(
      { ok: false, error: 'unauthorized' },
      { ok: false, error: 'unauthorized' },
      { ok: true, userId: USER_ID },
    );

    const { createUser } = await import('./identity');
    await createUser();

    expect(regenerateRandomInstallIdMock).not.toHaveBeenCalled();
  });
});
