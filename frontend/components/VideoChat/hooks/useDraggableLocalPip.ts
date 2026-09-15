/**
 * Перетаскивание локального video PiP на экране звонка.
 * Только UI-позиция — без логики сессии / system PiP.
 * Старт: сверху справа, ниже шапки CallScreenChrome (в т.ч. «удержание»).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';

export const LOCAL_PIP_W = 112;
export const LOCAL_PIP_H = 168;

const MARGIN = 14;
/** Высота headerRowWithHold в CallScreenChrome (имя + статус + hold). */
const HEADER_ROW_WITH_HOLD = 74;
const GAP_BELOW_HEADER = 16;
const DRAG_THRESHOLD = 8;

type StageSize = { width: number; height: number };

function headerFloorY(topInset: number) {
  // Как paddingTop шапки: Math.max(26, topInset + 24).
  const headerPad = Math.max(26, topInset + 24);
  return headerPad + HEADER_ROW_WITH_HOLD + GAP_BELOW_HEADER;
}

function defaultTopRight(w: number, topInset: number) {
  return {
    x: Math.max(MARGIN, w - MARGIN - LOCAL_PIP_W),
    y: headerFloorY(topInset),
  };
}

export function useDraggableLocalPip(
  stage: StageSize,
  opts?: {
    /** Инкремент при включении камеры — снова якорь сверху справа. */
    resetToken?: number;
    /** Как у CallScreenChrome topInset (Android safe area внутри stage). */
    topInset?: number;
  },
) {
  const w = Math.max(1, stage.width || 1);
  const h = Math.max(1, stage.height || 1);
  const resetToken = opts?.resetToken ?? 0;
  const topInset = Math.max(0, opts?.topInset ?? 0);
  const minY = headerFloorY(topInset);

  const clamp = useCallback(
    (x: number, y: number) => ({
      x: Math.max(MARGIN, Math.min(Math.max(MARGIN, w - MARGIN - LOCAL_PIP_W), x)),
      y: Math.max(minY, Math.min(Math.max(minY, h - MARGIN - LOCAL_PIP_H), y)),
    }),
    [w, h, minY],
  );

  const [pos, setPos] = useState(() => {
    const d = defaultTopRight(w, topInset);
    return clamp(d.x, d.y);
  });
  const initializedRef = useRef(false);
  const lastResetTokenRef = useRef(resetToken);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (w < 80 || h < 120) return;
    const def = defaultTopRight(w, topInset);
    const tokenChanged = lastResetTokenRef.current !== resetToken;
    if (!initializedRef.current || tokenChanged) {
      initializedRef.current = true;
      lastResetTokenRef.current = resetToken;
      setPos(clamp(def.x, def.y));
      return;
    }
    setPos((prev) => clamp(prev.x, prev.y));
  }, [w, h, clamp, resetToken, topInset]);

  const translate = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const dragStart = useRef({ x: 0, y: 0 });

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
        onMoveShouldSetPanResponderCapture: (_, g) =>
          Math.abs(g.dx) > DRAG_THRESHOLD || Math.abs(g.dy) > DRAG_THRESHOLD,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragStart.current = { ...posRef.current };
          translate.setValue({ x: 0, y: 0 });
        },
        onPanResponderMove: (_, g) => {
          translate.setValue({ x: g.dx, y: g.dy });
        },
        onPanResponderRelease: (_, g) => {
          const next = clamp(dragStart.current.x + g.dx, dragStart.current.y + g.dy);
          setPos(next);
          translate.setValue({ x: 0, y: 0 });
        },
        onPanResponderTerminate: (_, g) => {
          const next = clamp(dragStart.current.x + g.dx, dragStart.current.y + g.dy);
          setPos(next);
          translate.setValue({ x: 0, y: 0 });
        },
      }),
    [clamp, translate],
  );

  const style = useMemo(
    () => ({
      left: pos.x,
      top: pos.y,
      transform: [{ translateX: translate.x }, { translateY: translate.y }],
    }),
    [pos.x, pos.y, translate.x, translate.y],
  );

  return {
    localPipPanHandlers: panResponder.panHandlers,
    localPipDragStyle: style,
  };
}
