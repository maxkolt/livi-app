import React from 'react';
import { StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { getCosmeticFrame, isLiveCosmeticFrame, SHOWCASE_AVATAR } from '../../utils/cosmeticCatalog';
import { FireAvatarFrame, fireFrameOutset } from './FireAvatarFrame';
import { IceAvatarFrame } from './IceAvatarFrame';
import { DiamondAvatarFrame } from './DiamondAvatarFrame';

const LIVE_FRAMES = { fire: FireAvatarFrame, frost: IceAvatarFrame, diamond: DiamondAvatarFrame };

/** Один предпросмотр для витрины и покупок; размеры и фон фото задаёт место показа. */
export function CosmeticFramePreview({
  itemId,
  size,
  ringWidth = Math.max(2, Math.round(size * 0.025)),
  active,
  avatarBackgroundColor,
  onLoad,
  fallback = null,
}: {
  itemId: string;
  size: number;
  ringWidth?: number;
  active?: boolean;
  avatarBackgroundColor?: string;
  onLoad?: () => void;
  fallback?: React.ReactNode;
}) {
  const item = getCosmeticFrame(itemId);
  if (!item) return fallback;
  if (isLiveCosmeticFrame(itemId)) {
    const LiveFrame = LIVE_FRAMES[itemId];
    return (
      <LiveFrame size={size} photoSize={size - fireFrameOutset(size) * 2} active={active}>
        <ExpoImage
          source={SHOWCASE_AVATAR}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
          cachePolicy="memory-disk"
          onLoad={onLoad}
        />
      </LiveFrame>
    );
  }
  const avatarSize = size - ringWidth * 2;
  return (
    <LinearGradient
      colors={item.colors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        padding: ringWidth,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ExpoImage
        source={SHOWCASE_AVATAR}
        style={{
          width: avatarSize,
          height: avatarSize,
          borderRadius: avatarSize / 2,
          backgroundColor: avatarBackgroundColor,
        }}
        contentFit="cover"
        cachePolicy="memory-disk"
        onLoad={onLoad}
      />
    </LinearGradient>
  );
}
