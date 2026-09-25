const mockUsers: Record<string, { e2ePublicKey?: string; friends?: string[] }> = {};
jest.mock('../models/User', () => ({
  __esModule: true,
  default: {
    find: (q: any) => ({
      select: () => ({
        lean: async () =>
          (q._id.$in as string[]).filter((id) => mockUsers[id]).map((id) => ({ _id: id, ...mockUsers[id] })),
      }),
    }),
  },
}));
const mockFriendIds = jest.fn(async (_userId: string) => [] as string[]);
jest.mock('../utils/friendshipUtils', () => ({ getFriendIds: (id: string) => mockFriendIds(id) }));
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: jest.fn() }));

import {
  registerE2eKeyHandlers,
  hashBackupAuthKey,
  parseBackupKdf,
  parseBackupUpload,
  verifyBackupAuthKey,
  BACKUP_FETCH_LIMITS,
} from './e2eKeys';
import { hashInstallSecret } from '../utils/installSecret';

const b64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString('base64');
const PK = b64(32, 3);
const kdf = (over: Record<string, unknown> = {}) => ({ alg: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: b64(16), ...over });
const upload = (over: Record<string, unknown> = {}) => ({
  v: 1,
  kdf: kdf(),
  n: b64(24),
  c: b64(48),
  pk: PK,
  authKey: b64(32, 5),
  ...over,
});

describe('parseBackupKdf', () => {
  it('accepts the client defaults', () => {
    expect(parseBackupKdf(kdf())).toEqual(kdf());
  });

  it.each([
    ['another algorithm', { alg: 'pbkdf2' }],
    ['a cost below the floor', { N: 2 ** 14 }],
    ['a cost that is not a power of two', { N: 40_000 }],
    ['an absurd cost', { N: 2 ** 21 }],
    ['a small block size', { r: 4 }],
    ['a short salt', { salt: b64(8) }],
  ])('rejects %s', (_name, over) => {
    expect(parseBackupKdf(kdf(over))).toBeNull();
  });
});

describe('parseBackupKdf with native PBKDF2', () => {
  const pbkdf2 = (over: Record<string, unknown> = {}) => ({ alg: 'pbkdf2-sha256', iterations: 600_000, salt: b64(16), ...over });

  it('accepts the device default', () => {
    expect(parseBackupKdf(pbkdf2())).toEqual(pbkdf2());
  });

  it('refuses a weakened iteration count or a short salt', () => {
    expect(parseBackupKdf(pbkdf2({ iterations: 1000 }))).toBeNull();
    expect(parseBackupKdf(pbkdf2({ iterations: 600_000.5 }))).toBeNull();
    expect(parseBackupKdf(pbkdf2({ salt: b64(8) }))).toBeNull();
  });
});

describe('parseBackupUpload', () => {
  it('accepts a backup of the key being published', () => {
    expect(parseBackupUpload(upload(), PK)).toEqual(upload());
  });

  it('refuses to publish a key without a matching backup', () => {
    expect(parseBackupUpload(undefined, PK)).toBeNull();
    expect(parseBackupUpload(upload({ pk: b64(32, 4) }), PK)).toBeNull();
  });

  it.each([
    ['a wrapped key of the wrong size', { c: b64(40) }],
    ['a short nonce', { n: b64(16) }],
    ['a short auth key', { authKey: b64(16) }],
    ['a weak kdf', { kdf: kdf({ N: 1024 }) }],
    ['an unknown version', { v: 2 }],
  ])('rejects %s', (_name, over) => {
    expect(parseBackupUpload(upload(over), PK)).toBeNull();
  });
});

describe('backup auth key', () => {
  const authKey = b64(32, 5);

  it('verifies only the key it was made from', () => {
    const hash = hashBackupAuthKey(authKey);
    expect(verifyBackupAuthKey(authKey, hash)).toBe(true);
    expect(verifyBackupAuthKey(b64(32, 6), hash)).toBe(false);
    expect(verifyBackupAuthKey(undefined, hash)).toBe(false);
    expect(verifyBackupAuthKey(authKey, undefined)).toBe(false);
  });

  it('lives in its own HMAC domain, apart from install secrets', () => {
    expect(hashBackupAuthKey(authKey)).not.toBe(hashInstallSecret(authKey));
  });

  it('bounds online password guessing', () => {
    const perDay = BACKUP_FETCH_LIMITS.find((l) => l.windowMs === 24 * 60 * 60_000);
    expect(perDay?.max).toBeLessThanOrEqual(20);
  });
});

describe('e2e:keys', () => {
  const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const FRIEND = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const STRANGER = 'cccccccccccccccccccccccc';

  function keysHandler() {
    const handlers: Record<string, Function> = {};
    const sock = { on: (event: string, h: Function) => (handlers[event] = h) } as any;
    registerE2eKeyHandlers({ to: () => ({ emit: jest.fn() }) } as any, sock, () => ME);
    return (payload: unknown) => new Promise<any>((resolve) => handlers['e2e:keys'](payload, resolve));
  }

  beforeEach(() => {
    for (const k of Object.keys(mockUsers)) delete mockUsers[k];
    mockUsers[FRIEND] = { e2ePublicKey: b64(32, 1), friends: [] }; // устаревшее поле пустое
    mockUsers[STRANGER] = { e2ePublicKey: b64(32, 2) };
    mockFriendIds.mockResolvedValue([FRIEND]);
  });

  it('returns keys of friends from the friendship edges, not the legacy User.friends field', async () => {
    const res = await keysHandler()({ userIds: [FRIEND] });
    expect(res).toEqual({ ok: true, keys: { [FRIEND]: b64(32, 1) } });
    expect(mockFriendIds).toHaveBeenCalledWith(ME);
  });

  it('does not reveal keys of non-friends', async () => {
    const res = await keysHandler()({ userIds: [STRANGER] });
    expect(res).toEqual({ ok: true, keys: {} });
  });
});
