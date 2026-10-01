import type { IncomingMessage, Server as HttpServer } from 'http';
import net from 'net';
import tls from 'tls';
import type { Duplex } from 'stream';
import { logger } from './logger';

const SIGNAL_PROXY_PREFIX = '/livekit';
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

export type LiveKitSignalUpstream = {
  secure: boolean;
  hostname: string;
  port: number;
  hostHeader: string;
  path: string;
};

/**
 * Преобразует /livekit/rtc?... в фиксированный upstream LiveKit /rtc?....
 * Клиент не может выбрать upstream, поэтому endpoint не превращается в open proxy.
 */
export function resolveLiveKitSignalUpstream(
  requestUrl: string,
  liveKitUrl: string,
): LiveKitSignalUpstream | null {
  try {
    const incoming = new URL(requestUrl, 'http://signal-proxy.local');
    const rtcPath = `${SIGNAL_PROXY_PREFIX}/rtc`;
    if (incoming.pathname !== rtcPath && !incoming.pathname.startsWith(`${rtcPath}/`)) {
      return null;
    }
    if (!incoming.searchParams.get('access_token')) return null;

    const target = new URL(liveKitUrl);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return null;
    const secure = target.protocol === 'wss:';
    const targetBasePath = target.pathname === '/' ? '' : target.pathname.replace(/\/+$/, '');
    const signalPath = incoming.pathname.slice(SIGNAL_PROXY_PREFIX.length);

    return {
      secure,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : secure ? 443 : 80,
      hostHeader: target.host,
      path: `${targetBasePath}${signalPath}${incoming.search}`,
    };
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function buildUpstreamHandshake(req: IncomingMessage, upstream: LiveKitSignalUpstream): string {
  const lines = [`GET ${upstream.path} HTTP/1.1`, `Host: ${upstream.hostHeader}`];
  const skipped = new Set(['host', 'connection', 'upgrade', 'content-length']);
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (!name || value === undefined || skipped.has(name.toLowerCase())) continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push('Connection: Upgrade', 'Upgrade: websocket', '', '');
  return lines.join('\r\n');
}

/**
 * Проксирует только WebSocket signaling LiveKit. Медиа не идёт через Node:
 * после join оно устанавливается обычным WebRTC, включая TURN relay-only fallback.
 */
export function attachLiveKitSignalProxy(server: HttpServer, liveKitUrl: string): void {
  const configuredUrl = String(liveKitUrl || '').trim();
  if (!configuredUrl) {
    logger.warn('[LiveKit signal proxy] disabled: LIVEKIT_URL is empty');
    return;
  }

  server.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const requestUrl = String(req.url || '');
    const isProxyPath = requestUrl === SIGNAL_PROXY_PREFIX || requestUrl.startsWith(`${SIGNAL_PROXY_PREFIX}/`);
    if (!isProxyPath) return;

    const upstreamInfo = resolveLiveKitSignalUpstream(requestUrl, configuredUrl);
    if (!upstreamInfo) {
      rejectUpgrade(clientSocket, 400, 'Bad Request');
      return;
    }

    let connected = false;
    let upstreamSocket: net.Socket;
    const onConnected = () => {
      connected = true;
      clearTimeout(connectTimer);
      if (clientSocket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      upstreamSocket.write(buildUpstreamHandshake(req, upstreamInfo));
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket).pipe(clientSocket);
    };

    if (upstreamInfo.secure) {
      upstreamSocket = tls.connect(
        {
          host: upstreamInfo.hostname,
          port: upstreamInfo.port,
          ...(net.isIP(upstreamInfo.hostname) ? {} : { servername: upstreamInfo.hostname }),
        },
        onConnected,
      );
    } else {
      upstreamSocket = net.connect(
        { host: upstreamInfo.hostname, port: upstreamInfo.port },
        onConnected,
      );
    }

    const connectTimer = setTimeout(() => {
      logger.warn('[LiveKit signal proxy] upstream connect timeout', {
        upstreamHost: upstreamInfo.hostname,
      });
      upstreamSocket.destroy();
      rejectUpgrade(clientSocket, 504, 'Gateway Timeout');
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    upstreamSocket.once('error', (error) => {
      clearTimeout(connectTimer);
      logger.warn('[LiveKit signal proxy] upstream error', {
        upstreamHost: upstreamInfo.hostname,
        error: error.message,
      });
      if (!connected) rejectUpgrade(clientSocket, 502, 'Bad Gateway');
      else clientSocket.destroy();
    });
    clientSocket.once('error', () => upstreamSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
  });

  logger.info('[LiveKit signal proxy] enabled', { path: `${SIGNAL_PROXY_PREFIX}/rtc` });
}
