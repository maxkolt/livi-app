import { Skia, type SkImage } from '@shopify/react-native-skia';
import { subscribeMemoryPressure } from '../../utils/memoryPressure';
import { FliqAmbientCache } from './fliqAmbientCache';

export const fliqAmbientImages = new FliqAmbientCache<SkImage>({
  load: async (url, isCurrent) => {
    const data = await Skia.Data.fromURI(url);
    try {
      return isCurrent() ? Skia.Image.MakeImageFromEncoded(data) : null;
    } finally {
      // MakeImageFromEncoded retains its own native reference when needed.
      data.dispose();
    }
  },
});
subscribeMemoryPressure(() => fliqAmbientImages.clear());

export function prefetchFliqAmbient(urls: string[]): void {
  fliqAmbientImages.prefetch(urls);
}
