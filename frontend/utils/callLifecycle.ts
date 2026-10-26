/**
 * Жизненный цикл звонка другу — одна машина состояний вместо десятков глобальных флагов.
 *
 *   idle ──► outgoing ──┐
 *     │                 ├──► connecting ──► active ──► ending ──► idle
 *     └──► incoming ────┘         │                      ▲
 *     (accept из убитого        └──── отбой / сбой ─────┘
 *      приложения — сразу connecting)
 *   outgoing / incoming ──► idle   — отклонили, отменили, не дозвонились
 *
 * События приходят только из авторитетных мест (startCall, call:incoming, accept, LiveKit connected,
 * endCall / call:ended, cleanup сессии). Событие чужого звонка (поздний call:ended прошлого callId)
 * игнорируется, недопустимый переход пишется в лог и не применяется.
 *
 * Без таймеров: время только запоминается (since). RN не запускает JS-таймеры в фоне, и флаги
 * «снять через 3–6 с» там залипали или истекали не вовремя.
 */
import { logger } from './logger';

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ending';
export type CallRole = 'caller' | 'callee';

export type CallLifecycleState = Readonly<{
  phase: CallPhase;
  callId: string | null;
  peerUserId: string | null;
  role: CallRole | null;
  /** Когда вошли в текущую фазу (Date.now()). */
  since: number;
  /** Почему звонок завершается / завершился (последний). */
  endReason: string | null;
}>;

const NEXT: Record<CallPhase, readonly CallPhase[]> = {
  idle: ['outgoing', 'incoming', 'connecting'],
  outgoing: ['connecting', 'ending', 'idle'],
  incoming: ['connecting', 'ending', 'idle'],
  connecting: ['active', 'ending'],
  active: ['ending'],
  ending: ['idle'],
};

const IDLE: CallLifecycleState = Object.freeze({
  phase: 'idle',
  callId: null,
  peerUserId: null,
  role: null,
  since: 0,
  endReason: null,
});

let state: CallLifecycleState = IDLE;
const listeners = new Set<(next: CallLifecycleState, prev: CallLifecycleState) => void>();

export function getCallLifecycle(): CallLifecycleState {
  return state;
}

/** Медиа звонка идёт или вот-вот пойдёт: принят и соединяется, либо соединён. */
export function isCallMediaLive(): boolean {
  return state.phase === 'connecting' || state.phase === 'active';
}

/** Есть звонок, который ещё не закончился (включая дозвон и входящий). */
export function isCallInProgress(): boolean {
  return state.phase !== 'idle' && state.phase !== 'ending';
}

export function subscribeCallLifecycle(
  listener: (next: CallLifecycleState, prev: CallLifecycleState) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function normId(value: string | null | undefined): string | null {
  const s = String(value ?? '').trim();
  return s || null;
}

/** Событие относится к текущему звонку (или callId неизвестен с одной из сторон). */
function sameCall(callId: string | null): boolean {
  return !callId || !state.callId || callId === state.callId;
}

function transition(
  phase: CallPhase,
  event: string,
  patch: Partial<Omit<CallLifecycleState, 'phase' | 'since'>>,
): boolean {
  const prev = state;
  if (prev.phase !== phase && !NEXT[prev.phase].includes(phase)) {
    logger.warn('[callLifecycle] illegal transition ignored', {
      event,
      from: prev.phase,
      to: phase,
      callId: prev.callId,
      eventCallId: patch.callId ?? null,
    });
    return false;
  }
  const next: CallLifecycleState = Object.freeze({
    ...prev,
    ...patch,
    phase,
    since: prev.phase === phase ? prev.since : Date.now(),
  });
  state = next;
  if (prev.phase !== next.phase || prev.callId !== next.callId) {
    logger.info('[callLifecycle] transition', {
      event,
      from: prev.phase,
      to: next.phase,
      callId: next.callId,
      role: next.role,
      reason: next.endReason,
    });
  }
  for (const listener of [...listeners]) {
    try {
      listener(next, prev);
    } catch {}
  }
  return true;
}

/** Новый звонок, пока прошлый ещё не дочищен (быстрый перезвон): прошлый считаем закончившимся. */
function finishStalePreviousCall(event: string): void {
  if (state.phase === 'idle') return;
  if (state.phase !== 'ending') transition('ending', `${event}:supersede`, { endReason: 'superseded' });
  transition('idle', `${event}:supersede`, {});
}

export const callLifecycle = {
  /** Мы звоним (startCall). callId приходит позже — outgoingCallIdAssigned. */
  outgoingStarted(peerUserId: string): void {
    finishStalePreviousCall('outgoingStarted');
    transition('outgoing', 'outgoingStarted', {
      callId: null,
      peerUserId: normId(peerUserId),
      role: 'caller',
      endReason: null,
    });
  },

  outgoingCallIdAssigned(callId: string): void {
    const id = normId(callId);
    if (state.phase !== 'outgoing' || !id) return;
    transition('outgoing', 'outgoingCallIdAssigned', { callId: id });
  },

  /** Нам звонят (call:incoming / push), до ответа. */
  incomingPresented(callId: string, peerUserId: string): void {
    const id = normId(callId);
    if (!id) return;
    if (state.callId === id && state.phase !== 'idle') return;
    if (isCallInProgress()) {
      // Входящий поверх идущего звонка — это «занят», не новая фаза.
      logger.info('[callLifecycle] incoming during another call ignored', { callId: id, current: state.callId });
      return;
    }
    finishStalePreviousCall('incomingPresented');
    transition('incoming', 'incomingPresented', {
      callId: id,
      peerUserId: normId(peerUserId),
      role: 'callee',
      endReason: null,
    });
  },

  /** Звонок принят: мы ответили или нам ответили. */
  accepted(callId: string, peerUserId: string | null, role: CallRole): void {
    const id = normId(callId);
    if (state.phase === 'connecting' || state.phase === 'active') {
      if (!sameCall(id)) logger.warn('[callLifecycle] accept for another call ignored', { callId: id, current: state.callId });
      return;
    }
    if (state.phase === 'ending') finishStalePreviousCall('accepted');
    if (!sameCall(id) && state.phase !== 'idle') finishStalePreviousCall('accepted');
    transition('connecting', 'accepted', {
      callId: id ?? state.callId,
      peerUserId: normId(peerUserId) ?? state.peerUserId,
      role,
      endReason: null,
    });
  },

  /** LiveKit соединился, медиа идёт. */
  mediaConnected(callId: string | null): void {
    if (state.phase !== 'connecting' || !sameCall(normId(callId))) return;
    transition('active', 'mediaConnected', {});
  },

  /** Отбой нажат или пришёл call:ended; сессия ещё дочищается. */
  endRequested(callId: string | null, reason: string): void {
    if (state.phase === 'idle' || state.phase === 'ending' || !sameCall(normId(callId))) return;
    transition('ending', 'endRequested', { endReason: reason });
  },

  /** Звонок не состоялся: отклонили, отменили, не ответили. */
  ringEnded(callId: string | null, reason: string): void {
    if ((state.phase !== 'outgoing' && state.phase !== 'incoming') || !sameCall(normId(callId))) return;
    transition('idle', 'ringEnded', { endReason: reason, callId: null, peerUserId: null, role: null });
  },

  /** Сессия звонка дочищена. */
  ended(callId: string | null, reason: string): void {
    if (state.phase === 'idle' || !sameCall(normId(callId))) return;
    if (state.phase !== 'ending') transition('ending', 'ended', { endReason: state.endReason ?? reason });
    transition('idle', 'ended', { callId: null, peerUserId: null, role: null });
  },
};

/** Только для тестов. */
export function __resetCallLifecycleForTests(): void {
  state = IDLE;
  listeners.clear();
}
