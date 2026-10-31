import { WebSocket, XHR } from 'engine.io-client';
import { nextSocketTransportOrder } from './socketTransportPreference';

describe('socket transport fallback', () => {
  it('alternates after a timeout when Engine.IO has normalized strings to constructors', () => {
    expect(nextSocketTransportOrder([WebSocket, XHR], 'timeout')).toEqual(['polling', 'websocket']);
    expect(nextSocketTransportOrder([XHR, WebSocket], 'timeout')).toEqual(['websocket', 'polling']);
  });

  it('also handles the initial string options', () => {
    expect(nextSocketTransportOrder(['websocket', 'polling'], 'transport error')).toEqual(['polling', 'websocket']);
    expect(nextSocketTransportOrder(['polling', 'websocket'], 'timeout')).toEqual(['websocket', 'polling']);
  });

  it('chooses the other transport for specific errors without resetting an existing preference', () => {
    expect(nextSocketTransportOrder([WebSocket, XHR], 'websocket error')).toEqual(['polling', 'websocket']);
    expect(nextSocketTransportOrder([XHR, WebSocket], 'xhr poll error')).toEqual(['websocket', 'polling']);
    expect(nextSocketTransportOrder([WebSocket, XHR], 'xhr poll error')).toBeNull();
    expect(nextSocketTransportOrder([XHR, WebSocket], 'websocket error')).toBeNull();
  });

  it('leaves unrelated errors and unsupported transport configurations alone', () => {
    expect(nextSocketTransportOrder([WebSocket, XHR], 'unauthorized')).toBeNull();
    expect(nextSocketTransportOrder([WebSocket], 'timeout')).toBeNull();
    expect(nextSocketTransportOrder([], 'timeout')).toBeNull();
  });
});
