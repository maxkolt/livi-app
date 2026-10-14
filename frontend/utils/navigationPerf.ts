import { logger } from './logger';

export function navigationPerfNow(): number {
  try {
    const value = globalThis.performance?.now?.();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  } catch {}
  return Date.now();
}

export function nextNavigationPerfId(scope: string): string {
  const g = global as any;
  g.__navigationPerfSeq = Number(g.__navigationPerfSeq || 0) + 1;
  return `${scope}-${g.__navigationPerfSeq}`;
}

/** One-line JSON is easy to retain in logcat and parse after a rapid-tap session. */
export function logNavigationPerf(event: string, payload: Record<string, unknown> = {}) {
  logger.info(`[nav-perf] ${JSON.stringify({ event, ...payload })}`);
}
