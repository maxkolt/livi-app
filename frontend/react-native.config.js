/** @type {import('@react-native-community/cli-types').Config} */
module.exports = {
  dependencies: {
    // Play policy: no READ_MEDIA_* on Android.
    // Pick: system Photo Picker (expo-image-picker). Save: MediaStore via LiviAppModule.
    // Keep expo-media-library linked on iOS only (write-only save / ph:// resolve).
    'expo-media-library': {
      platforms: {
        android: null,
      },
    },
  },
};
