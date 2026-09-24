import {
  deliverOfflineMessages,
  socketSupportsOfflineAck,
  OFFLINE_ACK_TIMEOUT_MS,
  OFFLINE_CLAIM_LEASE_MS,
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
  it('keeps take-and-delete for legacy clients', async () => {
    const { sock, plain, acked } = makeSocket();
    const queue = makeQueue();

    await expect(deliverOfflineMessages(sock, 'u1', queue)).resolves.toBe(2);

    expect(queue.takeAll).toHaveBeenCalledWith('u1');
    expect(queue.claim).not.toHaveBeenCalled();
    expect(plain.map((e) => e.data.id)).toEqual(['legacy1', 'legacy2']);
    expect(acked).toHaveLength(0);
  });

  it('claims with a lease longer than the ack timeout', async () => {
    const { sock } = makeSocket('offline_ack');
    const queue = makeQueue();

    await deliverOfflineMessages(sock, 'u1', queue, () => 1_000);

    expect(queue.claim).toHaveBeenCalledWith('u1', new Date(1_000), new Date(1_000 + OFFLINE_CLAIM_LEASE_MS));
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
