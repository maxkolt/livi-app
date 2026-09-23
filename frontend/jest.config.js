/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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
  forceExit: true,
};
