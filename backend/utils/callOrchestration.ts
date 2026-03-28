import crypto from 'crypto';
import CallTimelineModel, {
  type CallLifecycleState,
  type CallTimelineEventName,
} from '../models/CallTimeline';
import { logger } from './logger';
import { callProviderMode } from './callProvider';

type CloseReason = 'accepted' | 'declined' | 'canceled' | 'timeout';
type IncomingShownSource = 'socket' | 'native_http' | 'provider';

type TimelineEvent = {
  name: CallTimelineEventName;
  atMs: number;
  source?: string;
  meta?: Record<string, unknown>;
};

type OrchestratedCall = {
  callId: string;
  callerId: string;
  calleeId: string;
  state: CallLifecycleState;
  closeReason?: CloseReason;
  providerPrimary: boolean;
  pushFallbackEnabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  incomingShownAtMs?: number;
  events: TimelineEvent[];
  processedActions: Set<string>;
};

type OrchestratedCallView = Omit<OrchestratedCall, 'processedActions'> & {
  processedActionsCount: number;
};

export const callFeatureFlags = {
  orchestrationEnabled: String(process.env.CALL_ORCHESTRATION_ENABLED ?? '1') !== '0',
  providerMode: callProviderMode,
  providerSignalingEnabled: callProviderMode !== 'none',
  pushFallbackEnabled: String(process.env.CALL_PUSH_FALLBACK_ENABLED ?? '1') !== '0',
  rolloutPercent: Math.max(0, Math.min(100, Number(process.env.CALL_ROLLOUT_PERCENT ?? 100))),
};

const terminalStates: ReadonlySet<CallLifecycleState> = new Set([
  'accepted',
  'declined',
  'canceled',
  'timeout',
  'ended',
]);

const calls = new Map<string, OrchestratedCall>();

function nowMs(): number {
  return Date.now();
}

function hashToPercent(input: string): number {
  const hashHex = crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
  const value = parseInt(hashHex, 16);
  return value % 100;
}

function persistUpsert(snapshot: OrchestratedCall): void {
  void CallTimelineModel.updateOne(
    { callId: snapshot.callId },
    {
      $set: {
        callerId: snapshot.callerId,
        calleeId: snapshot.calleeId,
        state: snapshot.state,
        closeReason: snapshot.closeReason,
        providerPrimary: snapshot.providerPrimary,
        pushFallbackEnabled: snapshot.pushFallbackEnabled,
        createdAtMs: snapshot.createdAtMs,
        updatedAtMs: snapshot.updatedAtMs,
        incomingShownAtMs: snapshot.incomingShownAtMs,
      },
      $setOnInsert: { callId: snapshot.callId },
    },
    { upsert: true }
  ).catch((e: unknown) => {
    logger.warn('[call:orchestration] persist upsert failed', {
      callId: snapshot.callId,
      error: (e as Error)?.message ?? String(e),
    });
  });
}

function persistAppendEvent(callId: string, event: TimelineEvent): void {
  void CallTimelineModel.updateOne(
    { callId },
    {
      $set: { updatedAtMs: nowMs() },
      $push: {
        events: {
          name: event.name,
          atMs: event.atMs,
          source: event.source ?? '',
          meta: event.meta ?? {},
        },
      },
    },
    { upsert: true }
  ).catch((e: unknown) => {
    logger.warn('[call:orchestration] persist append event failed', {
      callId,
      event: event.name,
      error: (e as Error)?.message ?? String(e),
    });
  });
}

function get(callId: string): OrchestratedCall | undefined {
  return calls.get(callId);
}

function appendEvent(snapshot: OrchestratedCall, event: TimelineEvent): void {
  snapshot.events.push(event);
  snapshot.updatedAtMs = event.atMs;
  persistAppendEvent(snapshot.callId, event);
}

export function isCallInRollout(callerId: string, calleeId: string): boolean {
  if (callFeatureFlags.rolloutPercent >= 100) return true;
  if (callFeatureFlags.rolloutPercent <= 0) return false;
  const bucket = hashToPercent(`${callerId}:${calleeId}`);
  return bucket < callFeatureFlags.rolloutPercent;
}

export function createOrchestratedCall(params: {
  callId: string;
  callerId: string;
  calleeId: string;
}): OrchestratedCall | null {
  if (!callFeatureFlags.orchestrationEnabled) return null;
  if (!isCallInRollout(params.callerId, params.calleeId)) return null;
  const existing = get(params.callId);
  if (existing) return existing;

  const createdAtMs = nowMs();
  const snapshot: OrchestratedCall = {
    callId: params.callId,
    callerId: params.callerId,
    calleeId: params.calleeId,
    state: 'invited',
    providerPrimary: callFeatureFlags.providerSignalingEnabled,
    pushFallbackEnabled: callFeatureFlags.pushFallbackEnabled,
    createdAtMs,
    updatedAtMs: createdAtMs,
    events: [],
    processedActions: new Set<string>(),
  };
  calls.set(params.callId, snapshot);
  appendEvent(snapshot, { name: 'invite_sent', atMs: createdAtMs, source: 'socket' });
  persistUpsert(snapshot);
  return snapshot;
}

export function addCallEvent(
  callId: string,
  name: CallTimelineEventName,
  source: string,
  meta?: Record<string, unknown>
): void {
  const snapshot = get(callId);
  if (!snapshot) return;
  appendEvent(snapshot, { name, atMs: nowMs(), source, meta });
  persistUpsert(snapshot);
}

export function markIncomingShown(callId: string, source: IncomingShownSource): boolean {
  const snapshot = get(callId);
  if (!snapshot) return false;
  if (snapshot.incomingShownAtMs) return false;
  const atMs = nowMs();
  snapshot.incomingShownAtMs = atMs;
  if (!terminalStates.has(snapshot.state)) snapshot.state = 'incoming_shown';
  appendEvent(snapshot, { name: 'incoming_shown', atMs, source });
  persistUpsert(snapshot);
  return true;
}

export function transitionCall(
  callId: string,
  nextState: Extract<CallLifecycleState, 'accepted' | 'declined' | 'canceled' | 'timeout' | 'ended'>,
  opts?: { actionKey?: string; source?: string; meta?: Record<string, unknown> }
): boolean {
  const snapshot = get(callId);
  if (!snapshot) return false;
  const actionKey = String(opts?.actionKey || `${nextState}:${callId}`);
  if (snapshot.processedActions.has(actionKey)) return false;
  snapshot.processedActions.add(actionKey);
  if (terminalStates.has(snapshot.state)) return false;

  snapshot.state = nextState;
  if (nextState === 'accepted' || nextState === 'declined' || nextState === 'canceled' || nextState === 'timeout') {
    snapshot.closeReason = nextState;
  }
  const eventName =
    nextState === 'accepted'
      ? 'accepted'
      : nextState === 'declined'
        ? 'declined'
        : nextState === 'canceled'
          ? 'canceled'
          : nextState === 'timeout'
            ? 'timeout'
            : 'end_reason';
  appendEvent(snapshot, { name: eventName, atMs: nowMs(), source: opts?.source, meta: opts?.meta });
  persistUpsert(snapshot);
  return true;
}

export function finalizeCall(callId: string, reason: CloseReason): void {
  const snapshot = get(callId);
  if (!snapshot) return;
  if (!terminalStates.has(snapshot.state)) {
    transitionCall(callId, reason, { source: 'cleanup', actionKey: `cleanup:${callId}:${reason}` });
  }
  addCallEvent(callId, 'end_reason', 'cleanup', { reason });
}

export function pruneOrchestratedCall(callId: string): void {
  const snapshot = get(callId);
  if (!snapshot) return;
  // Keep in-memory state bounded; Mongo keeps the historical timeline.
  calls.delete(callId);
}

export function markProviderDelivered(callId: string, providerPayload?: Record<string, unknown>): boolean {
  const snapshot = get(callId);
  if (!snapshot) return false;
  addCallEvent(callId, 'provider_delivered', 'provider_webhook', providerPayload);
  return true;
}

export function getCallTimeline(callId: string): OrchestratedCallView | null {
  const snapshot = get(callId);
  if (!snapshot) return null;
  return {
    callId: snapshot.callId,
    callerId: snapshot.callerId,
    calleeId: snapshot.calleeId,
    state: snapshot.state,
    closeReason: snapshot.closeReason,
    providerPrimary: snapshot.providerPrimary,
    pushFallbackEnabled: snapshot.pushFallbackEnabled,
    createdAtMs: snapshot.createdAtMs,
    updatedAtMs: snapshot.updatedAtMs,
    incomingShownAtMs: snapshot.incomingShownAtMs,
    events: snapshot.events,
    processedActionsCount: snapshot.processedActions.size,
  };
}

export function getOrchestrationMetrics(windowMin = 60): {
  windowMin: number;
  totals: {
    invites: number;
    incomingShown: number;
    accepted: number;
    declined: number;
    canceled: number;
    timeout: number;
    timeoutWithoutShown: number;
  };
  rates: {
    incomingShownRate: number;
    answeredSuccessRate: number;
    missedDueToDeliveryRate: number;
  };
} {
  const now = nowMs();
  const windowMs = Math.max(1, windowMin) * 60_000;
  const list = Array.from(calls.values()).filter((it) => now - it.createdAtMs <= windowMs);
  const invites = list.length;
  const incomingShown = list.filter((it) => it.incomingShownAtMs != null).length;
  const accepted = list.filter((it) => it.state === 'accepted' || it.closeReason === 'accepted').length;
  const declined = list.filter((it) => it.state === 'declined' || it.closeReason === 'declined').length;
  const canceled = list.filter((it) => it.state === 'canceled' || it.closeReason === 'canceled').length;
  const timeout = list.filter((it) => it.state === 'timeout' || it.closeReason === 'timeout').length;
  const timeoutWithoutShown = list.filter(
    (it) => (it.state === 'timeout' || it.closeReason === 'timeout') && it.incomingShownAtMs == null
  ).length;

  const incomingShownRate = invites > 0 ? incomingShown / invites : 1;
  const answeredSuccessRate = invites > 0 ? accepted / invites : 1;
  const missedDueToDeliveryRate = invites > 0 ? timeoutWithoutShown / invites : 0;

  return {
    windowMin,
    totals: {
      invites,
      incomingShown,
      accepted,
      declined,
      canceled,
      timeout,
      timeoutWithoutShown,
    },
    rates: {
      incomingShownRate,
      answeredSuccessRate,
      missedDueToDeliveryRate,
    },
  };
}

export async function getOrchestrationMetricsFromDb(windowMin = 60): Promise<{
  windowMin: number;
  totals: {
    invites: number;
    incomingShown: number;
    accepted: number;
    declined: number;
    canceled: number;
    timeout: number;
    timeoutWithoutShown: number;
  };
  rates: {
    incomingShownRate: number;
    answeredSuccessRate: number;
    missedDueToDeliveryRate: number;
  };
  latencyMs: {
    incomingShownP50: number | null;
    incomingShownP95: number | null;
  };
}> {
  const windowMs = Math.max(1, windowMin) * 60_000;
  const fromMs = nowMs() - windowMs;
  const docs = (await CallTimelineModel.find({ createdAtMs: { $gte: fromMs } })
    .select('state closeReason createdAtMs incomingShownAtMs')
    .lean()) as Array<{
    state?: CallLifecycleState;
    closeReason?: CloseReason;
    createdAtMs?: number;
    incomingShownAtMs?: number;
  }>;

  const invites = docs.length;
  const incomingShown = docs.filter((it) => typeof it.incomingShownAtMs === 'number').length;
  const accepted = docs.filter((it) => it.state === 'accepted' || it.closeReason === 'accepted').length;
  const declined = docs.filter((it) => it.state === 'declined' || it.closeReason === 'declined').length;
  const canceled = docs.filter((it) => it.state === 'canceled' || it.closeReason === 'canceled').length;
  const timeout = docs.filter((it) => it.state === 'timeout' || it.closeReason === 'timeout').length;
  const timeoutWithoutShown = docs.filter(
    (it) => (it.state === 'timeout' || it.closeReason === 'timeout') && it.incomingShownAtMs == null
  ).length;

  const incomingShownRate = invites > 0 ? incomingShown / invites : 1;
  const answeredSuccessRate = invites > 0 ? accepted / invites : 1;
  const missedDueToDeliveryRate = invites > 0 ? timeoutWithoutShown / invites : 0;

  const latencies = docs
    .filter((it) => typeof it.createdAtMs === 'number' && typeof it.incomingShownAtMs === 'number')
    .map((it) => Math.max(0, Number(it.incomingShownAtMs) - Number(it.createdAtMs)))
    .sort((a, b) => a - b);

  const quantile = (arr: number[], q: number): number | null => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(arr.length * q) - 1));
    return arr[idx];
  };

  return {
    windowMin,
    totals: {
      invites,
      incomingShown,
      accepted,
      declined,
      canceled,
      timeout,
      timeoutWithoutShown,
    },
    rates: {
      incomingShownRate,
      answeredSuccessRate,
      missedDueToDeliveryRate,
    },
    latencyMs: {
      incomingShownP50: quantile(latencies, 0.5),
      incomingShownP95: quantile(latencies, 0.95),
    },
  };
}

export async function getCallTimelineFromDb(callId: string): Promise<Record<string, unknown> | null> {
  const doc = await CallTimelineModel.findOne({ callId }).lean();
  return (doc as Record<string, unknown> | null) ?? null;
}
