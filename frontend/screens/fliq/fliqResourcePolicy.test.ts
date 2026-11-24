import { appendFliqWindow, FLIQ_MAX_ITEMS, shouldMountFliqPlayer } from './fliqResourcePolicy';

it('keeps only the current and next decoder, and only the current under memory pressure', () => {
  const offsets = [-2, -1, 0, 1, 2, 3];
  expect(offsets.filter(offset => shouldMountFliqPlayer(offset, false, true, false))).toEqual([0, 1]);
  expect(offsets.filter(offset => shouldMountFliqPlayer(offset, false, true, true))).toEqual([0]);
  expect(offsets.filter(offset => shouldMountFliqPlayer(offset, true, true, false))).toEqual([0]);
});

it('bounds a long scrolling session without losing the active object or duplicating items', () => {
  let items = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  for (let page = 2; page < 100; page++) {
    const index = items.length - 3;
    const active = items[index];
    const incoming = Array.from({ length: 10 }, (_, i) => ({ id: String(page * 10 + i) }));
    const next = appendFliqWindow(items, [...incoming, incoming[0]], index);
    expect(next.items[next.index]).toBe(active);
    expect(next.items.length).toBeLessThanOrEqual(FLIQ_MAX_ITEMS);
    expect(new Set(next.items.map(item => item.id)).size).toBe(next.items.length);
    expect(next.items.slice(-10)).toEqual(incoming);
    items = next.items;
  }
});
