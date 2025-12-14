import { EventEmitter } from 'events';

class MockSocket extends EventEmitter {
  id = 'socket-1';
  connected = true;
  emitted: { event: string; payload: any }[] = [];

  override on(event: string, listener: (...args: any[]) => void) {
    super.on(event, listener);
    return this;
  }

  override off(event: string, listener: (...args: any[]) => void) {
    super.off(event, listener);
    return this;
  }

  override emit(event: string, payload?: any) {
    this.emitted.push({ event, payload });
    return super.emit(event, payload);
  }
}

const socket = new MockSocket();

export default socket;
export { socket };
