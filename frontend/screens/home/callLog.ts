import AsyncStorage from '@react-native-async-storage/async-storage';
import { getCurrentUserId } from '../../sockets/socket';
import { CALL_LOG_KEY } from './constants';

export type CallLogDirection = 'outgoing' | 'incoming' | 'missed' | 'cancelled';

export type CallLogEntry = {
  id: string;
  peerId: string;
  direction: CallLogDirection;
  at: number;
};

const MAX_ENTRIES = 200;
const DEDUPE_MS = 1800;
/** Окно, в котором исходящий можно перевести в «отменённый». */
const OUTGOING_TO_CANCELLED_MS = 15 * 60 * 1000;

const VALID_DIRECTIONS = new Set<CallLogDirection>(['outgoing', 'incoming', 'missed', 'cancelled']);

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

let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notifyDeferred(ms: number) {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    notify();
  }, Math.max(0, ms));
}

/** Отменить отложенный notify — redial/dial не должен получить FlatList mid-flight. */
export function cancelPendingCallLogNotify(): void {
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
}

const softUiListeners = new Set<() => void>();

/**
 * Лёгкий UI-bump только для активной вкладки Calls (snapshot → setEntries).
 * Не трогает скрытые подписчики через полный notify.
 */
export function requestCallLogSoftUi(): void {
  softUiListeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

export function subscribeCallLogSoftUi(cb: () => void): () => void {
  softUiListeners.add(cb);
  return () => {
    softUiListeners.delete(cb);
  };
}

function parseEntries(raw: string | null): CallLogEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        const peerId = String(item?.peerId || '').trim();
        const direction = item?.direction as CallLogDirection;
        const at = Number(item?.at) || 0;
        const id = String(item?.id || '').trim();
        if (!peerId) return null;
        if (!VALID_DIRECTIONS.has(direction)) return null;
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
  // Смена uid (логин после пустого id) — сбрасываем кэш, иначе список «пропадает».
  if (memoryUid !== uid) {
    memory = null;
    loadPromise = null;
  }
  memoryUid = uid;
  loadPromise = AsyncStorage.getItem(storageKey(uid))
    .then((raw) => {
      if (memoryUid !== uid) return memory || [];
      memory = parseEntries(raw);
      memoryUid = uid;
      // После cancel не notify сразу — иначе CallsView remount на горячем пути.
      try {
        const at = Number((global as any).__lastOutgoingCancelAtRef?.current || 0);
        if (at > 0 && Date.now() - at < 5000) {
          notifyDeferred(3000);
        } else {
          notify();
        }
      } catch {
        notify();
      }
      return memory;
    })
    .catch(() => {
      if (memoryUid !== uid) return memory || [];
      memory = [];
      memoryUid = uid;
      try {
        const at = Number((global as any).__lastOutgoingCancelAtRef?.current || 0);
        if (at > 0 && Date.now() - at < 5000) {
          notifyDeferred(3000);
        } else {
          notify();
        }
      } catch {
        notify();
      }
      return memory;
    })
    .finally(() => {
      if (memoryUid === uid) loadPromise = null;
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

export function recordCallLog(
  input: { peerId: string; direction: CallLogDirection; at?: number; silent?: boolean },
): void {
  const peerId = String(input.peerId || '').trim();
  if (!peerId) return;
  const uid = currentUid();
  const at = input.at && Number.isFinite(input.at) ? input.at : Date.now();
  const silent = input.silent === true;
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
    if (!silent) notify();
  };

  if (memory && memoryUid === uid) apply(memory);
  else void ensureLoaded(uid).then(apply);
}

/**
 * Только своя отмена инициатора до ответа: исходящий → cancelled.
 * У абонента при отмене звонящего — пропущенный (не эта функция).
 * Memory/disk сразу; notify можно silent / отложить (не блокировать тапы после cancel).
 */
export function recordCancelledCall(
  peerIdRaw: string,
  opts?: { deferNotifyMs?: number; silent?: boolean },
): void {
  const peerId = String(peerIdRaw || '').trim();
  if (!peerId) return;
  const uid = currentUid();
  const now = Date.now();
  const deferNotifyMs = opts?.deferNotifyMs;
  const silent = opts?.silent === true;

  const apply = (prev: CallLogEntry[], doNotify: boolean) => {
    const idx = prev.findIndex(
      (item) =>
        item.peerId === peerId &&
        item.direction === 'outgoing' &&
        now - item.at <= OUTGOING_TO_CANCELLED_MS,
    );
    let next: CallLogEntry[];
    if (idx >= 0) {
      next = prev.slice();
      next[idx] = { ...next[idx], direction: 'cancelled' };
      lastRecord = { key: `${uid}:${peerId}:cancelled`, at: now };
    } else {
      const recentCancelled = prev.some(
        (item) =>
          item.peerId === peerId &&
          item.direction === 'cancelled' &&
          now - item.at < DEDUPE_MS * 4,
      );
      if (recentCancelled) return;
      const dedupeKey = `${uid}:${peerId}:cancelled`;
      if (lastRecord && lastRecord.key === dedupeKey && now - lastRecord.at < DEDUPE_MS) return;
      lastRecord = { key: dedupeKey, at: now };
      const entry: CallLogEntry = {
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        peerId,
        direction: 'cancelled',
        at: now,
      };
      next = [entry, ...prev].slice(0, MAX_ENTRIES);
    }
    memory = next;
    memoryUid = uid;
    persist(uid, next);
    if (!doNotify || silent) return;
    if (typeof deferNotifyMs === 'number' && deferNotifyMs > 0) {
      notifyDeferred(deferNotifyMs);
    } else {
      notify();
    }
  };

  const hadLoadedForUid = !!(memory && memoryUid === uid);
  const base = hadLoadedForUid ? (memory as CallLogEntry[]) : memory || [];
  apply(base, !silent);
  if (!hadLoadedForUid) {
    void ensureLoaded(uid).then((loaded) => {
      if (memoryUid !== uid) return;
      const cancelled = (memory || []).filter(
        (e) => e.peerId === peerId && e.direction === 'cancelled' && now - e.at < DEDUPE_MS * 4,
      );
      const withoutDupOut = loaded.filter(
        (e) =>
          !(
            e.peerId === peerId &&
            (e.direction === 'outgoing' || e.direction === 'cancelled') &&
            now - e.at <= OUTGOING_TO_CANCELLED_MS
          ),
      );
      const next = [...cancelled, ...withoutDupOut].slice(0, MAX_ENTRIES);
      memory = next;
      memoryUid = uid;
      persist(uid, next);
      if (silent) return;
      if (typeof deferNotifyMs === 'number' && deferNotifyMs > 0) {
        notifyDeferred(deferNotifyMs);
      } else {
        notify();
      }
    });
  }
}

/** Отложенный/немедленный notify подписчикам (после settle / при открытии Calls). */
export function scheduleCallLogNotify(ms = 0): void {
  if (ms <= 0) {
    cancelPendingCallLogNotify();
    notify();
    return;
  }
  notifyDeferred(ms);
}

/** Синхронный снимок memory — для мгновенного UI при открытии вкладки Calls. */
export function getCallLogSnapshot(): CallLogEntry[] {
  const uid = currentUid();
  if (memory && memoryUid === uid) return memory;
  return [];
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
