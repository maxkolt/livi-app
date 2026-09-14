/**
 * Active direct-call lease: busy stays only while heartbeats arrive.
 * No keepalive past TTL → server ends the call and clears busy.
 */

export type ActiveCallLeasePhase = 'active' | 'reconnecting';

export type ActiveCallLease = {
  callId: string;
  roomId: string;
  a: string;
  b: string;
  lastHeartbeatAt: number;
  phase: ActiveCallLeasePhase;
  createdAtMs: number;
};

/** Max silence before server force-ends (align with reconnect grace ~30–60s). */
export const CALL_LEASE_TTL_MS = 45_000;
export const CALL_LEASE_SWEEP_MS = 5_000;

const leasesByCallId = new Map<string, ActiveCallLease>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function registerActiveCallLease(input: {
  callId: string;
  roomId: string;
  a: string;
  b: string;
}): ActiveCallLease {
  const callId = String(input.callId || '').trim();
  const roomId = String(input.roomId || '').trim();
  const a = String(input.a || '').trim();
  const b = String(input.b || '').trim();
  const now = Date.now();
  const lease: ActiveCallLease = {
    callId,
    roomId,
    a,
    b,
    lastHeartbeatAt: now,
    phase: 'active',
    createdAtMs: now,
  };
  if (callId) leasesByCallId.set(callId, lease);
  return lease;
}

export function touchActiveCallLease(
  callId: string,
  opts?: { phase?: ActiveCallLeasePhase },
): ActiveCallLease | null {
  const id = String(callId || '').trim();
  if (!id) return null;
  const lease = leasesByCallId.get(id);
  if (!lease) return null;
  lease.lastHeartbeatAt = Date.now();
  if (opts?.phase) lease.phase = opts.phase;
  return lease;
}

export function clearActiveCallLease(callId: string | null | undefined): void {
  const id = String(callId || '').trim();
  if (!id) return;
  leasesByCallId.delete(id);
}

export function getActiveCallLease(callId: string | null | undefined): ActiveCallLease | null {
  const id = String(callId || '').trim();
  if (!id) return null;
  return leasesByCallId.get(id) || null;
}

export function findActiveCallLeaseByRoom(roomId: string | null | undefined): ActiveCallLease | null {
  const rid = String(roomId || '').trim();
  if (!rid) return null;
  for (const lease of leasesByCallId.values()) {
    if (lease.roomId === rid) return lease;
  }
  return null;
}

export function findActiveCallLeaseForUser(userId: string | null | undefined): ActiveCallLease | null {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  for (const lease of leasesByCallId.values()) {
    if (lease.a === uid || lease.b === uid) return lease;
  }
  return null;
}

export function hasActiveCallLease(callId: string | null | undefined): boolean {
  return !!getActiveCallLease(callId);
}

export function listExpiredActiveCallLeases(
  now = Date.now(),
  ttlMs = CALL_LEASE_TTL_MS,
): ActiveCallLease[] {
  const out: ActiveCallLease[] = [];
  for (const lease of leasesByCallId.values()) {
    if (now - lease.lastHeartbeatAt > ttlMs) out.push({ ...lease });
  }
  return out;
}

export function startActiveCallLeaseSweeper(
  onExpired: (lease: ActiveCallLease) => void | Promise<void>,
  intervalMs = CALL_LEASE_SWEEP_MS,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const expired = listExpiredActiveCallLeases();
    for (const lease of expired) {
      // Drop from map first so a slow end path cannot double-fire.
      clearActiveCallLease(lease.callId);
      try {
        void Promise.resolve(onExpired(lease)).catch(() => {});
      } catch {}
    }
  }, intervalMs);
  // Unref so lease sweeper does not keep the process alive in tests/scripts.
  try {
    (sweepTimer as any)?.unref?.();
  } catch {}
}

export function stopActiveCallLeaseSweeper(): void {
  if (!sweepTimer) return;
  try {
    clearInterval(sweepTimer);
  } catch {}
  sweepTimer = null;
}
