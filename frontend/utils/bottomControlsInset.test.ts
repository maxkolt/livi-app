import { bottomControlsInset } from './bottomControlsInset';

it.each([0, 8, 16, 24])('matches the button-navigation position for gesture inset %s', bottom => {
  expect(bottomControlsInset(bottom, 'android')).toBe(
    bottomControlsInset(48, 'android'),
  );
});
it('preserves larger real navigation bars', () => {
  expect(bottomControlsInset(56, 'android')).toBe(56);
});
it('preserves landscape side navigation and iOS', () => {
  expect(bottomControlsInset(0, 'android', true)).toBe(0);
  expect(bottomControlsInset(34, 'ios')).toBe(34);
});
