import React, { useEffect, useRef, useState } from 'react';
import { NativeModules, StyleSheet, View } from 'react-native';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import { RemoteVideo } from '../../components/VideoChat/shared/RemoteVideo';
import { defaultLang } from '../../utils/i18n';
import { usePiP } from './PiPContext';

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
  // В prewarm/prepared режиме remoteCamOn может быть "запаздывающим" (state еще не успел обновиться),
  // а нам нужен именно источник текущего кадра для system PiP. Поэтому в prepared форсим remoteCamOn=true.
  const remoteCamOnForCapture = prepared ? true : remoteCamOn;
  const shouldShowAway = !remoteCamOnForCapture;
  const shouldRenderVideoForCapture = active && !!remoteStream && (live ? !shouldShowAway : true);

  useEffect(() => {
    if (!active || !layoutReady || requestId <= 0) {
      return;
    }
    if (firedRequestIdRef.current === requestId) {
      return;
    }
    firedRequestIdRef.current = requestId;
    // ВАЖНО: для TextureView/RTC-поверхности нужно немного времени, иначе system PiP может
    // захватить "старый" frame UI (кнопки/оверлеи) вместо выделенного fullscreen video.
    // Ретраи native остаются как страховка для медленных устройств.
    const ENTER_DELAY_MS = 260;
    const t = setTimeout(() => {
      try {
        NativeModules.LiviAppModule?.requestEnterPictureInPicture?.();
      } catch (error) {
        console.warn('[SystemPiPCaptureHost] native requestEnterPictureInPicture threw', {
          requestId,
          error: String(error),
        });
      }
    }, ENTER_DELAY_MS);

    return () => clearTimeout(t);
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
