// store/me.ts
import { create, StateCreator } from 'zustand';

export type Me = {
  id: string;
  nick?: string;             // ← как в БД/бэке
  avatar?: string | '';      // ← маркер наличия аватара
  avatarVer?: number;        // ← версия аватара для кеша
  avatarUrl?: string | '';   // ← deprecated, для обратной совместимости
};

export interface MeState {
  me: Me | null;
  replaceMe: (u: Me) => void;
  setMe: (patch: Partial<Me>) => void;
  reset: () => void;
}

const creator: StateCreator<MeState> = (set, get) => ({
  me: null,

  replaceMe: (u) => set({ me: u }),

  setMe: (patch) =>
    set((state) => {
      const prev = state.me;
      if (prev) {
        // не даём случайно стереть id
        const next: Me = { ...prev, ...patch, id: prev.id };
        return { me: next };
      }
      // если id ещё нет — ожидаем, что он придёт в patch
      return { me: patch as Me };
    }),

  reset: () => set({ me: null }),
});

export const useMe = create<MeState>(creator);
