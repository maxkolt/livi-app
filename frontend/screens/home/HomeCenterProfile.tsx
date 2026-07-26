import React from 'react';
import { Platform, Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AvatarImage from '../../components/AvatarImage';
import { getCurrentUserId } from '../../sockets/socket';
import { CHROME_PERIMETER_GLOW_LAYOUT_INSET, LIVI } from './constants';
import { ChromePerimeterGlow } from './chrome';
import { displayAvatarLetter, displayName } from './friendHelpers';
import type { HomeStyles } from './styles';

export type HomeCenterProfileProps = {
  styles: HomeStyles;
  isDark: boolean;
  layoutWidth: number;
  compact?: boolean;
  savedNick: string;
  avatarUri: string;
  myFullAvatarUri: string;
  myAvatarVer: number;
  resolvedAvatarUri: string;
  resolvedAvatarReady: boolean;
  avatarVerChecked: boolean;
  menuChromeBg: string;
  onOpenAvatarModal: (uri: string) => void;
};

function HomeCenterProfileInner({
  styles,
  isDark,
  layoutWidth,
  compact = false,
  savedNick,
  avatarUri,
  myFullAvatarUri,
  myAvatarVer,
  resolvedAvatarUri,
  resolvedAvatarReady,
  avatarVerChecked,
  menuChromeBg,
  onOpenAvatarModal,
}: HomeCenterProfileProps) {
  const letter = displayAvatarLetter(savedNick);
  const wrapperStyle: StyleProp<ViewStyle> = {
    alignItems: 'center',
    marginTop: compact ? 4 : Platform.OS === 'android' ? 20 : 12 + 20,
    marginBottom: compact ? -18 : layoutWidth < 400 ? -40 : -65,
  };

  const isLocalPreview = avatarUri && /^(file|content|ph|assets-library):\/\//i.test(avatarUri);
  const hasDirectAvatarUri =
    !!avatarUri && (/^data:image\//i.test(avatarUri) || /^https?:\/\//i.test(avatarUri));
  const myUserId = getCurrentUserId();
  const hasCachedAvatar = !!(myUserId && myAvatarVer > 0);
  const noAvatar = !isLocalPreview && !hasCachedAvatar && !hasDirectAvatarUri;
  const noNick = !(savedNick && String(savedNick).trim());

  const centerAvatarSize = compact ? 76 : Platform.OS === 'ios' ? 136 : 120;
  const centerAvatarRadius = centerAvatarSize / 2;

  return (
    <View style={wrapperStyle}>
      <Pressable
        onPress={() => onOpenAvatarModal(myFullAvatarUri || avatarUri || '')}
        style={{ alignSelf: 'center' }}
      >
        <ChromePerimeterGlow
          isDark={isDark}
          width={centerAvatarSize}
          height={centerAvatarSize}
          borderRadius={centerAvatarRadius}
          outerStyle={{ marginBottom: -CHROME_PERIMETER_GLOW_LAYOUT_INSET }}
        >
          <View
            style={[
              styles.centerAvatarWrap,
              {
                width: centerAvatarSize,
                height: centerAvatarSize,
                borderRadius: centerAvatarRadius,
                backgroundColor: menuChromeBg,
              },
            ]}
          >
            {isLocalPreview ? (
              <ExpoImage
                source={{ uri: resolvedAvatarUri || avatarUri }}
                style={styles.centerAvatarImg}
                cachePolicy="none"
              />
            ) : myUserId && myAvatarVer > 0 ? (
              <AvatarImage
                userId={myUserId}
                avatarVer={myAvatarVer}
                uri={myFullAvatarUri || undefined}
                size={centerAvatarSize}
                fallbackText={letter}
                containerStyle={styles.centerAvatarImg}
                fallbackTextStyle={{ fontSize: 48, fontWeight: '800' }}
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
                  <Text style={{ color: LIVI.titan, fontSize: 48, fontWeight: '500' }}>{letter}</Text>
                </View>
              ) : (
                <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
              )
            ) : avatarVerChecked ? (
              <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]}>
                <Text style={{ color: LIVI.titan, fontSize: 48, fontWeight: '500' }}>{letter}</Text>
              </View>
            ) : (
              <View style={[styles.centerAvatarImg, { alignItems: 'center', justifyContent: 'center' }]} />
            )}
          </View>
        </ChromePerimeterGlow>
      </Pressable>
      <Text
        style={[
          styles.subtitleNik,
          {
            marginTop: compact ? 6 : 12,
            fontSize: compact ? 16 : Platform.OS === 'ios' ? 25 : 20,
            color: noNick || noAvatar ? LIVI.titan : isDark ? LIVI.text2 : LIVI.textThemeWhite,
          },
        ]}
      >
        {displayName(savedNick)}
      </Text>
    </View>
  );
}

export const HomeCenterProfile = React.memo(HomeCenterProfileInner);
