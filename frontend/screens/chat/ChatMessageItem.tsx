// screens/chat/ChatMessageItem.tsx
import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Pressable,
  Animated,
  StyleSheet,
  Linking,
  Dimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image as ExpoImage } from "expo-image";
import * as FileSystem from "expo-file-system";
import Svg, { Circle as SvgCircle, Defs, LinearGradient, Stop, G } from "react-native-svg";
import { useResolvedImageUri } from "../../hooks/useResolvedImageUri";
import { logger } from "../../utils/logger";
import { t, type Lang } from "../../utils/i18n";
import {
  StickerView,
  getBuiltInSticker,
} from "../../components/chatStickers";
import {
  isOfflineQueuedOrOptimisticOutgoingId,
  type ChatReadStatus,
} from "./chatMessageIds";
import { getMessageImageUris, CHAT_ALBUM_INSET } from "./chatAlbum";
import { ChatAlbumGrid } from "./ChatAlbumGrid";
import { ChatReplyQuoteAccent } from "./ChatReplyQuoteAccent";

/** Разбивает текст на сегменты «текст» и «ссылка» для отображения кликабельных URL в сообщениях. */
function parseTextWithUrls(text: string): { type: "text" | "url"; value: string }[] {
  if (!text || typeof text !== "string") return [{ type: "text", value: "" }];
  const regex = /(https?:\/\/[^\s<>"\]]+|www\.[^\s<>"\]]+)/gi;
  const parts = text.split(regex).filter(Boolean);
  return parts.map((part) => ({
    type: /^(https?:\/\/|www\.)/i.test(part) ? "url" : "text",
    value: part,
  }));
}

/** Нормализует URL для открытия (добавляет https:// для www.). */
function openMessageUrl(raw: string): void {
  const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  Linking.openURL(url).catch(() => {});
}

export type ChatMessageItemLivi = {
  white: string;
  titan: string;
  red: string;
  text: string;
  feedBg: string;
  replyQuoteAccent: string;
  replyQuotePressBg: string;
  replyHighlightAccent: string;
};

export type ChatMessageItemProps = {
  item: any;
  currentUserId: string | null;
  readStatus?: ChatReadStatus;
  uploadStatus?: "sending" | "sent" | "failed";
  onPressImage: (
    kind: "image",
    uri: string,
    name?: string,
    album?: { uris: string[]; index: number; message: any },
  ) => void;
  onPressAudio?: (item: any) => void;
  playingAudioId: string | null;
  playingAudioState: {
    id: string;
    positionMs: number;
    durationMs: number;
  } | null;
  onLongPressMessage: (
    item: any,
    layout: { x: number; y: number; width: number; height: number },
  ) => void;
  /** Long-press on one album tile — actions for one/all photos. */
  onLongPressAlbumTile?: (
    item: any,
    index: number,
    layout: { x: number; y: number; width: number; height: number },
  ) => void;
  /** Highlight album tile while actions sheet is open. */
  albumFocusIndex?: number | null;
  onMessagePress?: (item: any) => void;
  onReactionPress?: (messageId: string, emoji: string) => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelect?: (id: string) => void;
  /** Album multi-select: which photo indices are checked. */
  selectedAlbumIndices?: number[];
  onToggleAlbumTileSelect?: (index: number) => void;
  retryUiForId: string | null;
  onToggleRetryUi?: (id: string) => void;
  onRetryFailed?: (item: any) => void;
  resolveMediaUri: (uri?: string) => string;
  peerDisplayName?: string;
  highlightedMessageId: string | null;
  onPressReplyQuote?: (messageId: string) => void;
  animateMessagePress: (
    messageId: string,
    callback?: () => void,
    options?: { immediate?: boolean },
  ) => void;
  getMessageAnimation: (messageId: string) => Animated.Value;
  formatDurationDot: (ms: number) => string;
  BUBBLE_BG_OUT: string;
  BUBBLE_BG_IN: string;
  BORDER_COLOR: string;
  LIVI: ChatMessageItemLivi;
  isDark: boolean;
  lang: Lang;
};


export const ChatMessageItem = React.memo(({ item, currentUserId, readStatus, uploadStatus, onPressImage, onPressAudio, playingAudioId, playingAudioState, onLongPressMessage, onLongPressAlbumTile, albumFocusIndex = null, onMessagePress, onReactionPress, selectionMode, isSelected, onToggleSelect, selectedAlbumIndices = [], onToggleAlbumTileSelect, retryUiForId, onToggleRetryUi, onRetryFailed, resolveMediaUri, peerDisplayName, highlightedMessageId, onPressReplyQuote, animateMessagePress, getMessageAnimation, formatDurationDot, BUBBLE_BG_OUT, BUBBLE_BG_IN, BORDER_COLOR, LIVI, isDark, lang }: ChatMessageItemProps) => {
  const bubbleRef = React.useRef<View>(null);
  const [imageLoadError, setImageLoadError] = React.useState(false);
  const [localImageUri, setLocalImageUri] = React.useState<string | null>(null);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const imageUriForItem = item.type === 'image' ? (resolveMediaUri(item.uri) || '') : '';
  const [messageImageResolvedUri] = useResolvedImageUri(
    Platform.OS === 'android' && imageUriForItem && /^data:/i.test(imageUriForItem) ? imageUriForItem : ''
  );
  const fireLongPressWithLayout = React.useCallback(() => {
    const measure = () => {
      bubbleRef.current?.measureInWindow((x, y, w, h) => {
        onLongPressMessage(item, { x, y, width: w, height: h });
      });
    };
    if (Platform.OS === 'android') {
      requestAnimationFrame(measure);
    } else {
      measure();
    }
  }, [item, onLongPressMessage]);
  const openMessageActionsFromBubble = React.useCallback(() => {
    animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
  }, [item.id, animateMessagePress, fireLongPressWithLayout]);
  // Fallback логика для определения отправителя если поле sender отсутствует
  let isMyMessage = item.sender === 'me';
  if (item.sender === undefined || item.sender === null) {
    isMyMessage = item.from === currentUserId;
    // оставляем только предупреждение, без лишних деталей
    console.warn('Message without sender field: using fallback');
  }

  const effectiveReadStatus: ChatReadStatus | undefined =
    readStatus ||
    (isMyMessage
      ? (item.read
          ? 'read'
          : isOfflineQueuedOrOptimisticOutgoingId(String(item?.id || ''))
            ? 'sending'
            : 'sent')
      : undefined);
  const messageUploadStatus = isMyMessage ? (uploadStatus || 'sent') : 'sent';
  
  // Сбрасываем ошибку и локальный URI при изменении URI / альбома
  React.useEffect(() => {
    setImageLoadError(false);
    setLocalImageUri(null);
    setIsDownloading(false);
  }, [item.uri, item.uris]);

  const fireAlbumTileLongPress = React.useCallback(
    (index: number) => {
      const measure = () => {
        bubbleRef.current?.measureInWindow((x, y, w, h) => {
          const layout = { x, y, width: w, height: h };
          if (onLongPressAlbumTile) onLongPressAlbumTile(item, index, layout);
          else onLongPressMessage(item, layout);
        });
      };
      if (Platform.OS === "android") requestAnimationFrame(measure);
      else measure();
    },
    [item, onLongPressAlbumTile, onLongPressMessage],
  );
  
  // Функция для скачивания изображения через FileSystem (обходит ATS)
  const downloadImageViaFileSystem = React.useCallback(async (uri: string) => {
    if (isDownloading || localImageUri) return; // Уже скачивается или уже скачано
    
    setIsDownloading(true);
    try {
      const fileName = `image_${item.id}_${Date.now()}.jpg`;
      const targetUri = `${FileSystem.cacheDirectory}${fileName}`;
      
      logger.debug('[ChatScreen] MessageItem: downloading image via FileSystem', { 
        messageId: item.id, 
        sourceUri: uri,
        targetUri 
      });
      
      const downloadResult = await FileSystem.downloadAsync(uri, targetUri);
      
      if (downloadResult.uri) {
        logger.debug('[ChatScreen] MessageItem: image downloaded successfully', { 
          messageId: item.id, 
          localUri: downloadResult.uri 
        });
        setLocalImageUri(downloadResult.uri);
        setImageLoadError(false);
      } else {
        throw new Error('Download failed: no URI returned');
      }
    } catch (error: any) {
      logger.error('[ChatScreen] MessageItem: FileSystem download error', { 
        messageId: item.id, 
        uri, 
        error: error?.message || String(error) 
      });
      setImageLoadError(true);
    } finally {
      setIsDownloading(false);
    }
  }, [item.id, isDownloading, localImageUri]);

    const renderContent = () => {
      switch (item.type) {
        case 'image': {
          const albumUris = getMessageImageUris(item);
          if (albumUris.length > 1) {
            return (
              <View>
                <ChatAlbumGrid
                  item={item}
                  resolveMediaUri={resolveMediaUri}
                  selectionMode={selectionMode}
                  focusedIndex={albumFocusIndex}
                  selectedIndices={selectedAlbumIndices}
                  onToggleTileSelect={onToggleAlbumTileSelect}
                  onPressTile={(uri, index) => {
                    onPressImage('image', uri, item.name, {
                      uris: albumUris.map((u) => resolveMediaUri(u) || u),
                      index,
                      message: item,
                    });
                  }}
                  onLongPressTile={(_uri, index) => {
                    fireAlbumTileLongPress(index);
                  }}
                />
                {messageUploadStatus === 'sending' && (
                  <View style={{
                    marginTop: 6,
                    marginHorizontal: 8,
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    borderRadius: 4,
                    padding: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <ActivityIndicator size="small" color="#4CAF50" style={{ marginRight: 6 }} />
                    <Text style={{ color: 'white', fontSize: 10, fontWeight: '600' }}>
                      Отправляется...
                    </Text>
                  </View>
                )}
                {messageUploadStatus === 'failed' && (
                  <View style={{
                    marginTop: 6,
                    marginHorizontal: 8,
                    backgroundColor: 'rgba(255,0,0,0.8)',
                    borderRadius: 4,
                    padding: 8,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <Ionicons name="alert-circle" size={12} color="white" style={{ marginRight: 4 }} />
                    <Text style={{ color: 'white', fontSize: 10, fontWeight: '600' }}>
                      Ошибка отправки
                    </Text>
                  </View>
                )}
              </View>
            );
          }
          const imageUri = resolveMediaUri(item.uri);
          if (!imageUri) {
          logger.warn('[ChatScreen] MessageItem: image URI is empty', { messageId: item.id, originalUri: item.uri });
          return (
            <View style={{
              width: '100%',
              aspectRatio: 4 / 3,
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 8,
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <Ionicons name="image-outline" size={32} color="rgba(255,255,255,0.5)" />
              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 4 }}>
                {t('chatImageUnavailable', lang)}
              </Text>
            </View>
          );
        }
        const displayImageUri = (Platform.OS === 'android' && /^data:/i.test(imageUri)) ? messageImageResolvedUri : imageUri;
        
        logger.debug('[ChatScreen] MessageItem: rendering image', { 
          messageId: item.id, 
          originalUri: item.uri, 
          resolvedUri: imageUri 
        });
        
        // Если была ошибка загрузки, показываем fallback UI
        if (imageLoadError) {
          return (
            <TouchableOpacity 
              style={{ 
                position: 'relative',
                backgroundColor: 'rgba(255,255,255,0.1)',
                borderRadius: 8,
                overflow: 'hidden',
                width: '100%',
                aspectRatio: 4 / 3,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onPress={() => {
                animateMessagePress(item.id, () => {
                  onPressImage('image', imageUri, item.name);
                });
              }}
              delayLongPress={280}
              onLongPress={() => {
                animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
              }}
              activeOpacity={0.9}
            >
              <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.5)" />
              <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 8, textAlign: 'center', paddingHorizontal: 8 }}>
                Нажмите для просмотра
              </Text>
            </TouchableOpacity>
          );
        }
        
        return (
          <TouchableOpacity 
            style={{ 
              position: 'relative',
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: 8,
              overflow: 'hidden',
              width: '100%',
              aspectRatio: 4 / 3,
            }}
            onPress={() => {
              animateMessagePress(item.id, () => {
                onPressImage('image', imageUri, item.name);
              });
            }}
            delayLongPress={280}
            onLongPress={() => {
              animateMessagePress(item.id, fireLongPressWithLayout, { immediate: true });
            }}
            activeOpacity={0.9}
          >
            {isDownloading && (
              <View style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(0,0,0,0.3)',
              }}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            )}
            <ExpoImage
              source={{ uri: localImageUri || displayImageUri }}
              style={{
                width: '100%',
                height: '100%',
                backgroundColor: 'rgba(255,255,255,0.1)',
              }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={0}
              priority="high"
              recyclingKey={`message_image_${item.id}`}
              allowDownscaling={false}
              placeholder={null}
              onError={(error: any) => {
                // КРИТИЧНО: Детальное логирование ошибки для диагностики
                const errorDetails: any = {
                  messageId: item.id,
                  uri: imageUri,
                  originalUri: item.uri,
                  errorType: typeof error,
                  errorString: String(error),
                };
                
                // Пытаемся извлечь больше информации об ошибке
                try {
                  if (error?.nativeEvent) {
                    errorDetails.nativeEvent = error.nativeEvent;
                  }
                  if (error?.message) {
                    errorDetails.errorMessage = error.message;
                  }
                  if (error?.code) {
                    errorDetails.errorCode = error.code;
                  }
                  // Пытаемся сериализовать весь объект ошибки
                  const errorKeys = Object.keys(error || {});
                  if (errorKeys.length > 0) {
                    errorDetails.errorKeys = errorKeys;
                    errorDetails.errorValues = errorKeys.reduce((acc: any, key: string) => {
                      try {
                        acc[key] = String(error[key]);
                      } catch {
                        acc[key] = '[unserializable]';
                      }
                      return acc;
                    }, {});
                  }
                } catch (e) {
                  errorDetails.serializationError = String(e);
                }
                
                logger.error('[ChatScreen] MessageItem: image load error', errorDetails);
                console.error('[ChatScreen] Image load error details:', errorDetails);
                
                // КРИТИЧНО: Если ошибка связана с ATS, пытаемся скачать через FileSystem
                const isATSError = errorDetails.errorValues?.error?.includes('App Transport Security') || 
                                   errorDetails.nativeEvent?.error?.includes('App Transport Security');
                
                if (isATSError && !localImageUri && !isDownloading) {
                  logger.info('[ChatScreen] MessageItem: ATS error detected, trying FileSystem download', { 
                    messageId: item.id, 
                    uri: imageUri 
                  });
                  downloadImageViaFileSystem(imageUri);
                } else {
                  setImageLoadError(true);
                }
              }}
              onLoadStart={() => {
                setImageLoadError(false); // Сбрасываем ошибку при новой попытке загрузки
                logger.debug('[ChatScreen] MessageItem: image load started', { 
                  messageId: item.id, 
                  uri: imageUri 
                });
              }}
              onLoad={() => {
                setImageLoadError(false); // Успешная загрузка
                logger.debug('[ChatScreen] MessageItem: image loaded successfully', { 
                  messageId: item.id, 
                  uri: imageUri 
                });
              }}
              onLoadEnd={() => {
                logger.debug('[ChatScreen] MessageItem: image load ended', { 
                  messageId: item.id, 
                  uri: imageUri 
                });
              }}
            />
           
            
            
            {messageUploadStatus === 'sending' && (
              <View style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                right: 8,
                backgroundColor: 'rgba(0,0,0,0.8)',
                borderRadius: 4,
                padding: 8,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <ActivityIndicator size="small" color="#4CAF50" style={{ marginRight: 6 }} />
                <Text style={{
                  color: 'white',
                  fontSize: 10,
                  fontWeight: '600',
                }}>
                  Отправляется...
                </Text>
              </View>
            )}
            
            {messageUploadStatus === 'failed' && (
              <View style={{
                position: 'absolute',
                bottom: 8,
                left: 8,
                right: 8,
                backgroundColor: 'rgba(255,0,0,0.8)',
                borderRadius: 4,
                padding: 8,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <Ionicons name="alert-circle" size={12} color="white" style={{ marginRight: 4 }} />
                <Text style={{
                  color: 'white',
                  fontSize: 10,
                  fontWeight: '600',
                }}>
                  Ошибка отправки
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
        }
      case 'audio': {
        const isPlaying = String(playingAudioId || '') === String(item.id || '');
        const durSec = Number(item?.duration || 0);
        const fullMs = durSec > 0 ? durSec * 1000 : 0;
        const remainingMs =
          isPlaying && playingAudioState?.id === String(item.id || '')
            ? Math.max(0, Number(playingAudioState.durationMs || 0) - Number(playingAudioState.positionMs || 0))
            : fullMs;
        const durLabel = (isPlaying ? remainingMs : fullMs) > 0 ? formatDurationDot(isPlaying ? remainingMs : fullMs) : '';

        const voiceRingSize = 42;
        const voiceRingCx = voiceRingSize / 2;
        const voiceRingR = 19;
        /** Внутренний диск (тот же центр, что и у окружностей кольца) */
        const voiceDiscR = 17;
        const voiceRingCirc = 2 * Math.PI * voiceRingR;
        const voiceDiscFill = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)';
        const voiceDurMs =
          isPlaying && playingAudioState?.id === String(item.id || '')
            ? Math.max(0, Number(playingAudioState.durationMs || 0))
            : 0;
        const voicePosMs =
          isPlaying && playingAudioState?.id === String(item.id || '')
            ? Math.max(0, Number(playingAudioState.positionMs || 0))
            : 0;
        const voiceProgressRaw =
          isPlaying && voiceDurMs > 0 ? Math.min(1, voicePosMs / Math.max(voiceDurMs, 1)) : 0;
        // expo-av часто не доводит position до duration до didJustFinish; хвост считаем «концом» без ломания коротких клипов
        const tailMs = Math.min(220, Math.max(16, Math.floor(voiceDurMs * 0.08)));
        const nearEnd = voiceDurMs > 0 && voicePosMs >= voiceDurMs - tailMs;
        const voiceProgress = Math.min(1, nearEnd ? 1 : voiceProgressRaw);
        const voiceGradId = `voicePearl-${String(item.id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

        return (
          <View
            style={{
              minWidth: 200,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <View
              style={{
                width: voiceRingSize,
                height: voiceRingSize,
                position: 'relative',
              }}
            >
              {/*
                Кольцо + заливка только в SVG с одним центром (cx/cy) — иначе View/Svg/иконка
                на разных движках визуально «плывут». Сверху — только прозрачный hit-target и иконка.
              */}
              <Svg
                width={voiceRingSize}
                height={voiceRingSize}
                viewBox={`0 0 ${voiceRingSize} ${voiceRingSize}`}
                style={StyleSheet.absoluteFillObject}
                pointerEvents="none"
              >
                <Defs>
                  <LinearGradient id={voiceGradId} x1="0%" y1="0%" x2="100%" y2="100%">
                    <Stop offset="0%" stopColor={isDark ? '#C8FFF4' : '#EDE4FF'} stopOpacity={1} />
                    <Stop offset={isDark ? '45%' : '40%'} stopColor={isDark ? '#5ED4C8' : '#A894D8'} stopOpacity={1} />
                    <Stop offset="100%" stopColor={isDark ? '#A8E8E0' : '#D4C4F0'} stopOpacity={1} />
                  </LinearGradient>
                </Defs>
                <SvgCircle
                  cx={voiceRingCx}
                  cy={voiceRingCx}
                  r={voiceDiscR}
                  fill={voiceDiscFill}
                />
                <SvgCircle
                  cx={voiceRingCx}
                  cy={voiceRingCx}
                  r={voiceRingR}
                  fill="none"
                  stroke={isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'}
                  strokeWidth={2.5}
                />
                {isPlaying ? (
                  <G rotation="-90" origin={`${voiceRingCx}, ${voiceRingCx}`}>
                    <SvgCircle
                      cx={voiceRingCx}
                      cy={voiceRingCx}
                      r={voiceRingR}
                      fill="none"
                      stroke={`url(#${voiceGradId})`}
                      strokeWidth={2.5}
                      strokeLinecap="butt"
                      strokeDasharray={`${voiceRingCirc} ${voiceRingCirc}`}
                      strokeDashoffset={voiceRingCirc * (1 - voiceProgress)}
                    />
                  </G>
                ) : null}
              </Svg>
              <Pressable
                onPress={() => {
                  try { onPressAudio?.(item); } catch {}
                }}
                onLongPress={openMessageActionsFromBubble}
                delayLongPress={280}
                style={[
                  StyleSheet.absoluteFillObject,
                  {
                    alignItems: 'center',
                    justifyContent: 'center',
                  },
                ]}
              >
                <Ionicons name={isPlaying ? 'pause' : 'play'} size={18} color={LIVI.white} />
              </Pressable>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: LIVI.white, fontSize: 14, fontWeight: '600' }}>{t('chatVoiceMessage', lang)}</Text>
              <Text style={{ marginTop: 2, color: LIVI.titan, fontSize: 12, fontWeight: '500' }}>
                {durLabel || '—'}
              </Text>
            </View>

            {messageUploadStatus === 'sending' && (
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <ActivityIndicator size="small" color={LIVI.titan} />
              </View>
            )}
          </View>
        );
      }
      default:
        return null; // Текст будет отображаться в основном блоке
    }
  };

  const renderStatusIcons = () => {
    if (!isMyMessage) return null;
    
    // Все возможные статусы: sending, delivered, read, failed, error
    switch (effectiveReadStatus) {
      case 'sending':
        // Отправляется - часы
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
            <Ionicons 
              name="time-outline" 
              size={14} 
              color={LIVI.titan}
            />
          </View>
        );
        
      case 'failed': {
        const showRetry = String(retryUiForId || '') === String(item?.id || '');
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 6, gap: 8 }}>
            {showRetry && (
              <Pressable
                onPress={() => {
                  try { onRetryFailed?.(item); } catch {}
                }}
                onLongPress={openMessageActionsFromBubble}
                delayLongPress={280}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 10,
                  height: 28,
                  borderRadius: 14,
                  backgroundColor: isDark ? 'rgba(255,90,103,0.16)' : 'rgba(255,90,103,0.12)',
                  borderWidth: 1,
                  borderColor: 'rgba(255,90,103,0.45)',
                }}
              >
                <Ionicons name="refresh-circle" size={18} color="#FF5A67" style={{ marginRight: 6 }} />
                <Text style={{ color: '#FF5A67', fontSize: 12, fontWeight: '700' }}>{t('retry', lang)}</Text>
              </Pressable>
            )}

            <Pressable
              onPress={() => {
                try { onToggleRetryUi?.(String(item?.id || '')); } catch {}
              }}
              onLongPress={openMessageActionsFromBubble}
              delayLongPress={280}
              hitSlop={8}
              style={{ flexDirection: 'row', alignItems: 'center' }}
            >
              <View style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                backgroundColor: LIVI.red,
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <Text style={{ 
                  color: 'white', 
                  fontSize: 9, 
                  fontWeight: 'bold',
                  lineHeight: 9 
                }}>!</Text>
              </View>
            </Pressable>
          </View>
        );
      }
      case 'sent':
        // Отправлено на сервер (еще не доставлено) — одна серая птичка
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
            <Ionicons 
              name="checkmark" 
              size={14} 
              color={LIVI.titan}
            />
          </View>
        );
        
      case 'delivered':
        // Доставлено получателю, но не прочитано — одна серая птичка
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
            <Ionicons 
              name="checkmark" 
              size={14} 
              color={LIVI.titan}
            />
          </View>
        );
        
      case 'read':
        // Прочитано - две бирюзовые птички
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2 }}>
            <View style={{ position: 'relative' }}>
              <Ionicons name="checkmark" size={14} color="hsl(108, 53.10%, 35.10%)" />
              <Ionicons name="checkmark" size={14} color="hsl(108, 53.10%, 35.10%)" style={{ position: 'absolute', left: 5, top: 0 }} />
            </View>
          </View>
        );
        
      default:
        return null;
    }
  };

  const messageAnimation = getMessageAnimation(item.id);
  const canToggle = !!selectionMode;
  const isAlbumImageMsg =
    String(item?.type || '') === 'image' && getMessageImageUris(item).length > 1;
  const showSideCheckbox = !!selectionMode;
  const handleBubblePress = React.useCallback(() => {
    if (canToggle) {
      onToggleSelect?.(String(item.id));
      return;
    }
    if (String(item?.type || '') === 'audio') {
      onMessagePress?.(item);
      return;
    }
    onMessagePress?.(item);
  }, [canToggle, item, onToggleSelect, onMessagePress]);
  const isQuotedTargetHighlighted =
    highlightedMessageId != null && String(highlightedMessageId) === String(item.id);

  const replyQuoteAccent = LIVI.replyQuoteAccent;
  const replyQuotePressBg = LIVI.replyQuotePressBg;
  const highlightAccentColor = LIVI.replyHighlightAccent;
  /** Android: borderWidth+radius даёт тонкие углы — делаем ровное «кольцо» через padding */
  const androidHighlightRing = isQuotedTargetHighlighted && Platform.OS === 'android';
  const ANDROID_RING_PX = 1;
  const BUBBLE_RADIUS = 16;
  // Короткий текст ответа («Ппи») иначе сжимает цитату — держим ширину пузыря.
  const replyBubbleMinWidth = Math.round(Math.min(Dimensions.get('window').width * 0.58, 260));

  const replyAuthorLabel = item.replyTo
    ? (item.replyTo.isOwn ? t('you', lang) : (peerDisplayName || '—'))
    : '';
  const replyBodyText = item.replyTo ? (item.replyTo.text || '—') : '';

  if (String(item?.type || '') === 'sticker') {
    const sticker = getBuiltInSticker(item.stickerId);
    const reactions = Array.isArray(item.reactions) ? item.reactions : [];
    const byEmoji: Record<string, number> = {};
    reactions.forEach((r: { emoji: string }) => {
      byEmoji[r.emoji] = (byEmoji[r.emoji] || 0) + 1;
    });
    const reactionList = Object.entries(byEmoji).map(([emoji, count]) => ({ emoji, count }));
    const timeColor = isDark ? 'rgba(255,255,255,0.86)' : 'rgba(28, 36, 48, 0.92)';
    const metaBg = isDark ? 'rgba(18, 22, 30, 0.88)' : 'rgba(255,255,255,0.88)';
    const stickerSize = 132;

    const checkbox = (
      <Pressable
        onPress={() => onToggleSelect?.(String(item.id))}
        style={({ pressed }) => ({
          width: 26,
          height: 26,
          borderRadius: 13,
          borderWidth: 1.5,
          borderColor: isSelected ? '#55d187' : (isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)'),
          backgroundColor: pressed
            ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
            : (isSelected ? 'rgba(85,209,135,0.18)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')),
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: isMyMessage ? 0 : 10,
          marginLeft: isMyMessage ? 10 : 0,
          overflow: 'hidden',
        })}
      >
        {isSelected ? <Ionicons name="checkmark" size={18} color="#55d187" /> : null}
      </Pressable>
    );

    return (
      <Animated.View
        style={{
          transform: [{ scale: messageAnimation }],
          marginHorizontal: 16,
          marginVertical: 4,
          alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          maxWidth: '92%',
        }}
      >
        {selectionMode && !isMyMessage ? checkbox : null}
        <View
          style={{
            alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
            maxWidth: item.replyTo ? replyBubbleMinWidth : 190,
            ...(item.replyTo ? { minWidth: replyBubbleMinWidth } : null),
          }}
        >
          {item.replyTo && (
            <Pressable
              disabled={!!selectionMode}
              onPress={() => onPressReplyQuote?.(String(item.replyTo.id))}
              onLongPress={openMessageActionsFromBubble}
              delayLongPress={280}
              style={({ pressed }) => ({
                alignSelf: 'stretch',
                marginBottom: 4,
                paddingVertical: 4,
                paddingRight: 8,
                borderRadius: 10,
                opacity: selectionMode ? 0.5 : pressed ? 0.85 : 1,
                backgroundColor: pressed && !selectionMode ? replyQuotePressBg : metaBg,
              })}
            >
              <ChatReplyQuoteAccent color={replyQuoteAccent}>
                <Text
                  style={{ color: replyQuoteAccent, fontSize: 12, fontWeight: '600', marginBottom: 2 }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {replyAuthorLabel}
                </Text>
                <Text
                  style={{ color: timeColor, fontSize: 13, opacity: 0.9 }}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {replyBodyText}
                </Text>
              </ChatReplyQuoteAccent>
            </Pressable>
          )}
          <Pressable
            ref={bubbleRef}
            onPress={handleBubblePress}
            onLongPress={openMessageActionsFromBubble}
            delayLongPress={280}
            style={({ pressed }) => ({
              width: stickerSize,
              minHeight: stickerSize,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed && !selectionMode ? 0.92 : 1,
            })}
          >
            <StickerView stickerId={item.stickerId} sticker={sticker} size={stickerSize} animated isDark={isDark} />
            <View
              style={{
                position: 'absolute',
                right: 2,
                bottom: 0,
                borderRadius: 12,
                paddingHorizontal: 7,
                paddingVertical: 3,
                backgroundColor: metaBg,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: timeColor, fontSize: 11, marginRight: isMyMessage ? 4 : 0, fontWeight: '600' }}>
                {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
              {renderStatusIcons()}
            </View>
          </Pressable>
          {reactionList.length > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: isMyMessage ? 'flex-end' : 'flex-start', marginTop: 2 }}>
              {reactionList.map(({ emoji, count }) => (
                <Pressable
                  key={emoji}
                  onPress={() => onReactionPress?.(item.id, emoji)}
                  onLongPress={openMessageActionsFromBubble}
                  delayLongPress={280}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 12,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    backgroundColor: metaBg,
                    opacity: pressed ? 0.85 : 1,
                    marginLeft: 4,
                  })}
                >
                  <Text style={{ fontSize: 14 }}>{emoji}</Text>
                  {count > 1 ? <Text style={{ fontSize: 11, color: timeColor, marginLeft: 2 }}>{count}</Text> : null}
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
        {selectionMode && isMyMessage ? checkbox : null}
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={{
        transform: [{ scale: messageAnimation }],
        marginHorizontal: 16,
        marginVertical: 4,
        alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
        // row, чтобы чекбокс был рядом с облаком и по центру по высоте
        flexDirection: 'row',
        alignItems: 'center',
        // чуть шире, т.к. добавляется чекбокс
        maxWidth: '92%',
      }}
    >
      {/* Чекбокс выбора (режим "Выбрать") — рядом с облаком и по центру */}
      {showSideCheckbox && !isMyMessage && (
        <Pressable
          onPress={() => onToggleSelect?.(String(item.id))}
          style={({ pressed }) => ({
            width: 26,
            height: 26,
            borderRadius: 13,
            borderWidth: 1.5,
            borderColor: isSelected ? '#55d187' : (isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)'),
            backgroundColor: pressed
              ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
              : (isSelected ? 'rgba(85,209,135,0.18)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')),
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 10,
            overflow: 'hidden',
          })}
        >
          {isSelected ? <Ionicons name="checkmark" size={18} color="#55d187" /> : null}
        </Pressable>
      )}

      <View
        style={{
          alignSelf: isMyMessage ? 'flex-end' : 'flex-start',
          maxWidth: '80%',
          ...(item.replyTo ? { minWidth: replyBubbleMinWidth } : null),
        }}
      >
          {(() => {
            const bubbleFill = isMyMessage ? BUBBLE_BG_OUT : BUBBLE_BG_IN;
            const bubbleUnderlay = isMyMessage
              ? (isDark ? '#0E1420' : '#C4CAD4')
              : (isDark ? '#181E28' : '#8EA6BC');
            const isImageMsg = String(item?.type || '') === 'image';
            const isAlbumImage = isAlbumImageMsg;
            // Одинаковые отступы от краёв облака для 1 и для N фото
            const bubblePadStyle = isImageMsg
              ? {
                  paddingTop: CHAT_ALBUM_INSET,
                  paddingHorizontal: CHAT_ALBUM_INSET,
                  paddingBottom: 8,
                }
              : { padding: 12 };
            const bubbleBody = (
              <View style={{ maxWidth: '100%' }}>
          {/* Основной контент */}
          {renderContent()}
          
          {/* Текст сообщения (если есть), ссылки кликабельны */}
          {item.type === 'text' && (() => {
          const baseStyle = {
            color: LIVI.white,
            fontSize: 16,
            marginBottom: 3,
            lineHeight: 22,
            fontWeight: '400' as const,
          };
          const linkStyle = {
            ...baseStyle,
            color: '#7eb8ff',
            textDecorationLine: 'underline' as const,
          };
          const segments = parseTextWithUrls(String(item.text ?? ''));
          return (
            <Text style={baseStyle}>
              {segments.map((seg, idx) =>
                seg.type === 'url' ? (
                  <Text
                    key={idx}
                    onPress={() => openMessageUrl(seg.value)}
                    onLongPress={openMessageActionsFromBubble}
                    style={linkStyle}
                  >
                    {seg.value}
                  </Text>
                ) : (
                  <Text key={idx}>{seg.value}</Text>
                )
              )}
            </Text>
          );
        })()}
        
        {/* Нижняя строка: реакции слева, время + статус справа (всё внутри облака) */}
        {(() => {
          const reactions = Array.isArray(item.reactions) ? item.reactions : [];
          const hasReactions = reactions.length > 0;
          const byEmoji: Record<string, number> = {};
          if (hasReactions) {
            reactions.forEach((r: { emoji: string }) => {
              byEmoji[r.emoji] = (byEmoji[r.emoji] || 0) + 1;
            });
          }
          const list = hasReactions ? Object.entries(byEmoji).map(([emoji, count]) => ({ emoji, count })) : [];
          return (
            <View style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: hasReactions ? 'flex-end' : 'flex-end',
              marginTop: item.type !== 'text' ? 4 : 1,
              paddingHorizontal: isImageMsg ? 4 : 0,
            }}>
              {hasReactions ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0, marginRight: 10 }}>
                  {list.map(({ emoji, count }, idx) => (
                    <Pressable
                      key={emoji}
                      onPress={() => onReactionPress?.(item.id, emoji)}
                      onLongPress={openMessageActionsFromBubble}
                      delayLongPress={280}
                      style={({ pressed }) => [
                        {
                          flexDirection: 'row',
                          alignItems: 'center',
                          backgroundColor: 'transparent',
                          borderRadius: 12,
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          opacity: pressed ? 0.85 : 1,
                          transform: [{ scale: pressed ? 0.92 : 1 }],
                        },
                        idx > 0 ? { marginLeft: 4 } : {},
                      ]}
                    >
                      <Text style={{ fontSize: 14 }}>{emoji}</Text>
                      {count > 1 && (
                        <Text style={{ fontSize: 11, color: LIVI.text, marginLeft: 2, opacity: 0.9 }}>{count}</Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
                <Text style={{
                  color: isDark ? LIVI.text : 'rgba(28, 36, 48, 0.92)',
                  fontSize: 12,
                  marginRight: isMyMessage ? 4 : 0,
                  opacity: isDark ? 0.8 : 1,
                  fontWeight: '600',
                }}>
                  {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                {renderStatusIcons()}
              </View>
            </View>
          );
        })()}
            </View>
          );

          const bubbleWithReply = (
            <>
              {item.replyTo && (
                <Pressable
                  disabled={!!selectionMode}
                  onPress={() => onPressReplyQuote?.(String(item.replyTo.id))}
                  onLongPress={openMessageActionsFromBubble}
                  delayLongPress={280}
                  style={({ pressed }) => ({
                    alignSelf: 'stretch',
                    marginBottom: 8,
                    paddingVertical: 4,
                    marginHorizontal: -4,
                    marginTop: -2,
                    borderRadius: 8,
                    opacity: selectionMode ? 0.5 : pressed ? 0.85 : 1,
                    backgroundColor: pressed && !selectionMode ? replyQuotePressBg : 'transparent',
                  })}
                >
                  <ChatReplyQuoteAccent color={replyQuoteAccent}>
                    <Text
                      style={{ color: replyQuoteAccent, fontSize: 12, fontWeight: '600', marginBottom: 2 }}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {replyAuthorLabel}
                    </Text>
                    <Text
                      style={{ color: LIVI.white, fontSize: 13, opacity: 0.85 }}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {replyBodyText}
                    </Text>
                  </ChatReplyQuoteAccent>
                </Pressable>
              )}
              {bubbleBody}
            </>
          );

          if (androidHighlightRing) {
            return (
              <View
                style={{
                  borderRadius: BUBBLE_RADIUS + ANDROID_RING_PX,
                  padding: ANDROID_RING_PX,
                  backgroundColor: highlightAccentColor,
                  maxWidth: '100%',
                  elevation: 0,
                }}
              >
                {/*
                  Облака полупрозрачные — без подложки сквозь них просвечивает цвет кольца.
                  Непрозрачный фон списка сообщений, поверх — как обычно bubbleFill.
                */}
                <View
                  style={{
                    borderRadius: BUBBLE_RADIUS,
                    backgroundColor: bubbleUnderlay,
                    overflow: 'hidden',
                    maxWidth: '100%',
                  }}
                >
                  <Pressable
                    ref={bubbleRef}
                    onPress={handleBubblePress}
                    onLongPress={openMessageActionsFromBubble}
                    delayLongPress={280}
                    style={({ pressed }) => [
                      {
                        ...bubblePadStyle,
                        backgroundColor: bubbleFill,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        ...(item.replyTo ? { minWidth: replyBubbleMinWidth } : null),
                      },
                      // Для альбома эффект нажатия только у плитки, не у всего облака
                      pressed && !selectionMode && !isAlbumImage ? { opacity: 0.94 } : null,
                    ]}
                  >
                    {bubbleWithReply}
                  </Pressable>
                </View>
              </View>
            );
          }
          return (
            <Pressable
              ref={bubbleRef}
              onPress={handleBubblePress}
              onLongPress={openMessageActionsFromBubble}
              delayLongPress={280}
              style={({ pressed }) => [
                {
                  ...bubblePadStyle,
                  backgroundColor: bubbleFill,
                  borderRadius: BUBBLE_RADIUS,
                  borderWidth: 1,
                  borderColor: isQuotedTargetHighlighted ? highlightAccentColor : BORDER_COLOR,
                  maxWidth: '100%',
                  ...(item.replyTo ? { minWidth: replyBubbleMinWidth } : null),
                },
                pressed && !selectionMode && !isAlbumImage ? { opacity: 0.94 } : null,
              ]}
            >
              {bubbleWithReply}
            </Pressable>
          );
        })()}
      </View>

      {showSideCheckbox && isMyMessage && (
        <Pressable
          onPress={() => onToggleSelect?.(String(item.id))}
          style={({ pressed }) => ({
            width: 26,
            height: 26,
            borderRadius: 13,
            borderWidth: 1.5,
            borderColor: isSelected ? '#55d187' : (isDark ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)'),
            backgroundColor: pressed
              ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
              : (isSelected ? 'rgba(85,209,135,0.18)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')),
            alignItems: 'center',
            justifyContent: 'center',
            marginLeft: 10,
            overflow: 'hidden',
          })}
        >
          {isSelected ? <Ionicons name="checkmark" size={18} color="#55d187" /> : null}
        </Pressable>
      )}
    </Animated.View>
  );
});
