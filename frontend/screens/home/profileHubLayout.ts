type PhoneProfileLayoutOptions = {
  paneHeight: number;
  shortSide: number;
  isLandscape: boolean;
  diagonalInches?: unknown;
  rowCount: number;
  gapCount: number;
  bottomClearance: number;
  frameOutset: (avatarSize: number) => number;
};

export type PhoneProfileLayout = {
  avatarSize: number;
  gapTop: number;
  gapUnderAvatar: number;
  rowHeight: number;
  listGap: number;
  scroll: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Shared photo diameter before the profile's height-dependent fitting. */
export function preferredPhoneProfileAvatarSize(shortSide: number, diagonalInches?: unknown): number {
  const width = Number.isFinite(shortSide) && shortSide > 0 ? shortSide : 384;
  const diagonal = typeof diagonalInches === 'number' && Number.isFinite(diagonalInches) &&
    diagonalInches >= 4 && diagonalInches <= 8.5
    ? diagonalInches
    : 5.5;
  return Math.round(clamp(width * 0.38 + clamp((diagonal - 5.5) * 4, 0, 6), 128, 160));
}

export function profileAvatarDisplaySize(layoutSize: number): number {
  return Math.round(layoutSize * 0.88);
}

/**
 * Fit the complete phone profile into its measured pane. The photo has its own
 * moderate size instead of inheriting the smaller Search radar geometry. A real
 * screen diagonal only adds a small adjustment; the available dp remain the
 * limit, including display zoom, landscape and the outside of a purchased frame.
 */
export function resolvePhoneProfileLayout({
  paneHeight,
  shortSide,
  isLandscape,
  diagonalInches,
  rowCount,
  gapCount,
  bottomClearance,
  frameOutset,
}: PhoneProfileLayoutOptions): PhoneProfileLayout {
  const preferredAvatar = preferredPhoneProfileAvatarSize(shortSide, diagonalInches);
  const hasHeight = Number.isFinite(paneHeight) && paneHeight > 0;
  const compactPortrait = !isLandscape && hasHeight && paneHeight < 600;
  const veryCompactPortrait = compactPortrait && paneHeight < 460;
  const rowMax = isLandscape ? 42 : 52;
  const gapMin = isLandscape ? 4 : veryCompactPortrait ? 3 : compactPortrait ? 4 : 6;
  const gapMax = isLandscape ? 8 : 14;
  const topMin = isLandscape ? 2 : veryCompactPortrait ? 3 : compactPortrait ? 4 : 6;
  const underMin = isLandscape ? 6 : compactPortrait ? 8 : 12;
  const preferredTop = isLandscape ? 4 : 20;
  const preferredUnder = isLandscape ? 10 : 18;
  // One divider per section row; reserve a full dp even on fractional densities.
  const fixedClearance = bottomClearance + gapCount - 1;
  const maxList = rowCount * rowMax + gapCount * gapMax;
  const avatarFootprint = (size: number) => size + Math.max(0, frameOutset(size)) * 2;
  // Short phones first use denser rows, keeping a useful photo instead of
  // shrinking it to its floor while the list still consumes tall-phone space.
  const compactRowBudget = (paneHeight - avatarFootprint(preferredAvatar) -
    topMin - underMin - fixedClearance - gapCount * gapMin) / rowCount;
  const rowMin = isLandscape ? 26 : veryCompactPortrait ? 30 : compactPortrait
    ? clamp(Math.floor(compactRowBudget), 32, 34)
    : 38;
  const minList = rowCount * rowMin + gapCount * gapMin;

  let avatarSize = preferredAvatar;
  if (hasHeight) {
    // On short displays, reduce the photo only after reserving usable rows and
    // real gaps. Below this floor, scrolling is preferable to clipping controls.
    const avatarFloor = Math.min(preferredAvatar, isLandscape ? 92 : compactPortrait && !veryCompactPortrait ? 120 : 112);
    while (avatarSize > avatarFloor &&
      avatarFootprint(avatarSize) + topMin + underMin + fixedClearance + minList > paneHeight) {
      avatarSize--;
    }
  }

  const fixed = avatarFootprint(avatarSize) + fixedClearance;
  let shortage = hasHeight
    ? Math.max(0, fixed + preferredTop + preferredUnder + maxList - paneHeight)
    : 0;
  const topReduction = Math.min(preferredTop - topMin, shortage);
  const gapTop = preferredTop - topReduction;
  shortage -= topReduction;
  const gapUnderAvatar = preferredUnder - Math.min(preferredUnder - underMin, shortage);
  const listBudget = hasHeight ? Math.max(0, paneHeight - fixed - gapTop - gapUnderAvatar) : maxList;
  const scroll = listBudget < minList;
  const progress = clamp((listBudget - minList) / (maxList - minList), 0, 1);
  const rowHeight = Math.floor(rowMin + (rowMax - rowMin) * progress);
  const listGap = clamp(Math.floor((listBudget - rowCount * rowHeight) / gapCount * 10) / 10, gapMin, gapMax);

  return { avatarSize, gapTop, gapUnderAvatar, rowHeight, listGap, scroll };
}
