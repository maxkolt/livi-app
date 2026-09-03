import { useEffect, useState } from 'react';
import { getCurrentUserId } from '../../../sockets/socket';
import { loadCallLog, subscribeCallLog, type CallLogEntry } from '../callLog';

export function useCallLog(enabled: boolean) {
  const [entries, setEntries] = useState<CallLogEntry[]>([]);
  const uid = String(getCurrentUserId() || '').trim();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadCallLog().then((list) => {
      if (!cancelled) setEntries(list);
    });
    const off = subscribeCallLog((list) => {
      if (!cancelled) setEntries(list);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, uid]);

  return entries;
}
