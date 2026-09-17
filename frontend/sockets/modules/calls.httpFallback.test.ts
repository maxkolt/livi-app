const mockSocket = {
  connected: false,
  emit: jest.fn(),
  on: jest.fn(),
  off: jest.fn(),
};

jest.mock('../../utils/installId', () => ({
  getInstallId: jest.fn(async () => 'install-test'),
  getInstallSecret: jest.fn(async () => 'secret-test'),
}));

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
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

import { startCall } from './calls';

describe('startCall HTTP fallback', () => {
  beforeEach(() => {
    mockSocket.connected = false;
    jest.restoreAllMocks();
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
  });
});
