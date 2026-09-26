// components/AvatarImage.tsx
import React, { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, StyleProp, ViewStyle, TextStyle, ImageStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import { useResolvedImageUri } from '../hooks/useResolvedImageUri';
import { getAvatarImageProps } from '../utils/imageOptimization';
import { getAvatarUri } from '../utils/avatarCache';
import { useUserActiveFrame } from '../utils/cosmetics';

/**
 * Единая толщина рамки для всех экранов, в dp.
 *
 * Раньше каждый экран считал её сам: Профиль брал константу 2.5, радар на
 * «Поиске» — формулу от размера орбит и получал ~4.5. Одна и та же купленная
 * рамка выглядела по-разному в двух местах. Теперь источник один.
 */
const ACTIVE_FRAME_RING_RATIO = 0.027;
const ACTIVE_FRAME_RING_MIN = 2;
const ACTIVE_FRAME_RING_MAX = 5;


/**
 * Толщина рамки от размера аватара, в целых dp.
 *
 * Фиксированное число плохо масштабируется: 3 dp вокруг аватара 112 dp на
 * главной выглядят уместно, а вокруг 34 dp в списке друзей — грубо. Доля от
 * диаметра держит пропорцию, а границы не дают рамке пропасть на крошечных
 * аватарах и превратиться в бублик на крупных.
 *
 * Целое значение принципиально: дробные размеры SVG и раскладка округляют
 * по-разному, и кольцо переставало совпадать с краем фотографии.
 *
 * Один источник для всех экранов. Раньше «Профиль» брал константу 2.5, а
 * «Поиск» считал по формуле от орбит и получал ~4.5 — одна и та же купленная
 * рамка выглядела по-разному в двух местах.
 *
 * Границы целые не случайно: outerSize = photoSize + ringWidth × 2, и дробная
 * толщина (те же 1.8) вернула бы дробный размер контейнера — ровно то, с чего
 * начиналось расхождение кольца с краем фотографии.
 */
export function activeFrameRingWidth(avatarSize: number): number {
  const raw = Math.round(avatarSize) * ACTIVE_FRAME_RING_RATIO;
  return Math.round(Math.min(ACTIVE_FRAME_RING_MAX, Math.max(ACTIVE_FRAME_RING_MIN, raw)));
}
const FRAME_COLORS: Record<string, readonly [string, string, ...string[]]> = {
  fire: ['#FFC062', '#FF8A34', '#FF4D1C'],
  diamond: ['#E8F6FF', '#9ED0FF', '#6AA9FF'],
  aurora: ['#7CF5C8', '#5AA9FF', '#3B82F6'],
  palladium: ['#F2F4F7', '#C5CCD6', '#8B93A0'],
  frost: ['#D9F4FF', '#7EC8E8', '#4A9BC7'],
  jade: ['#B8F0D0', '#3DCF8E', '#1B8F5A'],
  void: ['#D4B5FF', '#7B5CFF', '#2A1B4A'],
  obsidian: ['#6B7280', '#374151', '#111827'],
};

export interface AvatarImageProps {
  userId?: string;
  avatarVer?: number;
  uri?: string; // для обратной совместимости или локальных файлов
  /** Внешний диаметр купленной рамки. Сам аватар при этом остаётся размера `size`. */
  frameSize?: number;
  /**
   * Какая рамка надета. Если проп передан — он главнее внутреннего хука.
   *
   * Нужен, потому что родитель и этот компонент зовут useUserActiveFrame
   * независимо и в пределах одного прохода рендера могут разойтись: родитель
   * рендерится первым и ещё не видит рамку, а ребёнок к своему рендеру уже
   * видит. Тогда кольцо рисуется по одной геометрии, а фотография приходит
   * от другой, и рамка оказывается не по центру.
   */
  frameId?: string | null;
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
  frameSize,
  frameId,
  style,
  fallbackText,
  fallbackTextStyle,
  containerStyle,
}) => {
  const willFetchFromCache = !propsUri && !!(userId && avatarVer && avatarVer > 0);
  const [uri, setUri] = useState<string>(propsUri || '');
  // true с первого кадра, если ждём кэш — иначе буква мелькает до useEffect.
  const [loading, setLoading] = useState(willFetchFromCache);
  const hookFrameId = useUserActiveFrame(userId);
  // undefined = проп не передан, решает хук. Пустая строка/null = «рамки нет».
  const activeFrameId = frameId !== undefined ? frameId || '' : hookFrameId;

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

  /**
   * Без size: это recyclingKey для expo-image, и при его смене view пересоздаётся —
   * картинка на миг пропадает, видно серую подложку. Размер аватара пересчитывается
   * при каждом замере раскладки, поэтому от него ключ зависеть не должен.
   * Идентичность аватара определяют userId и avatarVer.
   */
  const key = `avatar_${userId || 'none'}_v${avatarVer || 0}`;

  // Буква только когда точно нет аватара — не на первом кадре до useEffect (loading стартует true).
  const showFallbackLetter = !!(fallbackText && !loading && !uri);
  // Пока фото ещё нет — прозрачный фон: виден chrome родителя, не жёсткий #2A2C31.
  const placeholderBg = displayUri || showFallbackLetter ? '#2A2C31' : 'transparent';
  const frameColors = FRAME_COLORS[activeFrameId];
  const hasActiveFrame = !!frameColors;
  /**
   * Вся геометрия в целых dp. Дробные размеры (приходило 120.99882…) SVG и
   * раскладка округляют по-разному, и кольцо переставало совпадать с краем
   * фотографии на доли пикселя, которые складывались в заметное смещение.
   */
  const photoSize = Math.round(size);
  const ringWidth = activeFrameRingWidth(photoSize);
  const outerSize = hasActiveFrame ? photoSize + ringWidth * 2 : photoSize;
  const outerRadius = outerSize / 2;
  const avatarRadius = photoSize / 2;
  const avatarOffset = hasActiveFrame ? ringWidth : 0;
  // Кольцо целиком занимает пространство снаружи фотографии. Его внутренняя
  // граница совпадает с краем аватара и не перекрывает изображение.
  /**
   * Обводка SVG рисуется по центру линии, поэтому окружность радиуса
   * (outerSize − ringWidth)/2 занимает полосу ровно от photoSize/2 до
   * outerSize/2 — её внутренний край ложится точно на край фотографии.
   */
  const ringRadius = Math.max(1, (outerSize - ringWidth) / 2);
  /**
   * Врезка фотографии задаётся долей от контейнера, а не числом в dp.
   *
   * На устройстве с изменённым «Размером экрана» плотность раскладки (450)
   * и плотность растеризации (480) расходятся, и одно и то же значение в dp
   * превращается в разное число пикселей. Процент считается от реального
   * размера контейнера, поэтому внутренний край кольца и край фотографии
   * совпадают при любой плотности.
   */
  const ringInsetPct: `${number}%` = `${(ringWidth / outerSize) * 100}%`;
  const frameGradientId = `avatar-frame-${activeFrameId || 'none'}-${Math.round(outerSize)}`;

  const frameBase = frameColors ? (
    <Svg
      pointerEvents="none"
      viewBox={`0 0 ${outerSize} ${outerSize}`}
      style={[StyleSheet.absoluteFillObject, { zIndex: 3 }]}
    >
      <Defs>
        <SvgLinearGradient id={frameGradientId} x1="0" y1="0" x2="1" y2="1">
          {frameColors.map((color, index) => (
            <Stop
              key={`${color}-${index}`}
              offset={`${(index / Math.max(1, frameColors.length - 1)) * 100}%`}
              stopColor={color}
            />
          ))}
        </SvgLinearGradient>
      </Defs>
      <Circle
        cx={outerSize / 2}
        cy={outerSize / 2}
        r={ringRadius}
        fill="none"
        stroke={`url(#${frameGradientId})`}
        strokeWidth={ringWidth}
      />
    </Svg>
  ) : null;

  return (
    <View
      style={[
        { backgroundColor: placeholderBg },
        containerStyle,
        { width: outerSize, height: outerSize, borderRadius: outerRadius },
        hasActiveFrame
          ? {
              borderWidth: 0,
              borderColor: 'transparent',
              backgroundColor: 'transparent',
              overflow: 'hidden',
            }
          : null,
      ]}
    >
      {frameBase}
      <View
        style={{
          position: 'absolute',
          left: hasActiveFrame ? ringInsetPct : 0,
          top: hasActiveFrame ? ringInsetPct : 0,
          right: hasActiveFrame ? ringInsetPct : 0,
          bottom: hasActiveFrame ? ringInsetPct : 0,
          borderRadius: outerRadius,
          backgroundColor: placeholderBg,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          zIndex: 2,
        }}
      >
        {displayUri ? (
          <ExpoImage
            key={key}
            {...getAvatarImageProps(displayUri, key)}
            style={[
              StyleSheet.absoluteFillObject,
              { borderRadius: outerRadius },
              style,
            ]}
          />
        ) : showFallbackLetter ? (
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
      </View>
      {hasActiveFrame ? (
        /*
         * Волосяной ободок по краю фотографии.
         *
         * Тёмный верх снимка сливается с тёмным фоном приложения, и круг
         * читается как срезанный по прямой — особенно там, где в рисунке рамки
         * нет плотного контура. Ободок держит форму на тёмных участках и
         * практически не виден на светлых.
         */
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: hasActiveFrame ? ringInsetPct : 0,
            top: hasActiveFrame ? ringInsetPct : 0,
            right: hasActiveFrame ? ringInsetPct : 0,
            bottom: hasActiveFrame ? ringInsetPct : 0,
            borderRadius: outerRadius,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.38)',
            zIndex: 2,
          }}
        />
      ) : null}
    </View>
  );
});

AvatarImage.displayName = 'AvatarImage';

export default AvatarImage;
