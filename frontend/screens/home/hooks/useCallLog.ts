import { useEffect, useState } from 'react';
import { loadCallLog, subscribeCallLog, type CallLogEntry } from '../callLog';

export function useCallLog(enabled: boolean) {
  const [entries, setEntries] = useState<CallLogEntry[]>([]);

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
  }, [enabled]);

  return entries;
}
