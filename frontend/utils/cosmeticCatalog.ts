/** Каталог оформления клиента: порядок витрины, цвета, доступность и локальные ресурсы. */
export type FrameItem = {
  key: string;
  colors: readonly [string, string, ...string[]];
  kind: 'ring';
  available: boolean;
};

export type ChatBackgroundItem = {
  key: string;
  wallpaperId: string;
  source: number;
};

export const SHOWCASE_AVATAR = require('../assets/frames/showcase-avatar.jpg');

export const CHAT_BACKGROUND_CATALOG: ChatBackgroundItem[] = [
  {
    key: 'aurora-chat',
    wallpaperId: 'dark-doodles-cyan',
    source: require('../assets/chat-wallpapers/dark/doodles-cyan.jpeg'),
  },
  {
    key: 'deep-space',
    wallpaperId: 'dark-cosmos',
    source: require('../assets/chat-wallpapers/dark/cosmos.jpeg'),
  },
  {
    key: 'poetry',
    wallpaperId: 'dark-pushkin',
    source: require('../assets/chat-wallpapers/dark/pushkin.jpeg'),
  },
  {
    key: 'ocean-flow',
    wallpaperId: 'dark-doodles-teal',
    source: require('../assets/chat-wallpapers/dark/doodles-teal.jpeg'),
  },
  {
    key: 'graphite-chat',
    wallpaperId: 'dark-letters',
    source: require('../assets/chat-wallpapers/dark/letters.jpeg'),
  },
];

export const FRAME_CATALOG: FrameItem[] = [
  {
    key: 'fire',
    colors: ['#FFC062', '#FF8A34', '#FF4D1C'],
    kind: 'ring',
    available: true,
  },
  {
    key: 'diamond',
    colors: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
    kind: 'ring',
    available: true,
  },
  {
    key: 'frost',
    colors: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
    kind: 'ring',
    available: true,
  },
  {
    key: 'aurora',
    colors: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
    kind: 'ring',
    available: false,
  },
  {
    key: 'palladium',
    colors: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
    kind: 'ring',
    available: false,
  },
  {
    key: 'jade',
    colors: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
    kind: 'ring',
    available: false,
  },
  {
    key: 'void',
    colors: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
    kind: 'ring',
    available: false,
  },
  {
    key: 'obsidian',
    colors: ['#6B7280', '#374151', '#111827'],
    kind: 'ring',
    available: false,
  },
];

const FRAMES_BY_ID = new Map(FRAME_CATALOG.map((item) => [item.key, item]));
const BACKGROUNDS_BY_ID = new Map(CHAT_BACKGROUND_CATALOG.map((item) => [item.key, item]));

export function getCosmeticFrame(itemId: string): FrameItem | undefined {
  return FRAMES_BY_ID.get(itemId);
}

export function getCosmeticBackground(itemId: string): ChatBackgroundItem | undefined {
  return BACKGROUNDS_BY_ID.get(itemId);
}

export function isLiveCosmeticFrame(itemId: string): itemId is 'fire' | 'frost' | 'diamond' {
  return itemId === 'fire' || itemId === 'frost' || itemId === 'diamond';
}
