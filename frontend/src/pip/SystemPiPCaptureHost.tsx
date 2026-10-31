import type { MediaStream } from '@livekit/react-native-webrtc';
import type { CallAudioGlobals } from '../../utils/callStateTypes';
// App-level capture layer for Android system PiP when VideoCall is not mounted (Home / in-app PiP).
import React, { useCallback, useEffect } from 'react';
import { NativeModules, Platform, StyleSheet, View } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { usePiP } from './PiPContext';
import { mediaStreamHasLiveVideo } from './pipPlaceholderOnly';
import { PIP_ROUNDED, PIP_TEXTURE_VIEW } from '../../components/VideoChat/shared/pipTextureView';

// Keep the existing capture configuration, including legacy pass-through props.
type CaptureVideoProps = React.ComponentProps<typeof RTCView> & {
  stream: MediaStream | null;
  useTextureView: boolean;
  zOrderMediaOverlay: boolean;
};

/**
 * Product:
 * - peer cam ON / live remote → RTC full (TextureView) + local inset if local cam on
 * - local cam ON без peer → local RTC full
 * - иначе тихий fill; LiVi logo в system PiP — только native backdrop
 */
export default function SystemPiPCaptureHost() {
  const {
    systemPiPCaptureActive,
    inSystemPiPMode,
    pendingSystemPiP,
    remoteStream,
    remoteCamOn,
    localStream,
    localCamOn,
    pipRemoteViewKey,
    remoteStreamVersion,
  } = usePiP();

  let captureBlocked = false;
  try {
    const g = global as CallAudioGlobals;
    const now = Date.now();
    const inSys =
      inSystemPiPMode === true ||
      pendingSystemPiP === true ||
      g.__pipInSystemModeRef?.current === true;
    // Вне system PiP — никогда. Block только вне PiP (после expand), иначе mid-PiP peer video гасится.
    // Натив — источник правды: не в PiP и вход не идёт → подложки нет, даже если React-флаги
    // остались от прерванного входа (AppState мигнул background при закрытии экрана «Звонок..»).
    // Иначе полноэкранный RTCView (SurfaceView) ложится поверх экрана звонка, и его «дырка»
    // в окне стирает все кнопки, подписи и аватар.
    const nativeInSys = g.__pipInSystemModeRef?.current === true;
    const nativePendingEnter = g.__pendingSystemPiPSyncRef?.current === true;
    if (!inSys || (!nativeInSys && !nativePendingEnter)) {
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

  let sessionRemoteStream: MediaStream | null = null;
  let sessionRemoteCamOn: boolean | undefined;
  let sessionLocalStream: MediaStream | null = null;
  let sessionLocalCamOn: boolean | undefined;
  try {
    const session = (global as CallAudioGlobals).__webrtcSessionRef?.current;
    sessionRemoteStream =
      typeof session?.getRemoteStream === 'function' ? session.getRemoteStream() : null;
    if (typeof session?.getRemoteCamEnabled === 'function') {
      sessionRemoteCamOn = !!session.getRemoteCamEnabled();
    }
    sessionLocalStream =
      typeof session?.getLocalStream === 'function' ? session.getLocalStream() : null;
    if (typeof session?.getIsCamOn === 'function') {
      sessionLocalCamOn = !!session.getIsCamOn();
    }
  } catch (_) {}

  const effectiveRemoteStream =
    (mediaStreamHasLiveVideo(sessionRemoteStream) ? sessionRemoteStream : null) ??
    (mediaStreamHasLiveVideo(remoteStream) ? remoteStream : null) ??
    sessionRemoteStream ??
    remoteStream;

  const effectiveLocalStream =
    (mediaStreamHasLiveVideo(sessionLocalStream) ? sessionLocalStream : null) ??
    (mediaStreamHasLiveVideo(localStream) ? localStream : null) ??
    sessionLocalStream ??
    localStream;

  const hasLiveRemote = mediaStreamHasLiveVideo(effectiveRemoteStream);
  const hasLiveLocal = mediaStreamHasLiveVideo(effectiveLocalStream);
  const peerCamOn =
    remoteCamOn === true ||
    sessionRemoteCamOn === true ||
    hasLiveRemote;
  const selfCamOn =
    localCamOn === true ||
    sessionLocalCamOn === true ||
    hasLiveLocal;

  const remoteStreamUrl =
    effectiveRemoteStream && typeof effectiveRemoteStream.toURL === 'function'
      ? effectiveRemoteStream.toURL()
      : null;
  const localStreamUrl =
    effectiveLocalStream && typeof effectiveLocalStream.toURL === 'function'
      ? effectiveLocalStream.toURL()
      : null;

  const canBindRemote = peerCamOn && !!effectiveRemoteStream && !!remoteStreamUrl && hasLiveRemote;
  const canBindLocal = selfCamOn && !!effectiveLocalStream && !!localStreamUrl && hasLiveLocal;
  const canBindRtc = canBindRemote || canBindLocal;

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
  }, [
    active,
    peerCamOn,
    selfCamOn,
    canBindRtc,
    pipRemoteViewKey,
    remoteStreamVersion,
    markFrameReady,
  ]);

  useEffect(() => {
    if (!active || !peerCamOn) return;
    if (mediaStreamHasLiveVideo(effectiveRemoteStream)) return;
    const arm = () => {
      try {
        const session = (global as CallAudioGlobals).__webrtcSessionRef?.current;
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
    const t = setTimeout(arm, 500);
    return () => clearTimeout(t);
  }, [active, peerCamOn, effectiveRemoteStream]);

  if (!active) return null;

  const mainIsRemote = canBindRemote;
  const mainIsLocalOnly = !canBindRemote && canBindLocal;
  const showLocalInset = canBindRemote && canBindLocal;

  return (
    <View
      style={[styles.root, !canBindRtc ? styles.rootUnderLogo : null]}
      pointerEvents="none"
      collapsable={false}
      onLayout={canBindRtc ? markFrameReady : undefined}
    >
      {mainIsRemote ? (
        <RTCView
          key={`sys-pip-remote-${pipRemoteViewKey}-${remoteStreamVersion}-${effectiveRemoteStream?.id || 's'}`}
          {...({
            stream: effectiveRemoteStream,
            streamURL: remoteStreamUrl,
            useTextureView: true,
            renderToHardwareTextureAndroid: true,
            zOrderMediaOverlay: false,
          } satisfies CaptureVideoProps)}
          style={styles.video}
          objectFit="cover"
          mirror={false}
          zOrder={0}
        />
      ) : null}
      {mainIsLocalOnly ? (
        <RTCView
          key={`sys-pip-local-main-${effectiveLocalStream?.id || 'l'}`}
          {...({
            stream: effectiveLocalStream,
            streamURL: localStreamUrl,
            useTextureView: true,
            renderToHardwareTextureAndroid: true,
            zOrderMediaOverlay: false,
          } satisfies CaptureVideoProps)}
          style={styles.video}
          objectFit="cover"
          mirror={true}
          zOrder={0}
        />
      ) : null}
      {showLocalInset ? (
        <View style={[styles.localInset, PIP_ROUNDED && styles.localInsetRounded]} collapsable={false}>
          <RTCView
            key={`sys-pip-local-inset-${effectiveLocalStream?.id || 'l'}`}
            {...({
              stream: effectiveLocalStream,
              streamURL: localStreamUrl,
              useTextureView: true,
              textureView: PIP_TEXTURE_VIEW,
              renderToHardwareTextureAndroid: true,
              zOrderMediaOverlay: true,
            } satisfies CaptureVideoProps)}
            style={[styles.localInsetVideo, PIP_TEXTURE_VIEW && styles.localInsetVideoTransparent]}
            objectFit="cover"
            mirror={true}
            zOrder={1}
          />
        </View>
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
  localInset: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 48,
    height: 72,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
    zIndex: 2,
  },
  /** Свой кадр в TextureView (PIP_ROUNDED): скруглён, без рамки. */
  localInsetRounded: {
    borderRadius: 8,
    borderWidth: 0,
    backgroundColor: 'transparent',
  },
  localInsetVideoTransparent: {
    backgroundColor: 'transparent',
  },
  localInsetVideo: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
});
