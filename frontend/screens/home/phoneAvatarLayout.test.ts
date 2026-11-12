import { usesLargePhoneAvatar } from './phoneAvatarLayout';

it.each([
  [360, 4, 'SM-S938B'],
  [360, 3, 'SM-S938B'],
  [384, 2.8125, 'SM-S938B'],
  [411, 3.5, 'SM-S938B'],
  [360, 4, 'other-large-QHD-phone'],
  [448, 3, 'other-large-phone'],
])('selects the S25-sized layout despite display density: %s dp, %s density, %s', (width, density, model) => {
  expect(usesLargePhoneAvatar(width, density, model)).toBe(true);
});

it.each([
  [384, 2.8125, 'SM-A356E'],
  [432, 2.5, 'SM-A356B'],
  [360, 3, 'SM_A356E'],
  [320, 3, 'smaller-phone'],
  [360, 3, 'same-size-phone'],
  [384, 2.8125, 'same-size-phone'],
  [393, 3, 'smaller-than-wide-layout'],
])('preserves A35-sized avatars: %s dp, %s density, %s', (width, density, model) => {
  expect(usesLargePhoneAvatar(width, density, model)).toBe(false);
});

it('handles missing model/density metadata with the width fallback', () => {
  expect(usesLargePhoneAvatar(360, Number.NaN, null)).toBe(false);
  expect(usesLargePhoneAvatar(411, Number.NaN, null)).toBe(true);
});
