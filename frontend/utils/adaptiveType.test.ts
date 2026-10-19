import { adaptiveTypeScaleForSize, adaptiveTypeStyleScaleForSize, typeScaleWindowSize } from './adaptiveType';

describe('typeScaleWindowSize', () => {
  const screen = { width: 411, height: 891 };

  it('scales text by the screen while the app is in system PiP', () => {
    expect(typeScaleWindowSize({ width: 121, height: 215 }, screen)).toBe(screen);
  });

  it('keeps the window for full screen and split screen', () => {
    const full = { width: 411, height: 891 };
    const split = { width: 411, height: 440 };
    expect(typeScaleWindowSize(full, screen)).toBe(full);
    expect(typeScaleWindowSize(split, screen)).toBe(split);
  });
});

describe('adaptiveTypeScaleForSize', () => {
  it('keeps the established phone size at 384 dp and below', () => {
    expect(adaptiveTypeScaleForSize(384, 850)).toBe(1);
    expect(adaptiveTypeScaleForSize(360, 780)).toBe(1);
  });

  it('gently enlarges text on wide Ultra-class phones', () => {
    expect(adaptiveTypeScaleForSize(412, 915)).toBe(1.05);
  });

  it('caps the wide-phone adjustment', () => {
    expect(adaptiveTypeScaleForSize(480, 1000)).toBe(1.06);
  });

  it('preserves the existing tablet scale', () => {
    expect(adaptiveTypeScaleForSize(800, 1280)).toBe(1.08);
  });

  it('neutralizes Samsung fontScale below one for the base UI size', () => {
    const styleScale = adaptiveTypeStyleScaleForSize(360, 780, 0.9);
    expect(styleScale * 0.9).toBeCloseTo(1, 5);
  });

  it('does not suppress an increased accessibility font scale', () => {
    expect(adaptiveTypeStyleScaleForSize(360, 780, 1.2)).toBe(1);
  });
});
