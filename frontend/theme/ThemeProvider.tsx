import React from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MD3DarkTheme, MD3LightTheme } from 'react-native-paper';

export type ThemePreference = 'auto' | 'dark' | 'light';

const STORAGE_KEY = 'theme_preference_v1';

export const LightPalette = {
  primary: '#715BA8',
  background: 'rgba(182, 203, 216, 0.93)',
  surface: 'rgb(230, 230, 230)',
  outline: 'rgba(0,0,0,0.12)',
  onSurfaceVariant: '#4A5568',
  titan: '#3B4453',
};

export const DarkPalette = {
  primary: '#715BA8',
  background: '#151F33',
  surface: '#0D0E10',
  outline: 'rgba(255,255,255,0.12)',
  onSurfaceVariant: '#B7C0CF',
  titan: 'rgba(157, 161, 169, 1)',
};

export type AppTheme = typeof MD3DarkTheme & {
  colors: typeof MD3DarkTheme.colors & {
    outline: string;
    onSurfaceVariant: string;
    titan: string;
  };
};

function buildTheme(isDark: boolean): AppTheme {
  const base = isDark ? MD3DarkTheme : MD3LightTheme;
  const palette = isDark ? DarkPalette : LightPalette;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.primary,
      background: palette.background,
      surface: palette.surface,
      outline: palette.outline,
      onSurfaceVariant: palette.onSurfaceVariant,
      titan: palette.titan,
    },
  } as AppTheme;
}

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => Promise<void>;
  theme: AppTheme;
  isDark: boolean;
};

export const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [preference, setPref] = React.useState<ThemePreference>('auto');
  const isDark = (preference === 'auto' ? system === 'dark' : preference === 'dark') || false;
  const theme = React.useMemo(() => buildTheme(isDark), [isDark]);

  React.useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light' || saved === 'auto') setPref(saved);
      } catch {}
    })();
  }, []);

  const setPreference = React.useCallback(async (p: ThemePreference) => {
    setPref(p);
    try { await AsyncStorage.setItem(STORAGE_KEY, p); } catch {}
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, setPreference, theme, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useAppTheme must be used within ThemeProvider');
  return ctx;
}


