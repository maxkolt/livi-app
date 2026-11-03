import type { Room } from 'livekit-client';
import { disposeRoom } from './disposeRoom';

function roomFixture(state = 'reconnecting') {
  const engine = { close: jest.fn(async () => {}) };
  const room = { state, engine, removeAllListeners: jest.fn(), disconnect: jest.fn(async (_stop: boolean) => {}) };
  return { room, engine, sdkRoom: room as unknown as Room };
}

afterEach(() => jest.useRealTimers());

it('awaits engine shutdown even when the room is already disconnected', async () => {
  const { room, engine, sdkRoom } = roomFixture('disconnected');
  await disposeRoom(sdkRoom);
  expect(room.disconnect).toHaveBeenCalledWith(false);
  expect(engine.close).toHaveBeenCalledTimes(1);
});

it('cancels SDK reconnect retries after ending an offline call', async () => {
  jest.useFakeTimers();
  const { room, engine, sdkRoom } = roomFixture();
  const reconnect = jest.fn();
  const timer = setInterval(reconnect, 1000);
  engine.close.mockImplementation(async () => { clearInterval(timer); });
  await disposeRoom(sdkRoom, false);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(room.disconnect).toHaveBeenCalledWith(true);
  expect(reconnect).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('shares teardown and does not release shared tracks before old room cleanup completes', async () => {
  const { room, engine, sdkRoom } = roomFixture();
  let finish!: () => void;
  room.disconnect.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = disposeRoom(sdkRoom);
  expect(disposeRoom(sdkRoom)).toBe(pending);
  let done = false;
  void pending.then(() => { done = true; });
  await Promise.resolve();
  expect(done).toBe(false);
  finish();
  await pending;
  expect(engine.close).toHaveBeenCalledTimes(1);
  expect(room.disconnect).toHaveBeenCalledTimes(1);
});

it('closes the captured engine when disconnect hangs or clears room.engine', async () => {
  jest.useFakeTimers();
  const { room, engine, sdkRoom } = roomFixture();
  room.disconnect.mockImplementation(() => {
    Object.assign(room, { engine: undefined });
    return new Promise<void>(() => {});
  });
  const pending = disposeRoom(sdkRoom);
  await jest.advanceTimersByTimeAsync(3000);
  await pending;
  expect(engine.close).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});
