// src/pip/PiPOverlay.tsx
// In-app: горизонтальная плашка с превью и кнопками (без возврата в звонок по тапу на превью).
import React, { useContext, useRef, useCallback, useMemo, useState, useEffect } from 'react';
import {
  Dimensions,
  StyleSheet,
  View,
  Pressable,
  Text,
  Animated,
  PanResponder,
  Image,
} from 'react-native';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { PiPContext } from './PiPContext';
import { logger } from '../../utils/logger';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { useAppTheme } from '../../theme/ThemeProvider';
import { uiAccent } from '../../theme/uiAccent';
import {
  prepareDirectCallAudioReturnFromPiP,
  prepareDirectCallVideoReturnFromPiP,
  pipInAppBarEnteredFromAudioOnly,
} from './pipPlaceholderOnly';
import { resolvePiPLocalMutedState } from '../../utils/activeCallSession';
import {
  readInAppPiPAudioOutputRoute,
  toggleInAppPiPAudioOutputRoute,
} from '../../utils/inAppPiPAudioRoute';
import {
  iconNameForRoute,
  type InCallAudioRoute,
} from '../../components/VideoChat/hooks/audioRouteTypes';

const PIP_BAR_H = 58;
const PIP_BAR_RADIUS = PIP_BAR_H / 2;
const PIP_PREVIEW_SIZE = 46;
const PIP_ACTION_BTN = 36;
const PIP_ACTION_OUTER = PIP_ACTION_BTN + 2;
const PIP_ACTION_GAP = 6;
const PIP_BAR_H_PAD = 6;
const PIP_AVATAR_ACTION_GAP = 12;
const PIP_ICON_SIZE = 19;

const isRandomChatActive = () => {
  try {
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

class PiPErrorBoundary extends React.Component<
  { children: React.ReactNode },
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

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorFallback}>
          <Text style={styles.errorFallbackText}>Не удалось показать панель звонка</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

type PiPOverlayProps = { currentRouteName?: string | null };

export default function PiPOverlay({ currentRouteName }: PiPOverlayProps) {
  const { isDark } = useAppTheme();
  const accent = useMemo(() => uiAccent(isDark), [isDark]);
  const ctx = usePiPContextSafe();
  const visible = ctx?.visible ?? false;
  const returnToCall = ctx?.returnToCall ?? (() => {});
  const hidePiP = ctx?.hidePiP ?? (() => {});
  const endCall = ctx?.endCall ?? (() => {});
  const inSystemPiPMode = ctx?.inSystemPiPMode ?? false;
  const pendingSystemPiP = ctx?.pendingSystemPiP ?? false;
  const systemPiPCaptureActive = ctx?.systemPiPCaptureActive ?? false;
  const systemPiPCaptureRequestId = ctx?.systemPiPCaptureRequestId ?? 0;
  const suppressOverlayForReturn = ctx?.suppressOverlayForReturn ?? false;
  const pipPos = ctx?.pipPos ?? { x: 12, y: 120 };
  const updatePiPPosition = ctx?.updatePiPPosition ?? (() => {});
  const partnerAvatarUrl = ctx?.partnerAvatarUrl;
  const partnerName = ctx?.partnerName ?? '';
  const isMuted = ctx?.isMuted ?? false;
  const [localMicMuted, setLocalMicMuted] = useState(isMuted);
  const [pipAudioRoute, setPipAudioRoute] = useState<InCallAudioRoute>('EARPIECE');

  useEffect(() => {
    if (!visible) return;
    setLocalMicMuted(resolvePiPLocalMutedState());
    setPipAudioRoute(readInAppPiPAudioOutputRoute());
  }, [visible, isMuted]);

  const micIconMuted = visible ? localMicMuted : isMuted;
  const suppressInAppPiPOnCurrentRoute = shouldSuppressInAppPiPOnRoute(currentRouteName);

  const chrome = useMemo(
    () => ({
      barBg: isDark ? 'rgba(22, 22, 24, 0.98)' : 'rgba(36, 36, 38, 0.98)',
      border: 'rgba(255, 255, 255, 0.08)',
      btnBg: 'rgba(255, 255, 255, 0.08)',
      btnBorder: 'rgba(255, 255, 255, 0.1)',
      icon: 'rgba(255, 255, 255, 0.92)',
      iconOff: '#E57373',
      ripple: 'rgba(255, 255, 255, 0.14)',
      endCallBorder: 'rgba(229, 57, 53, 0.72)',
    }),
    [isDark],
  );

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
        session.toggleMic();
        const enabled =
          typeof session.getIsMicOn === 'function' ? session.getIsMicOn() : !micIconMuted;
        (global as any).__pipUpdateStateRef?.current?.({ isMuted: !enabled });
        setLocalMicMuted(!enabled);
      }
    } catch (_) {}
  }, [currentRouteName, micIconMuted]);

  useEffect(() => {
    if (!visible) {
      setLocalMicMuted(false);
    }
  }, [visible]);

  const pipFromAudioOnly = pipInAppBarEnteredFromAudioOnly();
  /** Ушли с видео-экрана в in-app PiP — подсветить «вернуться в видео», как активный динамик. */
  const pipVideoReturnHighlight = !pipFromAudioOnly;
  const loudSpeakerActive = pipAudioRoute === 'SPEAKER_PHONE';
  const pipAudioRouteIcon = iconNameForRoute(pipAudioRoute);

  const toggleAudioOutputRoute = useCallback(() => {
    const next = toggleInAppPiPAudioOutputRoute();
    if (next) {
      setPipAudioRoute(next);
    } else {
      setPipAudioRoute(readInAppPiPAudioOutputRoute());
    }
  }, []);

  const showAudioReturnFromVideoPiP = useMemo(() => {
    if (pipFromAudioOnly) return false;
    try {
      const g = global as any;
      const session = g.__webrtcSessionRef?.current;
      const live = session && typeof session.isEnded === 'function' && !session.isEnded();
      const params = g.__currentCallPiPParamsRef?.current;
      const direct =
        params?.navParams?.directCall === true ||
        params?.navParams?.directCall === undefined;
      return !!(live && direct && (params?.callId || session?.getCallId?.()));
    } catch {
      return false;
    }
  }, [pipFromAudioOnly, visible]);

  const returnToAudioFromVideoPiP = useCallback(() => {
    try {
      const g = global as any;
      const onVideoCallScreen = shouldSuppressInAppPiPOnRoute(currentRouteName);
      hidePiP();
      if (onVideoCallScreen) {
        const fn = g.__returnToAudioCallRef?.current;
        if (typeof fn === 'function') {
          void fn({ skipNavigation: true, fromPiP: true });
        }
        return;
      }
      prepareDirectCallAudioReturnFromPiP();
      returnToCall({ preferAudioOnlyUi: true });
    } catch (_) {}
  }, [returnToCall, currentRouteName, hidePiP]);

  const returnToCallFromPiP = useCallback(() => {
    try {
      const g = global as any;
      const onVideoCallScreen = shouldSuppressInAppPiPOnRoute(currentRouteName);
      if (onVideoCallScreen) {
        hidePiP();
        if (pipFromAudioOnly) {
          const fn = g.__returnToAudioCallRef?.current;
          if (typeof fn === 'function') {
            void fn({ skipNavigation: true, fromPiP: true });
          }
        } else {
          g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
          g.__expandToVideoCallUiFromPiPRef.current = true;
        }
        return;
      }
      hidePiP();
      if (pipFromAudioOnly) {
        prepareDirectCallAudioReturnFromPiP();
        returnToCall({ preferAudioOnlyUi: true });
      } else {
        returnToCall({ preferAudioOnlyUi: false });
      }
    } catch (_) {}
  }, [returnToCall, currentRouteName, hidePiP, pipFromAudioOnly]);

  const openVideoCallFromAudioPiP = useCallback(() => {
    try {
      const g = global as any;
      const onVideoCallScreen = shouldSuppressInAppPiPOnRoute(currentRouteName);
      hidePiP();
      if (onVideoCallScreen) {
        prepareDirectCallVideoReturnFromPiP();
        g.__expandToVideoCallUiFromPiPRef = g.__expandToVideoCallUiFromPiPRef || { current: false };
        g.__expandToVideoCallUiFromPiPRef.current = true;
        return;
      }
      prepareDirectCallVideoReturnFromPiP();
      returnToCall({ preferAudioOnlyUi: false });
    } catch (_) {}
  }, [returnToCall, currentRouteName, hidePiP]);

  const dims = Dimensions.get('window');
  const W = typeof dims?.width === 'number' && dims.width > 0 ? dims.width : 400;
  const H = typeof dims?.height === 'number' && dims.height > 0 ? dims.height : 700;

  const pipBarW = useMemo(() => {
    let actionCount = 3;
    if (showAudioReturnFromVideoPiP) actionCount += 1;
    if (pipFromAudioOnly) actionCount += 1;
    actionCount += 1;
    const actionSlots =
      actionCount * PIP_ACTION_OUTER + Math.max(0, actionCount - 1) * PIP_ACTION_GAP;
    const minW = PIP_PREVIEW_SIZE + PIP_BAR_H_PAD * 2 + PIP_AVATAR_ACTION_GAP + actionSlots;
    return Math.min(W - 16, minW);
  }, [W, showAudioReturnFromVideoPiP, pipFromAudioOnly]);

  const isSystemPiPLayout = pendingSystemPiP || inSystemPiPMode;
  const showingInAppPiPDuringBackTransition =
    !isSystemPiPLayout &&
    suppressInAppPiPOnCurrentRoute &&
    (global as any).__leavingVideoCallByBackRef?.current === true;
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
      x: Math.max(0, Math.min(W - pipBarW, x)),
      y: Math.max(0, Math.min(H - PIP_BAR_H, y)),
    }),
    [W, H, pipBarW],
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        const dx = Math.abs(gestureState.dx);
        const dy = Math.abs(gestureState.dy);
        return dx > 8 || dy > 8;
      },
      onMoveShouldSetPanResponderCapture: (_, gestureState) => {
        const dx = Math.abs(gestureState.dx);
        const dy = Math.abs(gestureState.dy);
        return dx > 8 || dy > 8;
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
    }),
  ).current;

  if (!shouldShowOverlay) {
    return null;
  }

  return (
    <PiPErrorBoundary>
      <View pointerEvents="box-none" style={styles.pipRoot}>
        <Animated.View
          style={[
            styles.pipBar,
            {
              left: pipPos.x,
              top: pipPos.y,
              width: pipBarW,
              height: PIP_BAR_H,
              borderRadius: PIP_BAR_RADIUS,
              transform: [{ translateX: translate.x }, { translateY: translate.y }],
            },
          ]}
          {...panResponder.panHandlers}
        >
          <View
            style={[
              styles.pipBarInner,
              {
                backgroundColor: chrome.barBg,
                borderColor: chrome.border,
              },
            ]}
          >
            <View style={styles.pipAvatarSlot} pointerEvents="none">
              <PipPlaceholder
                avatarUri={partnerAvatarUrl}
                name={partnerName}
                compact
                avatarSize={PIP_PREVIEW_SIZE}
              />
            </View>

            <View style={[styles.pipActionsRow, { gap: PIP_ACTION_GAP }]} pointerEvents="box-none">
              {showAudioReturnFromVideoPiP ? (
                <PiPActionButton
                  onPress={returnToAudioFromVideoPiP}
                  accessibilityLabel="Вернуться в аудиозвонок"
                  chrome={chrome}
                >
                  <MaterialCommunityIcons name="phone-in-talk" size={PIP_ICON_SIZE} color={chrome.icon} />
                </PiPActionButton>
              ) : null}
              <PiPActionButton
                onPress={returnToCallFromPiP}
                accessibilityLabel={pipFromAudioOnly ? 'Вернуться в аудиозвонок' : 'Вернуться в видеозвонок'}
                chrome={chrome}
                active={pipVideoReturnHighlight}
                activeAccent={accent}
              >
                {pipFromAudioOnly ? (
                  <MaterialCommunityIcons name="phone-in-talk" size={PIP_ICON_SIZE} color={chrome.icon} />
                ) : (
                  <MaterialIcons
                    name="videocam"
                    size={PIP_ICON_SIZE}
                    color={pipVideoReturnHighlight ? accent.softText : chrome.icon}
                  />
                )}
              </PiPActionButton>
              {pipFromAudioOnly ? (
                <PiPActionButton
                  onPress={openVideoCallFromAudioPiP}
                  accessibilityLabel="Вернуться в видеозвонок"
                  chrome={chrome}
                >
                  <MaterialIcons name="videocam" size={PIP_ICON_SIZE} color={chrome.icon} />
                </PiPActionButton>
              ) : null}
              <PiPActionButton
                onPress={toggleAudioOutputRoute}
                accessibilityLabel="Переключить динамик"
                chrome={chrome}
                active={loudSpeakerActive}
                activeAccent={accent}
              >
                {pipAudioRouteIcon === 'ear-hearing' ? (
                  <MaterialCommunityIcons
                    name="ear-hearing"
                    size={PIP_ICON_SIZE}
                    color={loudSpeakerActive ? accent.softText : chrome.icon}
                  />
                ) : (
                  <MaterialIcons
                    name={pipAudioRouteIcon}
                    size={PIP_ICON_SIZE}
                    color={loudSpeakerActive ? accent.softText : chrome.icon}
                  />
                )}
              </PiPActionButton>
              <PiPActionButton onPress={toggleMic} accessibilityLabel="Микрофон" chrome={chrome}>
                <MaterialIcons
                  name={micIconMuted ? 'mic-off' : 'mic'}
                  size={PIP_ICON_SIZE}
                  color={micIconMuted ? chrome.iconOff : chrome.icon}
                />
              </PiPActionButton>
              <PiPActionButton onPress={endCall} accessibilityLabel="Завершить" chrome={chrome} endCall>
                <MaterialIcons name="call-end" size={PIP_ICON_SIZE} color={chrome.endCallBorder} />
              </PiPActionButton>
            </View>
          </View>
        </Animated.View>
      </View>
    </PiPErrorBoundary>
  );
}

type PipChrome = {
  btnBg: string;
  btnBorder: string;
  ripple: string;
  endCallBorder: string;
};

type PipActiveAccent = {
  solid: string;
  solid15: string;
};

function PiPActionButton({
  onPress,
  children,
  disabled = false,
  accessibilityLabel,
  chrome,
  endCall = false,
  active = false,
  activeAccent,
}: {
  onPress: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  accessibilityLabel?: string;
  chrome: PipChrome;
  endCall?: boolean;
  active?: boolean;
  activeAccent?: PipActiveAccent;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.pipActionPressable,
        pressed && !disabled && styles.pipActionPressablePressed,
        disabled && styles.pipActionPressableDisabled,
      ]}
      hitSlop={4}
      android_ripple={
        disabled
          ? undefined
          : {
              color: chrome.ripple,
              borderless: true,
              radius: PIP_ACTION_BTN / 2,
            }
      }
    >
      <View
        style={[
          styles.pipActionCircle,
          endCall && styles.pipActionCircleEndCall,
          active && activeAccent
            ? {
                borderWidth: 2,
                borderColor: activeAccent.solid,
                backgroundColor: activeAccent.solid15,
              }
            : null,
          {
            backgroundColor:
              active && activeAccent ? activeAccent.solid15 : chrome.btnBg,
            borderColor: endCall
              ? chrome.endCallBorder
              : active && activeAccent
                ? activeAccent.solid
                : chrome.btnBorder,
          },
        ]}
      >
        {children}
      </View>
    </Pressable>
  );
}

function PipPlaceholder({
  avatarUri,
  name,
  compact,
  avatarSize,
}: {
  avatarUri?: string;
  name: string;
  compact?: boolean;
  avatarSize?: number;
}) {
  const [resolvedUri, ready] = useResolvedImageUri(avatarUri ?? '');
  const [imageFailed, setImageFailed] = useState(false);
  const size = avatarSize ?? (compact ? 46 : 80);
  const avatarStyle = { width: size, height: size, borderRadius: size / 2 };

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUri, resolvedUri]);

  const showImage = ready && !!resolvedUri && !imageFailed;

  return (
    <View style={[styles.pipAvatarClip, avatarStyle]}>
      {showImage ? (
        <Image
          source={{ uri: resolvedUri }}
          style={avatarStyle}
          resizeMode="cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <View style={[styles.pipAvatarFallback, avatarStyle, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
          <Text style={[styles.pipAvatarText, compact && styles.pipAvatarTextCompact]} numberOfLines={1}>
            {name ? name.trim().slice(0, 1).toUpperCase() : '?'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pipRoot: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10050,
    elevation: 10050,
  },
  pipBar: {
    position: 'absolute',
    zIndex: 10050,
    elevation: 10050,
    overflow: 'hidden',
  },
  pipBarInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: PIP_BAR_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: PIP_BAR_H_PAD,
    paddingVertical: PIP_BAR_H_PAD,
    gap: PIP_AVATAR_ACTION_GAP,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
    elevation: 12,
    overflow: 'hidden',
  },
  pipAvatarSlot: {
    width: PIP_PREVIEW_SIZE,
    height: PIP_PREVIEW_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  pipAvatarClip: {
    overflow: 'hidden',
  },
  pipActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    flexShrink: 0,
  },
  pipActionPressable: {
    width: PIP_ACTION_OUTER,
    height: PIP_ACTION_OUTER,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipActionPressablePressed: {
    opacity: 0.88,
  },
  pipActionPressableDisabled: {
    opacity: 0.45,
  },
  pipActionCircle: {
    width: PIP_ACTION_BTN,
    height: PIP_ACTION_BTN,
    borderRadius: PIP_ACTION_BTN / 2,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipActionCircleEndCall: {
    borderWidth: 1,
  },
  pipAvatarFallback: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipAvatarText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 32,
  },
  pipAvatarTextCompact: {
    fontSize: 16,
  },
  errorFallback: {
    position: 'absolute',
    left: 12,
    bottom: 100,
    zIndex: 10050,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: 'rgba(24,24,26,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  errorFallbackText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 13,
  },
});
