import React, { createContext, useContext, useMemo } from 'react';
import { useSafeAreaFrame } from 'react-native-safe-area-context';

export type HomeLayoutSize = { width: number; height: number };

const HomeLayoutContext = createContext<HomeLayoutSize | null>(null);

/**
 * Единственный источник размеров для экранов Home.
 *
 * Раньше ориентацию брали из `useSafeAreaFrame`, а размеры — из `onLayout`.
 * Эти два источника обновляются в разных кадрах: при повороте и при выходе из
 * сна frame ещё сообщает портрет, когда view уже разложился в landscape. За
 * счёт этого раскладка проходила через несколько несогласованных состояний —
 * визуально «съезжала и восстанавливалась».
 *
 * Провайдер меряет корневой контейнер Home один раз, и все потребители
 * пересчитываются в одном и том же кадре.
 */
export function HomeLayoutProvider({
  size,
  children,
}: {
  size: HomeLayoutSize;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ width: size.width, height: size.height }),
    [size.width, size.height],
  );
  return <HomeLayoutContext.Provider value={value}>{children}</HomeLayoutContext.Provider>;
}

/**
 * Размер корня Home. Вне провайдера (и до первого замера) отдаёт safe-area
 * frame — он корректен, просто может запаздывать на кадр при ресайзе.
 */
export function useHomeLayout(): HomeLayoutSize {
  const ctx = useContext(HomeLayoutContext);
  const frame = useSafeAreaFrame();
  if (ctx && ctx.width > 0 && ctx.height > 0) return ctx;
  return frame;
}
