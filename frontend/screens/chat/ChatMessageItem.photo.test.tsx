import React from 'react';
import { Animated } from 'react-native';
jest.mock('react', () => ({
  ...jest.requireActual('react'), memo: (component: unknown) => component,
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, jest.fn()],
  useRef: (current: unknown) => ({ current }), useEffect: () => {},
  useCallback: (callback: unknown) => callback, useMemo: (factory: () => unknown) => factory(),
}));
jest.mock('react-native', () => ({
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable',
  Animated: { View: 'AnimatedView', Value: class {} }, Platform: { OS: 'android' }, Dimensions: { get: () => ({ width: 360, height: 780 }) },
  StyleSheet: { absoluteFill: {}, absoluteFillObject: {} },
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon', MaterialCommunityIcons: 'MaterialIcon' }));
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
jest.mock('expo-file-system', () => ({}));
jest.mock('react-native-svg', () => ({ __esModule: true, default: 'Svg', Circle: 'Circle', Defs: 'Defs', LinearGradient: 'Gradient', Stop: 'Stop', G: 'G', Path: 'Path' }));
jest.mock('../../hooks/useResolvedImageUri', () => ({ useResolvedImageUri: () => ['', true] }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../utils/i18n', () => ({ t: (key: string) => key }));
jest.mock('../../components/chatStickers', () => ({ StickerView: 'Sticker', getBuiltInSticker: () => null }));
jest.mock('./chatMessageIds', () => ({ isOfflineQueuedOrOptimisticOutgoingId: () => false }));
jest.mock('../home/constants', () => ({ LIVI: { green: '#0f0' }, UI_ACCENT: '#62b0d8', UI_ACCENT_PRESSED: '#62b0d8' }));
jest.mock('./ChatAlbumGrid', () => ({ ChatAlbumGrid: 'AlbumGrid' }));
jest.mock('./ChatReplyQuoteAccent', () => ({ ChatReplyQuoteAccent: 'Reply' }));
jest.mock('../fliq/fliqLinks', () => ({ findFliqLink: () => null, isOnlyFliqLink: () => false }));
jest.mock('../fliq/FliqLinkCard', () => ({ FliqLinkCard: 'FliqCard' }));
jest.mock('./ChatVideoNote', () => ({ CHAT_VIDEO_NOTE_SIZE: 132, ChatVideoNote: 'VideoNote' }));

import { ChatMessageItem } from './ChatMessageItem';
import { ChatPhotoPreviewImage } from './ChatPhotoPreviewImage';
import { ChatMessageText } from './ChatMessageText';

function flatten(node: React.ReactNode): React.ReactElement<Record<string, unknown>>[] {
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node as React.ReactElement<Record<string, unknown>>, ...React.Children.toArray(node.props.children).flatMap(flatten)];
}
function renderPhoto(album = false, caption = 'Подпись к фотографии', options: { isOwn?: boolean; groupedAbove?: boolean; highlighted?: boolean; type?: 'image' | 'text' } = {}) {
  return ChatMessageItem({
    item: { id: 'photo-1', timestamp: '2026-11-18T10:00:00Z', type: options.type || 'image', groupedWithPrev: !!options.groupedAbove, uri: 'https://photo.test/1.jpg',
      ...(album ? { uris: ['https://photo.test/1.jpg', 'https://photo.test/2.jpg'] } : {}),
      imageWidth: 900, imageHeight: 1600, text: caption, sender: options.isOwn === false ? 'peer' : 'me',
    },
    currentUserId: 'me', onPressImage: jest.fn(), playingAudioId: null, playingAudioState: null,
    onLongPressMessage: jest.fn(), selectionMode: false, isSelected: false, retryUiForId: null,
    resolveMediaUri: (uri?: string) => uri || '', highlightedMessageId: options.highlighted === false ? null : 'photo-1',
    animateMessagePress: jest.fn(), getMessageAnimation: () => new Animated.Value(1), formatDurationDot: () => '',
    BUBBLE_BG_OUT: '#123', BUBBLE_BG_IN: '#234',
    LIVI: { white: '#fff', titan: '#aaa', red: '#f00', text: '#fff', feedBg: '#111', replyQuoteAccent: '#aaa', replyQuotePressBg: '#111', replyHighlightAccent: '#62b0d8' },
    isDark: true, lang: 'ru', layoutWidth: 360,
  });
}

it.each([false, true])('places one caption below the photo/grid inside the same bubble (album=%s)', album => {
  const nodes = flatten(renderPhoto(album));
  const imageAt = nodes.findIndex(node => album ? node.type === 'AlbumGrid' : node.type === ChatPhotoPreviewImage);
  const captions = nodes.filter(node => node.type === ChatMessageText);
  expect(imageAt).toBeGreaterThan(-1);
  expect(captions).toHaveLength(1);
  expect(captions[0].props.text).toBe('Подпись к фотографии');
  expect(nodes.indexOf(captions[0])).toBeGreaterThan(imageAt);
  const bubble = nodes.find(node => node.props.testID === 'chat-message-photo-1');
  expect(bubble).toBeDefined();
  expect(flatten(bubble!).filter(node => node.type === ChatMessageText)).toHaveLength(1);
});

it('keeps the established portrait width in a shorter frame with room for highlighting', () => {
  const nodes = flatten(renderPhoto());
  const container = nodes.find(node => node.type === 'TouchableOpacity' && node.props.children &&
    flatten(node).some(child => child.type === ChatPhotoPreviewImage))!;
  const style = container.props.style as { width: number; height: number };
  expect(style.width).toBe(252);
  expect(style.height).toBe(300);
  expect(nodes.find(node => node.type === ChatPhotoPreviewImage)!.props.allowDownscaling).toBe(true);
  expect(nodes.find(node => node.type === ChatPhotoPreviewImage)!.props.fit).toBe('cover');
  const outerBubble = nodes.find(node => {
    const bounds = node.props.style as { width?: number; maxWidth?: number } | undefined;
    return typeof bounds?.width === 'number' && bounds.maxWidth === bounds.width;
  })!;
  expect((outerBubble.props.style as { width: number }).width).toBe(style.width + 8 + 2);
});

it('does not create an empty caption below a photo', () => {
  expect(flatten(renderPhoto(false, '  ')).filter(node => node.type === ChatMessageText)).toHaveLength(0);
});


type CornerStyle = { borderTopLeftRadius: number; borderTopRightRadius: number; borderBottomLeftRadius?: number; borderBottomRightRadius?: number };
function cornerStyles(tree: React.ReactNode): CornerStyle[] {
  return flatten(tree).flatMap(node => {
    const value = typeof node.props.style === 'function' ? node.props.style({ pressed: false }) : node.props.style;
    return (Array.isArray(value) ? value : [value]).filter((style): style is CornerStyle =>
      !!style && typeof style === 'object' && 'borderTopLeftRadius' in style && 'borderTopRightRadius' in style);
  });
}

it.each([true, false].flatMap(isOwn => [true, false].flatMap(groupedAbove =>
  [true, false].flatMap(album => [true, false].map(highlighted => ({ isOwn, groupedAbove, album, highlighted }))),
)))('keeps both photo bubble top corners rounded: %j', options => {
  const corners = cornerStyles(renderPhoto(options.album, 'Подпись', options));
  expect(corners.length).toBeGreaterThan(0);
  for (const style of corners) {
    expect(style.borderTopLeftRadius).toBe(style.borderTopRightRadius);
    expect([12, ...(options.highlighted ? [13] : [])]).toContain(style.borderTopLeftRadius);
  }
});

it.each([true, false])('preserves text grouping and the bottom tail while rounding photo tops (isOwn=%s)', isOwn => {
  const photoCorners = cornerStyles(renderPhoto(false, 'Фото', { isOwn, groupedAbove: true, highlighted: false }))[0];
  const textCorners = cornerStyles(renderPhoto(false, 'Текст', { isOwn, groupedAbove: true, highlighted: false, type: 'text' }))[0];
  expect(isOwn ? textCorners.borderTopRightRadius : textCorners.borderTopLeftRadius).toBe(6);
  expect(isOwn ? textCorners.borderTopLeftRadius : textCorners.borderTopRightRadius).toBe(17);
  expect(photoCorners.borderBottomLeftRadius).toBe(textCorners.borderBottomLeftRadius);
  expect(photoCorners.borderBottomRightRadius).toBe(textCorners.borderBottomRightRadius);
});


it.each([true, false])('keeps a uniform four-dp band around both upper photo corners (isOwn=%s)', isOwn => {
  const tree = renderPhoto(false, 'Фото', { isOwn, groupedAbove: true, highlighted: false });
  const nodes = flatten(tree);
  const bubble = nodes.find(node => node.props.testID === 'chat-message-photo-1')!;
  const bubbleStyle = (bubble.props.style as (state: { pressed: boolean }) => Array<Record<string, number>>)({ pressed: false })[0];
  const photo = nodes.find(node => node.type === 'TouchableOpacity' &&
    flatten(node).some(child => child.type === ChatPhotoPreviewImage))!;
  const inner = photo.props.style as { borderRadius: number };
  expect(inner.borderRadius).toBe(8); // Existing photo content mask is preserved.
  expect(bubbleStyle.paddingTop).toBe(4);
  expect(bubbleStyle.paddingHorizontal).toBe(4);
  expect(bubbleStyle.borderTopLeftRadius - inner.borderRadius).toBe(bubbleStyle.paddingHorizontal);
  expect(bubbleStyle.borderTopRightRadius - inner.borderRadius).toBe(bubbleStyle.paddingTop);
  // Equal centers plus a radius difference equal to the inset form a uniform circular band.
  expect(bubbleStyle.paddingHorizontal + inner.borderRadius).toBe(bubbleStyle.borderTopLeftRadius);
  expect(bubbleStyle.paddingTop + inner.borderRadius).toBe(bubbleStyle.borderTopRightRadius);
});
