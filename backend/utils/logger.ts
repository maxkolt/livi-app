// backend/utils/logger.ts
// Система логирования с уровнями для оптимизации вывода

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

class Logger {
  private isProduction = process.env.NODE_ENV === 'production';
  private debugEnabled = process.env.DEBUG_LOGS === 'true' || !this.isProduction;
  private infoEnabled = process.env.INFO_LOGS === 'true' || !this.isProduction;

  private log(level: LogLevel, message: string, ...args: any[]) {
    // В production показываем только ошибки и предупреждения
    if (this.isProduction && (level === 'info' || level === 'debug')) {
      return;
    }

    // В development показываем только warn и error по умолчанию
    if (!this.isProduction && level === 'info' && !this.infoEnabled) {
      return;
    }

    // В development показываем все, кроме debug (если не включен явно)
    if (!this.isProduction && level === 'debug' && !this.debugEnabled) {
      return;
    }

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    
    switch (level) {
      case 'error':
        console.error(prefix, message, ...args);
        break;
      case 'warn':
        console.warn(prefix, message, ...args);
        break;
      case 'info':
        console.log(prefix, message, ...args);
        break;
      case 'debug':
        console.log(prefix, message, ...args);
        break;
    }
  }

  error(message: string, ...args: any[]) {
    this.log('error', message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.log('warn', message, ...args);
  }

  info(message: string, ...args: any[]) {
    this.log('info', message, ...args);
  }

  debug(message: string, ...args: any[]) {
    this.log('debug', message, ...args);
  }
}

export const logger = new Logger();
