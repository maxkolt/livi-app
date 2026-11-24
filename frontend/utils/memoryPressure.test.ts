import { getMemoryPressureRevision, notifyMemoryPressure, subscribeMemoryPressure } from './memoryPressure';

it('notifies all resource owners even if one fails, and honors unsubscription', () => {
  const before = getMemoryPressureRevision();
  const broken = subscribeMemoryPressure(() => { throw Error('cache'); });
  const cache = jest.fn();
  const unsubscribe = subscribeMemoryPressure(cache);
  notifyMemoryPressure();
  expect(cache).toHaveBeenCalledTimes(1);
  expect(getMemoryPressureRevision()).toBe(before + 1);
  unsubscribe();
  notifyMemoryPressure();
  expect(cache).toHaveBeenCalledTimes(1);
  broken();
});
