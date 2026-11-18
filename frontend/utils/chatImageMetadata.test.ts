import { normalizeChatImageMetadata } from './chatImageMetadata';

it('rejects partial, nonfinite and oversized geometry before durable enqueue', () => {
  for (const imageWidth of [0, -1, NaN, Infinity, 32769, 12.5, '900', undefined]) {
    expect(normalizeChatImageMetadata('image', { imageWidth, imageHeight: 1600 }, ['a'])).toEqual({});
  }
  expect(normalizeChatImageMetadata('image', { imageWidth: 900, imageHeight: 1600 }, ['a'])).toEqual({ imageWidth: 900, imageHeight: 1600 });
});

it('preserves sparse album positions when URI normalization or selection changes their order', () => {
  const payload = { uris: ['portrait', '', 'unknown', 'landscape'], imageWidth: 900, imageHeight: 1600,
    imageSizes: [{ width: 900, height: 1600 }, null, null, { width: 1600, height: 900 }] };
  expect(normalizeChatImageMetadata('image', payload, ['landscape'])).toEqual({ imageWidth: 1600, imageHeight: 900 });
  expect(normalizeChatImageMetadata('image', payload, ['unknown', 'landscape']))
    .toEqual({ imageSizes: [null, { width: 1600, height: 900 }] });
});
