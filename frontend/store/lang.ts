// store/lang.ts
import { create, StateCreator } from 'zustand';
import type { Lang } from '../utils/i18n';
import { defaultLang, getSystemLang, loadLang, saveLang, setLangModeSystem } from '../utils/i18n';

export interface LangState {
  lang: Lang;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setLang: (lang: Lang) => Promise<void>;
  setSystemLang: () => Promise<void>;
}

const creator: StateCreator<LangState> = (set, get) => ({
  lang: defaultLang,
  hydrated: false,

  hydrate: async () => {
    try {
      const stored = await loadLang();
      set({ lang: stored, hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },

  setLang: async (lang) => {
    // обновляем UI сразу
    set({ lang });
    try {
      await saveLang(lang);
    } catch {}
  },

  setSystemLang: async () => {
    const sys = getSystemLang();
    set({ lang: sys });
    try {
      await setLangModeSystem();
    } catch {}
  },
});

export const useLang = create<LangState>(creator);

