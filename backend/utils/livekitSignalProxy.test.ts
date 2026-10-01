import http from 'http';
import net from 'net';
import {
  attachLiveKitSignalProxy,
  resolveLiveKitSignalUpstream,
} from './livekitSignalProxy';

describe('resolveLiveKitSignalUpstream', () => {
  it('проксирует только /livekit/rtc и сохраняет параметры LiveKit', () => {
    const result = resolveLiveKitSignalUpstream(
      '/livekit/rtc?access_token=secret&auto_subscribe=1',
      'wss://livekit.liviapp.com',
    );
    expect(result).toEqual({
      secure: true,
      hostname: 'livekit.liviapp.com',
      port: 443,
      hostHeader: 'livekit.liviapp.com',
      path: '/rtc?access_token=secret&auto_subscribe=1',
    });
  });

  it('сохраняет base path и нестандартный порт upstream', () => {
    const result = resolveLiveKitSignalUpstream(
      '/livekit/rtc/reconnect?access_token=secret',
      'ws://127.0.0.1:7880/base/',
    );
    expect(result?.path).toBe('/base/rtc/reconnect?access_token=secret');
    expect(result?.port).toBe(7880);
    expect(result?.secure).toBe(false);
  });

  it('не принимает запрос без токена или вне signaling path', () => {
    expect(resolveLiveKitSignalUpstream('/livekit/rtc', 'wss://livekit.liviapp.com')).toBeNull();
    expect(
      resolveLiveKitSignalUpstream('/livekit/admin?access_token=secret', 'wss://livekit.liviapp.com'),
    ).toBeNull();
  });

  it('не принимает upstream с протоколом HTTP', () => {
    expect(
      resolveLiveKitSignalUpstream('/livekit/rtc?access_token=secret', 'https://example.com'),
    ).toBeNull();
  });

  it('передаёт реальный WebSocket upgrade локальному upstream', async () => {
    let receivedUrl = '';
    const upstream = http.createServer();
    upstream.on('upgrade', (req, socket) => {
      receivedUrl = String(req.url || '');
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('missing upstream port');

    const proxy = http.createServer();
    attachLiveKitSignalProxy(proxy, `ws://127.0.0.1:${upstreamAddress.port}`);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('missing proxy port');

    const response = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyAddress.port, '127.0.0.1');
      let data = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('proxy test timeout'));
      }, 2_000);
      socket.on('connect', () => {
        socket.write(
          'GET /livekit/rtc?access_token=test-token&auto_subscribe=1 HTTP/1.1\r\n' +
            'Host: api.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC10ZXN0LXRlc3Q=\r\n\r\n',
        );
      });
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('end', () => {
        clearTimeout(timer);
        resolve(data);
      });
      socket.on('error', reject);
    });

    expect(response).toContain('101 Switching Protocols');
    expect(receivedUrl).toBe('/rtc?access_token=test-token&auto_subscribe=1');
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  });
});
