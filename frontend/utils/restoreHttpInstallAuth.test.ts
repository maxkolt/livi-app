let mockUserId = 'me';
const mockGetInstallId = jest.fn();
const mockGetInstallSecret = jest.fn();
const mockReauth = jest.fn();
const mockAttach = jest.fn();
jest.mock('../sockets/modules/authState', () => ({ getCurrentUserId: () => mockUserId }));
jest.mock('./installId', () => ({
  getInstallId: () => mockGetInstallId(), getInstallSecret: () => mockGetInstallSecret(),
}));
jest.mock('../sockets/modules/emit', () => ({ emitAck: (...args: unknown[]) => mockReauth(...args) }));
jest.mock('../sockets/modules/identity', () => ({ attachIdentity: (...args: unknown[]) => mockAttach(...args) }));
let restore: typeof import('./restoreHttpInstallAuth').restoreHttpInstallAuth;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  jest.resetModules(); mockUserId = 'me';
  mockGetInstallId.mockReset().mockResolvedValue('existing-install');
  mockGetInstallSecret.mockReset().mockResolvedValue('test-install-secret');
  mockReauth.mockReset().mockResolvedValue({ ok: true, userId: 'me' });
  mockAttach.mockReset().mockResolvedValue({ ok: true, userId: 'me' });
  restore = require('./restoreHttpInstallAuth').restoreHttpInstallAuth;
});
it('revalidates only the existing installation and account', async () => {
  expect(await restore()).toBe(true);
  expect(mockReauth).toHaveBeenCalledWith('reauth', { userId: 'me', installSecret: 'test-install-secret' }, 6000, 0);
  expect(mockAttach).toHaveBeenCalledWith({ installId: 'existing-install', installSecret: 'test-install-secret' });
});
it('deduplicates concurrent HTTP repairs for the same account', async () => {
  let finish!: (value: unknown) => void;
  mockAttach.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const first = restore(), second = restore(); await flush();
  expect(mockAttach).toHaveBeenCalledTimes(1);
  finish({ ok: true, userId: 'me' });
  expect(await first).toBe(true); expect(await second).toBe(true);
});
it.each([{ ok: false, error: 'not_found' }, { ok: false, error: 'user_not_found' }, { ok: true, userId: 'other' }])(
  'does not attach or create an account without a matching existing mapping: %j', async mapped => {
    mockReauth.mockResolvedValue(mapped);
    expect(await restore()).toBe(false); expect(mockAttach).not.toHaveBeenCalled();
  },
);
it('does not attach without a locally stored installation secret', async () => {
  mockGetInstallSecret.mockResolvedValue(null);
  expect(await restore()).toBe(false); expect(mockAttach).not.toHaveBeenCalled();
});
it('does not accept or publish another identity if the account changes while awaiting reauth', async () => {
  mockReauth.mockImplementation(async () => { mockUserId = 'other'; return { ok: true, userId: 'me' }; });
  expect(await restore()).toBe(false); expect(mockAttach).not.toHaveBeenCalled();
});
it('rejects failed or mismatching attachment and releases the repair for a later retry', async () => {
  mockAttach.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, userId: 'other' })
    .mockResolvedValueOnce({ ok: true, userId: 'me' });
  expect(await restore()).toBe(false); expect(await restore()).toBe(false); expect(await restore()).toBe(true);
});
it('does not repair when no account is selected', async () => {
  mockUserId = ''; expect(await restore()).toBe(false); expect(mockReauth).not.toHaveBeenCalled();
});
