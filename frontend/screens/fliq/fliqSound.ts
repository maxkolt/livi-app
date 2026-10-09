// Звук ленты Fliq — один на все ролики: выключил раз — тихо и дальше, и после перезапуска.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const MUTED_KEY = 'fliq_muted_v1';

type FliqSoundState = {
  muted: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setMuted: (muted: boolean) => void;
};

export const useFliqSound = create<FliqSoundState>((set, get) => ({
  muted: false,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(MUTED_KEY);
      set({ muted: raw === '1', hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
  setMuted: (muted) => {
    if (get().muted === muted) return;
    set({ muted });
    AsyncStorage.setItem(MUTED_KEY, muted ? '1' : '0').catch(() => {});
  },
}));
