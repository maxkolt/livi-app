module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      'react-native-reanimated/plugin', // must be last
    ],
    env: {
      production: {
        // No raw device logs in release; privacy-filtered diagnostics remain opt-in.
        plugins: [['transform-remove-console', { exclude: [] }]],
      },
    },
  };
};