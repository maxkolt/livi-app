import { FriendPresenceRecipients } from './friendPresenceRecipients';

jest.mock('./friendshipUtils', () => ({ getFriendIdsForUsers: jest.fn() }));
const ids = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(24, '0'));
const result = (keys: string[]) => new Map(keys.map((id) => [id, [`friend-of-${id}`]]));

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('batches simultaneous users, coalesces pending duplicates and does not cache a completed result', async () => {
  const read = jest.fn(async (keys: string[]) => result(keys));
  const loader = new FriendPresenceRecipients(read);
  const pending = [loader.load(ids[0]), loader.load(ids[1]), loader.load(ids[0])];
  await jest.advanceTimersByTimeAsync(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0][0]).toEqual([ids[0], ids[1]]);
  expect(await Promise.all(pending)).toEqual([[`friend-of-${ids[0]}`], [`friend-of-${ids[1]}`], [`friend-of-${ids[0]}`]]);
  read.mockResolvedValueOnce(new Map([[ids[0], []]]));
  const fresh = loader.load(ids[0]);
  await jest.advanceTimersByTimeAsync(2);
  expect(await fresh).toEqual([]);
  expect(read).toHaveBeenCalledTimes(2);
});

it('bounds query size and concurrency while draining every queued user', async () => {
  const releases: Array<() => void> = [];
  let active = 0, maximum = 0;
  const read = jest.fn((keys: string[]) => new Promise<Map<string, string[]>>((resolve) => {
    maximum = Math.max(maximum, ++active);
    releases.push(() => { active--; resolve(result(keys)); });
  }));
  const loader = new FriendPresenceRecipients(read, 3, 2);
  const pending = ids.map((id) => loader.load(id));
  await jest.advanceTimersByTimeAsync(2);
  expect(read).toHaveBeenCalledTimes(2);
  releases.splice(0).forEach((release) => release());
  await jest.advanceTimersByTimeAsync(2);
  expect(read).toHaveBeenCalledTimes(4);
  releases.splice(0).forEach((release) => release());
  await Promise.all(pending);
  expect(maximum).toBe(2);
  expect(read.mock.calls.every(([keys]) => keys.length <= 3)).toBe(true);
});

it('does not attach a newer request to an older in-flight snapshot', async () => {
  let finishOld!: (value: Map<string, string[]>) => void;
  const read = jest.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(new Map([[ids[0], ['new-friend']]]));
  const loader = new FriendPresenceRecipients(read);
  const old = loader.load(ids[0]);
  await jest.advanceTimersByTimeAsync(2);
  const fresh = loader.load(ids[0]);
  await jest.advanceTimersByTimeAsync(2);
  expect(await fresh).toEqual(['new-friend']);
  finishOld(new Map([[ids[0], ['old-friend']]]));
  expect(await old).toEqual(['old-friend']);
  expect(read).toHaveBeenCalledTimes(2);
});

it('rejects a failed batch and continues with a later fresh query', async () => {
  const read = jest.fn().mockRejectedValueOnce(new Error('database unavailable')).mockImplementation(async (keys: string[]) => result(keys));
  const loader = new FriendPresenceRecipients(read);
  const failed = loader.load(ids[0]);
  const failure = expect(failed).rejects.toThrow('database unavailable');
  await jest.advanceTimersByTimeAsync(2);
  await failure;
  const retry = loader.load(ids[0]);
  await jest.advanceTimersByTimeAsync(2);
  expect(await retry).toEqual([`friend-of-${ids[0]}`]);
});
