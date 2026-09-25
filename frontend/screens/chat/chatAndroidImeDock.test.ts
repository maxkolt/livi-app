import {
  clampAndroidImeHeightScale,
  formatAndroidImeDockLog,
  resolveAndroidImeDockTranslateY,
  resolveAndroidImeGapDp,
  resolveAndroidImeHeightScale,
} from './chatAndroidImeDock';

describe('resolveAndroidImeHeightScale', () => {
  it('is 1 when kc is missing', () => {
    expect(resolveAndroidImeHeightScale(320, 0, 24)).toBe(1);
  });

  it('scales up when WindowInsets ime is taller than KC (density / nav mismatch)', () => {
    // system-density KC=300, activity-density ime=336 → stripe ≈ 36dp without scale
    expect(resolveAndroidImeHeightScale(336, 300, 24)).toBeCloseTo(336 / 300, 5);
  });

  it('falls back to kc+nav when ime is unknown (KC reports ime−nav)', () => {
    expect(resolveAndroidImeHeightScale(0, 300, 24)).toBeCloseTo(324 / 300, 5);
  });

  it('clamps absurd ratios', () => {
    expect(clampAndroidImeHeightScale(3)).toBe(1.5);
    expect(clampAndroidImeHeightScale(0.1)).toBe(0.85);
  });
});

describe('resolveAndroidImeDockTranslateY', () => {
  it('sits on nav when keyboard is closed', () => {
    expect(
      resolveAndroidImeDockTranslateY({
        kcAbsDp: 0,
        imeDp: 0,
        navDp: 24,
        progress: 0,
        kcHeightSigned: 0,
        scale: 1,
      }),
    ).toBe(-24);
  });

  it('reaches full ime when open: height×scale = −ime', () => {
    const ime = 336;
    const kc = 300;
    const scale = resolveAndroidImeHeightScale(ime, kc, 24);
    expect(
      resolveAndroidImeDockTranslateY({
        kcAbsDp: kc,
        imeDp: ime,
        navDp: 24,
        progress: 1,
        kcHeightSigned: -kc,
        scale,
      }),
    ).toBeCloseTo(-ime, 5);
  });

  it('tracks keyboard mid-flight without waiting for WindowInsets', () => {
    const ime = 336;
    const kcFull = 300;
    const scale = resolveAndroidImeHeightScale(ime, kcFull, 24);
    const progress = 0.5;
    const kcNow = -150; // half-open KC frame
    const y = resolveAndroidImeDockTranslateY({
      kcAbsDp: 150,
      imeDp: ime,
      navDp: 24,
      progress,
      kcHeightSigned: kcNow,
      scale,
    });
    // height×scale + (1-p)×(−nav) = -150*(336/300) + 0.5*(-24)
    expect(y).toBeCloseTo(-150 * (336 / 300) - 12, 5);
  });

  it('reports remaining gap after scale', () => {
    expect(resolveAndroidImeGapDp(336, 300, 336 / 300)).toBeCloseTo(0, 5);
    expect(resolveAndroidImeGapDp(336, 300, 1)).toBeCloseTo(36, 5);
  });
});

describe('formatAndroidImeDockLog', () => {
  it('formats a compact diagnostic line', () => {
    const line = formatAndroidImeDockLog({
      progress: 1,
      kcAbsDp: 300,
      imeDp: 336,
      navDp: 24,
      scale: 1.12,
      gapDp: 0,
      translateY: -336,
      pixelRatio: 2.75,
      windowH: 800,
    });
    expect(line).toContain('[ChatIME]');
    expect(line).toContain('ime=336.0');
    expect(line).toContain('scale=1.1200');
  });
});
