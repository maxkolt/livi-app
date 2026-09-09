import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { API_BASE, onConnected, onWelcomePresence } from '../../../sockets/socket';
import { shouldSkipHomeUiSettle } from '../../../utils/globalEvents';
import type { WelcomeBannerPeer } from '../WelcomeOnlineBanner';

/** Fallback heal, если socket snapshot давно не приходил. */
const FALLBACK_REFRESH_MS = 120_000;

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

function applyPresenceList(
  list: PresenceListItem[],
  excludeUserId: string | null | undefined,
  setCount: (n: number) => void,
  setPeers: (p: WelcomeBannerPeer[]) => void,
  lastGoodRef: { current: number | null },
) {
  const n = list.length;
  lastGoodRef.current = n;
  setCount(n);
  setPeers(normalizePresencePeers(list, excludeUserId));
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
        applyPresenceList(json.list, excludeRef.current, setCount, setPeers, lastGoodRef);
      }
    } catch {
      if (lastGoodRef.current != null) setCount(lastGoodRef.current);
    }
  }, [enabled]);

  // Socket realtime: presence:welcome при входе/выходе/фоне любого пользователя.
  useEffect(() => {
    if (!enabled) return;
    const unsub = onWelcomePresence((data) => {
      if (shouldSkipHomeUiSettle()) return;
      if (!data || data.ok === false || !Array.isArray(data.list)) return;
      applyPresenceList(data.list, excludeRef.current, setCount, setPeers, lastGoodRef);
    });
    return unsub;
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
    // Первый снимок: HTTP + после connect (сервер шлёт welcome вместе с friend presence).
    if (!shouldSkipHomeUiSettle() && !recentOutgoingCancel()) {
      void refresh();
    }
    const unsubConnected = onConnected(() => {
      if (shouldSkipHomeUiSettle() || recentOutgoingCancel()) return;
      void refresh();
    });
    const interval = setInterval(() => {
      if (shouldSkipHomeUiSettle() || recentOutgoingCancel()) return;
      void refresh();
    }, FALLBACK_REFRESH_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (shouldSkipHomeUiSettle() || recentOutgoingCancel()) return;
      void refresh();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
      unsubConnected();
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
