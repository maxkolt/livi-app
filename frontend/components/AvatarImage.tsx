// components/AvatarImage.tsx
import React, { memo, useEffect, useRef, useState } from 'react';
import { View, Text, StyleProp, ViewStyle, TextStyle, ImageStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { getAvatarUri } from '../utils/avatarCache';
import { useUserActiveFrame } from '../utils/cosmetics';

const FIRE_RING = require('../assets/frames/fire-ring-alpha.png');
const FRAME_COLORS: Record<string, string> = {
  diamond: '#9ED0FF',
  aurora: '#5AA9FF',
  palladium: '#C5CCD6',
  frost: '#7EC8E8',
  jade: '#3DCF8E',
  void: '#7B5CFF',
  obsidian: '#6B7280',
};

export interface AvatarImageProps {
  userId?: string;
  avatarVer?: number;
  uri?: string; // для обратной совместимости или локальных файлов
  size?: number;
  style?: StyleProp<ImageStyle>;
  fallbackText?: string;
  fallbackTextStyle?: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * Умный компонент аватара с кешированием через сокеты
 * Использует систему версионирования для автоматической инвалидации кеша
 */
const AvatarImage = memo<AvatarImageProps>(({
  userId,
  avatarVer,
  uri: propsUri, // для локальных файлов или обратной совместимости
  size = 48,
  style,
  fallbackText,
  fallbackTextStyle,
  containerStyle,
}) => {
  const [uri, setUri] = useState<string>(propsUri || '');
  const [loading, setLoading] = useState(false);
  const activeFrameId = useUserActiveFrame(userId);

  // Загрузка аватара через систему кеширования
  useEffect(() => {
    let alive = true;

    // Если передан прямой URI (data URI или локальный файл), используем его
    if (propsUri) {
      setUri(propsUri);
      setLoading(false);
      return;
    }

    // Иначе загружаем через систему кеширования
    if (userId && avatarVer && avatarVer > 0) {
      setLoading(true);
      (async () => {
        try {
          // Пытаемся загрузить миниатюру (для списков друзей)
          const cachedUri = await getAvatarUri(userId, avatarVer || 0, true);
          if (alive) {
            setUri(cachedUri || '');
            setLoading(false);
          }
        } catch (e) {
          console.warn('[AvatarImage] error loading avatar:', e);
          if (alive) {
            setUri('');
            setLoading(false);
          }
        }
      })();
    } else {
      // Нет userId или avatarVer - показываем плейсхолдер
      setUri('');
      setLoading(false);
    }

    return () => {
      alive = false;
    };
  }, [userId, avatarVer, propsUri]);

  const [resolvedUri, resolvedReady] = useResolvedImageUri(uri);
  const lastGoodDisplayRef = useRef('');
  useEffect(() => {
    lastGoodDisplayRef.current = '';
  }, [userId, avatarVer]);
  if (resolvedReady && resolvedUri) {
    lastGoodDisplayRef.current = resolvedUri;
  }
  const displayUri =
    (resolvedReady && resolvedUri) ||
    lastGoodDisplayRef.current ||
    (uri && !/^data:/i.test(uri) ? uri : '');

  const borderRadius = size / 2;
  /**
   * Без size: это recyclingKey для expo-image, и при его смене view пересоздаётся —
   * картинка на миг пропадает, видно серую подложку. Размер аватара пересчитывается
   * при каждом замере раскладки, поэтому от него ключ зависеть не должен.
   * Идентичность аватара определяют userId и avatarVer.
   */
  const key = `avatar_${userId || 'none'}_v${avatarVer || 0}`;

  const showFallbackLetter = fallbackText && !loading && !uri;
  const frameOverlay = activeFrameId === 'fire' ? (
    <ExpoImage
      source={FIRE_RING}
      style={{ position: 'absolute', left: -size * 0.03, top: -size * 0.03, width: size * 1.06, height: size * 1.06, zIndex: 3 }}
      contentFit="contain"
      cachePolicy="memory-disk"
      pointerEvents="none"
    />
  ) : activeFrameId && FRAME_COLORS[activeFrameId] ? (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: size,
        height: size,
        borderRadius,
        borderWidth: Math.max(2, size * 0.045),
        borderColor: FRAME_COLORS[activeFrameId],
        zIndex: 3,
      }}
    />
  ) : null;
  if (!displayUri) {
    return (
      <View
        style={[
          {
            width: size,
            height: size,
            borderRadius,
            backgroundColor: '#2A2C31',
            alignItems: 'center',
            justifyContent: 'center',
          },
          containerStyle,
        ]}
      >
        {showFallbackLetter ? (
          <Text
            style={[
              {
                color: '#E6E8EB',
                fontWeight: '700',
                fontSize: size * 0.4,
              },
              fallbackTextStyle,
            ]}
          >
            {fallbackText}
          </Text>
        ) : null}
        {frameOverlay}
      </View>
    );
  }

  return (
    <View style={[{ width: size, height: size, borderRadius }, containerStyle]}>
      <ExpoImage
        key={key}
        {...getAvatarImageProps(displayUri, key)}
        style={[
          {
            width: size,
            height: size,
            borderRadius,
          },
          style,
        ]}
      />
      {frameOverlay}
    </View>
  );
});

AvatarImage.displayName = 'AvatarImage';

export default AvatarImage;
