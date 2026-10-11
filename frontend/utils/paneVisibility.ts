import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedValue } from 'react-native-reanimated';

/**
 * false — содержимое лежит в скрытой keep-alive вкладке. Анимации (огонь рамок)
 * там замирают на последнем кадре, но остаются отрисованными.
 * SharedValue, а не boolean: смена вкладки не перерисовывает в React каждую рамку.
 */
export const PaneVisibleContext = createContext<SharedValue<boolean> | null>(null);

export function usePaneVisibleValue(): SharedValue<boolean> | null {
  return useContext(PaneVisibleContext);
}

/**
 * Та же видимость обычным boolean — для того, что должно перерисоваться при смене
 * вкладки (список). Вне keep-alive вкладки — true.
 */
export const PaneLiveContext = createContext(true);

const LIVE_LIST_WINDOW = { initialNumToRender: 12, maxToRenderPerBatch: 10, windowSize: 7 } as const;
const HIDDEN_LIST_WINDOW = { initialNumToRender: 12, maxToRenderPerBatch: 10, windowSize: 1 } as const;
/** Скрытая вкладка заранее строит только первый экран строк. */
const HIDDEN_ROWS = 12;
/** Одна часть за шаг: её нативный mount укладывается в кадр. */
const HIDDEN_STEP_MS = 50;

/**
 * Сколько частей скрытой вкладки уже построено. Скрытая (прогрев после splash,
 * пока на экране радар «Поиска») строит по одной части за шаг: каждая — короткая
 * работа UI-потока, и луч радара не спотыкается. Вкладка целиком одним коммитом
 * занимала UI-поток на 50–450 мс. Видимая и уже показанная — все части сразу.
 */
export function usePaneReveal(total: number): number {
  const live = useContext(PaneLiveContext);
  const shownRef = useRef(live);
  if (live) shownRef.current = true;
  const full = shownRef.current;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (full || count >= total) return;
    const timer = setTimeout(() => setCount((c) => c + 1), HIDDEN_STEP_MS);
    return () => clearTimeout(timer);
  }, [count, full, total]);
  return full ? Number.POSITIVE_INFINITY : count;
}

/**
 * Данные и окно FlatList вкладки. Скрытая получает строки по одной (первый экран)
 * и не строит окно за экраном: иначе FlatList рисовал видимые строки одной пачкой,
 * а потом дорисовывал окно в 7 экранов пачками по 10 строк несколько секунд.
 */
export function usePaneList<T>(items: ReadonlyArray<T>) {
  const live = useContext(PaneLiveContext);
  const revealed = usePaneReveal(Math.min(items.length, HIDDEN_ROWS));
  const data = useMemo(
    () => (revealed >= items.length ? items : items.slice(0, revealed)),
    [items, revealed],
  );
  return { data, windowProps: live ? LIVE_LIST_WINDOW : HIDDEN_LIST_WINDOW };
}
