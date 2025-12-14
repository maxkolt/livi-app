/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^@livekit/react-native-webrtc$': '<rootDir>/__mocks__/@livekit/react-native-webrtc.ts',
  },
  clearMocks: true,
  forceExit: true,
};
