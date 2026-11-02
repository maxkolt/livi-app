jest.mock('../utils/logger', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
}));
jest.mock('../routes/livekit', () => ({
  createToken: jest.fn(async () => 'lk-token'),
  getLiveKitUrl: () => 'wss://lk.test',
}));
jest.mock('../utils/friendPresenceRecipients', () => ({ getPresenceFriendIds: jest.fn(async () => []) }));
jest.mock('../utils/friendOnlinePresence', () => ({ scheduleGlobalFriendPresenceEmit: () => {} }));
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: async () => ({ ok: true }) }));
jest.mock('../models/UserReport', () => ({ __esModule: true, default: {}, isUserReportReason: () => true }));

import { bindMatch } from './match';
import { createToken } from '../routes/livekit';
import { getPresenceFriendIds } from '../utils/friendPresenceRecipients';
import * as queueStore from '../utils/queueStore';
import * as shutdownState from '../utils/shutdownState';

const GRACE_MS = 300;
process.env.RANDOM_RECONNECT_GRACE_MS = String(GRACE_MS);

type Received = { event: string; payload: any };
type Handler = (...args: any[]) => unknown;

/** Минимальный io: то, чем пользуется match.ts (sockets, adapter.rooms, to().emit). */
class FakeIo {
  sockets = {
    sockets: new Map<string, FakeSocket>(),
    adapter: { rooms: new Map<string, Set<string>>() },
  };

  to(room: string) {
    return {
      emit: (event: string, payload?: unknown) => {
        const direct = this.sockets.sockets.get(room);
        if (direct) {
          direct.received.push({ event, payload });
          return;
        }
        for (const sid of this.sockets.adapter.rooms.get(room) ?? []) {
          this.sockets.sockets.get(sid)?.received.push({ event, payload });
        }
      },
    };
  }
}

let seq = 0;

/** Серверный сокет: обработчики bindMatch вызываем напрямую, исходящие события копим. */
class FakeSocket {
  readonly id = `sock-${++seq}`;
  connected = true;
  data: Record<string, any>;
  rooms = new Set<string>();
  received: Received[] = [];
  private handlers = new Map<string, Handler[]>();

  constructor(private io: FakeIo, userId: string) {
    this.data = { userId };
    io.sockets.sockets.set(this.id, this);
    this.join(this.id);
    this.join(`u:${userId}`);
    bindMatch(io as any, this as any);
  }

  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }

  emit(event: string, payload?: unknown) {
    this.received.push({ event, payload });
    return true;
  }

  join(room: string) {
    this.rooms.add(room);
    const members = this.io.sockets.adapter.rooms.get(room) ?? new Set<string>();
    members.add(this.id);
    this.io.sockets.adapter.rooms.set(room, members);
  }

  leave(room: string) {
    this.rooms.delete(room);
    this.io.sockets.adapter.rooms.get(room)?.delete(this.id);
  }

  async fire(event: string, ...args: unknown[]) {
    await Promise.all((this.handlers.get(event) ?? []).map((h) => h(...args)));
  }

  request<T = any>(event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve) => {
      void this.fire(event, payload, resolve);
    });
  }

  /** Обрыв соединения: сокет пропадает из io, затем сервер получает disconnect. */
  async drop() {
    this.connected = false;
    this.io.sockets.sockets.delete(this.id);
    for (const room of [...this.rooms]) this.leave(room);
    await this.fire('disconnect', 'transport close');
  }

  got(event: string) {
    return this.received.filter((r) => r.event === event);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

let userSeq = 0;

async function pairUp() {
  const io = new FakeIo();
  userSeq += 1;
  const a = new FakeSocket(io, `user-a-${userSeq}`);
  const b = new FakeSocket(io, `user-b-${userSeq}`);
  await a.fire('start');
  await b.fire('start');
  await waitFor(() => a.got('match_found').length === 1 && b.got('match_found').length === 1);
  return { io, a, b, aUser: a.data.userId as string, bUser: b.data.userId as string };
}

describe('random chat: simultaneous searches', () => {
  it('does not reinsert an endpoint while its reserved pair awaits queue-removal completion', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'reserved-start-a');
    const b = new FakeSocket(io, 'reserved-start-b');
    let finishStart!: (ids: string[]) => void, finishRemoval!: () => void;
    let removalPending = false;
    const removalGate = new Promise<void>((resolve) => { finishRemoval = resolve; });
    jest.mocked(getPresenceFriendIds).mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const original = queueStore.removeFromQueue;
    const remove = jest.spyOn(queueStore, 'removeFromQueue').mockImplementation(async (sid) => {
      await original(sid);
      if (sid === a.id) { removalPending = true; await removalGate; }
    });
    const start = a.fire('start');
    try {
      await waitFor(() => !!finishStart);
      await queueStore.addToQueue(a.id);
      await b.fire('start');
      await waitFor(() => removalPending);
      finishStart([]);
      await start;
      expect(await queueStore.isInQueue(a.id)).toBe(false);
      finishRemoval();
      await waitFor(() => a.got('match_found').length === 1);
    } finally {
      finishStart([]); finishRemoval(); remove.mockRestore();
      await start;
      await Promise.all([a.fire('stop'), b.fire('stop')]);
    }
  });

  it('does not reinsert an already matched socket when a concurrent Start finishes its friend read late', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'late-start-a');
    const b = new FakeSocket(io, 'late-start-b');
    let finishStart!: (ids: string[]) => void;
    jest.mocked(getPresenceFriendIds).mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const start = a.fire('start');
    try {
      await waitFor(() => !!finishStart);
      // A Next requeue can make the socket available while Start still awaits metadata.
      await queueStore.addToQueue(a.id);
      await b.fire('start');
      await waitFor(() => a.got('match_found').length === 1);
      finishStart([]);
      await start;
      expect(await queueStore.isInQueue(a.id)).toBe(false);
      expect(a.got('match_found')).toHaveLength(1);
    } finally {
      finishStart([]);
      await start;
      await Promise.all([a.fire('stop'), b.fire('stop')]);
    }
  });

  it('does not announce stale busy=true after Stop when the earlier friend read finishes late', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'presence-order-a');
    let finishStart!: (ids: string[]) => void;
    let finishStop!: (ids: string[]) => void;
    const read = jest.mocked(getPresenceFriendIds);
    read.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishStop = resolve; }));
    const start = a.fire('start');
    await waitFor(() => !!finishStart);
    const stop = a.fire('stop');
    await waitFor(() => !!finishStop);
    finishStop([]);
    await stop;
    finishStart([]);
    await start;
    expect(a.got('presence:update').map((event) => event.payload.busy)).toEqual([false]);
    expect(await queueStore.isInQueue(a.id)).toBe(false);
  });

  it('contains a failed Start write and retries the original permission checks', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'start-oom-a');
    const b = new FakeSocket(io, 'start-oom-b');
    const fail = jest.spyOn(queueStore, 'setLastStart').mockRejectedValueOnce(new Error('OOM'));
    try {
      await expect(a.fire('start')).resolves.toBeUndefined();
      await b.fire('start');
      await waitFor(() => a.got('match_found').length === 1 && b.got('match_found').length === 1, 4000);
    } finally { fail.mockRestore(); await Promise.all([a.fire('stop'), b.fire('stop')]); }
  });

  it('retries Next when its first write failed before detaching the original pair', async () => {
    const { a, b } = await pairUp();
    const fail = jest.spyOn(queueStore, 'setLastSearch').mockRejectedValueOnce(new Error('OOM'));
    try {
      await expect(a.fire('next', { transitionId: 'retry-next' })).resolves.toBeUndefined();
      await waitFor(() => b.got('peer:left').length === 1, 4000);
      expect(b.got('peer:left')[0].payload.nextTransitionId).toBe('retry-next');
    } finally { fail.mockRestore(); await Promise.all([a.fire('stop'), b.fire('stop')]); }
  });

  it('does not pick a stopped user even if a late queue write restores its entry', async () => {
    const io = new FakeIo();
    const stopped = new FakeSocket(io, 'stopped-user');
    const searching = new FakeSocket(io, 'active-user');
    await stopped.fire('stop');
    await queueStore.addToQueue(stopped.id);
    await searching.fire('start');
    await sleep(30);
    expect(stopped.got('match_found')).toHaveLength(0);
    expect(searching.got('match_found')).toHaveLength(0);
    expect(await queueStore.isInQueue(stopped.id)).toBe(false);
    await searching.fire('stop');
  });

  it('releases the local pair even when Redis cleanup fails during Stop', async () => {
    const { a, b } = await pairUp();
    const failure = jest.spyOn(queueStore, 'removeFromQueue').mockRejectedValueOnce(new Error('Redis unavailable'));
    try {
      await a.fire('stop');
      for (const s of [a, b]) {
        expect(s.data.partnerSid).toBeUndefined();
        expect(s.data.inCall).toBe(false);
        expect(s.data.busy).toBe(false);
      }
      expect(b.got('peer:stopped')).toHaveLength(1);
    } finally { failure.mockRestore(); await b.fire('stop'); }
  });

  it('restores both queued searches after a transient queue write failure', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'queue-recovery-a');
    const b = new FakeSocket(io, 'queue-recovery-b');
    const remove = queueStore.removeFromQueue;
    const failure = jest.spyOn(queueStore, 'removeFromQueue').mockRejectedValueOnce(new Error('Redis temporarily unavailable'))
      .mockImplementation(remove);
    try {
      await Promise.all([a.fire('start'), b.fire('start')]);
      await waitFor(() => a.got('match_found').length === 1 && b.got('match_found').length === 1, 4000);
      expect(a.data.partnerSid).toBe(b.id);
      expect(b.data.partnerSid).toBe(a.id);
    } finally {
      failure.mockRestore();
      await Promise.all([a.fire('stop'), b.fire('stop')]);
    }
  });

  it('does not select a connected socket which never entered the waiting queue', async () => {
    const { tryMatch } = await import('./match');
    const io = new FakeIo();
    const idle = new FakeSocket(io, 'idle-user');
    const searching = new FakeSocket(io, 'searching-user');
    await searching.fire('start');
    expect(await tryMatch(io as any, idle as any)).toBe(false);
    expect(idle.got('match_found')).toHaveLength(0);
    expect(searching.got('match_found')).toHaveLength(0);
    await searching.fire('stop');
  });

  it('clears late Redis locks when Stop arrives while the pair is being locked', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'pending-lock-a');
    const b = new FakeSocket(io, 'pending-lock-b');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const lock = queueStore.lockSocket;
    const delayedLock = jest.spyOn(queueStore, 'lockSocket').mockImplementation(async (id) => { await gate; await lock(id); });
    try {
      await a.fire('start');
      await b.fire('start');
      await waitFor(() => delayedLock.mock.calls.length === 2);
      await a.fire('stop');
      release();
      await flushMatch();
      for (const s of [a, b]) {
        expect(s.data.inCall).toBe(false);
        expect(s.data.busy).toBe(false);
        expect(await queueStore.isLocked(s.id)).toBe(false);
        expect(s.got('match_found')).toHaveLength(0);
      }
    } finally {
      release(); delayedLock.mockRestore();
      await Promise.all([a.fire('stop'), b.fire('stop')]);
    }
  });

  it('does not deliver a late match or restore inCall after Stop during token creation', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'pending-token-a');
    const b = new FakeSocket(io, 'pending-token-b');
    let release!: (token: string) => void;
    const token = new Promise<string>((resolve) => { release = resolve; });
    const tokenMock = jest.mocked(createToken);
    tokenMock.mockImplementation(() => token);
    try {
      await a.fire('start');
      await b.fire('start');
      await waitFor(() => !!a.data.partnerSid && tokenMock.mock.calls.length > 0);
      await a.fire('stop');
      release('late-token');
      await flushMatch();
      expect(a.got('match_found')).toHaveLength(0);
      expect(b.got('match_found')).toHaveLength(0);
      expect(a.data.inCall).toBe(false);
      expect(b.data.inCall).toBe(false);
      expect(a.data.partnerSid).toBeUndefined();
      expect(b.data.partnerSid).toBeUndefined();
    } finally {
      release('late-token');
      tokenMock.mockImplementation(async () => 'lk-token');
      await Promise.all([a.fire('stop'), b.fire('stop')]);
    }
  });

  it('does not re-enqueue a stopped socket from an earlier Next timer', async () => {
    const { a, b } = await pairUp();
    await a.fire('next');
    await Promise.all([a.fire('stop'), b.fire('stop')]);
    await sleep(350);
    expect(await queueStore.isInQueue(a.id)).toBe(false);
    expect(await queueStore.isInQueue(b.id)).toBe(false);
    expect(a.data.busy).toBe(false);
    expect(b.data.busy).toBe(false);
  });

  it('gives every searching socket one reciprocal partner', async () => {
    const io = new FakeIo();
    const sockets = Array.from({ length: 100 }, (_, i) => new FakeSocket(io, `concurrent-${i}`));
    try {
      await Promise.all(sockets.map((s) => s.fire('start')));
      await waitFor(() => sockets.every((s) => s.got('match_found').length > 0), 5000);
      for (const s of sockets) {
        expect(s.got('match_found')).toHaveLength(1);
        const peer = io.sockets.sockets.get(s.data.partnerSid);
        expect(peer?.data.partnerSid).toBe(s.id);
        expect(s.got('match_found')[0].payload.id).toBe(peer?.id);
      }
    } finally {
      await Promise.all(sockets.map((s) => s.fire('stop')));
    }
  });
});

const flushMatch = () => new Promise((resolve) => setImmediate(resolve));

describe('random chat: pause for reconnect', () => {
  it('returns the same pair when the dropped user comes back in time', async () => {
    const { io, a, b, aUser, bUser } = await pairUp();

    await a.drop();
    expect(b.got('random:partnerReconnecting')).toEqual([
      { event: 'random:partnerReconnecting', payload: { graceMs: GRACE_MS } },
    ]);
    expect(b.got('disconnected')).toHaveLength(0);

    const a2 = new FakeSocket(io, aUser);
    const res = await a2.request('random:resume', { partnerUserId: bUser });
    expect(res).toEqual({
      ok: true,
      id: b.id,
      livekitToken: 'lk-token',
      livekitRoomName: `rand_room_${[aUser, bUser].sort().join('_')}`,
      livekitUrl: 'wss://lk.test',
    });
    expect(b.got('random:partnerResumed')).toEqual([
      { event: 'random:partnerResumed', payload: { id: a2.id } },
    ]);

    await sleep(GRACE_MS + 150);
    expect(b.got('disconnected')).toHaveLength(0);

    // Пара снова рабочая: «Далее» с нового сокета доходит до собеседника.
    await a2.fire('next');
    expect(b.got('peer:left')).toHaveLength(1);
  });

  it('sends the partner to search when the pause runs out', async () => {
    const { io, a, b, aUser, bUser } = await pairUp();

    await a.drop();
    await waitFor(() => b.got('disconnected').length === 1, GRACE_MS + 1000);
    expect(b.data.partnerSid).toBeUndefined();

    const a2 = new FakeSocket(io, aUser);
    const res = await a2.request('random:resume', { partnerUserId: bUser });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('takes over the pair while the server still counts the old socket as alive', async () => {
    const { io, a, b, aUser, bUser } = await pairUp();

    const a2 = new FakeSocket(io, aUser);
    const res = await a2.request('random:resume', { partnerUserId: bUser });
    expect(res).toMatchObject({ ok: true, id: b.id });
    expect(b.got('random:partnerResumed')).toHaveLength(1);

    // Запоздалый disconnect старого сокета не должен ни ставить паузу, ни рвать пару.
    await a.drop();
    await sleep(GRACE_MS + 150);
    expect(b.got('random:partnerReconnecting')).toHaveLength(0);
    expect(b.got('disconnected')).toHaveLength(0);
    expect(b.data.partnerSid).toBe(a2.id);
  });

  it('lets the partner go at once when the user starts a new search instead', async () => {
    const { io, a, b, aUser } = await pairUp();

    await a.drop();
    const a2 = new FakeSocket(io, aUser);
    await a2.fire('start');
    expect(b.got('disconnected')).toHaveLength(1);
  });

  it('lets the partner go at once when the user stops', async () => {
    const { io, a, b, aUser } = await pairUp();

    await a.drop();
    const a2 = new FakeSocket(io, aUser);
    await a2.fire('stop');
    expect(b.got('disconnected')).toHaveLength(1);
  });

  it('rejects the return when the partner already pressed Next', async () => {
    const { io, a, b, aUser, bUser } = await pairUp();

    await a.drop();
    await b.fire('next');
    const a2 = new FakeSocket(io, aUser);
    const res = await a2.request('random:resume', { partnerUserId: bUser });
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects the return into a pair with someone else', async () => {
    const { io, a, aUser } = await pairUp();

    await a.drop();
    const a2 = new FakeSocket(io, aUser);
    const res = await a2.request('random:resume', { partnerUserId: 'someone-else' });
    expect(res).toEqual({ ok: false, reason: 'partner_mismatch' });
  });

  it('gives a fresh LiveKit token to a socket that is still in the pair', async () => {
    const { a, b, aUser, bUser } = await pairUp();
    // Сокет жив, отвалился только LiveKit — клиент просит вернуть его в ту же комнату.
    const res = await a.request('random:resume', { partnerUserId: bUser });
    expect(res).toEqual({
      ok: true,
      id: b.id,
      livekitToken: 'lk-token',
      livekitRoomName: `rand_room_${[aUser, bUser].sort().join('_')}`,
      livekitUrl: 'wss://lk.test',
    });
    expect(b.got('random:partnerResumed')).toHaveLength(0);
    expect(a.data.partnerSid).toBe(b.id);
  });

  it('does not pause when the client closed the socket on purpose', async () => {
    const { a, b } = await pairUp();
    a.connected = false;
    await a.fire('disconnect', 'client namespace disconnect');
    expect(b.got('random:partnerReconnecting')).toHaveLength(0);
    expect(b.got('disconnected')).toHaveLength(1);
  });

  it('pauses when the server evicts the old socket because the user reconnected', async () => {
    const { io, a, b, aUser, bUser } = await pairUp();
    const a2 = new FakeSocket(io, aUser);
    // Так делает sockets/identity.ts: помечает вытесненный сокет и отключает его сам.
    a.data.evictedBy = a2.id;
    a.connected = false;
    io.sockets.sockets.delete(a.id);
    await a.fire('disconnect', 'server namespace disconnect');
    expect(b.got('random:partnerReconnecting')).toHaveLength(1);
    expect(b.got('disconnected')).toHaveLength(0);

    const res = await a2.request('random:resume', { partnerUserId: bUser });
    expect(res).toMatchObject({ ok: true, id: b.id });
  });

  it('does not throw when Redis is already closed during server shutdown', async () => {
    const { a } = await pairUp();
    const shutting = jest.spyOn(shutdownState, 'isShuttingDown').mockReturnValue(true);
    const unlock = jest.spyOn(queueStore, 'unlockSocket').mockRejectedValue(new Error('Connection is closed.'));
    try {
      a.connected = false;
      await expect(a.fire('disconnect', 'server shutting down')).resolves.toBeUndefined();
    } finally {
      shutting.mockRestore();
      unlock.mockRestore();
    }
  });

  it('keeps sockets in their personal user room through start and next', async () => {
    const { a, b, aUser, bUser } = await pairUp();
    await a.fire('next');
    // Через u:<userId> идут сообщения, presence и звонки — рандом не должен из неё выводить.
    expect(a.rooms.has(`u:${aUser}`)).toBe(true);
    expect(b.rooms.has(`u:${bUser}`)).toBe(true);
  });

  it('does not pause pairs that are not random chat (direct calls set partnerSid too)', async () => {
    const io = new FakeIo();
    const a = new FakeSocket(io, 'direct-a');
    const b = new FakeSocket(io, 'direct-b');
    a.data.partnerSid = b.id;
    b.data.partnerSid = a.id;

    await a.drop();
    expect(b.got('random:partnerReconnecting')).toHaveLength(0);
    expect(b.got('disconnected')).toHaveLength(1);
  });
});
