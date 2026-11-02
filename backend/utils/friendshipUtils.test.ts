import mongoose from 'mongoose';

const mockUser = { findById: jest.fn(), find: jest.fn() };
const mockEdge = { find: jest.fn(), bulkWrite: jest.fn() };
jest.mock('../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../models/FriendshipEdge', () => ({ __esModule: true, default: mockEdge }));
jest.mock('../models/FriendshipMessages', () => ({ __esModule: true, default: {} }));

import { getFriendIds, getFriendIdsForUsers } from './friendshipUtils';

type UserFixture = { _id: mongoose.Types.ObjectId; friends: mongoose.Types.ObjectId[] };
type EdgeFixture = { userId: mongoose.Types.ObjectId; friendId: mongoose.Types.ObjectId };
let users: UserFixture[];
let edges: EdgeFixture[];
let sequence = 0;
const oid = () => new mongoose.Types.ObjectId((++sequence).toString(16).padStart(24, '0'));
const query = <T>(value: T) => ({ sort: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), lean: jest.fn(async () => value) });

beforeEach(() => {
  users = [];
  edges = [];
  jest.clearAllMocks();
  mockUser.findById.mockImplementation((id: string) => query(users.find((u) => String(u._id) === String(id)) || null));
  mockUser.find.mockImplementation((filter: { $or?: unknown; friends?: mongoose.Types.ObjectId }) => query(
    filter.$or ? users : users.filter((u) => u.friends.some((id) => String(id) === String(filter.friends))),
  ));
  mockEdge.find.mockImplementation(() => query(edges.slice()));
  mockEdge.bulkWrite.mockImplementation(async (ops: Array<{ updateOne: { filter: EdgeFixture } }>) => {
    for (const { updateOne: { filter } } of ops) {
      if (!edges.some((e) => String(e.userId) === String(filter.userId) && String(e.friendId) === String(filter.friendId))) edges.push(filter);
    }
    return { ok: 1 };
  });
});

function pair(legacy = false) {
  const a = oid(), b = oid();
  users.push({ _id: a, friends: legacy ? [b] : [] }, { _id: b, friends: legacy ? [a] : [] });
  return { a, b, aid: String(a), bid: String(b) };
}

it('does not rewrite complete friendships on repeated reads when legacy arrays are still present', async () => {
  const { a, b, aid, bid } = pair(true);
  edges.push({ userId: a, friendId: b }, { userId: b, friendId: a });
  expect(await getFriendIds(aid)).toEqual([bid]);
  mockEdge.bulkWrite.mockClear();
  expect(await getFriendIds(aid)).toEqual([bid]);
  expect(await getFriendIds(aid)).toEqual([bid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it.each(['outgoing', 'incoming'])('repairs a missing reverse direction from an %s edge', async (direction) => {
  const { a, b, aid, bid } = pair();
  edges.push(direction === 'outgoing' ? { userId: a, friendId: b } : { userId: b, friendId: a });
  expect(await getFriendIds(aid)).toEqual([bid]);
  expect(mockEdge.bulkWrite).toHaveBeenCalledTimes(1);
  expect(edges).toHaveLength(2);
  mockEdge.bulkWrite.mockClear();
  expect(await getFriendIds(aid)).toEqual([bid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it('does not write during batched presence reads of complete edge pairs', async () => {
  const { a, b, aid, bid } = pair();
  edges.push({ userId: a, friendId: b }, { userId: b, friendId: a });
  const result = await getFriendIdsForUsers([aid, bid, aid]);
  expect(result.get(aid)).toEqual([bid]);
  expect(result.get(bid)).toEqual([aid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it('repairs an asymmetric pair once even when both users are in the batch', async () => {
  const { a, b, aid, bid } = pair();
  edges.push({ userId: a, friendId: b });
  const result = await getFriendIdsForUsers([aid, bid]);
  expect(result.get(aid)).toEqual([bid]);
  expect(result.get(bid)).toEqual([aid]);
  expect(mockEdge.bulkWrite).toHaveBeenCalledTimes(1);
  expect(mockEdge.bulkWrite.mock.calls[0][0]).toHaveLength(2);
  mockEdge.bulkWrite.mockClear();
  await getFriendIdsForUsers([aid, bid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it('keeps reverse-only legacy friends visible and persists both missing edge directions', async () => {
  const { a, b, aid, bid } = pair();
  users[1].friends = [a];
  const result = await getFriendIdsForUsers([aid]);
  expect(result.get(aid)).toEqual([bid]);
  expect(result.has(bid)).toBe(false);
  expect(edges).toEqual(expect.arrayContaining([{ userId: a, friendId: b }, { userId: b, friendId: a }]));
});

it('shares concurrent migration attempts without caching the current friend list', async () => {
  const { a, b, aid, bid } = pair();
  const results = await Promise.all(Array.from({ length: 20 }, () => getFriendIds(aid)));
  expect(results.every((ids) => ids.length === 0)).toBe(true);
  expect(mockUser.findById).toHaveBeenCalledTimes(21); // one migration + 20 authoritative reads
  edges.push({ userId: a, friendId: b }, { userId: b, friendId: a });
  expect(await getFriendIds(aid)).toEqual([bid]);
  edges.length = 0;
  expect(await getFriendIds(aid)).toEqual([]);
});

it('retries a failed migration instead of keeping its rejected promise', async () => {
  const { aid } = pair();
  mockUser.findById.mockImplementationOnce(() => ({ select: () => ({ lean: async () => { throw new Error('temporary database outage'); } }) }));
  await expect(getFriendIds(aid)).rejects.toThrow('temporary database outage');
  await expect(getFriendIds(aid)).resolves.toEqual([]);
});
