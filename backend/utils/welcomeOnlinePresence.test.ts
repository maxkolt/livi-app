let onlineIds: string[] = [];
jest.mock('mongoose', () => ({ connection: { readyState: 0 } }));
jest.mock('../models/User', () => ({ __esModule: true, default: {} }));
jest.mock('./friendOnlinePresence', () => ({ getFriendVisibleOnlineUserIds: jest.fn(() => onlineIds) }));

import { bindWelcomeOnlinePresence, getWelcomeOnlinePresenceSnapshot, scheduleWelcomeOnlinePresenceEmit, WELCOME_DELTA_ROOM } from './welcomeOnlinePresence';
import { getFriendVisibleOnlineUserIds } from './friendOnlinePresence';
import type { Server } from 'socket.io';
import type { AuthedSocket } from '../sockets/types';

function makeIo() {
  const delta = jest.fn();
  const legacy = jest.fn();
  const io = { to: jest.fn(() => ({ emit: delta })), except: jest.fn(() => ({ emit: legacy })) };
  return { io: io as unknown as Server, delta, legacy };
}

describe('welcome presence bandwidth and compatibility', () => {
  beforeEach(() => { jest.useFakeTimers(); onlineIds = []; jest.clearAllMocks(); });
  afterEach(() => { jest.useRealTimers(); });

  it('shares concurrent snapshots and does not broadcast unchanged heartbeats', async () => {
    const { io, delta, legacy } = makeIo();
    onlineIds = ['a', 'b'];
    const snapshots = await Promise.all(Array.from({ length: 100 }, () => getWelcomeOnlinePresenceSnapshot(io)));
    expect(getFriendVisibleOnlineUserIds).toHaveBeenCalledTimes(1);
    expect(snapshots.every((s) => s === snapshots[0])).toBe(true);
    await jest.advanceTimersByTimeAsync(150);
    await getWelcomeOnlinePresenceSnapshot(io);
    expect(delta).toHaveBeenCalledTimes(1);
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(io.except).toHaveBeenCalledWith(WELCOME_DELTA_ROOM);
    expect(legacy.mock.calls[0][1].list.map((p: { id: string }) => p.id)).toEqual(['a', 'b']);
  });

  it('sends only changed records to capable clients and handles the last user leaving', async () => {
    const { io, delta } = makeIo();
    onlineIds = Array.from({ length: 5000 }, (_, i) => `user-${i}`);
    const first = await getWelcomeOnlinePresenceSnapshot(io);
    await jest.advanceTimersByTimeAsync(150);
    onlineIds = [...onlineIds.slice(1), 'new-user'];
    await getWelcomeOnlinePresenceSnapshot(io);
    expect(delta.mock.calls[1]).toEqual(['presence:welcome:delta', {
      epoch: first.epoch, revision: first.revision + 1,
      upsert: [{ id: 'new-user', nick: '', avatarVer: 0 }], removed: ['user-0'],
    }]);
    await jest.advanceTimersByTimeAsync(150);
    onlineIds = [];
    const empty = await getWelcomeOnlinePresenceSnapshot(io);
    expect(empty.list).toEqual([]);
    expect(delta.mock.calls[2][1].removed).toHaveLength(5000);
  });

  it('does not postpone broadcasts indefinitely during continuous visibility events', async () => {
    const { io, delta } = makeIo();
    onlineIds = ['a'];
    for (let i = 0; i < 10; i++) {
      scheduleWelcomeOnlinePresenceEmit(io);
      await jest.advanceTimersByTimeAsync(30);
    }
    expect(delta).toHaveBeenCalledTimes(1);
  });

  it('joins the delta room only for clients announcing the capability', async () => {
    const { io } = makeIo();
    const socket = { connected: true, handshake: { query: { caps: 'offline_ack,welcome_delta' } },
      join: jest.fn(), on: jest.fn(), emit: jest.fn() };
    bindWelcomeOnlinePresence(io, socket as unknown as AuthedSocket);
    await jest.advanceTimersByTimeAsync(0);
    expect(socket.join).toHaveBeenCalledWith(WELCOME_DELTA_ROOM);
    expect(socket.emit).toHaveBeenCalledWith('presence:welcome', expect.objectContaining({ ok: true, list: [] }));
    socket.join.mockClear();
    socket.handshake.query.caps = 'offline_ack';
    bindWelcomeOnlinePresence(io, socket as unknown as AuthedSocket);
    expect(socket.join).not.toHaveBeenCalled();
  });
});
