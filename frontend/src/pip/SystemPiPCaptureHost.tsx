// App-level capture layer for Android system PiP when VideoCall is not mounted (Home / in-app PiP).
import React, { useCallback, useEffect } from 'react';
import { NativeModules, Platform, StyleSheet, View } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { usePiP } from './PiPContext';
import { mediaStreamHasLiveVideo } from './pipPlaceholderOnly';

/**
 * Product:
 * - peer cam ON / live remote → RTC (TextureView)
 * - иначе тихий fill; LiVi logo в system PiP — только native backdrop (без spinning AwayPlaceholder)
 */
export default function SystemPiPCaptureHost() {
  const {
    systemPiPCaptureActive,
    inSystemPiPMode,
    pendingSystemPiP,
    remoteStream,
    remoteCamOn,
    pipRemoteViewKey,
    remoteStreamVersion,
  } = usePiP();

  let captureBlocked = false;
  try {
    const g = global as any;
    const now = Date.now();
    const inSys =
      inSystemPiPMode === true ||
      pendingSystemPiP === true ||
      g.__pipInSystemModeRef?.current === true;
    // Вне system PiP — никогда. Block только вне PiP (после expand), иначе mid-PiP peer video гасится.
    if (!inSys) {
      captureBlocked = true;
    } else if (
      g.__pipInSystemModeRef?.current !== true &&
      inSystemPiPMode !== true &&
      now < Number(g.__blockSystemPiPCaptureHostUntilRef?.current || 0)
    ) {
      captureBlocked = true;
    }
    if (g.__pipReturnToCallInFlightRef?.current === true && g.__pipInSystemModeRef?.current !== true) {
      captureBlocked = true;
    }
  } catch (_) {}

  const active =
    Platform.OS === 'android' &&
    !captureBlocked &&
    systemPiPCaptureActive &&
    (pendingSystemPiP || inSystemPiPMode);

  let sessionRemoteStream: unknown = null;
  let sessionRemoteCamOn: boolean | undefined;
  try {
    const session = (global as any).__webrtcSessionRef?.current;
    sessionRemoteStream =
      typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null;
    if (typeof session?.getRemoteCamEnabled === 'function') {
      sessionRemoteCamOn = !!session.getRemoteCamEnabled();
    }
  } catch (_) {}

  const effectiveRemoteStream =
    (mediaStreamHasLiveVideo(sessionRemoteStream) ? sessionRemoteStream : null) ??
    (mediaStreamHasLiveVideo(remoteStream) ? remoteStream : null) ??
    sessionRemoteStream ??
    remoteStream;

  const hasLive = mediaStreamHasLiveVideo(effectiveRemoteStream);
  const peerCamOn =
    remoteCamOn === true ||
    sessionRemoteCamOn === true ||
    hasLive;

  // Не блокируем RTC из‑за sticky allowVideoRender=false после logo-enter.
  const remoteStreamUrl =
    effectiveRemoteStream && typeof (effectiveRemoteStream as any).toURL === 'function'
      ? (effectiveRemoteStream as any).toURL()
      : null;
  const canBindRtc = hasLive && !!effectiveRemoteStream && !!remoteStreamUrl;

  const markFrameReady = useCallback(() => {
    try {
      NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
    } catch (_) {}
  }, []);

  useEffect(() => {
    if (!active) return;
    markFrameReady();
    const t = setTimeout(markFrameReady, 32);
    return () => clearTimeout(t);
  }, [active, peerCamOn, canBindRtc, pipRemoteViewKey, remoteStreamVersion, markFrameReady]);

  useEffect(() => {
    if (!active || !peerCamOn) return;
    if (mediaStreamHasLiveVideo(effectiveRemoteStream)) return;
    const arm = () => {
      try {
        const session = (global as any).__webrtcSessionRef?.current;
        if (!session) return;
        const stream =
          typeof session.getRemoteStream === 'function' ? session.getRemoteStream() : null;
        if (mediaStreamHasLiveVideo(stream)) return;
        if (typeof session.ensureRemoteVideoForSystemPiPCapture === 'function') {
          session.ensureRemoteVideoForSystemPiPCapture();
        }
      } catch (_) {}
    };
    arm();
    // Retry once after TrackPublished lag — without remoteStreamVersion (avoids update-depth loop).
    const t = setTimeout(arm, 500);
    return () => clearTimeout(t);
  }, [active, peerCamOn, effectiveRemoteStream]);

  if (!active) return null;

  return (
    <View
      style={[styles.root, !canBindRtc ? styles.rootUnderLogo : null]}
      pointerEvents="none"
      collapsable={false}
      onLayout={canBindRtc ? markFrameReady : undefined}
    >
      {canBindRtc ? (
        <RTCView
          key={`sys-pip-remote-${pipRemoteViewKey}-${remoteStreamVersion}-${(effectiveRemoteStream as any)?.id || 's'}`}
          {...({
            stream: effectiveRemoteStream,
            streamURL: remoteStreamUrl,
            useTextureView: true,
            renderToHardwareTextureAndroid: true,
            zOrderMediaOverlay: false,
          } as any)}
          style={styles.video}
          objectFit="cover"
          mirror={false}
          zOrder={0}
        />
      ) : null}
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
  // Под native LiVi backdrop (elevation 10000): не перекрываем лого до peer video.
  rootUnderLogo: {
    zIndex: 0,
    elevation: 0,
    backgroundColor: 'transparent',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
});
