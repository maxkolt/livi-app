import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NativeModules, StyleSheet, View } from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import { RemoteVideo } from '../../components/VideoChat/shared/RemoteVideo';
import { defaultLang } from '../../utils/i18n';
import { usePiP } from './PiPContext';
import { getPipPlaceholderOnlyDebug, mediaStreamHasLiveVideo } from './pipPlaceholderOnly';
import { logger } from '../../utils/logger';
import { logHomePiPTrace } from '../../utils/systemPiPHomeTrace';

function resolveCaptureMediaFromSession(pip: ReturnType<typeof usePiP>) {
  const session = (global as any).__webrtcSessionRef?.current;
  const remoteStream =
    pip.remoteStream ??
    (session && typeof session.getRemoteStream === 'function' ? session.getRemoteStream() : null);
  const localStream =
    pip.localStream ??
    (session && typeof session.getLocalStream === 'function' ? session.getLocalStream() : null);
  const localCamOn =
    typeof pip.localCamOn === 'boolean'
      ? pip.localCamOn
      : session && typeof session.getIsCamOn === 'function'
        ? !!session.getIsCamOn()
        : false;
  const remoteCamOn =
    typeof pip.remoteCamOn === 'boolean'
      ? pip.remoteCamOn
      : session && typeof session.getRemoteCamEnabled === 'function'
        ? !!session.getRemoteCamEnabled()
        : true;
  const hasLiveLocalVideo = mediaStreamHasLiveVideo(localStream);
  const effectiveLocalCamOn = localCamOn || hasLiveLocalVideo;
  return { remoteStream, localStream, localCamOn: effectiveLocalCamOn, remoteCamOn };
}

export default function SystemPiPCaptureHost() {
  const pip = usePiP();
  const [layoutReady, setLayoutReady] = useState(false);
  const firedRequestIdRef = useRef(0);
  const captureSnapshotRef = useRef<{
    requestId: number;
    placeholderOnly: boolean;
    shouldRenderRemoteVideo: boolean;
    shouldRenderLocalVideo: boolean;
    captureSurfaceReady: boolean;
  } | null>(null);

  const active = pip.systemPiPCaptureActive;
  const requestId = pip.systemPiPCaptureRequestId;
  const live = active && requestId > 0;

  useEffect(() => {
    if (!active) {
      setLayoutReady(false);
      firedRequestIdRef.current = 0;
      captureSnapshotRef.current = null;
    }
  }, [active]);

  const { remoteStream, localStream, localCamOn, remoteCamOn } = useMemo(
    () => resolveCaptureMediaFromSession(pip),
    [
      pip.remoteStream,
      pip.localStream,
      pip.localCamOn,
      pip.remoteCamOn,
      pip.remoteStreamVersion,
    ]
  );

  const placeholderDebug = getPipPlaceholderOnlyDebug({
    localCamOn,
    remoteCamOn,
    remoteStream,
    localStream,
  });
  const placeholderOnly = placeholderDebug.placeholderOnly;
  const hasLiveRemoteVideo = mediaStreamHasLiveVideo(remoteStream);
  const hasLiveLocalVideo = mediaStreamHasLiveVideo(localStream);
  const remoteCamOnForCapture = placeholderOnly ? false : remoteCamOn;
  const shouldRenderRemoteVideo =
    active && !placeholderOnly && hasLiveRemoteVideo && remoteCamOnForCapture;
  const shouldRenderLocalVideo =
    active && !placeholderOnly && !shouldRenderRemoteVideo && localCamOn && hasLiveLocalVideo;
  const shouldRenderVideoForCapture = shouldRenderRemoteVideo || shouldRenderLocalVideo;
  const showIntentionalAway =
    active &&
    !placeholderOnly &&
    !shouldRenderRemoteVideo &&
    !shouldRenderLocalVideo &&
    (!localCamOn || !hasLiveLocalVideo) &&
    (!remoteCamOn || !hasLiveRemoteVideo);
  const captureSurfaceReady =
    placeholderOnly || shouldRenderVideoForCapture || showIntentionalAway;

  if (live && requestId > 0 && captureSurfaceReady) {
    if (captureSnapshotRef.current?.requestId !== requestId) {
      captureSnapshotRef.current = {
        requestId,
        placeholderOnly,
        shouldRenderRemoteVideo,
        shouldRenderLocalVideo,
        captureSurfaceReady,
      };
    }
  }
  const snap =
    live && captureSnapshotRef.current?.requestId === requestId
      ? captureSnapshotRef.current
      : null;
  const displayPlaceholderOnly = snap?.placeholderOnly ?? placeholderOnly;
  const displayShouldRenderRemoteVideo = snap?.shouldRenderRemoteVideo ?? shouldRenderRemoteVideo;
  const displayShouldRenderLocalVideo = snap?.shouldRenderLocalVideo ?? shouldRenderLocalVideo;
  const displayCaptureSurfaceReady = snap?.captureSurfaceReady ?? captureSurfaceReady;
  const displayShouldRenderVideoForCapture =
    displayShouldRenderRemoteVideo || displayShouldRenderLocalVideo;

  const lastCaptureDiagRef = useRef('');
  useEffect(() => {
    if (!active) return;
    const key = `${requestId}|ph=${placeholderOnly ? 1 : 0}|vid=${shouldRenderVideoForCapture ? 1 : 0}|rv=${shouldRenderRemoteVideo ? 1 : 0}|lv=${shouldRenderLocalVideo ? 1 : 0}|ready=${captureSurfaceReady ? 1 : 0}|rcam=${remoteCamOn ? 1 : 0}|lcam=${localCamOn ? 1 : 0}|liveRv=${hasLiveRemoteVideo ? 1 : 0}`;
    if (lastCaptureDiagRef.current === key) return;
    lastCaptureDiagRef.current = key;
    logger.info('[SystemPiPCaptureHost] capture frame decision', {
      requestId,
      placeholderOnly,
      shouldRenderVideoForCapture,
      shouldRenderRemoteVideo,
      shouldRenderLocalVideo,
      captureSurfaceReady,
      remoteCamOn,
      localCamOn,
      hasLiveRemoteVideo,
      hasLiveLocalVideo,
      prepared: layoutReady,
      live,
    });
  }, [
    active,
    requestId,
    placeholderOnly,
    shouldRenderVideoForCapture,
    shouldRenderRemoteVideo,
    shouldRenderLocalVideo,
    captureSurfaceReady,
    remoteCamOn,
    localCamOn,
    hasLiveRemoteVideo,
    hasLiveLocalVideo,
    live,
    layoutReady,
    placeholderDebug.reason,
  ]);

  useEffect(() => {
    if (!active || requestId <= 0) return;
    const t = setTimeout(() => setLayoutReady((prev) => prev || true), 180);
    return () => clearTimeout(t);
  }, [active, requestId]);

  useEffect(() => {
    if (!active || !layoutReady || requestId <= 0) {
      return;
    }
    if (!captureSurfaceReady && !displayCaptureSurfaceReady) {
      return;
    }
    if (firedRequestIdRef.current === requestId) {
      return;
    }
    firedRequestIdRef.current = requestId;
    const ENTER_DELAY_MS = displayPlaceholderOnly ? 16 : displayShouldRenderVideoForCapture ? 60 : 32;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
    const requestSystemPiP = () => {
      if (cancelled) return;
      try {
        logHomePiPTrace('js_frame_ready', { requestId, placeholderOnly: displayPlaceholderOnly, skipped: true });
        // System PiP on Home/navigation is disabled; do not signal frame ready or retry enterPictureInPictureMode.
      } catch (error) {
        console.warn('[SystemPiPCaptureHost] setSystemPiPCaptureFrameReady threw', {
          requestId,
          error: String(error),
        });
      }
    };
    raf(() => {
      if (cancelled) return;
      raf(() => {
        if (cancelled) return;
        timeoutId = setTimeout(requestSystemPiP, ENTER_DELAY_MS);
      });
    });

    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      try {
        NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(false);
      } catch (_) {}
    };
  }, [
    active,
    layoutReady,
    requestId,
    remoteStream,
    localStream,
    placeholderOnly,
    captureSurfaceReady,
    displayCaptureSurfaceReady,
    displayPlaceholderOnly,
    displayShouldRenderVideoForCapture,
    displayShouldRenderLocalVideo,
    displayShouldRenderRemoteVideo,
  ]);

  if (!live) {
    return null;
  }

  const localStreamUrl = (localStream as any)?.toURL?.();

  return (
    <View
      collapsable={false}
      pointerEvents="none"
      style={styles.hostActive}
      onLayout={() => {
        if (!layoutReady) {
          setLayoutReady(true);
        }
      }}
    >
      {displayShouldRenderRemoteVideo ? (
        <RemoteVideo
          remoteStream={remoteStream as any}
          remoteCamOn={displayPlaceholderOnly ? false : remoteCamOn}
          remoteCamSide="front"
          remoteMuted={false}
          isInactiveState={false}
          wasFriendCallEnded={false}
          started={true}
          loading={!remoteStream}
          remoteViewKey={requestId}
          showFriendBadge={false}
          lang={defaultLang}
          session={(global as any).__webrtcSessionRef?.current}
          partnerInPiP={false}
          forceTextureView={true}
          objectFit="contain"
        />
      ) : displayShouldRenderLocalVideo && localStream ? (
        <RTCView
          key={`pip-capture-local-${requestId}-${(localStream as any)?.id ?? 'none'}`}
          stream={localStream}
          streamURL={localStreamUrl}
          style={styles.fill}
          objectFit="contain"
          mirror={true}
          {...({
            renderToHardwareTextureAndroid: true,
            zOrderMediaOverlay: false,
            useTextureView: true,
          } as any)}
        />
      ) : active ? (
        <View style={styles.fill}>
          <AwayPlaceholder />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hostActive: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10000,
    elevation: 10000,
    backgroundColor: '#000',
  },
  fill: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
