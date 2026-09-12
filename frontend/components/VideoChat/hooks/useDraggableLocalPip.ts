/**
 * Перетаскивание локального video PiP на экране звонка.
 * Только UI-позиция — без логики сессии / system PiP.
 * Старт: снизу справа над панелью кнопок (CallScreenChrome capsule).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder } from 'react-native';

export const LOCAL_PIP_W = 112;
export const LOCAL_PIP_H = 168;

const MARGIN = 14;
/** Запас под capsule (~74) + safe inset + зазор; выше над панелью кнопок. */
const CONTROLS_BOTTOM_RESERVE = 172;
const GAP_ABOVE_CONTROLS = 16;
const DRAG_THRESHOLD = 8;

type StageSize = { width: number; height: number };

function defaultBottomRight(w: number, h: number) {
  return {
    x: Math.max(MARGIN, w - MARGIN - LOCAL_PIP_W),
    y: Math.max(
      MARGIN,
      h - LOCAL_PIP_H - CONTROLS_BOTTOM_RESERVE - GAP_ABOVE_CONTROLS,
    ),
  };
}

export function useDraggableLocalPip(
  stage: StageSize,
  opts?: { /** Инкремент при включении камеры — снова якорь снизу справа. */ resetToken?: number },
) {
  const w = Math.max(1, stage.width || 1);
  const h = Math.max(1, stage.height || 1);
  const resetToken = opts?.resetToken ?? 0;

  const clamp = useCallback(
    (x: number, y: number) => ({
      x: Math.max(MARGIN, Math.min(Math.max(MARGIN, w - MARGIN - LOCAL_PIP_W), x)),
      y: Math.max(MARGIN, Math.min(Math.max(MARGIN, h - MARGIN - LOCAL_PIP_H), y)),
    }),
    [w, h],
  );

  const [pos, setPos] = useState(() => {
    const d = defaultBottomRight(w, h);
    return clamp(d.x, d.y);
  });
  const initializedRef = useRef(false);
  const lastResetTokenRef = useRef(resetToken);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    if (w < 80 || h < 120) return;
    const def = defaultBottomRight(w, h);
    const tokenChanged = lastResetTokenRef.current !== resetToken;
    if (!initializedRef.current || tokenChanged) {
      initializedRef.current = true;
      lastResetTokenRef.current = resetToken;
      setPos(clamp(def.x, def.y));
      return;
    }
    setPos((prev) => clamp(prev.x, prev.y));
  }, [w, h, clamp, resetToken]);

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
