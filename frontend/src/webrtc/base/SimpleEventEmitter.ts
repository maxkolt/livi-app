import { logger } from '../../../utils/logger';

// ==================== Simple EventEmitter for React Native ====================

type EventHandler<Args extends unknown[]> = (...args: Args) => void;

export class SimpleEventEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private events: Map<string, EventHandler<Events[keyof Events]>[]> = new Map();

  on<K extends keyof Events & string>(event: K, handler: EventHandler<Events[K]>): this {
    const handlers = (this.events.get(event) || []) as EventHandler<Events[K]>[];
    handlers.push(handler);
    this.events.set(event, handlers as EventHandler<Events[keyof Events]>[]);
    return this;
  }

  off<K extends keyof Events & string>(event: K, handler?: EventHandler<Events[K]>): this {
    if (!handler) {
      this.events.delete(event);
      return this;
    }
    const handlers = (this.events.get(event) || []) as EventHandler<Events[K]>[];
    const filtered = handlers.filter(h => h !== handler);
    if (filtered.length === 0) {
      this.events.delete(event);
    } else {
      this.events.set(event, filtered as EventHandler<Events[keyof Events]>[]);
    }
    return this;
  }

  once<K extends keyof Events & string>(event: K, handler: EventHandler<Events[K]>): this {
    const onceHandler = (...args: Events[K]) => {
      handler(...args);
      this.off(event, onceHandler);
    };
    return this.on(event, onceHandler);
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
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

  removeAllListeners(event?: keyof Events & string): this {
    if (event) {
      this.events.delete(event);
    } else {
      this.events.clear();
    }
    return this;
  }
}

