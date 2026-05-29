import { Platform, ToastAndroid } from 'react-native';
import * as Sharing from 'expo-sharing';

/**
 * Save image to the user's gallery.
 * Android: no READ_MEDIA — opens share sheet (Save to Photos / Files).
 * iOS: expo-media-library (native module not linked on Android).
 */
export async function saveImageToGallery(localUri: string): Promise<void> {
  if (Platform.OS === 'android') {
    const available = await Sharing.isAvailableAsync();
    if (!available) throw new Error('Sharing not available');
    await Sharing.shareAsync(localUri, {
      mimeType: 'image/jpeg',
      dialogTitle: 'Save image',
    });
    ToastAndroid.show('Choose an app to save the image', ToastAndroid.SHORT);
    return;
  }

  const MediaLibrary = await import('expo-media-library');
  const perm = await MediaLibrary.requestPermissionsAsync();
  if (!perm.granted) throw new Error('No Photos permission');
  await MediaLibrary.saveToLibraryAsync(localUri);
}
