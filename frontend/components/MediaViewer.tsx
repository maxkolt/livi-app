// components/MediaViewer.tsx
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  StatusBar,
  SafeAreaView,
  Animated,
} from 'react-native';
import { PinchGestureHandler, State } from 'react-native-gesture-handler';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Image as ExpoImage } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import Modal from 'react-native-modal';
import { LIVI } from '../utils/i18n';
import { API_BASE } from '../sockets/socket';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

interface MediaViewerProps {
  visible: boolean;
  onClose: () => void;
  mediaType: 'image';
  uri: string;
  name?: string;
}

export default function MediaViewer({ 
  visible, 
  onClose, 
  mediaType, 
  uri, 
  name 
}: MediaViewerProps) {
  const [busy, setBusy] = React.useState(false);

  const resolvedUri = React.useMemo(() => {
    if (!uri) return '';
    if (/^https?:\/\//i.test(uri)) return uri;
    if (uri.startsWith('/uploads/')) return `${API_BASE}${uri}`;
    return uri;
  }, [uri]);

  // Pinch-to-zoom
  const pinchScale = React.useRef(new Animated.Value(1)).current;
  const baseScale = React.useRef(new Animated.Value(1)).current;
  const lastScale = React.useRef(1);
  const scale = Animated.multiply(baseScale, pinchScale);

  const onPinchEvent = Animated.event([{ nativeEvent: { scale: pinchScale } }], {
    useNativeDriver: true,
  });

  const onPinchStateChange = (e: any) => {
    if (e.nativeEvent.oldState === State.ACTIVE) {
      let next = lastScale.current * e.nativeEvent.scale;
      // Clamp scale between 1x and 4x
      next = Math.max(1, Math.min(next, 4));
      lastScale.current = next;
      baseScale.setValue(next);
      pinchScale.setValue(1);
    }
  };

  const ensureLocalFile = React.useCallback(async (): Promise<string> => {
    // Если уже локальный файл
    if (/^(file|content):\/\//i.test(resolvedUri)) return resolvedUri;
    const baseName = (name || resolvedUri.split('?')[0].split('#')[0].split('/').pop() || `image_${Date.now()}`).toString();
    const hasExt = /\.[a-zA-Z0-9]{2,5}$/.test(baseName);
    const fileName = hasExt ? baseName : `${baseName}.jpg`;
    const target = FileSystem.cacheDirectory + fileName;
    try {
      const { uri: localUri } = await FileSystem.downloadAsync(resolvedUri, target);
      return localUri;
    } catch (e) {
      throw e;
    }
  }, [resolvedUri, name]);

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
  return (
    <Modal
      isVisible={visible}
      onBackdropPress={onClose}
      onBackButtonPress={onClose}
      style={styles.modal}
      animationIn="fadeIn"
      animationOut="fadeOut"
      backdropOpacity={1}
    >
      <StatusBar hidden />
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={28} color={LIVI.white} />
          </TouchableOpacity>
          {name && (
            <Text style={styles.fileName} numberOfLines={1}>
              {name}
            </Text>
          )}
        </View>

        {/* Media Content */}
        <View style={styles.mediaContainer}>
          <PinchGestureHandler
            onGestureEvent={onPinchEvent}
            onHandlerStateChange={onPinchStateChange}
          >
            <Animated.View
              style={{
                width: '100%',
                height: '100%',
                transform: [{ scale }],
              }}
            >
              <ExpoImage
                source={{ uri: resolvedUri }}
                style={styles.image}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={200}
              />
            </Animated.View>
          </PinchGestureHandler>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <TouchableOpacity 
            style={[styles.actionButton, busy && { opacity: 0.7 }]}
            onPress={handleShare}
            disabled={busy}
          >
            <Ionicons name="share-outline" size={22} color={LIVI.white} />
            <Text style={styles.actionText}>Поделиться</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
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
    width: screenWidth,
    height: screenHeight,
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
    width: screenWidth,
    height: screenHeight - 120,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 25,
  },
  actionText: {
    color: LIVI.white,
    fontSize: 16,
    fontWeight: '500',
    marginLeft: 8,
  },
});
