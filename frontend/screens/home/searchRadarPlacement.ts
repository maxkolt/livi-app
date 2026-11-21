/** Visible banner-to-radar gap from the accepted A35 portrait layout, in dp. */
export const SEARCH_RADAR_TOP_GAP = 66;

export function searchRadarPlacement(options: {
  areaHeight: number;
  visibleRadius: number;
  ctaTop: number;
  nicknameHeight: number;
  minCtaGap: number;
}): { radarShiftY: number; nicknameShiftY: number; visibleTopGap: number } {
  const { areaHeight, visibleRadius, ctaTop, nicknameHeight, minCtaGap } = options;
  // Retain the accepted 8dp difference between the previous radar (-32) and
  // nickname (-24) shifts. Both move together so they cannot overlap.
  const nicknameOffset = nicknameHeight > 0 ? 8 : 0;
  const availableGap = Math.max(0, ctaTop - visibleRadius * 2 - nicknameHeight - nicknameOffset - minCtaGap);
  const visibleTopGap = Math.min(SEARCH_RADAR_TOP_GAP, availableGap);
  const radarShiftY = visibleTopGap - (areaHeight / 2 - visibleRadius);
  return { radarShiftY, nicknameShiftY: radarShiftY + 8, visibleTopGap };
}
