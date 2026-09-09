import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { API_BASE } from '../../../sockets/socket';
import { shouldSkipHomeUiSettle } from '../../../utils/globalEvents';
import type { WelcomeBannerPeer } from '../WelcomeOnlineBanner';

const REFRESH_MS = 45_000;

export function formatWelcomeOnlineCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '—';
  try {
    return new Intl.NumberFormat('ru-RU').format(Math.round(count));
  } catch {
    return String(Math.round(count));
  }
}

type PresenceListItem =
  | string
  | {
      id?: string;
      nick?: string;
      name?: string;
      avatarVer?: number;
    };

function normalizePresencePeers(list: PresenceListItem[], excludeUserId?: string | null): WelcomeBannerPeer[] {
  const exclude = String(excludeUserId || '').trim().toLowerCase();
  const out: WelcomeBannerPeer[] = [];
  const seen = new Set<string>();

  for (const raw of list) {
    let id = '';
    let name = '';
    let avatarVer = 0;
    if (typeof raw === 'string') {
      id = String(raw || '').trim();
    } else if (raw && typeof raw === 'object') {
      id = String(raw.id || '').trim();
      name = String(raw.nick || raw.name || '').trim();
      avatarVer = Number(raw.avatarVer) || 0;
    }
    if (!id) continue;
    const key = id.toLowerCase();
    if (exclude && key === exclude) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      name,
      avatarVer,
      avatarUri: avatarVer > 0 ? `${API_BASE}/api/avatar/${encodeURIComponent(id)}?thumb=1` : undefined,
    });
  }
  return out;
}

export function useWelcomeOnlineCount(enabled = true, excludeUserId?: string | null) {
  const [count, setCount] = useState<number | null>(null);
  const [peers, setPeers] = useState<WelcomeBannerPeer[]>([]);
  const lastGoodRef = useRef<number | null>(null);
  const excludeRef = useRef(excludeUserId);
  excludeRef.current = excludeUserId;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const res = await fetch(`${API_BASE}/api/presence`, { method: 'GET' });
      if (!res.ok) return;
      const json = (await res.json()) as { ok?: boolean; list?: PresenceListItem[] };
      if (json?.ok && Array.isArray(json.list)) {
        const n = json.list.length;
        lastGoodRef.current = n;
        setCount(n);
        setPeers(normalizePresencePeers(json.list, excludeRef.current));
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

  // Пересчитать peers при смене своего id (исключить себя из стека).
  useEffect(() => {
    setPeers((prev) => {
      const exclude = String(excludeUserId || '').trim().toLowerCase();
      if (!exclude) return prev;
      const next = prev.filter((p) => String(p.id).toLowerCase() !== exclude);
      return next.length === prev.length ? prev : next;
    });
  }, [excludeUserId]);

  return { onlineCount: count, peers, refreshOnlineCount: refresh };
}
