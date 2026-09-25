import { deliverLiveMessage, LIVE_DELIVERY_ACK_TIMEOUT_MS } from './liveMessageDelivery';

type Cb = (err: unknown, responses: unknown[]) => void;

function makeIo(sockets: Array<{ handshake?: { query?: Record<string, unknown> } }>) {
  const plain: unknown[] = [];
  const acked: Array<{ payload: unknown; timeout: number; cb: Cb }> = [];
  const io = {
    in: jest.fn(() => ({ fetchSockets: async () => sockets })),
    to: jest.fn(() => ({
      emit: (_event: string, payload: unknown) => plain.push(payload),
      timeout: (ms: number) => ({
        emit: (_event: string, payload: unknown, cb: Cb) => acked.push({ payload, timeout: ms, cb }),
      }),
    })),
  };
  return { io, plain, acked };
}

const modern = { handshake: { query: { caps: 'offline_ack' } } };
const legacy = { handshake: { query: {} } };

describe('deliverLiveMessage', () => {
  it('reports offline when the recipient has no sockets', async () => {
    const { io } = makeIo([]);
    await expect(deliverLiveMessage(io, 'u', { id: 'm' }, jest.fn())).resolves.toBe('offline');
  });

  it('waits for the client to confirm and does nothing more when it does', async () => {
    const { io, acked } = makeIo([modern]);
    const onUnconfirmed = jest.fn();
    await expect(deliverLiveMessage(io, 'u', { id: 'm' }, onUnconfirmed)).resolves.toBe('awaiting_ack');
    expect(acked[0].timeout).toBe(LIVE_DELIVERY_ACK_TIMEOUT_MS);
    acked[0].cb(null, [{ ok: true }]);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  it('falls back to the offline queue when a dead socket never confirms', async () => {
    const { io, acked } = makeIo([modern]);
    const onUnconfirmed = jest.fn();
    await deliverLiveMessage(io, 'u', { id: 'm' }, onUnconfirmed);
    acked[0].cb(new Error('operation has timed out'), []);
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });

  it('counts one confirming device as delivered, even if another timed out', async () => {
    const { io, acked } = makeIo([modern, modern]);
    const onUnconfirmed = jest.fn();
    await deliverLiveMessage(io, 'u', { id: 'm' }, onUnconfirmed);
    acked[0].cb(new Error('timeout'), [{ ok: true }]);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  it('keeps the old fire-and-forget path when any recipient socket is an old app', async () => {
    const { io, plain, acked } = makeIo([modern, legacy]);
    await expect(deliverLiveMessage(io, 'u', { id: 'm' }, jest.fn())).resolves.toBe('legacy');
    expect(plain).toEqual([{ id: 'm' }]);
    expect(acked).toHaveLength(0);
  });
});
