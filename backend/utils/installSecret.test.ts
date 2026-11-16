import { decideHttpInstallAuth, hashInstallSecret } from './installSecret';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const SECRET = 'a'.repeat(64);
const storedHash = hashInstallSecret(SECRET);

describe('HTTP install auth', () => {
  it('rejects installs without a stored secret', () => {
    expect(decideHttpInstallAuth({ storedHash: undefined, providedSecret: null, httpSecretSeen: false, requireAll: true }))
      .toEqual({ result: 'reject', markHttpSecretSeen: false });
  });

  it('accepts the right secret and remembers that this install sends it', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: SECRET, httpSecretSeen: false, requireAll: false }))
      .toEqual({ result: 'allow', markHttpSecretSeen: true });
    expect(decideHttpInstallAuth({ storedHash, providedSecret: SECRET, httpSecretSeen: true, requireAll: false }))
      .toEqual({ result: 'allow', markHttpSecretSeen: false });
  });

  it('requires the secret even before the first authenticated HTTP request', () => {
    expect(decideHttpInstallAuth({ storedHash, providedSecret: undefined, httpSecretSeen: false, requireAll: false }).result)
      .toBe('reject');
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

it('supports explicitly staged legacy compatibility without weakening protected records', () => {
  process.env.INSTALL_AUTH_MODE = 'legacy-migration';
  try {
    expect(decideHttpInstallAuth({ storedHash: undefined, providedSecret: null, httpSecretSeen: false, requireAll: false })).toEqual({ result: 'allow', markHttpSecretSeen: false });
    expect(decideHttpInstallAuth({ storedHash: undefined, providedSecret: null, httpSecretSeen: false, requireAll: true }).result).toBe('reject');
    expect(decideHttpInstallAuth({ storedHash, providedSecret: null, httpSecretSeen: false, requireAll: false }).result).toBe('reject');
  } finally { delete process.env.INSTALL_AUTH_MODE; }
});


it('keeps dev-created hashes verifiable in production without copying its pepper', () => {
  const previous = process.env.INSTALL_SECRET_PEPPER;
  const previousMode = process.env.NODE_ENV;
  try {
    delete process.env.INSTALL_SECRET_PEPPER; process.env.NODE_ENV = 'test';
    let devHash = '';
    jest.isolateModules(() => { devHash = require('./installSecret').hashInstallSecret(SECRET); });
    expect(devHash).toMatch(/^[a-f0-9]{64}$/);
    process.env.INSTALL_SECRET_PEPPER = 'isolated-test-production-pepper-with-32-characters';
    process.env.NODE_ENV = 'production';
    jest.isolateModules(() => {
      const prod = require('./installSecret');
      expect(prod.verifyInstallSecret(SECRET, devHash)).toBe(true);
      expect(prod.needsInstallSecretRehash(devHash)).toBe(true);
      expect(prod.hashInstallSecret(SECRET)).toMatch(/^v1:/);
      expect(prod.verifyInstallSecret(SECRET, 'v1:' + devHash)).toBe(false);
    });
  } finally {
    if (previous == null) delete process.env.INSTALL_SECRET_PEPPER; else process.env.INSTALL_SECRET_PEPPER = previous;
    process.env.NODE_ENV = previousMode;
  }
});
