import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { AppState, DeviceEventEmitter } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import {
  API_BASE, onConnected, onWelcomePresence, beginWelcomePresenceRefresh,
  getWelcomePresenceSnapshot, refreshWelcomePresenceSnapshot,
} from '../../../sockets/socket';
import { shouldSkipHomeUiSettle } from '../../../utils/globalEvents';
import { fetchWithTimeout } from '../../../utils/fetchWithTimeout';
import type { WelcomeBannerPeer } from '../WelcomeOnlineBanner';
import { WelcomeOnlineRefresh } from './welcomeOnlineRefresh';
export { formatWelcomeOnlineCount } from '../utils/welcomeOnlineLabel';

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

function samePeers(a: WelcomeBannerPeer[], b: WelcomeBannerPeer[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (p, i) => p.id === b[i].id && p.name === b[i].name && p.avatarVer === b[i].avatarVer,
  );
}

function applyPresenceList(
  list: PresenceListItem[],
  excludeUserId: string | null | undefined,
  setCount: (n: number) => void,
  setPeers: Dispatch<SetStateAction<WelcomeBannerPeer[]>>,
  lastGoodRef: { current: number | null },
) {
  const peers = normalizePresencePeers(list, excludeUserId);
  const n = peers.length;
  lastGoodRef.current = n;
  setCount(n);
  // Тот же снимок (HTTP + socket после connect) не должен перерисовывать Home.
  setPeers((prev) => (samePeers(prev, peers) ? prev : peers));
}

export function useWelcomeOnlineCount(enabled = true, excludeUserId?: string | null) {
  const initial = getWelcomePresenceSnapshot()?.list;
  const [count, setCount] = useState<number | null>(() => Array.isArray(initial)
    ? normalizePresencePeers(initial, excludeUserId).length : null);
  const [peers, setPeers] = useState<WelcomeBannerPeer[]>(() => Array.isArray(initial)
    ? normalizePresencePeers(initial, excludeUserId) : []);
  const lastGoodRef = useRef<number | null>(count);
  const sourceRef = useRef<PresenceListItem[] | null>(Array.isArray(initial) ? initial : null);
  const excludeRef = useRef(excludeUserId);
  excludeRef.current = excludeUserId;
  const refreshRef = useRef<WelcomeOnlineRefresh | null>(null);
  const refresh = useCallback(() => refreshRef.current?.refresh() ?? Promise.resolve(), []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new WelcomeOnlineRefresh({
      load: async (signal) => {
        const request = beginWelcomePresenceRefresh();
        const response = await fetchWithTimeout(`${API_BASE}/api/presence${request.query}`, { method: 'GET', signal }, 10_000);
        if (!response.ok || signal.aborted) return null;
        const data = await response.json();
        // An old path can finish after its cancellation or after the app goes to the background.
        if (signal.aborted) return null;
        return request.apply(data);
      },
      syncSocket: refreshWelcomePresenceSnapshot,
      publish: (snapshot) => {
        if (!Array.isArray(snapshot.list)) return;
        sourceRef.current = snapshot.list;
        applyPresenceList(snapshot.list, excludeRef.current, setCount, setPeers, lastGoodRef);
      },
      shouldDefer: () => {
        // The first number must never be lost behind a temporary call/UI transition.
        if (lastGoodRef.current == null) return false;
        const at = Number((global as typeof global & { __lastOutgoingCancelAtRef?: { current: number } }).__lastOutgoingCancelAtRef?.current || 0);
        return shouldSkipHomeUiSettle() || (at > 0 && Date.now() - at < 12_000);
      },
    });
    refreshRef.current = controller;
    // Never discard a delivered snapshot during a UI transition. It is already authoritative.
    const offPresence = onWelcomePresence(data => controller.receive(data));
    void controller.refresh();
    const offConnected = onConnected(() => { void controller.refresh(true); });
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') void controller.refresh(true);
    });
    const route = DeviceEventEmitter.addListener('LiviNetRouteChanged', () => controller.networkChanged());
    let lastReachable: boolean | null = null;
    let lastType: string | null = null;
    const offNetwork = NetInfo.addEventListener(state => {
      // VPNs can block the OS internet probe while our API is reachable.
      const reachable = state.isConnected === true;
      const type = String(state.type || '');
      if (reachable && (lastReachable === false || (lastType !== null && type !== lastType))) controller.networkChanged();
      lastReachable = reachable;
      lastType = type;
    });
    return () => {
      controller.stop();
      if (refreshRef.current === controller) refreshRef.current = null;
      offPresence(); offConnected(); offNetwork(); appState.remove(); route.remove();
    };
  }, [enabled]);

  // Recompute from the complete authoritative list, so changing identity can also restore the old self.
  useEffect(() => {
    if (sourceRef.current) applyPresenceList(sourceRef.current, excludeUserId, setCount, setPeers, lastGoodRef);
  }, [excludeUserId]);

  return { onlineCount: count, peers, refreshOnlineCount: refresh };
}
