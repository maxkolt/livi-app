jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));

import { AppReviewPolicy, REVIEW_OPPORTUNITY_MS, REVIEW_SETTLE_MS, reviewStorageKey } from './appReviewPolicy';
import { __resetCallLifecycleForTests, callLifecycle, getCallLifecycle, subscribeCallLifecycle } from './callLifecycle';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const policies: AppReviewPolicy[] = [];
const subscriptions: Array<() => void> = [];
let disk: Map<string, string>;

function setup() {
  const deps = {
    storage: {
      getItem: jest.fn(async (key: string) => disk.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => { disk.set(key, value); }),
    },
    canPresent: jest.fn(() => true),
    prepare: jest.fn(async (): Promise<string | null> => 'prepared'),
    launch: jest.fn(async (_token: string) => true),
    cancelPreparation: jest.fn(),
  };
  const policy = new AppReviewPolicy(deps);
  policies.push(policy);
  policy.setUser('alice');
  policy.observeCall(getCallLifecycle());
  subscriptions.push(subscribeCallLifecycle(next => policy.observeCall(next)));
  policy.setReady(true);
  return { policy, deps };
}

function connect(id = 'c1') {
  callLifecycle.outgoingStarted('bob');
  callLifecycle.outgoingCallIdAssigned(id);
  callLifecycle.accepted(id, 'bob', 'caller');
  callLifecycle.mediaConnected(id);
}
function finish(id = 'c1', reason = 'local') {
  callLifecycle.endRequested(id, reason);
  callLifecycle.ended(id, 'session:endCall');
}
const settle = () => jest.advanceTimersByTimeAsync(REVIEW_SETTLE_MS);

beforeEach(() => {
  jest.useFakeTimers({ now: 1_790_000_000_000 });
  __resetCallLifecycleForTests();
  disk = new Map();
});
afterEach(() => {
  subscriptions.splice(0).forEach(off => off());
  policies.splice(0).forEach(policy => policy.dispose());
  jest.useRealTimers();
});

it('waits until the connected call ends and Home settles; persists before requesting the Google UI', async () => {
  const { deps } = setup();
  connect();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(deps.storage.getItem).not.toHaveBeenCalled();
  finish();
  expect(deps.prepare).not.toHaveBeenCalled();
  await settle();
  expect(deps.launch).toHaveBeenCalledTimes(1);
  expect(deps.launch).toHaveBeenCalledWith('prepared');
  expect(disk.get(reviewStorageKey('alice'))).toBe(String(Date.now()));
  expect(deps.storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(deps.launch.mock.invocationCallOrder[0]);
  expect(jest.getTimerCount()).toBe(0);
});

it('also supports an incoming call ended by the remote peer', async () => {
  const { deps } = setup();
  callLifecycle.incomingPresented('c1', 'bob');
  callLifecycle.accepted('c1', 'bob', 'callee');
  callLifecycle.mediaConnected('c1');
  finish('c1', 'remote');
  await settle();
  expect(deps.launch).toHaveBeenCalledTimes(1);
});

it.each(['cancelled', 'declined', 'no_answer'])('never requests a review for %s ringing', async reason => {
  const { deps } = setup();
  callLifecycle.outgoingStarted('bob');
  callLifecycle.outgoingCallIdAssigned('c1');
  callLifecycle.ringEnded('c1', reason);
  await settle();
  expect(deps.storage.getItem).not.toHaveBeenCalled();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('does not treat accepted-but-failed connection as a conversation', async () => {
  const { deps } = setup();
  callLifecycle.accepted('c1', 'bob', 'callee');
  finish();
  await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('ignores duplicate end events and cleanup', async () => {
  const { policy, deps } = setup();
  connect(); finish();
  policy.observeCall(getCallLifecycle());
  finish();
  await settle();
  policy.observeCall(getCallLifecycle());
  await settle();
  expect(deps.launch).toHaveBeenCalledTimes(1);
});

it.each([10, 365, 3650])('never reopens after a previously stored attempt, even %i days later', async days => {
  const { deps } = setup();
  const last = Date.now();
  disk.set(reviewStorageKey('alice'), String(last));
  jest.setSystemTime(last + days * 24 * 60 * 60 * 1000);
  connect(); finish(); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
  expect(deps.launch).not.toHaveBeenCalled();
});

it('retains the permanent stop after a policy/app remount and never prompts merely on startup', async () => {
  const first = setup();
  connect(); finish(); await settle();
  first.policy.dispose();
  subscriptions.splice(0).forEach(off => off());
  jest.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const second = setup();
  await settle();
  expect(second.deps.storage.getItem).not.toHaveBeenCalled();
  connect('c2'); finish('c2'); await settle();
  expect(second.deps.launch).not.toHaveBeenCalled();
});

it('scopes the permanent stop to the signed-in account', async () => {
  const { policy, deps } = setup();
  connect(); finish(); await settle();
  policy.setUser('charlie');
  connect('c2'); finish('c2'); await settle();
  expect(deps.launch).toHaveBeenCalledTimes(2);
  expect(disk.has(reviewStorageKey('charlie'))).toBe(true);
});

it('does not attribute a call to an account changed during that call', async () => {
  const { policy, deps } = setup();
  connect(); policy.setUser('charlie'); finish(); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('waits for Home instead of interrupting the call closing animation', async () => {
  const { policy, deps } = setup();
  policy.setReady(false);
  connect(); finish(); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
  policy.setReady(true);
  await settle();
  expect(deps.launch).toHaveBeenCalledTimes(1);
});

it('drops the opportunity when the user leaves Home and does not resurrect it on return', async () => {
  const { policy, deps } = setup();
  connect(); finish(); policy.setReady(false); policy.setReady(true); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('cancels a slow preparation on background/new navigation without consuming the automatic attempt', async () => {
  const { policy, deps } = setup();
  const pending = deferred<string | null>();
  deps.prepare.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  policy.cancel();
  pending.resolve('late'); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
  expect(deps.storage.setItem).not.toHaveBeenCalled();
  expect(deps.cancelPreparation).toHaveBeenCalled();
});

it('ignores a storage read that completes after a new call starts', async () => {
  const { deps } = setup();
  const pending = deferred<string | null>();
  deps.storage.getItem.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  connect('c2');
  pending.resolve(null); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('expires delayed preparation instead of unexpectedly showing it much later', async () => {
  const { deps } = setup();
  const pending = deferred<string | null>();
  deps.prepare.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  await jest.advanceTimersByTimeAsync(REVIEW_OPPORTUNITY_MS);
  pending.resolve('late'); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('skips automatic UI when another dialog, keyboard, PiP, or app state prevents presentation', async () => {
  const { deps } = setup();
  deps.canPresent.mockReturnValue(false);
  connect(); finish(); await settle();
  expect(deps.storage.getItem).not.toHaveBeenCalled();
});

it.each(['getItem', 'setItem'] as const)('fails quietly and does not launch when storage %s fails', async method => {
  const { deps } = setup();
  deps.storage[method].mockRejectedValue(new Error('storage unavailable'));
  connect(); finish(); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['', 'garbage', '-1', 'Infinity', '9999999999999'])('does not nag with an invalid/future attempt record %s', async raw => {
  const { deps } = setup();
  disk.set(reviewStorageKey('alice'), raw);
  connect(); finish(); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('permanently stops automatic UI after the manual review action', async () => {
  const { policy, deps } = setup();
  connect(); finish();
  policy.manualReviewOpened(); await settle();
  jest.setSystemTime(Date.now() + 365 * 24 * 60 * 60 * 1000);
  connect('c2'); finish('c2'); await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
  expect(disk.has(reviewStorageKey('alice'))).toBe(true);
});

it('serializes an in-flight automatic persistence before a newer manual action', async () => {
  const { policy, deps } = setup();
  const pending = deferred<void>();
  deps.storage.setItem.mockImplementationOnce(async (key, value) => {
    await pending.promise;
    disk.set(key, value);
  });
  connect(); finish(); await settle();
  jest.setSystemTime(Date.now() + 1000);
  const manualAt = Date.now();
  policy.manualReviewOpened();
  pending.resolve(); await settle();
  expect(disk.get(reviewStorageKey('alice'))).toBe(String(manualAt));
  expect(deps.launch).not.toHaveBeenCalled();
});

it('does not count superseding a stale active call as a completed conversation', async () => {
  const { deps } = setup();
  connect();
  callLifecycle.outgoingStarted('charlie');
  await settle();
  expect(deps.prepare).not.toHaveBeenCalled();
});

it('cannot start a late native form after disposal', async () => {
  const { policy, deps } = setup();
  const pending = deferred<string | null>();
  deps.prepare.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  policy.dispose(); pending.resolve('late'); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
});

it('handles a native preparation failure quietly without consuming the automatic attempt', async () => {
  const { deps } = setup();
  deps.prepare.mockRejectedValue(new Error('Google service unavailable'));
  connect(); finish(); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
  expect(disk.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('does not repeatedly launch after an uncertain native launch result', async () => {
  const { deps } = setup();
  deps.launch.mockRejectedValue(new Error('Native flow failed'));
  connect(); finish(); await settle();
  connect('c2'); finish('c2'); await settle();
  expect(deps.launch).toHaveBeenCalledTimes(1);
  expect(disk.has(reviewStorageKey('alice'))).toBe(true);
});

it('rechecks presentation eligibility after preparing the Google form', async () => {
  const { deps } = setup();
  const pending = deferred<string | null>();
  deps.prepare.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  deps.canPresent.mockReturnValue(false);
  pending.resolve('prepared'); await settle();
  expect(deps.storage.setItem).not.toHaveBeenCalled();
  expect(deps.launch).not.toHaveBeenCalled();
});

it('never launches after a new call starts during the final persistence', async () => {
  const { deps } = setup();
  const pending = deferred<void>();
  deps.storage.setItem.mockReturnValue(pending.promise);
  connect(); finish(); await settle();
  connect('c2');
  pending.resolve(); await settle();
  expect(deps.launch).not.toHaveBeenCalled();
});

it('never records attempts or prompts without a signed-in account', async () => {
  const { policy, deps } = setup();
  policy.setUser(undefined);
  connect(); finish(); await settle();
  expect(deps.storage.getItem).not.toHaveBeenCalled();
  expect(deps.prepare).not.toHaveBeenCalled();
});
