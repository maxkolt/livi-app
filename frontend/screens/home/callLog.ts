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

/**
 * Сразу показать актуальный memory в Calls (cancel / timeout / decline / hangup).
 * Soft + полный notify: вкладка Calls обновляется даже если dial-hot глушил один из каналов.
 */
export function flushCallLogUi(): void {
  cancelPendingCallLogNotify();
  notify();
  softUiListeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

/** Memory поверх диска: cancel/record во время AsyncStorage.getItem не должны пропасть. */
function mergeCallLogPreferMemory(mem: CallLogEntry[], disk: CallLogEntry[]): CallLogEntry[] {
  const byId = new Map<string, CallLogEntry>();
  for (const e of disk) byId.set(e.id, e);
  for (const e of mem) byId.set(e.id, e);
  const list = Array.from(byId.values());
  const filtered = list.filter((e) => {
    if (e.direction !== 'outgoing') return true;
    const superseded = list.some(
      (c) =>
        c.direction === 'cancelled' &&
        c.peerId === e.peerId &&
        Math.abs(c.at - e.at) <= OUTGOING_TO_CANCELLED_MS,
    );
    return !superseded;
  });
  return filtered.sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES);
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
  // Memory готов и load не идёт — отдаём сразу.
  if (memory && memoryUid === uid && !loadPromise) return memory;
  // Дождаться in-flight load (с merge), иначе cancel mid-load теряется.
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
      const disk = parseEntries(raw);
      // Cancel/record могли обновить memory пока ждали диск — не затирать.
      if (memory && memoryUid === uid) {
        memory = mergeCallLogPreferMemory(memory, disk);
      } else {
        memory = disk;
      }
      memoryUid = uid;
      notify();
      return memory;
    })
    .catch(() => {
      if (memoryUid !== uid) return memory || [];
      if (!(memory && memoryUid === uid)) {
        memory = [];
        memoryUid = uid;
      }
      notify();
      return memory || [];
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
    if (!silent) {
      cancelPendingCallLogNotify();
      notify();
    }
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
      cancelPendingCallLogNotify();
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
        cancelPendingCallLogNotify();
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
