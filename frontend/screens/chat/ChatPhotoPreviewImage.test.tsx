import React from 'react';
jest.mock('expo-image', () => ({ Image: 'ExpoImage' }));
import { ChatPhotoPreviewImage, chatPhotoPreviewLayout, chatPhotoBubbleWidth } from './ChatPhotoPreviewImage';
import { albumGridLayout, CHAT_ALBUM_INSET } from './chatAlbum';

it('fills the compact photo frame proportionally without changing its source', () => {
  const source = { uri: 'file:///portrait.jpg', width: 900, height: 1600 };
  const style = { width: 252, height: 300 };
  const tree = ChatPhotoPreviewImage({ source, style, fit: 'cover' });
  expect(tree.props.contentFit).toBe('cover');
  expect(tree.props.placeholderContentFit).toBe('cover');
  expect(tree.props.source).toBe(source);
  expect(tree.props.style).toBe(style);
});

it.each([
  ['panorama', 6000, 1000],
  ['landscape', 1600, 900],
  ['portrait', 900, 1600],
  ['very tall screenshot', 1000, 9000],
  ['square', 1200, 1200],
  ['legacy unknown', undefined, undefined],
])('fits the complete %s image while preserving a stable message box', (_kind, width, height) => {
  const bounds = chatPhotoPreviewLayout(360, width && height ? { width, height } : null);
  const source = { uri: 'file:///photo.jpg', ...(width && height ? { width, height } : {}) };
  const onLoad = jest.fn();
  const tree = ChatPhotoPreviewImage({
    source,
    style: { width: bounds.width, height: bounds.height },
    onLoad,
    cachePolicy: 'memory-disk',
  });
  expect(React.isValidElement(tree)).toBe(true);
  expect(tree.type).toBe('ExpoImage');
  expect(tree.props.source).toBe(source);
  expect(tree.props.contentFit).toBe('contain');
  expect(tree.props.placeholderContentFit).toBe('contain');
  expect(tree.props.transition).toBe(0);
  expect(tree.props.style).toEqual({ width: bounds.width, height: bounds.height });
  tree.props.onLoad?.({ source: { width: width || 700, height: height || 1300 } });
  expect(onLoad).toHaveBeenCalledTimes(1);
  // Loading an unknown/remote image does not resize the active bubble.
  expect(tree.props.style).toEqual({ width: bounds.width, height: bounds.height });
});

it.each([240, 320, 360, 430, 720, 960])('reserves exact image and bubble bounds before loading at chat width %s', width => {
  const photo = chatPhotoPreviewLayout(width);
  expect(photo.width).toBeGreaterThan(0);
  expect(photo.height).toBe(Math.round(photo.width * 3 / 4));
  expect(photo.bubbleW).toBe(photo.width + CHAT_ALBUM_INSET * 2);
  const rowWidth = Math.min(Math.floor(width * 0.92), width - 32);
  expect(photo.bubbleW).toBeLessThanOrEqual(rowWidth * 0.8);
  expect(chatPhotoPreviewLayout(width)).toEqual(photo);
});

it.each([0, -1, NaN, Infinity])('uses valid stable bounds while chat width %s is not known', width => {
  expect(chatPhotoPreviewLayout(width)).toEqual(chatPhotoPreviewLayout(360));
});

it.each([2, 3, 4, 5, 6, 7, 8, 9, 10])('fits photos inside the existing %s-image album tiles without changing the grid', count => {
  const grid = albumGridLayout(360, count);
  const style = { width: grid.tile, height: grid.rowH };
  const tree = ChatPhotoPreviewImage({ source: { uri: 'https://api.test/photo.jpg', width: 1000, height: 5000 }, style });
  expect(tree.props.contentFit).toBe('contain');
  expect(tree.props.style).toBe(style);
  expect(grid.gridW).toBe(grid.tile * grid.cols + 2 * (grid.cols - 1));
});


it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])('keeps all %s-image content inside the Android quote highlight ring', count => {
  const imageWidth = count === 1 ? chatPhotoPreviewLayout(360).width : albumGridLayout(360, count).gridW;
  const ordinaryBubble = chatPhotoBubbleWidth(imageWidth);
  const highlightedBubble = chatPhotoBubbleWidth(imageWidth, 1);
  expect(highlightedBubble).toBe(ordinaryBubble + 2);
  expect(highlightedBubble - 2 * 1 - 2 * CHAT_ALBUM_INSET).toBe(imageWidth);
  // The ring adds outside space; neither photo nor grid size changes.
  expect(ordinaryBubble - 2 * CHAT_ALBUM_INSET).toBe(imageWidth);
});
