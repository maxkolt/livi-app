import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import {
  __resetCallKeepAliveForTests,
  attachCallKeepAlive,
  CALL_KEEPALIVE_PATH,
  deliverCallKeepAlive,
  getCallKeepAliveStats,
} from './callKeepAlive';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

type Frame = { t: string; data?: Record<string, string>; ts?: number };

function nextFrame(ws: WebSocket): Promise<Frame> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(String(raw))));
    ws.once('error', reject);
  });
}

describe('call keep-alive channel', () => {
  let server: http.Server;
  let url: string;
  const connected: string[] = [];
  /** Чужие upgrade-пути в проде забирают socket.io и прокси LiveKit — здесь заглушка. */
  const otherUpgrades: string[] = [];

  beforeEach(async () => {
    connected.length = 0;
    otherUpgrades.length = 0;
    server = http.createServer();
    server.on('upgrade', (req, socket) => {
      if (String(req.url || '').startsWith(CALL_KEEPALIVE_PATH)) return;
      otherUpgrades.push(String(req.url));
      socket.destroy();
    });
    attachCallKeepAlive(
      server,
      async (req) => {
        const installId = String(req.headers['x-install-id'] || '');
        if (!installId.startsWith('ok-')) return null;
        return { userId: String(req.headers['x-test-user'] || 'u1'), installId };
      },
      (auth) => connected.push(`${auth.userId}:${auth.installId}`),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${CALL_KEEPALIVE_PATH}`;
  });

  afterEach(async () => {
    __resetCallKeepAliveForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const open = async (installId: string, userId = 'u1') => {
    const ws = new WebSocket(url, { headers: { 'x-install-id': installId, 'x-test-user': userId } });
    const hello = nextFrame(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect((await hello).t).toBe('hb');
    return ws;
  };

  it('rejects connections that fail install auth', async () => {
    const ws = new WebSocket(url, { headers: { 'x-install-id': 'stolen' } });
    const status = await new Promise<number>((resolve) => {
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode || 0));
      ws.once('error', () => resolve(-1));
    });
    expect(status).toBe(401);
    expect(getCallKeepAliveStats().sockets).toBe(0);
  });

  it('delivers call events with the same fields as FCM data', async () => {
    const ws = await open('ok-install-1');
    expect(connected).toEqual(['u1:ok-install-1']);

    const pushed = nextFrame(ws);
    const sent = deliverCallKeepAlive('u1', { type: 'call', callId: 'c1', fromUserId: 'a', ts: '1' });
    expect(sent).toBe(1);
    const frame = await pushed;
    expect(frame.t).toBe('push');
    expect(frame.data).toEqual({ type: 'call', callId: 'c1', fromUserId: 'a', ts: '1' });

    expect(deliverCallKeepAlive('someone-else', { type: 'call', callId: 'c2' })).toBe(0);
    ws.close();
  });

  it('keeps one connection per install after a network switch', async () => {
    const first = await open('ok-install-1');
    const firstClosed = new Promise<void>((resolve) => first.once('close', () => resolve()));
    const second = await open('ok-install-1');
    await firstClosed;
    expect(getCallKeepAliveStats()).toEqual({ users: 1, sockets: 1 });

    const other = await open('ok-install-2');
    expect(getCallKeepAliveStats()).toEqual({ users: 1, sockets: 2 });
    second.close();
    other.close();
  });

  it('leaves other upgrade paths to their own handlers', async () => {
    const otherUrl = url.replace(CALL_KEEPALIVE_PATH, '/livekit/rtc');
    const ws = new WebSocket(otherUrl, { headers: { 'x-install-id': 'ok-install-1' } });
    ws.on('error', () => {});
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('close', () => resolve('closed'));
    });
    expect(outcome).toBe('closed');
    expect(otherUpgrades).toEqual(['/livekit/rtc']);
    expect(getCallKeepAliveStats().sockets).toBe(0);
  });
});
