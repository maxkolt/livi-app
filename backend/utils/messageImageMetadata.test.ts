import { normalizeMessageImageMetadata } from './messageImageMetadata';

it('accepts complete bounded dimensions and rejects invalid or partial pairs', () => {
  expect(normalizeMessageImageMetadata('image', { imageWidth: 900, imageHeight: 1600 }, ['a']))
    .toEqual({ imageWidth: 900, imageHeight: 1600 });
  for (const imageWidth of [0, -1, NaN, Infinity, 32769, 1.5, '900', null, undefined]) {
    expect(normalizeMessageImageMetadata('image', { imageWidth, imageHeight: 1600 }, ['a'])).toEqual({});
  }
  expect(normalizeMessageImageMetadata('audio', { imageWidth: 900, imageHeight: 1600 }, ['a'])).toEqual({});
});

it('keeps sizes aligned after filtering duplicate or empty album URIs', () => {
  const result = normalizeMessageImageMetadata('image', {
    uris: ['a', '', 'a', 'b', 'c'],
    imageSizes: [{ width: 800, height: 1200 }, null, { width: 1, height: 1 }, null, { width: 1800, height: 900 }],
  }, ['a', 'b', 'c']);
  expect(result).toEqual({ imageWidth: 800, imageHeight: 1200, imageSizes: [{ width: 800, height: 1200 }, null, { width: 1800, height: 900 }] });
});

it('remaps remaining album photos without assigning removed-first-photo dimensions to an unknown photo', () => {
  const payload = {
    uris: ['portrait', 'unknown', 'landscape'], imageWidth: 900, imageHeight: 1600,
    imageSizes: [{ width: 900, height: 1600 }, null, { width: 1600, height: 900 }],
  };
  expect(normalizeMessageImageMetadata('image', payload, ['landscape'])).toEqual({ imageWidth: 1600, imageHeight: 900 });
  expect(normalizeMessageImageMetadata('image', payload, ['unknown', 'landscape']))
    .toEqual({ imageSizes: [null, { width: 1600, height: 900 }] });
  expect(normalizeMessageImageMetadata('image', { uri: 'old', imageWidth: 900, imageHeight: 1600 }, ['new'])).toEqual({});
});
