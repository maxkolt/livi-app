import { useEffect, useState, startTransition } from 'react';
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
    if (g.__outgoingStartInFlightRef?.current) return true;
    if (g.__outgoingCallUiActiveRef?.current) return true;
    if (g.__outgoingCallScreenVisibleRef?.current) return true;
    // Cancel→redial grace: не bump FlatList, пока пользователь может сразу набрать снова.
    const cancelAt = Number(g.__lastOutgoingCancelAtRef?.current || 0);
    if (cancelAt > 0 && Date.now() - cancelAt < 3200) return true;
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

    // Вход на Calls: memory уже cancelled/outgoing — без ожидания notify.
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
