// components/MediaViewer.tsx
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Animated,
  Platform,
  Image,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView, PinchGestureHandler, PanGestureHandler, State, FlatList } from 'react-native-gesture-handler';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { saveImageToGallery } from '../utils/saveToGallery';
import * as ImageManipulator from 'expo-image-manipulator';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Modal from 'react-native-modal';
import { LIVI } from '../utils/i18n';
import { API_BASE } from '../sockets/socket';
import { useLang } from '../store/lang';
import { t } from '../utils/i18n';
import PhotoEditor from '@baronha/react-native-photo-editor';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import { prefetchImages } from '../utils/imageOptimization';

function resolveViewerUri(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/uploads/')) return `${API_BASE}${value}`;
  return value;
}

function ViewerImage({ uri }: { uri: string }) {
  const isAndroidData = Platform.OS === 'android' && !!uri && /^data:/i.test(uri);
  const [androidFileUri, dataReady] = useResolvedImageUri(isAndroidData ? uri : '');
  const imageSourceUri = isAndroidData ? androidFileUri : uri;
  if (!imageSourceUri || (isAndroidData && !dataReady)) {
    return <View style={styles.image} />;
  }
  return (
    <ExpoImage
      source={{ uri: imageSourceUri }}
      style={styles.image}
      contentFit="contain"
      cachePolicy="memory-disk"
      transition={0}
      recyclingKey={uri}
      priority="high"
      allowDownscaling
    />
  );
}

const AlbumStillSlide = React.memo(function AlbumStillSlide({
  uri,
  width,
  height,
}: {
  uri: string;
  width: number;
  height: number;
}) {
  return (
    <View style={{ width, height, justifyContent: 'center', alignItems: 'center' }}>
      <ViewerImage uri={uri} />
    </View>
  );
}, (prev, next) => prev.uri === next.uri && prev.width === next.width && prev.height === next.height);

interface MediaViewerProps {
  visible: boolean;
  onClose: () => void;
  /** Called after close animation — safe to drop viewer payload in parent state. */
  onClosed?: () => void;
  mediaType: 'image';
  uri: string;
  name?: string;
  onSend?: (finalUri: string) => void;
  /** All photos in the same chat message. Swipe between them when length > 1. */
  uris?: string[];
  initialIndex?: number;
}

export default function MediaViewer({ 
  visible, 
  onClose,
  onClosed,
  mediaType, 
  uri, 
  name,
  onSend,
  uris,
  initialIndex = 0,
}: MediaViewerProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const lang = useLang((s) => s.lang);
  const [busy, setBusy] = React.useState(false);
  const pagerRef = React.useRef<FlatList<string>>(null);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [editsByIndex, setEditsByIndex] = React.useState<Record<number, string>>({});
  const albumOpenIndexRef = React.useRef(0);
  const albumLayoutSyncedRef = React.useRef(false);
  const activeIndexRef = React.useRef(0);
  const [cropMode, setCropMode] = React.useState(false);
  const [cropRect, setCropRect] = React.useState<{ x: number; y: number; w: number; h: number }>(() => ({
    x: Math.round(screenWidth * 0.1),
    y: Math.round(screenHeight * 0.2),
    w: Math.round(screenWidth * 0.8),
    h: Math.round(screenWidth * 0.8),
  }));
  const cropRectRef = React.useRef(cropRect);
  React.useEffect(() => {
    cropRectRef.current = cropRect;
  }, [cropRect]);

  const sourceUris = React.useMemo(() => {
    const list = (Array.isArray(uris) && uris.length > 0 ? uris : [uri])
      .map((item) => resolveViewerUri(item))
      .filter(Boolean);
    if (list.length > 0) return list;
    const fallback = resolveViewerUri(uri);
    return fallback ? [fallback] : [];
  }, [uris, uri]);

  const isAlbum = sourceUris.length > 1;
  const currentUri = editsByIndex[activeIndex] || sourceUris[activeIndex] || '';
  const displayUris = React.useMemo(
    () => sourceUris.map((item, index) => editsByIndex[index] || item),
    [sourceUris, editsByIndex],
  );

  // Pinch-to-zoom
  const pinchScale = React.useRef(new Animated.Value(1)).current;
  const baseScale = React.useRef(new Animated.Value(1)).current;
  const lastScale = React.useRef(1);
  const scale = Animated.multiply(baseScale, pinchScale);
  const [scaleNumber, setScaleNumber] = React.useState(1);

  // Pan (to inspect corners when zoomed)
  const [containerSize, setContainerSize] = React.useState<{ w: number; h: number }>({ w: screenWidth, h: screenHeight });
  const translateX = React.useRef(new Animated.Value(0)).current;
  const translateY = React.useRef(new Animated.Value(0)).current;
  const lastTranslate = React.useRef({ x: 0, y: 0 });

  React.useEffect(() => {
    setContainerSize({ w: screenWidth, h: screenHeight });
    setCropRect({
      x: Math.round(screenWidth * 0.1),
      y: Math.round(screenHeight * 0.2),
      w: Math.round(screenWidth * 0.8),
      h: Math.round(screenWidth * 0.8),
    });
  }, [screenWidth, screenHeight]);

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  const getPanBounds = (s: number) => {
    const maxX = (containerSize.w * (s - 1)) / 2;
    const maxY = (containerSize.h * (s - 1)) / 2;
    return { maxX, maxY };
  };

  const onPinchEvent = Animated.event([{ nativeEvent: { scale: pinchScale } }], {
    useNativeDriver: true,
  });

  const onPinchStateChange = (e: any) => {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      let next = lastScale.current * e.nativeEvent.scale;
      // Clamp scale between 1x and 6x
      next = Math.max(1, Math.min(next, 6));
      lastScale.current = next;
      setScaleNumber(next);
      baseScale.setValue(next);
      pinchScale.setValue(1);

      // When zoom resets to 1x, reset panning too.
      if (next === 1) {
        lastTranslate.current = { x: 0, y: 0 };
        translateX.setValue(0);
        translateY.setValue(0);
      } else {
        // Clamp current translate within bounds after scale change.
        const { maxX, maxY } = getPanBounds(next);
        const nx = clamp(lastTranslate.current.x, -maxX, maxX);
        const ny = clamp(lastTranslate.current.y, -maxY, maxY);
        lastTranslate.current = { x: nx, y: ny };
        translateX.setValue(nx);
        translateY.setValue(ny);
      }
    }
  };

  const onPanEvent = (e: any) => {
    if (scaleNumber <= 1) return;
    const dx = Number(e?.nativeEvent?.translationX || 0);
    const dy = Number(e?.nativeEvent?.translationY || 0);
    const { maxX, maxY } = getPanBounds(scaleNumber);
    const nx = clamp(lastTranslate.current.x + dx, -maxX, maxX);
    const ny = clamp(lastTranslate.current.y + dy, -maxY, maxY);
    translateX.setValue(nx);
    translateY.setValue(ny);
  };

  const onPanStateChange = (e: any) => {
    if (e?.nativeEvent?.oldState === State.ACTIVE) {
      if (scaleNumber <= 1) {
        lastTranslate.current = { x: 0, y: 0 };
        translateX.setValue(0);
        translateY.setValue(0);
        return;
      }
      const dx = Number(e?.nativeEvent?.translationX || 0);
      const dy = Number(e?.nativeEvent?.translationY || 0);
      const { maxX, maxY } = getPanBounds(scaleNumber);
      const nx = clamp(lastTranslate.current.x + dx, -maxX, maxX);
      const ny = clamp(lastTranslate.current.y + dy, -maxY, maxY);
      lastTranslate.current = { x: nx, y: ny };
      translateX.setValue(nx);
      translateY.setValue(ny);
    }
  };

  // === Crop rectangle gestures (freeform) ===
  const cropLast = React.useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const MIN_CROP_SIZE = 64;
  const clampRect = React.useCallback(
    (r: { x: number; y: number; w: number; h: number }) => {
      const maxW = Math.max(MIN_CROP_SIZE, containerSize.w);
      const maxH = Math.max(MIN_CROP_SIZE, containerSize.h);
      const w = clamp(r.w, MIN_CROP_SIZE, maxW);
      const h = clamp(r.h, MIN_CROP_SIZE, maxH);
      const x = clamp(r.x, 0, Math.max(0, containerSize.w - w));
      const y = clamp(r.y, 0, Math.max(0, containerSize.h - h));
      return { x, y, w, h };
    },
    [containerSize, clamp]
  );

  const beginCropDrag = React.useCallback(() => {
    cropLast.current = cropRectRef.current;
  }, []);

  const onCropMoveEvent = React.useCallback(
    (e: any) => {
      if (!cropMode) return;
      const base = cropLast.current || cropRectRef.current;
      const dx = Number(e?.nativeEvent?.translationX || 0);
      const dy = Number(e?.nativeEvent?.translationY || 0);
      setCropRect(clampRect({ ...base, x: base.x + dx, y: base.y + dy }));
    },
    [cropMode, clampRect]
  );

  const onCropMoveState = React.useCallback(
    (e: any) => {
      if (!cropMode) return;
      if (e?.nativeEvent?.oldState === State.ACTIVE) {
        cropLast.current = cropRectRef.current;
      }
    },
    [cropMode]
  );

  type Corner = 'tl' | 'tr' | 'bl' | 'br';
  const onCornerEvent = React.useCallback(
    (corner: Corner, e: any) => {
      if (!cropMode) return;
      const base = cropLast.current || cropRectRef.current;
      const dx = Number(e?.nativeEvent?.translationX || 0);
      const dy = Number(e?.nativeEvent?.translationY || 0);

      let { x, y, w, h } = base;
      if (corner === 'tl') {
        x = x + dx;
        y = y + dy;
        w = w - dx;
        h = h - dy;
      } else if (corner === 'tr') {
        y = y + dy;
        w = w + dx;
        h = h - dy;
      } else if (corner === 'bl') {
        x = x + dx;
        w = w - dx;
        h = h + dy;
      } else if (corner === 'br') {
        w = w + dx;
        h = h + dy;
      }

      // normalize if user drags past the opposite side
      if (w < MIN_CROP_SIZE) {
        const diff = MIN_CROP_SIZE - w;
        if (corner === 'tl' || corner === 'bl') x -= diff;
        w = MIN_CROP_SIZE;
      }
      if (h < MIN_CROP_SIZE) {
        const diff = MIN_CROP_SIZE - h;
        if (corner === 'tl' || corner === 'tr') y -= diff;
        h = MIN_CROP_SIZE;
      }

      setCropRect(clampRect({ x, y, w, h }));
    },
    [cropMode, clampRect]
  );

  const onCornerState = React.useCallback(
    (e: any) => {
      if (!cropMode) return;
      if (e?.nativeEvent?.oldState === State.ACTIVE) {
        cropLast.current = cropRectRef.current;
      }
    },
    [cropMode]
  );

  const ensureLocalFile = React.useCallback(async (): Promise<string> => {
    // Если уже локальный файл
    if (/^(file|content):\/\//i.test(currentUri)) return currentUri;
    const baseName = (name || currentUri.split('?')[0].split('#')[0].split('/').pop() || `image_${Date.now()}`).toString();
    const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(baseName);
    const fileName = hasExt ? baseName : `${baseName}.jpg`;
    const target = FileSystem.cacheDirectory + fileName;
    try {
      const { uri: localUri } = await FileSystem.downloadAsync(currentUri, target);
      return localUri;
    } catch (e) {
      throw e;
    }
  }, [currentUri, name]);

  const resetZoomPan = React.useCallback(() => {
    lastScale.current = 1;
    setScaleNumber(1);
    baseScale.setValue(1);
    pinchScale.setValue(1);
    lastTranslate.current = { x: 0, y: 0 };
    translateX.setValue(0);
    translateY.setValue(0);
  }, [baseScale, pinchScale, translateX, translateY]);

  const commitActiveUri = React.useCallback((nextUri: string) => {
    setEditsByIndex((prev) => ({ ...prev, [activeIndex]: nextUri }));
  }, [activeIndex]);

  const pageWidth = containerSize.w;
  const pageHeight = containerSize.h;
  const albumPagerReady = pageWidth > 0 && pageHeight > 0;

  React.useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  React.useEffect(() => {
    if (!visible) {
      albumLayoutSyncedRef.current = false;
      return;
    }
    const max = Math.max(0, sourceUris.length - 1);
    const idx = Math.max(0, Math.min(Number(initialIndex) || 0, max));
    albumOpenIndexRef.current = idx;
    setActiveIndex(idx);
    setEditsByIndex({});
    setCropMode(false);
    resetZoomPan();
  }, [visible, initialIndex, sourceUris.length, resetZoomPan]);

  React.useEffect(() => {
    if (!visible || !isAlbum || displayUris.length === 0) return;
    const prefetchable = displayUris.filter((u) => /^https?:\/\//i.test(u));
    if (prefetchable.length > 0) void prefetchImages(prefetchable);
  }, [visible, isAlbum, displayUris]);

  React.useEffect(() => {
    if (!isAlbum) return;
    setCropMode((prev) => (prev ? false : prev));
  }, [activeIndex, isAlbum]);

  const syncActiveIndexFromOffset = React.useCallback(
    (offsetX: number) => {
      const w = pageWidth > 0 ? pageWidth : 1;
      const next = Math.round(offsetX / w);
      if (next < 0 || next >= displayUris.length) return;
      if (next === activeIndexRef.current) return;
      setActiveIndex(next);
    },
    [pageWidth, displayUris.length],
  );

  const syncAlbumLayout = React.useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return;
    setContainerSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
    if (!visible || !isAlbum || albumLayoutSyncedRef.current) return;
    albumLayoutSyncedRef.current = true;
    requestAnimationFrame(() => {
      try {
        pagerRef.current?.scrollToOffset({
          offset: albumOpenIndexRef.current * width,
          animated: false,
        });
      } catch {}
    });
  }, [visible, isAlbum]);

  const getImageSize = React.useCallback(async (imgUri: string): Promise<{ width: number; height: number }> => {
    return await new Promise((resolve, reject) => {
      try {
        Image.getSize(
          imgUri,
          (width, height) => resolve({ width, height }),
          (err) => reject(err),
        );
      } catch (e) {
        reject(e);
      }
    });
  }, []);

  const handleEdit = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const local = await ensureLocalFile();
      const edited = await PhotoEditor.open({
        path: local,
        stickers: [],
      });
      if (edited && typeof edited === 'string') {
        commitActiveUri(String(edited));
        resetZoomPan();
      }
    } catch (e) {
      // ignore user cancel / editor errors
    } finally {
      setBusy(false);
    }
  }, [busy, ensureLocalFile, resetZoomPan, commitActiveUri]);

  const enterCropMode = React.useCallback(async () => {
    if (busy) return;
    setCropMode(true);
    // Init crop rect (freeform) - centered, but resizable/movable.
    const w = Math.round(Math.min(containerSize.w, containerSize.h) * 0.78);
    const h = Math.round(Math.min(containerSize.w, containerSize.h) * 0.78);
    const x = Math.round((containerSize.w - w) / 2);
    const y = Math.round((containerSize.h - h) / 2);
    setCropRect(clampRect({ x, y, w, h }));
    cropLast.current = { x, y, w, h };

    // Make sure image covers the crop frame by default (so user sees a valid crop immediately).
    try {
      const local = await ensureLocalFile();
      const { width: iw, height: ih } = await getImageSize(local);
      if (!iw || !ih) return;
      const cw = containerSize.w || screenWidth;
      const ch = containerSize.h || screenHeight;
      const fit = Math.min(cw / iw, ch / ih); // contain
      const displayedW = iw * fit;
      const displayedH = ih * fit;
      const nextRect = cropLast.current || cropRectRef.current;
      const coverScale = Math.max(nextRect.w / displayedW, nextRect.h / displayedH, 1);

      lastScale.current = coverScale;
      setScaleNumber(coverScale);
      baseScale.setValue(coverScale);
      pinchScale.setValue(1);
      lastTranslate.current = { x: 0, y: 0 };
      translateX.setValue(0);
      translateY.setValue(0);
    } catch {
      // ignore
    }
  }, [busy, ensureLocalFile, getImageSize, containerSize, baseScale, pinchScale, translateX, translateY, clampRect]);

  const exitCropMode = React.useCallback(() => {
    setCropMode(false);
  }, []);

  const applyCrop = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const local = await ensureLocalFile();
      const { width: iw, height: ih } = await getImageSize(local);
      if (!iw || !ih) return;

      const cw = containerSize.w || screenWidth;
      const ch = containerSize.h || screenHeight;

      // Base "contain" placement (scale=1, translate=0)
      const fit = Math.min(cw / iw, ch / ih);
      const displayedW = iw * fit;
      const displayedH = ih * fit;
      const offsetX = (cw - displayedW) / 2;
      const offsetY = (ch - displayedH) / 2;

      // Invert current transform: p' = (p - c) * s + c + t
      const s = Math.max(0.0001, scaleNumber);
      const tcur = lastTranslate.current;
      const cx = cw / 2;
      const cy = ch / 2;
      const inv = (px: number, py: number) => {
        const x = (px - cx - tcur.x) / s + cx;
        const y = (py - cy - tcur.y) / s + cy;
        return { x, y };
      };

      const r = cropRectRef.current;
      const tl = inv(r.x, r.y);
      const br = inv(r.x + r.w, r.y + r.h);

      const x0 = clamp(Math.min(tl.x, br.x), offsetX, offsetX + displayedW);
      const x1 = clamp(Math.max(tl.x, br.x), offsetX, offsetX + displayedW);
      const y0 = clamp(Math.min(tl.y, br.y), offsetY, offsetY + displayedH);
      const y1 = clamp(Math.max(tl.y, br.y), offsetY, offsetY + displayedH);

      const px0 = Math.round(((x0 - offsetX) / displayedW) * iw);
      const px1 = Math.round(((x1 - offsetX) / displayedW) * iw);
      const py0 = Math.round(((y0 - offsetY) / displayedH) * ih);
      const py1 = Math.round(((y1 - offsetY) / displayedH) * ih);

      const originX = clamp(px0, 0, iw - 1);
      const originY = clamp(py0, 0, ih - 1);
      const width = clamp(px1 - px0, 1, iw - originX);
      const height = clamp(py1 - py0, 1, ih - originY);

      const result = await ImageManipulator.manipulateAsync(
        local,
        [{ crop: { originX, originY, width, height } }],
        { compress: 1, format: ImageManipulator.SaveFormat.JPEG }
      );

      if (result?.uri) {
        commitActiveUri(result.uri);
        setCropMode(false);
        resetZoomPan();
      }
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }, [busy, ensureLocalFile, getImageSize, containerSize, clamp, scaleNumber, resetZoomPan, commitActiveUri]);

  const handleShare = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const local = await ensureLocalFile();
      const available = await Sharing.isAvailableAsync();
      if (available) {
        await Sharing.shareAsync(local);
      } else {
        // Fallback на стандартный Share из RN (требует url)
        try {
          const { Share } = await import('react-native');
          await (Share as any).share({ url: local });
        } catch {}
      }
    } catch (e) {
      console.error('Share image error:', e);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureLocalFile]);

  const [saveToastVisible, setSaveToastVisible] = React.useState(false);
  const [saveToastOk, setSaveToastOk] = React.useState(true);
  const saveToastOpacity = React.useRef(new Animated.Value(0)).current;
  const saveToastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSaveToast = React.useCallback(
    (ok: boolean) => {
      try {
        if (saveToastTimerRef.current) {
          clearTimeout(saveToastTimerRef.current);
          saveToastTimerRef.current = null;
        }
      } catch {}
      setSaveToastOk(ok);
      setSaveToastVisible(true);
      saveToastOpacity.setValue(0);
      Animated.timing(saveToastOpacity, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }).start();
      saveToastTimerRef.current = setTimeout(() => {
        Animated.timing(saveToastOpacity, {
          toValue: 0,
          duration: 220,
          useNativeDriver: true,
        }).start(() => {
          saveToastTimerRef.current = null;
          setSaveToastVisible(false);
        });
      }, 1500);
    },
    [saveToastOpacity],
  );

  React.useEffect(() => {
    return () => {
      try {
        if (saveToastTimerRef.current) clearTimeout(saveToastTimerRef.current);
      } catch {}
    };
  }, []);

  const handleSave = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const local = await ensureLocalFile();
      await saveImageToGallery(local);
      showSaveToast(true);
    } catch {
      showSaveToast(false);
    } finally {
      setBusy(false);
    }
  }, [busy, ensureLocalFile, showSaveToast]);

  const renderAlbumItem = React.useCallback(
    ({ item }: { item: string }) => (
      <AlbumStillSlide uri={item} width={pageWidth} height={pageHeight} />
    ),
    [pageWidth, pageHeight],
  );

  const renderZoomable = (imageUri: string) => {
    const pinched = (
      <PinchGestureHandler onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
        <Animated.View
          style={{
            width: '100%',
            height: '100%',
            justifyContent: 'center',
            alignItems: 'center',
            transform: [{ scale }, { translateX }, { translateY }],
          }}
        >
          <ViewerImage uri={imageUri} />
        </Animated.View>
      </PinchGestureHandler>
    );
    if (scaleNumber <= 1 && !cropMode) return pinched;
    return (
      <PanGestureHandler onGestureEvent={onPanEvent} onHandlerStateChange={onPanStateChange}>
        <Animated.View style={{ width: '100%', height: '100%' }}>{pinched}</Animated.View>
      </PanGestureHandler>
    );
  };

  return (
    <Modal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      onModalHide={() => {
        try {
          onClosed?.();
        } catch {}
      }}
      hideModalContentWhileAnimating
      useNativeDriverForBackdrop
      style={styles.modal}
      animationIn="fadeIn"
      animationOut="fadeOut"
      animationOutTiming={220}
      backdropOpacity={1}
    >
      {/*
        IMPORTANT:
        Do NOT hide the StatusBar here. On Android this can change window metrics/insets,
        which causes ChatScreen to re-layout (input + list spacer "jump"/flicker) when closing.
      */}
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      {/* Important: GestureHandlerRootView is needed for pinch in Android modals */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaView
          style={styles.container}
          edges={Platform.OS === 'android' ? ['top', 'bottom', 'left', 'right'] : undefined}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={28} color={LIVI.white} />
            </TouchableOpacity>
            {isAlbum ? (
              <Text style={styles.fileName} numberOfLines={1}>
                {`${activeIndex + 1} / ${displayUris.length}`}
              </Text>
            ) : name ? (
              <Text style={styles.fileName} numberOfLines={1}>
                {name}
              </Text>
            ) : null}
          </View>

          {/* Media Content */}
          <View
            style={styles.mediaContainer}
            onLayout={(e) => {
              const { width, height } = e.nativeEvent.layout;
              syncAlbumLayout(width, height);
            }}
          >
            {isAlbum ? (
              albumPagerReady ? (
              <FlatList
                ref={pagerRef}
                data={displayUris}
                horizontal
                pagingEnabled
                scrollEnabled={!cropMode && !busy}
                showsHorizontalScrollIndicator={false}
                bounces={displayUris.length > 1}
                decelerationRate="fast"
                overScrollMode="never"
                style={{ width: pageWidth, height: pageHeight }}
                initialNumToRender={displayUris.length}
                maxToRenderPerBatch={displayUris.length}
                windowSize={displayUris.length}
                removeClippedSubviews={false}
                keyExtractor={(item) => item}
                getItemLayout={(_, index) => ({
                  length: pageWidth,
                  offset: pageWidth * index,
                  index,
                })}
                onMomentumScrollEnd={(e) => syncActiveIndexFromOffset(e.nativeEvent.contentOffset.x)}
                renderItem={renderAlbumItem}
              />
              ) : (
                <View style={{ width: pageWidth, height: pageHeight }} />
              )
            ) : (
              renderZoomable(currentUri)
            )}

            {cropMode ? (
              <View style={StyleSheet.absoluteFill}>
                <View style={[styles.cropDim, { left: 0, top: 0, right: 0, bottom: 0 }]} />
                {/* Punch-out using overlays */}
                <View style={[styles.cropShade, { left: 0, top: 0, width: containerSize.w, height: cropRect.y }]} />
                <View
                  style={[
                    styles.cropShade,
                    { left: 0, top: cropRect.y, width: cropRect.x, height: cropRect.h },
                  ]}
                />
                <View
                  style={[
                    styles.cropShade,
                    {
                      left: cropRect.x + cropRect.w,
                      top: cropRect.y,
                      width: containerSize.w - (cropRect.x + cropRect.w),
                      height: cropRect.h,
                    },
                  ]}
                />
                <View
                  style={[
                    styles.cropShade,
                    {
                      left: 0,
                      top: cropRect.y + cropRect.h,
                      width: containerSize.w,
                      height: containerSize.h - (cropRect.y + cropRect.h),
                    },
                  ]}
                />
                <PanGestureHandler
                  onBegan={beginCropDrag as any}
                  onGestureEvent={onCropMoveEvent}
                  onHandlerStateChange={onCropMoveState}
                >
                  <View style={[styles.cropFrame, { left: cropRect.x, top: cropRect.y, width: cropRect.w, height: cropRect.h }]}>
                    {/* Corner handles */}
                    <PanGestureHandler onBegan={beginCropDrag as any} onGestureEvent={(e) => onCornerEvent('tl', e)} onHandlerStateChange={onCornerState}>
                      <View style={[styles.handle, styles.handleTL]} />
                    </PanGestureHandler>
                    <PanGestureHandler onBegan={beginCropDrag as any} onGestureEvent={(e) => onCornerEvent('tr', e)} onHandlerStateChange={onCornerState}>
                      <View style={[styles.handle, styles.handleTR]} />
                    </PanGestureHandler>
                    <PanGestureHandler onBegan={beginCropDrag as any} onGestureEvent={(e) => onCornerEvent('bl', e)} onHandlerStateChange={onCornerState}>
                      <View style={[styles.handle, styles.handleBL]} />
                    </PanGestureHandler>
                    <PanGestureHandler onBegan={beginCropDrag as any} onGestureEvent={(e) => onCornerEvent('br', e)} onHandlerStateChange={onCornerState}>
                      <View style={[styles.handle, styles.handleBR]} />
                    </PanGestureHandler>
                  </View>
                </PanGestureHandler>
              </View>
            ) : null}

            {isAlbum && !cropMode ? (
              <View pointerEvents="none" style={styles.pageDotsWrap}>
                {displayUris.map((_, index) => (
                  <View
                    key={index}
                    style={[styles.pageDot, index === activeIndex && styles.pageDotActive]}
                  />
                ))}
              </View>
            ) : null}
          </View>

          {saveToastVisible ? (
            <Animated.View
              pointerEvents="none"
              style={[styles.saveToastWrap, { opacity: saveToastOpacity }]}
            >
              <View style={styles.saveToast}>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.saveToastText,
                    { color: saveToastOk ? 'rgba(255,255,255,0.96)' : '#FF8A93' },
                  ]}
                >
                  {saveToastOk ? t('chatAlbumSaved', lang) : t('saveFailed', lang)}
                </Text>
              </View>
            </Animated.View>
          ) : null}

          {/* Footer */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={[styles.actionButton, busy && { opacity: 0.7 }]}
              onPress={handleEdit}
              disabled={busy}
              accessibilityLabel={t('edit', lang)}
            >
              <Ionicons name="brush-outline" size={24} color={LIVI.white} />
            </TouchableOpacity>
            {cropMode ? (
              <>
                <TouchableOpacity
                  style={[styles.actionButton, busy && { opacity: 0.7 }]}
                  onPress={applyCrop}
                  disabled={busy}
                  accessibilityLabel={t('crop', lang)}
                >
                  <Ionicons name="checkmark" size={26} color={LIVI.white} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, busy && { opacity: 0.7 }]}
                  onPress={exitCropMode}
                  disabled={busy}
                  accessibilityLabel={t('cancel', lang)}
                >
                  <Ionicons name="close" size={26} color={LIVI.white} />
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={[styles.actionButton, busy && { opacity: 0.7 }]}
                onPress={() => void enterCropMode()}
                disabled={busy}
                accessibilityLabel={t('crop', lang)}
              >
                <Ionicons name="crop-outline" size={24} color={LIVI.white} />
              </TouchableOpacity>
            )}

            {onSend ? (
              <TouchableOpacity
                style={[styles.actionButton, busy && { opacity: 0.7 }]}
                onPress={() => {
                  try {
                    const finalUri = currentUri;
                    if (finalUri) onSend(finalUri);
                  } catch {}
                }}
                disabled={busy}
                accessibilityLabel={t('send', lang)}
              >
                <Ionicons name="send-outline" size={24} color={LIVI.white} />
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  style={[styles.actionButton, busy && { opacity: 0.7 }]}
                  onPress={handleSave}
                  disabled={busy}
                  accessibilityLabel={t('save', lang)}
                >
                  <Ionicons name="download-outline" size={24} color={LIVI.white} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionButton, busy && { opacity: 0.7 }]}
                  onPress={handleShare}
                  disabled={busy}
                  accessibilityLabel={t('share', lang)}
                >
                  <Ionicons name="share-outline" size={24} color={LIVI.white} />
                </TouchableOpacity>
              </>
            )}
          </View>
        </SafeAreaView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    margin: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.95)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  closeButton: {
    padding: 8,
    marginRight: 12,
  },
  fileName: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '500',
    flex: 1,
  },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 0,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  pageDotsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  pageDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  pageDotActive: {
    backgroundColor: 'rgba(255,255,255,0.95)',
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  cropDim: {
    ...StyleSheet.absoluteFillObject,
  },
  cropShade: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  cropFrame: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 8,
    backgroundColor: 'transparent',
  },
  handle: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.35)',
  },
  handleTL: { left: -14, top: -14 },
  handleTR: { right: -14, top: -14 },
  handleBL: { left: -14, bottom: -14 },
  handleBR: { right: -14, bottom: -14 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 26,
    width: 52,
    height: 52,
  },
  saveToastWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 96,
    alignItems: 'center',
    zIndex: 20,
  },
  saveToast: {
    alignSelf: 'center',
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: 'rgba(12, 14, 18, 0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    maxWidth: '72%',
  },
  saveToastText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.25,
    textAlign: 'center',
  },
});
