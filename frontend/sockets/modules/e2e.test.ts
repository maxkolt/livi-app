/**
 * Сквозное шифрование целиком на клиенте: два пользователя и поддельный сервер,
 * который ведёт себя как backend/sockets/e2eKeys.ts. Главный сценарий —
 * переустановка: аккаунт остаётся, SecureStore стирается, переписку возвращает пароль.
 */

const secure = new Map<string, string>();
const storage = new Map<string, string>();

jest.mock('react-native-get-random-values', () => ({}), { virtual: true });
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
  fetchAttempts: 0,
  down: false,
};
const mockEmitAck = jest.fn(async (event: string, payload: any, ..._opts: unknown[]) => {
  if (server.down) throw new Error('timeout');
  const me = String(mockShared.currentUserId);
  switch (event) {
    case 'e2e:state': {
      const b = server.backups.get(me);
      return { ok: true, publicKey: server.keys.get(me) ?? '', backup: b ? { kdf: b.kdf, pk: b.pk } : null };
    }
    case 'e2e:publish':
      if (!payload.backup || payload.backup.pk !== payload.publicKey) return { ok: false, error: 'invalid_backup' };
      server.keys.set(me, payload.publicKey);
      server.backups.set(me, payload.backup);
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
      return { ok: true };
    case 'e2e:enable': {
      const b = server.backups.get(me);
      if (!b || b.pk !== payload.publicKey) return { ok: false, error: 'no_backup' };
      server.keys.set(me, payload.publicKey);
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
  deleteLocalE2eKey,
  E2eUnavailableError,
  disableE2e,
  enableE2eAgain,
  getE2eStatus,
  hasLocalE2eKey,
  onPeerKeyChanged,
  refreshE2eState,
  resetE2e,
  restoreE2e,
  setupE2e,
  markE2eSetupPromptSeen,
  toWireEditPayload,
  toWireMessagePayload,
  wasE2eSetupPromptSeen,
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
  storage.clear();
  server.keys.clear();
  server.backups.clear();
  server.fetchAttempts = 0;
  server.down = false;
  mockSocket.connected = true;
  as('');
});

async function enable(user: string, password: string) {
  as(user);
  await refreshE2eState();
  expect(await setupE2e(password)).toEqual({ ok: true });
}

const textPayload = (over: Record<string, unknown> = {}) => ({
  to: BOB,
  type: 'text',
  text: 'секретный текст',
  clientMessageId: 'cm_1',
  replyTo: { id: 'm0', text: 'цитата', from: BOB },
  ...over,
});

describe('before encryption is enabled', () => {
  it('sends plain text while the user has not set a password', async () => {
    as(ALICE);
    expect(await refreshE2eState()).toBe('needs_setup');
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
  });

  it('sends plain text to a contact who has no key yet', async () => {
    await enable(ALICE, 'alice-password');
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
  });

  it('does not publish a key just by checking the state', async () => {
    as(ALICE);
    await refreshE2eState();
    expect(server.keys.size).toBe(0);
  });
});

describe('between two users with encryption on', () => {
  beforeEach(async () => {
    await enable(BOB, 'bob-password');
    await enable(ALICE, 'alice-password');
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
      // Переустановка: аккаунт и сервер те же, SecureStore пуст.
      secure.clear();
      as('');
      as(BOB);
    });

    it('asks for the password instead of silently starting over', async () => {
      expect(await refreshE2eState()).toBe('needs_restore');
      const m: any = await decryptIncomingMessage(delivered(oldWire), placeholder);
      expect(m.e2eUndecryptable).toBe(true);
    });

    it('blocks sending until the key is restored, rather than sending plain text', async () => {
      await refreshE2eState();
      await expect(toWireMessagePayload(textPayload({ to: ALICE }))).rejects.toMatchObject({ reason: 'locked' });
    });

    it('rejects a wrong password and keeps the old key on the server', async () => {
      await refreshE2eState();
      expect(await restoreE2e('not-bobs-password')).toEqual({ ok: false, error: 'wrong_password', retryAfterSec: undefined });
      expect(getE2eStatus()).toBe('needs_restore');
    });

    it('brings the old chats back with the right password', async () => {
      await refreshE2eState();
      expect(await restoreE2e('bob-password')).toEqual({ ok: true });
      expect(getE2eStatus()).toBe('ready');
      const m: any = await decryptIncomingMessage(delivered(oldWire), placeholder);
      expect(m.text).toBe('секретный текст');
    });

    it('can start over with a new password; the contact is told the key changed', async () => {
      await refreshE2eState();
      expect(await resetE2e('new-bob-password')).toEqual({ ok: true });
      expect(getE2eStatus()).toBe('ready');
      // Старое сообщение этому ключу уже не открыть.
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
});

describe('local key lifetime', () => {
  it('keeps keys per account, so a new account on the same device starts clean', async () => {
    await enable(ALICE, 'alice-password');
    as(BOB);
    expect(await refreshE2eState()).toBe('needs_setup');
  });

  it('forgets the key when the profile is deleted', async () => {
    await enable(ALICE, 'alice-password');
    await markE2eSetupPromptSeen();
    await deleteLocalE2eKey(ALICE);
    expect([...secure.keys()].some((k) => k.includes(ALICE))).toBe(false);
    expect([...storage.keys()].some((k) => k.includes(ALICE))).toBe(false);
  });

  it('offers encryption in the chat only once per account', async () => {
    as(ALICE);
    expect(await wasE2eSetupPromptSeen()).toBe(false);
    await markE2eSetupPromptSeen();
    expect(await wasE2eSetupPromptSeen()).toBe(true);
    as(BOB);
    expect(await wasE2eSetupPromptSeen()).toBe(false);
  });

  it('queues instead of sending plain text when this device had encryption on but the server is unreachable', async () => {
    await enable(ALICE, 'alice-password');
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
    await enable(BOB, 'bob-password');
    await enable(ALICE, 'alice-password');
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

  it('after reinstalling with encryption off, sending is not blocked and the key can be restored', async () => {
    await disableE2e();
    secure.clear();
    as('');
    as(ALICE);
    expect(await refreshE2eState()).toBe('disabled');
    expect(hasLocalE2eKey()).toBe(false);
    expect(await toWireMessagePayload(textPayload())).toEqual(textPayload());
    expect(await restoreE2e('alice-password')).toEqual({ ok: true });
    expect(getE2eStatus()).toBe('disabled');
    expect(hasLocalE2eKey()).toBe(true);
  });
});
