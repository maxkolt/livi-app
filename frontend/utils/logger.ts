// frontend/utils/logger.ts
// In Expo, environment variables intended for the JS bundle should be prefixed with EXPO_PUBLIC_.
// We still support LOG_LEVEL for local tooling / non-Expo environments.
const LOG_LEVEL = process.env.EXPO_PUBLIC_LOG_LEVEL || process.env.LOG_LEVEL || 'info'; // debug, info, warn, error

const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// `??`, not `||`: debug is level 0, and `0 || info` silently turned LOG_LEVEL=debug into info.
const currentLevel = levels[LOG_LEVEL as keyof typeof levels] ?? levels.info;
let diagnosticSink: ((level: 'warning' | 'error', args: unknown[]) => void) | null = null;
export function setDiagnosticLogSink(sink: typeof diagnosticSink): void { diagnosticSink = sink; }
function diagnose(level: 'warning' | 'error', args: unknown[]): void {
  try { diagnosticSink?.(level, args); } catch {}
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (currentLevel <= levels.debug) {
      console.log('[DEBUG]', ...args);
    }
  },
  info: (...args: unknown[]) => {
    if (currentLevel <= levels.info) {
      console.info('[INFO]', ...args);
    }
  },
  warn: (...args: unknown[]) => {
    diagnose('warning', args);
    if (currentLevel <= levels.warn) {
      console.warn('[WARN]', ...args);
    }
  },
  error: (...args: unknown[]) => {
    diagnose('error', args);
    if (currentLevel <= levels.error) {
      console.error('[ERROR]', ...args);
    }
  },
};
