jest.mock('../utils/logger', () => ({
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
}));
jest.mock('../routes/livekit', () => ({
  createToken: async () => 'lk-token',
  getLiveKitUrl: () => 'wss://lk.test',
}));
jest.mock('../utils/friendshipUtils', () => ({ getFriendIds: async () => [] }));
jest.mock('../utils/friendOnlinePresence', () => ({ scheduleGlobalFriendPresenceEmit: () => {} }));
jest.mock('../utils/rateLimit', () => ({ checkRateLimit: async () => ({ ok: true }) }));
jest.mock('../models/UserReport', () => ({ __esModule: true, default: {}, isUserReportReason: () => true }));

import { bindMatch } from './match';

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
