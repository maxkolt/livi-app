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

/** После cancel/decline/end refs могут кратко выглядеть hot — строку показать сразу. */
function shouldDeferCallLogUi(): boolean {
  if (!isOutgoingDialHot()) return false;
  try {
    const g = global as any;
    const forceAt = Number(g.__lastCallLogForceUiAtRef?.current || 0);
    if (forceAt > 0 && Date.now() - forceAt < 8000) return false;
    const cancelAt = Number(g.__lastOutgoingCancelAtRef?.current || 0);
    // Сразу после отмены не глушить UI — иначе «Отменённый/Пропущенный» ждёт остывания dial refs.
    if (cancelAt > 0 && Date.now() - cancelAt < 8000) return false;
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
        retryTimer = setTimeout(softPull, 250);
        return;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      applySnap();
    };

    const snap = getCallLogSnapshot();
    if (snap.length) setEntries(snap);
    void loadCallLog().then((list) => {
      if (cancelled) return;
      if (shouldDeferCallLogUi()) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 250);
        return;
      }
      setEntries(list);
    });

    const offSoft = subscribeCallLogSoftUi(softPull);
    const off = subscribeCallLog((list) => {
      if (cancelled) return;
      if (shouldDeferCallLogUi()) {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(softPull, 250);
        return;
      }
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
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
