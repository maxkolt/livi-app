import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';

type ChatMessageEdgeFadeProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Высота зоны под шапкой — растворение с первого пикселя под chrome. */
  top?: number;
  /** Высота зоны над композером. */
  bottom?: number;
};

/**
 * Растворяет облака/текст под шапкой и композером через маску ленты.
 * Без BlurView/tint — фон chrome остаётся как был (просвечивание glass без затемнения).
 */
export function ChatMessageEdgeFade({
  children,
  style,
  top = 0,
  bottom = 0,
}: ChatMessageEdgeFadeProps) {
  if (top <= 0 && bottom <= 0) {
    return <View style={[styles.root, style]}>{children}</View>;
  }

  return (
    <MaskedView
      style={[styles.root, style]}
      maskElement={
        <View style={styles.maskRoot} pointerEvents="none">
          {top > 0 ? (
            <LinearGradient
              colors={['transparent', '#000000']}
              locations={[0, 1]}
              style={{ height: top }}
            />
          ) : null}
          <View style={styles.maskMid} />
          {bottom > 0 ? (
            <LinearGradient
              colors={['#000000', 'transparent']}
              locations={[0, 1]}
              style={{ height: bottom }}
            />
          ) : null}
        </View>
      }
    >
      {children}
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
  maskRoot: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  maskMid: {
    flex: 1,
    backgroundColor: '#000000',
  },
});
