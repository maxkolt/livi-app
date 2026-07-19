import React from 'react';
import { View, StyleSheet, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

type Props = {
  color: string;
  /** Базовая толщина (на Android чуть толще из‑за пикселей). */
  width?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

function withAlpha(color: string, alpha: number): string {
  const m = String(color).match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\)/i);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return color;
}

/**
 * Тонкая рамка-скобка «[» у цитаты:
 * мягкие углы, горизонтали гаснут уже с ~40% длины.
 */
export function ChatReplyQuoteAccent({
  color,
  width,
  style,
  children,
}: Props) {
  const lineW = width ?? (Platform.OS === 'ios' ? 1.25 : 1.5);
  const bright = withAlpha(color, 0.95);
  const mid = withAlpha(color, 0.28);
  const dim = withAlpha(color, 0.04);
  const cornerR = 13;

  const inset = 8;

  return (
    <View
      style={[
        styles.wrap,
        {
          paddingTop: inset,
          paddingBottom: inset,
          paddingRight: inset,
          paddingLeft: inset + 2 + lineW,
        },
        style,
      ]}
    >
      {/* Вертикаль */}
      <View
        pointerEvents="none"
        style={[
          styles.vert,
          {
            width: lineW,
            left: 0,
            top: cornerR - 1,
            bottom: cornerR - 1,
            backgroundColor: bright,
            borderRadius: lineW,
          },
        ]}
      />

      {/* Верхний угол + горизонталь (мягкий радиус у стыка) */}
      <View pointerEvents="none" style={[styles.cornerRow, styles.cornerTop, { left: 0 }]}>
        <View
          style={{
            width: cornerR + lineW,
            height: cornerR + lineW,
            borderLeftWidth: lineW,
            borderTopWidth: lineW,
            borderColor: bright,
            borderTopLeftRadius: cornerR,
          }}
        />
        <LinearGradient
          colors={[bright, mid, dim]}
          locations={[0, 0.4, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1, height: lineW, marginLeft: -0.5, alignSelf: 'flex-start' }}
        />
      </View>

      {/* Нижний угол + горизонталь */}
      <View pointerEvents="none" style={[styles.cornerRow, styles.cornerBottom, { left: 0 }]}>
        <View
          style={{
            width: cornerR + lineW,
            height: cornerR + lineW,
            borderLeftWidth: lineW,
            borderBottomWidth: lineW,
            borderColor: bright,
            borderBottomLeftRadius: cornerR,
          }}
        />
        <LinearGradient
          colors={[bright, mid, dim]}
          locations={[0, 0.4, 1]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={{ flex: 1, height: lineW, marginLeft: -0.5, alignSelf: 'flex-end' }}
        />
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
  },
  vert: {
    position: 'absolute',
    zIndex: 1,
  },
  cornerRow: {
    position: 'absolute',
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 2,
  },
  cornerTop: {
    top: 0,
  },
  cornerBottom: {
    bottom: 0,
  },
});
