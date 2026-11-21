import { resolvePhoneProfileLayout } from './profileHubLayout';

function layout(width: number, height: number, options: {
  landscape?: boolean;
  diagonal?: unknown;
  framed?: boolean;
} = {}) {
  const landscape = options.landscape ?? false;
  const frameOutset = (size: number) => options.framed ? Math.min(12, Math.round(size * 0.085)) : 0;
  const rows = landscape ? 5 : 9;
  const gaps = landscape ? 3 : 5;
  const result = resolvePhoneProfileLayout({
    shortSide: width,
    paneHeight: height,
    isLandscape: landscape,
    diagonalInches: options.diagonal,
    rowCount: rows,
    gapCount: gaps,
    bottomClearance: 8,
    frameOutset,
  });
  const occupied = result.avatarSize + frameOutset(result.avatarSize) * 2 +
    result.gapTop + result.gapUnderAvatar + rows * result.rowHeight + gaps * result.listGap + 8 + gaps - 1;
  return { ...result, occupied };
}

it.each([
  [320, 540, 5.0],
  [360, 540, 5.5],
  [360, 620, 6.0],
  [384, 704, 6.6],
  [393, 730, 6.5],
  [411, 780, 6.7],
  [432, 820, 6.9],
])('keeps the complete profile on one page at %s dp / %s dp pane / %s inches', (width, height, diagonal) => {
  const result = layout(width, height, { diagonal });
  expect(result.scroll).toBe(false);
  expect(result.occupied).toBeLessThanOrEqual(height);
  expect(result.avatarSize).toBeGreaterThanOrEqual(128);
  expect(result.avatarSize).toBeLessThanOrEqual(160);
  expect(result.gapUnderAvatar).toBeGreaterThanOrEqual(height < 600 ? 8 : 12);
  expect(result.gapUnderAvatar).toBeLessThanOrEqual(18);
  expect(result.rowHeight).toBeGreaterThanOrEqual(38);
});

it.each([
  [360, 560, false],
  [384, 704, false],
  [411, 780, false],
  [360, 290, true],
  [384, 310, true],
  [432, 350, true],
])('reserves the outside of the active frame at %s / %s, landscape=%s', (width, height, landscape) => {
  const result = layout(width, height, { diagonal: 6.6, framed: true, landscape });
  expect(result.scroll).toBe(false);
  expect(result.occupied).toBeLessThanOrEqual(height);
  expect(result.avatarSize).toBeGreaterThanOrEqual(landscape ? 92 : 112);
});

it('keeps short screens usable and scrolls when the keyboard leaves too little room', () => {
  const short = layout(360, 540, { diagonal: 5.5 });
  const keyboard = layout(360, 350, { diagonal: 5.5 });
  expect(short.avatarSize).toBeGreaterThan(128);
  expect(short.scroll).toBe(false);
  expect(keyboard.scroll).toBe(true);
  expect(keyboard.rowHeight).toBeGreaterThanOrEqual(30);
  expect(keyboard.avatarSize).toBeGreaterThanOrEqual(112);
});

it.each([480, 490, 500])('keeps a moderate photo and every row on a short 360dp phone with a %s dp pane', height => {
  const result = layout(360, height, { diagonal: 6.6 });
  expect(result.scroll).toBe(false);
  expect(result.occupied).toBeLessThanOrEqual(height);
  expect(result.avatarSize).toBeGreaterThanOrEqual(128);
  expect(result.avatarSize).toBeLessThanOrEqual(144);
  expect(result.rowHeight).toBeGreaterThanOrEqual(32);
  expect(result.gapUnderAvatar).toBeGreaterThanOrEqual(8);
});

it.each([420, 430, 440, 450])('fits all controls on a 320dp compact phone with a %s dp pane', height => {
  const result = layout(320, height, { diagonal: 5.0 });
  expect(result.scroll).toBe(false);
  expect(result.occupied).toBeLessThanOrEqual(height);
  expect(result.avatarSize).toBeGreaterThanOrEqual(112);
  expect(result.rowHeight).toBeGreaterThanOrEqual(30);
});

it('retains scrolling rather than clipping controls below the smallest full-profile budget', () => {
  const result = layout(320, 390, { diagonal: 5.0 });
  expect(result.scroll).toBe(true);
  expect(result.rowHeight).toBeGreaterThanOrEqual(30);
  expect(result.avatarSize).toBeGreaterThanOrEqual(112);
});

it('adjusts for the diagonal without letting it override the available height', () => {
  const smaller = layout(384, 704, { diagonal: 5.5 });
  const bigger = layout(384, 704, { diagonal: 6.9 });
  expect(bigger.avatarSize).toBeGreaterThan(smaller.avatarSize);
  expect(bigger.avatarSize - smaller.avatarSize).toBeLessThanOrEqual(6);
  expect(bigger.occupied).toBeLessThanOrEqual(704);
});

it.each([undefined, null, Number.NaN, 0, 13, '6.6'])('uses screen dimensions when physical diagonal is unavailable: %s', diagonal => {
  expect(layout(384, 704, { diagonal })).toEqual(layout(384, 704));
});

it('bounds the photo on very tall phones instead of filling all free space', () => {
  const result = layout(432, 1000, { diagonal: 6.9 });
  expect(result.scroll).toBe(false);
  expect(result.avatarSize).toBeLessThanOrEqual(160);
  expect(result.gapUnderAvatar).toBeLessThanOrEqual(18);
});
