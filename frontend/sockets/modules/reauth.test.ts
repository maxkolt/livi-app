const mockSocket = { connected: true, id: 'connection-1' };
jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('../../utils/installId', () => ({ getInstallSecret: jest.fn(async () => 'original-secret') }));
jest.mock('./emit', () => ({ emitAck: jest.fn(), ensureSocketConnected: jest.fn(async () => {}) }));
jest.mock('./missedCalls', () => ({ applyMissedFromReauth: jest.fn(async () => {}) }));
jest.mock('./shared', () => ({ shared: {
  currentUserId: 'owner', lastSuccessfulReauthAt: 0, reauthInFlight: null,
  lastSuccessfulReauthSocketId: undefined, lastSuccessfulReauthUserId: undefined,
} }));

import { shared } from './shared';
import { emitAck } from './emit';
import { emitReauthDeduped, ensureReauthBeforePrivilegedSocketOp, hasFreshPrivilegedSocketProof, hasPrivilegedSocketOwnershipProof } from './reauth';

beforeEach(() => {
  mockSocket.connected = true; mockSocket.id = 'connection-1';
  shared.currentUserId = 'owner'; shared.lastSuccessfulReauthAt = 0;
  shared.lastSuccessfulReauthSocketId = undefined; shared.lastSuccessfulReauthUserId = undefined;
  shared.reauthInFlight = null;
  jest.mocked(emitAck).mockReset().mockResolvedValue({ ok: true });
});

it('reuses proof only for the same connection and user', async () => {
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(true);
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(true);
  expect(emitAck).toHaveBeenCalledTimes(1);
  expect(emitAck).toHaveBeenCalledWith('reauth', { userId: 'owner', installSecret: 'original-secret' }, 6000, 1);
  mockSocket.id = 'connection-2';
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(true);
  expect(emitAck).toHaveBeenCalledTimes(2);
  shared.currentUserId = 'another-owner';
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(true);
  expect(emitAck).toHaveBeenCalledTimes(3);
});

it('does not treat a recent timestamp from the old connection as authenticated', async () => {
  shared.lastSuccessfulReauthAt = Date.now(); shared.lastSuccessfulReauthSocketId = 'old-connection';
  jest.mocked(emitAck).mockResolvedValue({ ok: false, error: 'unauthorized' });
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(false);
  expect(shared.lastSuccessfulReauthAt).toBe(0);
});

it('rejects a late successful ACK from a lost connection', async () => {
  let finish!: (value: unknown) => void;
  jest.mocked(emitAck).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const auth = emitReauthDeduped('owner'); await Promise.resolve();
  mockSocket.id = 'connection-2'; finish({ ok: true });
  expect(await auth).toEqual({ ok: false, error: 'connection_changed' });
  expect(shared.lastSuccessfulReauthAt).toBe(0);
});

it('keeps new connection authentication in flight when an old ACK finishes', async () => {
  const pending: Array<(value: unknown) => void> = [];
  jest.mocked(emitAck).mockImplementation(() => new Promise(resolve => { pending.push(resolve); }));
  const old = emitReauthDeduped('owner'); await Promise.resolve();
  mockSocket.id = 'connection-2';
  const current = emitReauthDeduped('owner'); await Promise.resolve();
  pending[0]({ ok: true }); await old;
  expect(shared.reauthInFlight).not.toBeNull();
  pending[1]({ ok: true }); expect(await current).toEqual({ ok: true });
  expect(shared.lastSuccessfulReauthSocketId).toBe('connection-2');
});

it('deduplicates concurrent requests on the same connection', async () => {
  await Promise.all([emitReauthDeduped('owner'), emitReauthDeduped('owner')]);
  expect(emitAck).toHaveBeenCalledTimes(1);
});

it('never reports a disconnected socket authenticated', async () => {
  mockSocket.connected = false;
  expect(await ensureReauthBeforePrivilegedSocketOp()).toBe(false);
  expect(emitAck).not.toHaveBeenCalled();
});

it('fresh proof is synchronously scoped to the live socket, user and expiry', async () => {
  await ensureReauthBeforePrivilegedSocketOp();
  expect(hasFreshPrivilegedSocketProof()).toBe(true);
  shared.currentUserId = 'another-owner';
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
  shared.currentUserId = 'owner'; mockSocket.id = 'connection-2';
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
  mockSocket.id = 'connection-1'; shared.lastSuccessfulReauthAt = Date.now() - 6001;
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
  shared.lastSuccessfulReauthAt = Date.now() + 1000;
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
  shared.lastSuccessfulReauthAt = Date.now(); mockSocket.connected = false;
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
});

it('keeps a live socket ownership binding after the freshness window, but never across reconnect/user change', async () => {
  await ensureReauthBeforePrivilegedSocketOp();
  shared.lastSuccessfulReauthAt = Date.now() - 30_000;
  expect(hasFreshPrivilegedSocketProof()).toBe(false);
  expect(hasPrivilegedSocketOwnershipProof()).toBe(true);
  mockSocket.id = 'connection-2';
  expect(hasPrivilegedSocketOwnershipProof()).toBe(false);
  mockSocket.id = 'connection-1'; shared.currentUserId = 'another-owner';
  expect(hasPrivilegedSocketOwnershipProof()).toBe(false);
  shared.currentUserId = 'owner'; mockSocket.connected = false;
  expect(hasPrivilegedSocketOwnershipProof()).toBe(false);
});
