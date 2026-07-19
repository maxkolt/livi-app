import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  type StyleProp,
  type ViewStyle,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Path, Defs, LinearGradient, Stop, Mask, Rect } from 'react-native-svg';

type Props = {
  color: string;
  width?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
};

function parseRgb(color: string): { r: number; g: number; b: number } | null {
  const m = String(color).match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)(?:\s*,\s*[\d.]+)?\)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Скобка цитаты: один continuous path.
 * Горизонтали почти до края; после ~16% ширины плавно гаснут (mask),
 * на конце round cap — лёгкое «сужение», верх/низ не смыкаются.
 */
export function ChatReplyQuoteAccent({
  color,
  width,
  style,
  children,
}: Props) {
  const uid = React.useId().replace(/:/g, '');
  const lineW = width ?? (Platform.OS === 'ios' ? 1.15 : 1.3);
  const strokeOpacity = 0.42;
  const wash = withAlpha(color, 0.07);
  const rgb = parseRgb(color) || { r: 160, g: 160, b: 180 };
  const solid = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

  const cornerR = 11;
  const inset = 7;
  const [size, setSize] = useState({ w: 0, h: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    const nw = Math.round(w);
    const nh = Math.round(h);
    if (nw > 0 && nh > 0 && (nw !== size.w || nh !== size.h)) {
      setSize({ w: nw, h: nh });
    }
  };

  const half = lineW / 2;
  const hx = half + 0.5;
  const topY = half + 0.5;
  const botY = size.h > 0 ? size.h - half - 0.5 : topY;
  const armX = hx + cornerR;
  // Почти до конца облака, но не смыкаются
  const armEnd = Math.max(armX + 24, size.w - inset - 4);
  const minH = cornerR * 2 + lineW * 2 + 8;
  const ready = size.h >= minH && size.w > armX + 20;

  const bracketPath = ready
    ? [
        `M ${armEnd} ${topY}`,
        `L ${armX} ${topY}`,
        `A ${cornerR} ${cornerR} 0 0 0 ${hx} ${topY + cornerR}`,
        `L ${hx} ${botY - cornerR}`,
        `A ${cornerR} ${cornerR} 0 0 0 ${armX} ${botY}`,
        `L ${armEnd} ${botY}`,
      ].join(' ')
    : '';

  // Mask: до ~16% полностью видимо, дальше плавное затемнение/исчезновение
  const maskId = `replyMask_${uid}`;
  const gradId = `replyFade_${uid}`;

  const washLeft = hx + half;
  const washTop = topY + half;
  const washBottom = botY - half;
  const washRadius = Math.max(0, cornerR - half);

  return (
    <View onLayout={onLayout} style={[styles.wrap, style]}>
      {ready ? (
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={{
              position: 'absolute',
              left: washLeft,
              top: washTop,
              right: inset - 2,
              bottom: size.h - washBottom,
              backgroundColor: wash,
              borderTopLeftRadius: washRadius,
              borderBottomLeftRadius: washRadius,
              borderTopRightRadius: 8,
              borderBottomRightRadius: 8,
            }}
          />

          <Svg width={size.w} height={size.h} style={styles.svg}>
            <Defs>
              <LinearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#ffffff" stopOpacity={1} />
                <Stop offset="0.16" stopColor="#ffffff" stopOpacity={1} />
                <Stop offset="0.45" stopColor="#ffffff" stopOpacity={0.48} />
                <Stop offset="0.72" stopColor="#ffffff" stopOpacity={0.14} />
                <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
              </LinearGradient>
              <Mask
                id={maskId}
                x="0"
                y="0"
                width={size.w}
                height={size.h}
                maskUnits="userSpaceOnUse"
              >
                <Rect
                  x="0"
                  y="0"
                  width={size.w}
                  height={size.h}
                  fill={`url(#${gradId})`}
                />
              </Mask>
            </Defs>

            <Path
              d={bracketPath}
              stroke={solid}
              strokeOpacity={strokeOpacity}
              strokeWidth={lineW}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              mask={`url(#${maskId})`}
            />
          </Svg>
        </View>
      ) : null}

      <View
        style={{
          paddingTop: inset,
          paddingBottom: inset,
          paddingRight: inset,
          paddingLeft: inset + Math.ceil(lineW) + 5,
        }}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    overflow: 'hidden',
  },
  svg: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
});
