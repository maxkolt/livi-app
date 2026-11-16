let mockRevealed = false;
let mockRefCursor = 0;
let mockRefs: Array<{ current: any }> = [];
const mockGesture = {
  enabled: jest.fn().mockReturnThis(), activeOffsetX: jest.fn().mockReturnThis(),
  failOffsetY: jest.fn().mockReturnThis(), onEnd: jest.fn().mockReturnThis(),
  onStart: jest.fn().mockReturnThis(), onUpdate: jest.fn().mockReturnThis(), onFinalize: jest.fn().mockReturnThis(),
};
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useRef: (initial: unknown) => mockRefs[mockRefCursor++] ||= { current: initial },
  useState: () => [mockRevealed, (value: boolean) => { mockRevealed = value; }],
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}));
jest.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value, absoluteFillObject: {}, hairlineWidth: 1 } }));
jest.mock('react-native-gesture-handler', () => ({ GestureDetector: 'GestureDetector', Gesture: { Pan: () => mockGesture } }));
jest.mock('react-native-reanimated', () => ({
  __esModule: true, default: { View: 'AnimatedView' },
  useSharedValue: (initial: unknown) => (mockRefs[mockRefCursor++] ||= { current: { value: initial } }).current,
  useAnimatedStyle: (fn: () => object) => fn(), withTiming: (value: number) => value,
  cancelAnimation: jest.fn(), runOnJS: (fn: unknown) => fn,
}));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'Gradient' }));
jest.mock('../../components/AppDialog', () => ({ AppDialogButton: 'AppDialogButton' }));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
jest.mock('./constants', () => ({ WELCOME_GLASS_SURFACE: '#2E3540' }));
import { CosmeticSwipeRow } from './CosmeticSwipeRow';

const remove = jest.fn(), reveal = jest.fn(), close = jest.fn();
function render(disabled = false) {
  mockRefCursor = 0;
  const tree = CosmeticSwipeRow({ children: 'row', deleteLabel: 'Удалить', accessibilityLabel: 'Неон: Удалить', disabled, onDelete: remove, onReveal: reveal, onClose: close });
  const root = tree.props.children;
  const [tint, content, panel] = root.props.children;
  return { tree, root, tint, content, panel, dismiss: panel.props.children[0], button: panel.props.children[1] };
}
const swipe = (translationX: number) => mockGesture.onEnd.mock.calls.at(-1)![0]({ translationX });
beforeEach(() => { mockRevealed = false; mockRefs = []; jest.clearAllMocks(); });
it('keeps deletion hidden and noninteractive before a left swipe', () => {
  const { panel, button } = render();
  expect(panel.props).toMatchObject({ pointerEvents: 'none', accessibilityElementsHidden: true });
  expect(button.props.disabled).toBe(true);
  button.props.onPress();
  expect(remove).not.toHaveBeenCalled();
});
it('reveals only the compact danger button and closes before confirmation', () => {
  render(); swipe(-80);
  const { content, tint, button } = render();
  expect(content.props).toMatchObject({ pointerEvents: 'none', accessibilityElementsHidden: true, style: { opacity: 0 } });
  expect(tint.props.style[1].opacity).toBe(1);
  expect(button.props).toMatchObject({ variant: 'danger', iconSize: 38, disabled: false });
  expect(button.props.icon.props.name).toBe('trash-can-outline');
  button.props.onPress();
  expect(close).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(render().button.props.disabled).toBe(true);
});
it('keeps the whole-row gesture available for repeated open/close cycles and cancellation', () => {
  render();
  for (let i = 0; i < 8; i++) {
    swipe(-80); expect(render().content.props.style.opacity).toBe(0);
    swipe(80); expect(render().content.props.style.opacity).toBe(1);
  }
  swipe(-80); render().dismiss.props.onPress();
  swipe(-80); expect(render().button.props.disabled).toBe(false);
  reveal.mock.calls.at(-1)![0].close();
  swipe(-80); expect(render().button.props.disabled).toBe(false);
  expect(remove).not.toHaveBeenCalled();
});
it('ignores short drags and disables gestures and actions while busy', () => {
  render(); swipe(-10); expect(mockRevealed).toBe(false);
  render(); swipe(-80);
  const { button } = render(true);
  expect(mockGesture.enabled).toHaveBeenLastCalledWith(false);
  button.props.onPress(); swipe(80);
  expect(remove).not.toHaveBeenCalled();
  expect(mockRevealed).toBe(true);
});
it('follows the finger in both directions before release without enabling deletion', () => {
  render();
  mockGesture.onStart.mock.calls.at(-1)![0]();
  mockGesture.onUpdate.mock.calls.at(-1)![0]({ translationX: -48 });
  const halfway = render();
  expect(halfway.content.props.style).toMatchObject({ opacity: 0.5, transform: [{ translateX: -24 }] });
  expect(halfway.tint.props.style[1].opacity).toBe(0.5);
  expect(halfway.button.props.disabled).toBe(true);
  mockGesture.onUpdate.mock.calls.at(-1)![0]({ translationX: -24 });
  expect(render().content.props.style.opacity).toBe(0.75);
  expect(reveal).not.toHaveBeenCalled();
  mockGesture.onFinalize.mock.calls.at(-1)![0]({}, false);
  expect(render().content.props.style.opacity).toBe(1);
  expect(remove).not.toHaveBeenCalled();
});
it('restores the open state when a closing drag is cancelled, then accepts another swipe', () => {
  render(); swipe(-80); render();
  mockGesture.onStart.mock.calls.at(-1)![0]();
  mockGesture.onUpdate.mock.calls.at(-1)![0]({ translationX: 48 });
  expect(render().content.props.style.opacity).toBe(0.5);
  mockGesture.onFinalize.mock.calls.at(-1)![0]({}, false);
  expect(render().content.props.style.opacity).toBe(0);
  swipe(80); expect(render().content.props.style.opacity).toBe(1);
  swipe(-80); expect(render().button.props.disabled).toBe(false);
});
