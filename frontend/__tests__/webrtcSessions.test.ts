jest.mock('../sockets/socket', () => require('../__mocks__/socket'));
jest.mock('../utils/iceConfig', () => ({
  getIceConfiguration: jest.fn().mockResolvedValue({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:example.com:3478', username: 'test', credential: 'test' },
    ],
  }),
  getEnvFallbackConfiguration: jest.fn().mockReturnValue({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:example.com:3478', username: 'test', credential: 'test' },
    ],
  }),
}));

import { MockTrack, MediaStream, RTCPeerConnection } from '@livekit/react-native-webrtc';
import socket from '../sockets/socket';
import { VideoCallSession } from '../src/webrtc/sessions/VideoCallSession';
import { RandomChatSession } from '../src/webrtc/sessions/RandomChatSession';

const baseConfig = { callbacks: {} };

describe('WebRTC session socket ownership', () => {
  beforeEach(() => {
    (socket as any).emitted = [];
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
  });

  it('keeps offer handler owned by VideoCallSession', () => {
    const callSession = new VideoCallSession(baseConfig as any);
    expect((socket as any).listenerCount('offer')).toBe(1);

    const randomSession = new RandomChatSession(baseConfig as any);
    expect((socket as any).listenerCount('offer')).toBe(1);

    randomSession.cleanup();
    // RandomChatSession не владеет offer/answer/ice обработчиками, они принадлежат VideoCallSession.
    expect((socket as any).listenerCount('offer')).toBe(1);

    callSession.cleanup();
    expect((socket as any).listenerCount('offer')).toBe(0);
  });
});

describe('sendCameraState payloads', () => {
  beforeEach(() => {
    (socket as any).emitted = [];
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
  });

  it('includes roomId for video call cam-toggle', () => {
    const session = new VideoCallSession(baseConfig as any);
    (session as any).setRoomId('room-1');
    const stream = new MediaStream([new MockTrack('v1', 'video')]);
    (session as any).streamManager.setLocalStream(stream);

    session.sendCameraState();

    const camToggle = (socket as any).emitted.find((e: any) => e.event === 'cam-toggle');
    expect(camToggle).toBeDefined();
    expect(camToggle.payload.roomId).toBe('room-1');
    expect(camToggle.payload.enabled).toBe(true);

    session.cleanup();
  });

  it('random chat next emits only next', async () => {
    const session = new RandomChatSession(baseConfig as any);

    await session.next();

    expect((socket as any).emitted.some((e: any) => e.event === 'next')).toBe(true);
    // После next backend сам возвращает в очередь, поэтому клиент не должен слать start.
    expect((socket as any).emitted.some((e: any) => e.event === 'start')).toBe(false);

    session.cleanup();
  });
});

describe('Video call - two users receive video', () => {
  let user1Session: VideoCallSession;
  let user2Session: VideoCallSession;
  let user1LocalStream: MediaStream;
  let user2LocalStream: MediaStream;
  let user1RemoteStreamReceived: MediaStream | null = null;
  let user2RemoteStreamReceived: MediaStream | null = null;

  beforeEach(() => {
    (socket as any).emitted = [];
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
    jest.useFakeTimers();

    // Создаем локальные стримы для обоих пользователей
    user1LocalStream = new MediaStream([
      new MockTrack('user1-video', 'video'),
      new MockTrack('user1-audio', 'audio'),
    ]);
    user2LocalStream = new MediaStream([
      new MockTrack('user2-video', 'video'),
      new MockTrack('user2-audio', 'audio'),
    ]);

    // Создаем сессии для обоих пользователей
    const user1Config = {
      callbacks: {
        onRemoteStreamChange: (stream: MediaStream | null) => {
          user1RemoteStreamReceived = stream;
        },
      },
    };

    const user2Config = {
      callbacks: {
        onRemoteStreamChange: (stream: MediaStream | null) => {
          user2RemoteStreamReceived = stream;
        },
      },
    };

    user1Session = new VideoCallSession(user1Config as any);
    user2Session = new VideoCallSession(user2Config as any);

    // Устанавливаем roomId для обеих сессий
    (user1Session as any).setRoomId('test-room-1');
    (user2Session as any).setRoomId('test-room-1');
    (user1Session as any).setPartnerId('user2-id');
    (user2Session as any).setPartnerId('user1-id');
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    user1Session?.cleanup();
    user2Session?.cleanup();
    const events = (socket as any)._events;
    if (events) {
      Object.keys(events).forEach((evt) => {
        (socket as any).removeAllListeners(evt);
      });
    }
  });

  it('both users should receive remote video streams during video call', async () => {
    // Шаг 1: Проверяем, что стримы валидны
    expect(user1LocalStream.getTracks().length).toBeGreaterThan(0);
    expect(user2LocalStream.getTracks().length).toBeGreaterThan(0);
    expect(user1LocalStream.getVideoTracks().length).toBeGreaterThan(0);
    expect(user2LocalStream.getVideoTracks().length).toBeGreaterThan(0);

    // Шаг 2: Устанавливаем локальные стримы
    (user1Session as any).streamManager.setLocalStream(user1LocalStream);
    (user2Session as any).streamManager.setLocalStream(user2LocalStream);

    // Шаг 3: Создаем PeerConnection напрямую (обходя проверки ensurePcWithLocal)
    const { RTCPeerConnection } = await import('@livekit/react-native-webrtc');
    const user1Pc = new RTCPeerConnection({ iceServers: [] });
    const user2Pc = new RTCPeerConnection({ iceServers: [] });

    // Добавляем локальные треки в PC
    user1LocalStream.getTracks().forEach((track) => {
      user1Pc.addTrack(track, user1LocalStream);
    });
    user2LocalStream.getTracks().forEach((track) => {
      user2Pc.addTrack(track, user2LocalStream);
    });

    // Устанавливаем PC в сессии
    (user1Session as any).peerRef = user1Pc;
    (user2Session as any).peerRef = user2Pc;
    (user1Session as any).pcLifecycleManager.markPcWithToken(user1Pc);
    (user2Session as any).pcLifecycleManager.markPcWithToken(user2Pc);

    expect(user1Pc).not.toBeNull();
    expect(user2Pc).not.toBeNull();

    // Шаг 4: Устанавливаем обработчики удаленных стримов
    (user1Session as any).attachRemoteHandlers(user1Pc, 'user2-id');
    (user2Session as any).attachRemoteHandlers(user2Pc, 'user1-id');

    // Шаг 5: Симулируем процесс offer/answer
    // User1 создает offer
    const offer = await user1Pc.createOffer();
    await user1Pc.setLocalDescription(offer);

    // User2 получает offer и создает answer
    await user2Pc.setRemoteDescription(offer);
    const answer = await user2Pc.createAnswer();
    await user2Pc.setLocalDescription(answer);

    // User1 получает answer
    await user1Pc.setRemoteDescription(answer);

    // Шаг 6: Симулируем получение треков через ontrack
    // User1 получает треки от User2
    const user2VideoTrack = new MockTrack('user2-video-remote', 'video');
    const user2AudioTrack = new MockTrack('user2-audio-remote', 'audio');
    const user2RemoteStream = new MediaStream([user2VideoTrack, user2AudioTrack]);
    (user1Pc as any).simulateTrackReceived(user2VideoTrack, user2RemoteStream);

    // User2 получает треки от User1
    const user1VideoTrack = new MockTrack('user1-video-remote', 'video');
    const user1AudioTrack = new MockTrack('user1-audio-remote', 'audio');
    const user1RemoteStream = new MediaStream([user1VideoTrack, user1AudioTrack]);
    (user2Pc as any).simulateTrackReceived(user1VideoTrack, user1RemoteStream);

    // Даем время на обработку событий
    jest.advanceTimersByTime(100);

    // Шаг 7: Проверяем, что оба пользователя получили remote stream с видео
    const user1Remote = (user1Session as any).streamManager.getRemoteStream();
    const user2Remote = (user2Session as any).streamManager.getRemoteStream();

    // Проверяем через streamManager
    expect(user1Remote).toBeDefined();
    expect(user1Remote).not.toBeNull();
    if (user1Remote) {
      const videoTracks = user1Remote.getVideoTracks();
      expect(videoTracks.length).toBeGreaterThan(0);
      expect(videoTracks[0].kind).toBe('video');
      expect(videoTracks[0].readyState).toBe('live');
    }

    expect(user2Remote).toBeDefined();
    expect(user2Remote).not.toBeNull();
    if (user2Remote) {
      const videoTracks = user2Remote.getVideoTracks();
      expect(videoTracks.length).toBeGreaterThan(0);
      expect(videoTracks[0].kind).toBe('video');
      expect(videoTracks[0].readyState).toBe('live');
    }

    // Проверяем через callbacks (если они были вызваны)
    if (user1RemoteStreamReceived) {
      const videoTracks = user1RemoteStreamReceived.getVideoTracks();
      expect(videoTracks.length).toBeGreaterThan(0);
    }

    if (user2RemoteStreamReceived) {
      const videoTracks = user2RemoteStreamReceived.getVideoTracks();
      expect(videoTracks.length).toBeGreaterThan(0);
    }
  });
});
