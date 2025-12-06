import { logger } from '../../../utils/logger';

// ==================== Simple EventEmitter for React Native ====================

type EventHandler = (...args: any[]) => void;

export class SimpleEventEmitter {
  private events: Map<string, EventHandler[]> = new Map();

  on(event: string, handler: EventHandler): this {
    const handlers = this.events.get(event) || [];
    handlers.push(handler);
    this.events.set(event, handlers);
    return this;
  }

  off(event: string, handler?: EventHandler): this {
    if (!handler) {
      this.events.delete(event);
      return this;
    }
    const handlers = this.events.get(event) || [];
    const filtered = handlers.filter(h => h !== handler);
    if (filtered.length === 0) {
      this.events.delete(event);
    } else {
      this.events.set(event, filtered);
    }
    return this;
  }

  once(event: string, handler: EventHandler): this {
    const onceHandler = (...args: any[]) => {
      handler(...args);
      this.off(event, onceHandler);
    };
    return this.on(event, onceHandler);
  }

  emit(event: string, ...args: any[]): boolean {
    const handlers = this.events.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(...args);
      } catch (error) {
        logger.error(`[SimpleEventEmitter] Error in handler for event "${event}":`, error);
      }
    });
    return handlers.length > 0;
  }

  removeAllListeners(event?: string): this {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
    return this;
  }
}

