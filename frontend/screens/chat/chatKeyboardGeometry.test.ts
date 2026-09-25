import { resolveKeyboardAvoidance } from './chatKeyboardGeometry';

describe('resolveKeyboardAvoidance', () => {
  it('subtracts the safe-area already owned by the chat root', () => {
    expect(resolveKeyboardAvoidance({ screenY: 510, height: 334 }, 844, 34)).toBe(300);
  });

  it('tracks an extra keyboard panel while the keyboard stays open', () => {
    expect(resolveKeyboardAvoidance({ screenY: 450, height: 394 }, 844, 34)).toBe(360);
  });

  it('does not lift the bottom composer for a floating keyboard above it', () => {
    expect(resolveKeyboardAvoidance({ screenY: 500, height: 200 }, 844, 34)).toBe(0);
  });

  it('falls back to height if screenY is unavailable', () => {
    expect(resolveKeyboardAvoidance({ height: 334 }, 844, 34)).toBe(300);
  });
});
