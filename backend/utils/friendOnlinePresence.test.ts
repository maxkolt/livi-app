import type { Server } from 'socket.io';
import {
  getFriendVisibleOnlineUserIds,
  isFriendGloballyVisibleOnline,
  setLiveCallPredicate,
} from './friendOnlinePresence';

jest.mock('./friendshipUtils', () => ({ getFriendIdsForUsers: jest.fn(async () => new Map()) }));

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';

type FakeSocket = { id: string; data: Record<string, unknown> };

/** Как socket.io: сокеты по id + комната u:<userId> у каждого привязанного сокета. */
function fakeIo(sockets: FakeSocket[]): Server & { fullScans: () => number } {
  let scans = 0;
  const byId = new Map(sockets.map((s) => [s.id, s]));
  const values = byId.values.bind(byId);
  byId.values = () => {
    scans += 1;
    return values();
  };
  const rooms = new Map<string, Set<string>>();
  for (const s of sockets) {
    const uid = String(s.data.userId || '');
    if (!uid) continue;
    const room = rooms.get(`u:${uid}`) || new Set<string>();
    room.add(s.id);
    rooms.set(`u:${uid}`, room);
  }
  return {
    sockets: { sockets: byId, adapter: { rooms } },
    fullScans: () => scans,
  } as unknown as Server & { fullScans: () => number };
}

/** Пользователь ушёл в фон, гистерезис «в приложении» (2 с) уже истёк. */
function onlineAfterBackground(io: Server): string[] {
  const now = Date.now();
  const spy = jest.spyOn(Date, 'now');
  spy.mockReturnValue(now);
  getFriendVisibleOnlineUserIds(io);
  spy.mockReturnValue(now + 5_000);
  const online = getFriendVisibleOnlineUserIds(io);
  spy.mockRestore();
  return online;
}

describe('friend presence while the app is in the background', () => {
  afterEach(() => setLiveCallPredicate(null));

  it('shows a backgrounded user offline when only stale call flags remain on the socket', () => {
    setLiveCallPredicate(() => false);
    const io = fakeIo([{ id: 's1', data: { userId: USER, appForeground: false, busy: true, roomId: `room_${USER}_${'b'.repeat(24)}` } }]);
    expect(onlineAfterBackground(io)).toEqual([]);
  });

  it('keeps a backgrounded user online during a call the registry confirms', () => {
    setLiveCallPredicate((_io, uid) => uid === USER);
    const io = fakeIo([{ id: 's1', data: { userId: USER, appForeground: false, inCall: true } }]);
    expect(onlineAfterBackground(io)).toEqual([USER]);
  });

  it('does not ask the registry when the socket has no call flags', () => {
    const predicate = jest.fn(() => true);
    setLiveCallPredicate(predicate);
    const io = fakeIo([{ id: 's1', data: { userId: USER, appForeground: false } }]);
    expect(onlineAfterBackground(io)).toEqual([]);
    expect(predicate).not.toHaveBeenCalled();
  });

  it('shows a foreground user online regardless of call state', () => {
    setLiveCallPredicate(() => false);
    const io = fakeIo([{ id: 's1', data: { userId: USER, appForeground: true, appForegroundLastSeenAt: Date.now() } }]);
    expect(getFriendVisibleOnlineUserIds(io)).toEqual([USER]);
  });

  it('keeps a user online for the 2 s grace right after going to the background', () => {
    const io = fakeIo([{ id: 's1', data: { userId: USER, appForeground: false } }]);
    expect(getFriendVisibleOnlineUserIds(io)).toEqual([USER]);
  });
});

describe('presence cost', () => {
  const ids = Array.from({ length: 20_000 }, (_, i) => i.toString(16).padStart(24, '0'));
  const io = fakeIo(ids.map((uid, i) => ({ id: `s${i}`, data: { userId: uid, appForeground: true, appForegroundLastSeenAt: Date.now() } })));

  it("answers one user's status from that user's sockets, without scanning the server", () => {
    const before = io.fullScans();
    for (const uid of ids.slice(0, 500)) expect(isFriendGloballyVisibleOnline(io, uid)).toBe(true);
    expect(io.fullScans()).toBe(before);
  });

  it('builds the full online list in a single pass', () => {
    const before = io.fullScans();
    const started = Date.now();
    expect(getFriendVisibleOnlineUserIds(io)).toHaveLength(ids.length);
    expect(io.fullScans() - before).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
