import { useEffect, useState } from 'react';
import { API_BASE, getCurrentUserId } from '../sockets/socket';
import { getInstallId } from './installId';
import { DEFAULT_DARK_WALLPAPER_ID, setChatWallpaperId } from './chatWallpaper';

export type CosmeticKind = 'frame' | 'background';

export type CosmeticEntitlements = {
  purchasedFrameIds: string[];
  purchasedBackgroundIds: string[];
  activeFrameId: string;
  activeBackgroundId: string;
};

const EMPTY: CosmeticEntitlements = {
  purchasedFrameIds: [],
  purchasedBackgroundIds: [],
  activeFrameId: '',
  activeBackgroundId: '',
};

const BACKGROUND_TO_WALLPAPER: Record<string, string> = {
  'aurora-chat': 'dark-doodles-cyan',
  'deep-space': 'dark-cosmos',
  poetry: 'dark-pushkin',
  'ocean-flow': 'dark-doodles-teal',
  'graphite-chat': 'dark-letters',
};

export function cosmeticBackgroundToWallpaperId(itemId: string): string {
  return BACKGROUND_TO_WALLPAPER[itemId] || DEFAULT_DARK_WALLPAPER_ID;
}

let cached: CosmeticEntitlements = EMPTY;
let loadPromise: Promise<CosmeticEntitlements> | null = null;
const listeners = new Set<(value: CosmeticEntitlements) => void>();
const userFrameCache = new Map<string, { frameId: string; loadedAt: number }>();
const userFrameListeners = new Map<string, Set<(frameId: string) => void>>();

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
  void syncWallpaper(cached);
  return cached;
}

async function authHeaders(json = false): Promise<Record<string, string>> {
  const installId = await getInstallId();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'x-install-id': installId,
  };
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      ...(await authHeaders(!!init?.body)),
      ...(init?.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json?.ok) throw new Error(String(json?.error || `http_${response.status}`));
  return json;
}

export function getCachedCosmetics(): CosmeticEntitlements {
  return cached;
}

export async function loadCosmetics(force = false): Promise<CosmeticEntitlements> {
  if (loadPromise && !force) return loadPromise;
  loadPromise = request('/cosmetics/me')
    .then((json) => publish(json.entitlements))
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
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
  const json = await request('/cosmetics/active', {
    method: 'PATCH',
    body: JSON.stringify({ kind, itemId }),
  });
  return publish(json.entitlements);
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

async function loadUserActiveFrame(userId: string): Promise<string> {
  const cachedFrame = userFrameCache.get(userId);
  if (cachedFrame && Date.now() - cachedFrame.loadedAt < 5 * 60_000) return cachedFrame.frameId;
  const json = await request(`/cosmetics/user/${encodeURIComponent(userId)}`);
  const frameId = String(json.activeFrameId || '');
  userFrameCache.set(userId, { frameId, loadedAt: Date.now() });
  userFrameListeners.get(userId)?.forEach((listener) => listener(frameId));
  return frameId;
}

/** Активная рамка любого пользователя; запрос кешируется, чтобы списки не дёргали API повторно. */
export function useUserActiveFrame(userId?: string): string {
  const id = String(userId || '');
  const ownId = String(getCurrentUserId() || '');
  const initial = id && id === ownId ? cached.activeFrameId : userFrameCache.get(id)?.frameId || '';
  const [frameId, setFrameId] = useState(initial);

  useEffect(() => {
    if (!id) {
      setFrameId('');
      return;
    }
    let group = userFrameListeners.get(id);
    if (!group) {
      group = new Set();
      userFrameListeners.set(id, group);
    }
    group.add(setFrameId);
    if (id === String(getCurrentUserId() || '')) {
      setFrameId(cached.activeFrameId);
      void loadCosmetics().catch(() => {});
    } else {
      void loadUserActiveFrame(id).then(setFrameId).catch(() => {});
    }
    return () => {
      const listenersForId = userFrameListeners.get(id);
      listenersForId?.delete(setFrameId);
      if (listenersForId?.size === 0) userFrameListeners.delete(id);
    };
  }, [id]);

  return frameId;
}
