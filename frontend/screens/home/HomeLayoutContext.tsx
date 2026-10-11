import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useSafeAreaFrame } from 'react-native-safe-area-context';

type HomeLayoutSize = { width: number; height: number };

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
  // До первого замера — safe-area frame. Подписка здесь, а не в каждом потребителе:
  // иначе смена frame при повороте перерисовывала и скрытые вкладки.
  const frame = useSafeAreaFrame();
  const measured = size.width > 0 && size.height > 0;
  const width = measured ? size.width : frame.width;
  const height = measured ? size.height : frame.height;
  const value = useMemo(() => ({ width, height }), [width, height]);
  return (
    <HomeLayoutContext.Provider value={value}>{children}</HomeLayoutContext.Provider>
  );
}

/** Скрытая вкладка подхватывает новый размер с этой задержкой после последней смены. */
const HIDDEN_LAYOUT_DELAY_MS = 280;

/**
 * Размеры для keep-alive вкладки. Видимая получает их сразу; скрытая — после паузы:
 * при повороте все вкладки пересчитывались в одном кадре, и JS был занят секундами
 * (списки с аватарами). Открытие вкладки сразу отдаёт актуальный размер.
 */
export function DeferredHomeLayout({ live, children }: { live: boolean; children: React.ReactNode }) {
  const parent = useContext(HomeLayoutContext);
  const [held, setHeld] = useState(parent);
  useEffect(() => {
    if (held === parent) return;
    if (live) {
      setHeld(parent);
      return;
    }
    const timer = setTimeout(() => setHeld(parent), HIDDEN_LAYOUT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [held, live, parent]);
  if (!parent) return <>{children}</>;
  return <HomeLayoutContext.Provider value={live ? parent : held}>{children}</HomeLayoutContext.Provider>;
}

/**
 * Размер корня Home. Вне провайдера отдаёт safe-area frame — он корректен, просто
 * может запаздывать на кадр при ресайзе. Внутри провайдер или снаружи — постоянно
 * для компонента, поэтому условный хук здесь безопасен.
 */
export function useHomeLayout(): HomeLayoutSize {
  const ctx = useContext(HomeLayoutContext);
  if (ctx) return ctx;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useSafeAreaFrame();
}
