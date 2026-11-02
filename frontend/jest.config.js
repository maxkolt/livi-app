/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  // Unit tests render component element trees in Node; the app's "react-native" JSX stays uncompiled there.
  transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react' } }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
  roots: ['<rootDir>'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^@livekit/react-native-webrtc$': '<rootDir>/__mocks__/@livekit/react-native-webrtc.ts',
    '^expo-device$': '<rootDir>/__mocks__/expo-device.ts',
    '^@react-native-community/netinfo$': '<rootDir>/__mocks__/@react-native-community/netinfo.ts',
    '^react-native-incall-manager$': '<rootDir>/__mocks__/react-native-incall-manager.ts',
    '^@react-navigation/native$': '<rootDir>/__mocks__/@react-navigation/native.ts',
  },
  clearMocks: true,
  watchman: false,
  forceExit: true,
};
