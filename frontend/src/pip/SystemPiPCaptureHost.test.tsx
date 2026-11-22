import React from 'react';

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => fn(),
}));
const mockFrameReady = jest.fn();
jest.mock('react-native', () => ({
  View: 'View', Platform: { OS: 'android' },
  NativeModules: { LiviAppModule: { setSystemPiPCaptureFrameReady: (...args: unknown[]) => mockFrameReady(...args) } },
  StyleSheet: { create: (x: unknown) => x, absoluteFillObject: {} },
}));
jest.mock('@livekit/react-native-webrtc', () => ({ RTCView: 'RTCView' }));
jest.mock('../../components/VideoChat/shared/pipTextureView', () => ({ PIP_ROUNDED: true, PIP_TEXTURE_VIEW: true }));
let mockPip: Record<string, unknown>;
jest.mock('./PiPContext', () => ({ usePiP: () => mockPip }));

import SystemPiPCaptureHost from './SystemPiPCaptureHost';
import type { CallAudioGlobals } from '../../utils/callStateTypes';

const g = global as CallAudioGlobals;
function stream(id: string) {
  return { id, toURL: () => id, getVideoTracks: () => [{ kind: 'video', enabled: true, readyState: 'live' }] };
}
beforeEach(() => {
  g.__webrtcSessionRef = { current: null };
  g.__pipInSystemModeRef = { current: true };
  g.__pendingSystemPiPSyncRef = { current: false };
  g.__pipReturnToCallInFlightRef = { current: false };
  mockPip = {
    systemPiPCaptureActive: true, inSystemPiPMode: true, pendingSystemPiP: false,
    localStream: stream('local'), localCamOn: true, remoteStream: null, remoteCamOn: false,
  };
});

it('waits for the mounted video-only layout before uncovering the native backdrop', () => {
  const root = SystemPiPCaptureHost()!;
  expect(mockFrameReady).not.toHaveBeenCalled();
  root.props.onLayout();
  expect(mockFrameReady).toHaveBeenCalledWith(true);
});

it('uses the supported TextureView prop for local and remote capture', () => {
  mockPip.remoteStream = stream('remote');
  mockPip.remoteCamOn = true;
  const root = SystemPiPCaptureHost()!;
  const videos: React.ReactElement<Record<string, unknown>>[] = [];
  function walk(node: React.ReactNode) {
    React.Children.forEach(node, child => {
      if (!React.isValidElement<Record<string, unknown>>(child)) return;
      if (String(child.type) === 'RTCView') videos.push(child);
      walk(child.props.children as React.ReactNode);
    });
  }
  walk(root);
  expect(videos).toHaveLength(2);
  for (const video of videos) expect(video.props.textureView).toBe(true);
});

it('removes the capture overlay immediately after native PiP exit despite stale React state', () => {
  g.__pipInSystemModeRef!.current = false;
  expect(SystemPiPCaptureHost()).toBeNull();
  expect(mockFrameReady).not.toHaveBeenCalled();
});

it('prepares an invisible TextureView during an active call before the Home gesture', () => {
  type Session = NonNullable<NonNullable<CallAudioGlobals['__webrtcSessionRef']>['current']>;
  g.__webrtcSessionRef = { current: { isEnded: () => false } as Session };
  g.__pipInSystemModeRef!.current = false;
  mockPip.inSystemPiPMode = false;
  mockPip.systemPiPCaptureActive = false;
  const root = SystemPiPCaptureHost()!;
  expect(root).not.toBeNull();
  expect(root.props.nativeID).toBe('livi-system-pip-video');
  expect(root.props.style).toContainEqual({ opacity: 0 });
});
