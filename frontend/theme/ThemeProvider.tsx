import React from 'react';
import { MD3DarkTheme } from 'react-native-paper';

/** @deprecated Light theme removed — kept only for legacy imports. */
export const LightPalette = {
  primary: '#715BA8',
  background: '#B6CBD8',
  surface: 'rgb(230, 230, 230)',
  outline: 'rgba(0,0,0,0.12)',
  onSurfaceVariant: '#4A5568',
  titan: '#3B4453',
};

export const DarkPalette = {
  primary: '#2EC4B6',
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

function buildDarkTheme(): AppTheme {
  return {
    ...MD3DarkTheme,
    colors: {
      ...MD3DarkTheme.colors,
      primary: DarkPalette.primary,
      background: DarkPalette.background,
      surface: DarkPalette.surface,
      outline: DarkPalette.outline,
      onSurfaceVariant: DarkPalette.onSurfaceVariant,
      titan: DarkPalette.titan,
    },
  } as AppTheme;
}

/** @deprecated Always `'dark'` — light/auto removed. */
export type ThemePreference = 'dark';

type ThemeContextValue = {
  /** @deprecated Always `'dark'`. */
  preference: ThemePreference;
  /** @deprecated No-op; theme is fixed to dark. */
  setPreference: (p: ThemePreference) => Promise<void>;
  theme: AppTheme;
  /** Always `true` — light theme removed. */
  isDark: true;
};

export const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

const DARK_THEME = buildDarkTheme();

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const setPreference = React.useCallback(async (_p: ThemePreference) => {}, []);
  const value = React.useMemo<ThemeContextValue>(
    () => ({
      preference: 'dark',
      setPreference,
      theme: DARK_THEME,
      isDark: true,
    }),
    [setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useAppTheme must be used within ThemeProvider');
  return ctx;
}
