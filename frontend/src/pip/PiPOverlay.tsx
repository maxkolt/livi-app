// src/pip/PiPOverlay.tsx
// In-app: горизонтальная плашка с превью и кнопками (без возврата в звонок по тапу на превью).
import React, { useContext, useRef, useCallback, useMemo, useState, useEffect } from 'react';
import {
  AppState,
  DeviceEventEmitter,
  Dimensions,
  StyleSheet,
  View,
  Pressable,
  Text,
  Animated,
  PanResponder,
  Image,
  Platform,
} from 'react-native';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { RTCView } from '@livekit/react-native-webrtc';
import { PiPContext } from './PiPContext';
import { logger } from '../../utils/logger';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { useAppTheme } from '../../theme/ThemeProvider';
import { WELCOME_HEADER_TITLE, WELCOME_NAV_ACTIVE_ACCENT } from '../../screens/home/constants';
import AwayPlaceholder from '../../components/AwayPlaceholder';
import {
  prepareDirectCallAudioReturnFromPiP,
  pipInAppBarEnteredFromAudioOnly,
  mediaStreamHasLiveVideo,
} from './pipPlaceholderOnly';
import { resolvePiPLocalMutedState } from '../../utils/activeCallSession';
import { displayAvatarLetter } from '../../screens/home/friendHelpers';
import { prepareDirectCallVideoExpandFromInAppPiP } from '../../utils/callAudioRoutePersist';
import { refreshCallBluetoothHeadsetConnectedCache } from '../../utils/nativeCallAudioProbe';
import {
  tryAutoSwitchInAppPiPToConnectedHeadset,
  tryAutoSwitchInAppPiPFromDisconnectedHeadset,
  isInAppPiPManualRouteLockActive,
} from '../../utils/inAppPiPHeadsetConnect';
import { isSystemPiPActiveOrEnteringSync } from '../../utils/pipMutex';
import { t, loadLang, defaultLang, type Lang } from '../../utils/i18n';
import { useLang } from '../../store/lang';

const PIP_BAR_H = 58;
const PIP_BAR_RADIUS = PIP_BAR_H / 2;
const PIP_PREVIEW_SIZE = 46;
/** Превью peer над плашкой кнопок: ширина = бар, выше по высоте. */
const PIP_VIDEO_PREVIEW_H = 140;
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
          <Text style={styles.errorFallbackText}>{t('pipPanelFailed', useLang.getState().lang)}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

type PiPOverlayProps = { currentRouteName?: string | null };

export default function PiPOverlay({ currentRouteName }: PiPOverlayProps) {
  const { isDark } = useAppTheme();
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
  const remoteStream = ctx?.remoteStream ?? null;
  const remoteCamOn = ctx?.remoteCamOn !== false;
  const allowVideoRender = ctx?.allowVideoRender === true;
  const remoteStreamVersion = ctx?.remoteStreamVersion ?? 0;
  const pipRemoteViewKey = ctx?.pipRemoteViewKey ?? 0;
  const [localMicMuted, setLocalMicMuted] = useState(isMuted);
  const [lang, setLang] = useState<Lang>(defaultLang);

  useEffect(() => {
    let cancelled = false;
    void loadLang().then((next) => {
      if (!cancelled) setLang(next);
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Headset auto-switch: events first; редкий backup poll (ICM иногда молчит на BT).
  useEffect(() => {
    if (!visible) return;
    const syncHeadset = () => {
      void (async () => {
        if (Platform.OS !== 'android' || isInAppPiPManualRouteLockActive()) return;
        const unplugged = await tryAutoSwitchInAppPiPFromDisconnectedHeadset();
        if (unplugged) return;
        const switched = await tryAutoSwitchInAppPiPToConnectedHeadset();
        if (switched) return;
        await refreshCallBluetoothHeadsetConnectedCache();
      })();
    };
    setLocalMicMuted(resolvePiPLocalMutedState());
    syncHeadset();
    const subDevice = DeviceEventEmitter.addListener('onAudioDeviceChanged', () => {
      syncHeadset();
    });
    const subAppState = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncHeadset();
    });
    // Backup: 6s вместо 1.4s — ловим BT, если ICM не прислал событие.
    const interval = setInterval(syncHeadset, 6000);
    return () => {
      subDevice.remove();
      subAppState.remove();
      clearInterval(interval);
    };
  }, [visible, isMuted]);

  const micIconMuted = visible ? localMicMuted : isMuted;
  const suppressInAppPiPOnCurrentRoute = shouldSuppressInAppPiPOnRoute(currentRouteName);

  const chrome = useMemo(
    () => ({
      barBg: isDark ? 'rgba(22, 22, 24, 0.98)' : 'rgba(36, 36, 38, 0.98)',
      /** Видео-блок чуть плотнее плашки — без просвечивания welcome. */
      videoBg: isDark ? 'rgb(22, 22, 24)' : 'rgb(36, 36, 38)',
      border: 'rgba(255, 255, 255, 0.08)',
      btnBg: 'rgba(255, 255, 255, 0.08)',
      btnBorder: 'rgba(255, 255, 255, 0.1)',
      /** Как заголовок «Звонки» на странице Calls. */
      icon: WELCOME_HEADER_TITLE,
      ripple: 'rgba(255, 255, 255, 0.14)',
      /** Краповый фон+рамка — muted mic / hangup (как на экране звонка). */
      dangerBg: 'rgba(163, 59, 79, 0.42)',
      dangerBorder: '#A33B4F',
      dangerIcon: '#F5E6EA',
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
  const localCamOn = ctx?.localCamOn === true;
  const peerHasLiveVideo = remoteCamOn && mediaStreamHasLiveVideo(remoteStream);
  /** Video UI → слот превью; audio UI → слот только когда peer уже шлёт live video (mid-PiP cam on). */
  const showPeerVideoPreviewSlot = !pipFromAudioOnly || peerHasLiveVideo;
  const remoteStreamUrl =
    remoteStream && typeof (remoteStream as any).toURL === 'function'
      ? String((remoteStream as any).toURL())
      : '';
  const showPeerLiveVideo =
    showPeerVideoPreviewSlot &&
    allowVideoRender &&
    peerHasLiveVideo &&
    !!remoteStreamUrl;
  /**
   * Ушли с видео-экрана в in-app PiP — подсветить «вернуться» только если реально есть video
   * (своя cam или live peer). Иначе video shell с cam off выглядел как «видео вкл»,
   * хотя у собеседника камера выключена.
   */
  const pipVideoReturnHighlight =
    !pipFromAudioOnly && (localCamOn || peerHasLiveVideo);
  /** Cam-off video shell → иконка трубки (как audio), но возврат всё ещё на video UI. */
  const pipReturnUsesPhoneIcon = pipFromAudioOnly || (!localCamOn && !peerHasLiveVideo);

  const returnToCallFromPiP = useCallback(() => {
    try {
      const g = global as any;
      const onVideoCallScreen = shouldSuppressInAppPiPOnRoute(currentRouteName);
      if (onVideoCallScreen) {
        if (!pipFromAudioOnly) {
          prepareDirectCallVideoExpandFromInAppPiP();
        }
        hidePiP();
        if (pipFromAudioOnly) {
          const fn = g.__returnToAudioCallRef?.current;
          if (typeof fn === 'function') {
            void fn({ skipNavigation: true, fromPiP: true });
          }
        } else {
          const expandFn = g.__expandDirectCallToVideoUiRef?.current;
          if (typeof expandFn === 'function') {
            void expandFn();
          }
        }
        return;
      }
      if (pipFromAudioOnly) {
        prepareDirectCallAudioReturnFromPiP();
        hidePiP();
        returnToCall({ preferAudioOnlyUi: true });
      } else {
        prepareDirectCallVideoExpandFromInAppPiP();
        hidePiP();
        returnToCall({ preferAudioOnlyUi: false });
      }
    } catch (_) {}
  }, [returnToCall, currentRouteName, hidePiP, pipFromAudioOnly]);

  const dims = Dimensions.get('window');
  const W = typeof dims?.width === 'number' && dims.width > 0 ? dims.width : 400;
  const H = typeof dims?.height === 'number' && dims.height > 0 ? dims.height : 700;

  // Пункт 5: ровно 3 кнопки — вернуться · mute · end.
  const pipBarW = useMemo(() => {
    const actionCount = 3;
    const actionSlots =
      actionCount * PIP_ACTION_OUTER + Math.max(0, actionCount - 1) * PIP_ACTION_GAP;
    const minW = PIP_PREVIEW_SIZE + PIP_BAR_H_PAD * 2 + PIP_AVATAR_ACTION_GAP + actionSlots;
    return Math.min(W - 16, minW);
  }, [W]);

  const pipClusterW = pipBarW;
  const pipClusterH = showPeerVideoPreviewSlot
    ? PIP_VIDEO_PREVIEW_H + PIP_BAR_H
    : PIP_BAR_H;

  const isSystemPiPLayout = pendingSystemPiP || inSystemPiPMode;
  // Ref выставляется синхронно в AboutToEnter — не держать RTCView рядом с CaptureHost.
  let suspendedForSystemPiP = false;
  try {
    suspendedForSystemPiP =
      (global as any).__pipSuspendedForSystemPiPRef?.current === true ||
      isSystemPiPActiveOrEnteringSync();
  } catch (_) {}
  const showingInAppPiPDuringBackTransition =
    !isSystemPiPLayout &&
    !suspendedForSystemPiP &&
    suppressInAppPiPOnCurrentRoute &&
    (global as any).__leavingVideoCallByBackRef?.current === true;
  const shouldShowOverlay =
    visible &&
    !suspendedForSystemPiP &&
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
      x: Math.max(0, Math.min(W - pipClusterW, x)),
      y: Math.max(0, Math.min(H - pipClusterH, y)),
    }),
    [W, H, pipClusterW, pipClusterH],
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
            styles.pipCluster,
            {
              left: pipPos.x,
              top: pipPos.y,
              width: pipClusterW,
              height: pipClusterH,
              transform: [{ translateX: translate.x }, { translateY: translate.y }],
            },
            showPeerVideoPreviewSlot ? styles.pipClusterShadow : null,
          ]}
          {...panResponder.panHandlers}
        >
          <View
            style={[
              styles.pipClusterBody,
              showPeerVideoPreviewSlot
                ? {
                    borderRadius: PIP_BAR_RADIUS,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: chrome.border,
                    backgroundColor: chrome.videoBg,
                    overflow: 'hidden',
                  }
                : null,
            ]}
          >
          {showPeerVideoPreviewSlot ? (
            <View
              style={[
                styles.pipVideoPreview,
                {
                  width: pipClusterW,
                  height: PIP_VIDEO_PREVIEW_H,
                  backgroundColor: chrome.videoBg,
                },
              ]}
              pointerEvents="none"
            >
              {showPeerLiveVideo ? (
                <RTCView
                  key={`pip-remote-${pipRemoteViewKey}-${remoteStreamVersion}`}
                  streamURL={remoteStreamUrl}
                  style={styles.pipVideoRtc}
                  objectFit="cover"
                  mirror={false}
                  zOrder={0}
                />
              ) : (
                <AwayPlaceholder logoSize={44} />
              )}
            </View>
          ) : null}
          <View
            style={[
              styles.pipBar,
              {
                width: pipClusterW,
                height: PIP_BAR_H,
                borderBottomLeftRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                borderBottomRightRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                borderTopLeftRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                borderTopRightRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
              },
            ]}
          >
            <View
              style={[
                styles.pipBarInner,
                {
                  backgroundColor: chrome.barBg,
                  borderColor: chrome.border,
                  borderBottomLeftRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                  borderBottomRightRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                  borderTopLeftRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                  borderTopRightRadius: showPeerVideoPreviewSlot ? 0 : PIP_BAR_RADIUS,
                  // С видео: рамка/тень на кластере — иначе elevation даёт щель на стыке.
                  ...(showPeerVideoPreviewSlot
                    ? {
                        borderWidth: 0,
                        shadowOpacity: 0,
                        elevation: 0,
                      }
                    : null),
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
              <PiPActionButton
                onPress={returnToCallFromPiP}
                accessibilityLabel={
                  pipReturnUsesPhoneIcon
                    ? t('returnToAudioCallA11y', lang)
                    : t('returnToVideoCall', lang)
                }
                chrome={chrome}
                active={pipVideoReturnHighlight}
                activeAccent={WELCOME_NAV_ACTIVE_ACCENT}
              >
                {pipReturnUsesPhoneIcon ? (
                  <MaterialCommunityIcons
                    name="phone-in-talk"
                    size={PIP_ICON_SIZE}
                    color={
                      pipVideoReturnHighlight
                        ? WELCOME_NAV_ACTIVE_ACCENT.softText
                        : chrome.icon
                    }
                  />
                ) : (
                  <MaterialIcons
                    name="videocam"
                    size={PIP_ICON_SIZE}
                    color={pipVideoReturnHighlight ? WELCOME_NAV_ACTIVE_ACCENT.softText : chrome.icon}
                  />
                )}
              </PiPActionButton>
              <PiPActionButton
                onPress={toggleMic}
                accessibilityLabel={t('microphone', lang)}
                chrome={chrome}
                danger={micIconMuted}
              >
                <MaterialIcons
                  name={micIconMuted ? 'mic-off' : 'mic'}
                  size={PIP_ICON_SIZE}
                  color={micIconMuted ? chrome.dangerIcon : chrome.icon}
                />
              </PiPActionButton>
              <PiPActionButton onPress={endCall} accessibilityLabel={t('endCall', lang)} chrome={chrome} danger>
                <MaterialIcons name="call-end" size={PIP_ICON_SIZE} color={chrome.dangerIcon} />
              </PiPActionButton>
              </View>
            </View>
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
  dangerBg: string;
  dangerBorder: string;
  dangerIcon: string;
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
  danger = false,
  active = false,
  activeAccent,
}: {
  onPress: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  accessibilityLabel?: string;
  chrome: PipChrome;
  /** Краповая заливка+рамка — как muted mic / hangup на аудиозвонке. */
  danger?: boolean;
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
          active && activeAccent
            ? {
                borderWidth: 1,
                borderColor: activeAccent.solid,
                backgroundColor: activeAccent.solid15,
              }
            : null,
          {
            backgroundColor: danger
              ? chrome.dangerBg
              : active && activeAccent
                ? activeAccent.solid15
                : chrome.btnBg,
            borderColor: danger
              ? chrome.dangerBorder
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
            {name ? displayAvatarLetter(name) : '?'}
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
  pipCluster: {
    position: 'absolute',
    zIndex: 10050,
    elevation: 10050,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  /** iOS-тень на кластере; elevation не трогаем — у pipCluster уже 10050 для z-order. */
  pipClusterShadow: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
  pipClusterBody: {
    flex: 1,
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  pipVideoPreview: {
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  pipVideoRtc: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  pipBar: {
    overflow: 'hidden',
  },
  pipBarInner: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: PIP_BAR_H_PAD,
    paddingVertical: PIP_BAR_H_PAD,
    gap: PIP_AVATAR_ACTION_GAP,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    shadowOpacity: 0.2,
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
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
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
