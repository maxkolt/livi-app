import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { API_BASE } from '../../../sockets/socket';
import { shouldSkipHomeUiSettle } from '../../../utils/globalEvents';

const REFRESH_MS = 45_000;

export function formatWelcomeOnlineCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  try {
    return new Intl.NumberFormat('ru-RU').format(Math.round(count));
  } catch {
    return String(Math.round(count));
  }
}

export function useWelcomeOnlineCount(enabled = true) {
  const [count, setCount] = useState<number | null>(null);
  const lastGoodRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch(`${API_BASE}/api/presence`, { method: 'GET' });
      if (!res.ok) return;
      const json = (await res.json()) as { ok?: boolean; list?: unknown[] };
      if (json?.ok && Array.isArray(json.list)) {
        const n = json.list.length;
        lastGoodRef.current = n;
        setCount(n);
      }
    } catch {
      if (lastGoodRef.current != null) setCount(lastGoodRef.current);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const recentOutgoingCancel = () => {
      try {
        const at = Number((global as any).__lastOutgoingCancelAtRef?.current || 0);
        return at > 0 && Date.now() - at < 12000;
      } catch {
        return false;
      }
    };
    // После cancel Outgoing enabled снова true на том же кадре что resume —
    // не дергать /api/presence+setCount, иначе лишний ре-рендер Home.
    if (!shouldSkipHomeUiSettle() && !recentOutgoingCancel()) {
      void refresh();
    }
    const interval = setInterval(() => {
      if (shouldSkipHomeUiSettle() || recentOutgoingCancel()) return;
      void refresh();
    }, REFRESH_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (shouldSkipHomeUiSettle() || recentOutgoingCancel()) return;
      void refresh();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [enabled, refresh]);

  return { onlineCount: count, refreshOnlineCount: refresh };
}
