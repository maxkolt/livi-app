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

import { onPresenceUpdate } from './presence';
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
