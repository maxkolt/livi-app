/**
 * Локальный выбор обоев чата (тёмная тема).
 * lightId в storage оставлен для совместимости со старыми prefs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ImageSourcePropType } from 'react-native';

const STORAGE_KEY = 'livi.chatWallpaper.v1';

export type ChatWallpaperTheme = 'light' | 'dark';

type ChatWallpaperItem = {
  id: string;
  source: ImageSourcePropType;
};

/** Текущие штатные обои — остаются дефолтом. */
const DEFAULT_LIGHT_WALLPAPER_ID = 'light-default';
export const DEFAULT_DARK_WALLPAPER_ID = 'dark-default';

/** Светлая тема: класть новые JPEG в `assets/chat-wallpapers/light/`. */
const CHAT_WALLPAPERS_LIGHT: ChatWallpaperItem[] = [
  {
    id: DEFAULT_LIGHT_WALLPAPER_ID,
    source: require('../assets/chat-wallpapers/light/default.jpeg'),
  },
  {
    id: 'light-doodles-soft',
    source: require('../assets/chat-wallpapers/light/doodles-soft.jpeg'),
  },
  {
    id: 'light-math',
    source: require('../assets/chat-wallpapers/light/math.jpeg'),
  },
  {
    id: 'light-rpg',
    source: require('../assets/chat-wallpapers/light/rpg.jpeg'),
  },
  {
    id: 'light-doodles-bw',
    source: require('../assets/chat-wallpapers/light/doodles-bw.jpeg'),
  },
  {
    id: 'light-love',
    source: require('../assets/chat-wallpapers/light/love.jpeg'),
  },
  {
    id: 'light-school',
    source: require('../assets/chat-wallpapers/light/school.jpeg'),
  },
  {
    id: 'light-doodles-teal',
    source: require('../assets/chat-wallpapers/light/doodles-teal.jpeg'),
  },
  {
    id: 'light-doodles-bw-2',
    source: require('../assets/chat-wallpapers/light/doodles-bw-2.jpeg'),
  },
  {
    id: 'light-zoo',
    source: require('../assets/chat-wallpapers/light/zoo.jpeg'),
  },
  {
    id: 'light-doodles-cyan',
    source: require('../assets/chat-wallpapers/light/doodles-cyan.jpeg'),
  },
  {
    id: 'light-office',
    source: require('../assets/chat-wallpapers/light/office.jpeg'),
  },
  {
    id: 'light-doodles-mint',
    source: require('../assets/chat-wallpapers/light/doodles-mint.jpeg'),
  },
];

/** Тёмная тема: класть новые JPEG в `assets/chat-wallpapers/dark/`. */
const CHAT_WALLPAPERS_DARK: ChatWallpaperItem[] = [
  {
    id: DEFAULT_DARK_WALLPAPER_ID,
    source: require('../assets/chat-wallpapers/dark/default.jpeg'),
  },
  {
    id: 'dark-pushkin',
    source: require('../assets/chat-wallpapers/dark/pushkin.jpeg'),
  },
  {
    id: 'dark-texture-navy',
    source: require('../assets/chat-wallpapers/dark/texture-navy.jpeg'),
  },
  {
    id: 'dark-cosmos',
    source: require('../assets/chat-wallpapers/dark/cosmos.jpeg'),
  },
  {
    id: 'dark-doodles-cyan',
    source: require('../assets/chat-wallpapers/dark/doodles-cyan.jpeg'),
  },
  {
    id: 'dark-linen-blue',
    source: require('../assets/chat-wallpapers/dark/linen-blue.jpeg'),
  },
  {
    id: 'dark-nowhere',
    source: require('../assets/chat-wallpapers/dark/nowhere.jpeg'),
  },
  {
    id: 'dark-letters',
    source: require('../assets/chat-wallpapers/dark/letters.jpeg'),
  },
  {
    id: 'dark-doodles-soft',
    source: require('../assets/chat-wallpapers/dark/doodles-soft.jpeg'),
  },
  {
    id: 'dark-doodles-teal',
    source: require('../assets/chat-wallpapers/dark/doodles-teal.jpeg'),
  },
  {
    id: 'dark-fingerprint',
    source: require('../assets/chat-wallpapers/dark/fingerprint.jpeg'),
  },
  {
    id: 'dark-doodles-bw',
    source: require('../assets/chat-wallpapers/dark/doodles-bw.jpeg'),
  },
];

const ALL_WALLPAPERS: ChatWallpaperItem[] = [
  ...CHAT_WALLPAPERS_LIGHT,
  ...CHAT_WALLPAPERS_DARK,
];

type ChatWallpaperPrefs = {
  lightId: string;
  darkId: string;
};

const DEFAULT_CHAT_WALLPAPER_PREFS: ChatWallpaperPrefs = {
  lightId: DEFAULT_LIGHT_WALLPAPER_ID,
  darkId: DEFAULT_DARK_WALLPAPER_ID,
};

const listeners = new Set<(prefs: ChatWallpaperPrefs) => void>();
let cachedPrefs: ChatWallpaperPrefs = { ...DEFAULT_CHAT_WALLPAPER_PREFS };

function isKnownId(id: string, theme?: ChatWallpaperTheme): boolean {
  const list =
    theme === 'light'
      ? CHAT_WALLPAPERS_LIGHT
      : theme === 'dark'
        ? CHAT_WALLPAPERS_DARK
        : ALL_WALLPAPERS;
  return list.some((item) => item.id === id);
}

function normalizePrefs(raw: Partial<ChatWallpaperPrefs> | null | undefined): ChatWallpaperPrefs {
  const lightId =
    raw?.lightId && isKnownId(raw.lightId, 'light')
      ? raw.lightId
      : DEFAULT_LIGHT_WALLPAPER_ID;
  const darkId =
    raw?.darkId && isKnownId(raw.darkId, 'dark')
      ? raw.darkId
      : DEFAULT_DARK_WALLPAPER_ID;
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

function getChatWallpaperCatalog(theme: ChatWallpaperTheme): ChatWallpaperItem[] {
  return theme === 'dark' ? CHAT_WALLPAPERS_DARK : CHAT_WALLPAPERS_LIGHT;
}

export function getChatWallpaperById(
  id: string | null | undefined,
  theme?: ChatWallpaperTheme,
): ChatWallpaperItem {
  const list = theme ? getChatWallpaperCatalog(theme) : ALL_WALLPAPERS;
  const found = list.find((item) => item.id === id) ?? ALL_WALLPAPERS.find((item) => item.id === id);
  if (found) return found;
  return theme === 'dark' ? CHAT_WALLPAPERS_DARK[0]! : CHAT_WALLPAPERS_LIGHT[0]!;
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

