import { useEffect, useLayoutEffect, useState, startTransition } from 'react';
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

    const applySnap = () => {
      if (cancelled) return;
      const snap = getCallLogSnapshot();
      startTransition(() => {
        if (!cancelled) setEntries(snap);
      });
    };

    const softPull = () => {
      if (cancelled) return;
      if (isOutgoingDialHot()) {
        // Dial/redial: не трогаем FlatList — догоним после.
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 700);
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
      if (isOutgoingDialHot()) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 700);
        return;
      }
      startTransition(() => {
        if (!cancelled) setEntries(list);
      });
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
