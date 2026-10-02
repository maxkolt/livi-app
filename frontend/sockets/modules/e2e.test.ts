/**
 * Сквозное шифрование целиком на клиенте: два пользователя и поддельный сервер,
 * который ведёт себя как backend/sockets/e2eKeys.ts. Ключ создаётся без пароля
 * и переживает переустановку в KeyVault; пароль нужен только для миграции старых копий.
 */

const secure = new Map<string, string>();
const vault = new Map<string, string>();
const storage = new Map<string, string>();
const mockKeyVault = {
  readFails: false,
  save: jest.fn(async (k: string, v: string) => {
    vault.set(k, v);
    return true;
  }),
  load: jest.fn(async (k: string) => {
    if (mockKeyVault.readFails) throw new Error('vault unavailable');
    return vault.get(k) ?? null;
  }),
  remove: jest.fn(async (k: string) => {
    vault.delete(k);
    return true;
  }),
};

jest.mock('react-native-get-random-values', () => ({}), { virtual: true });
jest.mock('react-native', () => ({ NativeModules: { LiviKeyVault: mockKeyVault } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => secure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    secure.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    secure.delete(k);
  }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => storage.get(k) ?? null),
  setItem: jest.fn(async (k: string, v: string) => {
    storage.set(k, v);
  }),
  removeItem: jest.fn(async (k: string) => {
    storage.delete(k);
  }),
  multiRemove: jest.fn(async (keys: string[]) => {
    for (const k of keys) storage.delete(k);
  }),
}));

const mockShared: { currentUserId?: string } = {};
jest.mock('./shared', () => ({ shared: mockShared }));
const mockSocket = { connected: true, on: jest.fn() };
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));

/** Поддельный сервер: публичные ключи и копии, как в e2eKeys.ts (authKey сравнивается напрямую). */
const server = {
  keys: new Map<string, string>(),
  backups: new Map<string, any>(),
  disabled: new Set<string>(),
  fetchAttempts: 0,
  down: false,
};
const mockEmitAck = jest.fn(async (event: string, payload: any, ..._opts: unknown[]) => {
  if (server.down) throw new Error('timeout');
  const me = String(mockShared.currentUserId);
  switch (event) {
    case 'e2e:state': {
      const b = server.backups.get(me);
      return {
        ok: true,
        publicKey: server.keys.get(me) ?? '',
        backup: b ? { kdf: b.kdf, pk: b.pk } : null,
        disabled: server.disabled.has(me),
      };
    }
    case 'e2e:publish':
      if (payload.backup && payload.backup.pk !== payload.publicKey) return { ok: false, error: 'invalid_backup' };
      server.keys.set(me, payload.publicKey);
      server.disabled.delete(me);
      if (payload.backup) server.backups.set(me, payload.backup);
      return { ok: true };
    case 'e2e:backup_fetch': {
      server.fetchAttempts += 1;
      const b = server.backups.get(me);
      if (!b) return { ok: false, error: 'no_backup' };
      if (payload.authKey !== b.authKey) return { ok: false, error: 'wrong_password' };
      const { authKey: _secret, ...rest } = b;
      return { ok: true, backup: rest };
    }
    case 'e2e:disable':
      server.keys.set(me, '');
      server.disabled.add(me);
      return { ok: true };
    case 'e2e:enable': {
      const b = server.backups.get(me);
      if (!b || b.pk !== payload.publicKey) return { ok: false, error: 'no_backup' };
      server.keys.set(me, payload.publicKey);
      server.disabled.delete(me);
      return { ok: true };
    }
    case 'e2e:keys': {
      const keys: Record<string, string> = {};
      for (const id of payload.userIds) keys[id] = server.keys.get(id) ?? '';
      return { ok: true, keys };
    }
    default:
      throw new Error(`unexpected ${event}`);
  }
});
jest.mock('./emit', () => ({ emitAck: (e: string, p: any, ...opts: unknown[]) => mockEmitAck(e, p, ...opts) }));

import {
  decryptIncomingMessage,
  changeE2eBackupPassword,
  deleteLocalE2eKey,
  E2eUnavailableError,
  disableE2e,
  enableE2eAgain,
  getE2eStatus,
  hasLocalE2eKey,
  markE2eChatNoticeSeen,
  onPeerKeyChanged,
  refreshE2eState,
  resetE2e,
  restoreE2e,
  toWireEditPayload,
  toWireMessagePayload,
  wasE2eChatNoticeSeen,
} from './e2e';

jest.setTimeout(60_000);

const ALICE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'bbbbbbbbbbbbbbbbbbbbbbbb';
/** Сменить пользователя. Модуль замечает смену при следующем обращении — обращаемся сразу. */
const as = (user: string) => {
  mockShared.currentUserId = user;
  getE2eStatus();
};
const placeholder = () => 'UNDECRYPTABLE';

/** Как сообщение выглядит после сервера: метаданные + то, что ушло в сеть. */
const delivered = (wire: any) => ({ id: wire.clientMessageId, from: ALICE, to: BOB, type: 'text', ...wire });

beforeEach(() => {
  secure.clear();
  vault.clear();
  storage.clear();
  server.keys.clear();
  server.backups.clear();
  server.disabled.clear();
  server.fetchAttempts = 0;
  server.down = false;
  mockKeyVault.readFails = false;
  mockSocket.connected = true;
  as('');
});

async function enable(user: string) {
  as(user);
  expect(await refreshE2eState()).toBe('ready');
}

/** Создать копию прежней схемы для проверки миграции. */
async function enableLegacy(user: string, password: string) {
  await enable(user);
  expect(await changeE2eBackupPassword(password)).toEqual({ ok: true });
}

const textPayload = (over: Record<string, unknown> = {}) => ({
  to: BOB,
  type: 'text',
  text: 'секретный текст',
  clientMessageId: 'cm_1',
  replyTo: { id: 'm0', text: 'цитата', from: BOB },
  ...over,
});

describe('automatic setup without a password', () => {
  it('creates, stores and publishes a key on the first state refresh', async () => {
    as(ALICE);
    expect(await refreshE2eState()).toBe('ready');
    expect(server.keys.get(ALICE)).toBeTruthy();
    expect(server.backups.has(ALICE)).toBe(false);
    expect([...secure.values()]).toEqual([...vault.values()]);
  });

  it('sends plain text to a contact who has not published a key yet', async () => {
    await enable(ALICE);
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
  });
});

describe('between two users with encryption on', () => {
  beforeEach(async () => {
    await enable(BOB);
    await enable(ALICE);
  });

  it('never puts the text or the quote on the wire', async () => {
    const wire: any = await toWireMessagePayload(textPayload());
    expect(wire.text).toBeUndefined();
    expect(wire.replyTo).toEqual({ id: 'm0', from: BOB });
    expect(JSON.stringify(wire)).not.toContain('секретный');
    expect(JSON.stringify(wire)).not.toContain('цитата');
  });

  it('is readable by the recipient and by the sender', async () => {
    const wire = await toWireMessagePayload(textPayload());
    as(BOB);
    const forBob: any = await decryptIncomingMessage(delivered(wire), placeholder);
    expect(forBob).toMatchObject({ text: 'секретный текст', replyTo: { id: 'm0', text: 'цитата' }, e2e: true });
    expect(forBob.enc).toBeUndefined();
    as(ALICE);
    const forAlice: any = await decryptIncomingMessage(delivered(wire), placeholder);
    expect(forAlice.text).toBe('секретный текст');
  });

  it('leaves non-text messages alone', async () => {
    const image = { to: BOB, type: 'image', uri: 'https://x/y.jpg', clientMessageId: 'cm_2' };
    expect(await toWireMessagePayload(image)).toEqual(image);
  });

  it('encrypts edits for the chat peer', async () => {
    const wire: any = await toWireEditPayload('cm_1', 'исправлено', BOB);
    expect(wire.text).toBeUndefined();
    as(BOB);
    const m: any = await decryptIncomingMessage({ id: 'cm_1', from: ALICE, to: BOB, enc: wire.enc }, placeholder);
    expect(m.text).toBe('исправлено');
  });

  it('shows a placeholder instead of a message whose id was swapped by the server', async () => {
    const wire = await toWireMessagePayload(textPayload());
    as(BOB);
    const m: any = await decryptIncomingMessage({ ...delivered(wire), id: 'cm_other' }, placeholder);
    expect(m).toMatchObject({ text: 'UNDECRYPTABLE', e2eUndecryptable: true });
  });

  it('does not fall back to plain text when keys cannot be checked', async () => {
    as(ALICE);
    await toWireMessagePayload(textPayload()); // онлайн: ключ Боба попадает в кэш
    mockSocket.connected = false;
    // Ключ собеседника уже в кэше — шифруем и без сети.
    await expect(toWireMessagePayload(textPayload())).resolves.toHaveProperty('enc');
    // А для нового собеседника без сети — в очередь, не открытым текстом.
    await expect(toWireMessagePayload(textPayload({ to: 'cccccccccccccccccccccccc' }))).rejects.toBeInstanceOf(
      E2eUnavailableError,
    );
  });

  describe('after reinstalling the app on the same device', () => {
    let oldWire: any;

    beforeEach(async () => {
      as(ALICE);
      oldWire = await toWireMessagePayload(textPayload());
      // Переустановка: SecureStore пуст, но KeyVault пережил её.
      secure.clear();
      as('');
      as(BOB);
    });

    it('restores the same key from KeyVault without asking for a password', async () => {
      const before = server.keys.get(BOB);
      expect(await refreshE2eState()).toBe('ready');
      expect(server.keys.get(BOB)).toBe(before);
      expect(hasLocalE2eKey()).toBe(true);
      const bobStorageKey = [...vault.keys()].find((k) => k.includes(BOB));
      expect(bobStorageKey).toBeTruthy();
      expect(secure.get(bobStorageKey!)).toBe(vault.get(bobStorageKey!));
      expect(getE2eStatus()).toBe('ready');
      const m: any = await decryptIncomingMessage(delivered(oldWire), placeholder);
      expect(m.text).toBe('секретный текст');
    });

    it('does not rotate the server key when KeyVault is temporarily unavailable', async () => {
      const before = server.keys.get(BOB);
      mockKeyVault.readFails = true;
      expect(await refreshE2eState()).toBe('needs_setup');
      expect(server.keys.get(BOB)).toBe(before);
    });
  });
});

describe('migration from password-protected backups', () => {
  let oldWire: any;

  beforeEach(async () => {
    await enableLegacy(BOB, 'bob-password');
    await enable(ALICE);
    oldWire = await toWireMessagePayload(textPayload());
    // На старой установке ключ ещё не был скопирован в KeyVault.
    secure.clear();
    vault.clear();
    as('');
    as(BOB);
  });

  it('asks for the old password and blocks encrypted sending until recovery', async () => {
    expect(await refreshE2eState()).toBe('needs_restore');
    expect(((await decryptIncomingMessage(delivered(oldWire), placeholder)) as any).e2eUndecryptable).toBe(true);
    await expect(toWireMessagePayload(textPayload({ to: ALICE }))).rejects.toMatchObject({ reason: 'locked' });
  });

  it('rejects a wrong password and keeps the published key', async () => {
    const before = server.keys.get(BOB);
    await refreshE2eState();
    expect(await restoreE2e('not-bobs-password')).toEqual({
      ok: false,
      error: 'wrong_password',
      retryAfterSec: undefined,
    });
    expect(getE2eStatus()).toBe('needs_restore');
    expect(server.keys.get(BOB)).toBe(before);
  });

  it('restores old chats and copies the recovered key into KeyVault', async () => {
    await refreshE2eState();
    expect(await restoreE2e('bob-password')).toEqual({ ok: true });
    expect(getE2eStatus()).toBe('ready');
    expect(vault.size).toBe(1);
    expect(((await decryptIncomingMessage(delivered(oldWire), placeholder)) as any).text).toBe('секретный текст');
  });

  it('can start over without a password and tells the contact that the key changed', async () => {
    await refreshE2eState();
    expect(await resetE2e()).toEqual({ ok: true });
    expect(((await decryptIncomingMessage(delivered(oldWire), placeholder)) as any).e2eUndecryptable).toBe(true);

    as(ALICE);
    await refreshE2eState();
    const changed: string[] = [];
    const off = onPeerKeyChanged((peer) => changed.push(peer));
    const { getPeerPublicKey } = await import('./e2e');
    await getPeerPublicKey(BOB, { force: true });
    off();
    expect(changed).toEqual([BOB]);
  });
});

describe('local key lifetime', () => {
  it('keeps keys per account, so a new account on the same device starts clean', async () => {
    await enable(ALICE);
    const aliceKey = server.keys.get(ALICE);
    as(BOB);
    expect(await refreshE2eState()).toBe('ready');
    expect(server.keys.get(BOB)).toBeTruthy();
    expect(server.keys.get(BOB)).not.toBe(aliceKey);
  });

  it('forgets both local copies when the profile is deleted', async () => {
    await enable(ALICE);
    storage.set(`e2e_peer_key_pins_v1:${ALICE}`, '{}');
    await deleteLocalE2eKey(ALICE);
    expect([...secure.keys()].some((k) => k.includes(ALICE))).toBe(false);
    expect([...vault.keys()].some((k) => k.includes(ALICE))).toBe(false);
    expect([...storage.keys()].some((k) => k.includes(ALICE))).toBe(false);
  });

  it('queues instead of sending plain text when this device had encryption on but the server is unreachable', async () => {
    await enable(ALICE);
    as(''); // перезапуск приложения: состояние в памяти потеряно
    as(ALICE);
    server.down = true;
    await expect(toWireMessagePayload(textPayload())).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('keeps chatting as before against a server without E2E support', async () => {
    as(ALICE);
    server.down = true; // старый бэкенд не отвечает на e2e:state
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
    // Неудачная сверка запоминается: следующее сообщение не ждёт таймаута.
    const calls = mockEmitAck.mock.calls.length;
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
    expect(mockEmitAck.mock.calls.length).toBe(calls);
  });
});

describe('turning encryption off and on again', () => {
  beforeEach(async () => {
    await enable(BOB);
    await enable(ALICE);
  });

  it('sends plain text after turning it off, while old messages stay readable', async () => {
    const oldWire = await toWireMessagePayload(textPayload());
    expect(await disableE2e()).toEqual({ ok: true });
    expect(getE2eStatus()).toBe('disabled');
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
    const m: any = await decryptIncomingMessage(delivered(oldWire), placeholder);
    expect(m.text).toBe('секретный текст');
  });

  it('makes the contact send plain text too', async () => {
    as(BOB);
    await disableE2e();
    as(ALICE);
    const { getPeerPublicKey } = await import('./e2e');
    expect(await getPeerPublicKey(BOB, { force: true })).toBeNull();
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
  });

  it('turns back on without a password, with the same key', async () => {
    const before = server.keys.get(ALICE);
    await disableE2e();
    expect(await enableE2eAgain()).toEqual({ ok: true });
    expect(getE2eStatus()).toBe('ready');
    expect(server.keys.get(ALICE)).toBe(before);
  });

  it('after reinstalling while disabled, loads the same key without a password', async () => {
    const before = server.keys.get(ALICE);
    await disableE2e();
    secure.clear();
    as('');
    as(ALICE);
    expect(await refreshE2eState()).toBe('disabled');
    expect(hasLocalE2eKey()).toBe(true);
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
    expect(await enableE2eAgain()).toEqual({ ok: true });
    expect(getE2eStatus()).toBe('ready');
    expect(server.keys.get(ALICE)).toBe(before);
  });
});

describe('"chat is protected" notice in an empty chat', () => {
  it('is shown once per contact and per account', async () => {
    as(ALICE);
    expect(await wasE2eChatNoticeSeen(BOB)).toBe(false);
    await markE2eChatNoticeSeen(BOB);
    expect(await wasE2eChatNoticeSeen(BOB)).toBe(true);
    // Другой собеседник — своё первое знакомство с чатом.
    expect(await wasE2eChatNoticeSeen('cccccccccccccccccccccccc')).toBe(false);
    // Другой аккаунт на том же телефоне видит его заново.
    as(BOB);
    expect(await wasE2eChatNoticeSeen(BOB)).toBe(false);
  });

  it('is not shown before the account is known', async () => {
    as('');
    expect(await wasE2eChatNoticeSeen(BOB)).toBe(true);
  });
});
