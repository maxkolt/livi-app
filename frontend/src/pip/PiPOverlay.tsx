// src/pip/PiPOverlay.tsx
// Два режима: in-app PiP (маленькое перетаскиваемое окно) и полноэкранный слой для входа в системный PiP.
import React, { useContext, useRef, useEffect, useCallback } from 'react';
import {
  Dimensions,
  StyleSheet,
  View,
  Pressable,
  Platform,
  Text,
  Animated,
  PanResponder,
  Image,
} from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { PiPContext } from './PiPContext';
import { logger } from '../../utils/logger';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { RemoteVideo } from '../../components/VideoChat/shared/RemoteVideo';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import { defaultLang } from '../../utils/i18n';

const PIP_W = 150;
const PIP_H = 260;

const isVideoCallScreen = (name?: string | null) =>
  name === 'VideoCall' || name === 'RandomChat';

function usePiPContextSafe(): React.ContextType<typeof PiPContext> | null {
  try {
    return useContext(PiPContext) ?? null;
  } catch (_) {
    return null;
  }
}

/** Fallback при ошибке рендера — полноэкранный тап для возврата в звонок. */
class PiPErrorBoundary extends React.Component<
  { children: React.ReactNode; onReturnRef: React.MutableRefObject<(() => void) | null> },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    try {
      logger.warn('[PiPOverlay] Error boundary caught', { message: error?.message });
    } catch (_) {}
  }

  _onFallbackTouch = () => {
    this.setState({ hasError: false });
    try {
      const fn = this.props.onReturnRef?.current;
      if (typeof fn === 'function') fn();
    } catch (_) {}
  };

  render() {
    if (this.state.hasError) {
      return (
        <View
          style={StyleSheet.absoluteFill}
          onStartShouldSetResponder={() => true}
          onResponderRelease={this._onFallbackTouch}
        >
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' }}>
            <Text style={{ color: '#E7EEF7', fontSize: 14, textAlign: 'center' }}>
              Тап — вернуться в звонок
            </Text>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

type PiPOverlayProps = { currentRouteName?: string | null };

export default function PiPOverlay({ currentRouteName }: PiPOverlayProps) {
  const ctx = usePiPContextSafe();
  const visible = ctx?.visible ?? false;
  const callId = ctx?.callId ?? null;
  const roomId = ctx?.roomId ?? null;
  const remoteStream = ctx?.remoteStream ?? null;
  const returnToCall = ctx?.returnToCall ?? (() => {});
  const endCall = ctx?.endCall ?? (() => {});
  const allowVideoRender = ctx?.allowVideoRender ?? false;
  const inSystemPiPMode = ctx?.inSystemPiPMode ?? false;
  const pendingSystemPiP = ctx?.pendingSystemPiP ?? false;
  const suppressOverlayForReturn = ctx?.suppressOverlayForReturn ?? false;
  const pipPos = ctx?.pipPos ?? { x: 12, y: 120 };
  const updatePiPPosition = ctx?.updatePiPPosition ?? (() => {});
  const partnerAvatarUrl = ctx?.partnerAvatarUrl;
  const partnerName = ctx?.partnerName ?? '';
  const localCamOn = ctx?.localCamOn ?? true;
  const remoteCamOn = ctx?.remoteCamOn ?? true;
  const isMuted = ctx?.isMuted ?? false;

  const toggleCamera = useCallback(() => {
    try {
      const toggleFromVideoCall = (global as any).__toggleCamRef?.current;
      if (typeof toggleFromVideoCall === 'function') {
        toggleFromVideoCall();
        return;
      }
      // В PiP экран VideoCall размонтирован, ref обнулён — переключаем камеру через сессию и обновляем PiP state
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleCam === 'function') {
        const nextCamOn = !localCamOn;
        (global as any).__pipUpdateStateRef?.current?.({ localCamOn: nextCamOn });
        session.toggleCam().catch(() => {});
      }
    } catch (_) {}
  }, [localCamOn]);

  const toggleMic = useCallback(() => {
    try {
      const toggleFromVideoCall = (global as any).__toggleMicRef?.current;
      if (typeof toggleFromVideoCall === 'function') {
        toggleFromVideoCall();
        return;
      }
      const session = (global as any).__webrtcSessionRef?.current;
      if (session && typeof session.toggleMic === 'function') {
        const nextMuted = !isMuted;
        (global as any).__pipUpdateStateRef?.current?.({ isMuted: nextMuted });
        session.toggleMic();
      }
    } catch (_) {}
  }, [isMuted]);

  // Системный PiP: overlay = область контента (window), блок 9:16 по центру — совпадает с buildSystemPiPSourceRect на нативе.
  const dims = Dimensions.get('window');
  const W = typeof dims?.width === 'number' && dims.width > 0 ? dims.width : 400;
  const H = typeof dims?.height === 'number' && dims.height > 0 ? dims.height : 700;
  const pipRatioW = 9;
  const pipRatioH = 16;

  const onVideoCallScreen = isVideoCallScreen(currentRouteName);
  const isSystemPiPLayout = pendingSystemPiP || inSystemPiPMode;
  // При Android Back со страницы звонка разрешаем показать in-app PiP сразу, ещё до завершения goBack(),
  // иначе окно ждёт смены route и выглядит "задержанным".
  const showingInAppPiPDuringBackTransition =
    !isSystemPiPLayout &&
    onVideoCallScreen &&
    (global as any).__leavingVideoCallByBackRef?.current === true;
  // На экране VideoCall обычный in-app PiP не показываем. Исключение — явный уход по Back,
  // где маленькое окно нужно показать сразу. Для системного PiP по Back/leaveHint тоже оставляем
  // рендер оверлея с блоком 9:16, иначе в кадр попадёт экран звонка (чёрные/синие полосы).
  const shouldShowOverlay =
    visible &&
    !suppressOverlayForReturn &&
    (!onVideoCallScreen || isSystemPiPLayout || showingInAppPiPDuringBackTransition);

  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const dragStartPos = useRef({ x: 0, y: 0 });
  const pipPosRef = useRef(pipPos);
  pipPosRef.current = pipPos;

  const clampPosition = useCallback(
    (x: number, y: number) => ({
      x: Math.max(0, Math.min(W - PIP_W, x)),
      y: Math.max(0, Math.min(H - PIP_H, y)),
    }),
    [W, H]
  );

  const panResponder = useRef(
    PanResponder.create({
      // ВАЖНО: не перехватываем обычные тапы — иначе кнопки/Pressable внутри PiP не работают.
      // Перехватываем только когда это реальный drag (смещение больше порога).
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        const dx = Math.abs(gestureState.dx);
        const dy = Math.abs(gestureState.dy);
        return dx > 6 || dy > 6;
      },
      onMoveShouldSetPanResponderCapture: (_, gestureState) => {
        const dx = Math.abs(gestureState.dx);
        const dy = Math.abs(gestureState.dy);
        return dx > 6 || dy > 6;
      },
      onPanResponderGrant: () => {
        const pos = pipPosRef.current;
        dragStartPos.current = { x: pos.x, y: pos.y };
        translate.setValue({ x: 0, y: 0 });
      },
      onPanResponderMove: (_, gestureState) => {
        translate.setValue({ x: gestureState.dx, y: gestureState.dy });
      },
      onPanResponderRelease: (_, gestureState) => {
        const newX = dragStartPos.current.x + gestureState.dx;
        const newY = dragStartPos.current.y + gestureState.dy;
        const clamped = clampPosition(newX, newY);
        updatePiPPosition(clamped.x, clamped.y);
        translate.setValue({ x: 0, y: 0 });
      },
    })
  ).current;

  const returnToCallRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    returnToCallRef.current = returnToCall;
  }, [returnToCall]);

  if (!shouldShowOverlay) {
    return null;
  }

  const streamURL = remoteStream?.toURL?.();
  const canRenderVideo =
    allowVideoRender &&
    remoteStream &&
    (Platform.OS !== 'ios' || (streamURL && streamURL.length > 0));
  const session = (global as any).__webrtcSessionRef?.current;

  // Системный PiP: только видео собеседника по центру 9:16, без лишних элементов.
  if (isSystemPiPLayout) {
    const pipBlockW = W;
    const pipBlockH = (W * pipRatioH) / pipRatioW;
    const pipTop = Math.max(0, (H - pipBlockH) / 2);
    return (
      <PiPErrorBoundary onReturnRef={returnToCallRef}>
        <View pointerEvents="box-none" style={[styles.overlay, { width: W, height: H }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={returnToCall} android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true }}>
            {canRenderVideo && remoteStream ? (
              <View style={[styles.pipSystemVideoBlock, { left: 0, top: pipTop, width: pipBlockW, height: pipBlockH }]}>
                <RemoteVideo
                  remoteStream={remoteStream as any}
                  remoteCamOn={remoteCamOn}
                  remoteMuted={false}
                  isInactiveState={false}
                  wasFriendCallEnded={false}
                  started={true}
                  loading={false}
                  remoteViewKey={0}
                  showFriendBadge={false}
                  lang={defaultLang}
                  session={session}
                  partnerInPiP={false}
                  forceTextureView={true}
                  objectFit="contain"
                />
              </View>
            ) : (
              <View style={[styles.pipSystemVideoBlock, { left: 0, top: pipTop, width: pipBlockW, height: pipBlockH }]}>
                <View style={styles.placeholder} />
              </View>
            )}
          </Pressable>
        </View>
      </PiPErrorBoundary>
    );
  }

  // In-app PiP: маленькое перетаскиваемое окно
  return (
    <PiPErrorBoundary onReturnRef={returnToCallRef}>
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            styles.pipWindow,
            {
              left: pipPos.x,
              top: pipPos.y,
              width: PIP_W,
              height: PIP_H,
              transform: [
                { translateX: translate.x },
                { translateY: translate.y },
              ],
            },
          ]}
          {...panResponder.panHandlers}
        >
          <View style={[styles.pipWindowInner, { width: PIP_W, height: PIP_H }]}>
            <View style={styles.pipTopBar}>
              <Pressable
                onPress={toggleCamera}
                style={styles.pipTopBarBtn}
                hitSlop={8}
                android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
              >
                <View style={styles.pipTopBarIconCircle}>
                  <View style={styles.pipTopBarIconCenter}>
                    <MaterialIcons
                      name={localCamOn ? 'videocam' : 'videocam-off'}
                      size={24}
                      color={localCamOn ? '#fff' : '#E53935'}
                    />
                  </View>
                </View>
              </Pressable>
              <Pressable
                onPress={toggleMic}
                style={styles.pipTopBarBtn}
                hitSlop={8}
                android_ripple={{ color: 'rgba(255,255,255,0.2)', borderless: true }}
              >
                <View style={styles.pipTopBarIconCircle}>
                  <View style={styles.pipTopBarIconCenter}>
                    <MaterialIcons
                      name={isMuted ? 'mic-off' : 'mic'}
                      size={24}
                      color={isMuted ? '#E53935' : '#fff'}
                    />
                  </View>
                </View>
              </Pressable>
              <Pressable
                onPress={endCall}
                style={styles.pipTopBarBtn}
                hitSlop={8}
                android_ripple={{ color: 'rgba(229,57,53,0.4)', borderless: true }}
              >
                {({ pressed }) => (
                  <View style={styles.pipTopBarIconCircle}>
                    <View style={styles.pipTopBarIconCenter}>
                      <Text style={[styles.pipCloseText, pressed && styles.pipCloseTextPressed]}>✕</Text>
                    </View>
                  </View>
                )}
              </Pressable>
            </View>
            <Pressable
              style={styles.pipVideoArea}
              onPress={returnToCall}
              android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true }}
            >
              {!remoteCamOn ? (
                <View style={StyleSheet.absoluteFill}>
                  <AwayPlaceholder />
                </View>
              ) : canRenderVideo && remoteStream ? (
                <View style={StyleSheet.absoluteFill}>
                  {Platform.OS === 'android' ? (
                    <RTCView
                      key={`pip-inapp-${remoteStream.id}`}
                      stream={remoteStream}
                      streamURL={streamURL}
                      style={styles.rtcView}
                      objectFit="cover"
                      mirror={false}
                      {...({
                        renderToHardwareTextureAndroid: true,
                        zOrderMediaOverlay: false,
                        useTextureView: true,
                      } as any)}
                    />
                  ) : (
                    <RTCView
                      key={`pip-inapp-${remoteStream.id}`}
                      streamURL={streamURL!}
                      style={styles.rtcView}
                      objectFit="cover"
                      mirror={false}
                    />
                  )}
                </View>
              ) : (
                <PipPlaceholder avatarUri={partnerAvatarUrl} name={partnerName} />
              )}
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </PiPErrorBoundary>
  );
}

function PipPlaceholder({ avatarUri, name }: { avatarUri?: string; name: string }) {
  const [resolvedUri, ready] = useResolvedImageUri(avatarUri ?? '');
  return (
    <View style={styles.placeholder}>
      {ready && resolvedUri ? (
        <Image source={{ uri: resolvedUri }} style={styles.pipAvatar} resizeMode="cover" />
      ) : (
        <View style={styles.pipAvatarFallback}>
          <Text style={styles.pipAvatarText} numberOfLines={1}>
            {name ? name.trim().slice(0, 1).toUpperCase() : '?'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 9999,
    elevation: 9999,
    backgroundColor: '#000',
  },
  rtcView: {
    ...StyleSheet.absoluteFillObject,
  },
  // Для system PiP: без дополнительных трансформаций.
  // transform на TextureView в системном PiP на части Android
  // может давать визуальные артефакты вида "обрезанный и вставленный блок".
  rtcViewSystem: {
    ...StyleSheet.absoluteFillObject,
  },
  /** Блок 9:16 по центру экрана — в него попадает системный PiP capture. */
  pipSystemVideoBlock: {
    position: 'absolute',
    overflow: 'hidden',
  },
  placeholder: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#1a1a2e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipWindow: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 9999,
    elevation: 9999,
  },
  pipWindowInner: {
    position: 'absolute',
    backgroundColor: '#000',
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 8,
  },
  pipTopBar: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    height: 44,
    backgroundColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 1,
  },
  pipTopBarBtn: {
    width: 38,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipTopBarIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipTopBarIconCenter: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipCloseText: {
    color: '#fff',
    fontSize: 20,
  },
  pipCloseTextPressed: {
    color: '#E53935',
  },
  pipVideoArea: {
    ...StyleSheet.absoluteFillObject,
  },
  pipAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  pipAvatarFallback: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#3d3d5c',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipAvatarText: {
    color: '#E7EEF7',
    fontSize: 32,
  },
});
