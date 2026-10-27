jest.mock('expo-application', () => ({ applicationId: 'com.kolt12max.livi' }));
jest.mock('../sockets/modules/constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('./installId', () => ({
  getInstallAuthHeaders: jest.fn(),
  getInstallId: jest.fn(),
  getInstallSecret: jest.fn(),
  wasInstallSecretCreatedThisRun: jest.fn(),
}));

import { integrityRequestHash } from './playIntegrity';

describe('play integrity request hash', () => {
  it('matches the backend hash for the same install id and secret', () => {
    // crypto.createHash('sha512') in backend/utils/playIntegrity.ts for the same input.
    expect(integrityRequestHash('inst_android_abc', 'secret-1')).toBe(
      'a7d7690e84a602ea2c18c58c43bc78afadfa07b25bfb5e1081a43b6b3f626813bfa498faeefffa2061722f67ca2f07365f0b6fd41477daca7977695dd356e75e',
    );
  });
});
