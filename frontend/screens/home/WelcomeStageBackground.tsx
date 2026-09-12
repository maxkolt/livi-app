import React from 'react';
import {
  Image,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SEARCH_CTA_TABLET_MIN_WIDTH, WELCOME_STAGE_BG } from './constants';

const STAGE_BG = require('../../assets/welcome-stage-bg.png');

/**
 * Full-bleed stage.
 * Phone portrait: dithered bitmap + cover (как на макете).
 * Tablet / landscape: сплошной WELCOME_STAGE_BG — портретный PNG на широком
 * экране даёт вертикальный «шов» (две колонки тона).
 */
export function WelcomeStageBackground() {
  const { width, height } = useWindowDimensions();
  const isWide =
    width > 0 &&
    height > 0 &&
    (width / height > 1.05 || Math.min(width, height) >= SEARCH_CTA_TABLET_MIN_WIDTH);

  if (isWide) {
    return (
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]}
        pointerEvents="none"
      />
    );
  }

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: WELCOME_STAGE_BG }]} pointerEvents="none">
      <Image source={STAGE_BG} style={StyleSheet.absoluteFill} resizeMode="cover" fadeDuration={0} />
    </View>
  );
}

type StageGradientProps = {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  /** Полупрозрачный слой поверх обоев чата — картинка слегка просвечивает. */
  translucent?: boolean;
  /** Зеркально по вертикали (нижний chrome чата). */
  mirror?: boolean;
};

/** Chrome header/composer: bitmap для непрозрачного stage, градиент только для стекла. */
export function StageGradient({ style, children, onLayout, translucent, mirror }: StageGradientProps) {
  const { width, height } = useWindowDimensions();
  const isWide =
    width > 0 &&
    height > 0 &&
    (width / height > 1.05 || Math.min(width, height) >= SEARCH_CTA_TABLET_MIN_WIDTH);

  if (!translucent) {
    return (
      <View
        style={[style, isWide ? { backgroundColor: WELCOME_STAGE_BG } : null]}
        onLayout={onLayout}
      >
        {isWide ? null : (
          <Image
            source={STAGE_BG}
            style={[StyleSheet.absoluteFill, mirror ? styles.mirror : null]}
            resizeMode="cover"
            fadeDuration={0}
          />
        )}
        {children}
      </View>
    );
  }

  const colors = [
    'rgba(14, 28, 34, 0.72)',
    'rgba(10, 12, 20, 0.66)',
    'rgba(11, 17, 24, 0.68)',
    'rgba(12, 21, 32, 0.74)',
  ] as const;
  const vStart = mirror ? { x: 0.5, y: 1 } : { x: 0.5, y: 0 };
  const vEnd = mirror ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };

  return (
    <View style={style} onLayout={onLayout}>
      <LinearGradient
        colors={[...colors]}
        locations={[0, 0.32, 0.68, 1]}
        start={vStart}
        end={vEnd}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  mirror: {
    transform: [{ scaleY: -1 }],
  },
});
