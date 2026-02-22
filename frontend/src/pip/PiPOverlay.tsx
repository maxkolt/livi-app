// src/pip/PiPOverlay.tsx
// PiP в стиле WhatsApp/Telegram: видео собеседника, сверху слева X (завершить), справа камера (вкл/выкл). Тап по видео — вернуться в звонок.
import React, { useMemo, useRef, useEffect } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  View,
  Pressable,
  Image,
  Platform,
} from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePiP } from './PiPContext';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { logger } from '../../utils/logger';

const UI = {
  bg: 'rgba(25,32,46,0.95)',
  fg: '#E7EEF7',
  danger: '#FF4D4F',
  stroke: 'rgba(255,255,255,0.10)',
  overlayBtn: 'rgba(0,0,0,0.35)',
};

const PIP_W = 150;
const PIP_H = 260;
const TOP_BAR_H = 44;
const PAD = 12;

export default function PiPOverlay() {
  const {
    visible,
    callId,
    roomId,
    partnerName,
    partnerAvatarUrl,
    remoteStream,
    returnToCall,
    toggleCam,
    endCall,
    pipPos,
    updatePiPPosition,
    localCamOn,
    allowVideoRender,
    inSystemPiPMode,
  } = usePiP();

  const insets = useSafeAreaInsets();
  const { width: W, height: H } = Dimensions.get('window');

  const MIN_X = PAD + insets.left;
  const MIN_Y = PAD + insets.top;
  const MAX_X = W - PIP_W - PAD - insets.right;
  const MAX_Y = H - PIP_H - PAD - insets.bottom;

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));

  const translate = useRef(
    new Animated.ValueXY({
      x: clamp(pipPos.x, MIN_X, MAX_X),
      y: clamp(pipPos.y, MIN_Y, MAX_Y),
    })
  ).current;
  const start = useRef({ x: 0, y: 0 });

  const DRAG_THRESHOLD = 6;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
        onPanResponderGrant: () => {
          // @ts-ignore
          start.current = { x: translate.x.__getValue(), y: translate.y.__getValue() };
        },
        onPanResponderMove: (_e, g) => {
          const nx = clamp(start.current.x + g.dx, MIN_X, MAX_X);
          const ny = clamp(start.current.y + g.dy, MIN_Y, MAX_Y);
          translate.setValue({ x: nx, y: ny });
        },
        onPanResponderRelease: (_e, g) => {
          if (Math.abs(g.dx) < DRAG_THRESHOLD && Math.abs(g.dy) < DRAG_THRESHOLD) {
            returnToCall();
            return;
          }
          const nx = clamp(start.current.x + g.dx, MIN_X, MAX_X);
          const ny = clamp(start.current.y + g.dy, MIN_Y, MAX_Y);
          const snapLeft = Math.abs(nx - MIN_X) < Math.abs(nx - MAX_X);
          const snapX = snapLeft ? MIN_X : MAX_X;
          Animated.spring(translate, {
            toValue: { x: snapX, y: ny },
            useNativeDriver: false,
            bounciness: 6,
            speed: 12,
          }).start(() => updatePiPPosition(snapX, ny));
        },
      }),
    [MIN_X, MAX_X, MIN_Y, MAX_Y, translate, updatePiPPosition, returnToCall]
  );

  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      const maxX = window.width - PIP_W - PAD - insets.right;
      const maxY = window.height - PIP_H - PAD - insets.bottom;
      updatePiPPosition(clamp(pipPos.x, MIN_X, maxX), clamp(pipPos.y, MIN_Y, maxY));
    });
    return () => sub?.remove?.();
  }, [pipPos.x, pipPos.y, insets.right, insets.bottom, MIN_X, MIN_Y, updatePiPPosition]);

  const [resolvedPartnerAvatarUri, resolvedPartnerAvatarReady] = useResolvedImageUri(partnerAvatarUrl || '');
  const hasValidAvatar =
    partnerAvatarUrl &&
    typeof partnerAvatarUrl === 'string' &&
    partnerAvatarUrl.trim() !== '' &&
    (partnerAvatarUrl.startsWith('http') || partnerAvatarUrl.startsWith('data:'));
  const showAvatar = hasValidAvatar && resolvedPartnerAvatarReady && !!resolvedPartnerAvatarUri;

  useEffect(() => {
    if (visible) {
      logger.info('[PiPOverlay] PiP visible', {
        callId,
        roomId,
        hasRemoteStream: !!remoteStream,
        allowVideoRender,
      });
    }
  }, [visible, callId, roomId, remoteStream, allowVideoRender]);

  if (!visible) {
    return null;
  }

  const camOn = typeof localCamOn === 'boolean' ? localCamOn : true;
  const streamURL = remoteStream?.toURL?.();
  const canRenderVideo =
    allowVideoRender &&
    remoteStream &&
    (Platform.OS !== 'ios' || (streamURL && streamURL.length > 0));

  // Системный PiP (главный экран): только видео, завершение — системная кнопка X. In-app PiP: верхняя панель (X, камера) + видео как раньше.
  const showTopBar = !inSystemPiPMode;
  const videoObjectFit = inSystemPiPMode ? 'contain' : 'cover';
  const videoAreaStyle = inSystemPiPMode ? styles.videoAreaSystemPiP : styles.videoArea;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        {
          width: PIP_W,
          height: PIP_H,
          transform: [{ translateX: translate.x }, { translateY: translate.y }],
        },
      ]}
      {...panResponder.panHandlers}
    >
      <View style={styles.card}>
        {showTopBar && (
          <View style={styles.topBar}>
            <Pressable
              onPress={toggleCam}
              style={styles.topBarBtn}
              android_ripple={{ color: UI.overlayBtn, borderless: true }}
            >
              <MaterialIcons
                name={camOn ? 'videocam' : 'videocam-off'}
                size={22}
                color={camOn ? UI.fg : UI.danger}
              />
            </Pressable>
            <Pressable
              onPress={endCall}
              style={styles.topBarBtn}
              android_ripple={{ color: UI.overlayBtn, borderless: true }}
            >
              <MaterialIcons name="close" size={22} color={UI.fg} />
            </Pressable>
          </View>
        )}

        <Pressable
          style={videoAreaStyle}
          onPress={returnToCall}
          android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true }}
        >
          {canRenderVideo && remoteStream ? (
            <View style={StyleSheet.absoluteFill}>
              {Platform.OS === 'android' ? (
                <RTCView
                  key={`pip-remote-${remoteStream.id}`}
                  stream={remoteStream}
                  streamURL={streamURL}
                  style={styles.rtcView}
                  objectFit={videoObjectFit}
                  mirror={false}
                />
              ) : (
                <RTCView
                  key={`pip-remote-${remoteStream.id}`}
                  streamURL={streamURL!}
                  style={styles.rtcView}
                  objectFit={videoObjectFit}
                  mirror={false}
                />
              )}
            </View>
          ) : (
            <View style={styles.placeholder}>
              {showAvatar ? (
                <Image
                  source={{ uri: resolvedPartnerAvatarUri }}
                  style={styles.avatarImg}
                  resizeMode="cover"
                />
              ) : (
                <View style={styles.avatarFallback}>
                  <MaterialIcons name="person" size={40} color={UI.fg} />
                </View>
              )}
            </View>
          )}
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', zIndex: 9999, elevation: 9999 },
  card: {
    flex: 1,
    borderRadius: 16,
    backgroundColor: UI.bg,
    borderWidth: 1,
    borderColor: UI.stroke,
    overflow: 'hidden',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    height: TOP_BAR_H,
    paddingHorizontal: 6,
  },
  topBarBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoArea: {
    flex: 1,
    minHeight: PIP_H - TOP_BAR_H,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  videoAreaSystemPiP: {
    flex: 1,
    minHeight: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  rtcView: {
    ...StyleSheet.absoluteFillObject,
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImg: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    borderColor: UI.stroke,
  },
  avatarFallback: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(113,91,168,0.3)',
    borderWidth: 1,
    borderColor: UI.stroke,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
