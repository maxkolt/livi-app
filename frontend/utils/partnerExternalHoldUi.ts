/** UI-снимок «партнёр на GSM hold» без импорта socket (для useSyncExternalStore). */

import { isExternalCallHoldActive } from './externalCallHold';

type HoldSessionLike = {
  isEnded?: () => boolean;
  getRoomId?: () => string | null;
  getPartnerUserId?: () => string | null;
  config?: { myUserId?: string };
  setPartnerExternalHoldState?: (hold: boolean) => void;
};

const listeners = new Set<() => void>();

export function subscribePartnerExternalHoldUi(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

export function getPartnerExternalHoldSnapshot(): boolean {
  try {
    return (global as any).__partnerExternalHoldRef?.current === true;
  } catch {
    return false;
  }
}

export function setPartnerExternalHoldSnapshot(hold: boolean): void {
  try {
    const g = global as any;
    g.__partnerExternalHoldRef = g.__partnerExternalHoldRef || { current: false };
    if (g.__partnerExternalHoldRef.current === hold) {
      listeners.forEach((l) => l());
      return;
    }
    g.__partnerExternalHoldRef.current = hold;
  } catch {}
  listeners.forEach((l) => l());
}

function incomingMatchesActiveCall(session: HoldSessionLike, roomId?: string | null): boolean {
  const incoming = String(roomId ?? '').trim();
  if (!incoming) {
    return !!(session.getRoomId?.() || session.getPartnerUserId?.());
  }
  if (!incoming.startsWith('room_')) return false;
  const me = String(session.config?.myUserId ?? '').trim();
  const partner = String(session.getPartnerUserId?.() ?? '').trim();
  if (me && partner && incoming.includes(me) && incoming.includes(partner)) return true;
  const current = String(session.getRoomId?.() ?? '').trim();
  return !!current && (current === incoming || incoming.includes(me));
}

/** Единая точка для socket relay и VideoCallSession — всегда через __webrtcSessionRef. */
export function dispatchPartnerExternalHoldFromSocket(hold: boolean, roomId?: string | null): void {
  let session: HoldSessionLike | null = null;
  try {
    session = (global as any).__webrtcSessionRef?.current ?? null;
  } catch {}
  if (!session || (typeof session.isEnded === 'function' && session.isEnded())) {
    if (!hold) setPartnerExternalHoldSnapshot(false);
    return;
  }
  if (!incomingMatchesActiveCall(session, roomId)) return;
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
