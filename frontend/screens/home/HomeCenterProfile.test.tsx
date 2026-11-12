import React from 'react';
let mockFrame = '';
jest.mock('react', () => ({
  ...jest.requireActual('react'), memo: (component: unknown) => component,
  useState: (initial: unknown) => [initial, jest.fn()], useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn,
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' }, View: 'View', Text: 'Text', Pressable: 'Pressable' }));
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
jest.mock('../../components/AvatarImage', () => ({ __esModule: true, default: 'AvatarImage', activeFrameOutset: () => 2 }));
jest.mock('../../components/AvatarGlyph', () => ({ AvatarGlyph: 'Glyph' }));
jest.mock('../../sockets/socket', () => ({ getCurrentUserId: () => 'self' }));
jest.mock('../../utils/cosmetics', () => ({ useUserActiveFrame: () => mockFrame }));
jest.mock('./chrome', () => ({ ChromePerimeterGlow: 'Glow' }));
jest.mock('./constants', () => ({ CHROME_PERIMETER_GLOW_LAYOUT_INSET: 2, LIVI: { titan: '#fff' } }));
jest.mock('./AvatarDust', () => ({ AvatarDustHide: 'DustHide', avatarDustSourceKey: () => '' }));
import { HomeCenterProfile, hasProfilePhoto } from './HomeCenterProfile';

type Props = React.ComponentProps<typeof HomeCenterProfile>;
const props: Props = {
  styles: {} as Props['styles'], isDark: true, layoutWidth: 384,
  savedNick: 'New nickname', radarStage: true,
  avatarUri: 'file:///new-selection.jpg', myFullAvatarUri: 'file:///old-saved.jpg',
  myAvatarVer: 4, resolvedAvatarUri: 'file:///new-selection.jpg', resolvedAvatarReady: true,
  avatarVerChecked: true, menuChromeBg: '#181a20', onOpenAvatarModal: jest.fn(),
};
type ImageProps = { children?: React.ReactNode; uri?: string; source?: { uri: string } };
function find(node: React.ReactNode, type: string): React.ReactElement<ImageProps> | undefined {
  if (!React.isValidElement<ImageProps>(node)) return;
  if ((node.type as unknown) === type) return node;
  return React.Children.toArray(node.props.children).map(child => find(child, type)).find(Boolean);
}
beforeEach(() => { mockFrame = ''; });

it('shows the selected file on the first radar render while the saved full avatar is still old', () => {
  const tree = HomeCenterProfile(props);
  expect(find(tree, 'AvatarImage')?.props.uri).toBe('file:///new-selection.jpg');
});

it('shows the first selected avatar on Search before the server assigns its first version', () => {
  const tree = HomeCenterProfile({ ...props, myAvatarVer: 0, myFullAvatarUri: '' });
  expect(hasProfilePhoto(props.avatarUri, 0)).toBe(true);
  expect(find(tree, 'ExpoImage')?.props.source?.uri).toBe('file:///new-selection.jpg');
});

it('keeps the purchased frame around the selected photo on the first radar render', () => {
  mockFrame = 'fire';
  expect(find(HomeCenterProfile(props), 'AvatarImage')?.props.uri).toBe('file:///new-selection.jpg');
});
