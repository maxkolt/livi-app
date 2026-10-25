import type { Server } from 'socket.io';
import { getFriendVisibleOnlineUserIds, setLiveCallPredicate } from './friendOnlinePresence';

jest.mock('./friendshipUtils', () => ({ getFriendIdsForUsers: jest.fn(async () => new Map()) }));

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function fakeIo(sockets: Array<{ id: string; data: Record<string, unknown> }>): Server {
  return { sockets: { sockets: new Map(sockets.map((s) => [s.id, s])) } } as unknown as Server;
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
});
