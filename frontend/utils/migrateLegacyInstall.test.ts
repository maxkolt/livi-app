let mockUserId = 'owner';
const mockFetch = jest.fn(), mockAnswer = jest.fn(), mockAck = jest.fn();
jest.mock('../sockets/modules/authState', () => ({ getCurrentUserId: () => mockUserId }));
jest.mock('../sockets/modules/constants', () => ({ API_BASE: 'https://api.example.test' }));
jest.mock('./installId', () => ({ getInstallId: async () => 'saved-install', getInstallSecret: async () => 'saved-secret' }));
jest.mock('./fetchWithTimeout', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('../sockets/modules/e2e', () => ({ answerInstallMigrationChallenge: (...args: unknown[]) => mockAnswer(...args) }));
jest.mock('../sockets/modules/emit', () => ({ emitAck: (...args: unknown[]) => mockAck(...args) }));
import { migrateLegacyInstall } from './migrateLegacyInstall';
const reply = (body: object, ok = true) => ({ ok, json: async () => body });
beforeEach(() => { mockUserId = 'owner'; mockFetch.mockReset(); mockAnswer.mockReset().mockResolvedValue('decrypted-proof'); mockAck.mockReset().mockResolvedValue({ ok: true, userId: 'owner' }); });
it('enrolls only with a decrypted proof and then verifies the same account', async () => {
  mockFetch.mockResolvedValueOnce(reply({ ok: true, id: 'challenge-id' })).mockResolvedValueOnce(reply({ ok: true }));
  expect(await migrateLegacyInstall('owner')).toBe(true);
  expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ id: 'challenge-id', proof: 'decrypted-proof' });
  expect(mockAck).toHaveBeenCalledWith('reauth', { userId: 'owner', installSecret: 'saved-secret' }, 6000, 0);
});
it('retains the account and sends no completion when its private key is unavailable', async () => {
  mockFetch.mockResolvedValue(reply({ ok: true, id: 'challenge-id' })); mockAnswer.mockResolvedValue(null);
  expect(await migrateLegacyInstall('owner')).toBe(false); expect(mockUserId).toBe('owner'); expect(mockFetch).toHaveBeenCalledTimes(1); expect(mockAck).not.toHaveBeenCalled();
});
it('stops on an account switch while the challenge is loading', async () => {
  mockFetch.mockImplementation(async () => { mockUserId = 'other'; return reply({ ok: true, id: 'challenge-id' }); });
  expect(await migrateLegacyInstall('owner')).toBe(false); expect(mockAnswer).not.toHaveBeenCalled(); expect(mockFetch).toHaveBeenCalledTimes(1);
});
it('does not change local identity when the migration service is unavailable', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  expect(await migrateLegacyInstall('owner')).toBe(false); expect(mockUserId).toBe('owner'); expect(mockAck).not.toHaveBeenCalled();
});
