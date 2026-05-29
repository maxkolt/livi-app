/** @type {import('@react-native-community/cli-types').Config} */
module.exports = {
  dependencies: {
    // Play policy: no READ_MEDIA_* — gallery via system Photo Picker (expo-image-picker).
    'expo-media-library': {
      platforms: {
        android: null,
      },
    },
  },
};
