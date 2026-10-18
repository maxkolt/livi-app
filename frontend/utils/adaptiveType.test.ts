import { adaptiveTypeScaleForSize, adaptiveTypeStyleScaleForSize } from './adaptiveType';

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
