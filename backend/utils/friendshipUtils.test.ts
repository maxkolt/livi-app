import mongoose from 'mongoose';

const mockUser = { findById: jest.fn(), find: jest.fn(), findOne: jest.fn() };
const mockEdge = { find: jest.fn(), bulkWrite: jest.fn() };
jest.mock('../models/User', () => ({ __esModule: true, default: mockUser }));
jest.mock('../models/FriendshipEdge', () => ({ __esModule: true, default: mockEdge }));
jest.mock('../models/FriendshipMessages', () => ({ __esModule: true, default: {} }));

import { getFriendIds, getFriendIdsForUsers, areFriendsCached, clearFriendshipCache } from './friendshipUtils';

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
  clearFriendshipCache();
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

it.each(['outgoing', 'incoming'])('reads an asymmetric %s edge without rewriting it', async (direction) => {
  const { a, b, aid, bid } = pair();
  edges.push(direction === 'outgoing' ? { userId: a, friendId: b } : { userId: b, friendId: a });
  expect(await getFriendIds(aid)).toEqual([bid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
  expect(edges).toHaveLength(1);
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

it('reads an asymmetric pair for both users without creating a reverse edge', async () => {
  const { a, b, aid, bid } = pair();
  edges.push({ userId: a, friendId: b });
  const result = await getFriendIdsForUsers([aid, bid]);
  expect(result.get(aid)).toEqual([bid]);
  expect(result.get(bid)).toEqual([aid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
  expect(edges).toHaveLength(1);
  mockEdge.bulkWrite.mockClear();
  await getFriendIdsForUsers([aid, bid]);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it('keeps reverse-only legacy friends visible without copying them into new edges', async () => {
  const { a, aid, bid } = pair();
  users[1].friends = [a];
  const result = await getFriendIdsForUsers([aid]);
  expect(result.get(aid)).toEqual([bid]);
  expect(result.has(bid)).toBe(false);
  expect(edges).toHaveLength(0);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});

it('keeps concurrent reads authoritative without any conversion writes', async () => {
  const { a, b, aid, bid } = pair();
  const results = await Promise.all(Array.from({ length: 20 }, () => getFriendIds(aid)));
  expect(results.every((ids) => ids.length === 0)).toBe(true);
  expect(mockUser.findById).toHaveBeenCalledTimes(20);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
  edges.push({ userId: a, friendId: b }, { userId: b, friendId: a });
  expect(await getFriendIds(aid)).toEqual([bid]);
  edges.length = 0;
  expect(await getFriendIds(aid)).toEqual([]);
});

it('can read again after a temporary database error', async () => {
  const { aid } = pair();
  mockUser.findById.mockImplementationOnce(() => ({ select: () => ({ lean: async () => { throw new Error('temporary database outage'); } }) }));
  await expect(getFriendIds(aid)).rejects.toThrow('temporary database outage');
  await expect(getFriendIds(aid)).resolves.toEqual([]);
});

it('keeps historical arrays intact on a direct read and on an authorization check', async () => {
  const { a, aid, bid } = pair(true);
  const before = users.map(user => user.friends.map(String));
  expect(await getFriendIds(aid)).toEqual([bid]);
  mockUser.findOne.mockImplementation(() => query({ _id: a }));
  expect(await areFriendsCached(aid, bid)).toBe(true);
  expect(users.map(user => user.friends.map(String))).toEqual(before);
  expect(edges).toHaveLength(0);
  expect(mockEdge.bulkWrite).not.toHaveBeenCalled();
});
