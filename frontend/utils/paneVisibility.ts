import { createContext, useContext } from 'react';
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
