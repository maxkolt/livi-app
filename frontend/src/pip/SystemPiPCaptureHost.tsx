import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, StyleSheet, View } from 'react-native';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import { RemoteVideo } from '../../components/VideoChat/shared/RemoteVideo';
import { defaultLang } from '../../utils/i18n';
import { usePiP } from './PiPContext';
import { mediaStreamHasLiveVideo, shouldUsePipPlaceholderOnly } from './pipPlaceholderOnly';
import { logger } from '../../utils/logger';

export default function SystemPiPCaptureHost() {
  const pip = usePiP();
  const [layoutReady, setLayoutReady] = useState(false);
  const firedRequestIdRef = useRef(0);

  const active = pip.systemPiPCaptureActive;
  const pipVisible = pip.visible;
  const requestId = pip.systemPiPCaptureRequestId;
  const prepared = active && requestId <= 0;
  const live = active && requestId > 0;
  const preparedVisible = prepared && !pipVisible;
  const remoteStream = pip.remoteStream;
  const remoteCamOn = pip.remoteCamOn ?? true;
  const placeholderOnly = shouldUsePipPlaceholderOnly({
    localCamOn: pip.localCamOn,
    remoteCamOn,
    remoteStream,
  });
  const hasLiveRemoteVideo = mediaStreamHasLiveVideo(remoteStream);
  const remoteCamOnForCapture = placeholderOnly ? false : remoteCamOn;
  const shouldShowAway = placeholderOnly || !remoteCamOnForCapture || !hasLiveRemoteVideo;
  const shouldRenderVideoForCapture =
    active && !placeholderOnly && hasLiveRemoteVideo && remoteCamOn && (live ? true : remoteCamOn);

  const lastCaptureDiagRef = useRef('');
  useEffect(() => {
    if (!active) return;
    const key = `${requestId}|ph=${placeholderOnly ? 1 : 0}|vid=${shouldRenderVideoForCapture ? 1 : 0}|away=${shouldShowAway ? 1 : 0}|rcam=${remoteCamOn ? 1 : 0}|lcam=${pip.localCamOn ? 1 : 0}|liveRv=${hasLiveRemoteVideo ? 1 : 0}`;
    if (lastCaptureDiagRef.current === key) return;
    lastCaptureDiagRef.current = key;
    logger.info('[SystemPiPCaptureHost] capture frame decision', {
      requestId,
      placeholderOnly,
      shouldRenderVideoForCapture,
      shouldShowAway,
      remoteCamOn,
      localCamOn: pip.localCamOn,
      hasLiveRemoteVideo,
      prepared,
      live,
      preparedVisible,
    });
  }, [
    active,
    requestId,
    placeholderOnly,
    shouldRenderVideoForCapture,
    shouldShowAway,
    remoteCamOn,
    pip.localCamOn,
    hasLiveRemoteVideo,
    prepared,
    live,
    preparedVisible,
  ]);

  useEffect(() => {
    if (!active || !layoutReady) return;
    if (!placeholderOnly && !shouldShowAway) return;
    try {
      NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
    } catch (_) {}
  }, [active, layoutReady, placeholderOnly, shouldShowAway]);

  useEffect(() => {
    if (!active || !layoutReady || requestId <= 0) {
      return;
    }
    if (firedRequestIdRef.current === requestId) {
      return;
    }
    firedRequestIdRef.current = requestId;
    const ENTER_DELAY_MS = 60;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
    const requestSystemPiP = () => {
      if (cancelled) return;
      try {
        NativeModules.LiviAppModule?.setSystemPiPCaptureFrameReady?.(true);
        NativeModules.LiviAppModule?.requestEnterPictureInPicture?.();
      } catch (error) {
        console.warn('[SystemPiPCaptureHost] native requestEnterPictureInPicture threw', {
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
  }, [active, layoutReady, requestId, remoteStream, shouldShowAway]);

  return (
    <View
      collapsable={false}
      pointerEvents="none"
      style={[
        styles.hostBase,
        live
          ? styles.hostActive
          : preparedVisible
            ? styles.hostPrepared
            : prepared
              ? styles.hostPreparedHidden
              : styles.hostInactive,
      ]}
      onLayout={() => {
        if (!layoutReady) {
          setLayoutReady(true);
        }
      }}
    >
      {shouldRenderVideoForCapture ? (
        <RemoteVideo
          remoteStream={remoteStream as any}
          remoteCamOn={remoteCamOnForCapture}
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
      ) : active ? (
        <View style={styles.fill}>
          <AwayPlaceholder />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hostBase: {
    ...StyleSheet.absoluteFillObject,
  },
  hostActive: {
    zIndex: 10000,
    elevation: 10000,
    backgroundColor: '#000',
  },
  hostPrepared: {
    zIndex: 9998,
    elevation: 9998,
    // Для сценария VideoCall -> Home native может заходить в PiP быстрее JS-рендеров.
    // Если host "подготовлен, но невидим" (opacity: 0), Android захватывает underlying UI
    // (кнопки/оверлеи VideoCall) — что и даёт неверный "захват". Поэтому в prepared-режиме
    // делаем host фактически присутствующим в кадре.
    opacity: 1,
    backgroundColor: '#000',
  },
  hostPreparedHidden: {
    zIndex: -1,
    elevation: 0,
    opacity: 0,
    backgroundColor: 'transparent',
  },
  hostInactive: {
    zIndex: -1,
    elevation: 0,
    opacity: 0,
    backgroundColor: 'transparent',
  },
  fill: {
    flex: 1,
    backgroundColor: '#000',
  },
});
