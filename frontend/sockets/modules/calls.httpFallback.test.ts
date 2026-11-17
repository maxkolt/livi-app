const mockSocket = {
  connected: false,
  id: 'connection-1',
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
};

jest.mock('../../utils/installId', () => ({
  getInstallAuthHeaders: jest.fn(async () => ({ 'x-install-id': 'install-test', 'x-install-secret': 'secret-test' })),
}));

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('./constants', () => ({
  API_BASE: 'https://api.test',
  CALL_SIGNALING_CONNECT_MS: 100,
  isOid: (value: string) => /^[a-f\d]{24}$/i.test(String(value || '')),
}));

jest.mock('./emit', () => ({
  emitAck: jest.fn(),
  ensureSocketConnected: jest.fn(async () => undefined),
  warmCallSignaling: jest.fn(),
}));

jest.mock('./shared', () => ({
  shared: {
    reconnecting: false,
    currentUserId: '507f1f77bcf86cd799439011',
    earlyIncomingCallAcceptById: new Map(),
  },
}));

jest.mock('./socketCore', () => ({ socket: mockSocket }));
jest.mock('./reauth', () => ({ ensureReauthBeforePrivilegedSocketOp: jest.fn(async () => true) }));
const mockBindOutgoingCallE2ee = jest.fn<Promise<boolean>, [string, string, { pk: string }]>(async () => true);
jest.mock('./callE2ee', () => ({
  createOutgoingCallE2eeDeclaration: jest.fn(() => ({ pk: 'ephemeral-public-key' })),
  bindOutgoingCallE2ee: (callId: string, peerUserId: string, declaration: { pk: string }) =>
    mockBindOutgoingCallE2ee(callId, peerUserId, declaration),
  getOrCreateIncomingCallE2eeDeclaration: jest.fn(async () => ({ pk: 'incoming-public-key' })),
  peekIncomingCallE2eeDeclaration: jest.fn(() => ({ pk: 'incoming-public-key' })),
}));

import { emitCallAcceptAck, startCall } from './calls';
import { emitAck } from './emit';
import { ensureReauthBeforePrivilegedSocketOp } from './reauth';

describe('startCall HTTP fallback', () => {
  beforeEach(() => {
    mockSocket.connected = false;
    jest.restoreAllMocks();
    jest.mocked(emitAck).mockReset();
    jest.mocked(ensureReauthBeforePrivilegedSocketOp).mockReset().mockResolvedValue(true);
  });

  it('создаёт звонок через HTTP при недоступном Socket.IO', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, callId: 'call-http-1' }),
    } as Response);

    await expect(
      startCall('507f191e810c19729de860ea', { media: 'audio', callerNick: 'Test' }),
    ).resolves.toEqual({ ok: true, callId: 'call-http-1' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/calls/initiate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-install-id': 'install-test',
          'x-install-secret': 'secret-test',
          'x-user-id': '507f1f77bcf86cd799439011',
        }),
      }),
    );
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      to: '507f191e810c19729de860ea',
      e2ee: { pk: 'ephemeral-public-key' },
    });
    expect(mockBindOutgoingCallE2ee).toHaveBeenCalledWith(
      'call-http-1',
      '507f191e810c19729de860ea',
      { pk: 'ephemeral-public-key' },
    );
  });

  it('uses authenticated HTTP when a connected socket is still a guest', async () => {
    mockSocket.connected = true;
    jest.mocked(ensureReauthBeforePrivilegedSocketOp).mockResolvedValue(false);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ ok: true, callId: 'call-http-auth' }),
    } as Response);
    await expect(startCall('507f191e810c19729de860ea')).resolves.toMatchObject({ ok: true, callId: 'call-http-auth' });
    expect(emitAck).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back after an explicit socket authentication rejection', async () => {
    mockSocket.connected = true;
    jest.mocked(emitAck).mockResolvedValue({ ok: false, error: 'unauthorized' });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ ok: true, callId: 'call-http-retry' }),
    } as Response);
    await expect(startCall('507f191e810c19729de860ea')).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not initiate a second call after a semantic rejection', async () => {
    mockSocket.connected = true;
    jest.mocked(emitAck).mockResolvedValue({ ok: false, error: 'busy' });
    const fetchMock = jest.spyOn(global, 'fetch');
    await expect(startCall('507f191e810c19729de860ea')).resolves.toMatchObject({ ok: false, error: 'busy' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('waits for ownership proof before emitting accept', async () => {
    mockSocket.connected = true;
    let finish!: (value: boolean) => void;
    jest.mocked(ensureReauthBeforePrivilegedSocketOp).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    jest.mocked(emitAck).mockResolvedValue({ ok: true });
    const accept = emitCallAcceptAck('incoming-1');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(emitAck).not.toHaveBeenCalled();
    finish(true); expect(await accept).toMatchObject({ ok: true });
    expect(emitAck).toHaveBeenCalledWith('call:accept', expect.objectContaining({ callId: 'incoming-1' }), 7000, 1);
  });

  it('does not accept when reauth fails, even if an old success existed', async () => {
    mockSocket.connected = true;
    jest.mocked(ensureReauthBeforePrivilegedSocketOp).mockResolvedValue(false);
    await expect(emitCallAcceptAck('incoming-1')).resolves.toMatchObject({ ok: false, error: 'unauthorized' });
    expect(emitAck).not.toHaveBeenCalled();
  });

  it('refreshes proof once after an auth race and preserves E2EE on retry', async () => {
    mockSocket.connected = true;
    jest.mocked(emitAck).mockResolvedValueOnce({ ok: false, error: 'unauthorized' }).mockResolvedValueOnce({ ok: true });
    await expect(emitCallAcceptAck('incoming-1')).resolves.toMatchObject({ ok: true });
    expect(ensureReauthBeforePrivilegedSocketOp).toHaveBeenNthCalledWith(2, true);
    expect(emitAck).toHaveBeenCalledTimes(2);
    expect(jest.mocked(emitAck).mock.calls[0][1]).toEqual(jest.mocked(emitAck).mock.calls[1][1]);
  });

  it('does not retry an expired or canceled incoming call', async () => {
    mockSocket.connected = true;
    jest.mocked(emitAck).mockResolvedValue({ ok: false, error: 'not_found' });
    await expect(emitCallAcceptAck('incoming-1')).resolves.toMatchObject({ ok: false, error: 'not_found' });
    expect(emitAck).toHaveBeenCalledTimes(1);
  });
});
