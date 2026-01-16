/**
 * Минимальная реализация распределённого хранилища очереди/состояний.
 * В этом репо раньше был Redis-backed store, но файл отсутствовал — для dev используем in-memory.
 * Важно: in-memory работает только в рамках одного процесса backend.
 */

type CleanupStatesResult = { cleanedBans: number; cleanedLocks: number; cleanedPairs: number };

const waitingQueue: string[] = [];
const inQueue = new Set<string>();
const queueAddedAt = new Map<string, number>();

const pair = new Map<string, string>(); // sid -> sid
const locks = new Map<string, number>(); // sid -> expTs (lock TTL)

const bans = new Map<string, number>(); // "a|b" -> expTs

const lastMatchAttempt = new Map<string, number>();
const lastStart = new Map<string, number>();
const lastSearch = new Map<string, number>();

const LOCK_TTL_MS = 30_000;

function now() {
  return Date.now();
}

function banKey(a: string, b: string) {
  const [x, y] = [a, b].sort();
  return `${x}|${y}`;
}

export async function addToQueue(sid: string): Promise<void> {
  const id = String(sid);
  if (inQueue.has(id)) return;
  inQueue.add(id);
  waitingQueue.push(id);
  queueAddedAt.set(id, now());
}

export async function removeFromQueue(sid: string): Promise<void> {
  const id = String(sid);
  if (!inQueue.has(id)) return;
  inQueue.delete(id);
  queueAddedAt.delete(id);
  const idx = waitingQueue.indexOf(id);
  if (idx >= 0) waitingQueue.splice(idx, 1);
}

export async function isInQueue(sid: string): Promise<boolean> {
  return inQueue.has(String(sid));
}

export async function getWaitingQueue(): Promise<string[]> {
  // Возвращаем снепшот, чтобы не было гонок при итерации
  return waitingQueue.slice();
}

export async function getQueueSize(): Promise<number> {
  return waitingQueue.length;
}

export async function setPair(aSid: string, bSid: string): Promise<void> {
  const a = String(aSid);
  const b = String(bSid);
  pair.set(a, b);
  pair.set(b, a);
}

export async function getPartner(sid: string): Promise<string | undefined> {
  return pair.get(String(sid));
}

export async function removePair(sid: string): Promise<string | undefined> {
  const a = String(sid);
  const b = pair.get(a);
  pair.delete(a);
  if (b) pair.delete(b);
  return b;
}

export async function lockSocket(sid: string): Promise<void> {
  locks.set(String(sid), now() + LOCK_TTL_MS);
}

export async function unlockSocket(sid: string): Promise<void> {
  locks.delete(String(sid));
}

export async function isLocked(sid: string): Promise<boolean> {
  const exp = locks.get(String(sid));
  if (!exp) return false;
  if (exp <= now()) {
    locks.delete(String(sid));
    return false;
  }
  return true;
}

export async function banPair(aSid: string, bSid: string, ms: number): Promise<void> {
  bans.set(banKey(String(aSid), String(bSid)), now() + Math.max(0, Number(ms) || 0));
}

export async function isBannedTogether(aSid: string, bSid: string): Promise<boolean> {
  const k = banKey(String(aSid), String(bSid));
  const exp = bans.get(k);
  if (!exp) return false;
  if (exp <= now()) {
    bans.delete(k);
    return false;
  }
  return true;
}

export async function getLastMatchAttempt(sid: string): Promise<number | undefined> {
  return lastMatchAttempt.get(String(sid));
}

export async function setLastMatchAttempt(sid: string, ts: number): Promise<void> {
  lastMatchAttempt.set(String(sid), Number(ts) || now());
}

export async function getLastStart(sid: string): Promise<number | undefined> {
  return lastStart.get(String(sid));
}

export async function setLastStart(sid: string, ts: number): Promise<void> {
  lastStart.set(String(sid), Number(ts) || now());
}

export async function getLastSearch(sid: string): Promise<number | undefined> {
  return lastSearch.get(String(sid));
}

export async function setLastSearch(sid: string, ts: number): Promise<void> {
  lastSearch.set(String(sid), Number(ts) || now());
}

export async function clearSocketData(sid: string): Promise<void> {
  const id = String(sid);
  await removeFromQueue(id);
  await unlockSocket(id);
  await removePair(id);
  lastMatchAttempt.delete(id);
  lastStart.delete(id);
  lastSearch.delete(id);
}

/**
 * Удаляем из очереди сокеты, которые:
 * - не подключены (isSocketConnected=false)
 * - или "висят" в очереди дольше timeoutMs
 */
export async function cleanupStaleQueueEntries(
  timeoutMs: number,
  isSocketConnected: (sid: string) => boolean
): Promise<string[]> {
  const stale: string[] = [];
  const t = Math.max(0, Number(timeoutMs) || 0);
  const n = now();

  // Итерация по копии, потому что removeFromQueue мутирует очередь
  for (const sid of waitingQueue.slice()) {
    const added = queueAddedAt.get(sid) || n;
    const tooOld = n - added > t;
    const disconnected = !isSocketConnected(sid);
    if (tooOld || disconnected) {
      stale.push(sid);
      await removeFromQueue(sid);
    }
  }
  return stale;
}

export async function cleanupStaleStates(isSocketConnected: (sid: string) => boolean): Promise<CleanupStatesResult> {
  const n = now();
  let cleanedBans = 0;
  let cleanedLocks = 0;
  let cleanedPairs = 0;

  for (const [k, exp] of bans.entries()) {
    if (exp <= n) {
      bans.delete(k);
      cleanedBans++;
    }
  }

  for (const [sid, exp] of locks.entries()) {
    if (exp <= n || !isSocketConnected(sid)) {
      locks.delete(sid);
      cleanedLocks++;
    }
  }

  // Пары: если один из сокетов уже отключён — удаляем пару
  for (const [a, b] of pair.entries()) {
    if (!isSocketConnected(a) || !isSocketConnected(b)) {
      pair.delete(a);
      pair.delete(b);
      cleanedPairs++;
    }
  }

  return { cleanedBans, cleanedLocks, cleanedPairs };
}

export async function setBusy(_userId: string, _busy: boolean): Promise<void> {
  // В текущей версии backend busy хранится в socket.data и рассылается через presence:update,
  // поэтому тут no-op (оставлено для совместимости).
}

export async function close(): Promise<void> {
  // no-op for in-memory
}

