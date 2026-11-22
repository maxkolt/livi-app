jest.mock('@shopify/react-native-skia', () => ({}));

import { fisheyeScreen, fisheyeSource } from '../../utils/fisheyeLens';
import { radarAvatarSizeForPhoto, radarFittedAvatarSize, radarGeometry, radarRangeRadii } from './welcomeRadarScene';
import { preferredPhoneProfileAvatarSize, profileAvatarDisplaySize, resolvePhoneProfileLayout } from './profileHubLayout';

it.each([
  [360, 620, 351],
  [384, 704, 383],
  [411, 780, 410],
  [432, 820, 440],
])('matches the Profile photo on a large %s dp phone without resizing its %s dp pane radar',
  (shortSide, paneHeight, radarSize) => {
    const profile = resolvePhoneProfileLayout({
      shortSide, paneHeight, isLandscape: false, diagonalInches: 6.9,
      rowCount: 9, gapCount: 5, bottomClearance: 8, frameOutset: () => 0,
    });
    const photoSize = profileAvatarDisplaySize(preferredPhoneProfileAvatarSize(shortSide, 6.9));
    expect(photoSize).toBe(profileAvatarDisplaySize(profile.avatarSize));
    const before = radarGeometry(radarSize, 111);
    const avatarSize = radarAvatarSizeForPhoto(radarSize, photoSize);
    const after = radarGeometry(radarSize, avatarSize);
    expect(radarFittedAvatarSize(radarSize, avatarSize)).toBe(photoSize);
    expect(after.size).toBe(before.size);
    expect(after.rDisc).toBe(before.rDisc);
    expect(after.rDash).toBe(before.rDash);
    const rings = radarRangeRadii(after, true);
    expect(rings[0]).toBeGreaterThan(after.rIn);
    expect(rings[1]).toBeLessThan(after.rDisc);
  },
);

it.each([96, 220, 328, 351, 383, 410, 560])(
  'preserves the existing rings for ordinary phones and tablets at %s dp', size => {
    const g = radarGeometry(size, size * 0.38);
    const s0 = fisheyeSource(g.rIn / g.rDisc, 0.45);
    const rings = radarRangeRadii(g);
    expect(rings).toHaveLength(2);
    rings.forEach((radius, i) => {
      expect(radius).toBeCloseTo(g.rDisc * fisheyeScreen(s0 + ((1 - s0) * (i + 1)) / 3, 0.45), 10);
    });
  },
);

it.each([96, 160, 220, 317, 328, 351, 383, 410, 440])(
  'keeps all range rings outside the unchanged avatar and inside the scale at %s dp', size => {
    const g = radarGeometry(size, Math.min(111, size * 0.36));
    const original = { ...g };
    const photoSize = radarFittedAvatarSize(size, g.a * 2);
    const rings = radarRangeRadii(g, true);
    expect(rings).toHaveLength(2);
    expect(rings[0]).toBeGreaterThan(g.rIn);
    expect(rings[1]).toBeGreaterThan(rings[0]);
    expect(rings[1]).toBeLessThan(g.rDisc - 7 * g.u);
    expect(rings[0] - g.rIn).toBeLessThanOrEqual(28 * g.u + 0.001);
    expect(g).toEqual(original);
    expect(radarFittedAvatarSize(size, g.a * 2)).toBe(photoSize);
  },
);

it.each([351, 383, 410])('closes the excessive first gap on large phones at %s dp', size => {
  const g = radarGeometry(size, 111);
  const before = radarRangeRadii(g);
  const after = radarRangeRadii(g, true);
  expect(after[0]).toBeLessThan(before[0]);
  expect(after[1]).toBeLessThan(before[1]);
});

it('keeps the four-interval radar unchanged when no avatar is set', () => {
  const g = radarGeometry(383, 0);
  expect(radarRangeRadii(g, true)).toEqual(radarRangeRadii(g));
  expect(radarRangeRadii(g)).toHaveLength(3);
});

it('does not widen an already compact first gap', () => {
  const g = radarGeometry(220, 110);
  expect(radarRangeRadii(g, true)).toEqual(radarRangeRadii(g));
});
