import React from 'react';
import { View, StyleSheet } from 'react-native';
import VoiceEqualizer from '../../VoiceEqualizer';
import { useAppTheme } from '../../../theme/ThemeProvider';

interface VoiceEqualizerWrapperProps {
  level: number;
  width?: number;
  height?: number;
  bars?: number;
  gap?: number;
  minLine?: number;
}

/**
 * Обертка для эквалайзера с общими настройками
 */
export const VoiceEqualizerWrapper: React.FC<VoiceEqualizerWrapperProps> = ({
  level,
  width = 220,
  height = 30,
  bars = 21,
  gap = 8,
  minLine = 4,
}) => {
  const { isDark } = useAppTheme();

  return (
    <View style={styles.eqWrapper}>
      <VoiceEqualizer
        level={level}
        width={width}
        height={height}
        bars={bars}
        gap={gap}
        minLine={minLine}
        colors={isDark ? ["#F4FFFF", "#2EE6FF", "#F4FFFF"] : ["#FFE6E6", "rgb(58, 11, 160)", "#FFE6E6"]}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  eqWrapper: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});

