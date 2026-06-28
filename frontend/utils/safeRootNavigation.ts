/** Доступ к __navRef без console.error createNavigationContainerRef до mount. */

export type SafeRootNavLike = {
  isReady?: () => boolean;
  getCurrentRoute?: () => { name?: string; params?: object } | undefined;
  getState?: () => { routes?: ReadonlyArray<{ name?: string; params?: object }>; index?: number };
  getRootState?: () => { routes?: ReadonlyArray<{ name?: string; params?: object }>; index?: number };
};

export function readSafeRootNavigation(): SafeRootNavLike | null {
  try {
    const nav = (global as any).__navRef as SafeRootNavLike | undefined;
    if (!nav?.isReady?.()) return null;
    return nav;
  } catch {
    return null;
  }
}

export function readRootCurrentRouteName(): string {
  const nav = readSafeRootNavigation();
  return String(nav?.getCurrentRoute?.()?.name ?? '');
}

export function readRootCurrentRoute(): { name?: string; params?: object } | undefined {
  const nav = readSafeRootNavigation();
  if (!nav) return undefined;
  return nav.getCurrentRoute?.();
}

export function readRootNavigationState():
  | { routes?: ReadonlyArray<{ name?: string; params?: object }>; index?: number }
  | undefined {
  const nav = readSafeRootNavigation();
  if (!nav) return undefined;
  if (typeof nav.getRootState === 'function') {
    return nav.getRootState();
  }
  return nav.getState?.();
}
