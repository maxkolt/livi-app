import crypto from 'crypto';
import { buildServiceAccountAssertion, integrityRequestHash, summarizeIntegrity } from './playIntegrity';

const PACKAGE = 'com.kolt12max.livi';
const NOW = 1_800_000_000_000;
const HASH = integrityRequestHash('inst_android_abc', 'secret-1');

function payload(overrides: Record<string, any> = {}) {
  return {
    requestDetails: { requestPackageName: PACKAGE, requestHash: HASH, timestampMillis: String(NOW - 2_000) },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PACKAGE },
    deviceIntegrity: {
      deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
      recentDeviceActivity: { deviceActivityLevel: 'LEVEL_1' },
    },
    accountDetails: { appLicensingVerdict: 'LICENSED' },
    ...overrides,
  };
}

const summarize = (p: any) => summarizeIntegrity(p, { packageName: PACKAGE, requestHash: HASH, nowMs: NOW });

describe('play integrity', () => {
  it('binds the request hash to install id and secret', () => {
    expect(HASH).toMatch(/^[0-9a-f]{128}$/);
    expect(integrityRequestHash('inst_android_abc', 'secret-2')).not.toBe(HASH);
    expect(integrityRequestHash('inst_android_abd', 'secret-1')).not.toBe(HASH);
  });

  it('passes a fresh Play-recognized token from a genuine device for this request', () => {
    expect(summarize(payload())).toEqual({
      app: 'PLAY_RECOGNIZED',
      device: 'MEETS_DEVICE_INTEGRITY',
      licensing: 'LICENSED',
      activity: 'LEVEL_1',
      packageOk: true,
      hashOk: true,
      ageMs: 2_000,
      pass: true,
    });
  });

  it('fails a token issued for another request (replayed with a different secret)', () => {
    const s = summarize(payload({ requestDetails: { ...payload().requestDetails, requestHash: 'x' } }));
    expect(s).toMatchObject({ hashOk: false, pass: false });
  });

  it('fails a stale token', () => {
    const s = summarize(payload({ requestDetails: { ...payload().requestDetails, timestampMillis: String(NOW - 11 * 60_000) } }));
    expect(s).toMatchObject({ ageMs: 11 * 60_000, pass: false });
  });

  it('fails without device integrity or with an unrecognized app', () => {
    expect(summarize(payload({ deviceIntegrity: {} }))).toMatchObject({ device: 'none', activity: 'missing', pass: false });
    expect(summarize(payload({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }))).toMatchObject({
      app: 'UNRECOGNIZED_VERSION',
      pass: false,
    });
  });

  it('fails a token for another package and survives an empty payload', () => {
    const other = payload({ requestDetails: { ...payload().requestDetails, requestPackageName: 'com.example' } });
    expect(summarize(other)).toMatchObject({ packageOk: false, pass: false });
    expect(summarize(null)).toMatchObject({ app: 'missing', device: 'none', hashOk: false, ageMs: null, pass: false });
  });

  it('signs a service-account assertion Google can verify', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = buildServiceAccountAssertion(
      { client_email: 'sa@livi.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
      1_000
    );
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
      iss: 'sa@livi.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/playintegrity',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000,
      exp: 4_600,
    });
    const valid = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url'));
    expect(valid).toBe(true);
  });
});
