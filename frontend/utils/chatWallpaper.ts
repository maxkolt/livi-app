/**
 * Локальный выбор обоев чата (светлая / тёмная тема).
 * Меняется только id картинки — overlays/параллакс в ChatParallaxWallpaper без изменений.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ImageSourcePropType } from 'react-native';

const STORAGE_KEY = 'livi.chatWallpaper.v1';

export type ChatWallpaperTheme = 'light' | 'dark';

export type ChatWallpaperItem = {
  id: string;
  source: ImageSourcePropType;
};

/** Текущие штатные обои — остаются дефолтом. */
export const DEFAULT_LIGHT_WALLPAPER_ID = 'light-default';
export const DEFAULT_DARK_WALLPAPER_ID = 'dark-default';

/**
 * Каталог. Пока в assets две картинки — обе доступны в каждом пикере,
 * чтобы слайдер было чем листать; дефолты совпадают с текущим поведением чата.
 * Новые фоны добавлять сюда же.
 */
export const CHAT_WALLPAPER_CATALOG: ChatWallpaperItem[] = [
  {
    id: DEFAULT_LIGHT_WALLPAPER_ID,
    source: require('../assets/chat-wallpaper-light.jpeg'),
  },
  {
    id: DEFAULT_DARK_WALLPAPER_ID,
    source: require('../assets/chat-wallpaper-dark.jpeg'),
  },
];

export type ChatWallpaperPrefs = {
  lightId: string;
  darkId: string;
};

export const DEFAULT_CHAT_WALLPAPER_PREFS: ChatWallpaperPrefs = {
  lightId: DEFAULT_LIGHT_WALLPAPER_ID,
  darkId: DEFAULT_DARK_WALLPAPER_ID,
};

const listeners = new Set<(prefs: ChatWallpaperPrefs) => void>();
let cachedPrefs: ChatWallpaperPrefs = { ...DEFAULT_CHAT_WALLPAPER_PREFS };
let loadPromise: Promise<ChatWallpaperPrefs> | null = null;

function isKnownId(id: string): boolean {
  return CHAT_WALLPAPER_CATALOG.some((item) => item.id === id);
}

function normalizePrefs(raw: Partial<ChatWallpaperPrefs> | null | undefined): ChatWallpaperPrefs {
  const lightId =
    raw?.lightId && isKnownId(raw.lightId) ? raw.lightId : DEFAULT_LIGHT_WALLPAPER_ID;
  const darkId =
    raw?.darkId && isKnownId(raw.darkId) ? raw.darkId : DEFAULT_DARK_WALLPAPER_ID;
  return { lightId, darkId };
}

function notify(prefs: ChatWallpaperPrefs) {
  cachedPrefs = prefs;
  listeners.forEach((fn) => {
    try {
      fn(prefs);
    } catch {
      /* ignore */
    }
  });
}

export function getChatWallpaperCatalog(_theme: ChatWallpaperTheme): ChatWallpaperItem[] {
  return CHAT_WALLPAPER_CATALOG;
}

export function getChatWallpaperById(id: string | null | undefined): ChatWallpaperItem {
  const found = CHAT_WALLPAPER_CATALOG.find((item) => item.id === id);
  return found ?? CHAT_WALLPAPER_CATALOG[0]!;
}

export function getChatWallpaperSource(
  isDark: boolean,
  prefs: ChatWallpaperPrefs = cachedPrefs,
): ImageSourcePropType {
  const id = isDark ? prefs.darkId : prefs.lightId;
  return getChatWallpaperById(id).source;
}

export function getCachedChatWallpaperPrefs(): ChatWallpaperPrefs {
  return cachedPrefs;
}

export async function loadChatWallpaperPrefs(): Promise<ChatWallpaperPrefs> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) {
        notify(DEFAULT_CHAT_WALLPAPER_PREFS);
        return cachedPrefs;
      }
      const parsed = JSON.parse(raw) as Partial<ChatWallpaperPrefs>;
      notify(normalizePrefs(parsed));
      return cachedPrefs;
    } catch {
      notify(DEFAULT_CHAT_WALLPAPER_PREFS);
      return cachedPrefs;
    }
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

export async function setChatWallpaperId(
  theme: ChatWallpaperTheme,
  id: string,
): Promise<ChatWallpaperPrefs> {
  const next = normalizePrefs({
    ...cachedPrefs,
    ...(theme === 'light' ? { lightId: id } : { darkId: id }),
  });
  notify(next);
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* keep in-memory */
  }
  return next;
}

export function subscribeChatWallpaperPrefs(
  listener: (prefs: ChatWallpaperPrefs) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Реактивные prefs для чата / пикера. */
export function useChatWallpaperPrefs(): ChatWallpaperPrefs {
  const [prefs, setPrefs] = useState<ChatWallpaperPrefs>(cachedPrefs);

  useEffect(() => {
    let mounted = true;
    void loadChatWallpaperPrefs().then((p) => {
      if (mounted) setPrefs(p);
    });
    const unsub = subscribeChatWallpaperPrefs((p) => {
      if (mounted) setPrefs(p);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  return prefs;
}
