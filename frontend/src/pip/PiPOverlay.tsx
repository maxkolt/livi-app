// src/pip/PiPOverlay.tsx
// PiP в стиле WhatsApp/Telegram: видео собеседника, сверху слева X (завершить), справа камера (вкл/выкл). Тап по видео — вернуться в звонок.
import React, { useContext, useMemo, useRef, useEffect } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  View,
  Pressable,
  Image,
  Platform,
  Text,
} from 'react-native';
import { RTCView } from '@livekit/react-native-webrtc';
import { MaterialIcons } from '@expo/vector-icons';
import { PiPContext } from './PiPContext';
import { useResolvedImageUri } from '../../hooks/useResolvedImageUri';
import { logger } from '../../utils/logger';

/** При ошибке рендера (например "forEach of null" при выходе в PiP) показываем минимальный оверлей. Fallback — только View/Text и inline-стили, без контекста/StyleSheet/Pressable/MaterialIcons, чтобы не спровоцировать повторный forEach. */
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
          style={{
            position: 'absolute',
            left: 12,
            top: 120,
            width: 150,
            height: 260,
            zIndex: 9999,
            elevation: 9999,
            backgroundColor: 'rgba(25,32,46,0.95)',
            borderRadius: 16,
            justifyContent: 'center',
            alignItems: 'center',
            padding: 12,
          }}
          onStartShouldSetResponder={() => true}
          onResponderRelease={this._onFallbackTouch}
        >
          <Text style={{ color: '#E7EEF7', fontSize: 12, textAlign: 'center' }}>
            Тап — вернуться в звонок
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

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

// Безопасное чтение контекста: при "forEach of null" внутри React/контекста не падаем.
function usePiPContextSafe(): PiPContextValue | null {
  try {
    return useContext(PiPContext) ?? null;
  } catch (_) {
    return null;
  }
}

type PiPContextValue = React.ContextType<typeof PiPContext>;

export default function PiPOverlay() {
  const ctx = usePiPContextSafe();
  const visible = ctx?.visible ?? false;
  const callId = ctx?.callId ?? null;
  const roomId = ctx?.roomId ?? null;
  const partnerName = ctx?.partnerName ?? '';
  const partnerAvatarUrl = ctx?.partnerAvatarUrl;
  const remoteStream = ctx?.remoteStream ?? null;
  const returnToCall = ctx?.returnToCall ?? (() => {});
  const toggleCam = ctx?.toggleCam ?? (() => {});
  const endCall = ctx?.endCall ?? (() => {});
  const pipPos = ctx?.pipPos ?? { x: PAD, y: 120 };
  const updatePiPPosition = ctx?.updatePiPPosition ?? (() => {});
  const localCamOn = ctx?.localCamOn;
  const allowVideoRender = ctx?.allowVideoRender ?? false;
  const inSystemPiPMode = ctx?.inSystemPiPMode ?? false;
  const pendingSystemPiP = ctx?.pendingSystemPiP ?? false;

  // Не используем useSafeAreaInsets() здесь — при смене экрана/ремаунте он может давать "forEach of null" внутри провайдера.
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const dims = Dimensions.get('window');
  const W = typeof dims?.width === 'number' && dims.width > 0 ? dims.width : 400;
  const H = typeof dims?.height === 'number' && dims.height > 0 ? dims.height : 700;

  const safePosX = typeof pipPos?.x === 'number' && !Number.isNaN(pipPos.x) ? pipPos.x : PAD;
  const safePosY = typeof pipPos?.y === 'number' && !Number.isNaN(pipPos.y) ? pipPos.y : 120;

  // Системный PiP: окно уже имеет размер PiP — занимаем весь экран (0,0, W, H), только видео собеседника.
  // ВАЖНО: pendingSystemPiP нужен, чтобы заранее подготовить UI ДО enterPictureInPictureMode()
  // (иначе Android может "сфотографировать" HomeScreen + маленький in-app PiP).
  const isSystemPiP = !!inSystemPiPMode || !!pendingSystemPiP;
  const overlayWidth = isSystemPiP ? W : PIP_W;
  const overlayHeight = isSystemPiP ? H : PIP_H;

  const MIN_X = PAD + insets.left;
  const MIN_Y = PAD + insets.top;
  const MAX_X = Math.max(MIN_X, W - PIP_W - PAD - insets.right);
  const MAX_Y = Math.max(MIN_Y, H - PIP_H - PAD - insets.bottom);

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(v, b));

  const translate = useRef(
    new Animated.ValueXY({
      x: clamp(safePosX, MIN_X, MAX_X),
      y: clamp(safePosY, MIN_Y, MAX_Y),
    })
  ).current;
  const start = useRef({ x: 0, y: 0 });

  // В системном PiP (и в режиме подготовки pendingSystemPiP) окно на весь экран — сбрасываем позицию в (0,0),
  // но transform не убираем (избегаем forEach of null).
  useEffect(() => {
    if (isSystemPiP) {
      translate.setValue({ x: 0, y: 0 });
      return;
    }
    // При выходе из system/pending — вернуть оверлей в сохранённую позицию.
    translate.setValue({ x: clamp(safePosX, MIN_X, MAX_X), y: clamp(safePosY, MIN_Y, MAX_Y) });
  }, [isSystemPiP, translate, safePosX, safePosY, MIN_X, MAX_X, MIN_Y, MAX_Y]);

  const DRAG_THRESHOLD = 6;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          !isSystemPiP && (Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD),
        onPanResponderGrant: () => {
          // @ts-ignore
          start.current = { x: translate.x.__getValue(), y: translate.y.__getValue() };
        },
        onPanResponderMove: (_e, g) => {
          if (isSystemPiP) return;
          const nx = clamp(start.current.x + g.dx, MIN_X, MAX_X);
          const ny = clamp(start.current.y + g.dy, MIN_Y, MAX_Y);
          translate.setValue({ x: nx, y: ny });
        },
        onPanResponderRelease: (_e, g) => {
          if (isSystemPiP) {
            returnToCall();
            return;
          }
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
    [MIN_X, MAX_X, MIN_Y, MAX_Y, translate, updatePiPPosition, returnToCall, isSystemPiP]
  );

  useEffect(() => {
    const sub = Dimensions.addEventListener?.('change', ({ window }: { window: { width: number; height: number } }) => {
      const maxX = Math.max(MIN_X, (window?.width ?? W) - PIP_W - PAD - insets.right);
      const maxY = Math.max(MIN_Y, (window?.height ?? H) - PIP_H - PAD - insets.bottom);
      updatePiPPosition(clamp(safePosX, MIN_X, maxX), clamp(safePosY, MIN_Y, maxY));
    });
    return () => sub?.remove?.();
  }, [safePosX, safePosY, insets.right, insets.bottom, MIN_X, MIN_Y, W, H, updatePiPPosition]);

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

  const returnToCallRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    returnToCallRef.current = returnToCall;
  }, [returnToCall]);

  if (!visible) {
    return null;
  }

  const camOn = typeof localCamOn === 'boolean' ? localCamOn : true;
  const streamURL = remoteStream?.toURL?.();
  const canRenderVideo =
    allowVideoRender &&
    remoteStream &&
    (Platform.OS !== 'ios' || (streamURL && streamURL.length > 0));

  // Системный PiP: только видео собеседника на всю ширину и высоту окна PiP. In-app PiP: верхняя панель + видео.
  const showTopBar = !isSystemPiP;
  const videoObjectFit = isSystemPiP ? 'cover' : 'cover';
  const videoAreaStyle = isSystemPiP ? styles.videoAreaSystemPiP : styles.videoArea;
  const cardStyle = isSystemPiP ? [styles.card, styles.cardSystemPiP] : styles.card;

  return (
    <PiPErrorBoundary onReturnRef={returnToCallRef}>
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        {
          width: overlayWidth,
          height: overlayHeight,
          left: isSystemPiP ? 0 : undefined,
          top: isSystemPiP ? 0 : undefined,
          // Не убираем transform при системном PiP — иначе Animated может вызвать __getChildren().forEach(null) и краш.
          transform: [{ translateX: translate.x }, { translateY: translate.y }],
        },
      ]}
      {...panResponder.panHandlers}
    >
      <View style={cardStyle}>
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
                  // TextureView avoids black Surface overlays / flicker on some Android devices.
                  {...({
                    renderToHardwareTextureAndroid: true,
                    zOrderMediaOverlay: false,
                    // prop may be missing in types, but supported natively.
                    useTextureView: true,
                  } as any)}
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
    </PiPErrorBoundary>
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
    backgroundColor: '#000',
  },
  cardSystemPiP: {
    borderRadius: 0,
    borderWidth: 0,
    // В системном PiP должны перекрыть HomeScreen, чтобы в окне PiP не было UI приветствия.
    backgroundColor: '#000',
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
