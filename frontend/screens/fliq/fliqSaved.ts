// Сохранённые ролики Fliq. Храним метаданные локально, чтобы коллекция открывалась без сети.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import type { FliqItem } from './fliqApi';

const SAVED_KEY = 'fliq_saved_v1';
const MAX_SAVED = 300;

export type SavedFliqItem = FliqItem & { savedAt: number };

type FliqSavedState = {
  items: SavedFliqItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  toggle: (item: FliqItem) => void;
  remove: (id: string) => void;
};

function validSavedItem(value: unknown): value is SavedFliqItem {
  const item = value as Partial<SavedFliqItem> | null;
  return !!item && typeof item.id === 'string' && item.id.length > 0 && item.source === 'youtube';
}

function persist(items: SavedFliqItem[]): void {
  AsyncStorage.setItem(SAVED_KEY, JSON.stringify(items)).catch(() => {});
}

export const useFliqSaved = create<FliqSavedState>((set, get) => ({
  items: [],
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(SAVED_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const items = Array.isArray(parsed) ? parsed.filter(validSavedItem).slice(0, MAX_SAVED) : [];
      set({ items, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  toggle: (item) => {
    set((state) => {
      const exists = state.items.some((saved) => saved.id === item.id);
      const items = exists
        ? state.items.filter((saved) => saved.id !== item.id)
        : [{ ...item, savedAt: Date.now() }, ...state.items].slice(0, MAX_SAVED);
      persist(items);
      return { items };
    });
  },
  remove: (id) => {
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      if (items.length === state.items.length) return state;
      persist(items);
      return { items };
    });
  },
}));
