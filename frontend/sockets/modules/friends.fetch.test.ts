jest.mock('./socketCore', () => ({ socket: { connected: true } }));
jest.mock('./emit', () => ({ emitAck: jest.fn() }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
jest.mock('./constants', () => ({ API_BASE: 'https://api.test' }));
jest.mock('../../utils/installId', () => ({ getInstallAuthHeaders: async () => ({}) }));
jest.mock('./shared', () => ({ shared: { currentUserId: 'me', reconnecting: false } }));

import { fetchFriends } from './friends';
import { emitAck } from './emit';
import { ensureReauthBeforePrivilegedSocketOp } from './reauth';

const realFetch = global.fetch;
beforeEach(() => jest.useFakeTimers());
afterEach(() => { global.fetch = realFetch; jest.useRealTimers(); });

it('refreshes an offline friend over HTTP without waiting for stuck socket reauth', async () => {
  let finishReauth!: (value: boolean) => void;
  jest.mocked(ensureReauthBeforePrivilegedSocketOp).mockImplementationOnce(() => new Promise(resolve => { finishReauth = resolve; }));
  const page = { ok: true, list: [{ _id: 'max', online: false, isBusy: false }] };
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => page })) as any;
  const result = fetchFriends(1, 50, { includeAvatarThumbs: false });
  await jest.advanceTimersByTimeAsync(1200);
  await expect(result).resolves.toEqual(page);
  finishReauth(true);
  await jest.advanceTimersByTimeAsync(8000);
  expect(emitAck).not.toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

it('uses a healthy socket without fetching the same list twice', async () => {
  const page = { ok: true, list: [{ _id: 'max', online: true, isBusy: true }] };
  jest.mocked(emitAck).mockResolvedValueOnce(page);
  global.fetch = jest.fn();
  await expect(fetchFriends()).resolves.toEqual(page);
  await jest.advanceTimersByTimeAsync(9000);
  expect(global.fetch).not.toHaveBeenCalled();
});
