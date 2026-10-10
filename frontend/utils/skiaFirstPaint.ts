import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { View } from 'react-native';
import { makeImageFromView, useCanvasRef } from '@shopify/react-native-skia';

/** Снимок идёт через UI-поток, который на холодном старте и так перегружен. */
const RETRY_MS = 100;
/**
 * Дальше не ждём, чтобы splash не завис из-за сбоя GPU. На холодном старте
 * первый экранный кадр приходит через 3.5–5 с; общий предел splash — 9 с.
 */
const MAX_WAIT_MS = 8000;
/** Прореживание при поиске непрозрачного пикселя: кадр радара/пламени — тысячи точек. */
const PIXEL_STRIDE = 7;

function hasVisiblePixels(pixels: ArrayLike<number> | null | undefined): boolean {
  if (!pixels) return false;
  // Premultiplied: полностью прозрачный пиксель — все каналы нулевые.
  for (let i = 0; i < pixels.length; i += PIXEL_STRIDE) {
    if (pixels[i] > 0) return true;
  }
  return false;
}

/**
 * Первый кадр Skia-канваса действительно попал в его TextureView.
 *
 * На Android Skia рисует в TextureView через очередь UI-потока, и на холодном
 * старте первый экранный кадр появляется на секунды позже, чем JS выставил
 * картинку. makeImageSnapshotAsync для сигнала не годится: он рендерит в
 * отдельный offscreen-буфер и отвечает, даже когда TextureView ещё пуст.
 * makeImageFromView читает настоящий буфер TextureView (getBitmap), поэтому
 * ждём, пока в нём появятся непрозрачные пиксели.
 *
 * paintViewRef вешается на обёртку, внутри которой только Canvas.
 * Снимок до создания поверхности бессмыслен, поэтому сначала ждём ненулевой
 * размер через SkiaViewApi.size — он безопасен.
 */
export function useSkiaFirstPaint(onPainted?: () => void) {
  const canvasRef = useCanvasRef();
  const paintViewRef = useRef<View>(null);
  const onPaintedRef = useRef(onPainted);
  onPaintedRef.current = onPainted;
  const state = useRef({ requested: false, done: false, alive: true, startedAt: 0 });

  useEffect(() => {
    const s = state.current;
    s.alive = true;
    return () => {
      s.alive = false;
    };
  }, []);

  const finish = useCallback(() => {
    const s = state.current;
    if (s.done || !s.alive) return;
    s.done = true;
    onPaintedRef.current?.();
  }, []);

  const attempt = useCallback(() => {
    const s = state.current;
    if (!s.alive || s.done) return;
    const retry = () => {
      if (Date.now() - s.startedAt >= MAX_WAIT_MS) finish();
      else setTimeout(attempt, RETRY_MS);
    };
    const canvas = canvasRef.current;
    const api = (globalThis as any).SkiaViewApi;
    if (!canvas || !paintViewRef.current || !api?.size) {
      retry();
      return;
    }
    let size: { width: number; height: number } | undefined;
    try {
      size = api.size(canvas.getNativeId());
    } catch {
      size = undefined;
    }
    if (!size || !(size.width > 0 && size.height > 0)) {
      retry();
      return;
    }
    makeImageFromView(paintViewRef as RefObject<View>)
      .then((image) => {
        let painted = false;
        try {
          painted = hasVisiblePixels(image?.readPixels() as ArrayLike<number> | null);
        } catch {}
        try {
          image?.dispose?.();
        } catch {}
        if (painted) finish();
        else retry();
      })
      .catch(retry);
  }, [canvasRef, finish]);

  /** Повторные вызовы безопасны: после первого кадра сразу сообщает «готово». */
  const requestPaintSignal = useCallback(() => {
    const s = state.current;
    if (s.done) {
      onPaintedRef.current?.();
      return;
    }
    if (s.requested) return;
    s.requested = true;
    s.startedAt = Date.now();
    attempt();
  }, [attempt]);

  return { canvasRef, paintViewRef, requestPaintSignal };
}
