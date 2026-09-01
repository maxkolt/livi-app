import React, { memo } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop as SvgStop,
  Text as SvgText,
} from 'react-native-svg';
import { AURA_GRADIENT, BRAND_FONT_FAMILY } from './constants';

type WelcomeBrandMarkProps = {
  onPress?: () => void;
  disabled?: boolean;
};

function WelcomeBrandMarkInner({ onPress, disabled }: WelcomeBrandMarkProps) {
  const fontSize = 26;
  const fontWeight = '700';
  const gradId = 'welcomeViGrad';

  const content = (
    <View style={styles.row}>
      <Text style={[styles.li, { fontSize, fontFamily: BRAND_FONT_FAMILY }]}>Li</Text>
      <Svg width={34} height={32} viewBox="0 0 34 32">
        <Defs>
          <SvgLinearGradient id={gradId} x1="0%" y1="0%" x2="0%" y2="100%">
            <SvgStop offset="0%" stopColor={AURA_GRADIENT[2]} />
            <SvgStop offset="42%" stopColor={AURA_GRADIENT[1]} />
            <SvgStop offset="100%" stopColor={AURA_GRADIENT[0]} />
          </SvgLinearGradient>
        </Defs>
        <SvgText
          fill={`url(#${gradId})`}
          fontSize={fontSize}
          fontWeight={fontWeight}
          fontFamily={Platform.OS === 'ios' ? 'System' : 'sans-serif-medium'}
          x={0}
          y={Platform.OS === 'ios' ? 24 : 25}
        >
          Vi
        </SvgText>
      </Svg>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
      accessibilityRole="header"
      accessibilityLabel="LiVi"
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  li: {
    color: '#F4F5F7',
    fontWeight: '700',
    letterSpacing: 0.3,
    marginRight: -1,
  },
});

export const WelcomeBrandMark = memo(WelcomeBrandMarkInner);
