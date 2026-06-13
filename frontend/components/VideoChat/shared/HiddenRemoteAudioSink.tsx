import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { RTCView, type MediaStream } from '@livekit/react-native-webrtc';

type Props = {
  stream: MediaStream;
  remoteMuted?: boolean;
};

/**
 * Keeps remote WebRTC audio playing when no visible RemoteVideo/RTCView is mounted
 * (audio-only call UI, partner camera off, return from video layout).
 */
export const HiddenRemoteAudioSink: React.FC<Props> = ({ stream, remoteMuted = false }) => {
  useEffect(() => {
    try {
      const tracks = stream.getAudioTracks?.() ?? [];
      for (const track of tracks) {
        track.enabled = !remoteMuted;
      }
    } catch {}
  }, [stream, stream?.id, remoteMuted]);

  const streamURL = typeof stream.toURL === 'function' ? stream.toURL() : undefined;
  if (Platform.OS === 'ios' && (!streamURL || streamURL.length === 0)) {
    return null;
  }

  return (
    <View pointerEvents="none" style={styles.host} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <RTCView
        stream={stream}
        streamURL={streamURL}
        objectFit="cover"
        zOrder={0}
        {...(Platform.OS === 'android' ? { zOrderMediaOverlay: false } : {})}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    left: -9999,
    top: 0,
    overflow: 'hidden',
  },
});
