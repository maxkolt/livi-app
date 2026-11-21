import { SEARCH_RADAR_TOP_GAP, searchRadarPlacement } from './searchRadarPlacement';

it.each([
  [486, 144, 520],
  [386, 130, 470],
  [560, 160, 650],
])('anchors the visible radar to the same banner gap at area=%s / radius=%s', (areaHeight, visibleRadius, ctaTop) => {
  const result = searchRadarPlacement({ areaHeight, visibleRadius, ctaTop, nicknameHeight: 48, minCtaGap: 16 });
  expect(areaHeight / 2 - visibleRadius + result.radarShiftY).toBe(SEARCH_RADAR_TOP_GAP);
  expect(result.nicknameShiftY - result.radarShiftY).toBe(8);
});
it('reduces the gap on genuinely short windows to keep the nickname clear of the CTA', () => {
  const result = searchRadarPlacement({ areaHeight: 180, visibleRadius: 70, ctaTop: 220, nicknameHeight: 40, minCtaGap: 12 });
  expect(result.visibleTopGap).toBeLessThan(SEARCH_RADAR_TOP_GAP);
  expect(result.visibleTopGap + 140 + 40 + 8 + 12).toBeLessThanOrEqual(220);
});
