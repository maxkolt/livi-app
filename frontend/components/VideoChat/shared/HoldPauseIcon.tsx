import React from 'react';
import Svg, { Circle, Rect } from 'react-native-svg';

type Props = {
  size?: number;
  color?: string;
};

/** Pause в круге: палки шире, чем у MaterialIcons pause-circle-filled. */
export function HoldPauseIcon({
  size = 20,
  color = 'rgba(255,255,255,0.92)',
}: Props) {
  // viewBox 24 — палки ~2.6 ширина (Material ~1.8–2).
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={10} fill={color} />
      <Rect x={8.2} y={7.5} width={2.8} height={9} rx={0.9} fill="#0a0a0c" />
      <Rect x={13} y={7.5} width={2.8} height={9} rx={0.9} fill="#0a0a0c" />
    </Svg>
  );
}
