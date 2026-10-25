import { decideHttpInstallAuth, hashInstallSecret } from './installSecret';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const SECRET = 'a'.repeat(64);
const storedHash = hashInstallSecret(SECRET);

describe('HTTP install auth', () => {
  it('lets installs without a stored secret through as legacy', () => {
    expect(decideHttpInstallAuth({ storedHash: undefined, providedSecret: null, httpSecretSeen: false, requireAll: true }))
      .toEqual({ result: 'legacy', markHttpSecretSeen: false });
  });

  it('accepts the right secret and remembers that this install sends it', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: SECRET, httpSecretSeen: false, requireAll: false }))
      .toEqual({ result: 'allow', markHttpSecretSeen: true });
    expect(decideHttpInstallAuth({ storedHash, providedSecret: SECRET, httpSecretSeen: true, requireAll: false }))
      .toEqual({ result: 'allow', markHttpSecretSeen: false });
  });

  it('keeps old builds working until the install has sent a secret over HTTP', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: undefined, httpSecretSeen: false, requireAll: false }).result)
      .toBe('legacy');
  });

  it('rejects a missing or wrong secret once the install is updated', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: undefined, httpSecretSeen: true, requireAll: false }).result)
      .toBe('reject');
    expect(decideHttpInstallAuth({ storedHash, providedSecret: 'b'.repeat(64), httpSecretSeen: true, requireAll: false }).result)
      .toBe('reject');
  });

  it('rejects a missing secret for every install when required globally', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: undefined, httpSecretSeen: false, requireAll: true }).result)
      .toBe('reject');
  });
});
