import type { AuthedSocket } from '../sockets/types';
import { hashInstallSecret, verifyInstallSecret } from './installSecret';
import { hasVerifiedSocketInstall } from './socketInstallAuth';
const secret = 'a'.repeat(64);
const record = { installId: 'inst_android_test1234', user: '0123456789abcdef01234567', installSecretHash: hashInstallSecret(secret) };
const socket = (auth: object, data: object = {}) => ({ handshake: { auth, query: {} }, data }) as AuthedSocket;
it('rejects knowledge of the installation or user ID without its secret', () => {
  expect(hasVerifiedSocketInstall(socket({ installId: record.installId, userId: record.user }), record)).toBe(false);
  expect(hasVerifiedSocketInstall(socket({ installId: record.installId, installSecret: 'wrong' }), record)).toBe(false);
  expect(hasVerifiedSocketInstall(socket({ installSecret: secret }), { ...record, installSecretHash: undefined })).toBe(false);
});
it('authenticates a real secret and supports older clients only after verified attachment', () => {
  expect(hasVerifiedSocketInstall(socket({ installSecret: secret }), record)).toBe(true);
  expect(hasVerifiedSocketInstall(socket({}, { userId: record.user, verifiedInstallId: record.installId, verifiedInstallSecretHash: record.installSecretHash }), record)).toBe(true);
  expect(hasVerifiedSocketInstall(socket({}, { userId: record.user }), record)).toBe(false);
});
it('does not reuse verification for another installation, user, or changed secret', () => {
  const sock = socket({}, { userId: record.user, verifiedInstallId: record.installId, verifiedInstallSecretHash: record.installSecretHash });
  expect(hasVerifiedSocketInstall(sock, { ...record, installId: 'other' })).toBe(false);
  expect(hasVerifiedSocketInstall(sock, { ...record, user: 'other' })).toBe(false);
  expect(hasVerifiedSocketInstall(sock, { ...record, installSecretHash: hashInstallSecret('b'.repeat(64)) })).toBe(false);
});
it('accepts existing unversioned hashes only with the original high entropy secret', () => {
  const crypto = require('crypto');
  const legacy = crypto.createHmac('sha256', 'livi-dev-only-pepper-do-not-use-in-production').update(secret).digest('hex');
  expect(verifyInstallSecret(secret, legacy)).toBe(true);
  expect(verifyInstallSecret('b'.repeat(64), legacy)).toBe(false);
  expect(verifyInstallSecret(secret, 'v1:'+legacy+'trailing')).toBe(false);
});
