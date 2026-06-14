// src/pip/PiPOverlay.tsx
// Два режима: in-app PiP (маленькое перетаскиваемое окно) и полноэкранный слой для входа в системный PiP.
import React, { useContext, useRef, useEffect, useCallback, useMemo } from 'react';
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
import AwayPlaceholder from '../../components/AwayPlaceholder';
import {
  isInAudioOnlyCallUi,
  resolvePreferAudioOnlyUiOnPiPReturn,
  shouldUsePipPlaceholderOnly,
} from './pipPlaceholderOnly';

const PIP_W = 130;
const PIP_H = 210;
/** Одинаковый отступ кнопок от краёв окна PiP */
const PIP_CORNER_INSET = 8;
const PIP_CORNER_BTN = 34;

const isRandomChatActive = () => {
  try {
    // RandomChat keeps this ref in sync: true means the screen is idle/inactive.
    return (global as any).__isInactiveStateRef?.current !== true;
  } catch {
    return true;
  }
};

const shouldSuppressInAppPiPOnRoute = (name?: string | null) =>
  name === 'VideoCall' || (name === 'RandomChat' && isRandomChatActive());

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
  const systemPiPCaptureActive = ctx?.systemPiPCaptureActive ?? false;
  const systemPiPCaptureRequestId = ctx?.systemPiPCaptureRequestId ?? 0;
  const suppressOverlayForReturn = ctx?.suppressOverlayForReturn ?? false;
  const pipPos = ctx?.pipPos ?? { x: 12, y: 120 };
  const updatePiPPosition = ctx?.updatePiPPosition ?? (() => {});
  const partnerAvatarUrl = ctx?.partnerAvatarUrl;
  const partnerName = ctx?.partnerName ?? '';
  const localCamOn = ctx?.localCamOn ?? true;
  const remoteCamOn = ctx?.remoteCamOn ?? true;
  const remoteStreamVersion = ctx?.remoteStreamVersion ?? 0;
  const pipRemoteViewKey = ctx?.pipRemoteViewKey ?? 0;
  const isMuted = ctx?.isMuted ?? false;
  const suppressInAppPiPOnCurrentRoute = shouldSuppressInAppPiPOnRoute(currentRouteName);

  const toggleCamera = useCallback(() => {
    try {
      const onVideoCallScreenNow = shouldSuppressInAppPiPOnRoute(currentRouteName);
      const toggleFromVideoCall = (global as any).__toggleCamRef?.current;
      if (onVideoCallScreenNow && typeof toggleFromVideoCall === 'function') {
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
  }, [currentRouteName, localCamOn]);

  const toggleMic = useCallback(() => {
    try {
      const onVideoCallScreenNow = shouldSuppressInAppPiPOnRoute(currentRouteName);
      const toggleFromVideoCall = (global as any).__toggleMicRef?.current;
      if (onVideoCallScreenNow && typeof toggleFromVideoCall === 'function') {
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
  }, [currentRouteName, isMuted]);

  const returnToAudioCall = useCallback(() => {
    try {
      const g = global as any;
      g.__preferAudioOnlyUiOnNextVideoCallRef = g.__preferAudioOnlyUiOnNextVideoCallRef || { current: false };
      g.__preferAudioOnlyUiOnNextVideoCallRef.current = true;
      g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
      g.__expandToVideoCallUiFromPiPRef.current = false;
      const onVideoCallScreen = shouldSuppressInAppPiPOnRoute(currentRouteName);
      const fn = g.__returnToAudioCallRef?.current;
      const session = g.__webrtcSessionRef?.current;
      if (onVideoCallScreen && typeof fn === 'function') {
        void fn({ skipNavigation: true });
        return;
      }
      if (typeof fn === 'function') {
        void fn({ fromPiP: true, skipNavigation: true });
      } else if (session && typeof session.enterDirectCallAudioOnlyMode === 'function') {
        void session.enterDirectCallAudioOnlyMode().catch(() => {});
      }
      const navFn = g.__pipReturnToAudioCallRef?.current;
      if (typeof navFn === 'function') {
        navFn();
        return;
      }
      returnToCall({ preferAudioOnlyUi: true });
    } catch (_) {}
  }, [returnToCall, currentRouteName]);

  /** Центр PiP: вернуть на тот UI звонка, с которого ушли (audio / video). Угол «телефон» — по-прежнему всегда audio. */
  const returnToCallFromCenter = useCallback(() => {
    try {
      const preferAudioOnlyUi = resolvePreferAudioOnlyUiOnPiPReturn({
        localCamOn,
        remoteCamOn,
        remoteStream,
      });
      returnToCall({ preferAudioOnlyUi });
    } catch (_) {
      returnToCall();
    }
  }, [returnToCall, localCamOn, remoteCamOn, remoteStream]);

  const dims = Dimensions.get('window');
  const W = typeof dims?.width === 'number' && dims.width > 0 ? dims.width : 400;
  const H = typeof dims?.height === 'number' && dims.height > 0 ? dims.height : 700;

  const isSystemPiPLayout = pendingSystemPiP || inSystemPiPMode;
  // При Android Back со страницы звонка разрешаем показать in-app PiP сразу, ещё до завершения goBack(),
  // иначе окно ждёт смены route и выглядит "задержанным".
  const showingInAppPiPDuringBackTransition =
    !isSystemPiPLayout &&
    suppressInAppPiPOnCurrentRoute &&
    (global as any).__leavingVideoCallByBackRef?.current === true;
  // На экране VideoCall обычный in-app PiP не показываем. Исключение — явный уход по Back,
  // где маленькое окно нужно показать сразу. Для system PiP capture теперь используется
  // отдельный fullscreen-host, поэтому обычный overlay в этот момент скрываем полностью.
  const shouldShowOverlay =
    visible &&
    !(systemPiPCaptureActive && systemPiPCaptureRequestId > 0) &&
    !suppressOverlayForReturn &&
    !isSystemPiPLayout &&
    (!suppressInAppPiPOnCurrentRoute || showingInAppPiPDuringBackTransition);

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
    returnToCallRef.current = returnToCallFromCenter;
  }, [returnToCallFromCenter]);

  const streamURL = remoteStream?.toURL?.();
  const pipHasLiveRemoteVideo = useMemo(() => {
    try {
      const t = (remoteStream as any)?.getVideoTracks?.()?.[0];
      return !!t && t.readyState === 'live' && t.enabled !== false;
    } catch {
      return false;
    }
  }, [remoteStream, remoteStreamVersion, pipRemoteViewKey]);
  const showPartnerAway = remoteCamOn === false;
  const pipPlaceholderOnly = shouldUsePipPlaceholderOnly({
    localCamOn,
    remoteCamOn,
    remoteStream,
  });
  const pipVideoToggleDisabled = isInAudioOnlyCallUi();
  const pipShowCamOffIcon = pipVideoToggleDisabled || !localCamOn;
  const canRenderVideo =
    shouldShowOverlay &&
    allowVideoRender &&
    remoteStream &&
    remoteCamOn !== false &&
    pipHasLiveRemoteVideo &&
    (Platform.OS !== 'ios' || (streamURL && streamURL.length > 0));
  const pipRtcViewKey = `pip-inapp-${remoteStream?.id ?? 'none'}-${remoteStreamVersion}-${pipRemoteViewKey}`;

  if (!shouldShowOverlay) {
    return null;
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
            <View style={[styles.pipCornerSlot, styles.pipCornerTL]} pointerEvents="box-none">
              <PiPCornerButton onPress={toggleCamera} disabled={pipVideoToggleDisabled}>
                <MaterialIcons
                  name={pipShowCamOffIcon ? 'videocam-off' : 'videocam'}
                  size={20}
                  color={pipShowCamOffIcon ? '#E53935' : '#fff'}
                />
              </PiPCornerButton>
            </View>
            <View style={[styles.pipCornerSlot, styles.pipCornerTR]} pointerEvents="box-none">
              <PiPCornerButton onPress={toggleMic}>
                <MaterialIcons
                  name={isMuted ? 'mic-off' : 'mic'}
                  size={20}
                  color={isMuted ? '#E53935' : '#fff'}
                />
              </PiPCornerButton>
            </View>
            <View style={[styles.pipCornerSlot, styles.pipCornerBL]} pointerEvents="box-none">
              <PiPCornerButton onPress={returnToAudioCall}>
                <MaterialIcons name="phone-in-talk" size={19} color="#fff" />
              </PiPCornerButton>
            </View>
            <View style={[styles.pipCornerSlot, styles.pipCornerBR]} pointerEvents="box-none">
              <PiPCornerButton onPress={endCall} rippleColor="rgba(229,57,53,0.4)">
                <MaterialIcons name="close" size={22} color="#fff" />
              </PiPCornerButton>
            </View>
            <Pressable
              style={styles.pipVideoArea}
              onPress={returnToCallFromCenter}
              android_ripple={{ color: 'rgba(255,255,255,0.08)', borderless: true }}
            >
              {pipPlaceholderOnly ? (
                <View style={StyleSheet.absoluteFill}>
                  <AwayPlaceholder />
                </View>
              ) : showPartnerAway ? (
                <View style={StyleSheet.absoluteFill}>
                  <AwayPlaceholder />
                </View>
              ) : canRenderVideo && remoteStream ? (
                <View style={StyleSheet.absoluteFill}>
                  {Platform.OS === 'android' ? (
                    <RTCView
                      key={pipRtcViewKey}
                      stream={remoteStream}
                      streamURL={streamURL}
                      style={styles.rtcView}
                      objectFit="contain"
                      mirror={false}
                      {...({
                        renderToHardwareTextureAndroid: true,
                        zOrderMediaOverlay: false,
                        useTextureView: true,
                      } as any)}
                    />
                  ) : (
                    <RTCView
                      key={pipRtcViewKey}
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

function PiPCornerButton({
  onPress,
  children,
  rippleColor = 'rgba(255,255,255,0.2)',
  disabled = false,
}: {
  onPress: () => void;
  children: React.ReactNode;
  rippleColor?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      style={[styles.pipCornerPressable, disabled && styles.pipCornerPressableDisabled]}
      hitSlop={6}
      android_ripple={disabled ? undefined : { color: rippleColor, borderless: true }}
    >
      <View style={styles.pipCornerIconCircle}>{children}</View>
    </Pressable>
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
  pipCornerSlot: {
    position: 'absolute',
    zIndex: 2,
    width: PIP_CORNER_BTN,
    height: PIP_CORNER_BTN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipCornerTL: {
    top: PIP_CORNER_INSET,
    left: PIP_CORNER_INSET,
  },
  pipCornerTR: {
    top: PIP_CORNER_INSET,
    right: PIP_CORNER_INSET,
  },
  pipCornerBL: {
    bottom: PIP_CORNER_INSET,
    left: PIP_CORNER_INSET,
  },
  pipCornerBR: {
    bottom: PIP_CORNER_INSET,
    right: PIP_CORNER_INSET,
  },
  pipCornerPressable: {
    width: PIP_CORNER_BTN,
    height: PIP_CORNER_BTN,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipCornerPressableDisabled: {
    opacity: 0.55,
  },
  pipCornerIconCircle: {
    width: PIP_CORNER_BTN,
    height: PIP_CORNER_BTN,
    borderRadius: PIP_CORNER_BTN / 2,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
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
