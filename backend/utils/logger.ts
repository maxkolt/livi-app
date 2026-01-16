type LogMeta = Record<string, unknown> | undefined;

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
    if (process.env.LOG_LEVEL === 'silent') return;
    if (process.env.NODE_ENV === 'production' && process.env.LOG_LEVEL !== 'debug') return;
    // eslint-disable-next-line no-console
    console.log(`[${ts()}] [debug] ${message}${fmt(meta)}`);
  },
  info(message: string, meta?: LogMeta) {
    if (process.env.LOG_LEVEL === 'silent') return;
    // eslint-disable-next-line no-console
    console.log(`[${ts()}] [info] ${message}${fmt(meta)}`);
  },
  warn(message: string, meta?: LogMeta) {
    if (process.env.LOG_LEVEL === 'silent') return;
    // eslint-disable-next-line no-console
    console.warn(`[${ts()}] [warn] ${message}${fmt(meta)}`);
  },
  error(message: string, meta?: LogMeta) {
    if (process.env.LOG_LEVEL === 'silent') return;
    // eslint-disable-next-line no-console
    console.error(`[${ts()}] [error] ${message}${fmt(meta)}`);
  },
};

