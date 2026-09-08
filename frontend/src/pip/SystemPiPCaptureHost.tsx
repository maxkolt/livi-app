// App-level capture layer for Android system PiP when VideoCall is not mounted (Home / in-app PiP).
import React, { useCallback, useEffect } from 'react';
import { NativeModules, Platform, StyleSheet, View } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import { usePiP } from './PiPContext';
import {
  isSystemPiPLeaveAudioOrigin,
  mediaStreamHasLiveVideo,
  shouldUseSystemPiPPlaceholderOnly,
} from './pipPlaceholderOnly';

export default function SystemPiPCaptureHost() {
  const {
    systemPiPCaptureActive,
    inSystemPiPMode,
    pendingSystemPiP,
    remoteStream,
    remoteCamOn,
    allowVideoRender,
    pipRemoteViewKey,
    remoteStreamVersion,
  } = usePiP();

  const active =
    Platform.OS === 'android' &&
    systemPiPCaptureActive &&
    (pendingSystemPiP || inSystemPiPMode) &&
    !isSystemPiPLeaveAudioOrigin();

  // Prefer session live stream over possibly stale PiP React state after in-app → system PiP.
  let sessionRemoteStream: unknown = null;
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    sessionRemoteStream =
      typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null;
  } catch (_) {}
  const effectiveRemoteStream =
    (mediaStreamHasLiveVideo(sessionRemoteStream) ? sessionRemoteStream : null) ??
    (mediaStreamHasLiveVideo(remoteStream) ? remoteStream : null) ??
    sessionRemoteStream ??
    remoteStream;

  const placeholderOnly = shouldUseSystemPiPPlaceholderOnly({
    remoteCamOn,
    remoteStream: effectiveRemoteStream,
  });

  const remoteStreamUrl =
    effectiveRemoteStream && typeof (effectiveRemoteStream as any).toURL === 'function'
      ? (effectiveRemoteStream as any).toURL()
      : null;

  const showLive =
    !placeholderOnly &&
    allowVideoRender &&
    !!remoteStreamUrl &&
    mediaStreamHasLiveVideo(effectiveRemoteStream);

  const markFrameReady = useCallback(() => {
    try {
      NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(markFrameReady, 48);
    return () => clearTimeout(t);
  }, [active, showLive, pipRemoteViewKey, remoteStreamVersion, markFrameReady]);

  if (!active) return null;

  return (
    <View
      style={styles.root}
      pointerEvents="none"
      collapsable={false}
      onLayout={markFrameReady}
    >
      {showLive ? (
        <RTCView
          key={`sys-pip-remote-${pipRemoteViewKey}-${remoteStreamVersion}`}
          streamURL={remoteStreamUrl}
          style={styles.video}
          objectFit="cover"
          mirror={false}
          zOrder={0}
        />
      ) : (
        <AwayPlaceholder logoSize={90} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10040,
    elevation: 10040,
    backgroundColor: '#0a0a0c',
    justifyContent: 'center',
    alignItems: 'center',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
});
