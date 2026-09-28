// store/lang.ts
import { NativeModules, Platform } from 'react-native';
import { create, StateCreator } from 'zustand';
import type { Lang } from '../utils/i18n';
import { defaultLang, getSystemLang, loadLang, saveLang, setLangModeSystem } from '../utils/i18n';

/**
 * Нативные экраны звонка и уведомления показываются и без JS (FCM в убитом
 * процессе), поэтому фактический язык UI сохраняем в нативные prefs.
 */
function syncNativeLang(lang: Lang) {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LiviAppModule?.setAppLanguage?.(lang);
  } catch {}
}

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
      syncNativeLang(stored);
    } catch {
      set({ hydrated: true });
    }
  },

  setLang: async (lang) => {
    // обновляем UI сразу
    set({ lang });
    syncNativeLang(lang);
    try {
      await saveLang(lang);
    } catch {}
  },

  setSystemLang: async () => {
    const sys = getSystemLang();
    set({ lang: sys });
    syncNativeLang(sys);
    try {
      await setLangModeSystem();
    } catch {}
  },
});

export const useLang = create<LangState>(creator);
