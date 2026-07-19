/**
 * Save image directly to the device gallery (no share / app picker).
 */
export async function saveImageToGallery(localUri: string): Promise<void> {
  const MediaLibrary = await import('expo-media-library');
  // writeOnly: iOS — only add-to-library; Android — request write (+ read when required by OS).
  const perm = await MediaLibrary.requestPermissionsAsync(true);
  if (!perm.granted) throw new Error('No Photos permission');
  await MediaLibrary.saveToLibraryAsync(localUri);
}
