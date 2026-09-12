// __mocks__/@livekit/react-native-webrtc.ts
// Минимальный мок для юнит-тестов чистой логики — не реализует настоящий WebRTC.
// См. пояснение в __mocks__/react-native.ts (тот же повод: mapper ссылался в никуда).
export class RTCPeerConnection {}
export class MediaStream {}
export class MediaStreamTrack {}
export const mediaDevices = {
  getUserMedia: async () => new MediaStream(),
  enumerateDevices: async () => [],
};
export const RTCView = () => null;
