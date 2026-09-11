import { useEffect, useLayoutEffect, useState } from 'react';
import { getCurrentUserId } from '../../../sockets/socket';
import {
  getCallLogSnapshot,
  loadCallLog,
  subscribeCallLog,
  subscribeCallLogSoftUi,
  type CallLogEntry,
} from '../callLog';

function isOutgoingDialHot(): boolean {
  try {
    const g = global as any;
    // Только активный дозвон — не grace после cancel: иначе строка «отменён/пропущен» ждёт ~3с.
    if (g.__outgoingStartInFlightRef?.current) return true;
    if (g.__outgoingCallUiActiveRef?.current) return true;
    if (g.__outgoingCallScreenVisibleRef?.current) return true;
    return false;
  } catch {
    return false;
  }
}

/** После cancel/timeout refs могут кратко выглядеть hot — строку в списке всё равно показать сразу. */
function shouldDeferCallLogUi(): boolean {
  if (!isOutgoingDialHot()) return false;
  try {
    const cancelAt = Number((global as any).__lastOutgoingCancelAtRef?.current || 0);
    if (cancelAt > 0 && Date.now() - cancelAt < 6000) return false;
  } catch {}
  return true;
}

export function useCallLog(enabled: boolean) {
  const [entries, setEntries] = useState<CallLogEntry[]>(() =>
    enabled ? getCallLogSnapshot() : [],
  );
  const uid = String(getCurrentUserId() || '').trim();

  // До paint: если prefetch уже в memory — сразу полный список, не «1 строка → rest».
  useLayoutEffect(() => {
    if (!enabled) return;
    const snap = getCallLogSnapshot();
    if (snap.length) setEntries(snap);
  }, [enabled, uid]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const applySnap = (list?: CallLogEntry[]) => {
      if (cancelled) return;
      setEntries(list ?? getCallLogSnapshot());
    };

    const softPull = () => {
      if (cancelled) return;
      if (shouldDeferCallLogUi()) {
        // Dial/redial: не трогаем FlatList — догоним после.
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 400);
        return;
      }
      applySnap();
    };

    const snap = getCallLogSnapshot();
    if (snap.length) setEntries(snap);
    void loadCallLog().then((list) => {
      if (!cancelled) setEntries(list);
    });

    const offSoft = subscribeCallLogSoftUi(softPull);
    const off = subscribeCallLog((list) => {
      if (cancelled) return;
      if (shouldDeferCallLogUi()) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 400);
        return;
      }
      applySnap(list);
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      off();
      offSoft();
    };
  }, [enabled, uid]);

  return entries;
}
