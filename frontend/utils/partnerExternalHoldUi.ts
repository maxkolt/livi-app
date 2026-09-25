/** UI-снимок «партнёр на GSM hold» без импорта socket (для useSyncExternalStore). */

import { isExternalCallHoldActive } from './externalCallHold';

export type PartnerExternalHoldSignal = {
  callId?: string | null;
  roomId?: string | null;
  from?: string | null;
};

type HoldSessionLike = {
  isEnded?: () => boolean;
  getCallId?: () => string | null;
  getRoomId?: () => string | null;
  getPartnerUserId?: () => string | null;
  config?: { myUserId?: string };
  matchesExternalHoldSignal?: (signal?: PartnerExternalHoldSignal | null) => boolean;
  setPartnerExternalHoldState?: (hold: boolean) => void;
};

type PartnerExternalHoldRef = {
  current: boolean;
  callId?: string | null;
  roomId?: string | null;
};

const listeners = new Set<() => void>();

function normalized(value?: string | null): string | null {
  const result = String(value ?? '').trim();
  return result || null;
}

function getRef(): PartnerExternalHoldRef | null {
  try {
    return (global as any).__partnerExternalHoldRef ?? null;
  } catch {
    return null;
  }
}

function getActiveSession(): HoldSessionLike | null {
  try {
    return (global as any).__webrtcSessionRef?.current ?? null;
  } catch {
    return null;
  }
}

function notifyListeners(): void {
  listeners.forEach((listener) => listener());
}

export function subscribePartnerExternalHoldUi(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

export function getPartnerExternalHoldSnapshot(): boolean {
  const ref = getRef();
  if (ref?.current !== true) return false;

  // Один и тот же direct-call room переиспользуется между звонками. Не позволяем
  // снимку предыдущего callId включить hold уже в следующем звонке.
  const storedCallId = normalized(ref.callId);
  const session = getActiveSession();
  if (session && (typeof session.isEnded !== 'function' || !session.isEnded())) {
    const activeCallId = normalized(session.getCallId?.());
    if (storedCallId && activeCallId && storedCallId !== activeCallId) return false;
  }
  return true;
}

export function setPartnerExternalHoldSnapshot(
  hold: boolean,
  scope?: PartnerExternalHoldSignal | null,
): void {
  try {
    const g = global as any;
    const ref: PartnerExternalHoldRef =
      g.__partnerExternalHoldRef || (g.__partnerExternalHoldRef = { current: false });
    const callId = normalized(scope?.callId);
    const roomId = normalized(scope?.roomId);

    if (!hold) {
      const storedCallId = normalized(ref.callId);
      // Поздняя очистка старой сессии не должна погасить hold уже нового звонка.
      if (callId && storedCallId && callId !== storedCallId) return;
      ref.current = false;
      ref.callId = null;
      ref.roomId = null;
    } else {
      ref.current = true;
      ref.callId = callId;
      ref.roomId = roomId;
    }
  } catch {}
  notifyListeners();
}

/** Вызывается на границе нового звонка; повторная подготовка того же callId сохраняет его hold. */
export function preparePartnerExternalHoldSnapshotForCall(callId?: string | null): void {
  const nextCallId = normalized(callId);
  if (!nextCallId) return;
  const ref = getRef();
  if (ref?.current !== true) return;
  if (normalized(ref.callId) === nextCallId) return;
  setPartnerExternalHoldSnapshot(false);
}

function incomingMatchesActiveCall(
  session: HoldSessionLike,
  signal?: PartnerExternalHoldSignal | null,
): boolean {
  const incomingCallId = normalized(signal?.callId);
  const activeCallId = normalized(session.getCallId?.());
  if (incomingCallId && (!activeCallId || incomingCallId !== activeCallId)) return false;

  if (typeof session.matchesExternalHoldSignal === 'function') {
    return session.matchesExternalHoldSignal(signal);
  }

  const incomingRoomId = normalized(signal?.roomId);
  if (!incomingRoomId) {
    return !!(incomingCallId || session.getRoomId?.() || session.getPartnerUserId?.());
  }
  if (!incomingRoomId.startsWith('room_')) return false;
  const me = normalized(session.config?.myUserId);
  const partner = normalized(session.getPartnerUserId?.());
  if (me && partner && incomingRoomId.includes(me) && incomingRoomId.includes(partner)) return true;
  const current = normalized(session.getRoomId?.());
  return !!current && (current === incomingRoomId || (!!me && incomingRoomId.includes(me)));
}

/** Единая точка для socket relay и VideoCallSession — всегда через __webrtcSessionRef. */
export function dispatchPartnerExternalHoldFromSocket(
  hold: boolean,
  signal?: PartnerExternalHoldSignal | null,
): void {
  const session = getActiveSession();
  if (!session || (typeof session.isEnded === 'function' && session.isEnded())) {
    if (!hold) setPartnerExternalHoldSnapshot(false, signal);
    return;
  }
  if (!incomingMatchesActiveCall(session, signal)) return;
  if (hold) {
    if (isExternalCallHoldActive()) return;
    const localHold =
      typeof (session as HoldSessionLike & { getLocalExternalHoldActive?: () => boolean })
        .getLocalExternalHoldActive === 'function' &&
      (session as HoldSessionLike & { getLocalExternalHoldActive?: () => boolean })
        .getLocalExternalHoldActive?.();
    if (localHold) return;
  }
  try {
    session.setPartnerExternalHoldState?.(hold);
  } catch {}
}
