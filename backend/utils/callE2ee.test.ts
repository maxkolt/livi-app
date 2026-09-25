import { callAcceptedE2eeField, decideCallE2ee, parseCallE2eeDeclaration } from './callE2ee';

const b64 = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const PK_A = b64(1);
const PK_B = b64(2);

describe('parseCallE2eeDeclaration', () => {
  it('accepts a 32-byte public key and nothing else', () => {
    expect(parseCallE2eeDeclaration({ pk: PK_A })).toBe(PK_A);
    expect(parseCallE2eeDeclaration({ pk: 'short' })).toBeNull();
    expect(parseCallE2eeDeclaration(undefined)).toBeNull();
    expect(parseCallE2eeDeclaration('x')).toBeNull();
  });
});

describe('decideCallE2ee', () => {
  it('accepts independent ephemeral keys from both call participants', () => {
    expect(decideCallE2ee({ declaredA: PK_A, declaredB: PK_B })).toEqual({ pkA: PK_A, pkB: PK_B });
  });

  it('rejects a call when either mandatory declaration is absent', () => {
    expect(decideCallE2ee({ declaredA: PK_A, declaredB: null })).toBeNull();
    expect(decideCallE2ee({ declaredA: undefined, declaredB: PK_B })).toBeNull();
  });

  it('does not depend on published chat keys', () => {
    expect(decideCallE2ee({ declaredA: b64(9), declaredB: b64(8) })).toEqual({
      pkA: b64(9),
      pkB: b64(8),
    });
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
