/**
 * Распределенное хранилище для очереди ожидания и пар
 * Поддерживает Redis для масштабирования с fallback на память
 */

import { logger } from './logger';

// Попытка импортировать Redis (опционально)
let redisClient: any = null;
let redisAvailable = false;
let redisConnectionAttempted = false;
let redisConnectionFailed = false;

// Функция для инициализации Redis (вызывается один раз)
async function initRedis(): Promise<void> {
  if (redisConnectionAttempted) return;
  redisConnectionAttempted = true;

  try {
    // Redis будет подключен только если установлен пакет ioredis
    const Redis = require('ioredis');
    let REDIS_URL = process.env.REDIS_URL || process.env.REDIS_HOST || '';
    
    if (!REDIS_URL || REDIS_URL === '') {
      logger.info('[QueueStore] REDIS_URL not set, using memory fallback');
      redisConnectionFailed = true;
      return;
    }
    
    // Нормализация Redis URL
    // Если указан просто IP или hostname без порта и протокола, добавляем порт по умолчанию
    if (!REDIS_URL.includes('://') && !REDIS_URL.includes(':')) {
      // Если это просто hostname/IP без порта, добавляем порт 6379
      REDIS_URL = `redis://${REDIS_URL}:6379`;
    } else if (!REDIS_URL.includes('://') && REDIS_URL.includes(':')) {
      // Если указан host:port без протокола, добавляем протокол
      REDIS_URL = `redis://${REDIS_URL}`;
    } else if (REDIS_URL === 'redis') {
      // Если указан просто "redis", это ошибка - нужно указать полный адрес
      logger.warn('[QueueStore] REDIS_URL is just "redis", please specify full address (e.g., redis://92.242.61.46:6379)');
      logger.info('[QueueStore] Using memory fallback instead');
      redisConnectionFailed = true;
      return;
    }
    
    logger.info('[QueueStore] Attempting Redis connection', { 
      url: REDIS_URL.replace(/\/\/.*@/, '//***@') // Скрываем credentials если есть
    });
    
    redisClient = new Redis(REDIS_URL, {
      retryStrategy: () => null, // Не пытаемся переподключаться автоматически
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 2000, // Таймаут подключения 2 секунды
    });
    
    redisClient.on('error', (err: Error) => {
      if (!redisConnectionFailed) {
        logger.warn('[QueueStore] Redis error, falling back to memory', { error: err.message });
        redisConnectionFailed = true;
        redisAvailable = false;
      }
    });
    
    redisClient.on('connect', () => {
      if (!redisConnectionFailed) {
        logger.info('[QueueStore] Redis connected');
        redisAvailable = true;
        redisConnectionFailed = false;
      }
    });
    
    redisClient.on('ready', () => {
      if (!redisConnectionFailed) {
        logger.info('[QueueStore] Redis ready');
        redisAvailable = true;
        redisConnectionFailed = false;
      }
    });
    
    // Пытаемся подключиться один раз с таймаутом
    try {
      await Promise.race([
        redisClient.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 2000))
      ]);
    } catch (e) {
      logger.info('[QueueStore] Redis connection failed, using memory fallback');
      redisConnectionFailed = true;
      redisAvailable = false;
      // Закрываем клиент, чтобы не было утечек
      try {
        await redisClient.quit();
      } catch {}
      redisClient = null;
    }
  } catch (e) {
    logger.info('[QueueStore] Redis not available, using memory fallback');
    redisConnectionFailed = true;
    redisAvailable = false;
  }
}

// Инициализируем Redis при первом импорте модуля
initRedis().catch(() => {
  // Игнорируем ошибки инициализации
});

// Fallback: хранилище в памяти
const memoryQueue: string[] = [];
const memoryPairs = new Map<string, string>();
const memoryBusy = new Map<string, boolean>();
const memoryLocks = new Set<string>();
const memoryBans = new Map<string, { sid: string; until: number }>();
const memoryLastSearch = new Map<string, number>();
const memoryLastStart = new Map<string, number>();
const memoryLastMatchAttempt = new Map<string, number>();
const memoryQueueEntryTime = new Map<string, number>(); // Время добавления в очередь

// Ключи для Redis
const QUEUE_KEY = 'random:waiting:queue';
const PAIR_PREFIX = 'random:pair:';
const BUSY_PREFIX = 'random:busy:';
const LOCK_PREFIX = 'random:lock:';
const BAN_PREFIX = 'random:ban:';
const LAST_SEARCH_PREFIX = 'random:lastsearch:';
const LAST_START_PREFIX = 'random:laststart:';
const LAST_MATCH_ATTEMPT_PREFIX = 'random:lastmatchattempt:';
const QUEUE_ENTRY_TIME_PREFIX = 'random:queueentrytime:';

/**
 * Получить очередь ожидания
 */
export async function getWaitingQueue(): Promise<string[]> {
  // Если Redis недоступен, сразу используем память
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return [...memoryQueue];
  }
  
  try {
    const result = await redisClient.smembers(QUEUE_KEY);
    return result || [];
  } catch (e) {
    // При ошибке переключаемся на память навсегда
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getWaitingQueue error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return [...memoryQueue];
  }
}

/**
 * Добавить в очередь
 */
export async function addToQueue(sid: string): Promise<void> {
  const entryTime = Date.now();
  
  // Если Redis недоступен, сразу используем память
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    if (!memoryQueue.includes(sid)) {
      memoryQueue.push(sid);
      memoryQueueEntryTime.set(sid, entryTime);
    }
    return;
  }
  
  try {
    await Promise.all([
      redisClient.sadd(QUEUE_KEY, sid),
      redisClient.set(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`, String(entryTime), 'EX', 600), // TTL 10 минут
    ]);
  } catch (e) {
    // При ошибке переключаемся на память навсегда
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis addToQueue error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    if (!memoryQueue.includes(sid)) {
      memoryQueue.push(sid);
      memoryQueueEntryTime.set(sid, entryTime);
    }
  }
}

/**
 * Удалить из очереди
 */
export async function removeFromQueue(sid: string): Promise<void> {
  // Если Redis недоступен, сразу используем память
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    const index = memoryQueue.indexOf(sid);
    if (index !== -1) {
      memoryQueue.splice(index, 1);
    }
    memoryQueueEntryTime.delete(sid);
    return;
  }
  
  try {
    await Promise.all([
      redisClient.srem(QUEUE_KEY, sid),
      redisClient.del(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`),
    ]);
  } catch (e) {
    // При ошибке переключаемся на память навсегда
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis removeFromQueue error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    const index = memoryQueue.indexOf(sid);
    if (index !== -1) {
      memoryQueue.splice(index, 1);
    }
    memoryQueueEntryTime.delete(sid);
  }
}

/**
 * Проверить, есть ли в очереди
 */
export async function isInQueue(sid: string): Promise<boolean> {
  // Если Redis недоступен, сразу используем память
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryQueue.includes(sid);
  }
  
  try {
    const result = await redisClient.sismember(QUEUE_KEY, sid);
    return result === 1;
  } catch (e) {
    // При ошибке переключаемся на память навсегда
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis isInQueue error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryQueue.includes(sid);
  }
}

/**
 * Получить партнера
 */
export async function getPartner(sid: string): Promise<string | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryPairs.get(sid) || null;
  }
  
  try {
    const result = await redisClient.get(`${PAIR_PREFIX}${sid}`);
    return result || null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getPartner error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryPairs.get(sid) || null;
  }
}

/**
 * Создать пару
 */
export async function setPair(a: string, b: string): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryPairs.set(a, b);
    memoryPairs.set(b, a);
    return;
  }
  
  try {
    await Promise.all([
      redisClient.set(`${PAIR_PREFIX}${a}`, b),
      redisClient.set(`${PAIR_PREFIX}${b}`, a),
      redisClient.expire(`${PAIR_PREFIX}${a}`, 3600), // TTL 1 час
      redisClient.expire(`${PAIR_PREFIX}${b}`, 3600),
    ]);
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis setPair error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryPairs.set(a, b);
    memoryPairs.set(b, a);
  }
}

/**
 * Удалить пару
 */
export async function removePair(sid: string): Promise<string | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    const partner = memoryPairs.get(sid) || null;
    if (partner) {
      memoryPairs.delete(sid);
      memoryPairs.delete(partner);
    }
    return partner;
  }
  
  try {
    const partner = await redisClient.get(`${PAIR_PREFIX}${sid}`);
    if (partner) {
      await Promise.all([
        redisClient.del(`${PAIR_PREFIX}${sid}`),
        redisClient.del(`${PAIR_PREFIX}${partner}`),
      ]);
      return partner;
    }
    return null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis removePair error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    const partner = memoryPairs.get(sid) || null;
    if (partner) {
      memoryPairs.delete(sid);
      memoryPairs.delete(partner);
    }
    return partner;
  }
}

/**
 * Установить занятость пользователя
 */
export async function setBusy(userId: string, busy: boolean): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    if (busy) {
      memoryBusy.set(userId, true);
    } else {
      memoryBusy.delete(userId);
    }
    return;
  }
  
  try {
    if (busy) {
      await redisClient.set(`${BUSY_PREFIX}${userId}`, '1', 'EX', 3600); // TTL 1 час
    } else {
      await redisClient.del(`${BUSY_PREFIX}${userId}`);
    }
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis setBusy error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    if (busy) {
      memoryBusy.set(userId, true);
    } else {
      memoryBusy.delete(userId);
    }
  }
}

/**
 * Проверить занятость пользователя
 */
export async function isBusy(userId: string): Promise<boolean> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryBusy.has(userId);
  }
  
  try {
    const result = await redisClient.get(`${BUSY_PREFIX}${userId}`);
    return result === '1';
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis isBusy error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryBusy.has(userId);
  }
}

/**
 * Заблокировать сокет (для предотвращения одновременных матчей)
 */
export async function lockSocket(sid: string): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryLocks.add(sid);
    return;
  }
  
  try {
    await redisClient.set(`${LOCK_PREFIX}${sid}`, '1', 'EX', 60); // TTL 1 минута
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis lockSocket error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryLocks.add(sid);
  }
}

/**
 * Разблокировать сокет
 */
export async function unlockSocket(sid: string): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryLocks.delete(sid);
    return;
  }
  
  try {
    await redisClient.del(`${LOCK_PREFIX}${sid}`);
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis unlockSocket error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryLocks.delete(sid);
  }
}

/**
 * Проверить, заблокирован ли сокет
 */
export async function isLocked(sid: string): Promise<boolean> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryLocks.has(sid);
  }
  
  try {
    const result = await redisClient.get(`${LOCK_PREFIX}${sid}`);
    return result === '1';
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis isLocked error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryLocks.has(sid);
  }
}

/**
 * Забанить пару (предотвратить немедленный рематч)
 */
export async function banPair(aSid: string, bSid: string, ms: number = 5000): Promise<void> {
  const until = Date.now() + ms;
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryBans.set(aSid, { sid: bSid, until });
    memoryBans.set(bSid, { sid: aSid, until });
    return;
  }
  
  try {
    const ttl = Math.ceil(ms / 1000);
    await Promise.all([
      redisClient.set(`${BAN_PREFIX}${aSid}`, JSON.stringify({ sid: bSid, until }), 'EX', ttl),
      redisClient.set(`${BAN_PREFIX}${bSid}`, JSON.stringify({ sid: aSid, until }), 'EX', ttl),
    ]);
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis banPair error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryBans.set(aSid, { sid: bSid, until });
    memoryBans.set(bSid, { sid: aSid, until });
  }
}

/**
 * Проверить, забанены ли вместе
 */
export async function isBannedTogether(aSid: string, bSid: string): Promise<boolean> {
  const now = Date.now();
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    const aBan = memoryBans.get(aSid);
    const bBan = memoryBans.get(bSid);
    if (aBan && aBan.sid === bSid && aBan.until > now) return true;
    if (bBan && bBan.sid === aSid && bBan.until > now) return true;
    return false;
  }
  
  try {
    const aBanStr = await redisClient.get(`${BAN_PREFIX}${aSid}`);
    const bBanStr = await redisClient.get(`${BAN_PREFIX}${bSid}`);
    
    if (aBanStr) {
      const aBan = JSON.parse(aBanStr);
      if (aBan.sid === bSid && aBan.until > now) return true;
    }
    if (bBanStr) {
      const bBan = JSON.parse(bBanStr);
      if (bBan.sid === aSid && bBan.until > now) return true;
    }
    return false;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis isBannedTogether error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    const aBan = memoryBans.get(aSid);
    const bBan = memoryBans.get(bSid);
    if (aBan && aBan.sid === bSid && aBan.until > now) return true;
    if (bBan && bBan.sid === aSid && bBan.until > now) return true;
    return false;
  }
}

/**
 * Установить время последнего поиска
 */
export async function setLastSearch(sid: string, timestamp: number): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryLastSearch.set(sid, timestamp);
    return;
  }
  
  try {
    await redisClient.set(`${LAST_SEARCH_PREFIX}${sid}`, String(timestamp), 'EX', 300); // TTL 5 минут
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis setLastSearch error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryLastSearch.set(sid, timestamp);
  }
}

/**
 * Получить время последнего поиска
 */
export async function getLastSearch(sid: string): Promise<number | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryLastSearch.get(sid) || null;
  }
  
  try {
    const result = await redisClient.get(`${LAST_SEARCH_PREFIX}${sid}`);
    return result ? Number(result) : null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getLastSearch error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryLastSearch.get(sid) || null;
  }
}

/**
 * Установить время последнего вызова start
 */
export async function setLastStart(sid: string, timestamp: number): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryLastStart.set(sid, timestamp);
    return;
  }
  
  try {
    await redisClient.set(`${LAST_START_PREFIX}${sid}`, String(timestamp), 'EX', 300); // TTL 5 минут
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis setLastStart error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryLastStart.set(sid, timestamp);
  }
}

/**
 * Получить время последнего вызова start
 */
export async function getLastStart(sid: string): Promise<number | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryLastStart.get(sid) || null;
  }
  
  try {
    const result = await redisClient.get(`${LAST_START_PREFIX}${sid}`);
    return result ? Number(result) : null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getLastStart error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryLastStart.get(sid) || null;
  }
}

/**
 * Установить время последней попытки матчинга
 */
export async function setLastMatchAttempt(sid: string, timestamp: number): Promise<void> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    memoryLastMatchAttempt.set(sid, timestamp);
    return;
  }
  
  try {
    await redisClient.set(`${LAST_MATCH_ATTEMPT_PREFIX}${sid}`, String(timestamp), 'EX', 300); // TTL 5 минут
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis setLastMatchAttempt error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    memoryLastMatchAttempt.set(sid, timestamp);
  }
}

/**
 * Получить время последней попытки матчинга
 */
export async function getLastMatchAttempt(sid: string): Promise<number | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryLastMatchAttempt.get(sid) || null;
  }
  
  try {
    const result = await redisClient.get(`${LAST_MATCH_ATTEMPT_PREFIX}${sid}`);
    return result ? Number(result) : null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getLastMatchAttempt error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryLastMatchAttempt.get(sid) || null;
  }
}

/**
 * Получить время добавления в очередь
 */
export async function getQueueEntryTime(sid: string): Promise<number | null> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryQueueEntryTime.get(sid) || null;
  }
  
  try {
    const result = await redisClient.get(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`);
    return result ? Number(result) : null;
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getQueueEntryTime error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryQueueEntryTime.get(sid) || null;
  }
}

/**
 * Очистить устаревшие сокеты из очереди
 * Удаляет сокеты, которые находятся в очереди дольше указанного времени
 */
export async function cleanupStaleQueueEntries(
  maxWaitTimeMs: number,
  isSocketConnected: (sid: string) => boolean
): Promise<string[]> {
  const now = Date.now();
  const staleSids: string[] = [];
  
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    // Очистка в памяти
    for (let i = memoryQueue.length - 1; i >= 0; i--) {
      const sid = memoryQueue[i];
      const entryTime = memoryQueueEntryTime.get(sid);
      
      if (entryTime && (now - entryTime) > maxWaitTimeMs) {
        // Проверяем, что сокет действительно отключен или не существует
        if (!isSocketConnected(sid)) {
          staleSids.push(sid);
          memoryQueue.splice(i, 1);
          memoryQueueEntryTime.delete(sid);
        }
      }
    }
    return staleSids;
  }
  
  try {
    // Очистка в Redis
    const queueMembers = await redisClient.smembers(QUEUE_KEY);
    if (!queueMembers || queueMembers.length === 0) {
      return staleSids;
    }
    
    for (const sid of queueMembers) {
      const entryTimeStr = await redisClient.get(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`);
      if (!entryTimeStr) {
        // Если нет времени входа, считаем устаревшим и удаляем
        if (!isSocketConnected(sid)) {
          staleSids.push(sid);
          await Promise.all([
            redisClient.srem(QUEUE_KEY, sid),
            redisClient.del(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`),
          ]);
        }
        continue;
      }
      
      const entryTime = Number(entryTimeStr);
      if (entryTime && (now - entryTime) > maxWaitTimeMs) {
        // Проверяем, что сокет действительно отключен или не существует
        if (!isSocketConnected(sid)) {
          staleSids.push(sid);
          await Promise.all([
            redisClient.srem(QUEUE_KEY, sid),
            redisClient.del(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`),
          ]);
        }
      }
    }
    
    return staleSids;
  } catch (e) {
    logger.warn('[QueueStore] Redis cleanupStaleQueueEntries error', e);
    // При ошибке переключаемся на память и пробуем очистить там
    if (!redisConnectionFailed) {
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    // Пробуем очистить в памяти
    for (let i = memoryQueue.length - 1; i >= 0; i--) {
      const sid = memoryQueue[i];
      const entryTime = memoryQueueEntryTime.get(sid);
      
      if (entryTime && (now - entryTime) > maxWaitTimeMs) {
        if (!isSocketConnected(sid)) {
          staleSids.push(sid);
          memoryQueue.splice(i, 1);
          memoryQueueEntryTime.delete(sid);
        }
      }
    }
    return staleSids;
  }
}

/**
 * Очистить все данные для сокета (при disconnect)
 */
export async function clearSocketData(sid: string): Promise<void> {
  await Promise.all([
    removeFromQueue(sid),
    removePair(sid),
    unlockSocket(sid),
  ]);
  
  if (redisAvailable && redisClient) {
    try {
      await Promise.all([
        redisClient.del(`${BAN_PREFIX}${sid}`),
        redisClient.del(`${LAST_SEARCH_PREFIX}${sid}`),
        redisClient.del(`${LAST_START_PREFIX}${sid}`),
        redisClient.del(`${LAST_MATCH_ATTEMPT_PREFIX}${sid}`),
        redisClient.del(`${QUEUE_ENTRY_TIME_PREFIX}${sid}`),
      ]);
    } catch (e) {
      logger.warn('[QueueStore] Redis clearSocketData error', e);
    }
  } else {
    memoryBans.delete(sid);
    memoryLastSearch.delete(sid);
    memoryLastStart.delete(sid);
    memoryLastMatchAttempt.delete(sid);
    memoryQueueEntryTime.delete(sid);
  }
}

/**
 * Получить размер очереди
 */
export async function getQueueSize(): Promise<number> {
  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    return memoryQueue.length;
  }
  
  try {
    return await redisClient.scard(QUEUE_KEY);
  } catch (e) {
    if (!redisConnectionFailed) {
      logger.warn('[QueueStore] Redis getQueueSize error, switching to memory', e);
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    return memoryQueue.length;
  }
}

/**
 * Очистить устаревшие состояния:
 * - Забаненные пары (истекшие баны)
 * - Заблокированные сокеты (для несуществующих сокетов)
 * - Мертвые пары (где хотя бы один сокет не существует)
 */
export async function cleanupStaleStates(
  isSocketConnected: (sid: string) => boolean
): Promise<{
  cleanedBans: number;
  cleanedLocks: number;
  cleanedPairs: number;
}> {
  const now = Date.now();
  const result = {
    cleanedBans: 0,
    cleanedLocks: 0,
    cleanedPairs: 0,
  };

  if (redisConnectionFailed || !redisAvailable || !redisClient) {
    // Очистка в памяти
    
    // 1. Очистка истекших банов
    for (const [sid, ban] of memoryBans.entries()) {
      if (ban.until < now) {
        memoryBans.delete(sid);
        result.cleanedBans++;
      }
    }
    
    // 2. Очистка блокировок для несуществующих сокетов
    for (const sid of memoryLocks) {
      if (!isSocketConnected(sid)) {
        memoryLocks.delete(sid);
        result.cleanedLocks++;
      }
    }
    
    // 3. Очистка мертвых пар
    for (const [sid, partnerSid] of memoryPairs.entries()) {
      if (!isSocketConnected(sid) || !isSocketConnected(partnerSid)) {
        memoryPairs.delete(sid);
        memoryPairs.delete(partnerSid);
        result.cleanedPairs++;
      }
    }
    
    return result;
  }
  
  try {
    // Очистка в Redis
    
    // 1. Очистка истекших банов (Redis TTL автоматически удаляет, но проверим и удалим явно)
    // Получаем все ключи банов
    const banKeys: string[] = [];
    let cursor = '0';
    do {
      const scanResult = await redisClient.scan(
        cursor,
        'MATCH',
        `${BAN_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      banKeys.push(...scanResult[1]);
    } while (cursor !== '0');
    
    for (const key of banKeys) {
      const banStr = await redisClient.get(key);
      if (banStr) {
        try {
          const ban = JSON.parse(banStr);
          if (ban.until < now) {
            await redisClient.del(key);
            result.cleanedBans++;
          }
        } catch {
          // Если не удалось распарсить, удаляем ключ
          await redisClient.del(key);
          result.cleanedBans++;
        }
      } else {
        // Ключ уже истек (TTL), но удаляем явно для чистоты
        await redisClient.del(key);
        result.cleanedBans++;
      }
    }
    
    // 2. Очистка блокировок для несуществующих сокетов
    const lockKeys: string[] = [];
    cursor = '0';
    do {
      const scanResult = await redisClient.scan(
        cursor,
        'MATCH',
        `${LOCK_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      lockKeys.push(...scanResult[1]);
    } while (cursor !== '0');
    
    for (const key of lockKeys) {
      const sid = key.replace(LOCK_PREFIX, '');
      if (!isSocketConnected(sid)) {
        await redisClient.del(key);
        result.cleanedLocks++;
      }
    }
    
    // 3. Очистка мертвых пар
    const pairKeys: string[] = [];
    cursor = '0';
    do {
      const scanResult = await redisClient.scan(
        cursor,
        'MATCH',
        `${PAIR_PREFIX}*`,
        'COUNT',
        100
      );
      cursor = scanResult[0];
      pairKeys.push(...scanResult[1]);
    } while (cursor !== '0');
    
    const processedPairs = new Set<string>();
    for (const key of pairKeys) {
      if (processedPairs.has(key)) continue;
      
      const sid = key.replace(PAIR_PREFIX, '');
      const partnerSid = await redisClient.get(key);
      
      if (partnerSid) {
        const partnerKey = `${PAIR_PREFIX}${partnerSid}`;
        const isSidConnected = isSocketConnected(sid);
        const isPartnerConnected = isSocketConnected(partnerSid);
        
        if (!isSidConnected || !isPartnerConnected) {
          await Promise.all([
            redisClient.del(key),
            redisClient.del(partnerKey),
          ]);
          processedPairs.add(key);
          processedPairs.add(partnerKey);
          result.cleanedPairs++;
        }
      } else {
        // Партнер не найден, удаляем ключ
        await redisClient.del(key);
        result.cleanedPairs++;
      }
    }
    
    return result;
  } catch (e) {
    logger.warn('[QueueStore] Redis cleanupStaleStates error', e);
    // При ошибке переключаемся на память и пробуем очистить там
    if (!redisConnectionFailed) {
      redisConnectionFailed = true;
      redisAvailable = false;
    }
    
    // Очистка в памяти как fallback
    for (const [sid, ban] of memoryBans.entries()) {
      if (ban.until < now) {
        memoryBans.delete(sid);
        result.cleanedBans++;
      }
    }
    for (const sid of memoryLocks) {
      if (!isSocketConnected(sid)) {
        memoryLocks.delete(sid);
        result.cleanedLocks++;
      }
    }
    for (const [sid, partnerSid] of memoryPairs.entries()) {
      if (!isSocketConnected(sid) || !isSocketConnected(partnerSid)) {
        memoryPairs.delete(sid);
        memoryPairs.delete(partnerSid);
        result.cleanedPairs++;
      }
    }
    
    return result;
  }
}

/**
 * Закрыть соединение с Redis (при завершении приложения)
 */
export async function close(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (e) {
      logger.warn('[QueueStore] Error closing Redis connection', e);
    }
  }
}

