type LogMeta = Record<string, unknown> | undefined;

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
} as const;
const currentLevel = levels[LOG_LEVEL as keyof typeof levels] ?? levels.info;

function ts() {
  return new Date().toISOString();
}

function fmt(meta?: LogMeta) {
  if (!meta) return '';
  try {
    return ' ' + JSON.stringify(meta);
  } catch {
    return ' ' + String(meta);
  }
}

export const logger = {
  debug(message: string, meta?: LogMeta) {
    if (currentLevel > levels.debug) return;
    // eslint-disable-next-line no-console
    console.log(`[${ts()}] [debug] ${message}${fmt(meta)}`);
  },
  info(message: string, meta?: LogMeta) {
    if (currentLevel > levels.info) return;
    // eslint-disable-next-line no-console
    console.log(`[${ts()}] [info] ${message}${fmt(meta)}`);
  },
  warn(message: string, meta?: LogMeta) {
    if (currentLevel > levels.warn) return;
    // eslint-disable-next-line no-console
    console.warn(`[${ts()}] [warn] ${message}${fmt(meta)}`);
  },
  error(message: string, meta?: LogMeta) {
    if (currentLevel > levels.error) return;
    // eslint-disable-next-line no-console
    console.error(`[${ts()}] [error] ${message}${fmt(meta)}`);
  },
};

