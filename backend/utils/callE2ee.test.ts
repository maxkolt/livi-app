import { callAcceptedE2eeField, decideCallE2ee, parseCallE2eeDeclaration } from './callE2ee';

const b64 = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const PK_A = b64(1);
const PK_B = b64(2);
const published = jest.fn(async () => ({ a: PK_A, b: PK_B }));
const base = { a: 'a', b: 'b', loadPublicKeys: published };

describe('parseCallE2eeDeclaration', () => {
  it('accepts a 32-byte public key and nothing else', () => {
    expect(parseCallE2eeDeclaration({ pk: PK_A })).toBe(PK_A);
    expect(parseCallE2eeDeclaration({ pk: 'short' })).toBeNull();
    expect(parseCallE2eeDeclaration(undefined)).toBeNull();
    expect(parseCallE2eeDeclaration('x')).toBeNull();
  });
});

describe('decideCallE2ee', () => {
  it('encrypts when both sides declared their published keys', async () => {
    await expect(decideCallE2ee({ ...base, declaredA: PK_A, declaredB: PK_B })).resolves.toEqual({ pkA: PK_A, pkB: PK_B });
  });

  it('keeps the call plain when either side did not declare (older app)', async () => {
    await expect(decideCallE2ee({ ...base, declaredA: PK_A, declaredB: null })).resolves.toBeNull();
    await expect(decideCallE2ee({ ...base, declaredA: undefined, declaredB: PK_B })).resolves.toBeNull();
  });

  it('keeps the call plain when a declared key is stale, so both sides agree', async () => {
    await expect(decideCallE2ee({ ...base, declaredA: b64(9), declaredB: PK_B })).resolves.toBeNull();
    await expect(decideCallE2ee({ ...base, declaredA: PK_A, declaredB: b64(9) })).resolves.toBeNull();
  });
});

describe('callAcceptedE2eeField', () => {
  const link = { a: 'a', b: 'b' };
  const decision = { pkA: PK_A, pkB: PK_B };

  it("hands each side the other side's key", () => {
    expect(callAcceptedE2eeField('a', link, decision)).toEqual({ e2ee: { peerPublicKey: PK_B } });
    expect(callAcceptedE2eeField('b', link, decision)).toEqual({ e2ee: { peerPublicKey: PK_A } });
  });

  it('adds nothing for a plain call or a stranger', () => {
    expect(callAcceptedE2eeField('a', link, null)).toEqual({});
    expect(callAcceptedE2eeField('c', link, decision)).toEqual({});
  });
});
