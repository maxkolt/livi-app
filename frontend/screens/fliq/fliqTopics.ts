// Темы ленты Fliq, которые выбрал пользователь, и признак «выбор тем уже показывали».
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

export const FLIQ_TOPICS = [
  'humor',
  'animals',
  'music',
  'sport',
  'games',
  'food',
  'science',
  'travel',
  'cars',
  'art',
  'technology',
  'politics',
  'history',
  'fishing',
  'hunting',
  'fitness',
  'fashion',
  'movies',
  'business',
  'nature',
] as const;
export type FliqTopic = (typeof FLIQ_TOPICS)[number];

const TOPICS_KEY = 'fliq_topics_v1';

type FliqTopicsState = {
  /** Пусто — все темы. */
  topics: FliqTopic[];
  /** Пользователь уже видел выбор тем (выбрал или нажал «Все темы»). */
  onboarded: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setTopics: (topics: FliqTopic[]) => void;
};

export const useFliqTopics = create<FliqTopicsState>((set, get) => ({
  topics: [],
  onboarded: false,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(TOPICS_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      const known = new Set<string>(FLIQ_TOPICS);
      const topics = Array.isArray(saved?.topics)
        ? (saved.topics as string[]).filter((t) => known.has(t)) as FliqTopic[]
        : [];
      set({ topics, onboarded: !!saved, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  setTopics: (topics) => {
    set({ topics, onboarded: true });
    AsyncStorage.setItem(TOPICS_KEY, JSON.stringify({ topics })).catch(() => {});
  },
}));
