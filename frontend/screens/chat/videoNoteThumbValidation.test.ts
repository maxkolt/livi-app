jest.mock('@shopify/react-native-skia', () => ({
  Skia: { Data: { fromURI: jest.fn() }, Image: { MakeImageFromEncoded: jest.fn() } },
  ColorType: { RGBA_8888: 4 }, AlphaType: { Unpremul: 3 },
}));

import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { isSolidGreenVideoNoteThumb, isVideoNoteThumbUsable } from './videoNoteThumbValidation';

function pixelsFor(color: (x: number, y: number) => number[]): Uint8Array {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) pixels.set(color(x, y), (y * 32 + x) * 4);
  }
  return pixels;
}

describe('solid green video-note thumbnails', () => {
  it.each([64, 128, 255])('rejects a uniform decoder-green frame with G=%i', green => {
    expect(isSolidGreenVideoNoteThumb(pixelsFor(() => [0, green, 0, 255]), 32, 32)).toBe(true);
  });

  it('tolerates small JPEG color variations in a corrupted frame', () => {
    const pixels = pixelsFor((x, y) => [x % 3, 128 + y % 5, y % 3, 255]);
    expect(isSolidGreenVideoNoteThumb(pixels, 32, 32)).toBe(true);
  });

  it.each([
    ['black', [0, 0, 0, 255]], ['blue', [0, 0, 255, 255]],
    ['white', [255, 255, 255, 255]], ['skin', [184, 132, 97, 255]],
  ])('keeps legitimate %s frames', (_name, color) => {
    expect(isSolidGreenVideoNoteThumb(pixelsFor(() => color as number[]), 32, 32)).toBe(false);
  });

  it('keeps a textured green scene', () => {
    expect(isSolidGreenVideoNoteThumb(pixelsFor((x, y) => [8, 80 + (x + y) % 100, 12, 255]), 32, 32)).toBe(false);
  });

  it('keeps a person against a mostly green background', () => {
    const pixels = pixelsFor((x, y) => x >= 12 && x <= 20 && y >= 8 && y <= 24
      ? [180, 130, 95, 255] : [0, 128, 0, 255]);
    expect(isSolidGreenVideoNoteThumb(pixels, 32, 32)).toBe(false);
  });
});

describe('validation of the saved JPEG', () => {
  let data: { dispose: jest.Mock };
  let image: { width: jest.Mock; height: jest.Mock; readPixels: jest.Mock; dispose: jest.Mock };
  beforeEach(() => {
    data = { dispose: jest.fn() };
    image = {
      width: jest.fn(() => 32), height: jest.fn(() => 32), dispose: jest.fn(),
      readPixels: jest.fn(() => pixelsFor(() => [184, 132, 97, 255])),
    };
    (Skia.Data.fromURI as jest.Mock).mockResolvedValue(data);
    (Skia.Image.MakeImageFromEncoded as jest.Mock).mockReturnValue(image);
  });

  it('reads the final encoded JPEG with explicit RGBA byte ordering and frees native objects', async () => {
    expect(await isVideoNoteThumbUsable('file:///thumbnail.jpg')).toBe(true);
    expect(Skia.Data.fromURI).toHaveBeenCalledWith('file:///thumbnail.jpg');
    expect(image.readPixels).toHaveBeenCalledWith(0, 0, {
      width: 32, height: 32, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul,
    });
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(data.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a green saved JPEG', async () => {
    image.readPixels.mockReturnValue(pixelsFor(() => [0, 128, 0, 255]));
    expect(await isVideoNoteThumbUsable('file:///green.jpg')).toBe(false);
  });

  it('rejects undecodable JPEG data', async () => {
    (Skia.Image.MakeImageFromEncoded as jest.Mock).mockReturnValue(null);
    expect(await isVideoNoteThumbUsable('file:///broken.jpg')).toBe(false);
    expect(data.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([null, new Uint8Array(4), new Float32Array(32 * 32 * 4)])('rejects unreadable or unexpected pixel buffers: %p', async pixels => {
    image.readPixels.mockReturnValue(pixels);
    expect(await isVideoNoteThumbUsable('file:///unreadable.jpg')).toBe(false);
  });

  it.each([0, 10000])('does not allocate pixels for an invalid width: %i', async width => {
    image.width.mockReturnValue(width);
    expect(await isVideoNoteThumbUsable('file:///invalid.jpg')).toBe(false);
    expect(image.readPixels).not.toHaveBeenCalled();
  });

  it('cleans up native objects even if pixel reading throws', async () => {
    image.readPixels.mockImplementation(() => { throw new Error('read failed'); });
    await expect(isVideoNoteThumbUsable('file:///failed.jpg')).rejects.toThrow('read failed');
    expect(image.dispose).toHaveBeenCalledTimes(1);
    expect(data.dispose).toHaveBeenCalledTimes(1);
  });
});
