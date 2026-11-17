import { ACCOUNT_GENERATION_KEY, ACCOUNT_RESET_PENDING_KEY, ACCOUNT_FRESH_PROFILE_KEY, createAccountDataReset, hasSavedAccountData } from './accountDataReset';

function fixture(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => { values.set(key, value); }),
    removeItem: jest.fn(async (key: string) => { values.delete(key); }),
  };
  const fetchGeneration = jest.fn<Promise<string | null>, []>(async () => 'fresh-1');
  const resetLocalData = jest.fn(async () => { values.delete('userId'); });
  const controller = createAccountDataReset({ storage, fetchGeneration,
    hasLocalIdentity: async () => values.has('userId'), resetLocalData });
  return { controller, values, storage, fetchGeneration, resetLocalData };
}
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

it('does not mistake an ID created early by bootstrap for a previous user account', async () => {
  const f = fixture({ 'livi.installId': 'created-during-clean-startup' });
  expect(await hasSavedAccountData(f.storage)).toBe(false);
  f.values.set('userId', 'previous-owner');
  expect(await hasSavedAccountData(f.storage)).toBe(true);
  f.values.delete('userId');
  f.values.set('livi.profile.v1', JSON.stringify({ nick: 'saved-owner' }));
  expect(await hasSavedAccountData(f.storage)).toBe(true);
});

it('blocks all concurrent startup callers until explicit confirmation and clears only once', async () => {
  const f = fixture({ userId: 'old-owner' });
  let started = 0;
  const waits = [f.controller.ensureReady(), f.controller.ensureReady()].map(p => p.then(() => { started++; }));
  await settle();
  expect(f.controller.getStatus()).toBe('confirmation');
  expect(started).toBe(0);
  expect(f.resetLocalData).not.toHaveBeenCalled();
  await Promise.all([f.controller.confirm(), f.controller.confirm()]);
  await Promise.all(waits);
  expect(started).toBe(2);
  expect(f.fetchGeneration).toHaveBeenCalledTimes(1);
  expect(f.resetLocalData).toHaveBeenCalledTimes(1);
  expect(f.values.get(ACCOUNT_GENERATION_KEY)).toBe('fresh-1');
  expect(f.values.has(ACCOUNT_RESET_PENDING_KEY)).toBe(false);
  expect(f.controller.shouldOpenProfile()).toBe(true);
});

it.each([null, 'fresh-1'])('does not reset for offline/missing marker or an already adopted generation: %s', async remote => {
  const f = fixture({ userId: 'current-owner', [ACCOUNT_GENERATION_KEY]: 'fresh-1' });
  f.fetchGeneration.mockResolvedValue(remote);
  await f.controller.ensureReady();
  expect(f.controller.getStatus()).toBe('ready');
  expect(f.resetLocalData).not.toHaveBeenCalled();
  expect(f.values.get('userId')).toBe('current-owner');
});

it('records a clean installation generation without showing the reset dialog', async () => {
  const f = fixture();
  await f.controller.ensureReady();
  expect(f.values.get(ACCOUNT_GENERATION_KEY)).toBe('fresh-1');
  expect(f.resetLocalData).not.toHaveBeenCalled();
  expect(f.controller.shouldOpenProfile()).toBe(true);
});

it('keeps incomplete registration on the profile pane after relaunch and stops after saving a nickname', async () => {
  const f = fixture({ userId: 'new-owner', [ACCOUNT_GENERATION_KEY]: 'fresh-1', [ACCOUNT_FRESH_PROFILE_KEY]: '1' });
  await f.controller.ensureReady();
  expect(f.controller.shouldOpenProfile()).toBe(true);
  await f.controller.completeProfile();
  expect(f.controller.shouldOpenProfile()).toBe(false);
  expect(f.values.has(ACCOUNT_FRESH_PROFILE_KEY)).toBe(false);
  expect(f.resetLocalData).not.toHaveBeenCalled();
});

it('keeps startup blocked after a partial failure and retries the journaled reset', async () => {
  const f = fixture({ userId: 'old-owner' });
  f.resetLocalData.mockRejectedValueOnce(new Error('SecureStore unavailable'));
  const waiting = f.controller.ensureReady();
  await settle();
  await f.controller.confirm();
  expect(f.controller.getStatus()).toBe('failed');
  expect(f.values.get(ACCOUNT_RESET_PENDING_KEY)).toBe('fresh-1');
  expect(f.values.has(ACCOUNT_GENERATION_KEY)).toBe(false);
  await f.controller.retry();
  await waiting;
  expect(f.controller.getStatus()).toBe('ready');
  expect(f.resetLocalData).toHaveBeenCalledTimes(2);
});

it('resumes a confirmed reset after process death, even offline', async () => {
  const f = fixture({ [ACCOUNT_RESET_PENDING_KEY]: 'fresh-1' });
  f.fetchGeneration.mockResolvedValue(null);
  await f.controller.ensureReady();
  expect(f.resetLocalData).toHaveBeenCalledTimes(1);
  expect(f.values.get(ACCOUNT_GENERATION_KEY)).toBe('fresh-1');
  expect(f.fetchGeneration).not.toHaveBeenCalled();
});

it('learns about a reset after offline startup without silently deleting the account', async () => {
  const f = fixture({ userId: 'old-owner' });
  f.fetchGeneration.mockResolvedValueOnce(null);
  await f.controller.ensureReady();
  const refreshed = f.controller.refresh();
  await settle();
  expect(f.controller.getStatus()).toBe('confirmation');
  expect(f.resetLocalData).not.toHaveBeenCalled();
  await f.controller.confirm();
  await refreshed;
  expect(f.controller.getGeneration()).toBe('fresh-1');
});
