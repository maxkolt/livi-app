jest.mock('../models/User', () => ({}));
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: jest.fn() }));

import {
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
