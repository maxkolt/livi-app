import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/** Ionicons image-outline geometry, with outlined mountains and a filled sun. */
export function ChatAttachmentIcon({ color, size = 28 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" fill="none">
      <Rect x={48} y={80} width={416} height={352} rx={48} ry={48} stroke={color} strokeWidth={32} strokeLinejoin="round" />
      <Circle cx={336} cy={176} r={32} fill={color} stroke={color} strokeWidth={32} />
      <Path d="M304 335.79 213.34 245.3A32 32 0 0 0 169.47 244L48 352" stroke={color} strokeWidth={32} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M224 432 347.34 308.66a32 32 0 0 1 43.11-2L464 368" stroke={color} strokeWidth={32} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
