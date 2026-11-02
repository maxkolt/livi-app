import {
  deliverOfflineMessages,
  socketSupportsOfflineAck,
  OFFLINE_ACK_TIMEOUT_MS,
  OFFLINE_CLAIM_LEASE_MS,
  OFFLINE_DELIVERY_BATCH_SIZE,
  OfflineQueuePort,
} from './offlineMessageDelivery';

type AckCb = (err: unknown, res?: any) => void;

function makeSocket(caps?: unknown) {
  const plain: Array<{ event: string; data: any }> = [];
  const acked: Array<{ event: string; data: any; cb: AckCb; timeoutMs: number }> = [];
  const sock = {
    handshake: { query: caps === undefined ? {} : { caps } },
    emit: jest.fn((event: string, data: any) => {
      plain.push({ event, data });
    }),
    timeout: jest.fn((timeoutMs: number) => ({
      emit: (event: string, data: any, cb: AckCb) => {
        acked.push({ event, data, cb, timeoutMs });
      },
    })),
  };
  return { sock, plain, acked };
}

function makeQueue(overrides: Partial<OfflineQueuePort> = {}) {
  return {
    claim: jest.fn(async () => [
      { queueId: 'q1', messageData: { id: 'm1' } },
      { queueId: 'q2', messageData: { id: 'm2' } },
    ]),
    remove: jest.fn(async () => {}),
    takeAll: jest.fn(async () => [{ id: 'legacy1' }, { id: 'legacy2' }]),
    ...overrides,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('socketSupportsOfflineAck', () => {
  it('reads the capability from a comma list or an array', () => {
    expect(socketSupportsOfflineAck({ handshake: { query: { caps: 'offline_ack' } } })).toBe(true);
    expect(socketSupportsOfflineAck({ handshake: { query: { caps: 'x, offline_ack' } } })).toBe(true);
    expect(socketSupportsOfflineAck({ handshake: { query: { caps: ['x', 'offline_ack'] } } })).toBe(true);
  });

  it('treats missing or unrelated caps as a legacy client', () => {
    expect(socketSupportsOfflineAck({})).toBe(false);
    expect(socketSupportsOfflineAck({ handshake: { query: {} } })).toBe(false);
    expect(socketSupportsOfflineAck({ handshake: { query: { caps: 'offline_ack_v2' } } })).toBe(false);
  });
});

describe('deliverOfflineMessages', () => {
  it('bounds in-flight messages, shares overlapping binds and renews each batch lease', async () => {
    const { sock, acked } = makeSocket('offline_ack');
    let clock = 1000;
    const queue = makeQueue({ claim: jest.fn()
      .mockResolvedValueOnce(Array.from({ length: OFFLINE_DELIVERY_BATCH_SIZE }, (_, i) => ({ queueId: i, messageData: { id: i } })))
      .mockResolvedValueOnce([{ queueId: 'last', messageData: { id: 'last' } }]) });
    const first = await deliverOfflineMessages(sock, 'u1', queue, () => clock);
    expect(first).toBe(OFFLINE_DELIVERY_BATCH_SIZE);
    expect(acked).toHaveLength(OFFLINE_DELIVERY_BATCH_SIZE);
    await expect(deliverOfflineMessages(sock, 'u1', queue, () => clock)).resolves.toBe(first);
    expect(queue.claim).toHaveBeenCalledTimes(1);
    clock += 15_000;
    for (const message of [...acked]) message.cb(null, { ok: true });
    await flush();
    expect(queue.claim).toHaveBeenNthCalledWith(2, 'u1', new Date(1000), new Date(clock + OFFLINE_CLAIM_LEASE_MS), OFFLINE_DELIVERY_BATCH_SIZE);
    expect(acked).toHaveLength(OFFLINE_DELIVERY_BATCH_SIZE + 1);
    acked[acked.length - 1].cb(null, { ok: true });
    await flush();
    expect(queue.remove).toHaveBeenCalledTimes(OFFLINE_DELIVERY_BATCH_SIZE + 1);
  });

  it('stops on disconnect but keeps an unacknowledged row from blocking the remaining backlog', async () => {
    for (const disconnect of [true, false]) {
      const { sock, acked } = makeSocket('offline_ack');
      const connected = Object.assign(sock, { connected: true });
      const queue = makeQueue({ claim: jest.fn()
        .mockResolvedValueOnce(Array.from({ length: OFFLINE_DELIVERY_BATCH_SIZE }, (_, i) => ({ queueId: i, messageData: { id: i } })))
        .mockResolvedValueOnce([]) });
      await deliverOfflineMessages(connected, 'u1', queue);
      if (disconnect) connected.connected = false;
      acked.forEach((message, i) => message.cb(i === 0 && !disconnect ? new Error('timeout') : null, { ok: true }));
      await flush();
      expect(queue.claim).toHaveBeenCalledTimes(disconnect ? 1 : 2);
      expect(queue.remove).toHaveBeenCalledTimes(disconnect ? OFFLINE_DELIVERY_BATCH_SIZE : OFFLINE_DELIVERY_BATCH_SIZE - 1);
    }
  });
  it('keeps take-and-delete for legacy clients', async () => {
    const { sock, plain, acked } = makeSocket();
    const queue = makeQueue();

    await expect(deliverOfflineMessages(sock, 'u1', queue)).resolves.toBe(2);

    expect(queue.takeAll).toHaveBeenCalledWith('u1', OFFLINE_DELIVERY_BATCH_SIZE, expect.any(Date));
    expect(queue.claim).not.toHaveBeenCalled();
    expect(plain.map((e) => e.data.id)).toEqual(['legacy1', 'legacy2']);
    expect(acked).toHaveLength(0);
  });

  it('claims with a lease longer than the ack timeout', async () => {
    const { sock } = makeSocket('offline_ack');
    const queue = makeQueue();

    await deliverOfflineMessages(sock, 'u1', queue, () => 1_000);

    expect(queue.claim).toHaveBeenCalledWith('u1', new Date(1_000), new Date(1_000 + OFFLINE_CLAIM_LEASE_MS), OFFLINE_DELIVERY_BATCH_SIZE);
    expect(OFFLINE_CLAIM_LEASE_MS).toBeGreaterThan(OFFLINE_ACK_TIMEOUT_MS);
  });

  it('deletes a queue entry only after the client acks it', async () => {
    const { sock, plain, acked } = makeSocket('offline_ack');
    const queue = makeQueue();

    await expect(deliverOfflineMessages(sock, 'u1', queue)).resolves.toBe(2);
    expect(plain).toHaveLength(0);
    expect(acked.map((e) => [e.event, e.data.id, e.timeoutMs])).toEqual([
      ['message:received', 'm1', OFFLINE_ACK_TIMEOUT_MS],
      ['message:received', 'm2', OFFLINE_ACK_TIMEOUT_MS],
    ]);
    expect(queue.remove).not.toHaveBeenCalled();

    acked[1].cb(null, { ok: true });
    await flush();
    expect(queue.remove).toHaveBeenCalledTimes(1);
    expect(queue.remove).toHaveBeenCalledWith('q2');
  });

  it('keeps the entry when the ack times out or is negative', async () => {
    const { sock, acked } = makeSocket('offline_ack');
    const queue = makeQueue();

    await deliverOfflineMessages(sock, 'u1', queue);
    acked[0].cb(new Error('operation has timed out'));
    acked[1].cb(null, { ok: false });
    await flush();

    expect(queue.remove).not.toHaveBeenCalled();
  });

  it('does not throw into bindUser when claiming fails', async () => {
    const { sock, acked } = makeSocket('offline_ack');
    const queue = makeQueue({ claim: jest.fn(async () => { throw new Error('mongo down'); }) });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(deliverOfflineMessages(sock, 'u1', queue)).resolves.toBe(0);
    expect(acked).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('swallows a failed delete after ack', async () => {
    const { sock, acked } = makeSocket('offline_ack');
    const queue = makeQueue({ remove: jest.fn(async () => { throw new Error('mongo down'); }) });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await deliverOfflineMessages(sock, 'u1', queue);
    acked[0].cb(null, { ok: true });
    await flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
