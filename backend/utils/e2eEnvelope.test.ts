import {
  parseE2eEnvelope,
  resolveIncomingEnvelope,
  strictBase64Length,
  E2E_MAX_CIPHERTEXT_BYTES,
} from './e2eEnvelope';

const b64 = (bytes: number, fill = 7) => Buffer.alloc(bytes, fill).toString('base64');
const SPK = b64(32, 1);
const RPK = b64(32, 2);
const envelope = (over: Record<string, unknown> = {}) => ({ v: 1, n: b64(24), c: b64(64), spk: SPK, rpk: RPK, ...over });

describe('strictBase64Length', () => {
  it('accepts canonical base64 only', () => {
    expect(strictBase64Length(b64(32))).toBe(32);
    expect(strictBase64Length('not base64!')).toBeNull();
    expect(strictBase64Length('QQ')).toBeNull(); // без паддинга
    expect(strictBase64Length('QR==')).toBeNull(); // неканоничные хвостовые биты
    expect(strictBase64Length('')).toBeNull();
    expect(strictBase64Length(123)).toBeNull();
  });
});

describe('parseE2eEnvelope', () => {
  it('accepts a well-formed v1 envelope and drops unknown fields', () => {
    expect(parseE2eEnvelope({ ...envelope(), extra: 'x' })).toEqual(envelope());
  });

  it.each([
    ['wrong version', { v: 2 }],
    ['short nonce', { n: b64(12) }],
    ['ciphertext without room for a MAC', { c: b64(16) }],
    ['oversized ciphertext', { c: b64(E2E_MAX_CIPHERTEXT_BYTES + 17) }],
    ['bad sender key', { spk: b64(31) }],
    ['bad recipient key', { rpk: 'zz' }],
  ])('rejects %s', (_name, over) => {
    expect(parseE2eEnvelope(envelope(over))).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(parseE2eEnvelope('x')).toBeNull();
    expect(parseE2eEnvelope(null)).toBeNull();
  });
});

describe('resolveIncomingEnvelope', () => {
  const keys = jest.fn(async () => ({ me: SPK, peer: RPK }));
  const base = { type: 'text', clientMessageId: 'cm_1', from: 'me', to: 'peer', loadPublicKeys: keys };

  it('passes plain messages through without touching keys', async () => {
    await expect(resolveIncomingEnvelope({ ...base, rawEnc: undefined })).resolves.toEqual({ ok: true, enc: null });
    expect(keys).not.toHaveBeenCalled();
  });

  it('accepts an envelope made with both published keys', async () => {
    await expect(resolveIncomingEnvelope({ ...base, rawEnc: envelope() })).resolves.toEqual({ ok: true, enc: envelope() });
  });

  it('requires a client message id, because the id is bound inside the ciphertext', async () => {
    await expect(resolveIncomingEnvelope({ ...base, clientMessageId: '', rawEnc: envelope() })).resolves.toEqual({
      ok: false,
      error: 'invalid_enc',
    });
  });

  it('only encrypts text messages', async () => {
    await expect(resolveIncomingEnvelope({ ...base, type: 'image', rawEnc: envelope() })).resolves.toEqual({
      ok: false,
      error: 'invalid_enc',
    });
  });

  it('rejects stale keys on either side so the sender refreshes them', async () => {
    const other = b64(32, 9);
    await expect(resolveIncomingEnvelope({ ...base, rawEnc: envelope({ rpk: other }) })).resolves.toEqual({
      ok: false,
      error: 'e2e_key_mismatch',
    });
    await expect(resolveIncomingEnvelope({ ...base, rawEnc: envelope({ spk: other }) })).resolves.toEqual({
      ok: false,
      error: 'e2e_key_mismatch',
    });
  });

  it('rejects when the recipient has no published key', async () => {
    const noPeer = jest.fn(async () => ({ me: SPK }));
    await expect(
      resolveIncomingEnvelope({ ...base, loadPublicKeys: noPeer, rawEnc: envelope() }),
    ).resolves.toEqual({ ok: false, error: 'e2e_key_mismatch' });
  });
});
