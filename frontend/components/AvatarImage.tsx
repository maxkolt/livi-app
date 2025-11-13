// components/AvatarImage.tsx
import React, { memo, useEffect, useState } from 'react';
import { View, Text, StyleProp, ViewStyle, TextStyle, ImageStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { getAvatarUri } from '../utils/avatarCache';

interface AvatarImageProps {
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

  const borderRadius = size / 2;
  const key = `avatar_${userId || 'none'}_v${avatarVer || 0}_${size}`;

  // Показываем плейсхолдер если нет URI или идет загрузка
  if (!uri || loading) {
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
        {fallbackText && (
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
        )}
      </View>
    );
  }

  return (
    <View style={[{ width: size, height: size, borderRadius }, containerStyle]}>
      <ExpoImage
        key={key}
        {...getAvatarImageProps(uri, key)}
        style={[
          {
            width: size,
            height: size,
            borderRadius,
          },
          style,
        ]}
      />
    </View>
  );
});

AvatarImage.displayName = 'AvatarImage';

export default AvatarImage;
