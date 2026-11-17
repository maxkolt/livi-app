jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }));
jest.mock('@shopify/react-native-skia', () => ({ Skia: {
  Data: { fromURI: jest.fn() }, Image: { MakeImageFromEncoded: jest.fn() },
} }));

import { Asset } from 'expo-asset';
import { Skia } from '@shopify/react-native-skia';
import { loadBakedRing } from './bakedRing';

beforeEach(() => jest.clearAllMocks());
it('materializes a packaged Android resource instead of sending its bare name to Skia', async () => {
  const image = { texture: true };
  (Asset.fromModule as jest.Mock).mockReturnValue({ uri: 'assets_frames_icering256',
    downloadAsync: async () => ({ localUri: 'file:///cache/ice-ring.png' }) });
  (Skia.Data.fromURI as jest.Mock).mockResolvedValue('encoded');
  (Skia.Image.MakeImageFromEncoded as jest.Mock).mockReturnValue(image);
  expect(await loadBakedRing(10)).toBe(image);
  expect(Skia.Data.fromURI).toHaveBeenCalledWith('file:///cache/ice-ring.png');
});
it('coalesces concurrent users of a frame and releases a failed load for retry', async () => {
  const download = jest.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue({ localUri: 'file:///cache/ring.png' });
  (Asset.fromModule as jest.Mock).mockReturnValue({ downloadAsync: download });
  const a = loadBakedRing(11), b = loadBakedRing(11);
  expect(a).toBe(b);expect(await a).toBeNull();expect(download).toHaveBeenCalledTimes(1);
  await loadBakedRing(11);expect(download).toHaveBeenCalledTimes(2);
});
it('does not invoke the native decoder when an asset cannot be materialized', async () => {
  (Asset.fromModule as jest.Mock).mockReturnValue({ downloadAsync: async () => ({ localUri: null, uri: 'missing_resource' }) });
  expect(await loadBakedRing(12)).toBeNull();expect(Skia.Data.fromURI).not.toHaveBeenCalled();
});
