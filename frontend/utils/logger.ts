// frontend/utils/logger.ts
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug, info, warn, error

const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = levels[LOG_LEVEL as keyof typeof levels] || levels.info;

export const logger = {
  debug: (...args: any[]) => {
    if (currentLevel <= levels.debug) {
      console.log('[DEBUG]', ...args);
    }
  },
  info: (...args: any[]) => {
    if (currentLevel <= levels.info) {
      console.info('[INFO]', ...args);
    }
  },
  warn: (...args: any[]) => {
    if (currentLevel <= levels.warn) {
      console.warn('[WARN]', ...args);
    }
  },
  error: (...args: any[]) => {
    if (currentLevel <= levels.error) {
      console.error('[ERROR]', ...args);
    }
  },
};
