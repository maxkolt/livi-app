import { createContext, useContext } from 'react';

/**
 * false — содержимое лежит в скрытой keep-alive вкладке. Анимации (огонь рамок)
 * там замирают на последнем кадре, но остаются отрисованными.
 */
export const PaneVisibleContext = createContext(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibleContext);
}
