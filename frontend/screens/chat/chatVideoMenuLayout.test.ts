import { chatVideoMenuLayout } from './chatVideoMenuLayout';

it.each([240, 300, 400, 600])('fits the full video preview and scrolling actions above the keyboard (stack=%s)', height => {
  const result = chatVideoMenuLayout(height, 58, 10, 298);
  expect(result.previewMaxHeight).toBeGreaterThan(0);
  expect(result.previewMaxHeight).toBeLessThanOrEqual(112);
  expect(58 + 20 + Math.min(298, result.listMaxHeight) + result.previewMaxHeight).toBeLessThanOrEqual(height);
  if (height <= 400) expect(result.listMaxHeight).toBeLessThan(298);
});

it('gives a short menu its natural height and keeps a recognisable preview', () => {
  expect(chatVideoMenuLayout(400, 58, 10, 104).previewMaxHeight).toBe(112);
});

it('keeps geometry nonnegative if the reaction panel fills all available height', () => {
  expect(chatVideoMenuLayout(80, 80, 10, 298)).toEqual({ listMaxHeight: 0, previewMaxHeight: 0 });
});
