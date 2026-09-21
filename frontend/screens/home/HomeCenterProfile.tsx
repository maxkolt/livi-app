import React from 'react';
import { Platform, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AvatarImage, { activeFrameRingWidth } from '../../components/AvatarImage';
import { getCurrentUserId } from '../../sockets/socket';
import { CHROME_PERIMETER_GLOW_LAYOUT_INSET, LIVI } from './constants';
import { ChromePerimeterGlow } from './chrome';
import { displayAvatarLetter, displayName } from './friendHelpers';
import type { HomeStyles } from './styles';
import { useUserActiveFrame } from '../../utils/cosmetics';


export type HomeCenterProfileProps = {
  styles: HomeStyles;
  isDark: boolean;
  layoutWidth: number;
  compact?: boolean;
  /** Телефон в landscape: та же вертикальная структура, меньший аватар/ник. */
  dense?: boolean;
  /** Экран приветствия: аватар в радаре без ника под фото. */
  radarStage?: boolean;
  /** Явный диаметр аватара на radar (иначе layoutWidth → 112/124). */
  radarAvatarSize?: number;
  /** Диаметр фотографии при купленной рамке: рамка занимает край 1-й орбиты. */
  radarFramedAvatarSize?: number;
  /** Насколько рамка выходит наружу от фотографии в радаре. */
  radarFrameOutset?: number;
  savedNick: string;
  avatarUri: string;
  myFullAvatarUri: string;
  myAvatarVer: number;
  resolvedAvatarUri: string;
  resolvedAvatarReady: boolean;
  avatarVerChecked: boolean;
  menuChromeBg: string;
  onOpenAvatarModal: (uri: string) => void;
  avatarAnchorRef?: React.Ref<View>;
};

function HomeCenterProfileInner({
  styles,
  isDark,
  layoutWidth,
  compact = false,
  dense = false,
  radarStage = false,
  radarAvatarSize,
  radarFramedAvatarSize,
  radarFrameOutset,
  savedNick,
  avatarUri,
  myFullAvatarUri,
  myAvatarVer,
  resolvedAvatarUri,
  resolvedAvatarReady,
  avatarVerChecked,
  menuChromeBg,
  onOpenAvatarModal,
  avatarAnchorRef,
}: HomeCenterProfileProps) {
  const letter = displayAvatarLetter(savedNick);
  const wrapperStyle: StyleProp<ViewStyle> = {
    alignItems: 'center',
    marginTop: radarStage
      ? 0
      : dense
        ? 2
        : compact
          ? 4
          : Platform.OS === 'android'
            ? 20
            : 12 + 20,
    marginBottom: radarStage ? 0 : dense ? -8 : compact ? -18 : layoutWidth < 400 ? -40 : -65,
  };

  const isLocalPreview = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  const hasDirectAvatarUri =
    !!avatarUri && (/^data:image\//i.test(avatarUri) || /^https?:\/\//i.test(avatarUri));
  const myUserId = getCurrentUserId();
  const activeFrameId = useUserActiveFrame(myUserId);
  const hasCachedAvatar = !!(myUserId && myAvatarVer > 0);
  const noAvatar = !isLocalPreview && !hasCachedAvatar && !hasDirectAvatarUri;
  const noNick = !(savedNick && String(savedNick).trim());

  const centerAvatarSize = radarStage
    ? Math.round(
        activeFrameId && radarFramedAvatarSize
          ? radarFramedAvatarSize
          : radarAvatarSize ?? (layoutWidth < 400 ? 112 : 124),
      )
    : dense
      ? 56
      : compact
        ? 76
        : Platform.OS === 'ios'
          ? 136
          : 120;
  const centerAvatarRadius = centerAvatarSize / 2;
  // Толщина рамки одна на все экраны — см. ACTIVE_FRAME_RING_WIDTH.
  // radarFrameOutset больше не участвует: из-за него «Поиск» рисовал 4.5 dp,
  // а «Профиль» — 2.5, и одна и та же рамка выглядела по-разному.
  const frameOutset = activeFrameRingWidth(centerAvatarSize);
  const centerAvatarFrameSize = Math.round(centerAvatarSize) + frameOutset * 2;
  const centerAvatarContainerSize = activeFrameId ? centerAvatarFrameSize : centerAvatarSize;
  const letterFontSize = dense ? 22 : radarStage ? 36 : 48;
  const framedAvatarUri = isLocalPreview
    ? resolvedAvatarUri || avatarUri
    : myFullAvatarUri || (resolvedAvatarReady ? resolvedAvatarUri : '') || avatarUri || undefined;

  const avatarInner = (
    <View
      ref={avatarAnchorRef}
      collapsable={false}
      style={[
        styles.centerAvatarWrap,
        {
          width: centerAvatarContainerSize,
          height: centerAvatarContainerSize,
          borderRadius: centerAvatarContainerSize / 2,
          backgroundColor: menuChromeBg,
        },
      ]}
    >
      {myUserId && activeFrameId ? (
        <AvatarImage
          key="avatar-framed"
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={framedAvatarUri}
          size={centerAvatarSize}
          frameSize={centerAvatarFrameSize}
          frameId={activeFrameId}
          fallbackText={letter}
          containerStyle={styles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: letterFontSize, fontWeight: '800' }}
        />
      ) : isLocalPreview ? (
        <ExpoImage
          source={{ uri: resolvedAvatarUri || avatarUri }}
          style={styles.centerAvatarImg}
          cachePolicy="none"
        />
      ) : myUserId && myAvatarVer > 0 ? (
        <AvatarImage
          key="avatar-plain"
          userId={myUserId}
          avatarVer={myAvatarVer}
          uri={myFullAvatarUri || undefined}
          size={centerAvatarSize}
          frameId={activeFrameId || null}
          fallbackText={letter}
          containerStyle={styles.centerAvatarImg}
          fallbackTextStyle={{ fontSize: letterFontSize, fontWeight: '800' }}
        />
      ) : hasDirectAvatarUri && resolvedAvatarReady ? (
        <ExpoImage
          source={{ uri: resolvedAvatarUri }}
          style={styles.centerAvatarImg}
          cachePolicy={/^https?:\/\//i.test(avatarUri) ? 'memory-disk' : 'none'}
        />
      ) : hasDirectAvatarUri ? (
        avatarVerChecked ? (
          <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
            <Text style={{ color: LIVI.titan, fontSize: letterFontSize, fontWeight: '500' }}>{letter}</Text>
          </View>
        ) : (
          <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
        )
      ) : avatarVerChecked ? (
        <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ color: LIVI.titan, fontSize: letterFontSize, fontWeight: '500' }}>{letter}</Text>
        </View>
      ) : (
        <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
      )}
    </View>
  );

  return (
    <View style={wrapperStyle}>
      <Pressable
        onPress={() => onOpenAvatarModal(myFullAvatarUri || avatarUri || '')}
        style={{ alignSelf: 'center' }}
      >
        {radarStage || activeFrameId ? (
          avatarInner
        ) : (
          <ChromePerimeterGlow
            isDark={isDark}
            width={centerAvatarSize}
            height={centerAvatarSize}
            borderRadius={centerAvatarRadius}
            glowIntensity={isDark ? 1.15 : 2.25}
            outerStyle={{ marginBottom: -CHROME_PERIMETER_GLOW_LAYOUT_INSET }}
          >
            {avatarInner}
          </ChromePerimeterGlow>
        )}
      </Pressable>
      {!radarStage ? (
      <Text
        style={[
          styles.subtitleNik,
          {
            marginTop: dense ? 4 : compact ? 6 : 12,
            fontSize: dense ? 14 : compact ? 16 : Platform.OS === 'ios' ? 25 : 20,
            color: noNick || noAvatar ? LIVI.titan : isDark ? LIVI.text2 : LIVI.textThemeWhite,
          },
        ]}
        numberOfLines={dense ? 1 : undefined}
        ellipsizeMode={dense ? 'tail' : undefined}
      >
        {displayName(savedNick)}
      </Text>
      ) : null}
    </View>
  );
}

export const HomeCenterProfile = React.memo(HomeCenterProfileInner);
