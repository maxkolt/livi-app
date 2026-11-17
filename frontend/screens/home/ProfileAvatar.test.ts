jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
import { profileAvatarDeleteInset } from './ProfileAvatar';

// Small phone, wide phone, tablet and frame outsets in portrait/landscape.
it.each([
  [96, 36], [108, 36], [120, 36], [137, 36], [144, 36],
  [152, 36], [132, 38], [148, 38], [156, 38], [180, 38],
])('keeps the delete badge on the lower-right circular edge at %s/%s dp', (diameter, size) => {
  const inset = profileAvatarDeleteInset(diameter, size);
  const center = diameter - inset - size / 2;
  expect(center).toBeGreaterThan(diameter / 2);
  const distance = Math.hypot(center - diameter / 2, center - diameter / 2);
  // The badge center stays outside the photo/frame, while the inner edge overlaps.
  expect(distance).toBeGreaterThan(diameter / 2);
  const overlap = diameter / 2 - (distance - size / 2);
  expect(overlap).toBeGreaterThan(0);
  expect(overlap).toBeLessThan(size / 4);
});
