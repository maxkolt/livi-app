import {
  createKeyBackup,
  deriveCallFrameKey,
  nativePbkdf2MatchesJs,
  setNativePbkdf2,
  deriveRestoreKeys,
  fromBase64,
  generateKeyPair,
  isAcceptableBackupPassword,
  openKeyBackup,
  openMessage,
  sealMessage,
  toBase64,
  utf8Decode,
  utf8Encode,
} from './e2eCrypto';

const alice = generateKeyPair();
const bob = generateKeyPair();
const mallory = generateKeyPair();
const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const body = (over: Partial<{ id: string; text: string; replyText: string }> = {}) => ({
  id: 'cm_1',
  from: A,
  to: B,
  text: 'привет 👋 hello',
  ...over,
});

describe('encoding helpers', () => {
  it('round-trips base64 and rejects non-canonical input', () => {
    for (const len of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37) & 255);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(toBase64(Uint8Array.from([0xfb, 0xff]))).toBe(Buffer.from([0xfb, 0xff]).toString('base64'));
    expect(fromBase64('QR==')).toBeNull();
    expect(fromBase64('abc')).toBeNull();
    expect(fromBase64('ab$=')).toBeNull();
    expect(fromBase64(5)).toBeNull();
  });

  it('matches the platform UTF-8 codec, including surrogate pairs', () => {
    for (const s of ['', 'ascii', 'кириллица', '中文', '👨‍👩‍👧 emoji', 'x'.repeat(1000)]) {
      expect(Buffer.from(utf8Encode(s)).equals(Buffer.from(s, 'utf8'))).toBe(true);
      expect(utf8Decode(utf8Encode(s))).toBe(s);
    }
  });

  it('rejects invalid UTF-8 instead of guessing', () => {
    expect(utf8Decode(Uint8Array.from([0xc3]))).toBeNull(); // обрыв
    expect(utf8Decode(Uint8Array.from([0xc0, 0x80]))).toBeNull(); // overlong
    expect(utf8Decode(Uint8Array.from([0xed, 0xa0, 0x80]))).toBeNull(); // суррогат
    expect(utf8Decode(Uint8Array.from([0xff]))).toBeNull();
  });
});

describe('message envelopes', () => {
  const sealed = sealMessage(body({ replyText: 'цитата' }), alice, bob.publicKey);
  const meta = { id: 'cm_1', from: A, to: B };

  it('lets the recipient read it and reports the sender key', () => {
    const r = openMessage(sealed, bob, { ...meta, me: B });
    expect(r).toEqual({ ok: true, body: body({ replyText: 'цитата' }), peerPublicKey: toBase64(alice.publicKey) });
  });

  it('lets the sender read their own history from the same ciphertext', () => {
    const r = openMessage(sealed, alice, { ...meta, me: A });
    expect(r.ok && r.body.text).toBe(body().text);
  });

  it('refuses a third party', () => {
    expect(openMessage(sealed, mallory, { ...meta, me: 'm' })).toEqual({ ok: false, reason: 'not_my_key' });
  });

  it('detects a tampered ciphertext', () => {
    const c = fromBase64(sealed.c)!;
    c[c.length - 1] ^= 1;
    expect(openMessage({ ...sealed, c: toBase64(c) }, bob, { ...meta, me: B })).toEqual({ ok: false, reason: 'forged' });
  });

  it('binds the message id and chat', () => {
    expect(openMessage(sealed, bob, { ...meta, id: 'cm_2', me: B })).toEqual({ ok: false, reason: 'forged' });
    expect(openMessage(sealed, bob, { ...meta, from: 'cccccccccccccccccccccccc', me: B })).toEqual({
      ok: false,
      reason: 'forged',
    });
  });

  it('rejects my own message reflected back as if the peer sent it', () => {
    // Сервер меняет местами ключи и метаданные: общий ключ box тот же, расшифровка удаётся.
    const reflected = { ...sealed, spk: sealed.rpk, rpk: sealed.spk };
    expect(openMessage(reflected, alice, { id: 'cm_1', from: B, to: A, me: A })).toEqual({ ok: false, reason: 'forged' });
    expect(openMessage(reflected, alice, { ...meta, me: A })).toEqual({ ok: false, reason: 'forged' });
  });

  it('pads plaintext so the ciphertext does not reveal the exact length', () => {
    const short = sealMessage(body({ text: 'a' }), alice, bob.publicKey);
    const longer = sealMessage(body({ text: 'abc' }), alice, bob.publicKey);
    expect(fromBase64(short.c)!.length).toBe(fromBase64(longer.c)!.length);
  });

  it('uses a fresh nonce every time', () => {
    const again = sealMessage(body({ replyText: 'цитата' }), alice, bob.publicKey);
    expect(again.n).not.toBe(sealed.n);
    expect(again.c).not.toBe(sealed.c);
  });

  it('rejects malformed envelopes', () => {
    expect(openMessage({ ...sealed, v: 2 }, bob, { ...meta, me: B })).toEqual({ ok: false, reason: 'malformed' });
    expect(openMessage({ ...sealed, n: 'x' }, bob, { ...meta, me: B })).toEqual({ ok: false, reason: 'malformed' });
    expect(openMessage(null, bob, { ...meta, me: B })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('key backup', () => {
  jest.setTimeout(30_000);

  it('restores the same key pair with the right password', async () => {
    const backup = await createKeyBackup(alice, 'correct horse');
    const { authKey: _upload, ...stored } = backup;
    const { wrapKey, authKey } = await deriveRestoreKeys('correct horse', stored.kdf);
    expect(authKey).toBe(backup.authKey);
    const restored = openKeyBackup(stored, wrapKey);
    expect(restored && toBase64(restored.secretKey)).toBe(toBase64(alice.secretKey));
  });

  it('fails with the wrong password and derives a different auth key', async () => {
    const backup = await createKeyBackup(alice, 'correct horse');
    const { wrapKey, authKey } = await deriveRestoreKeys('wrong horse!', backup.kdf);
    expect(authKey).not.toBe(backup.authKey);
    expect(openKeyBackup(backup, wrapKey)).toBeNull();
  });

  it('normalizes the password, so the same text typed differently still works', async () => {
    const backup = await createKeyBackup(alice, 'парольй-12'); // й одним символом
    const { wrapKey } = await deriveRestoreKeys('парольй-12', backup.kdf); // и + бреве
    expect(openKeyBackup(backup, wrapKey)).not.toBeNull();
  });

  it('rejects a backup that does not match its declared public key', async () => {
    const backup = await createKeyBackup(alice, 'correct horse');
    const { wrapKey } = await deriveRestoreKeys('correct horse', backup.kdf);
    expect(openKeyBackup({ ...backup, pk: toBase64(bob.publicKey) }, wrapKey)).toBeNull();
  });

  it('never puts the auth key and the wrap key on the same value', async () => {
    const backup = await createKeyBackup(alice, 'correct horse');
    const { wrapKey } = await deriveRestoreKeys('correct horse', backup.kdf);
    expect(toBase64(wrapKey)).not.toBe(backup.authKey);
  });

  it('requires at least 8 characters, counting emoji as one', () => {
    expect(isAcceptableBackupPassword('1234567')).toBe(false);
    expect(isAcceptableBackupPassword('12345678')).toBe(true);
    expect(isAcceptableBackupPassword('😀😀😀😀😀😀😀')).toBe(false);
  });
});

describe('call frame key', () => {
  it('is the same on both sides of the call', () => {
    const forAlice = deriveCallFrameKey(alice, bob.publicKey, 'call_1');
    const forBob = deriveCallFrameKey(bob, alice.publicKey, 'call_1');
    expect(forAlice).not.toBeNull();
    expect(toBase64(forAlice!)).toBe(toBase64(forBob!));
  });

  it('differs for every call between the same pair', () => {
    const one = deriveCallFrameKey(alice, bob.publicKey, 'call_1')!;
    const two = deriveCallFrameKey(alice, bob.publicKey, 'call_2')!;
    expect(toBase64(one)).not.toBe(toBase64(two));
  });

  it('cannot be derived by a third party', () => {
    const real = deriveCallFrameKey(alice, bob.publicKey, 'call_1')!;
    const mallorys = deriveCallFrameKey(mallory, bob.publicKey, 'call_1')!;
    expect(toBase64(mallorys)).not.toBe(toBase64(real));
  });

  it('is not the chat message key for the same pair', () => {
    // Разные метки HKDF: утечка ключа звонка не раскрывает переписку и наоборот.
    const callKey = deriveCallFrameKey(alice, bob.publicKey, 'call_1')!;
    const nacl = require('tweetnacl');
    expect(toBase64(callKey)).not.toBe(toBase64(nacl.box.before(bob.publicKey, alice.secretKey)));
  });

  it('refuses a low-order peer key that would give everyone the same secret', () => {
    expect(deriveCallFrameKey(alice, new Uint8Array(32), 'call_1')).toBeNull();
    expect(deriveCallFrameKey(alice, bob.publicKey, '')).toBeNull();
  });
});

describe('native PBKDF2 backups', () => {
  jest.setTimeout(60_000);
  const { pbkdf2Async } = require('@noble/hashes/pbkdf2');
  const { sha256 } = require('@noble/hashes/sha2');
  const { pbkdf2Sync } = require('crypto');
  // Эталон — PBKDF2 из OpenSSL (node:crypto), как нативный модуль на устройстве.
  const openssl = async (pw: Uint8Array, salt: Uint8Array, c: number, dkLen: number) =>
    new Uint8Array(pbkdf2Sync(Buffer.from(pw), Buffer.from(salt), c, dkLen, 'sha256'));

  afterEach(() => setNativePbkdf2(null));

  it('accepts a native implementation only when it matches JS byte for byte', async () => {
    await expect(nativePbkdf2MatchesJs(openssl)).resolves.toBe(true);
    const wrongEncoding = async (pw: Uint8Array, salt: Uint8Array, c: number, dkLen: number) =>
      openssl(Buffer.from(Buffer.from(pw).toString('latin1'), 'utf16le'), salt, c, dkLen);
    await expect(nativePbkdf2MatchesJs(wrongEncoding)).resolves.toBe(false);
  });

  it('uses PBKDF2 when the device has it, and the backup opens without it', async () => {
    setNativePbkdf2(openssl);
    const backup = await createKeyBackup(alice, 'correct horse');
    expect(backup.kdf).toMatchObject({ alg: 'pbkdf2-sha256', iterations: 600_000 });
    // Другое устройство без нативного модуля открывает копию JS-реализацией.
    setNativePbkdf2(null);
    const { wrapKey, authKey } = await deriveRestoreKeys('correct horse', backup.kdf);
    expect(authKey).toBe(backup.authKey);
    expect(openKeyBackup(backup, wrapKey)).not.toBeNull();
  });

  it('keeps scrypt backups working when the device has no native module', async () => {
    const backup = await createKeyBackup(alice, 'correct horse');
    expect(backup.kdf.alg).toBe('scrypt');
    setNativePbkdf2(openssl);
    const { wrapKey } = await deriveRestoreKeys('correct horse', backup.kdf);
    expect(openKeyBackup(backup, wrapKey)).not.toBeNull();
  });

  it('matches the RFC 7914 PBKDF2-HMAC-SHA256 vector', async () => {
    const out = await pbkdf2Async(sha256, 'passwd', 'salt', { c: 1, dkLen: 64 });
    expect(Buffer.from(out).toString('hex')).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
  });
});
