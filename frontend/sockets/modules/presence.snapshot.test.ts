const socketHandlers = new Map<string, (...args: any[]) => void>();
const presenceUpdateSubscribers = new Set<(data: unknown) => void>();

jest.mock('./socketCore', () => ({
  socket: {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => {
      socketHandlers.set(event, handler);
    }),
    emit: jest.fn(),
  },
}));
jest.mock('./shared', () => ({
  shared: {
    lastPresenceUpdateKey: null,
    lastVisibleOnlineUserIds: new Set<string>(),
    visibleOnlinePresenceListKnown: false,
    lastSocketConnectAt: 0,
    presenceUpdateSubscribers,
    welcomePresenceSubscribers: new Set(),
    hasConnectedEver: false,
  },
}));
jest.mock('./missedCalls', () => ({ applyMissedFromReauth: jest.fn() }));
jest.mock('./outboxTriggers', () => ({ drainAllOutboxes: jest.fn() }));
jest.mock('./outbox', () => ({ noteNetworkBack: jest.fn() }));
jest.mock('./e2e', () => ({ refreshE2eState: jest.fn(async () => undefined) }));
jest.mock('../../utils/cosmetics', () => ({ applyRemoteFrameChange: jest.fn() }));
jest.mock('../../utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { onPresenceUpdate, beginWelcomePresenceRefresh, getWelcomePresenceSnapshot, refreshWelcomePresenceSnapshot } from './presence';
import { socket } from './socketCore';
import { shared } from './shared';

describe('presence snapshots after reconnect', () => {
  beforeEach(() => {
    shared.lastVisibleOnlineUserIds = new Set(['friend']);
    shared.lastSocketConnectAt = Date.now();
    presenceUpdateSubscribers.clear();
  });

  it('accepts an authoritative empty list instead of restoring stale online users', () => {
    const listener = jest.fn();
    onPresenceUpdate(listener);

    socketHandlers.get('presence:update')?.([]);

    expect(listener).toHaveBeenCalledWith([]);
    expect([...shared.lastVisibleOnlineUserIds]).toEqual([]);
  });
});

describe('welcome HTTP/socket ordering', () => {
  it('exposes the confirmed snapshot immediately to a remounted banner', () => {
    const data = { ok: true, epoch: 'welcome-cache-read', revision: 1, list: ['me', 'peer'] };
    socketHandlers.get('presence:welcome')?.(data);
    expect(getWelcomePresenceSnapshot()).toBe(data);
  });

  it('requests a socket snapshot independently of HTTP and does not buffer sync requests while offline', () => {
    (socket.emit as jest.Mock).mockClear();
    socket.connected = true;
    refreshWelcomePresenceSnapshot();
    expect(socket.emit).toHaveBeenCalledWith('presence:welcome:sync');
    socket.connected = false;
    refreshWelcomePresenceSnapshot();
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });

  it('reuses a current snapshot for a conditional refresh after the UI skipped an update', () => {
    const data = { ok: true, epoch: 'welcome-server-a', revision: 10, list: [{ id: 'peer', nick: 'Peer', avatarVer: 1 }] };
    socketHandlers.get('presence:welcome')?.(data);
    const request = beginWelcomePresenceRefresh();
    expect(request.query).toContain('revision=10');
    expect(request.apply({ ok: true, unchanged: true, epoch: data.epoch, revision: 10 })).toBe(data);
  });

  it('discards an HTTP response started before reconnect', () => {
    const request = beginWelcomePresenceRefresh();
    socketHandlers.get('connect')?.();
    expect(request.apply({ ok: true, list: ['stale'] })).toBeNull();
  });
});
