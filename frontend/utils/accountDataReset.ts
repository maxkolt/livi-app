export type AccountResetStatus = 'checking' | 'ready' | 'confirmation' | 'resetting' | 'failed';
export const ACCOUNT_GENERATION_KEY = 'livi.accountDataGeneration';
export const ACCOUNT_RESET_PENDING_KEY = 'livi.accountDataResetPending';
export const ACCOUNT_FRESH_PROFILE_KEY = 'livi.accountFreshProfilePending';

type ResetStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** Native/bootstrap helpers can create an install ID before this check. That ID
 * alone is not evidence of a previous profile on an otherwise clean install. */
export async function hasSavedAccountData(storage: Pick<ResetStorage, 'getItem'>): Promise<boolean> {
  if (await storage.getItem('userId')) return true;
  return !!(await storage.getItem('livi.profile.v1') || await storage.getItem('profile_draft_v1'));
}
type Dependencies = {
  storage: ResetStorage;
  fetchGeneration(): Promise<string | null>;
  hasLocalIdentity(): Promise<boolean>;
  resetLocalData(): Promise<void>;
};

/** A network/auth error is never authority to erase local data. Only a server
 * generation change followed by the user's explicit confirmation can do that. */
export function createAccountDataReset(deps: Dependencies) {
  let status: AccountResetStatus = 'checking';
  let generation = '';
  let target = '';
  let needsProfile = false;
  let started = false;
  let running: Promise<void> | null = null;
  let resolveReady: (() => void) | null = null;
  let ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const listeners = new Set<() => void>();
  const publish = (next: AccountResetStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  const finish = () => { publish('ready'); resolveReady?.(); };

  const apply = async () => {
    publish('resetting');
    try {
      // Journal survives process death and partial storage failures. Commit the
      // generation last; retry completes the same reset instead of skipping it.
      await deps.storage.setItem(ACCOUNT_RESET_PENDING_KEY, target);
      await deps.resetLocalData();
      await deps.storage.setItem(ACCOUNT_FRESH_PROFILE_KEY, '1');
      needsProfile = true;
      await deps.storage.setItem(ACCOUNT_GENERATION_KEY, target);
      await deps.storage.removeItem(ACCOUNT_RESET_PENDING_KEY);
      generation = target;
      finish();
    } catch { publish('failed'); }
  };

  const check = async () => {
    publish('checking');
    try {
      generation = await deps.storage.getItem(ACCOUNT_GENERATION_KEY) || '';
      needsProfile = await deps.storage.getItem(ACCOUNT_FRESH_PROFILE_KEY) === '1';
      const pending = await deps.storage.getItem(ACCOUNT_RESET_PENDING_KEY);
      if (pending) {
        target = pending;
        await apply();
        return;
      }
      // null includes offline, a non-OK response and older servers without a
      // reset marker. None of those outcomes delete or rebind an account.
      const remote = await deps.fetchGeneration();
      if (!remote || remote === generation) { finish(); return; }
      target = remote;
      if (await deps.hasLocalIdentity()) { publish('confirmation'); return; }
      await deps.storage.setItem(ACCOUNT_FRESH_PROFILE_KEY, '1');
      needsProfile = true;
      await deps.storage.setItem(ACCOUNT_GENERATION_KEY, remote);
      generation = remote;
      finish();
    } catch { publish('failed'); }
  };

  return {
    getStatus: () => status,
    getGeneration: () => generation,
    shouldOpenProfile: () => needsProfile,
    async completeProfile() {
      await deps.storage.removeItem(ACCOUNT_FRESH_PROFILE_KEY);
      needsProfile = false;
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureReady() {
      if (!started) { started = true; running = check().finally(() => { running = null; }); }
      return ready;
    },
    async confirm() {
      if (status !== 'confirmation' || running) return;
      running = apply().finally(() => { running = null; });
      await running;
    },
    async retry() {
      if (status !== 'failed' || running) return;
      running = check().finally(() => { running = null; });
      await running;
    },
    /** An offline startup may learn about the reset on its first attach. */
    async refresh() {
      if (running) await running;
      if (status === 'ready') {
        ready = new Promise<void>(resolve => { resolveReady = resolve; });
        running = check().finally(() => { running = null; });
      }
      await ready;
    },
  };
}
