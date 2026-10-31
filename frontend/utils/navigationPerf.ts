import { logger } from './logger';

export type NavigationPerfGlobals = typeof global & {
  __navigationPerfSeq?: number;
  __searchNavT0?: number;
  __searchNavFocusLogged?: boolean;
  __searchNavStateChangeLogged?: boolean;
  __searchNavSteps?: Array<{ step: string; at: number; elapsedMs: number; effectMs?: number }>;
  __searchPerfTrace?: { id: string; startedAt: number; wallStartedAt: number; focusLogged?: boolean };
  __randomExitPerfTrace?: { id: string; startedAt: number; blurLogged?: boolean };
};

export function navigationPerfNow(): number {
  try {
    const value = globalThis.performance?.now?.();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  } catch {}
  return Date.now();
}

export function nextNavigationPerfId(scope: string): string {
  const g = global as NavigationPerfGlobals;
  g.__navigationPerfSeq = Number(g.__navigationPerfSeq || 0) + 1;
  return `${scope}-${g.__navigationPerfSeq}`;
}

/** One-line JSON is easy to retain in logcat and parse after a rapid-tap session. */
export function logNavigationPerf(event: string, payload: Record<string, unknown> = {}) {
  logger.info(`[nav-perf] ${JSON.stringify({ event, ...payload })}`);
}
