/** Копия облака в меню по зажиму: не влезает по высоте — уменьшается целиком, а не обрезается. */

import React from "react";
import { View } from "react-native";

type Props = {
  /** Сколько места есть по высоте. */
  maxHeight: number;
  /**
   * Ширина, на которой рендерится копия (по центру коробки). Шире коробки — чтобы
   * проценты maxWidth у облака дали тот же перенос строк, что в чате; лишнее по краям пустое.
   */
  contentWidth?: number;
  /** Доп. ограничение масштаба по ширине (облако фиксированной ширины шире коробки). */
  widthScale?: number;
  /** Мельче не уменьшаем — дальше уже нечитаемо, остаток обрезается по краям. */
  minScale?: number;
  children: React.ReactNode;
};

export function ChatMessagePreviewFit({
  maxHeight,
  contentWidth,
  widthScale = 1,
  minScale = 0.3,
  children,
}: Props) {
  // Естественная высота копии (transform на layout не влияет).
  const [naturalH, setNaturalH] = React.useState<number | null>(null);
  const heightScale =
    naturalH == null || naturalH <= maxHeight || naturalH <= 0 ? 1 : maxHeight / naturalH;
  const scale = Math.max(minScale, Math.min(1, heightScale, widthScale));
  // Коробка — по уменьшенной копии, чтобы над/под ней не оставалось пустой полосы.
  const boxH = Math.max(0, naturalH == null ? maxHeight : Math.min(maxHeight, naturalH * scale));

  return (
    <View pointerEvents="none" style={{ alignSelf: "stretch", height: boxH, overflow: "hidden" }}>
      <View
        onLayout={(e) => {
          const h = Math.ceil(e.nativeEvent.layout.height);
          setNaturalH((prev) => (prev === h ? prev : h));
        }}
        style={{
          position: "absolute",
          ...(contentWidth && contentWidth > 0
            ? { left: "50%" as const, width: contentWidth, marginLeft: -contentWidth / 2 }
            : { left: 0, right: 0 }),
          // Центр копии на центре коробки: scale идёт от центра, края не вылезают.
          top: naturalH == null ? 0 : (boxH - naturalH) / 2,
          opacity: naturalH == null ? 0 : 1,
          transform: [{ scale }],
        }}
      >
        {children}
      </View>
    </View>
  );
}
