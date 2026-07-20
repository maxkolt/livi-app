import { NativeModules, Platform } from 'react-native';

/**
 * Save image directly to the device gallery (no share / app picker).
 * - Android: MediaStore via LiviAppModule (no READ_MEDIA_* — Play policy).
 * - iOS: expo-media-library write-only (add-to-library).
 */
export async function saveImageToGallery(localUri: string): Promise<void> {
  const uri = (localUri || '').trim();
  if (!uri) throw new Error('No image uri');

  if (Platform.OS === 'android') {
    const mod = NativeModules.LiviAppModule as
      | { saveImageToGallery?: (u: string) => Promise<boolean> }
      | undefined;
    if (!mod?.saveImageToGallery) {
      throw new Error('saveImageToGallery unavailable — rebuild Android app');
    }
    await mod.saveImageToGallery(uri);
    return;
  }

  const MediaLibrary = await import('expo-media-library');
  // writeOnly: iOS — only add-to-library permission.
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) throw new Error('No Photos permission');
  await MediaLibrary.saveToLibraryAsync(uri);
}
