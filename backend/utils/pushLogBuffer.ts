/**
 * Кольцевой буфер последних событий пуша для отладки.
 * GET /api/debug/push-log возвращает эти записи (чтобы проверить FCM vs Expo при звонке).
 */
const MAX_ENTRIES = 100;

export type PushLogEntry = {
  ts: string;
  event: string;
  payload?: Record<string, unknown>;
};

const buffer: PushLogEntry[] = [];

export function pushLog(event: string, payload?: Record<string, unknown>): void {
  const entry: PushLogEntry = {
    ts: new Date().toISOString(),
    event,
    ...(payload ? { payload } : {}),
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

export function getPushLog(): PushLogEntry[] {
  return [...buffer];
}
