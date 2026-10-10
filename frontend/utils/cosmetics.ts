import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
// Импортируем из листовых модулей, а не из бареля sockets/socket: барель
// реэкспортирует presence.ts, который сам подписывается на cosmetics:frame и
// зовёт этот файл. Через барель получался цикл, и при инициализации значения
// могли оказаться неопределёнными.
import { API_BASE } from '../sockets/modules/constants';
import { getCurrentUserId } from '../sockets/modules/authState';
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
  return BACKGROUND_TO_WALLPAPER[itemId] || DEFAULT_DARK_WALLPAPER_ID;
}

let cached: CosmeticEntitlements = EMPTY;
let loadPromise: Promise<CosmeticEntitlements> | null = null;
const listeners = new Set<(value: CosmeticEntitlements) => void>();
const userFrameCache = new Map<string, { frameId: string; loadedAt: number }>();
const userFrameListeners = new Map<string, Set<(frameId: string) => void>>();

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

export function hydrateCosmetics(): Promise<void> {
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
  if (String(getCurrentUserId() || '') === id) {
    cached = { ...cached, activeFrameId: next };
    listeners.forEach((listener) => listener(cached));
  }
  schedulePersist();
  if (current?.frameId === next) return;
  userFrameListeners.get(id)?.forEach((listener) => listener(next));
}

async function loadUserActiveFrame(userId: string): Promise<string> {
  const cachedFrame = userFrameCache.get(userId);
  if (cachedFrame && Date.now() - cachedFrame.loadedAt < 5 * 60_000) return cachedFrame.frameId;
  const json = await request(`/cosmetics/user/${encodeURIComponent(userId)}`);
  const frameId = String(json.activeFrameId || '');
  userFrameCache.set(userId, { frameId, loadedAt: Date.now() });
  userFrameListeners.get(userId)?.forEach((listener) => listener(frameId));
  schedulePersist();
  return frameId;
}

/** Активная рамка любого пользователя; запрос кешируется, чтобы списки не дёргали API повторно. */
export function useUserActiveFrame(userId?: string): string {
  const id = String(userId || '');
  const ownId = String(getCurrentUserId() || '');
  const initial = id && id === ownId ? ownFrameId(id) : userFrameCache.get(id)?.frameId || '';
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
      setFrameId(ownFrameId(id));
      void loadCosmetics().catch(() => {});
    } else {
      const known = userFrameCache.get(id);
      if (known) setFrameId(known.frameId);
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
