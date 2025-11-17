import { logger } from './logger';

let implActivate: (() => Promise<void>) | null = null;
let implDeactivate: (() => Promise<void>) | null = null;

try {
  // Динамический импорт, чтобы не падать, если модуля нет в окружении
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const keepAwakeModule = require('expo-keep-awake');
  implActivate = keepAwakeModule.activateKeepAwakeAsync
    ? keepAwakeModule.activateKeepAwakeAsync
    : (keepAwakeModule.activateKeepAwake
        ? async () => { keepAwakeModule.activateKeepAwake(); }
        : null);
  implDeactivate = keepAwakeModule.deactivateKeepAwakeAsync
    ? keepAwakeModule.deactivateKeepAwakeAsync
    : (keepAwakeModule.deactivateKeepAwake
        ? async () => { keepAwakeModule.deactivateKeepAwake(); }
        : null);
} catch (e) {
  logger.warn('expo-keep-awake module not available, using fallback', e);
}

export const activateKeepAwakeAsync = async (): Promise<void> => {
  if (implActivate) {
    try {
      await implActivate();
      return;
    } catch (e) {
      logger.warn('activateKeepAwakeAsync failed:', e);
    }
  }
  logger.debug('keep-awake activate (fallback - module not available)');
};

export const deactivateKeepAwakeAsync = async (): Promise<void> => {
  if (implDeactivate) {
    try {
      await implDeactivate();
      return;
    } catch (e) {
      logger.warn('deactivateKeepAwakeAsync failed:', e);
    }
  }
  logger.debug('keep-awake deactivate (fallback - module not available)');
};


