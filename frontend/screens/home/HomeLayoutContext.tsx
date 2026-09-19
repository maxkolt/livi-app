import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useSafeAreaFrame } from 'react-native-safe-area-context';

export type HomeLayoutSize = { width: number; height: number };

const HomeLayoutContext = createContext<HomeLayoutSize | null>(null);
const HomeLayoutActivityContext = createContext<(() => void) | null>(null);

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
  onLayoutActivity,
  children,
}: {
  size: HomeLayoutSize;
  /** Любой вложенный onLayout во время ресайза — раскладка ещё «едет». */
  onLayoutActivity?: () => void;
  children: React.ReactNode;
}) {
  const value = useMemo(
    () => ({ width: size.width, height: size.height }),
    [size.width, size.height],
  );
  const activity = useMemo(() => onLayoutActivity ?? null, [onLayoutActivity]);
  return (
    <HomeLayoutContext.Provider value={value}>
      <HomeLayoutActivityContext.Provider value={activity}>
        {children}
      </HomeLayoutActivityContext.Provider>
    </HomeLayoutContext.Provider>
  );
}

/**
 * Сообщить, что раскладка всё ещё пересчитывается. Корень Home держит контент
 * скрытым, пока такие сигналы приходят: размеры сходятся не за один проход —
 * сначала окно, потом safe-area, потом шапка и сцена, и это занимает ~700мс.
 */
export function useHomeLayoutActivity(): () => void {
  const notify = useContext(HomeLayoutActivityContext);
  return useCallback(() => {
    notify?.();
  }, [notify]);
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
