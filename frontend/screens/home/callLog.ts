import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId } from '../../sockets/socket';
import { CALL_LOG_KEY } from './constants';

export type CallLogDirection = 'outgoing' | 'incoming' | 'missed';

export type CallLogEntry = {
  id: string;
  peerId: string;
  direction: CallLogDirection;
  at: number;
};

const MAX_ENTRIES = 200;
const DEDUPE_MS = 1800;

let memory: CallLogEntry[] | null = null;
let memoryUid = '';
let loadPromise: Promise<CallLogEntry[]> | null = null;
const listeners = new Set<(entries: CallLogEntry[]) => void>();
let lastRecord: { key: string; at: number } | null = null;

function currentUid(): string {
  return String(getCurrentUserId() || '').trim();
}

function storageKey(uid = currentUid()): string {
  return uid ? `${CALL_LOG_KEY}:${uid}` : CALL_LOG_KEY;
}

function notify() {
  const list = memory || [];
  listeners.forEach((cb) => {
    try {
      cb(list);
    } catch {}
  });
}

function parseEntries(raw: string | null): CallLogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const peerId = String(item?.peerId || '').trim();
        const direction = item?.direction;
        const at = Number(item?.at) || 0;
        const id = String(item?.id || '').trim();
        if (!peerId) return null;
        if (direction !== 'outgoing' && direction !== 'incoming' && direction !== 'missed') return null;
        return { id: id || `${peerId}:${at}`, peerId, direction, at } as CallLogEntry;
      })
      .filter(Boolean) as CallLogEntry[];
  } catch {
    return [];
  }
}

async function ensureLoaded(uid = currentUid()): Promise<CallLogEntry[]> {
  if (memory && memoryUid === uid) return memory;
  if (loadPromise && memoryUid === uid) return loadPromise;
  memoryUid = uid;
  loadPromise = AsyncStorage.getItem(storageKey(uid))
    .then((raw) => {
      memory = parseEntries(raw);
      memoryUid = uid;
      return memory;
    })
    .catch(() => {
      memory = [];
      memoryUid = uid;
      return memory;
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

function persist(uid: string, entries: CallLogEntry[]) {
  AsyncStorage.setItem(storageKey(uid), JSON.stringify(entries)).catch(() => {});
}

export async function loadCallLog(): Promise<CallLogEntry[]> {
  return ensureLoaded();
}

export function subscribeCallLog(cb: (entries: CallLogEntry[]) => void): () => void {
  listeners.add(cb);
  if (memory && memoryUid === currentUid()) cb(memory);
  else {
    void ensureLoaded().then((list) => cb(list));
  }
  return () => {
    listeners.delete(cb);
  };
}

export function recordCallLog(input: { peerId: string; direction: CallLogDirection; at?: number }): void {
  const peerId = String(input.peerId || '').trim();
  if (!peerId) return;
  const uid = currentUid();
  const at = input.at && Number.isFinite(input.at) ? input.at : Date.now();
  const dedupeKey = `${uid}:${peerId}:${input.direction}`;
  if (lastRecord && lastRecord.key === dedupeKey && at - lastRecord.at < DEDUPE_MS) return;
  lastRecord = { key: dedupeKey, at };

  const entry: CallLogEntry = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    peerId,
    direction: input.direction,
    at,
  };

  const apply = (prev: CallLogEntry[]) => {
    const next = [entry, ...prev].slice(0, MAX_ENTRIES);
    memory = next;
    memoryUid = uid;
    persist(uid, next);
    notify();
  };

  if (memory && memoryUid === uid) apply(memory);
  else void ensureLoaded(uid).then(apply);
}

export function deleteCallLogIds(ids: string[]): void {
  const remove = new Set(ids.map((id) => String(id || '').trim()).filter(Boolean));
  if (remove.size === 0) return;
  const uid = currentUid();
  const apply = (prev: CallLogEntry[]) => {
    const next = prev.filter((item) => !remove.has(item.id));
    if (next.length === prev.length) return;
    memory = next;
    memoryUid = uid;
    persist(uid, next);
    notify();
  };
  if (memory && memoryUid === uid) apply(memory);
  else void ensureLoaded(uid).then(apply);
}
