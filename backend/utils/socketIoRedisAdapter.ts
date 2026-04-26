import type { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { logger } from './logger';

const REDIS_URL = (process.env.REDIS_URL || process.env.REDIS_URI || '').trim();
const SOCKET_IO_REDIS_ADAPTER_ENABLED = String(process.env.SOCKET_IO_REDIS_ADAPTER || '1').trim() !== '0';

let socketIoRedisAdapterActive = false;

function createRedisClient(role: 'pub' | 'sub'): Redis {
  const client = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times) {
      return Math.min(times * 100, 3000);
    },
  });

  client.on('connect', () => logger.info(`[socket.io:redis] ${role} connected`));
  client.on('ready', () => logger.info(`[socket.io:redis] ${role} ready`));
  client.on('error', (err) => logger.warn(`[socket.io:redis] ${role} error`, { message: err?.message ?? String(err) }));

  return client;
}

export function isSocketIoRedisAdapterActive(): boolean {
  return socketIoRedisAdapterActive;
}

export async function setupSocketIoRedisAdapter(io: Server): Promise<() => Promise<void>> {
  if (!SOCKET_IO_REDIS_ADAPTER_ENABLED) {
    logger.info('[socket.io:redis] adapter disabled by env');
    socketIoRedisAdapterActive = false;
    return async () => {};
  }

  if (!REDIS_URL) {
    logger.info('[socket.io:redis] adapter disabled (no REDIS_URL)');
    socketIoRedisAdapterActive = false;
    return async () => {};
  }

  const pubClient = createRedisClient('pub');
  const subClient = createRedisClient('sub');

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    socketIoRedisAdapterActive = true;
    logger.info('[socket.io:redis] adapter enabled');

    return async () => {
      socketIoRedisAdapterActive = false;
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
      logger.info('[socket.io:redis] adapter closed');
    };
  } catch (e: any) {
    socketIoRedisAdapterActive = false;
    logger.warn('[socket.io:redis] adapter init failed, falling back to in-memory adapter', {
      error: e?.message || String(e),
    });
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    return async () => {};
  }
}
