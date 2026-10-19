import { reconcileLayoutSize } from './useOrientationLayoutGuard';

describe('reconcileLayoutSize', () => {
  const phone = { width: 411, height: 891 };

  it('drops a stale system-PiP layout once the window is full screen again', () => {
    // PiP 9:16 → полный экран, оба портрет: onLayout так и остался от окна PiP.
    expect(reconcileLayoutSize({ width: 121, height: 215 }, phone)).toEqual(phone);
  });

  it('replaces the PiP-width size committed from mixed window/screen edges', () => {
    expect(reconcileLayoutSize({ width: 121, height: 891 }, phone)).toEqual(phone);
  });

  it('drops a landscape PiP layout after returning to a portrait window', () => {
    expect(reconcileLayoutSize({ width: 215, height: 121 }, phone)).toEqual(phone);
  });

  it('keeps the measured layout while the keyboard shortens the root', () => {
    expect(reconcileLayoutSize({ width: 411, height: 560 }, phone)).toEqual({ width: 411, height: 560 });
  });

  it('keeps the measured layout when the window width excludes a side navigation bar', () => {
    const landscapeWindow = { width: 843, height: 411 };
    expect(reconcileLayoutSize({ width: 891, height: 411 }, landscapeWindow)).toEqual({ width: 891, height: 411 });
  });

  it('falls back to the window when nothing was measured yet', () => {
    expect(reconcileLayoutSize(null, phone)).toEqual(phone);
  });

  it('ignores an empty window', () => {
    expect(reconcileLayoutSize({ width: 411, height: 891 }, { width: 0, height: 0 })).toBeNull();
  });
});
