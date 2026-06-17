// @ts-nocheck — LiveKit RN MediaRecorder types are not compatible with strict DOM lib checks.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MediaRecorder } = require('@livekit/react-native/src/audio/MediaRecorder') as {
  MediaRecorder: unknown;
};

function shimMediaRecorder() {
  if (!(global as { MediaRecorder?: unknown }).MediaRecorder) {
    (global as { MediaRecorder?: unknown }).MediaRecorder = MediaRecorder;
  }
}

shimMediaRecorder();
