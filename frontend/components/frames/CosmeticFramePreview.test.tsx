jest.mock('../../assets/frames/showcase-avatar.jpg', () => 100);
jest.mock('../../assets/chat-wallpapers/dark/doodles-cyan.jpeg', () => 101);
jest.mock('../../assets/chat-wallpapers/dark/cosmos.jpeg', () => 102);
jest.mock('../../assets/chat-wallpapers/dark/pushkin.jpeg', () => 103);
jest.mock('../../assets/chat-wallpapers/dark/doodles-teal.jpeg', () => 104);
jest.mock('../../assets/chat-wallpapers/dark/letters.jpeg', () => 105);
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
jest.mock('./FireAvatarFrame', () => ({ FireAvatarFrame: 'FireAvatarFrame', fireFrameOutset: () => 6 }));
jest.mock('./IceAvatarFrame', () => ({ IceAvatarFrame: 'IceAvatarFrame' }));
jest.mock('./DiamondAvatarFrame', () => ({ DiamondAvatarFrame: 'DiamondAvatarFrame' }));

import React from 'react';
import { CosmeticFramePreview } from './CosmeticFramePreview';
import { CHAT_BACKGROUND_CATALOG, FRAME_CATALOG, getCosmeticBackground, getCosmeticFrame } from '../../utils/cosmeticCatalog';

type PreviewProps = {
  size: number;
  photoSize: number;
  active?: boolean;
  colors?: readonly string[];
  style: { width: number; height: number; padding: number; backgroundColor?: string };
  children: React.ReactElement<{ onLoad?: () => void; style: PreviewProps['style'] }>;
};

it('keeps the three completed frames first and the other five unavailable', () => {
  expect(FRAME_CATALOG.map(item => item.key)).toEqual(['fire', 'diamond', 'frost', 'aurora', 'palladium', 'jade', 'void', 'obsidian']);
  expect(FRAME_CATALOG.filter(item => item.available).map(item => item.key)).toEqual(['fire', 'diamond', 'frost']);
});

it('keeps all five background images and their chat wallpaper mapping', () => {
  expect(CHAT_BACKGROUND_CATALOG.map(({ key, source, wallpaperId }) => [key, source, wallpaperId])).toEqual([
    ['aurora-chat', 101, 'dark-doodles-cyan'], ['deep-space', 102, 'dark-cosmos'],
    ['poetry', 103, 'dark-pushkin'], ['ocean-flow', 104, 'dark-doodles-teal'],
    ['graphite-chat', 105, 'dark-letters'],
  ]);
  expect(getCosmeticBackground('unknown')).toBeUndefined();
  expect(getCosmeticFrame('unknown')).toBeUndefined();
});

it.each([['fire', 'FireAvatarFrame'], ['frost', 'IceAvatarFrame'], ['diamond', 'DiamondAvatarFrame']])(
  'keeps the live renderer, photo inset, animation flag and ready callback for %s', (itemId, renderer) => {
    const onLoad = jest.fn();
    const tree = CosmeticFramePreview({ itemId, size: 106, active: false, onLoad }) as React.ReactElement<PreviewProps>;
    expect(tree.type).toBe(renderer);
    expect(tree.props).toMatchObject({ size: 106, photoSize: 94, active: false });
    tree.props.children.props.onLoad?.();
    expect(onLoad).toHaveBeenCalledTimes(1);
  },
);

it('preserves the different ring thicknesses and avatar backgrounds in purchases and showcase', () => {
  const purchase = CosmeticFramePreview({ itemId: 'aurora', size: 48, ringWidth: 3 }) as React.ReactElement<PreviewProps>;
  expect(purchase.props.colors).toEqual(['#7CF5C8', '#5AA9FF', '#3B82F6']);
  expect(purchase.props.style).toMatchObject({ width: 48, height: 48, padding: 3 });
  expect(purchase.props.children.props.style).toMatchObject({ width: 42, height: 42 });
  const showcase = CosmeticFramePreview({ itemId: 'aurora', size: 70, avatarBackgroundColor: '#0B1219' }) as React.ReactElement<PreviewProps>;
  expect(showcase.props.style.padding).toBe(2);
  expect(showcase.props.children.props.style).toMatchObject({ width: 66, height: 66, backgroundColor: '#0B1219' });
  const fallback = <React.Fragment>unavailable</React.Fragment>;
  expect(CosmeticFramePreview({ itemId: 'unknown', size: 48, fallback })).toBe(fallback);
});
