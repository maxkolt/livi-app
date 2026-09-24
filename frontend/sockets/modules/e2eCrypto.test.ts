import {
  createKeyBackup,
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
