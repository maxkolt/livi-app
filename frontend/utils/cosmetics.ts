import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DeviceEventEmitter } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
// Импортируем из листовых модулей, а не из бареля sockets/socket: барель
// реэкспортирует presence.ts, который сам подписывается на cosmetics:frame и
// зовёт этот файл. Через барель получался цикл, и при инициализации значения
// могли оказаться неопределёнными.
import { API_BASE } from '../sockets/modules/constants';
import { getCurrentUserId } from '../sockets/modules/authState';
import { getInstallAuthHeaders } from './installId';
import { fetchWithTimeout } from './fetchWithTimeout';
import { getCosmeticBackground } from './cosmeticCatalog';
import { DEFAULT_DARK_WALLPAPER_ID, setChatWallpaperId } from './chatWallpaper';
import { UserFrameRefresh } from './userFrameRefresh';
import { restoreHttpInstallAuth } from './restoreHttpInstallAuth';

export type CosmeticKind = 'frame' | 'background';

type CosmeticEntitlements = {
  purchasedFrameIds: string[];
  purchasedBackgroundIds: string[];
  activeFrameId: string;
  activeBackgroundId: string;
};

type CosmeticResponse = Record<string, unknown> & {
  ok?: boolean;
  error?: string;
  entitlements?: Partial<CosmeticEntitlements>;
};

const EMPTY: CosmeticEntitlements = {
  purchasedFrameIds: [],
  purchasedBackgroundIds: [],
  activeFrameId: '',
  activeBackgroundId: '',
};

function cosmeticKeySuffix(itemId: string): string {
  return itemId
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** i18n-ключ названия рамки или фона: 'aurora-chat' → 'cosmeticNameAuroraChat'. */
export function cosmeticNameKey(itemId: string): string {
  return `cosmeticName${cosmeticKeySuffix(itemId)}`;
}

/** i18n-ключ описания рамки или фона. */
export function cosmeticBlurbKey(itemId: string): string {
  return `cosmeticBlurb${cosmeticKeySuffix(itemId)}`;
}

export function cosmeticBackgroundToWallpaperId(itemId: string): string {
  return getCosmeticBackground(itemId)?.wallpaperId || DEFAULT_DARK_WALLPAPER_ID;
}

let cached: CosmeticEntitlements = EMPTY;
let loadPromise: Promise<CosmeticEntitlements> | null = null;
let entitlementRevision = 0;
let activeWrites = 0;
let loadSequence = 0;
let writeTail: Promise<unknown> = Promise.resolve();
const listeners = new Set<(value: CosmeticEntitlements) => void>();
const userFrameCache = new Map<string, { frameId: string; loadedAt: number }>();
const userFrameListeners = new Map<string, Set<(frameId: string) => void>>();
const userFrameRefreshers = new Map<string, UserFrameRefresh>();
let stopFrameNetworkWatch: (() => void) | null = null;

/** Socket reconnect heals missed frame events even when the avatar stays mounted. */
export function refreshObservedUserFrames(): void {
  userFrameRefreshers.forEach(refresh => { void refresh.refresh(true); });
}

function watchFrameNetwork(): void {
  if (stopFrameNetworkWatch) return;
  const appState = AppState.addEventListener('change', state => {
    if (state === 'active') refreshObservedUserFrames();
  });
  const routeChanged = () => userFrameRefreshers.forEach(refresh => refresh.networkChanged());
  const route = DeviceEventEmitter.addListener('LiviNetRouteChanged', routeChanged);
  let lastConnected: boolean | null = null;
  let lastType: string | null = null;
  const offNetwork = NetInfo.addEventListener(state => {
    const connected = state.isConnected === true;
    const type = String(state.type || '');
    // A VPN may block the OS reachability probe while the API still works.
    if (connected && (lastConnected === false || (lastType !== null && lastType !== type))) routeChanged();
    lastConnected = connected;
    lastType = type;
  });
  stopFrameNetworkWatch = () => {
    appState.remove(); route.remove(); offNetwork(); stopFrameNetworkWatch = null;
  };
}

function observeUserFrame(id: string): void {
  let refresh = userFrameRefreshers.get(id);
  if (!refresh) {
    refresh = new UserFrameRefresh({
      load: async (signal, force) => {
        const known = userFrameCache.get(id);
        if (!force && known && Date.now() - known.loadedAt < 5 * 60_000) return null;
        const json = await request(`/cosmetics/user/${encodeURIComponent(id)}`, { signal });
        if (typeof json.activeFrameId !== 'string') throw new Error('invalid_frame_response');
        return json.activeFrameId;
      },
      publish: frame => applyRemoteFrameChange(id, frame),
    });
    userFrameRefreshers.set(id, refresh);
    watchFrameNetwork();
  }
  void refresh.refresh();
}

function stopObservingUserFrame(id: string): void {
  if (userFrameListeners.get(id)?.size) return;
  userFrameRefreshers.get(id)?.stop();
  userFrameRefreshers.delete(id);
  if (!userFrameRefreshers.size) stopFrameNetworkWatch?.();
}

/**
 * Рамки с прошлого запуска. Без них до ответа сервера аватары рисовались без
 * рамки, а через секунду-две перестраивались — рамка «догоняла» фото.
 */
const STORAGE_KEY = 'livi_cosmetics_v1';
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
const hydrateListeners = new Set<() => void>();
let persistedOwnId = '';
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const frames: Record<string, string> = {};
    userFrameCache.forEach((value, userId) => {
      frames[userId] = value.frameId;
    });
    const payload = {
      ownId: String(getCurrentUserId() || '') || persistedOwnId,
      own: cached,
      frames,
    };
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload)).catch(() => {});
  }, 400);
}

function notifyUserFrame(userId: string, frameId: string) {
  userFrameListeners.get(userId)?.forEach((listener) => listener(frameId));
}

/** Свои рамки: до первого ответа сервера — значение с диска из userFrameCache. */
function ownFrameId(userId: string): string {
  return cached !== EMPTY ? cached.activeFrameId : userFrameCache.get(userId)?.frameId || '';
}

function hydrateCosmetics(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        ownId?: string;
        own?: Partial<CosmeticEntitlements>;
        frames?: Record<string, string>;
      };
      const ownId = String(saved?.ownId || '');
      persistedOwnId = ownId;
      const currentId = String(getCurrentUserId() || '');
      const sameAccount = !!ownId && (!currentId || currentId === ownId);
      // Свежие данные из сети, пришедшие раньше диска, не перетираем (loadedAt 0 → сеть всё равно обновит).
      Object.entries(saved?.frames || {}).forEach(([userId, frameId]) => {
        if (!userId || userFrameCache.has(userId)) return;
        if (userId === ownId && !sameAccount) return;
        const value = String(frameId || '');
        userFrameCache.set(userId, { frameId: value, loadedAt: 0 });
        notifyUserFrame(userId, value);
      });
      if (sameAccount && cached === EMPTY && saved?.own) {
        cached = normalize(saved.own);
        listeners.forEach((listener) => listener(cached));
        notifyUserFrame(ownId, cached.activeFrameId);
      }
    })
    .catch(() => {})
    .finally(() => {
      hydrated = true;
      hydrateListeners.forEach((listener) => listener());
      hydrateListeners.clear();
    });
  return hydratePromise;
}

void hydrateCosmetics();

/** true, когда рамки с прошлого запуска уже подняты с диска (или их нет). */
export function useCosmeticsHydrated(): boolean {
  const [value, setValue] = useState(hydrated);
  useEffect(() => {
    if (hydrated) {
      setValue(true);
      return;
    }
    const listener = () => setValue(true);
    hydrateListeners.add(listener);
    return () => {
      hydrateListeners.delete(listener);
    };
  }, []);
  return value;
}

function normalize(value: Partial<CosmeticEntitlements> | null | undefined): CosmeticEntitlements {
  return {
    purchasedFrameIds: Array.isArray(value?.purchasedFrameIds) ? value!.purchasedFrameIds!.map(String) : [],
    purchasedBackgroundIds: Array.isArray(value?.purchasedBackgroundIds)
      ? value!.purchasedBackgroundIds!.map(String)
      : [],
    activeFrameId: String(value?.activeFrameId || ''),
    activeBackgroundId: String(value?.activeBackgroundId || ''),
  };
}

async function syncWallpaper(value: CosmeticEntitlements) {
  const wallpaperId = cosmeticBackgroundToWallpaperId(value.activeBackgroundId);
  await setChatWallpaperId('dark', wallpaperId);
}

function publish(value: Partial<CosmeticEntitlements> | null | undefined) {
  cached = normalize(value);
  const ownId = String(getCurrentUserId() || '');
  if (ownId) {
    userFrameCache.set(ownId, { frameId: cached.activeFrameId, loadedAt: Date.now() });
    userFrameListeners.get(ownId)?.forEach((listener) => listener(cached.activeFrameId));
  }
  listeners.forEach((listener) => listener(cached));
  schedulePersist();
  void syncWallpaper(cached);
  return cached;
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(await getInstallAuthHeaders()),
  };
}

async function request(path: string, init?: RequestInit, mayRestoreAuth = true): Promise<CosmeticResponse> {
  const response = await fetchWithTimeout(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      ...(await authHeaders(!!init?.body)),
      ...(init?.headers || {}),
    },
  });
  const json: CosmeticResponse = await response.json().catch(() => ({}));
  if (response.status === 401 && mayRestoreAuth && !init?.signal?.aborted && await restoreHttpInstallAuth()) {
    return request(path, init, false);
  }
  if (!response.ok || !json?.ok) throw new Error(String(json?.error || `http_${response.status}`));
  return json;
}

export async function loadCosmetics(force = false): Promise<CosmeticEntitlements> {
  if (loadPromise && !force) return loadPromise;
  const revision = entitlementRevision;
  const sequence = ++loadSequence;
  const pending = request('/cosmetics/me')
    .then((json) => {
      // A read started before/during a change cannot undo that change.
      if (activeWrites || revision !== entitlementRevision || sequence !== loadSequence) return cached;
      return publish(json.entitlements);
    })
    .finally(() => {
      if (loadPromise === pending) loadPromise = null;
    });
  loadPromise = pending;
  return pending;
}

export async function createCosmeticPayment(kind: CosmeticKind, itemId: string) {
  const json = await request('/cosmetics/payments', {
    method: 'POST',
    body: JSON.stringify({ kind, itemId }),
  });
  if (json.entitlements) publish(json.entitlements);
  return json as {
    ok: true;
    alreadyOwned?: boolean;
    paymentId?: string;
    confirmationUrl?: string;
    status?: string;
    entitlements?: CosmeticEntitlements;
  };
}

export async function checkCosmeticPayment(paymentId: string) {
  const json = await request(`/cosmetics/payments/${encodeURIComponent(paymentId)}`);
  if (json.entitlements) publish(json.entitlements);
  return json as { ok: true; status: string; entitlements?: CosmeticEntitlements };
}

export async function setActiveCosmetic(kind: CosmeticKind, itemId: string) {
  entitlementRevision += 1;
  activeWrites += 1;
  // Both settings share one server snapshot. Serialize writes so a late frame
  // response cannot restore a background removed by the next action (or vice versa).
  const pending = writeTail.then(async () => {
    const json = await request('/cosmetics/active', {
      method: 'PATCH',
      body: JSON.stringify({ kind, itemId }),
    });
    return publish(json.entitlements);
  }).finally(() => {
    activeWrites -= 1;
    entitlementRevision += 1;
  });
  writeTail = pending.catch(() => {});
  return pending;
}

export function useCosmetics(): CosmeticEntitlements {
  const [value, setValue] = useState(cached);
  useEffect(() => {
    let alive = true;
    const listener = (next: CosmeticEntitlements) => {
      if (alive) setValue(next);
    };
    listeners.add(listener);
    void loadCosmetics().catch(() => {});
    return () => {
      alive = false;
      listeners.delete(listener);
    };
  }, []);
  return value;
}

/**
 * Применить рамку, пришедшую пушем по сокету.
 *
 * Без этого друзья видели новую рамку только после протухания пятиминутного
 * кеша И перемонтирования компонента — то есть на практике после перезапуска
 * приложения. Сервер шлёт `cosmetics:frame` сразу при смене, здесь мы освежаем
 * кеш и будим всех подписчиков этого userId.
 */
export function applyRemoteFrameChange(userId: string, frameId: string): void {
  const id = String(userId || '');
  if (!id) return;
  const next = String(frameId || '');
  const current = userFrameCache.get(id);
  userFrameCache.set(id, { frameId: next, loadedAt: Date.now() });
  userFrameRefreshers.get(id)?.received();
  if (String(getCurrentUserId() || '') === id) {
    entitlementRevision += 1;
    cached = { ...cached, activeFrameId: next };
    listeners.forEach((listener) => listener(cached));
  }
  schedulePersist();
  if (current?.frameId === next) return;
  userFrameListeners.get(id)?.forEach((listener) => listener(next));
}

/** Активная рамка любого пользователя; запрос кешируется, чтобы списки не дёргали API повторно. */
export function useUserActiveFrame(userId?: string): string {
  const id = String(userId || '');
  const ownId = String(getCurrentUserId() || '');
  const initial = id && id === ownId ? ownFrameId(id) : userFrameCache.get(id)?.frameId || '';
  const [frame, setFrame] = useState({ id, frameId: initial });

  useEffect(() => {
    if (!id) {
      setFrame({ id, frameId: '' });
      return;
    }
    let group = userFrameListeners.get(id);
    if (!group) {
      group = new Set();
      userFrameListeners.set(id, group);
    }
    const setFrameId = (frameId: string) => setFrame({ id, frameId });
    group.add(setFrameId);
    if (id === String(getCurrentUserId() || '')) {
      setFrameId(ownFrameId(id));
      void loadCosmetics().catch(() => {});
    } else {
      const known = userFrameCache.get(id);
      setFrameId(known?.frameId || '');
      observeUserFrame(id);
    }
    return () => {
      const listenersForId = userFrameListeners.get(id);
      listenersForId?.delete(setFrameId);
      if (listenersForId?.size === 0) userFrameListeners.delete(id);
      stopObservingUserFrame(id);
    };
  }, [id, ownId]);

  return frame.id === id ? frame.frameId : initial;
}
