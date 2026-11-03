import { closeSocketTransportForRecovery } from './socketRecovery';

it('preserves namespace recovery and closes a stalled transport before waiting for engine drain', () => {
  const order: string[] = [];
  const socket = {
    disconnect: jest.fn(() => order.push('user left')),
    io: { engine: {
      transport: { close: jest.fn(() => order.push('transport close')) },
      close: jest.fn(() => order.push('engine close')),
    } },
  };
  closeSocketTransportForRecovery(socket);
  expect(socket.disconnect).not.toHaveBeenCalled();
  expect(order).toEqual(['transport close', 'engine close']);
});

it('still closes the engine if the old transport has already failed', () => {
  const close = jest.fn();
  closeSocketTransportForRecovery({ io: { engine: {
    transport: { close: () => { throw new Error('already closed'); } }, close,
  } } });
  expect(close).toHaveBeenCalledTimes(1);
  expect(() => closeSocketTransportForRecovery({})).not.toThrow();
});
