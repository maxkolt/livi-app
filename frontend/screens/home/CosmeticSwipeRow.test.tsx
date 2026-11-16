let mockRevealed = false;
const mockHandle = { close: jest.fn() };
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useRef: () => ({ current: mockHandle }),
  useState: () => [mockRevealed, (value: boolean) => { mockRevealed = value; }],
}));
jest.mock('react-native', () => ({ StyleSheet: { create: (value: unknown) => value } }));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => ({ __esModule: true, default: 'Swipeable' }));
jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: 'AnimatedView' }, useAnimatedStyle: (fn: () => object) => fn() }));
jest.mock('../../components/AppDialog', () => ({ AppDialogButton: 'AppDialogButton' }));
jest.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: 'Icon' }));
jest.mock('./constants', () => ({ WELCOME_GLASS_SURFACE: '#2E3540' }));
import { CosmeticSwipeRow } from './CosmeticSwipeRow';

const remove = jest.fn(), reveal = jest.fn(), close = jest.fn();
function render(disabled = false) {
  const tree = CosmeticSwipeRow({ children: 'row', deleteLabel: 'Удалить', accessibilityLabel: 'Неон: Удалить', disabled, onDelete: remove, onReveal: reveal, onClose: close });
  const action = tree.props.renderRightActions({ value: 1 });
  const panel = action.type(action.props);
  return { tree, panel, button: panel.props.children };
}
beforeEach(() => { mockRevealed = false; jest.clearAllMocks(); });
it('keeps deletion hidden and noninteractive before a left swipe', () => {
  const { panel, button } = render();
  expect(panel.props).toMatchObject({ pointerEvents: 'none', accessibilityElementsHidden: true });
  expect(button.props.disabled).toBe(true);
  button.props.onPress();
  expect(remove).not.toHaveBeenCalled();
});
it('reveals the shared danger button after a swipe and closes the row before confirmation', () => {
  render().tree.props.onSwipeableWillOpen();
  expect(reveal).toHaveBeenCalledWith(mockHandle);
  const { panel, button } = render();
  expect(panel.props).toMatchObject({ pointerEvents: 'auto', accessibilityElementsHidden: false });
  expect(button.props).toMatchObject({ label: 'Удалить', variant: 'danger', stretch: false, disabled: false });
  expect(button.props.icon.props.name).toBe('trash-can-outline');
  button.props.onPress();
  expect(mockHandle.close).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
  render().tree.props.onSwipeableWillClose();
  expect(close).toHaveBeenCalledWith(mockHandle);
  expect(render().button.props.disabled).toBe(true);
});
it('disables swipes and deletion while another collection action is pending', () => {
  mockRevealed = true;
  const { tree, button } = render(true);
  expect(tree.props.enabled).toBe(false);
  button.props.onPress();
  expect(remove).not.toHaveBeenCalled();
});
