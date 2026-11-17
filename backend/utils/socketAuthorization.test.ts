import { EventEmitter } from 'events';
import type { AuthedSocket } from '../sockets/types';
import { LEGACY_INSTALL_SEAL } from './installSecret';
import { installSocketAuthorization } from './socketAuthorization';

function fixture() {
  let middleware!: Parameters<AuthedSocket['use']>[0];
  const sock = Object.assign(new EventEmitter(), {
    connected: true, data: {} as AuthedSocket['data'],
    handshake: { auth: { installId: 'known-id', userId: 'known-user' } },
    use: (fn: typeof middleware) => { middleware = fn; },
  }) as unknown as AuthedSocket;
  installSocketAuthorization(sock, 100);
  const send = (event: string) => {
    const ack = jest.fn(); const next = jest.fn();
    middleware([event, {}, ack], next);
    return { ack, next };
  };
  const prove = () => Object.assign(sock.data, {
    userId: 'known-user', verifiedInstallId: 'known-id', verifiedInstallSecretHash: 'verified-proof',
  });
  return { sock, send, prove };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it.each(['call:accept', 'call:initiate'])('waits for verified attachment before %s on an old release', async event => {
  const { send, prove, sock } = fixture(); const call = send(event);
  expect(call.next).not.toHaveBeenCalled(); expect(call.ack).not.toHaveBeenCalled();
  const attach = send('identity:attach'); expect(attach.next).toHaveBeenCalledTimes(1);
  prove(); await jest.advanceTimersByTimeAsync(25);
  expect(call.next).toHaveBeenCalledTimes(1); expect(call.ack).not.toHaveBeenCalled();
  expect(sock.listenerCount('disconnect')).toBe(0); expect(jest.getTimerCount()).toBe(0);
});

it('never authorizes knowledge of identifiers without proof and bounds the wait', async () => {
  const { send } = fixture(); const call = send('call:accept');
  await jest.advanceTimersByTimeAsync(100);
  expect(call.next).not.toHaveBeenCalled(); expect(call.ack).toHaveBeenCalledWith({ ok: false, error: 'unauthorized' });
  expect(jest.getTimerCount()).toBe(0);
});

it('requires completed binding, not just an installation proof', async () => {
  const { send, sock } = fixture(); const call = send('call:accept');
  sock.data.verifiedInstallId = 'known-id'; sock.data.verifiedInstallSecretHash = 'proof';
  await jest.advanceTimersByTimeAsync(100);
  expect(call.next).not.toHaveBeenCalled(); expect(call.ack).toHaveBeenCalledTimes(1);
});

it('cancels pending authorization immediately on disconnect', async () => {
  const { send, sock, prove } = fixture(); const call = send('call:accept');
  sock.connected = false; sock.emit('disconnect', 'transport close'); prove();
  await jest.advanceTimersByTimeAsync(100);
  expect(call.next).not.toHaveBeenCalled(); expect(call.ack).toHaveBeenCalledTimes(1);
  expect(sock.listenerCount('disconnect')).toBe(0); expect(jest.getTimerCount()).toBe(0);
});

it('limits concurrent guest waits and shares one timer', async () => {
  const { send, prove } = fixture(); const calls = Array.from({ length: 5 }, () => send('call:accept'));
  expect(calls[4].ack).toHaveBeenCalledWith({ ok: false, error: 'unauthorized' });
  expect(jest.getTimerCount()).toBe(1);
  prove(); await jest.advanceTimersByTimeAsync(25);
  for (const call of calls.slice(0, 4)) expect(call.next).toHaveBeenCalledTimes(1);
  expect(calls[4].next).not.toHaveBeenCalled();
});

it('keeps other guest operations rejected immediately and verified calls immediate', () => {
  const { send, prove } = fixture();
  expect(send('e2e:publish').ack).toHaveBeenCalledWith({ ok: false, error: 'unauthorized' });
  prove(); expect(send('call:accept').next).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it('preserves staged legacy restrictions after attachment', () => {
  const { send, prove, sock } = fixture(); prove(); sock.data.verifiedInstallSecretHash = LEGACY_INSTALL_SEAL;
  expect(send('identity:wipeMe').ack).toHaveBeenCalledWith({ ok: false, error: 'account_proof_required' });
  expect(send('e2e:publish').next).not.toHaveBeenCalled();
  expect(send('call:accept').next).toHaveBeenCalledTimes(1);
});
